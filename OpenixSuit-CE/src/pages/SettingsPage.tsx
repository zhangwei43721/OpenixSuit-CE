import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AppSettings, ThemeMode, UsbBackend } from "../store/settings";
import { DriverGuide } from "./DriverGuide";

interface SettingsPageProps {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

const AI_ENDPOINT = "http://127.0.0.1:28765";
const AI_CLI_EXAMPLES = [
  "openixsuit-ai status",
  "curl http://127.0.0.1:28765/api/status",
];

export function SettingsPage({ settings, onUpdate }: SettingsPageProps) {
  const { t } = useTranslation();
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

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
