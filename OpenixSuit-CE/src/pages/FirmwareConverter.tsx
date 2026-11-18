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
  const [norSize, setNorSize] = useState(16);
  const [ubootStart, setUbootStart] = useState("");
  const [storageSize, setStorageSize] = useState("auto");
  const [secureMode, setSecureMode] = useState<"auto" | "enabled" | "disabled">("auto");
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
      const parsedUbootStart =
        target === "spinor" && ubootStart.trim() !== "" && Number.isFinite(Number(ubootStart))
          ? Number(ubootStart)
          : null;
      const res = await invoke<string | void>("convert_firmware", {
        firmwarePath,
        target,
        logicOffset,
        ubootStart: parsedUbootStart,
        norSize,
        storageSize: storageSize.trim() || "auto",
        secure: secureMode,
        outputPath,
      });
      if (typeof res === "string" && res) pushLog(res);
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
    <div className="grid h-full min-h-0 grid-cols-12 gap-3">
      <div className="ui-card col-span-3 flex flex-col overflow-hidden">
        <div className="ui-card-header">
          <span className="ui-title">{t("converter.tools")}</span>
        </div>
        <div className="space-y-1.5 p-3">
          {TARGET_DEFS.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setTarget(item.key);
                setLogicOffset(item.defaultOffset);
              }}
              className={`w-full rounded-lg border p-2.5 text-left text-xs transition ${
                target === item.key
                  ? "border-blue-500/30 bg-blue-600/10 text-blue-600 dark:border-blue-500/40 dark:bg-blue-600/15 dark:text-blue-400"
                  : "border-transparent text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              <div className="font-semibold">{t(item.titleKey)}</div>
              <div className="mt-0.5 text-[11px] opacity-75">{t(item.descKey)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="col-span-9 flex min-h-0 flex-col gap-3 text-xs">
        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t(currentMeta.titleKey)}</span>
            <span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
              {progress.toFixed(0)}%
            </span>
          </div>

          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {t("converter.logicOffset")}
                </span>
                <input
                  type="number"
                  value={logicOffset}
                  onChange={(e) => setLogicOffset(Number(e.target.value))}
                  className="ui-input w-full font-mono tabular-nums"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {t("converter.storageSize")}
                </span>
                <input
                  type="text"
                  list="converter-storage-presets"
                  value={storageSize}
                  onChange={(e) => setStorageSize(e.target.value)}
                  placeholder="auto / 8GB / 512MB"
                  className="ui-input w-full font-mono"
                />
                <datalist id="converter-storage-presets">
                  <option value="auto" />
                  <option value="512MB" />
                  <option value="1GB" />
                  <option value="4GB" />
                  <option value="8GB" />
                  <option value="16GB" />
                </datalist>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {t("converter.secureMode")}
                </span>
                <select
                  value={secureMode}
                  onChange={(e) => setSecureMode(e.target.value as "auto" | "enabled" | "disabled")}
                  className="ui-select w-full"
                >
                  <option value="auto">{t("converter.secureAuto")}</option>
                  <option value="enabled">{t("converter.secureEnabled")}</option>
                  <option value="disabled">{t("converter.secureDisabled")}</option>
                </select>
              </div>
              {target === "spinor" && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {t("converter.norSize")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={norSize}
                      onChange={(e) => setNorSize(Number(e.target.value))}
                      className="ui-input w-full font-mono tabular-nums"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {t("converter.ubootStart")}
                    </span>
                    <input
                      type="number"
                      value={ubootStart}
                      onChange={(e) => setUbootStart(e.target.value)}
                      placeholder={t("converter.ubootStartPlaceholder")}
                      className="ui-input w-full font-mono tabular-nums"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
              </div>

              <button
                disabled={converting || !firmwarePath}
                onClick={startConvert}
                className="ui-btn-primary w-full py-2"
              >
                {converting ? `${t("converter.converting")} (${progress.toFixed(0)}%)...` : t("converter.start")}
              </button>
            </div>

            {partitions.length > 0 && (
              <div className="ui-subcard max-h-36 overflow-y-auto p-3">
                <div className="mb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {t("converter.partList")} ({partitions.length})
                </div>
                {partitions.map((p) => (
                  <div key={p.name} className="flex justify-between py-0.5 font-mono tabular-nums">
                    <span className="text-slate-700 dark:text-slate-200">{p.name}</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      {(p.size_bytes / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="ui-card flex min-h-[140px] flex-1 flex-col overflow-hidden">
          <div className="ui-card-header py-2">
            <span className="ui-title">
              {t("converter.logTitle")} ({logs.length})
            </span>
          </div>
          <pre className="ui-terminal min-h-0 flex-1 overflow-y-auto rounded-none border-0 p-3 text-slate-300">
            {logs.join("\n") || t("converter.logTitle")}
          </pre>
        </div>
      </div>
    </div>
  );
}
