import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult } from "./FlashHub";

interface FirmwareFlashProps {
  firmwarePath: string;
  inspectInfo: SharedImageInspectResult | null;
  isFlashing: boolean;
  onFlashingChange: (flashing: boolean) => void;
  onLog: (msg: string) => void;
}

export function FirmwareFlash({
  firmwarePath,
  inspectInfo,
  isFlashing,
  onFlashingChange,
  onLog,
}: FirmwareFlashProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"full_erase" | "keep_data" | "partition_erase" | "partition">(
    () =>
      (localStorage.getItem("flash_mode") as
        | "full_erase"
        | "keep_data"
        | "partition_erase"
        | "partition") || "full_erase"
  );
  const [verify, setVerify] = useState(true);
  const [postAction, setPostAction] = useState<"keep" | "reboot" | "poweroff">("reboot");
  const [progress, setProgress] = useState<{ partition: string; percent: number } | null>(null);
  const [flashLogs, setFlashLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const pushLog = (msg: string) => {
    setFlashLogs((prev) => [...prev.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    onLog(msg);
  };

  useEffect(() => {
    setProgress(null);
    setSelected(inspectInfo ? inspectInfo.partitions.map((p) => p.name) : []);
  }, [inspectInfo]);

  useEffect(() => {
    const unlisten = listen<{ partition: string; percent: number }>("flash-progress", (e) => {
      setProgress({ partition: e.payload.partition, percent: e.payload.percent });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const startFlash = async () => {
    if (!firmwarePath) return;
    if ((mode === "partition" || mode === "partition_erase") && selected.length === 0) return;
    onFlashingChange(true);
    setErrorMsg(null);
    pushLog(`Flash started: ${mode}`);
    try {
      const res = await invoke<string | void>("flash_firmware_full", {
        firmwarePath,
        mode,
        partitions: selected,
        verify,
        postAction,
        bus: null,
        port: null,
      });
      if (typeof res === "string" && res) pushLog(res);
      pushLog("Flash completed");
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      pushLog(msg);
    } finally {
      onFlashingChange(false);
    }
  };

  const cancelFlash = async () => {
    try {
      await invoke("cancel_flash");
    } catch (err) {
      pushLog(String(err));
    }
  };

  return (
    <div className="flex h-full flex-col space-y-3">
      {errorMsg && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {errorMsg}
        </div>
      )}

      <div className="grid flex-1 grid-cols-12 gap-4">
        <div className="col-span-4 space-y-3 rounded border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="text-sm font-semibold text-blue-600 dark:text-blue-400">{t("flash.config")}</div>
          <select
            disabled={isFlashing}
            value={mode}
            onChange={(e) => {
              const next = e.target.value as "full_erase" | "keep_data" | "partition_erase" | "partition";
              setMode(next);
              localStorage.setItem("flash_mode", next);
            }}
            className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="full_erase">{t("flash.fullErase")}</option>
            <option value="keep_data">{t("flash.keepData")}</option>
            <option value="partition_erase">{t("flash.partitionErase")}</option>
            <option value="partition">{t("flash.partitionOnly")}</option>
          </select>

          <div className="max-h-60 space-y-1.5 overflow-y-auto pt-1">
            {(inspectInfo?.partitions || []).map((p) => (
              <label key={p.name} className="flex items-center justify-between rounded bg-white px-2 py-1 dark:bg-slate-950">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={isFlashing}
                    checked={selected.includes(p.name)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, p.name] : prev.filter((x) => x !== p.name)
                      )
                    }
                  />
                  {p.name}
                </span>
                <span className="font-mono text-slate-500">{(p.size_bytes / 1024).toFixed(0)} KB</span>
              </label>
            ))}
          </div>
        </div>

        <div className="col-span-8 flex flex-col space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
              <div className="text-sm font-semibold text-blue-600 dark:text-blue-400">{t("flash.options")}</div>
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
            </div>

            <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">{t("flash.control")}</span>
                <span>{progress ? `${progress.percent.toFixed(1)}%` : "0.0%"}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  disabled={isFlashing || !firmwarePath}
                  onClick={startFlash}
                  className="flex-1 rounded bg-blue-600 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {isFlashing ? t("flash.flashing") : t("flash.start")}
                </button>
                {isFlashing && (
                  <button
                    onClick={cancelFlash}
                    className="rounded bg-red-600 px-3 py-1.5 text-white hover:bg-red-500"
                  >
                    {t("common.cancel")}
                  </button>
                )}
              </div>
            </div>
          </div>

          <pre className="flex-1 overflow-y-auto rounded border border-slate-200 bg-slate-900 p-3 font-mono text-xs text-slate-300 dark:border-slate-800 dark:bg-slate-950">
            {flashLogs.join("\n") || t("flash.logPlaceholder")}
          </pre>
        </div>
      </div>
    </div>
  );
}
