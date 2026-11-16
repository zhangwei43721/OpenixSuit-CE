import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult } from "./FlashHub";

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
      {errorMsg && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-600 dark:text-amber-400">
          {errorMsg}
        </div>
      )}

      {inspectInfo ? (
        <>
          {inspectInfo.boot0 && (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-1 font-semibold text-blue-500">{t("parser.boot0Info")}</div>
              <div>
                Magic: {inspectInfo.boot0.magic} | Platform: {inspectInfo.boot0.platform || "-"} | File Count: {inspectInfo.file_count}
              </div>
            </div>
          )}

          <div className="rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-2 font-semibold text-blue-500">{t("parser.filesTitle")}</div>
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-left">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1">{t("sector.name")}</th>
                    <th className="py-1">Size</th>
                    <th className="py-1 text-right">{t("sector.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {inspectInfo.files.map((p) => (
                    <tr key={`${p.index}-${p.name}`}>
                      <td className="py-1 font-mono">{p.name}</td>
                      <td className="py-1 font-mono">{(p.size_bytes / 1024).toFixed(1)} KB</td>
                      <td className="py-1 text-right">
                        <button onClick={() => extractItem(p.name)} className="text-blue-500 hover:underline">
                          {t("parser.extract")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="rounded border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-slate-800">
          请在上方选择 `.img` 固件以查看 Boot0 信息与提取包内文件
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-blue-500">设备树反编译预览 (DTB → DTS)</span>
          <button
            disabled={loading}
            onClick={pickDtb}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-slate-800 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {t("parser.openDtb")}
          </button>
        </div>
        <pre className="h-56 overflow-auto rounded border border-slate-200 bg-slate-900 p-4 font-mono text-xs text-emerald-400 dark:border-slate-800 dark:bg-slate-950">
          {dtsOutput || t("parser.dtbPlaceholder")}
        </pre>
      </div>
    </div>
  );
}
