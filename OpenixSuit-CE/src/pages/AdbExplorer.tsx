import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import {
  ArrowLeft,
  Download,
  Edit3,
  File as FileIcon,
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface AdbFileEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

const STORAGE_PATHS_KEY = "adb_paths_by_serial";

const TEXT_EXTS = new Set([
  "txt", "conf", "cfg", "ini", "json", "xml", "yaml", "yml", "sh", "bash", "zsh",
  "log", "md", "dts", "dtsi", "fex", "py", "js", "ts", "tsx", "jsx", "c", "h",
  "cpp", "hpp", "rs", "toml", "service", "rules", "env", "properties", "rc",
]);
const TEXT_EXACT_NAMES = new Set([
  "fstab", "hosts", "hostname", "resolv.conf", "rc.local", "cmdline", "inittab", "profile", "passwd", "group",
]);

function isEditableTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXACT_NAMES.has(lower)) return true;
  const idx = lower.lastIndexOf(".");
  if (idx === -1) return false;
  return TEXT_EXTS.has(lower.slice(idx + 1));
}

function detectMonacoLanguage(path: string): string {
  const ext = path.toLowerCase().split(".").pop() || "";
  if (ext === "json") return "json";
  if (["sh", "bash", "zsh"].includes(ext)) return "shell";
  if (ext === "py") return "python";
  if (["js", "jsx"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (ext === "xml") return "xml";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (["c", "h", "cpp", "hpp"].includes(ext)) return "cpp";
  if (ext === "rs") return "rust";
  if (ext === "md") return "markdown";
  if (["ini", "conf", "cfg", "fex", "dts", "dtsi", "toml"].includes(ext)) return "ini";
  return "plaintext";
}

function readSavedPaths(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_PATHS_KEY) || "{}");
  } catch {
    return {};
  }
}

function getSavedPathForSerial(serial: string): string {
  return readSavedPaths()[serial] || "/";
}

function savePathForSerial(serial: string, path: string) {
  if (!serial) return;
  const map = readSavedPaths();
  map[serial] = path;
  localStorage.setItem(STORAGE_PATHS_KEY, JSON.stringify(map));
}

type PromptModal =
  | { type: "mkdir"; value: string }
  | { type: "rename"; oldName: string; value: string }
  | { type: "delete"; names: string[] }
  | null;

export function AdbExplorer({
  serial,
  theme,
  onLog,
}: {
  serial: string;
  theme: "dark" | "light";
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState(() =>
    serial ? getSavedPathForSerial(serial) : "/"
  );
  const [entries, setEntries] = useState<AdbFileEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cmd, setCmd] = useState(() => localStorage.getItem("adb_last_cmd") || "uname -a");
  const [shellOutput, setShellOutput] = useState("");
  const [editingFile, setEditingFile] = useState<{ path: string; content: string } | null>(null);
  const [modal, setModal] = useState<PromptModal>(null);
  const reqIdRef = useRef(0);
  const serialRef = useRef(serial);
  const currentPathRef = useRef(currentPath);

  const loadDir = async (targetSerial: string, path: string, fallbackToRoot = false) => {
    if (!targetSerial) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setErrorMsg(null);
    setEntries([]);
    setSelectedNames([]);
    try {
      const list = await invoke<AdbFileEntry[]>("adb_list_dir", {
        serial: targetSerial,
        remotePath: path,
      });
      if (reqId !== reqIdRef.current) return;
      setCurrentPath(path);
      savePathForSerial(targetSerial, path);
      setEntries(list);
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      if (fallbackToRoot && path !== "/") {
        await loadDir(targetSerial, "/", false);
        return;
      }
      setEntries([]);
      setErrorMsg(String(err));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  };

  const loadDirRef = useRef(loadDir);
  serialRef.current = serial;
  currentPathRef.current = currentPath;
  loadDirRef.current = loadDir;

  useEffect(() => {
    const unlisten = listen<{ serial: string; action: string }>("adb-sync", (event) => {
      const activeSerial = serialRef.current;
      const activePath = currentPathRef.current;
      if (!activeSerial) return;
      if (event.payload.serial === activeSerial || event.payload.serial === "") {
        loadDirRef.current(activeSerial, activePath);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    setShellOutput("");
    if (serial) {
      const savedPath = getSavedPathForSerial(serial);
      setCurrentPath(savedPath);
      loadDir(serial, savedPath, true);
    } else {
      setEntries([]);
      setSelectedNames([]);
    }
  }, [serial]);

  const joinPath = (name: string) => (currentPath === "/" ? `/${name}` : `${currentPath}/${name}`);

  const toggleSelect = (name: string) => {
    setSelectedNames((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  };

  const goParent = () => {
    if (!serial || currentPath === "/") return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    loadDir(serial, "/" + parts.join("/"));
  };

  const submitModal = async () => {
    if (!modal || !serial) return;
    try {
      if (modal.type === "mkdir" && modal.value.trim()) {
        await invoke("adb_mkdir", { serial, remotePath: joinPath(modal.value.trim()) });
      } else if (modal.type === "rename" && modal.value.trim() && modal.value.trim() !== modal.oldName) {
        await invoke("adb_rename", {
          serial,
          oldPath: joinPath(modal.oldName),
          newPath: joinPath(modal.value.trim()),
        });
      } else if (modal.type === "delete") {
        for (const name of modal.names) {
          await invoke("adb_delete", { serial, remotePath: joinPath(name) });
        }
      }
      setModal(null);
      await loadDir(serial, currentPath);
    } catch (err) {
      setModal(null);
      setErrorMsg(String(err));
    }
  };

  const handleBatchDownload = async () => {
    if (!serial || selectedNames.length === 0) return;
    try {
      const dir = await open({ directory: true });
      if (typeof dir !== "string") return;
      for (const name of selectedNames) {
        const entry = entries.find((e) => e.name === name);
        if (entry && !entry.is_dir) {
          await invoke("adb_pull_file", {
            serial,
            remotePath: joinPath(name),
            localPath: `${dir}/${name}`,
          });
        }
      }
      onLog(`批量下载完成 (${selectedNames.length} 项) -> ${dir}`);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const handleOpenFile = async (name: string) => {
    if (!serial) return;
    if (!isEditableTextFile(name)) {
      setErrorMsg(`${name}: ${t("adb.nonTextHint")}`);
      return;
    }
    const remotePath = joinPath(name);
    try {
      const content = await invoke<string>("adb_read_text", { serial, remotePath });
      setEditingFile({ path: remotePath, content });
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const saveEditedText = async () => {
    if (!editingFile || !serial) return;
    try {
      await invoke("adb_write_text", {
        serial,
        remotePath: editingFile.path,
        content: editingFile.content,
      });
      onLog(`Saved: ${editingFile.path}`);
      setEditingFile(null);
      await loadDir(serial, currentPath);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const handleUpload = async () => {
    if (!serial) return;
    try {
      const localPath = await open();
      if (typeof localPath !== "string") return;
      const fileName = localPath.split(/[\\/]/).pop() || "upload.bin";
      await invoke("adb_push_file", { serial, localPath, remotePath: joinPath(fileName) });
      await loadDir(serial, currentPath);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const handleDownload = async (name: string) => {
    if (!serial) return;
    try {
      const localPath = await save({ defaultPath: name });
      if (!localPath) return;
      await invoke("adb_pull_file", { serial, remotePath: joinPath(name), localPath });
      onLog(`Downloaded -> ${localPath}`);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const runShell = async () => {
    localStorage.setItem("adb_last_cmd", cmd);
    if (!serial) return;
    try {
      const out = await invoke<string>("adb_exec_shell", { serial, command: cmd });
      setShellOutput(out || "(OK)");
    } catch (err) {
      setShellOutput(String(err));
    }
  };

  const folderCount = entries.filter((e) => e.is_dir).length;
  const fileCount = entries.length - folderCount;
  const crumbs = currentPath.split("/").filter(Boolean);

  return (
    <div className="flex h-full flex-col space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-500">
          <span>
            {folderCount} folders, {fileCount} files
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {selectedNames.length > 0 && (
            <>
              <button
                onClick={handleBatchDownload}
                className="flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-white"
              >
                <Download className="h-3.5 w-3.5" />
                {t("common.download")} ({selectedNames.length})
              </button>
              <button
                onClick={() => setModal({ type: "delete", names: selectedNames })}
                className="flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 text-white"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")} ({selectedNames.length})
              </button>
            </>
          )}
          <button
            disabled={!serial}
            onClick={() => setModal({ type: "mkdir", value: "" })}
            className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("adb.mkdir")}
          </button>
          <button
            disabled={!serial}
            onClick={handleUpload}
            className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-white hover:bg-blue-500 disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
            {t("common.upload")}
          </button>
          <button
            onClick={() => setViewMode((v) => (v === "grid" ? "list" : "grid"))}
            className="rounded border border-slate-300 bg-white p-1.5 dark:border-slate-700 dark:bg-slate-800"
          >
            {viewMode === "grid" ? <List className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-1">
          <button disabled={!serial || currentPath === "/"} onClick={goParent} className="rounded p-1 hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-slate-800">
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            disabled={!serial}
            onClick={() => loadDir(serial, "/")}
            className="rounded px-1.5 py-0.5 font-mono hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            /
          </button>
          {crumbs.map((seg, i) => {
            const target = "/" + crumbs.slice(0, i + 1).join("/");
            return (
              <span key={target} className="flex items-center gap-1">
                <span className="text-slate-400">&gt;</span>
                <button
                  onClick={() => loadDir(serial, target)}
                  className="rounded px-1.5 py-0.5 font-mono hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <button
              onClick={() =>
                setSelectedNames(
                  selectedNames.length === entries.length ? [] : entries.map((e) => e.name)
                )
              }
              className="rounded px-2 py-0.5 text-[11px] hover:bg-slate-200 dark:hover:bg-slate-800"
            >
              {selectedNames.length === entries.length ? "取消全选" : "全选"}
            </button>
          )}
          <button disabled={!serial} onClick={() => loadDir(serial, currentPath)} className="rounded p-1 hover:bg-slate-200 dark:hover:bg-slate-800">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-600 dark:text-amber-400">
          {errorMsg}
        </div>
      )}

      <div className="flex-1 overflow-y-auto rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
        {loading ? (
          <div className="py-12 text-center text-slate-500">{t("common.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="py-12 text-center text-slate-500">{serial ? t("adb.emptyDir") : t("adb.waitConnect")}</div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-6 gap-3">
            {entries.map((item) => {
              const editable = !item.is_dir && isEditableTextFile(item.name);
              const checked = selectedNames.includes(item.name);
              return (
                <div
                  key={item.name}
                  onDoubleClick={() => (item.is_dir ? loadDir(serial, joinPath(item.name)) : handleOpenFile(item.name))}
                  className={`group relative flex cursor-pointer flex-col items-center rounded border p-2 text-center ${
                    checked
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-900"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelect(item.name)}
                    onClick={(e) => e.stopPropagation()}
                    className={`absolute left-1.5 top-1.5 ${checked ? "block" : "hidden group-hover:block"}`}
                  />
                  {item.is_dir ? (
                    <Folder
                      onClick={() => loadDir(serial, joinPath(item.name))}
                      className="h-10 w-10 fill-amber-400 text-amber-500"
                    />
                  ) : (
                    <FileIcon className="h-10 w-10 text-slate-400" />
                  )}
                  <div className="mt-1 w-full truncate font-medium">{item.name}</div>
                  {!item.is_dir && <div className="text-[10px] text-slate-400">{item.size} B</div>}
                  <div className="mt-1 hidden gap-1 group-hover:flex">
                    {!item.is_dir && (
                      <button onClick={() => handleDownload(item.name)} title={t("common.download")} className="rounded bg-slate-200 p-1 dark:bg-slate-800">
                        <Download className="h-3 w-3" />
                      </button>
                    )}
                    {editable && (
                      <button onClick={() => handleOpenFile(item.name)} title={t("common.edit")} className="rounded bg-slate-200 p-1 dark:bg-slate-800">
                        <Edit3 className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={() => setModal({ type: "rename", oldName: item.name, value: item.name })}
                      className="rounded bg-slate-200 px-1 text-[10px] dark:bg-slate-800"
                    >
                      {t("common.rename")}
                    </button>
                    <button
                      onClick={() => setModal({ type: "delete", names: [item.name] })}
                      title={t("common.delete")}
                      className="rounded bg-red-500/20 p-1 text-red-500"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
              <tr>
                <th className="w-8 py-1.5">
                  <input
                    type="checkbox"
                    checked={entries.length > 0 && selectedNames.length === entries.length}
                    onChange={() =>
                      setSelectedNames(
                        selectedNames.length === entries.length ? [] : entries.map((e) => e.name)
                      )
                    }
                  />
                </th>
                <th className="py-1.5">{t("sector.name")}</th>
                <th className="py-1.5">Size</th>
                <th className="py-1.5 text-right">{t("sector.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {entries.map((item) => {
                const editable = !item.is_dir && isEditableTextFile(item.name);
                return (
                  <tr key={item.name}>
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        checked={selectedNames.includes(item.name)}
                        onChange={() => toggleSelect(item.name)}
                      />
                    </td>
                    <td className="py-1.5">
                      {item.is_dir ? (
                        <button onClick={() => loadDir(serial, joinPath(item.name))} className="text-blue-500 hover:underline">
                          {item.name}/
                        </button>
                      ) : (
                        item.name
                      )}
                    </td>
                    <td className="py-1.5 font-mono text-slate-500">{item.is_dir ? "-" : `${item.size} B`}</td>
                    <td className="space-x-2 py-1.5 text-right">
                      {!item.is_dir && (
                        <button onClick={() => handleDownload(item.name)} className="text-blue-500 hover:underline">
                          {t("common.download")}
                        </button>
                      )}
                      {editable && (
                        <button onClick={() => handleOpenFile(item.name)} className="text-blue-500 hover:underline">
                          {t("common.edit")}
                        </button>
                      )}
                      <button
                        onClick={() => setModal({ type: "rename", oldName: item.name, value: item.name })}
                        className="text-slate-500 hover:underline"
                      >
                        {t("common.rename")}
                      </button>
                      <button
                        onClick={() => setModal({ type: "delete", names: [item.name] })}
                        className="text-red-500 hover:underline"
                      >
                        {t("common.delete")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runShell()}
          placeholder={t("adb.shellPlaceholder")}
          className="flex-1 rounded border border-slate-300 bg-white px-3 py-1 font-mono dark:border-slate-700 dark:bg-slate-900"
        />
        <button onClick={runShell} className="rounded bg-blue-600 px-3 py-1 text-white">
          {t("adb.runShell")}
        </button>
      </div>
      {shellOutput && (
        <pre className="max-h-24 overflow-auto rounded bg-slate-900 p-2 font-mono text-slate-200">{shellOutput}</pre>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-sm space-y-3 rounded bg-white p-4 dark:bg-slate-900">
            <div className="text-sm font-semibold">
              {modal.type === "mkdir" && t("adb.newFolderPrompt")}
              {modal.type === "rename" && t("adb.renamePrompt")}
              {modal.type === "delete" && `${t("adb.deleteConfirm")} (${modal.names.join(", ")})`}
            </div>
            {modal.type !== "delete" && (
              <input
                autoFocus
                value={modal.value}
                onChange={(e) => setModal({ ...modal, value: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && submitModal()}
                className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setModal(null)} className="rounded border px-3 py-1 text-xs">
                {t("common.cancel")}
              </button>
              <button
                onClick={submitModal}
                className={`rounded px-3 py-1 text-xs text-white ${modal.type === "delete" ? "bg-red-600" : "bg-blue-600"}`}
              >
                {modal.type === "delete" ? t("common.delete") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="flex h-[75vh] w-full max-w-4xl flex-col space-y-3 rounded bg-white p-4 dark:bg-slate-900">
            <div className="flex items-center justify-between font-mono text-sm font-semibold">
              <span>
                {t("adb.editTitle")}: {editingFile.path}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setEditingFile(null)} className="rounded border px-3 py-1 text-xs">
                  {t("common.cancel")}
                </button>
                <button onClick={saveEditedText} className="rounded bg-blue-600 px-3 py-1 text-xs text-white">
                  {t("adb.saveBack")}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden rounded border border-slate-300 dark:border-slate-700">
              <Editor
                height="100%"
                language={detectMonacoLanguage(editingFile.path)}
                theme={theme === "dark" ? "vs-dark" : "vs"}
                value={editingFile.content}
                onChange={(val) => setEditingFile({ ...editingFile, content: val ?? "" })}
                options={{ minimap: { enabled: false }, fontSize: 13 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
