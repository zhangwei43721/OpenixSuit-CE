import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult } from "./FlashHub";

type TargetKind = "spinor" | "sdcard" | "emmc" | "sdnand" | "ufs";

const TARGET_DEFS: { key: TargetKind; titleKey: string; descKey: string; defaultOffset: number }[] = [
  { key: "spinor", titleKey: "converter.spinorTitle", descKey: "converter.spinorDesc", defaultOffset: 2106 },
  { key: "sdcard", titleKey: "converter.sdcardTitle", descKey: "converter.sdcardDesc", defaultOffset: 40960 },
  { key: "emmc", titleKey: "converter.emmcTitle", descKey: "converter.emmcDesc", defaultOffset: 40960 },
  { key: "sdnand", titleKey: "converter.sdnandTitle", descKey: "converter.sdnandDesc", defaultOffset: 40960 },
  { key: "ufs", titleKey: "converter.ufsTitle", descKey: "converter.ufsDesc", defaultOffset: 40960 },
];

export function FirmwareConverter({
  firmwarePath,
  inspectInfo,
  onLog,
}: {
  firmwarePath: string;
  inspectInfo: SharedImageInspectResult | null;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<TargetKind>("sdcard");
  const [logicOffset, setLogicOffset] = useState(40960);
  const [sizeMode, setSizeMode] = useState<"auto" | "manual">("auto");
  const [manualSectors, setManualSectors] = useState(16777216);
  const [progress, setProgress] = useState(0);
  const [converting, setConverting] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const pushLog = (msg: string) => {
    setLogs((p) => [...p.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    onLog(msg);
  };

  useEffect(() => {
    const unlisten = listen<{ percent: number; message: string }>("convert-progress", (e) => {
      setProgress(e.payload.percent);
      pushLog(e.payload.message);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const startConvert = async () => {
    if (!firmwarePath) return;
    try {
      const outputPath = await save({ defaultPath: `firmware_${target}_programmer.bin` });
      if (!outputPath) return;
      setConverting(true);
      setProgress(0);
      await invoke("convert_firmware", {
        firmwarePath,
        target,
        logicOffset,
        manualSectors: sizeMode === "manual" ? manualSectors : null,
        outputPath,
      });
      pushLog(`转换完成 -> ${outputPath}`);
    } catch (err) {
      pushLog(String(err));
    } finally {
      setConverting(false);
    }
  };

  const currentMeta = TARGET_DEFS.find((item) => item.key === target)!;
  const partitions = inspectInfo?.partitions || [];

  return (
    <div className="grid h-full grid-cols-12 gap-4">
      <div className="col-span-3 space-y-1.5 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="px-2 py-1 text-xs font-semibold text-slate-500">{t("converter.tools")}</div>
        {TARGET_DEFS.map((item) => (
          <button
            key={item.key}
            onClick={() => {
              setTarget(item.key);
              setLogicOffset(item.defaultOffset);
            }}
            className={`w-full rounded p-2.5 text-left text-xs ${
              target === item.key
                ? "bg-blue-600/15 text-blue-600 dark:text-blue-400"
                : "hover:bg-slate-200 dark:hover:bg-slate-800"
            }`}
          >
            <div className="font-semibold">{t(item.titleKey)}</div>
            <div className="mt-0.5 text-[11px] opacity-75">{t(item.descKey)}</div>
          </button>
        ))}
      </div>

      <div className="col-span-9 flex flex-col space-y-3 text-xs">
        <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-sm font-semibold">{t(currentMeta.titleKey)}</div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-slate-500">{t("converter.logicOffset")}</div>
              <input
                type="number"
                value={logicOffset}
                onChange={(e) => setLogicOffset(Number(e.target.value))}
                className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <div className="mb-1 text-slate-500">{t("converter.storageSize")}</div>
              <div className="flex items-center gap-3 py-1.5">
                <label className="flex items-center gap-1">
                  <input type="radio" checked={sizeMode === "auto"} onChange={() => setSizeMode("auto")} />
                  {t("converter.auto")}
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" checked={sizeMode === "manual"} onChange={() => setSizeMode("manual")} />
                  {t("converter.manual")}
                </label>
                {sizeMode === "manual" && (
                  <input
                    type="number"
                    value={manualSectors}
                    onChange={(e) => setManualSectors(Number(e.target.value))}
                    className="w-28 rounded border border-slate-300 bg-white px-2 py-0.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                )}
              </div>
            </div>
          </div>

          <div className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
            <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
          </div>

          <button
            disabled={converting || !firmwarePath}
            onClick={startConvert}
            className="w-full rounded bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {converting ? `${t("converter.converting")} (${progress.toFixed(0)}%)...` : t("converter.start")}
          </button>

          {partitions.length > 0 && (
            <div className="max-h-36 overflow-y-auto rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950">
              <div className="mb-1 text-slate-500">
                {t("converter.partList")} ({partitions.length})
              </div>
              {partitions.map((p) => (
                <div key={p.name} className="flex justify-between py-0.5 font-mono">
                  <span>{p.name}</span>
                  <span>{(p.size_bytes / 1024 / 1024).toFixed(2)} MB</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <pre className="h-28 overflow-y-auto rounded border border-slate-200 bg-slate-900 p-2.5 font-mono text-xs text-slate-300 dark:border-slate-800 dark:bg-slate-950">
          {logs.join("\n") || t("converter.logTitle")}
        </pre>
      </div>
    </div>
  );
}
