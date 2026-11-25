import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Puzzle, RefreshCw, Terminal, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppSettings, ThemeMode, UsbBackend } from "../store/settings";
import { PluginManifest } from "../types/plugin";
import { ExtensionIcon } from "../components/ExtensionIcon";
import { DriverGuide } from "./DriverGuide";
import { LogColorSettings } from "./LogColorSettings";
import { DesktopUpdateSettings } from "./DesktopUpdateSettings";

interface SettingsPageProps {
  settings: AppSettings;
  plugins: PluginManifest[];
  onUpdate: (patch: Partial<AppSettings>) => void;
  onRefreshPlugins: () => Promise<void>;
  onLog: (msg: string) => void;
  onOpenAiWorkbench?: () => void;
}

const AI_ENDPOINT = "http://127.0.0.1:28765";

export function SettingsPage({
  settings,
  plugins,
  onUpdate,
  onRefreshPlugins,
  onLog,
  onOpenAiWorkbench,
}: SettingsPageProps) {
  const { t } = useTranslation();
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);

  const installPluginPath = async (selectedPath: string) => {
    setPluginBusy(true);
    setPluginError(null);
    try {
      await invoke("install_plugin", { packagePath: selectedPath });
      onLog(`${t("plugins.installSuccess")}: ${selectedPath}`);
      await onRefreshPlugins();
    } catch (err) {
      const msg = String(err);
      setPluginError(msg);
      onLog(msg);
    } finally {
      setPluginBusy(false);
    }
  };

  const handleImportPlugin = async () => {
    try {
      const file = await open({
        filters: [{ name: "OpenixSuit Plugin", extensions: ["oixplugin", "zip"] }],
      });
      if (typeof file === "string") {
        await installPluginPath(file);
      }
    } catch (err) {
      const msg = String(err);
      setPluginError(msg);
      onLog(msg);
    }
  };

  const handleImportPluginDir = async () => {
    try {
      const dir = await open({ directory: true });
      if (typeof dir === "string") {
        await installPluginPath(dir);
      }
    } catch (err) {
      const msg = String(err);
      setPluginError(msg);
      onLog(msg);
    }
  };

  const handleUninstallPlugin = async (pluginId: string) => {
    try {
      setPluginBusy(true);
      setPluginError(null);
      await invoke("uninstall_plugin", { pluginId });
      onLog(`${t("plugins.uninstallSuccess")}: ${pluginId}`);
      await onRefreshPlugins();
    } catch (err) {
      const msg = String(err);
      setPluginError(msg);
      onLog(msg);
    } finally {
      setPluginBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="ui-toolbar">
        <span className="ui-title text-sm">{t("settings.title")}</span>
      </div>

      <div className="ui-card divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="space-y-0.5">
            <div className="font-medium text-slate-900 dark:text-slate-100">{t("settings.lang")}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t("settings.langDesc")}</div>
          </div>
          <select
            value={settings.language}
            onChange={(e) => onUpdate({ language: e.target.value as "zh-CN" | "en-US" })}
            className="ui-select min-w-28 shrink-0"
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-4 p-4">
          <div className="space-y-0.5">
            <div className="font-medium text-slate-900 dark:text-slate-100">{t("settings.theme")}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t("settings.themeDesc")}</div>
          </div>
          <select
            value={settings.theme}
            onChange={(e) => onUpdate({ theme: e.target.value as ThemeMode })}
            className="ui-select min-w-28 shrink-0"
          >
            <option value="system">{t("settings.system")}</option>
            <option value="dark">{t("settings.dark")}</option>
            <option value="light">{t("settings.light")}</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-4 p-4">
          <div className="space-y-0.5">
            <div className="font-medium text-slate-900 dark:text-slate-100">{t("settings.usb")}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t("settings.usbDesc")}</div>
          </div>
          <select
            value={settings.usb_backend}
            onChange={(e) => onUpdate({ usb_backend: e.target.value as UsbBackend })}
            className="ui-select min-w-28 shrink-0"
          >
            <option value="auto">Auto</option>
            <option value="winusb">WinUSB</option>
            <option value="libusb">libusb</option>
          </select>
        </div>

        <DesktopUpdateSettings />
      </div>

      <LogColorSettings />

      {/* 项目拓展插件管理 */}

      <div className="ui-card overflow-hidden text-sm">
        <div className="ui-card-header">
          <div className="space-y-0.5">
            <div className="ui-title text-sm">
              <Puzzle className="h-4 w-4 text-blue-500" />
              <span>{t("plugins.settingsTitle")}</span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t("plugins.settingsDesc")}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pluginBusy}
              onClick={() => onRefreshPlugins()}
              className="ui-btn-secondary"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${pluginBusy ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </button>
            <button
              type="button"
              disabled={pluginBusy}
              onClick={handleImportPluginDir}
              className="ui-btn-secondary"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("plugins.importDir")}
            </button>
            <button
              type="button"
              disabled={pluginBusy}
              onClick={handleImportPlugin}
              className="ui-btn-primary"
            >
              <Upload className="h-3.5 w-3.5" />
              {t("plugins.import")}
            </button>
          </div>
        </div>

        <div className="space-y-3 p-4">
          {pluginError && <div className="ui-alert-warn">{pluginError}</div>}

          <div className="space-y-2">
            {plugins.length === 0 ? (
              <div className="ui-subcard border-dashed p-6 text-center text-xs text-slate-400">
                {t("plugins.noPlugins")}
              </div>
            ) : (
              plugins.map((plugin) => {
                const tabCount =
                  Array.isArray(plugin.tabs) && plugin.tabs.length > 0 ? plugin.tabs.length : 1;
                return (
                  <div
                    key={plugin.id}
                    className="ui-subcard flex items-start justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <ExtensionIcon icon={plugin.icon} className="h-4 w-4 shrink-0 text-blue-500" />
                        <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {plugin.name}
                        </span>
                        <span className="rounded-md bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                          v{plugin.version}
                        </span>
                        <span className="rounded-md bg-blue-600/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                          {t("plugins.tabCount", { count: tabCount })}
                        </span>
                      </div>
                      {plugin.description && (
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          {plugin.description}
                        </div>
                      )}
                      <div className="mt-1 font-mono text-[10px] text-slate-400">
                        ID: {plugin.id}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={pluginBusy}
                      onClick={() => handleUninstallPlugin(plugin.id)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-500/20 disabled:opacity-45 dark:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("plugins.uninstall")}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* AI 本地控制接口 (CLI 同步) */}
      <div className="ui-card overflow-hidden text-sm">
        <div className="ui-card-header">
          <div className="space-y-0.5">
            <div className="ui-title text-sm">
              <Terminal className="h-4 w-4 text-purple-500" />
              <span>{t("settings.aiTitle")}</span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t("settings.aiDesc")}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-purple-500/15 px-2.5 py-1 font-mono text-xs font-medium text-purple-600 dark:text-purple-300">{AI_ENDPOINT}</code>
            {onOpenAiWorkbench && <button type="button" onClick={onOpenAiWorkbench} className="ui-btn-secondary">{t("aiWorkbench.title")}</button>}
          </div>
        </div>
      </div>

      {/* 驱动与环境自检合并入设置页 */}
      <DriverGuide />
    </div>
  );
}
