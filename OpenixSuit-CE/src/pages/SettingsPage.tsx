import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppSettings, ThemeMode, UsbBackend } from "../store/settings";
import { InstalledPlugin } from "../types/plugin";
import { PluginManagement } from "./PluginManagement";
import { DriverGuide } from "./DriverGuide";
import { DesktopUpdateSettings } from "./DesktopUpdateSettings";

interface SettingsPageProps {
  settings: AppSettings;
  plugins: InstalledPlugin[];
  onUpdate: (patch: Partial<AppSettings>) => void;
  onRefreshPlugins: () => Promise<void>;
  onLog: (msg: string) => void;
  onOpenAiWorkbench?: () => void;
}

const AI_ENDPOINT = "http://127.0.0.1:28765";
const SETTING_ROW = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2";
const SETTING_SELECT = "ui-select ui-select-compact ml-auto w-32 max-w-full";

export function SettingsPage({
  settings,
  plugins,
  onUpdate,
  onRefreshPlugins,
  onLog,
  onOpenAiWorkbench,
}: SettingsPageProps) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-3 pb-3">
      <h1 className="px-0.5 text-sm font-semibold">{t("settings.title")}</h1>

      <div className="ui-card min-w-0 divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <label className={SETTING_ROW}>
          <span className="font-medium">{t("settings.lang")}</span>
          <select
            value={settings.language}
            onChange={(e) => onUpdate({ language: e.target.value as "zh-CN" | "en-US" })}
            className={SETTING_SELECT}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </label>

        <label className={SETTING_ROW}>
          <span className="font-medium">{t("settings.theme")}</span>
          <select
            value={settings.theme}
            onChange={(e) => onUpdate({ theme: e.target.value as ThemeMode })}
            className={SETTING_SELECT}
          >
            <option value="system">{t("settings.system")}</option>
            <option value="dark">{t("settings.dark")}</option>
            <option value="light">{t("settings.light")}</option>
          </select>
        </label>

        <label className={SETTING_ROW}>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium">{t("settings.usb")}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">{t("settings.usbDesc")}</span>
          </span>
          <select
            value={settings.usb_backend}
            onChange={(e) => onUpdate({ usb_backend: e.target.value as UsbBackend })}
            className={SETTING_SELECT}
          >
            <option value="auto">Auto</option>
            <option value="winusb">WinUSB</option>
            <option value="libusb">libusb</option>
          </select>
        </label>

        <DesktopUpdateSettings />
      </div>

      <PluginManagement plugins={plugins} onRefresh={onRefreshPlugins} onLog={onLog} />

      <div className="ui-card min-w-0 divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <DriverGuide />
        <div className={SETTING_ROW}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="flex items-center gap-2 font-medium">
              <Terminal className="size-3.5 shrink-0 text-purple-500" />
              {t("settings.aiTitle")}
            </h2>
            <code className="min-w-0 break-all text-xs text-slate-500 dark:text-slate-400">{AI_ENDPOINT}</code>
          </div>
          {onOpenAiWorkbench && <button type="button" onClick={onOpenAiWorkbench} className="ui-btn-secondary">{t("aiWorkbench.title")}</button>}
        </div>
      </div>
    </div>
  );
}
