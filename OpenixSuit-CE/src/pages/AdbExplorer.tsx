import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Editor from "@monaco-editor/react";
import {
  ArrowDown,
  ArrowUp,
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
import { AdbFileDownloadStatus, useAdbFileDownloads } from "./AdbFileDownloads";
import { AdbFileToolbar } from "./AdbFileToolbar";
import { formatFileSize, matchesFilename, sortFiles, type FileSort } from "./adbFileBrowser";

const STORAGE_PATHS_KEY = "adb_paths_by_serial";
const VIEW_MODE_KEY = "adb_file_view_mode";

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
  const { t, i18n } = useTranslation();
  const [currentPath, setCurrentPath] = useState(() =>
    serial ? getSavedPathForSerial(serial) : "/"
  );
  const [entries, setEntries] = useState<AdbDetailedFileEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid");
  const [search, setSearch] = useState("");
  const [copiedPath, setCopiedPath] = useState("");
  const [sort, setSort] = useState<{ field: FileSort; descending: boolean }>({ field: "name", descending: false });
  const visibleEntries = useMemo(() => sortFiles(
    entries.filter((entry) => matchesFilename(entry.name, search)), sort.field, sort.descending, i18n.language,
  ), [entries, search, sort, i18n.language]);
  const downloads = useAdbFileDownloads();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<{ path: string; content: string } | null>(null);
  const [fileViewTab, setFileViewTab] = useState<"editor" | "ansi">("editor");
  const [modal, setModal] = useState<PromptModal>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [lastClickedName, setLastClickedName] = useState<string | null>(null);
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
    setLastClickedName(null);
    try {
      const list = await invoke<AdbDetailedFileEntry[]>("adb_list_dir_detailed", {
        serial: targetSerial,
        remotePath: path,
      });
      if (reqId !== reqIdRef.current) return;
      if (currentPathRef.current !== path) setSearch("");
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
    setSearch("");
    if (serial) {
      const savedPath = getSavedPathForSerial(serial);
      setCurrentPath(savedPath);
      loadDir(serial, savedPath, true);
    } else {
      reqIdRef.current += 1;
      setLoading(false);
      setEntries([]);
      setSelectedNames([]);
    }
  }, [serial]);

  const jumpToPath = async (input: string, fallbackToRoot = false) => {
    if (!serial) return false;
    const raw = input.trim();
    if (!raw.startsWith("/") || /[\x00-\x1f\x7f]/.test(raw)) {
      setErrorMsg(t("adb.absolutePathRequired"));
      return false;
    }
    const path = raw.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    setSearch("");
    if (path === "/") return Boolean(await loadDir(serial, "/"));
    const lastSlash = path.lastIndexOf("/");
    const parent = path.slice(0, lastSlash) || "/";
    const name = path.slice(lastSlash + 1);
    const list = await loadDir(serial, parent, fallbackToRoot, name);
    if (!list || serialRef.current !== serial) return false;
    const match = list.find((item) => item.name === name);
    if (!match) {
      if (!fallbackToRoot) setErrorMsg(t("adb.pathNotFound", { path }));
      return false;
    }
    if (match.is_dir) return Boolean(await loadDir(serial, path));
    requestAnimationFrame(() => {
      const items = listWrapRef.current?.querySelectorAll<HTMLElement>("[data-item-name]");
      Array.from(items ?? []).find((item) => item.dataset.itemName === name)?.scrollIntoView({ block: "nearest" });
    });
    return true;
  };

  const jumpToPathRef = useRef(jumpToPath);
  jumpToPathRef.current = jumpToPath;
  useEffect(() => {
    if (serial && jumpRequest?.path) void jumpToPathRef.current(jumpRequest.path, true);
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

  const selectItem = (e: ReactMouseEvent, name: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (renamingName === name) return;
    if (e.ctrlKey || e.metaKey) {
      setSelectedNames((prev) =>
        prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
      );
      setLastClickedName(name);
      return;
    }
    if (e.shiftKey && lastClickedName) {
      const names = visibleEntries.map((entry) => entry.name);
      const from = names.indexOf(lastClickedName);
      const to = names.indexOf(name);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelectedNames(names.slice(lo, hi + 1));
        return;
      }
    }
    setSelectedNames([name]);
    setLastClickedName(name);
  };

  const openItem = (item: AdbDetailedFileEntry) => {
    if (renamingName === item.name) return;
    if (item.is_dir) void loadDir(serial, joinPath(item.name));
    else void handleOpenFile(item.name);
  };

  const openOnDoubleClick = (event: ReactMouseEvent, item: AdbDetailedFileEntry) => {
    if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      openItem(item);
    }
  };

  const handleItemKeyDown = (event: ReactKeyboardEvent, item: AdbDetailedFileEntry) => {
    if (event.target !== event.currentTarget || renamingName || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      openItem(item);
    } else if (event.key === " " || event.key === "F2") {
      event.preventDefault();
      setSelectedNames([item.name]);
      setLastClickedName(item.name);
      if (event.key === "F2") beginRename(item.name);
    }
  };

  const containerMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (renamingName) void commitRename();
    const target = e.target as HTMLElement;
    if (!target.closest("[data-item-name]") && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Blank area: plain press clears the selection.
      setSelectedNames([]);
      setLastClickedName(null);
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

  async function downloadItems(items: AdbDetailedFileEntry[]) {
    try {
      const result = await downloads.download(serial, items, joinPath);
      if (result) {
        onLog(`${t("adb.downloadResult", {
          completed: result.completed, failed: result.failed.length,
        })} → ${result.path}`);
      }
    } catch (error) {
      setErrorMsg(String(error));
    }
  }

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

  const folderCount = entries.filter((e) => e.is_dir).length;
  const fileCount = entries.length - folderCount;
  const selection = new Set(selectedNames);
  const selectedEntries = visibleEntries.filter((entry) => selection.has(entry.name));
  const allVisibleSelected = visibleEntries.length > 0 && selectedEntries.length === visibleEntries.length;
  const selectedPath = selectedEntries.length === 1 ? joinPath(selectedEntries[0].name) : "";

  function changeSearch(value: string) {
    setSearch(value);
    setSelectedNames((previous) => previous.filter((name) => matchesFilename(name, value)));
    setLastClickedName(null);
  }

  function changeView(mode: "grid" | "list") {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
    } catch (error) {
      setErrorMsg(String(error));
    }
  }

  useEffect(() => {
    if (!copiedPath) return;
    const timer = window.setTimeout(() => setCopiedPath(""), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedPath]);

  function sizeLabel(item: AdbDetailedFileEntry) {
    return item.is_dir ? "—" : (
      <span title={`${item.size.toLocaleString(i18n.language)} B`}>{formatFileSize(item.size, i18n.language)}</span>
    );
  }

  function sortHeader(field: FileSort, label: string) {
    const active = sort.field === field;
    const Icon = sort.descending ? ArrowDown : ArrowUp;
    return (
      <th className="px-3 py-2" aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
        <button type="button" className="inline-flex items-center gap-1 hover:text-blue-600" onClick={() => setSort({
          field, descending: active ? !sort.descending : field !== "name",
        })}>
          {label}
          {active && <Icon className="size-3" aria-hidden="true" />}
        </button>
      </th>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs">
      <div className="ui-toolbar">
        <div className="flex items-center gap-2.5 text-slate-600 dark:text-slate-300">
          <div className="ui-title">
            <Folder className="h-4 w-4 text-blue-500" />
            <span>{t("nav.adb")}</span>
          </div>
          <span className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {t("adb.itemCount", { folders: folderCount, files: fileCount })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedEntries.length > 0 && (
            <>
              <button
                type="button"
                disabled={downloads.busy}
                onClick={() => void downloadItems(selectedEntries)}
                className="ui-btn-success"
              >
                <Download className="h-3.5 w-3.5" />
                {t("common.download")} ({selectedEntries.length})
              </button>
              {selectedPath && (
                <>
                  <button type="button" className="ui-btn-secondary" title={`${t("adb.rename")} (F2)`}
                    onClick={() => beginRename(selectedEntries[0].name)}>
                    {t("adb.rename")}
                  </button>
                  <button type="button" className="ui-btn-secondary" onClick={() => void copyPath(selectedPath)}>
                    {t(copiedPath === selectedPath ? "adb.pathCopied" : "adb.copyItemPath")}
                  </button>
                </>
              )}
              <button
                onClick={() => setModal({ type: "delete", names: selectedEntries.map((entry) => entry.name) })}
                className="ui-btn-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")} ({selectedEntries.length})
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
              onClick={() => changeView("grid")}
              aria-label={t("adb.gridView")}
              aria-pressed={viewMode === "grid"}
              title={t("adb.gridView")}
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
              onClick={() => changeView("list")}
              aria-label={t("adb.listView")}
              aria-pressed={viewMode === "list"}
              title={t("adb.listView")}
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

      <AdbFileToolbar
        key={serial}
        connected={Boolean(serial)}
        loading={loading}
        currentPath={currentPath}
        copiedPath={copiedPath}
        search={search}
        sort={sort.field}
        descending={sort.descending}
        canSelectAll={visibleEntries.length > 0}
        allSelected={allVisibleSelected}
        onOpenDirectory={(path) => void loadDir(serial, path)}
        onJump={jumpToPath}
        onCopyPath={(path) => void copyPath(path)}
        onSearch={changeSearch}
        onSort={(field) => setSort({ field, descending: field !== "name" })}
        onReverse={() => setSort((previous) => ({ ...previous, descending: !previous.descending }))}
        onSelectAll={() => setSelectedNames(allVisibleSelected ? [] : visibleEntries.map((entry) => entry.name))}
      />
      <AdbFileDownloadStatus transfer={downloads.transfer} result={downloads.result} onDismiss={downloads.clear} />

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
        ) : visibleEntries.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 py-12 text-center text-slate-500 dark:text-slate-400">
            <Folder className="h-8 w-8 text-slate-300 dark:text-slate-700" />
            <span>{serial ? t(search.trim() ? "adb.noSearchMatches" : "adb.emptyDir") : t("adb.waitConnect")}</span>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {visibleEntries.map((item) => {
              const editable = !item.is_dir && isEditableTextFile(item.name);
              const checked = selection.has(item.name);
              return (
                <div
                  key={item.name}
                  data-item-name={item.name}
                  tabIndex={0}
                  onClick={(event) => selectItem(event, item.name)}
                  onDoubleClick={(event) => openOnDoubleClick(event, item)}
                  onKeyDown={(event) => handleItemKeyDown(event, item)}
                  className={`group relative flex cursor-pointer flex-col items-center rounded-lg border p-2.5 text-center transition ${
                    checked
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/70"
                  }`}
                >
                  {item.is_dir ? (
                    <Folder
                      className="h-10 w-10 fill-amber-400 text-amber-500"
                    />
                  ) : (
                    <FileIcon className="h-10 w-10 text-slate-400" />
                  )}
                  <div title={item.name} className="mt-1.5 w-full truncate font-medium text-slate-800 dark:text-slate-100">
                    {renderItemName(item, item.name)}
                  </div>
                  {renamingName !== item.name && (
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-slate-400">{sizeLabel(item)}</div>
                  )}
                  {editable && (
                    <button
                      type="button"
                      aria-label={t("common.edit")}
                      title={t("common.edit")}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); void handleOpenFile(item.name); }}
                      onDoubleClick={(event) => event.stopPropagation()}
                      className="pointer-events-none absolute right-1 top-1 rounded-md border border-slate-200 bg-white p-1 text-slate-600 opacity-0 shadow-sm transition-opacity hover:text-blue-600 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    >
                      <Edit3 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400">
              <tr>
                {sortHeader("name", t("sector.name"))}
                {sortHeader("size", t("adb.size"))}
                {sortHeader("time", t("adb.modifiedTime"))}
                <th className="px-3 py-2">{t("adb.permissions")}</th>
                <th className="px-3 py-2 text-right">{t("sector.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {visibleEntries.map((item) => {
                const editable = !item.is_dir && isEditableTextFile(item.name);
                const checked = selection.has(item.name);
                return (
                  <tr
                    key={item.name}
                    data-item-name={item.name}
                    tabIndex={0}
                    onClick={(event) => selectItem(event, item.name)}
                    onDoubleClick={(event) => openOnDoubleClick(event, item)}
                    onKeyDown={(event) => handleItemKeyDown(event, item)}
                    className={`cursor-pointer ${checked ? "bg-blue-500/10 hover:bg-blue-500/15" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}`}
                  >
                    <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-100">
                      {renderItemName(item, item.is_dir ? `${item.name}/` : item.name)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{sizeLabel(item)}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{item.modified_time || "-"}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{item.permissions || "-"}</td>
                    <td className="space-x-2 whitespace-nowrap px-3 py-1.5 text-right" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
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
