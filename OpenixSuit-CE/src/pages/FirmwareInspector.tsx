import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult } from "./FlashHub";
import { SysConfigEditor } from "../components/SysConfigEditor";

export function FirmwareInspector({
  firmwarePath,
  inspectInfo,
  onLog,
}: {
  firmwarePath: string;
  inspectInfo: SharedImageInspectResult | null;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [dtsOutput, setDtsOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [unpacking, setUnpacking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const extractItem = async (partition: string) => {
    if (!firmwarePath) return;
    try {
      const dir = await open({ directory: true });
      if (typeof dir === "string") {
        const out = await invoke<string>("extract_partition", {
          imagePath: firmwarePath,
          partition,
          outDir: dir,
        });
        onLog(`Extracted ${partition} -> ${out}`);
      }
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      onLog(msg);
    }
  };

  const unpackAll = async () => {
    if (!firmwarePath) return;
    setErrorMsg(null);
    try {
      const outDir = await open({ directory: true });
      if (typeof outDir !== "string") return;
      setUnpacking(true);
      const res = await invoke<unknown>("unpack_firmware", {
        firmwarePath,
        outDir,
      });
      let count: number | null = null;
      if (typeof res === "number") {
        count = res;
      } else if (Array.isArray(res)) {
        count = res.length;
      } else if (
        res &&
        typeof res === "object" &&
        "count" in res &&
        typeof (res as { count: unknown }).count === "number"
      ) {
        count = (res as { count: number }).count;
      }
      if (count !== null) {
        onLog(`全部解包完成: 提取了 ${count} 个文件 -> ${outDir}`);
      } else if (typeof res === "string" && res) {
        onLog(`${res} -> ${outDir}`);
      } else {
        onLog(`全部解包完成: 提取了 ${inspectInfo?.files.length ?? 0} 个文件 -> ${outDir}`);
      }
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      onLog(msg);
    } finally {
      setUnpacking(false);
    }
  };

  const pickDtb = async () => {
    setErrorMsg(null);
    try {
      const file = await open({ filters: [{ name: "Device Tree Blob", extensions: ["dtb"] }] });
      if (typeof file === "string") {
        setLoading(true);
        const dts = await invoke<string>("dtb_to_dts", { dtbPath: file });
        setDtsOutput(dts);
        onLog(`DTB -> DTS: ${file}`);
      }
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      onLog(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3 text-xs">
      {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}

      {inspectInfo ? (
        <>
          <div className="ui-card overflow-hidden">
            <div className="ui-card-header">
              <span className="ui-title text-blue-600 dark:text-blue-400">{t("parser.imageInfo")}</span>
            </div>
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                <div className="ui-subcard flex items-center justify-between px-3 py-2">
                  <span className="text-slate-500 dark:text-slate-400">Magic</span>
                  <span className="font-mono font-medium text-slate-800 dark:text-slate-100">{inspectInfo.magic}</span>
                </div>
                {inspectInfo.header_version && (
                  <div className="ui-subcard flex items-center justify-between px-3 py-2">
                    <span className="text-slate-500 dark:text-slate-400">Format</span>
                    <span className="font-mono font-medium text-slate-800 dark:text-slate-100">
                      {inspectInfo.header_version}
                    </span>
                  </div>
                )}
                <div className="ui-subcard flex items-center justify-between px-3 py-2">
                  <span className="text-slate-500 dark:text-slate-400">Encrypted</span>
                  <span className="font-mono font-medium text-slate-800 dark:text-slate-100">
                    {inspectInfo.encrypted ? "Yes" : "No"}
                  </span>
                </div>
                <div className="ui-subcard flex items-center justify-between px-3 py-2">
                  <span className="text-slate-500 dark:text-slate-400">File Count</span>
                  <span className="font-mono font-medium tabular-nums text-slate-800 dark:text-slate-100">
                    {inspectInfo.file_count}
                  </span>
                </div>
                <div className="ui-subcard flex items-center justify-between px-3 py-2">
                  <span className="text-slate-500 dark:text-slate-400">Partitions</span>
                  <span className="font-mono font-medium tabular-nums text-slate-800 dark:text-slate-100">
                    {inspectInfo.partitions.length}
                  </span>
                </div>
              </div>
              {inspectInfo.boot0 && (
                <div className="border-t border-slate-200 pt-2.5 font-mono text-slate-600 dark:border-slate-800 dark:text-slate-300">
                  Boot0 Magic: {inspectInfo.boot0.magic} | Platform: {inspectInfo.boot0.platform || "-"}
                </div>
              )}
            </div>
          </div>

          <div className="ui-card overflow-hidden">
            <div className="ui-card-header">
              <span className="ui-title text-blue-600 dark:text-blue-400">{t("parser.filesTitle")}</span>
              <button
                disabled={unpacking || !firmwarePath}
                onClick={unpackAll}
                className="ui-btn-primary"
              >
                {unpacking ? t("parser.unpacking") : t("parser.unpackAll")}
              </button>
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-left">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-50/90 text-[11px] font-semibold text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2">{t("sector.name")}</th>
                    <th className="px-4 py-2">Type</th>
                    <th className="px-4 py-2">Size</th>
                    <th className="px-4 py-2 text-right">{t("sector.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {inspectInfo.files.map((p) => (
                    <tr key={`${p.index}-${p.name}`} className="transition hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-2 font-mono font-medium text-slate-800 dark:text-slate-100">
                        {p.name}
                        {p.sparse && (
                          <span className="ml-1.5 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            sparse
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-slate-500 dark:text-slate-400">{p.type_guid}</td>
                      <td className="px-4 py-2 font-mono tabular-nums">{(p.size_bytes / 1024).toFixed(1)} KB</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => extractItem(p.name)}
                          className="font-medium text-blue-600 transition hover:text-blue-500 hover:underline dark:text-blue-400"
                        >
                          {t("parser.extract")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <SysConfigEditor rawText={inspectInfo.sys_config_raw || ""} onLog={onLog} />
        </>
      ) : (
        <div className="space-y-3">
          <div className="ui-card border-dashed p-6 text-center text-slate-500 dark:text-slate-400">
            请在上方选择 `.img` 固件以查看 Boot0 信息与提取包内文件
          </div>
          <SysConfigEditor rawText="" onLog={onLog} />
        </div>
      )}

      <div className="ui-card overflow-hidden">
        <div className="ui-card-header">
          <span className="ui-title text-blue-600 dark:text-blue-400">设备树反编译预览 (DTB → DTS)</span>
          <button
            disabled={loading}
            onClick={pickDtb}
            className="ui-btn-secondary"
          >
            {t("parser.openDtb")}
          </button>
        </div>
        <pre className="ui-terminal h-56 overflow-auto rounded-none border-0 p-4 text-emerald-400">
          {dtsOutput || t("parser.dtbPlaceholder")}
        </pre>
      </div>
    </div>
  );
}
