import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import {
  ArrowLeft,
  Check,
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
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AdbDetailedFileEntry } from "../types/workbench";
import Selecto from "react-selecto";
import { AnsiText } from "../utils/ansi";

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
  const raw = readSavedPaths()[serial] || "/";
  // Clear any previously cached path containing ANSI escape or control characters
  const cleaned = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.startsWith("/") ? cleaned : "/";
}

function savePathForSerial(serial: string, path: string) {
  if (!serial) return;
  const map = readSavedPaths();
  map[serial] = path;
  localStorage.setItem(STORAGE_PATHS_KEY, JSON.stringify(map));
}

type PromptModal =
  | { type: "mkdir"; value: string }
  | { type: "delete"; names: string[] }
  | null;

export function AdbExplorer({
  serial,
  theme,
  jumpRequest,
  onLog,
}: {
  serial: string;
  theme: "dark" | "light";
  jumpRequest?: { path: string; seq: number } | null;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState(() =>
    serial ? getSavedPathForSerial(serial) : "/"
  );
  const [entries, setEntries] = useState<AdbDetailedFileEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cmd, setCmd] = useState(() => localStorage.getItem("adb_last_cmd") || "uname -a");
  const [shellOutput, setShellOutput] = useState("");
  const [editingFile, setEditingFile] = useState<{ path: string; content: string } | null>(null);
  const [fileViewTab, setFileViewTab] = useState<"editor" | "ansi">("editor");
  const [modal, setModal] = useState<PromptModal>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [lastClickedName, setLastClickedName] = useState<string | null>(null);
  const lastClickRef = useRef<{ name: string | null; ts: number }>({ name: null, ts: 0 });
  const renameBusyRef = useRef(false);
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const serialRef = useRef(serial);
  const currentPathRef = useRef(currentPath);

  const loadDir = async (
    targetSerial: string,
    path: string,
    fallbackToRoot = false,
    highlightName?: string
  ) => {
    if (!targetSerial) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setErrorMsg(null);
    setEntries([]);
    setSelectedNames([]);
    try {
      const list = await invoke<AdbDetailedFileEntry[]>("adb_list_dir_detailed", {
        serial: targetSerial,
        remotePath: path,
      });
      if (reqId !== reqIdRef.current) return;
      setCurrentPath(path);
      savePathForSerial(targetSerial, path);
      setEntries(list);
      if (highlightName && list.some((e) => e.name === highlightName)) {
        setSelectedNames([highlightName]);
      }
      return list;
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

  useEffect(() => {
    if (!serial || !jumpRequest?.path) return;
    const raw = jumpRequest.path.trim();
    if (!raw.startsWith("/")) return;
    const normalized = raw.length > 1 ? raw.replace(/\/+$/, "") : "/";
    if (normalized === "/") {
      loadDir(serial, "/", false);
      return;
    }
    const lastSlash = normalized.lastIndexOf("/");
    const parentDir = lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
    const baseName = normalized.slice(lastSlash + 1);
    loadDir(serial, parentDir, true, baseName).then((list) => {
      const match = list?.find((item) => item.name === baseName);
      if (match?.is_dir) {
        loadDir(serial, normalized, false);
      }
    });
  }, [serial, jumpRequest]);

  const joinPath = (name: string) => (currentPath === "/" ? `/${name}` : `${currentPath}/${name}`);

  const beginRename = (name: string) => {
    setRenamingName(name);
    setRenameDraft(name);
    // Preselect the base name (without extension), like desktop file managers.
    requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) return;
      const dot = name.lastIndexOf(".");
      if (dot > 0) {
        input.setSelectionRange(0, dot);
      } else {
        input.select();
      }
    });
  };

  const cancelRename = () => {
    setRenamingName(null);
    setRenameDraft("");
  };

  const commitRename = async () => {
    if (renameBusyRef.current) return;
    const oldName = renamingName;
    if (!oldName || !serial) return cancelRename();
    renameBusyRef.current = true;
    try {
    const newName = renameDraft.trim();
    setRenamingName(null);
    setRenameDraft("");
    if (!newName || newName === oldName) return;
      if (newName.includes("/")) {
        setErrorMsg(t("adb.invalidName"));
        return;
      }
      await invoke("adb_rename", {
        serial,
        oldPath: joinPath(oldName),
        newPath: joinPath(newName),
      });
      onLog(`Renamed: ${oldName} -> ${newName}`);
      await loadDir(serial, currentPath, false, newName);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      renameBusyRef.current = false;
    }
  };

  const handleRenameKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  const itemMouseDown = (e: ReactMouseEvent, name: string) => {
    if (e.button !== 0) return;
    if (renamingName && renamingName !== name) {
      void commitRename();
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click toggles the item without starting a rubber band.
      e.stopPropagation();
      setSelectedNames((prev) =>
        prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
      );
      setLastClickedName(name);
      lastClickRef.current = { name: null, ts: 0 };
      return;
    }
    if (e.shiftKey && lastClickedName) {
      e.stopPropagation();
      const names = entries.map((entry) => entry.name);
      const from = names.indexOf(lastClickedName);
      const to = names.indexOf(name);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelectedNames(names.slice(lo, hi + 1));
      }
      lastClickRef.current = { name: null, ts: 0 };
      return;
    }
    e.stopPropagation();
    if (!selectedNames.includes(name)) {
      setSelectedNames([name]);
    }
    setLastClickedName(name);
  };

  const itemClick = (name: string) => {
    const now = Date.now();
    const prev = lastClickRef.current;
    if (prev.name === name && now - prev.ts > 400 && renamingName !== name) {
      // Two clicks on the same name spaced wider than a double-click: inline rename.
      lastClickRef.current = { name: null, ts: 0 };
      beginRename(name);
      return;
    }
    lastClickRef.current = { name, ts: now };
  };

  const containerMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (renamingName) void commitRename();
    const target = e.target as HTMLElement;
    if (!target.closest("[data-item-name]") && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Blank area: plain press clears the selection.
      setSelectedNames([]);
      setLastClickedName(null);
      lastClickRef.current = { name: null, ts: 0 };
    }
  };

  const renderItemName = (
    item: AdbDetailedFileEntry,
    display: ReactNode,
    options?: { suffix?: ReactNode }
  ) => {
    if (renamingName === item.name) {
      return (
        <span
          className="inline-flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={renameInputRef}
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleRenameKeyDown}
            className="w-full rounded border border-blue-500 bg-white px-1 py-0.5 text-xs text-slate-900 outline-none dark:bg-slate-900 dark:text-slate-100"
          />
          <button
            title={t("common.save")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={commitRename}
            className="rounded bg-emerald-500/20 p-0.5 text-emerald-600 dark:text-emerald-400"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            title={t("common.cancel")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelRename}
            className="rounded bg-rose-500/20 p-0.5 text-rose-500"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      );
    }
    return (
      <>
        {display}
        {options?.suffix}
      </>
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
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs">
      <div className="ui-toolbar">
        <div className="flex items-center gap-2.5 text-slate-600 dark:text-slate-300">
          <div className="ui-title">
            <Folder className="h-4 w-4 text-blue-500" />
            <span>{t("nav.adb")}</span>
          </div>
          <span className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {folderCount} folders · {fileCount} files
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedNames.length > 0 && (
            <>
              <button
                onClick={handleBatchDownload}
                className="ui-btn-success"
              >
                <Download className="h-3.5 w-3.5" />
                {t("common.download")} ({selectedNames.length})
              </button>
              <button
                onClick={() => setModal({ type: "delete", names: selectedNames })}
                className="ui-btn-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")} ({selectedNames.length})
              </button>
              <div className="mx-0.5 hidden h-4 w-px bg-slate-200 dark:bg-slate-700 sm:block" />
            </>
          )}
          <button
            disabled={!serial}
            onClick={() => setModal({ type: "mkdir", value: "" })}
            className="ui-btn-secondary"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("adb.mkdir")}
          </button>
          <button
            disabled={!serial}
            onClick={handleUpload}
            className="ui-btn-primary"
          >
            <Upload className="h-3.5 w-3.5" />
            {t("common.upload")}
          </button>
          <div className="mx-0.5 hidden h-4 w-px bg-slate-200 dark:bg-slate-700 sm:block" />
          <div className="ui-segmented">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              title="Grid"
              className={`ui-segmented-btn !px-2 ${
                viewMode === "grid"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              title="List"
              className={`ui-segmented-btn !px-2 ${
                viewMode === "list"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="ui-card flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <button
            disabled={!serial || currentPath === "/"}
            onClick={goParent}
            className="rounded-md p-1 text-slate-600 transition hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            disabled={!serial}
            onClick={() => loadDir(serial, "/")}
            className={`rounded-md px-1.5 py-0.5 font-mono transition hover:bg-slate-100 dark:hover:bg-slate-800 ${
              crumbs.length === 0
                ? "font-semibold text-slate-900 dark:text-slate-100"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            /
          </button>
          {crumbs.map((seg, i) => {
            const target = "/" + crumbs.slice(0, i + 1).join("/");
            const isLast = i === crumbs.length - 1;
            return (
              <span key={target} className="flex items-center gap-1">
                <span className="text-slate-400">&gt;</span>
                <button
                  onClick={() => loadDir(serial, target)}
                  className={`rounded-md px-1.5 py-0.5 font-mono transition hover:bg-slate-100 dark:hover:bg-slate-800 ${
                    isLast
                      ? "font-semibold text-slate-900 dark:text-slate-100"
                      : "text-slate-600 dark:text-slate-300"
                  }`}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {entries.length > 0 && (
            <button
              onClick={() =>
                setSelectedNames(
                  selectedNames.length === entries.length ? [] : entries.map((e) => e.name)
                )
              }
              className="ui-btn-secondary !px-2.5 !py-1 text-[11px]"
            >
              {selectedNames.length === entries.length ? "取消全选" : "全选"}
            </button>
          )}
          <button
            disabled={!serial}
            onClick={() => loadDir(serial, currentPath)}
            className="ui-btn-secondary !p-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}

      <div
        ref={(el) => {
          listWrapRef.current = el;
          setListEl(el);
        }}
        onMouseDown={containerMouseDown}
        className="ui-card relative flex-1 overflow-y-auto p-4"
      >
        <Selecto
          dragContainer={listEl ?? undefined}
          selectableTargets={["[data-item-name]"]}
          selectFromInside={false}
          selectByClick={false}
          hitRate={20}
          checkInput
          toggleContinueSelect={["ctrl"]}
          onDragStart={(e) => {
            // Renaming or pressing on an item itself: never start a rubber band.
            const src = e.inputEvent.target as HTMLElement | null;
            if (renamingName || (src && src.closest("[data-item-name]"))) {
              e.stop();
            }
          }}
          onSelect={(e) => {
            const added = e.added
              .map((el) => el.dataset.itemName)
              .filter((n): n is string => !!n);
            const removed = e.removed
              .map((el) => el.dataset.itemName)
              .filter((n): n is string => !!n);
            setSelectedNames((prev) => {
              const set = new Set(prev);
              for (const n of added) set.add(n);
              for (const n of removed) set.delete(n);
              return [...set];
            });
          }}
        />
        {loading ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 py-12 text-center text-slate-500 dark:text-slate-400">
            <RefreshCw className="h-6 w-6 animate-spin text-slate-400" />
            <span>{t("common.loading")}</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 py-12 text-center text-slate-500 dark:text-slate-400">
            <Folder className="h-8 w-8 text-slate-300 dark:text-slate-700" />
            <span>{serial ? t("adb.emptyDir") : t("adb.waitConnect")}</span>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {entries.map((item) => {
              const editable = !item.is_dir && isEditableTextFile(item.name);
              const checked = selectedNames.includes(item.name);
              return (
                <div
                  key={item.name}
                  data-item-name={item.name}
                  onMouseDown={(e) => itemMouseDown(e, item.name)}
                  onClick={() => itemClick(item.name)}
                  onDoubleClick={() => {
                    if (renamingName === item.name) {
                      cancelRename();
                      return;
                    }
                    item.is_dir ? loadDir(serial, joinPath(item.name)) : handleOpenFile(item.name);
                  }}
                  className={`group relative flex cursor-pointer flex-col items-center rounded-lg border p-2.5 text-center transition ${
                    checked
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/70"
                  }`}
                >
                  {item.is_dir ? (
                    <Folder
                      onClick={() => loadDir(serial, joinPath(item.name))}
                      className="h-10 w-10 fill-amber-400 text-amber-500"
                    />
                  ) : (
                    <FileIcon className="h-10 w-10 text-slate-400" />
                  )}
                  <div title={item.name} className="mt-1.5 w-full truncate font-medium text-slate-800 dark:text-slate-100">
                    {renderItemName(item, item.name)}
                  </div>
                  {!item.is_dir && renamingName !== item.name && (
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-slate-400">{item.size} B</div>
                  )}
                  <div className="mt-1.5 hidden gap-1 group-hover:flex">
                    {!item.is_dir && (
                      <button
                        onClick={() => handleDownload(item.name)}
                        title={t("common.download")}
                        className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 shadow-sm hover:text-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      >
                        <Download className="h-3 w-3" />
                      </button>
                    )}
                    {editable && (
                      <button
                        onClick={() => handleOpenFile(item.name)}
                        title={t("common.edit")}
                        className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 shadow-sm hover:text-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      >
                        <Edit3 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">{t("sector.name")}</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">{t("adb.modifiedTime")}</th>
                <th className="px-3 py-2">{t("adb.permissions")}</th>
                <th className="px-3 py-2 text-right">{t("sector.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {entries.map((item) => {
                const editable = !item.is_dir && isEditableTextFile(item.name);
                const checked = selectedNames.includes(item.name);
                return (
                  <tr
                    key={item.name}
                    data-item-name={item.name}
                    onMouseDown={(e) => itemMouseDown(e, item.name)}
                    onClick={() => itemClick(item.name)}
                    onDoubleClick={() => {
                      if (renamingName === item.name) {
                        cancelRename();
                        return;
                      }
                      item.is_dir ? loadDir(serial, joinPath(item.name)) : handleOpenFile(item.name);
                    }}
                    className={checked ? "bg-blue-500/10 hover:bg-blue-500/15" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}
                  >
                    <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-100">
                      {item.is_dir ? (
                        <span
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            if (renamingName === item.name) {
                              cancelRename();
                              return;
                            }
                            loadDir(serial, joinPath(item.name));
                          }}
                          className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {renderItemName(item, <>{item.name}/</>)}
                        </span>
                      ) : (
                        renderItemName(item, item.name)
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{item.is_dir ? "-" : `${item.size} B`}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{item.modified_time || "-"}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{item.permissions || "-"}</td>
                    <td className="space-x-2 whitespace-nowrap px-3 py-1.5 text-right">
                      {!item.is_dir && (
                        <button onClick={() => handleDownload(item.name)} className="text-blue-600 hover:underline dark:text-blue-400">
                          {t("common.download")}
                        </button>
                      )}
                      {editable && (
                        <button onClick={() => handleOpenFile(item.name)} className="text-blue-600 hover:underline dark:text-blue-400">
                          {t("common.edit")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="ui-card flex items-center gap-2 px-4 py-2.5">
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runShell()}
          placeholder={t("adb.shellPlaceholder")}
          className="ui-input flex-1 font-mono"
        />
        <button onClick={runShell} className="ui-btn-primary">
          {t("adb.runShell")}
        </button>
      </div>
      {shellOutput && (
        <div className="ui-terminal max-h-28 overflow-auto p-3">
          <AnsiText text={shellOutput} showTimestamps={false} />
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-[1px]">
          <div className="ui-card w-full max-w-sm space-y-4 p-5 shadow-xl">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {modal.type === "mkdir" && t("adb.newFolderPrompt")}
              {modal.type === "delete" && `${t("adb.deleteConfirm")} (${modal.names.join(", ")})`}
            </div>
            {modal.type !== "delete" && (
              <input
                autoFocus
                value={modal.value}
                onChange={(e) => setModal({ ...modal, value: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && submitModal()}
                className="ui-input w-full"
              />
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setModal(null)} className="ui-btn-secondary">
                {t("common.cancel")}
              </button>
              <button
                onClick={submitModal}
                className={modal.type === "delete" ? "ui-btn-danger" : "ui-btn-primary"}
              >
                {modal.type === "delete" ? t("common.delete") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-[1px]">
          <div className="ui-card flex h-[75vh] w-full max-w-4xl flex-col gap-3 p-5 shadow-xl">
            <div className="flex items-center justify-between font-mono text-sm font-semibold">
              <span className="truncate">
                {t("adb.editTitle")}: {editingFile.path}
              </span>
              <div className="flex items-center gap-2">
                <div className="ui-segmented">
                  <button
                    type="button"
                    onClick={() => setFileViewTab("editor")}
                    className={`ui-segmented-btn ${
                      fileViewTab === "editor"
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-600 dark:text-slate-300"
                    }`}
                  >
                    {t("adb.editorTab")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFileViewTab("ansi")}
                    className={`ui-segmented-btn ${
                      fileViewTab === "ansi"
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-600 dark:text-slate-300"
                    }`}
                  >
                    {t("adb.ansiTab")}
                  </button>
                </div>
                <button onClick={() => setEditingFile(null)} className="ui-btn-secondary">
                  {t("common.cancel")}
                </button>
                <button onClick={saveEditedText} className="ui-btn-primary">
                  {t("adb.saveBack")}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              {fileViewTab === "ansi" ? (
                <div className="ui-terminal h-full overflow-auto border-0 p-3">
                  <AnsiText text={editingFile.content} showTimestamps={false} />
                </div>
              ) : (
                <Editor
                  height="100%"
                  language={detectMonacoLanguage(editingFile.path)}
                  theme={theme === "dark" ? "vs-dark" : "vs"}
                  value={editingFile.content}
                  onChange={(val) => setEditingFile({ ...editingFile, content: val ?? "" })}
                  options={{ minimap: { enabled: false }, fontSize: 13 }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
