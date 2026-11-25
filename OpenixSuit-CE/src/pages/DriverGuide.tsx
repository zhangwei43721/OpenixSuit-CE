import { useEffect, useId, useState } from "react";
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
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const runCheck = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await invoke<EnvCheckReport>("check_system_env");
      setReport(res);
    } catch (err) {
      setReport(null);
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
    <section className="min-w-0 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-3.5 shrink-0 text-blue-500" />
            {t("driver.title")}
          </h2>
          {report && !loading && (
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${report.ok
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>
              {t(report.ok ? "driver.ok" : "driver.needConfig")}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" disabled={loading} onClick={runCheck} className="ui-btn-secondary">
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            {t(loading ? "driver.checking" : "driver.recheck")}
          </button>
          {report && (
            <button type="button" className="ui-btn-secondary" aria-expanded={expanded} aria-controls={detailsId}
              onClick={() => setExpanded((open) => !open)}>
              {t(expanded ? "settings.collapseDetails" : "driver.details")}
            </button>
          )}
        </div>
      </div>
      {errorMsg && <div role="alert" className="ui-alert-warn mt-2 block break-all">{errorMsg}</div>}
      {report && !report.ok && !loading && (
        <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-400">{report.summary}</p>
      )}
      <div id={detailsId} hidden={!expanded || !report}>
        {expanded && report && (
          <div className="mt-2 space-y-2 border-t border-slate-200 pt-2 text-xs dark:border-slate-800">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-slate-500 dark:text-slate-400">{t("driver.os")}</span>
              <code className="min-w-0 break-all">{report.os}</code>
            </p>
            {report.ok && <p className="break-words text-slate-600 dark:text-slate-300">{report.summary}</p>}
            {!report.ok && report.fix_hint && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 text-slate-600 dark:text-slate-400">{t("driver.guide")}</p>
                  <button type="button" onClick={copyCommand} className="ui-btn-secondary">
                    {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                    {t(copied ? "driver.copied" : "driver.copy")}
                  </button>
                </div>
                <pre className="ui-terminal max-w-full whitespace-pre-wrap break-all p-2 text-emerald-400">
                  {report.fix_hint}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
