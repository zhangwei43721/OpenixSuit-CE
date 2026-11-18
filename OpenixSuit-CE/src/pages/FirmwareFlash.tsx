import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult } from "./FlashHub";

interface FirmwareFlashProps {
  active?: boolean;
  firmwarePath: string;
  inspectInfo: SharedImageInspectResult | null;
  isFlashing: boolean;
  onFlashingChange: (flashing: boolean) => void;
  onFlashComplete?: (status: "completed" | "error", mode: string, message: string) => void;
  onLog: (msg: string) => void;
}

export function FirmwareFlash({
  active = true,
  firmwarePath,
  inspectInfo,
  isFlashing,
  onFlashingChange,
  onFlashComplete,
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
  const [progress, setProgress] = useState<{
    partition: string;
    written: number;
    total: number;
    percent: number;
  } | null>(null);
  const [flashLogs, setFlashLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  const appendFlashLine = (msg: string) => {
    setFlashLogs((prev) => [...prev.slice(-499), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const pushLog = (msg: string) => {
    appendFlashLine(msg);
    onLog(msg);
  };

  useEffect(() => {
    setProgress(null);
    setSelected(inspectInfo ? inspectInfo.partitions.map((p) => p.name) : []);
  }, [inspectInfo]);

  useEffect(() => {
    const unlistenProgress = listen<{
      partition: string;
      written: number;
      total: number;
      percent: number;
    }>("flash-progress", (e) => {
      setProgress({
        partition: e.payload.partition,
        written: e.payload.written ?? 0,
        total: e.payload.total ?? 0,
        percent: e.payload.percent,
      });
    });
    const unlistenLog = listen<{ stage: string; level: string; message: string }>(
      "flash-log",
      (e) => {
        if (!active || !e.payload?.message) return;
        const warnTag = e.payload.level === "warn" ? "[WARN] " : "";
        appendFlashLine(`[${e.payload.stage || "FLASH"}] ${warnTag}${e.payload.message}`);
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
  }, [flashLogs]);

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
      onFlashComplete?.("completed", mode, "Flash completed");
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      pushLog(msg);
      onFlashComplete?.("error", mode, msg);
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
    <div className="flex h-full flex-col gap-3">
      {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
        <div className="ui-card col-span-4 flex min-h-0 flex-col overflow-hidden text-xs">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("flash.config")}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <select
              disabled={isFlashing}
              value={mode}
              onChange={(e) => {
                const next = e.target.value as "full_erase" | "keep_data" | "partition_erase" | "partition";
                setMode(next);
                localStorage.setItem("flash_mode", next);
              }}
              className="ui-select w-full"
            >
              <option value="full_erase">{t("flash.fullErase")}</option>
              <option value="keep_data">{t("flash.keepData")}</option>
              <option value="partition_erase">{t("flash.partitionErase")}</option>
              <option value="partition">{t("flash.partitionOnly")}</option>
            </select>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {(inspectInfo?.partitions || []).length === 0 ? (
                <div className="flex h-full min-h-[120px] items-center justify-center rounded-lg border border-dashed border-slate-200 p-4 text-center text-[11px] text-slate-400 dark:border-slate-800">
                  {t("flash.unselected")}
                </div>
              ) : (
                (inspectInfo?.partitions || []).map((p) => (
                  <label
                    key={p.name}
                    className="ui-subcard flex cursor-pointer items-center justify-between px-3 py-2 transition hover:border-blue-500/40"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={isFlashing}
                        checked={selected.includes(p.name)}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked ? [...prev, p.name] : prev.filter((x) => x !== p.name)
                          )
                        }
                        className="accent-blue-600"
                      />
                      <span className="truncate font-medium text-slate-800 dark:text-slate-200">{p.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                      {(p.size_bytes / 1024).toFixed(0)} KB
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="col-span-8 flex min-h-0 flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="ui-card flex flex-col overflow-hidden text-xs">
              <div className="ui-card-header">
                <span className="ui-title text-blue-600 dark:text-blue-400">{t("flash.options")}</span>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-3 p-4">
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
              </div>
            </div>

            <div className="ui-card flex flex-col overflow-hidden text-xs">
              <div className="ui-card-header">
                <span className="ui-title truncate text-blue-600 dark:text-blue-400">
                  {progress?.partition || t("flash.control")}
                </span>
                <span className="shrink-0 font-mono text-[11px] font-medium tabular-nums text-slate-600 dark:text-slate-300">
                  {progress
                    ? `${progress.percent.toFixed(1)}%${
                        progress.total > 100
                          ? ` (${(progress.written / 1024 / 1024).toFixed(1)}/${(
                              progress.total /
                              1024 /
                              1024
                            ).toFixed(1)} MB)`
                          : ""
                      }`
                    : "0.0%"}
                </span>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-3 p-4">
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all"
                    style={{ width: `${progress?.percent ?? 0}%` }}
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    disabled={isFlashing || !firmwarePath}
                    onClick={startFlash}
                    className="ui-btn-primary flex-1 py-2"
                  >
                    {isFlashing ? t("flash.flashing") : t("flash.start")}
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
          </div>

          <div className="ui-card flex min-h-[220px] flex-1 flex-col overflow-hidden">
            <div className="ui-card-header py-2">
              <span className="ui-title">
                {t("log.live")} ({flashLogs.length})
              </span>
              {flashLogs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFlashLogs([])}
                  className="text-[11px] font-medium text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  {t("log.clear")}
                </button>
              )}
            </div>
            <pre
              ref={logBoxRef}
              className="ui-terminal min-h-0 flex-1 overflow-y-auto rounded-none border-0 p-3.5 text-slate-300"
            >
              {flashLogs.join("\n") || t("flash.logPlaceholder")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
