import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy } from "lucide-react";
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
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("driver.title")}</h2>
        <button
          disabled={loading}
          onClick={runCheck}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {loading ? t("driver.checking") : t("driver.recheck")}
        </button>
      </div>

      {errorMsg && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {errorMsg}
        </div>
      )}

      {report && (
        <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
          <div>
            {t("driver.os")}: {report.os}
          </div>
          <div>
            {t("driver.result")}: {report.ok ? t("driver.ok") : t("driver.needConfig")} — {report.summary}
          </div>
          {!report.ok && (
            <>
              <div className="text-xs text-slate-600 dark:text-slate-400">{t("driver.guide")}</div>
              <div className="relative">
                <pre className="whitespace-pre-wrap break-all rounded bg-slate-900 p-3 pr-20 text-xs text-emerald-400 dark:bg-slate-950">
                  {report.fix_hint}
                </pre>
                <button
                  onClick={copyCommand}
                  className="absolute right-2 top-2 flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? t("driver.copied") : t("driver.copy")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
