import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Power, RefreshCw, RotateCw, Shield, Zap } from "lucide-react";

export interface FelDevice {
  id: string;
  chip: string;
  mode: string;
}

export interface AdbDevice {
  serial: string;
  target?: string;
  usb_path?: string | null;
  state: string;
}

export function adbDeviceKey(device: AdbDevice): string {
  return device.target || device.serial;
}

export function resolveAdbDevice(value: string, devices: readonly AdbDevice[]): AdbDevice | undefined {
  const exact = devices.filter((device) => adbDeviceKey(device) === value);
  if (exact.length === 1) return exact[0];
  const legacy = devices.filter((device) => device.serial === value);
  return legacy.length === 1 ? legacy[0] : undefined;
}

export function adbDeviceOnline(device?: AdbDevice): boolean {
  return device?.state === "Device" || device?.state === "Recovery";
}

export function adbSerialAmbiguous(value: string, devices: readonly AdbDevice[]): boolean {
  return !!value && devices.filter((device) => device.serial === value).length > 1;
}

interface TopBarProps {
  felDevices: FelDevice[];
  adbDevices: AdbDevice[];
  selectedAdbTarget: string;
  unavailableAdbTarget: boolean;
  aiSyncStatus?: string | null;
  switchingEfex?: boolean;
  deviceActionBusy?: boolean;
  onSelectAdbSerial: (serial: string) => void;
  onRefreshDevices: () => void;
  onAdbRoot: () => void;
  onAdbReboot: () => void;
  onSwitchEfex: () => void;
  onExitFes: (deviceId: string, action: "reboot" | "fel") => Promise<void>;
}

export function TopBar({
  felDevices,
  adbDevices,
  selectedAdbTarget,
  unavailableAdbTarget,
  aiSyncStatus,
  switchingEfex = false,
  deviceActionBusy = false,
  onSelectAdbSerial,
  onRefreshDevices,
  onAdbRoot,
  onAdbReboot,
  onSwitchEfex,
  onExitFes,
}: TopBarProps) {
  const { t } = useTranslation();
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitDeviceId, setExitDeviceId] = useState("");
  const [exitAction, setExitAction] = useState<"reboot" | "fel">("reboot");
  const [exitSubmitting, setExitSubmitting] = useState(false);
  const [exitResult, setExitResult] = useState<"success" | string | null>(null);
  const fesDevices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of felDevices) counts.set(device.id, (counts.get(device.id) || 0) + 1);
    return felDevices.filter((device) => device.mode === "FES (U-Boot)" && counts.get(device.id) === 1);
  }, [felDevices]);
  const actionsBlocked = deviceActionBusy || switchingEfex || exitSubmitting;
  const exitTargetAvailable = fesDevices.some((device) => device.id === exitDeviceId);
  const exitAcknowledged = exitResult === "success";
  const adbReady = adbDeviceOnline(resolveAdbDevice(selectedAdbTarget, adbDevices));

  const openExitDialog = () => {
    setExitDeviceId(fesDevices.length === 1 ? fesDevices[0].id : "");
    setExitAction("reboot");
    setExitResult(null);
    setExitDialogOpen(true);
  };

  const submitExit = async () => {
    if (actionsBlocked || exitAcknowledged || !exitTargetAvailable) return;
    setExitSubmitting(true);
    setExitResult(null);
    try {
      await onExitFes(exitDeviceId, exitAction);
      setExitResult("success");
    } catch (error) {
      setExitResult(String(error));
    } finally {
      setExitSubmitting(false);
    }
  };

  const leftBadge =
    felDevices.length > 0
      ? {
          text: `${t("status.connected")} (${felDevices.length})`,
          cls: "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
        }
      : adbDevices.some(adbDeviceOnline)
      ? {
          text: t("status.adbOnline"),
          cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
        }
      : {
          text: t("status.disconnected"),
          cls: "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
        };

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 font-semibold tracking-tight">{t("appTitle")}</span>
        <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${leftBadge.cls}`}>
          {leftBadge.text}
        </span>
        {aiSyncStatus && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-purple-500/40 bg-purple-500/15 px-2.5 py-0.5 text-xs font-medium text-purple-600 dark:text-purple-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-purple-500" />
            </span>
            {t("status.aiSyncing", { action: aiSyncStatus })}
          </span>
        )}
      </div>

      {/* 全局设备控制条：统一管理 ADB 设备选择、刷新、Root、切烧录模式 */}
      <div className="flex shrink-0 items-center gap-2 text-xs">
        {adbDevices.length > 0 ? (
          <select
            value={selectedAdbTarget}
            onChange={(e) => onSelectAdbSerial(e.target.value)}
            className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-xs font-medium text-blue-600 focus:border-blue-500 focus:outline-none dark:text-blue-400"
          >
            <option value="" disabled>
              {t(unavailableAdbTarget ? "status.adbTargetUnavailable" : "multiLog.pickAdb")}
            </option>
            {adbDevices.map((d) => (
              <option
                key={adbDeviceKey(d)}
                value={adbDeviceKey(d)}
                className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              >
                ADB: {d.serial}{d.usb_path ? ` · ${d.usb_path}` : ""} ({d.state})
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-slate-500 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-400">
            {t("status.noAdb")}
          </span>
        )}

        <button
          onClick={onRefreshDevices}
          className="ui-btn-secondary"
          title={t("common.refresh")}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("common.refresh")}
        </button>

        {fesDevices.length > 0 && (
          <button
            onClick={openExitDialog}
            disabled={actionsBlocked}
            className="ui-btn-secondary"
          >
            <Power className="h-3.5 w-3.5" />
            {t("fesExit.title")}
          </button>
        )}

        {adbDevices.length > 0 && (
          <>
            <button
              onClick={onAdbRoot}
              disabled={!adbReady}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-500/20 dark:text-emerald-400"
            >
              <Shield className="h-3.5 w-3.5" />
              Root
            </button>
            <button
              onClick={onAdbReboot}
              disabled={!adbReady}
              className="ui-btn-secondary"
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("status.reboot")}
            </button>
          </>
        )}

        {(adbDevices.length > 0 || switchingEfex) && (
          <button
            onClick={onSwitchEfex}
            disabled={switchingEfex || !adbReady}
            className="ui-btn-primary"
          >
            {switchingEfex ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            {switchingEfex ? t("status.switchingEfex") : t("status.switchEfex")}
          </button>
        )}
      </div>

      {exitDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="fes-exit-title"
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <h2 id="fes-exit-title" className="text-base font-semibold">{t("fesExit.title")}</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("fesExit.description")}</p>

            <label className="mt-4 block text-xs font-medium text-slate-600 dark:text-slate-300">
              {t("fesExit.device")}
              <select
                value={exitTargetAvailable ? exitDeviceId : ""}
                onChange={(event) => { setExitDeviceId(event.target.value); setExitResult(null); }}
                disabled={exitSubmitting || exitAcknowledged}
                className="ui-select mt-1 w-full"
              >
                <option value="" disabled>{t("fesExit.selectDevice")}</option>
                {fesDevices.map((device) => (
                  <option key={device.id} value={device.id}>{device.chip} · {device.id}</option>
                ))}
              </select>
            </label>

            <fieldset className="mt-4 space-y-2" disabled={exitSubmitting || exitAcknowledged}>
              <legend className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("fesExit.action")}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="fes-exit-action" checked={exitAction === "reboot"} onChange={() => setExitAction("reboot")} className="mt-1" />
                <span>{t("fesExit.reboot")}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="radio" name="fes-exit-action" checked={exitAction === "fel"} onChange={() => setExitAction("fel")} className="mt-1" />
                <span>{t("fesExit.fel")}</span>
              </label>
            </fieldset>

            {exitResult ? (
              <p role="status" className={`mt-4 rounded-lg px-3 py-2 text-sm ${exitResult === "success" ? "ui-alert-ok" : "ui-alert-err"}`}>
                {exitResult === "success" ? t(exitAction === "reboot" ? "fesExit.rebootSent" : "fesExit.felSent") : t("fesExit.failed", { error: exitResult })}
              </p>
            ) : exitDeviceId && !exitTargetAvailable && (
              <p role="status" className="ui-alert-err mt-4 rounded-lg px-3 py-2 text-sm">{t("fesExit.deviceUnavailable")}</p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button className="ui-btn-secondary" onClick={() => setExitDialogOpen(false)} disabled={exitSubmitting}>
                {t(exitAcknowledged ? "fesExit.close" : "common.cancel")}
              </button>
              {!exitAcknowledged && (
                <button className="ui-btn-primary" onClick={submitExit} disabled={actionsBlocked || !exitTargetAvailable}>
                  {exitSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("fesExit.confirm")}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </header>
  );
}
