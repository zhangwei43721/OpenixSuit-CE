import { useTranslation } from "react-i18next";
import { RefreshCw, Shield, Zap } from "lucide-react";

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
  onSelectAdbSerial: (serial: string) => void;
  onRefreshDevices: () => void;
  onAdbRoot: () => void;
  onSwitchEfex: () => void;
}

export function TopBar({
  felDevices,
  adbDevices,
  selectedAdbSerial,
  onSelectAdbSerial,
  onRefreshDevices,
  onAdbRoot,
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
      </div>

      {/* 全局设备控制条：统一管理 ADB 设备选择、刷新、Root、切烧录模式 */}
      <div className="flex shrink-0 items-center gap-2 text-xs">
        {adbDevices.length > 0 ? (
          <select
            value={selectedAdbSerial}
            onChange={(e) => onSelectAdbSerial(e.target.value)}
            className="rounded border border-blue-400/50 bg-blue-500/10 px-2.5 py-1 text-blue-600 dark:text-blue-400"
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
          <span className="rounded bg-slate-100 px-2.5 py-1 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {t("status.noAdb")}
          </span>
        )}

        <button
          onClick={onRefreshDevices}
          className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          title={t("common.refresh")}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("common.refresh")}
        </button>

        {adbDevices.length > 0 && (
          <>
            <button
              onClick={onAdbRoot}
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-2.5 py-1 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400"
            >
              <Shield className="h-3.5 w-3.5" />
              Root
            </button>
            <button
              onClick={onSwitchEfex}
              className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-white hover:bg-blue-500"
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
