import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Copy, FolderOpen, Puzzle, RefreshCw, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppSettings, ThemeMode, UsbBackend } from "../store/settings";
import { PluginManifest } from "../types/plugin";
import { ExtensionIcon } from "../components/ExtensionIcon";
import { DriverGuide } from "./DriverGuide";

interface SettingsPageProps {
  settings: AppSettings;
  plugins: PluginManifest[];
  onUpdate: (patch: Partial<AppSettings>) => void;
  onRefreshPlugins: () => Promise<void>;
  onLog: (msg: string) => void;
}

const AI_ENDPOINT = "http://127.0.0.1:28765";
const AI_CLI_EXAMPLES = [
  "openixsuit-ce ai status",
  "openixsuit-ai status",
  "curl http://127.0.0.1:28765/api/status",
];

export function SettingsPage({
  settings,
  plugins,
  onUpdate,
  onRefreshPlugins,
  onLog,
}: SettingsPageProps) {
  const { t } = useTranslation();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
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

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd(text);
      setTimeout(() => setCopiedCmd((cur) => (cur === text ? null : cur)), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-lg font-semibold">{t("settings.title")}</h2>

      <div className="space-y-4 rounded border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">{t("settings.lang")}</div>
            <div className="text-xs text-slate-500">{t("settings.langDesc")}</div>
          </div>
          <select
            value={settings.language}
            onChange={(e) => onUpdate({ language: e.target.value as "zh-CN" | "en-US" })}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800">
          <div>
            <div className="font-medium">{t("settings.theme")}</div>
            <div className="text-xs text-slate-500">{t("settings.themeDesc")}</div>
          </div>
          <select
            value={settings.theme}
            onChange={(e) => onUpdate({ theme: e.target.value as ThemeMode })}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="system">{t("settings.system")}</option>
            <option value="dark">{t("settings.dark")}</option>
            <option value="light">{t("settings.light")}</option>
          </select>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800">
          <div>
            <div className="font-medium">{t("settings.usb")}</div>
            <div className="text-xs text-slate-500">{t("settings.usbDesc")}</div>
          </div>
          <select
            value={settings.usb_backend}
            onChange={(e) => onUpdate({ usb_backend: e.target.value as UsbBackend })}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="auto">Auto</option>
            <option value="winusb">WinUSB</option>
            <option value="libusb">libusb</option>
          </select>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800">
          <div>
            <div className="font-medium">{t("settings.version")}</div>
            <div className="text-xs text-slate-500">OpenixSuit-CE v0.1.0 (Tauri 2.x + React 19)</div>
          </div>
          <span className="rounded bg-blue-600/15 px-2.5 py-1 text-xs font-medium text-blue-600 dark:text-blue-400">
            {t("settings.latest")}
          </span>
        </div>
      </div>

      {/* 项目拓展插件管理 */}
      <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 font-medium">
              <Puzzle className="h-4 w-4 text-blue-500" />
              <span>{t("plugins.settingsTitle")}</span>
            </div>
            <div className="mt-0.5 text-xs text-slate-500">{t("plugins.settingsDesc")}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pluginBusy}
              onClick={() => onRefreshPlugins()}
              className="flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${pluginBusy ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </button>
            <button
              type="button"
              disabled={pluginBusy}
              onClick={handleImportPluginDir}
              className="flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("plugins.importDir")}
            </button>
            <button
              type="button"
              disabled={pluginBusy}
              onClick={handleImportPlugin}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {t("plugins.import")}
            </button>
          </div>
        </div>

        {pluginError && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {pluginError}
          </div>
        )}

        <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          {plugins.length === 0 ? (
            <div className="rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
              {t("plugins.noPlugins")}
            </div>
          ) : (
            plugins.map((plugin) => {
              const tabCount =
                Array.isArray(plugin.tabs) && plugin.tabs.length > 0 ? plugin.tabs.length : 1;
              return (
                <div
                  key={plugin.id}
                  className="flex items-start justify-between gap-3 rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ExtensionIcon icon={plugin.icon} className="h-4 w-4 shrink-0 text-blue-500" />
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        {plugin.name}
                      </span>
                      <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        v{plugin.version}
                      </span>
                      <span className="rounded bg-blue-600/15 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
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
                    className="flex shrink-0 items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-600 hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t("plugins.uninstall")}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* AI 本地控制接口 (CLI 同步) */}
      <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-medium">{t("settings.aiTitle")}</div>
            <div className="text-xs text-slate-500">{t("settings.aiDesc")}</div>
          </div>
          <code className="rounded bg-purple-500/15 px-2.5 py-1 font-mono text-xs font-medium text-purple-600 dark:text-purple-300">
            {AI_ENDPOINT}
          </code>
        </div>

        <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="text-xs text-slate-500">{t("settings.aiExamples")}</div>
          {AI_CLI_EXAMPLES.map((cmd) => (
            <div key={cmd} className="relative">
              <pre className="whitespace-pre-wrap break-all rounded bg-slate-900 p-2.5 pr-20 font-mono text-xs text-emerald-400 dark:bg-slate-950">
                {cmd}
              </pre>
              <button
                onClick={() => copyText(cmd)}
                className="absolute right-2 top-1.5 flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
              >
                {copiedCmd === cmd ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedCmd === cmd ? t("driver.copied") : t("driver.copy")}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 驱动与环境自检合并入设置页 */}
      <DriverGuide />
    </div>
  );
}
