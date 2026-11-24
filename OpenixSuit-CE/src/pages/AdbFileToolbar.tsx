import { useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Clipboard, RefreshCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileSort } from "./adbFileBrowser";

interface AdbFileToolbarProps {
  connected: boolean;
  loading: boolean;
  currentPath: string;
  copiedPath: string;
  search: string;
  sort: FileSort;
  descending: boolean;
  canSelectAll: boolean;
  allSelected: boolean;
  onOpenDirectory: (path: string) => void;
  onJump: (path: string) => Promise<boolean>;
  onCopyPath: (path: string) => void;
  onSearch: (search: string) => void;
  onSort: (sort: FileSort) => void;
  onReverse: () => void;
  onSelectAll: () => void;
}

export function AdbFileToolbar({
  connected, loading, currentPath, copiedPath, search, sort, descending, canSelectAll, allSelected,
  onOpenDirectory, onJump, onCopyPath, onSearch, onSort, onReverse, onSelectAll,
}: AdbFileToolbarProps) {
  const { t } = useTranslation();
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const crumbs = currentPath.split("/").filter(Boolean);
  const parent = "/" + crumbs.slice(0, -1).join("/");
  const Order = descending ? ArrowDown : ArrowUp;

  return (
    <div className="ui-card space-y-2 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={t("adb.parentDir")}
          title={t("adb.parentDir")}
          disabled={!connected || currentPath === "/"}
          onClick={() => { setPathDraft(null); onOpenDirectory(parent); }}
          className="ui-btn-secondary !p-1.5"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        {pathDraft === null ? (
          <div className="flex min-w-20 flex-1 items-center gap-1 overflow-x-auto" aria-label={t("adb.devicePath")}>
            {["/", ...crumbs].map((segment, index) => {
              const path = "/" + crumbs.slice(0, index).join("/");
              return (
                <span className="flex shrink-0 items-center gap-1" key={path}>
                  {index > 0 && <span className="text-slate-400" aria-hidden="true">/</span>}
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() => onOpenDirectory(path)}
                    aria-current={path === currentPath ? "location" : undefined}
                    className={`rounded px-1.5 py-0.5 font-mono hover:bg-slate-100 dark:hover:bg-slate-800 ${path === currentPath ? "font-semibold" : "text-slate-500 dark:text-slate-400"}`}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <form
            className="flex min-w-32 flex-1 items-center gap-1"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await onJump(pathDraft)) setPathDraft(null);
            }}
          >
            <input
              autoFocus
              aria-label={t("adb.devicePath")}
              className="ui-input min-w-0 flex-1 font-mono"
              value={pathDraft}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setPathDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setPathDraft(null); }}
            />
            <button type="submit" disabled={!connected || loading} className="ui-btn-secondary">{t("adb.go")}</button>
          </form>
        )}
        {pathDraft === null && (
          <button type="button" disabled={!connected} className="ui-btn-secondary" onClick={() => setPathDraft(currentPath)}>
            {t("adb.goToPath")}
          </button>
        )}
        <button
          type="button"
          disabled={!connected}
          aria-label={t("adb.copyDirectoryPath")}
          title={t("adb.copyDirectoryPath")}
          className="ui-btn-secondary !p-1.5"
          onClick={() => onCopyPath(currentPath)}
        >
          <Clipboard className="size-3.5" />
          {copiedPath === currentPath && <span role="status">{t("adb.pathCopied")}</span>}
        </button>
        <button type="button" disabled={!connected} className="ui-btn-secondary !p-1.5"
          aria-label={t("adb.refreshDirectory")} title={t("adb.refreshDirectory")} onClick={() => onOpenDirectory(currentPath)}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-36 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            disabled={!connected}
            placeholder={t("adb.searchDirectory")}
            aria-label={t("adb.searchDirectory")}
            className="ui-input w-full !pl-7"
          />
        </label>
        <select aria-label={t("adb.sortBy")} title={t("adb.sortBy")} value={sort} onChange={(event) => onSort(event.target.value as FileSort)} className="ui-select">
          <option value="name">{t("sector.name")}</option>
          <option value="size">{t("adb.size")}</option>
          <option value="time">{t("adb.modifiedTime")}</option>
        </select>
        <button type="button" className="ui-btn-secondary !p-1.5" aria-label={t(descending ? "adb.descending" : "adb.ascending")}
          title={t(descending ? "adb.descending" : "adb.ascending")} onClick={onReverse}
        >
          <Order className="size-3.5" />
        </button>
        <button type="button" className="ui-btn-secondary" disabled={!canSelectAll} onClick={onSelectAll}>
          {t(allSelected ? "adb.deselectAll" : "adb.selectAll")}
        </button>
      </div>
    </div>
  );
}
