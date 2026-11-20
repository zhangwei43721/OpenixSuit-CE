import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

interface CaptureSettings {
  save_continuous: boolean;
  keywords: string[];
  before_lines: number;
  after_lines: number;
  directory?: string | null;
}

interface CaptureInfo {
  directory: string;
  default_directory: string;
  settings: CaptureSettings;
}

export function LogCaptureSettings() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [continuous, setContinuous] = useState(true);
  const [keywords, setKeywords] = useState("");
  const [context, setContext] = useState({ before_lines: "", after_lines: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [directory, setDirectory] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let changed = false;
    const apply = (current: CaptureInfo) => {
      setInfo(current);
      setDirectory(current.settings.directory ?? null);
      setContinuous(current.settings.save_continuous);
      setKeywords(current.settings.keywords.join("\n"));
      setContext({
        before_lines: String(current.settings.before_lines),
        after_lines: String(current.settings.after_lines),
      });
      setError("");
    };
    const subscription = listen<CaptureInfo>("log-capture-settings-changed", ({ payload }) => {
      if (mounted) {
        changed = true;
        apply(payload);
      }
    });
    void subscription.catch(() => {}).then(() => invoke<CaptureInfo>("log_capture_get")).then(
      (current) => { if (mounted && !changed) apply(current); },
      (reason) => { if (mounted && !changed) setError(String(reason)); },
    );
    return () => {
      mounted = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const chooseDirectory = async () => {
    setError("");
    try {
      const selected = await open({ directory: true });
      if (typeof selected === "string") {
        setDirectory(selected);
        setSaved(false);
      }
    } catch (reason) {
      setError(String(reason));
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !info) return;
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const current = await invoke<CaptureInfo>("log_capture_save", {
        settings: {
          save_continuous: continuous,
          keywords: keywords.split("\n").map((word) => word.trim()).filter(Boolean),
          before_lines: Number(context.before_lines),
          after_lines: Number(context.after_lines),
          directory,
        },
      });
      setInfo(current);
      setDirectory(current.settings.directory ?? null);
      setKeywords(current.settings.keywords.join("\n"));
      setSaved(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} onChange={() => setSaved(false)} className="ui-card min-w-0 space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t("multiLog.storage.directory")}</h2>
        <p className="select-text break-all font-mono text-xs text-slate-600 dark:text-slate-300">
          {directory ?? info?.default_directory ?? info?.directory ?? (!error && t("multiLog.storage.loading"))}
        </p>
        {info && (
          <>
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" onClick={chooseDirectory} disabled={saving} className="ui-btn-secondary">
                {t("multiLog.storage.chooseDirectory")}
              </button>
              {directory && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => { setDirectory(null); setSaved(false); setError(""); }}
                  className="ui-btn-secondary"
                >
                  {t("multiLog.storage.useDefaultDirectory")}
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("multiLog.storage.directoryHint")}</p>
          </>
        )}
      </div>
      {info && (
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <div className="space-y-1 border-t border-slate-200 pt-3 dark:border-slate-800">
            <label className="flex w-fit items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} />
              {t("multiLog.storage.continuous")}
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("multiLog.storage.continuousHint")}</p>
          </div>
          <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <label className="block space-y-1 text-sm font-medium">
              <span>{t("multiLog.storage.keywords")}</span>
              <textarea
                rows={4}
                value={keywords}
                placeholder={t("multiLog.storage.keywordExample")}
                onChange={(event) => setKeywords(event.target.value)}
                className="ui-input block w-full min-w-0 max-w-lg resize-y font-mono"
              />
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("multiLog.storage.keywordHint")}</p>
            <div className="flex flex-wrap gap-3">
              {(["before_lines", "after_lines"] as const).map((key) => (
                <label key={key} className="flex flex-wrap items-center gap-2 text-xs">
                  {t(key === "before_lines" ? "multiLog.storage.before" : "multiLog.storage.after")}
                  <input
                    type="number"
                    required
                    min={0}
                    max={1000}
                    value={context[key]}
                    onChange={(event) => setContext({ ...context, [key]: event.target.value })}
                    className="ui-input w-24 text-right tabular-nums"
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="ui-btn-primary">
              {t(saving ? "multiLog.storage.saving" : "multiLog.storage.save")}
            </button>
            {saved && <span role="status" className="text-xs text-emerald-700 dark:text-emerald-400">{t("multiLog.storage.saved")}</span>}
          </div>
        </fieldset>
      )}
      {error && <p role="alert" className="break-words text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </form>
  );
}
