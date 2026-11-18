import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

interface EnvCheckReport {
  os: string;
  ok: boolean;
  summary: string;
  fix_hint: string;
}

export function DriverGuide() {
  const { t } = useTranslation();
  const [report, setReport] = useState<EnvCheckReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const runCheck = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await invoke<EnvCheckReport>("check_system_env");
      setReport(res);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runCheck();
  }, []);

  const copyCommand = async () => {
    if (!report?.fix_hint) return;
    try {
      await navigator.clipboard.writeText(report.fix_hint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  return (
    <div className="ui-card overflow-hidden">
      <div className="ui-card-header">
        <h3 className="ui-title text-sm">
          <ShieldCheck className="h-4 w-4 text-blue-500" />
          <span>{t("driver.title")}</span>
        </h3>
        <button
          type="button"
          disabled={loading}
          onClick={runCheck}
          className="ui-btn-primary"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? t("driver.checking") : t("driver.recheck")}
        </button>
      </div>

      <div className="space-y-3 p-4">
        {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}

        {report && (
          <div className="ui-subcard space-y-2.5 p-3 text-xs text-slate-900 dark:text-slate-100">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400">{t("driver.os")}:</span>
                <span className="rounded-md bg-slate-200/70 px-2 py-0.5 font-mono text-[11px] text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                  {report.os}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400">{t("driver.result")}:</span>
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                    report.ok
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  }`}
                >
                  {report.ok ? t("driver.ok") : t("driver.needConfig")}
                </span>
                <span className="text-slate-600 dark:text-slate-300">{report.summary}</span>
              </div>
            </div>
            {!report.ok && (
              <div className="space-y-1.5 border-t border-slate-200 pt-2.5 dark:border-slate-800">
                <div className="text-xs text-slate-600 dark:text-slate-400">{t("driver.guide")}</div>
                <div className="relative">
                  <pre className="ui-terminal whitespace-pre-wrap break-all p-3 pr-20 text-emerald-400">
                    {report.fix_hint}
                  </pre>
                  <button
                    type="button"
                    onClick={copyCommand}
                    className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-slate-700"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? t("driver.copied") : t("driver.copy")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
