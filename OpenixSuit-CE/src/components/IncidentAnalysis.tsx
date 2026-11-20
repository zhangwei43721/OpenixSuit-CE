import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

interface AnalysisSettings {
  enabled: boolean;
  codex_path: string;
}

export type IncidentAnalysisRecord = { incident_id: string } & (
  | { status: "queued" | "running" }
  | { status: "completed"; output: string }
  | { status: "failed"; error: string }
);

export function IncidentAnalysisOptions() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AnalysisSettings | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    invoke<AnalysisSettings>("incident_analysis_settings").then(
      (loaded) => {
        if (active) setSettings(loaded);
      },
      (error) => {
        if (active) setFeedback({ error: true, text: String(error) });
      }
    );
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    if (!settings || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await invoke<AnalysisSettings>("incident_analysis_save_settings", { settings });
      setSettings(saved);
      setFeedback({ error: false, text: t("incidentAnalysis.saved") });
    } catch (error) {
      setFeedback({ error: true, text: String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ui-card overflow-hidden">
      <div className="ui-card-header">
        <h3 className="ui-title">{t("incidentAnalysis.title")}</h3>
      </div>
      <div className="space-y-3 p-3 text-xs">
        <p className="text-slate-600 dark:text-slate-300">{t("incidentAnalysis.description")}</p>
        <fieldset disabled={saving || !settings} className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings?.enabled ?? false}
              onChange={(event) => settings && setSettings({ ...settings, enabled: event.target.checked })}
            />
            {t("incidentAnalysis.enable")}
          </label>
          <label className="block space-y-1">
            <span>{t("incidentAnalysis.codexPath")}</span>
            <input
              type="text"
              className="ui-input w-full"
              placeholder={t("incidentAnalysis.codexPathPlaceholder")}
              value={settings?.codex_path ?? ""}
              onChange={(event) => settings && setSettings({ ...settings, codex_path: event.target.value })}
            />
          </label>
          <button type="button" className="ui-btn-primary" onClick={save}>
            {t("common.save")}
          </button>
        </fieldset>
        {feedback && (
          <div role="status" className={feedback.error ? "ui-alert-err" : "ui-alert-ok"}>
            {feedback.text}
          </div>
        )}
      </div>
    </div>
  );
}

export function IncidentAnalysisResult({ analysis }: { analysis: IncidentAnalysisRecord }) {
  const { t } = useTranslation();

  return (
    <div className="ui-subcard space-y-2 p-3 text-xs">
      <p className="font-semibold" role="status">{t(`incidentAnalysis.status.${analysis.status}`)}</p>
      {analysis.status === "completed" && (
        <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
          {analysis.output}
        </div>
      )}
      {analysis.status === "failed" && (
        <p className="whitespace-pre-wrap break-words text-rose-700 dark:text-rose-300">
          {analysis.error}
        </p>
      )}
    </div>
  );
}
