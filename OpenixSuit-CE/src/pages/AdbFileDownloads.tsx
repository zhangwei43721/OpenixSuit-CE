import { useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type { AdbDetailedFileEntry } from "../types/workbench";
import { formatFileSize } from "./adbFileBrowser";

interface Transfer {
  name: string;
  bytes: number;
  expected: number;
  index: number;
  count: number;
}

interface DownloadResult {
  completed: number;
  failed: { name: string; reason: string }[];
  skippedLinks: number;
}

export function useAdbFileDownloads() {
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const active = useRef(false);

  async function download(
    serial: string,
    entries: AdbDetailedFileEntry[],
    remotePath: (name: string) => string,
  ) {
    if (active.current || !serial || entries.length === 0) return;
    active.current = true;
    setBusy(true);
    try {
      const path = await open({ directory: true });
      if (typeof path !== "string") return;

      setResult(null);
      const next: DownloadResult = { completed: 0, failed: [], skippedLinks: 0 };
      for (const [index, item] of entries.entries()) {
        const current = { name: item.name, bytes: 0, expected: item.is_dir ? 0 : item.size, index: index + 1, count: entries.length };
        setTransfer(current);
        const progress = new Channel<number>();
        let downloading = true;
        progress.onmessage = (bytes) => {
          if (downloading) setTransfer({ ...current, bytes });
        };
        try {
          if (item.is_dir) {
            const folder = await invoke<{ skipped_links: number }>("adb_download_directory", {
              serial, remotePath: remotePath(item.name), localDirectory: path, name: item.name, progress,
            });
            next.skippedLinks += folder.skipped_links;
          } else {
            await invoke<number>("adb_download_file", {
              serial,
              remotePath: remotePath(item.name),
              destination: { type: "directory", path, name: item.name },
              progress,
            });
          }
          next.completed += 1;
        } catch (error) {
          next.failed.push({ name: item.name, reason: String(error) });
        } finally {
          downloading = false;
        }
      }
      setResult(next);
      return { ...next, path };
    } finally {
      active.current = false;
      setTransfer(null);
      setBusy(false);
    }
  }

  return { busy, transfer, result, download, clear: () => setResult(null) };
}

export function AdbFileDownloadStatus({ transfer, result, onDismiss }: {
  transfer: Transfer | null;
  result: DownloadResult | null;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  if (transfer) {
    const expected = transfer.expected > 0 && transfer.expected >= transfer.bytes ? transfer.expected : undefined;
    const received = formatFileSize(transfer.bytes, i18n.language);
    return (
      <div className="ui-subcard space-y-1 px-3 py-2 text-xs" role="status">
        <div className="flex flex-wrap justify-between gap-1">
          <span className="min-w-0 break-all">{t("adb.downloading", {
            index: transfer.index, count: transfer.count, name: transfer.name,
          })}</span>
          <span className="shrink-0 tabular-nums">{received}{expected ? ` / ${formatFileSize(expected, i18n.language)}` : ""}</span>
        </div>
        <progress className="h-2 w-full" aria-label={transfer.name} value={expected ? transfer.bytes : undefined} max={expected} />
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className="ui-subcard space-y-1 px-3 py-2 text-xs" role="status">
      <div className="flex justify-between gap-2">
        <span>{t("adb.downloadResult", { completed: result.completed, failed: result.failed.length })}</span>
        <button type="button" className="shrink-0 text-slate-500 hover:underline" onClick={onDismiss}>{t("adb.dismiss")}</button>
      </div>
      {result.skippedLinks > 0 && (
        <p className="break-all text-slate-600 dark:text-slate-300">{t("adb.skippedLinks", { count: result.skippedLinks })}</p>
      )}
      {result.failed.length > 0 && (
        <ul className="max-h-24 overflow-auto break-all text-red-600 dark:text-red-400">
          {result.failed.map(({ name, reason }) => <li key={name}>{name} · {reason}</li>)}
        </ul>
      )}
    </div>
  );
}
