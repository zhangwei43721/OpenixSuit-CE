import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Edit2, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult, SharedPartitionEntry } from "./FlashHub";

export function SectorFlash({
  firmwarePath,
  inspectInfo,
  isFlashing,
  onFlashingChange,
  onLog,
}: {
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

  const log = (msg: string) => {
    setOpLogs((p) => [...p.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    onLog(msg);
  };

  useEffect(() => {
    const unlisten = listen<{ partition: string; percent: number }>("flash-progress", (e) => {
      setProgress({ partition: e.payload.partition, percent: e.payload.percent });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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
    <div className="grid h-full grid-cols-12 gap-4">
      <div className="col-span-3 space-y-4">
        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-slate-500">{t("sector.exportMbr")}</div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeCopies}
              onChange={(e) => setIncludeCopies(e.target.checked)}
            />
            {t("sector.includeCopies")}
          </label>
          <button
            disabled={partitions.length === 0}
            onClick={exportMbr}
            className="w-full rounded border border-slate-300 bg-white py-1.5 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800"
          >
            {t("sector.exportBtn")}
          </button>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={isFlashing}
              checked={verify}
              onChange={(e) => setVerify(e.target.checked)}
            />
            {t("flash.verify")}
          </label>
          <div className="flex items-center justify-between gap-2 pt-1">
            <span>{t("flash.postAction")}</span>
            <select
              disabled={isFlashing}
              value={postAction}
              onChange={(e) => setPostAction(e.target.value as "keep" | "reboot" | "poweroff")}
              className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="reboot">{t("flash.reboot")}</option>
              <option value="poweroff">{t("flash.poweroff")}</option>
              <option value="keep">{t("flash.keepState")}</option>
            </select>
          </div>
          {progress && (
            <div className="space-y-1 pt-1">
              <div className="flex justify-between text-[11px] text-slate-500">
                <span className="truncate">{progress.partition}</span>
                <span>{progress.percent.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                <div className="h-full bg-emerald-600 transition-all" style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              disabled={isFlashing || partitions.length === 0 || !firmwarePath}
              onClick={flashPartitions}
              className="flex-1 rounded bg-emerald-600 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {isFlashing ? t("flash.flashing") : t("sector.flashBtn")}
            </button>
            {isFlashing && (
              <button
                onClick={cancelFlash}
                className="rounded bg-red-600 px-3 py-2 text-xs text-white hover:bg-red-500"
              >
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>

        {errorMsg && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-600 dark:text-amber-400">
            {errorMsg}
          </div>
        )}
      </div>

      <div className="col-span-9 flex flex-col space-y-3">
        <div className="flex flex-1 flex-col rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-semibold text-blue-500">
              {t("sector.editorTitle")} ({partitions.length}/120)
            </span>
            <div className="flex items-center gap-2">
              <select
                value={alignSectors}
                onChange={(e) => setAlignSectors(Number(e.target.value))}
                className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
              >
                <option value={128}>64K (128 sectors align)</option>
                <option value={2048}>1M (2048 sectors align)</option>
              </select>
              <button
                onClick={() => setPartitions([])}
                className="rounded bg-red-600 px-2 py-1 text-white"
                title={t("log.clear")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="py-1.5">#</th>
                  <th className="py-1.5">{t("sector.name")}</th>
                  <th className="py-1.5">{t("sector.downloadFile")}</th>
                  <th className="py-1.5">{t("sector.address")}</th>
                  <th className="py-1.5">{t("sector.sectors")}</th>
                  <th className="py-1.5 text-right">{t("sector.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {partitions.map((p, idx) => {
                  const isEd = editingIdx === idx && editRow;
                  return (
                    <tr key={`${p.name}-${idx}`}>
                      <td className="py-1.5">{idx}</td>
                      <td className="py-1.5 font-medium">
                        {isEd ? (
                          <input
                            value={editRow.name}
                            onChange={(e) => setEditRow({ ...editRow, name: e.target.value })}
                            className="w-24 rounded border border-slate-400 bg-white px-1 py-0.5 dark:bg-slate-950"
                          />
                        ) : (
                          p.name
                        )}
                      </td>
                      <td className="py-1.5 font-mono text-slate-500">
                        {isEd ? (
                          <input
                            value={editRow.download_file}
                            onChange={(e) => setEditRow({ ...editRow, download_file: e.target.value })}
                            className="w-32 rounded border border-slate-400 bg-white px-1 py-0.5 dark:bg-slate-950"
                          />
                        ) : (
                          p.download_file || "-"
                        )}
                      </td>
                      <td className="py-1.5 font-mono">
                        {isEd ? (
                          <input
                            value={`0x${editRow.start_sector.toString(16)}`}
                            onChange={(e) =>
                              setEditRow({ ...editRow, start_sector: parseInt(e.target.value, 16) || 0 })
                            }
                            className="w-24 rounded border border-slate-400 bg-white px-1 py-0.5 dark:bg-slate-950"
                          />
                        ) : (
                          `0x${p.start_sector.toString(16).padStart(8, "0")}`
                        )}
                      </td>
                      <td className="py-1.5 font-mono">
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
                            className="w-20 rounded border border-slate-400 bg-white px-1 py-0.5 dark:bg-slate-950"
                          />
                        ) : (
                          p.sectors
                        )}
                      </td>
                      <td className="space-x-1 py-1.5 text-right">
                        {isEd ? (
                          <>
                            <button onClick={saveEditRow} className="rounded bg-emerald-500/20 p-1 text-emerald-500">
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setEditingIdx(null)} className="rounded bg-red-500/20 p-1 text-red-500">
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
                              className="rounded bg-slate-200 p-1 dark:bg-slate-800"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setPartitions((prev) => prev.filter((_, i) => i !== idx))}
                              className="text-red-500 hover:underline"
                            >
                              {t("common.delete")}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="py-1.5">*</td>
                  <td>
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("sector.partPlaceholder")}
                      className="w-24 rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
                    />
                  </td>
                  <td>
                    <input
                      value={newFile}
                      onChange={(e) => setNewFile(e.target.value)}
                      placeholder={t("sector.filePlaceholder")}
                      className="w-32 rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
                    />
                  </td>
                  <td>
                    <input
                      value={newAddr}
                      onChange={(e) => setNewAddr(e.target.value)}
                      className="w-24 rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={newSectors}
                      onChange={(e) => setNewSectors(Number(e.target.value))}
                      className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
                    />
                  </td>
                  <td className="text-right">
                    <button onClick={addPartition} className="rounded bg-emerald-600 p-1 text-white">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <pre className="h-28 overflow-y-auto rounded border border-slate-200 bg-slate-900 p-2.5 font-mono text-xs text-slate-300 dark:border-slate-800 dark:bg-slate-950">
          {opLogs.join("\n") || "OPERATION LOG"}
        </pre>
      </div>
    </div>
  );
}
