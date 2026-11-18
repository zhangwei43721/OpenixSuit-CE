import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Edit2, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult, SharedPartitionEntry } from "./FlashHub";

export function SectorFlash({
  active = true,
  firmwarePath,
  inspectInfo,
  isFlashing,
  onFlashingChange,
  onLog,
}: {
  active?: boolean;
  firmwarePath: string;
  inspectInfo: SharedImageInspectResult | null;
  isFlashing: boolean;
  onFlashingChange: (v: boolean) => void;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [partitions, setPartitions] = useState<SharedPartitionEntry[]>([]);
  const [alignSectors, setAlignSectors] = useState(128);
  const [includeCopies, setIncludeCopies] = useState(true);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editRow, setEditRow] = useState<SharedPartitionEntry | null>(null);
  const [newName, setNewName] = useState("");
  const [newFile, setNewFile] = useState("");
  const [newAddr, setNewAddr] = useState("0x00000020");
  const [newSectors, setNewSectors] = useState(0);
  const [verify, setVerify] = useState(true);
  const [postAction, setPostAction] = useState<"keep" | "reboot" | "poweroff">("reboot");
  const [progress, setProgress] = useState<{ partition: string; percent: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [opLogs, setOpLogs] = useState<string[]>([]);
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  const appendLine = (msg: string) => {
    setOpLogs((p) => [...p.slice(-499), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const log = (msg: string) => {
    appendLine(msg);
    onLog(msg);
  };

  useEffect(() => {
    const unlistenProgress = listen<{ partition: string; percent: number }>("flash-progress", (e) => {
      setProgress({ partition: e.payload.partition, percent: e.payload.percent });
    });
    const unlistenLog = listen<{ stage: string; level: string; message: string }>(
      "flash-log",
      (e) => {
        if (!active || !e.payload?.message) return;
        const warnTag = e.payload.level === "warn" ? "[WARN] " : "";
        appendLine(`[${e.payload.stage || "FLASH"}] ${warnTag}${e.payload.message}`);
      }
    );
    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenLog.then((fn) => fn());
    };
  }, [active]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [opLogs]);

  useEffect(() => {
    setProgress(null);
    if (inspectInfo) {
      setPartitions(inspectInfo.partitions);
      log(`同步 MBR 分区表: ${inspectInfo.partitions.length} 个分区`);
    } else {
      setPartitions([]);
    }
  }, [inspectInfo]);

  const exportMbr = async () => {
    try {
      const outPath = await save({ defaultPath: "sunxi_mbr.bin" });
      if (!outPath) return;
      await invoke("export_mbr_binary", {
        partitions,
        includeCopies,
        outPath,
      });
      log(`Exported MBR -> ${outPath}`);
    } catch (err) {
      log(`Export failed: ${String(err)}`);
    }
  };

  const addPartition = () => {
    if (!newName.trim()) return;
    const addr = parseInt(newAddr, 16) || 0;
    const aligned = Math.ceil(addr / alignSectors) * alignSectors;
    setPartitions((prev) => [
      ...prev,
      {
        index: prev.length,
        name: newName.trim(),
        download_file: newFile || "-",
        start_sector: aligned,
        sectors: newSectors,
        size_bytes: newSectors * 512,
        type_guid: "Sunxi-MBR",
      },
    ]);
    setNewName("");
    setNewFile("");
    setNewSectors(0);
  };

  const saveEditRow = () => {
    if (editingIdx === null || !editRow) return;
    setPartitions((prev) => prev.map((p, i) => (i === editingIdx ? editRow : p)));
    setEditingIdx(null);
    setEditRow(null);
  };

  const flashPartitions = async () => {
    if (partitions.length === 0 || !firmwarePath) return;
    onFlashingChange(true);
    setErrorMsg(null);
    setProgress(null);
    log("开始按编辑后的 MBR 扇区表刷写到设备...");
    try {
      await invoke("flash_custom_mbr_layout", {
        firmwarePath,
        partitions,
        includeCopies,
        verify,
        postAction,
      });
      log("Sector MBR flash completed");
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      log(`Flash error: ${msg}`);
    } finally {
      onFlashingChange(false);
    }
  };

  const cancelFlash = async () => {
    try {
      await invoke("cancel_flash");
    } catch (err) {
      log(String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-12 gap-3">
      <div className="col-span-3 space-y-3">
        <div className="ui-card overflow-hidden text-xs">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("sector.exportMbr")}</span>
          </div>
          <div className="space-y-3 p-4">
            <label className="flex cursor-pointer items-center gap-2 text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={includeCopies}
                onChange={(e) => setIncludeCopies(e.target.checked)}
                className="accent-blue-600"
              />
              {t("sector.includeCopies")}
            </label>
            <button
              disabled={partitions.length === 0}
              onClick={exportMbr}
              className="ui-btn-secondary w-full"
            >
              {t("sector.exportBtn")}
            </button>
          </div>
        </div>

        <div className="ui-card overflow-hidden text-xs">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("flash.options")}</span>
          </div>
          <div className="space-y-3 p-4">
            <label className="flex cursor-pointer items-center gap-2 text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                disabled={isFlashing}
                checked={verify}
                onChange={(e) => setVerify(e.target.checked)}
                className="accent-blue-600"
              />
              {t("flash.verify")}
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600 dark:text-slate-300">{t("flash.postAction")}</span>
              <select
                disabled={isFlashing}
                value={postAction}
                onChange={(e) => setPostAction(e.target.value as "keep" | "reboot" | "poweroff")}
                className="ui-select"
              >
                <option value="reboot">{t("flash.reboot")}</option>
                <option value="poweroff">{t("flash.poweroff")}</option>
                <option value="keep">{t("flash.keepState")}</option>
              </select>
            </div>
            {progress && (
              <div className="space-y-1.5 pt-1">
                <div className="flex justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="truncate">{progress.partition}</span>
                  <span className="shrink-0 font-mono tabular-nums">{progress.percent.toFixed(1)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                disabled={isFlashing || partitions.length === 0 || !firmwarePath}
                onClick={flashPartitions}
                className="ui-btn-success flex-1 py-2"
              >
                {isFlashing ? t("flash.flashing") : t("sector.flashBtn")}
              </button>
              {isFlashing && (
                <button
                  onClick={cancelFlash}
                  className="ui-btn-danger py-2"
                >
                  {t("common.cancel")}
                </button>
              )}
            </div>
          </div>
        </div>

        {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}
      </div>

      <div className="col-span-9 flex min-h-0 flex-col gap-3">
        <div className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">
              {t("sector.editorTitle")} ({partitions.length}/120)
            </span>
            <div className="flex items-center gap-2">
              <select
                value={alignSectors}
                onChange={(e) => setAlignSectors(Number(e.target.value))}
                className="ui-select"
              >
                <option value={128}>64K (128 sectors align)</option>
                <option value={2048}>1M (2048 sectors align)</option>
              </select>
              <button
                onClick={() => setPartitions([])}
                className="ui-btn-danger p-1.5"
                title={t("log.clear")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50/90 text-[11px] font-semibold text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">{t("sector.name")}</th>
                  <th className="px-3 py-2">{t("sector.downloadFile")}</th>
                  <th className="px-3 py-2">{t("sector.address")}</th>
                  <th className="px-3 py-2">{t("sector.sectors")}</th>
                  <th className="px-3 py-2 text-right">{t("sector.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {partitions.map((p, idx) => {
                  const isEd = editingIdx === idx && editRow;
                  return (
                    <tr key={`${p.name}-${idx}`} className="transition hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                      <td className="px-3 py-2 font-mono tabular-nums text-slate-400">{idx}</td>
                      <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">
                        {isEd ? (
                          <input
                            value={editRow.name}
                            onChange={(e) => setEditRow({ ...editRow, name: e.target.value })}
                            className="ui-input w-24 py-1"
                          />
                        ) : (
                          p.name
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-500 dark:text-slate-400">
                        {isEd ? (
                          <input
                            value={editRow.download_file}
                            onChange={(e) => setEditRow({ ...editRow, download_file: e.target.value })}
                            className="ui-input w-32 py-1 font-mono"
                          />
                        ) : (
                          p.download_file || "-"
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {isEd ? (
                          <input
                            value={`0x${editRow.start_sector.toString(16)}`}
                            onChange={(e) =>
                              setEditRow({ ...editRow, start_sector: parseInt(e.target.value, 16) || 0 })
                            }
                            className="ui-input w-24 py-1 font-mono tabular-nums"
                          />
                        ) : (
                          `0x${p.start_sector.toString(16).padStart(8, "0")}`
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {isEd ? (
                          <input
                            type="number"
                            value={editRow.sectors}
                            onChange={(e) =>
                              setEditRow({
                                ...editRow,
                                sectors: Number(e.target.value),
                                size_bytes: Number(e.target.value) * 512,
                              })
                            }
                            className="ui-input w-20 py-1 font-mono tabular-nums"
                          />
                        ) : (
                          p.sectors
                        )}
                      </td>
                      <td className="space-x-1.5 whitespace-nowrap px-3 py-2 text-right">
                        {isEd ? (
                          <>
                            <button onClick={saveEditRow} className="rounded-md bg-emerald-500/20 p-1.5 text-emerald-600 transition hover:bg-emerald-500/30 dark:text-emerald-400">
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setEditingIdx(null)} className="rounded-md bg-rose-500/20 p-1.5 text-rose-500 transition hover:bg-rose-500/30">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setEditingIdx(idx);
                                setEditRow({ ...p });
                              }}
                              className="rounded-md bg-slate-100 p-1.5 text-slate-600 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setPartitions((prev) => prev.filter((_, i) => i !== idx))}
                              className="text-xs font-medium text-rose-500 transition hover:text-rose-600 hover:underline dark:hover:text-rose-400"
                            >
                              {t("common.delete")}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-slate-50/50 dark:bg-slate-950/30">
                  <td className="px-3 py-2 font-mono text-slate-400">*</td>
                  <td className="px-3 py-2">
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("sector.partPlaceholder")}
                      className="ui-input w-24 py-1"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={newFile}
                      onChange={(e) => setNewFile(e.target.value)}
                      placeholder={t("sector.filePlaceholder")}
                      className="ui-input w-32 py-1 font-mono"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={newAddr}
                      onChange={(e) => setNewAddr(e.target.value)}
                      className="ui-input w-24 py-1 font-mono tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      value={newSectors}
                      onChange={(e) => setNewSectors(Number(e.target.value))}
                      className="ui-input w-20 py-1 font-mono tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={addPartition} className="ui-btn-success p-1.5">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="ui-card flex h-48 shrink-0 flex-col overflow-hidden">
          <div className="ui-card-header py-2">
            <span className="ui-title">
              {t("log.live")} ({opLogs.length})
            </span>
            {opLogs.length > 0 && (
              <button
                type="button"
                onClick={() => setOpLogs([])}
                className="text-[11px] font-medium text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              >
                {t("log.clear")}
              </button>
            )}
          </div>
          <pre
            ref={logBoxRef}
            className="ui-terminal min-h-0 flex-1 overflow-y-auto rounded-none border-0 p-3 text-slate-300"
          >
            {opLogs.join("\n") || "OPERATION LOG"}
          </pre>
        </div>
      </div>
    </div>
  );
}
