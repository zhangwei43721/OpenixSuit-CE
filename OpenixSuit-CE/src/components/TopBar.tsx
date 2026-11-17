import { useTranslation } from "react-i18next";
import { RefreshCw, RotateCw, Shield, Zap } from "lucide-react";

export interface FelDevice {
  id: string;
  chip: string;
  mode: string;
}

export interface AdbDevice {
  serial: string;
  state: string;
}

interface TopBarProps {
  felDevices: FelDevice[];
  adbDevices: AdbDevice[];
  selectedAdbSerial: string;
  aiSyncStatus?: string | null;
  onSelectAdbSerial: (serial: string) => void;
  onRefreshDevices: () => void;
  onAdbRoot: () => void;
  onAdbReboot: () => void;
  onSwitchEfex: () => void;
}

export function TopBar({
  felDevices,
  adbDevices,
  selectedAdbSerial,
  aiSyncStatus,
  onSelectAdbSerial,
  onRefreshDevices,
  onAdbRoot,
  onAdbReboot,
  onSwitchEfex,
}: TopBarProps) {
  const { t } = useTranslation();

  const leftBadge =
    felDevices.length > 0
      ? {
          text: `${t("status.connected")} (${felDevices.length})`,
          cls: "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
        }
      : adbDevices.length > 0
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
            value={selectedAdbSerial}
            onChange={(e) => onSelectAdbSerial(e.target.value)}
            className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-xs font-medium text-blue-600 focus:border-blue-500 focus:outline-none dark:text-blue-400"
          >
            {adbDevices.map((d) => (
              <option
                key={d.serial}
                value={d.serial}
                className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              >
                ADB: {d.serial} ({d.state})
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

        {adbDevices.length > 0 && (
          <>
            <button
              onClick={onAdbRoot}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-500/20 dark:text-emerald-400"
            >
              <Shield className="h-3.5 w-3.5" />
              Root
            </button>
            <button
              onClick={onAdbReboot}
              className="ui-btn-secondary"
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("status.reboot")}
            </button>
            <button
              onClick={onSwitchEfex}
              className="ui-btn-primary"
            >
              <Zap className="h-3.5 w-3.5" />
              {t("status.switchEfex")}
            </button>
          </>
        )}
      </div>
    </header>
  );
}
