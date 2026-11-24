import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FlashPlanDialog, type FlashPlan } from "./FlashPlanDialog";
import type { FelDevice } from "../components/TopBar";
import { useTranslation } from "react-i18next";
import { SharedImageInspectResult } from "./FlashHub";
import { SectorFlash } from "./SectorFlash";
import { LogMarkedText } from "../utils/ansi";

interface FirmwareFlashProps {
  active?: boolean;
  firmwarePath: string;
  felDevices: FelDevice[];
  inspectInfo: SharedImageInspectResult | null;
  isFlashing: boolean;
  onFlashingChange: (flashing: boolean) => void;
  onFlashComplete?: (status: "completed" | "error", mode: string, message: string) => void;
  onLog: (msg: string) => void;
}

export function FirmwareFlash(props: FirmwareFlashProps) {
  const { active = true, onFlashComplete, ...flashProps } = props;
  const { isFlashing } = flashProps;
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="ui-toolbar">
        <div className="ui-segmented">
          <button
            type="button"
            aria-pressed={!advanced}
            disabled={isFlashing}
            onClick={() => setAdvanced(false)}
            className={`ui-segmented-btn disabled:opacity-50 ${!advanced ? "bg-blue-600 text-white" : ""}`}
          >
            {t("flash.config")}
          </button>
          <button
            type="button"
            aria-pressed={advanced}
            disabled={isFlashing}
            onClick={() => setAdvanced(true)}
            className={`ui-segmented-btn disabled:opacity-50 ${advanced ? "bg-blue-600 text-white" : ""}`}
          >
            {t("flash.advancedLayout")}
          </button>
        </div>
      </div>
      <div className={advanced ? "hidden" : "min-h-0 flex-1"}>
        <StandardFlash
          {...flashProps}
          active={active && !advanced}
          onFlashComplete={onFlashComplete}
        />
      </div>
      <div className={advanced ? "min-h-0 flex-1" : "hidden"}>
        <SectorFlash {...flashProps} active={active && advanced} />
      </div>
    </div>
  );
}

type FlashMode = "full_erase" | "keep_data" | "partition_erase" | "partition";

interface FlashOptions {
  firmware_path: string;
  mode: FlashMode;
  partitions: string[];
  verify: boolean;
  post_action: "reboot" | "poweroff";
  bus: number | null;
  port: number | null;
  boot_check: {
    adbTarget: string;
    expectedSlot: string | null;
    programCheck: { executablePath: string; expectedSha256: string } | null;
  } | null;
}

interface BootCheck {
  status: "passed" | "failed" | "timed_out" | "skipped";
  expected?: string;
  observed?: string;
  message?: string;
}

interface FlashResult {
  flash: { status: "completed" | "failed"; error?: string };
  boot: {
    status: BootCheck["status"];
    adbReconnect: BootCheck;
    bootSlot: BootCheck;
    program: BootCheck;
  };
}

function StandardFlash({
  active = true,
  firmwarePath,
  felDevices,
  inspectInfo,
  isFlashing,
  onFlashingChange,
  onFlashComplete,
  onLog,
}: FirmwareFlashProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<FlashMode | "">(() => {
    const saved = localStorage.getItem("flash_mode");
    return saved === "keep_data" || saved === "partition_erase" || saved === "partition" ? saved : "";
  });
  const partitionOnly = mode === "partition";
  const [felTarget, setFelTarget] = useState("");
  const deviceId = felDevices.length === 1 ? felDevices[0].id : felTarget;
  const devicePair = /^bus:(\d+)-port:(\d+)$/.exec(deviceId);
  const targetSelected = felDevices.length <= 1 || felDevices.some((device) => device.id === deviceId);
  const canStart = !isFlashing && firmwarePath && mode && targetSelected && (!partitionOnly || selected.length > 0);
  const [verify, setVerify] = useState(true);
  const [postAction, setPostAction] = useState<"reboot" | "poweroff">("reboot");
  const [adbTarget, setAdbTarget] = useState("");
  const [expectedSlot, setExpectedSlot] = useState("");
  const [executablePath, setExecutablePath] = useState("");
  const [expectedSha256, setExpectedSha256] = useState("");
  const [result, setResult] = useState<FlashResult | null>(null);
  const [writing, setWriting] = useState(false);
  const [verifyingBoot, setVerifyingBoot] = useState(false);
  const [pending, setPending] = useState<{ plan: FlashPlan; options: FlashOptions; deviceId: string } | null>(null);
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
    setSelected([]);
    setResult(null);
  }, [inspectInfo]);

  useEffect(() => {
    const unlistenProgress = listen<{
      partition: string;
      written: number;
      total: number;
      percent: number;
    }>("flash-progress", (e) => {
      if (!active) return;
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
    const unlistenResult = listen<FlashResult>("standard-flash-result", (e) => {
      setResult(e.payload);
      setVerifyingBoot(false);
    });
    const unlistenVerifying = listen("standard-flash-verifying", () => setVerifyingBoot(true));
    return () => {
      unlistenVerifying.then((fn) => fn());
      unlistenResult.then((fn) => fn());
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
    if (!canStart) return;
    onFlashingChange(true);
    setErrorMsg(null);
    setResult(null);
    const options: FlashOptions = {
      firmware_path: firmwarePath,
      mode,
      partitions: partitionOnly ? selected : [],
      verify,
      post_action: postAction,
      bus: devicePair ? Number(devicePair[1]) : null,
      port: devicePair ? Number(devicePair[2]) : null,
      boot_check: postAction === "reboot" && adbTarget.trim() ? {
        adbTarget: adbTarget.trim(),
        expectedSlot: expectedSlot || null,
        programCheck: executablePath.trim() || expectedSha256.trim() ? {
          executablePath: executablePath.trim(),
          expectedSha256: expectedSha256.trim(),
        } : null,
      } : null,
    };
    try {
      const plan = await invoke<FlashPlan>("flash_firmware_plan", { options });
      setPending({ plan, options, deviceId });
    } catch (err) {
      setErrorMsg(String(err));
      onFlashingChange(false);
    }
  };

  const confirmFlash = async () => {
    if (!pending) return;
    const { plan, options } = pending;
    setPending(null);
    setWriting(true);
    pushLog(`Flash started: ${options.mode}`);
    try {
      const report = await invoke<FlashResult>("flash_firmware_full", {
        options: { ...options, confirm_plan: plan.id },
      });
      setResult(report);
      const completed = report.flash.status === "completed";
      const bootOk = report.boot.status === "passed" || report.boot.status === "skipped";
      const msg = report.flash.error || `${t(`flash.result.flash_${report.flash.status}`)} · ${t("flash.result.boot")} ${t(`flash.result.${report.boot.status}`)}`;
      pushLog(msg);
      onFlashComplete?.(completed && bootOk ? "completed" : "error", options.mode, msg);
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      pushLog(msg);
    } finally {
      setWriting(false);
      setVerifyingBoot(false);
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
      {pending && (
        <FlashPlanDialog
          plan={pending.plan}
          deviceId={pending.deviceId}
          onCancel={() => { setPending(null); onFlashingChange(false); }}
          onConfirm={confirmFlash}
        />
      )}
      {result && (
        <section className="ui-card px-4 py-2.5 text-xs" aria-live="polite">
          <div className="font-semibold">{t(`flash.result.flash_${result.flash.status}`)}</div>
          {result.flash.error && <p className="break-words text-red-600 dark:text-red-300">{result.flash.error}</p>}
          {([
            ["adb", result.boot.adbReconnect],
            ["slot", result.boot.bootSlot],
            ["program", result.boot.program],
          ] as const).map(([name, check]) => (
            <div key={name} className="mt-1 break-all">
              <span className="font-medium">{t(`flash.result.${name}`)}</span>{" · "}
              {t(`flash.result.${check.status}`)}
              {check.observed && ` · ${check.observed}`}
              {check.expected && check.expected !== check.observed && ` · ${t("flash.result.expected", { value: check.expected })}`}
              {check.message && ` · ${check.message}`}
            </div>
          ))}
        </section>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="ui-card flex flex-col overflow-hidden text-xs">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("flash.options")}</span>
          </div>
          <div className="flex flex-1 flex-col justify-center gap-3 p-4">
            <div className="space-y-1.5">
              <select
                aria-label={t("flash.config")}
                aria-describedby="flash-mode-description"
                disabled={isFlashing}
                value={mode}
                onChange={(e) => {
                  const next = e.target.value as FlashMode;
                  setMode(next);
                  localStorage.setItem("flash_mode", next);
                }}
                className="ui-select w-full"
              >
                <option value="" disabled>{t("flash.selectMode")}</option>
                <option value="full_erase">{t("flash.fullErase")}</option>
                <option value="keep_data">{t("flash.keepData")}</option>
                <option value="partition_erase">{t("flash.partitionErase")}</option>
                <option value="partition">{t("flash.partitionOnly")}</option>
              </select>
              <p id="flash-mode-description" className="leading-relaxed text-slate-600 dark:text-slate-300">
                {mode && t(`flash.modeDescription.${mode}`)}
              </p>
            </div>
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
                onChange={(e) => setPostAction(e.target.value as "reboot" | "poweroff")}
                className="ui-select"
              >
                <option value="reboot">{t("flash.reboot")}</option>
                <option value="poweroff">{t("flash.poweroff")}</option>
              </select>
            </div>
            {felDevices.length > 1 && (
              <label className="space-y-1">
                <span>{t("flash.felTarget")}</span>
                <select className="ui-select w-full" value={felTarget} disabled={isFlashing} onChange={(e) => setFelTarget(e.target.value)}>
                  <option value="">{t("flash.selectDevice")}</option>
                  {felDevices.map((device) => <option key={device.id} value={device.id}>{device.id} · {device.chip}</option>)}
                </select>
              </label>
            )}
            {postAction === "reboot" && (
              <details className="space-y-2">
                <summary className="cursor-pointer font-medium">{t("flash.result.boot")}</summary>
                <label className="block space-y-1">
                  <span>{t("flash.adbTarget")}</span>
                  <input className="ui-input w-full" disabled={isFlashing} value={adbTarget} onChange={(e) => setAdbTarget(e.target.value)} placeholder="adb-usb:usb:1-3#20080411" />
                </label>
                {adbTarget.trim() && (
                  <div className="space-y-2">
                    <label className="flex items-center justify-between gap-2">
                      <span>{t("flash.expectedSlot")}</span>
                      <select className="ui-select" disabled={isFlashing} value={expectedSlot} onChange={(e) => setExpectedSlot(e.target.value)}>
                        <option value="">{t("flash.observeSlot")}</option>
                        <option value="a">A</option>
                        <option value="b">B</option>
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span>{t("flash.executablePath")}</span>
                      <input className="ui-input w-full" disabled={isFlashing} value={executablePath} onChange={(e) => setExecutablePath(e.target.value)} placeholder="/usr/bin/app" />
                    </label>
                    <label className="block space-y-1">
                      <span>{t("flash.expectedSha256")}</span>
                      <input className="ui-input w-full" disabled={isFlashing} value={expectedSha256} onChange={(e) => setExpectedSha256(e.target.value)} />
                    </label>
                  </div>
                )}
              </details>
            )}
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
                disabled={!canStart}
                onClick={startFlash}
                className="ui-btn-primary flex-1 py-2"
              >
                {verifyingBoot ? t("flash.verifyingBoot") : isFlashing ? t("flash.flashing") : t("flash.previewPlan")}
              </button>
              {writing && !verifyingBoot && (
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

      <div className="flex min-h-[220px] flex-1 gap-3">
        {partitionOnly && (
          <div className="ui-card flex w-1/3 shrink-0 flex-col overflow-hidden text-xs">
            <div className="ui-card-header">
              <span className="ui-title">{t("flash.partitions")}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
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
        )}
        <div className="ui-card flex min-w-0 flex-1 flex-col overflow-hidden">
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
            {flashLogs.length > 0 ? <LogMarkedText text={flashLogs.join("\n")} /> : t("flash.logPlaceholder")}
          </pre>
        </div>
      </div>
    </div>
  );
}
