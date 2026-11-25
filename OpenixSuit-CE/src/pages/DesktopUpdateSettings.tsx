import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

type UpdateCheck =
  | { status: "unconfigured" | "unavailable" | "current" }
  | { status: "available"; version: string; installable: boolean };

interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export function DesktopUpdateSettings() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [configured, setConfigured] = useState(false);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void getVersion().then(setVersion, () => {});
    void invoke<boolean>("desktop_update_enabled").then(setConfigured, () => {});
  }, []);

  const checkUpdate = async () => {
    setCheck(null);
    setError("");
    setBusy("check");
    try {
      setCheck(await invoke<UpdateCheck>("desktop_check_update"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const openReleases = async () => {
    setError("");
    try {
      await invoke("desktop_open_releases");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const installUpdate = async () => {
    setBusy("install");
    setProgress(null);
    setError("");
    try {
      if (!(await ask(t("settings.update.confirm"), { title: t("settings.update.install"), kind: "warning" }))) {
        return;
      }
      const channel = new Channel<UpdateProgress>();
      channel.onmessage = setProgress;
      await invoke("desktop_install_update", { progress: channel });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const percentage = progress?.total
    ? Math.min(100, Math.round(progress.downloaded * 100 / progress.total))
    : null;

  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium">{t("settings.version")}</span>
          <span className="break-all font-mono text-xs text-slate-500 dark:text-slate-400">{version && `v${version}`}</span>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" onClick={checkUpdate} disabled={busy !== null} className="ui-btn-secondary">
            <RefreshCw className={`h-3.5 w-3.5 ${busy === "check" ? "animate-spin" : ""}`} />
            {t("settings.update.check")}
          </button>
          {check?.status === "available" && check.installable && (
            <button type="button" onClick={installUpdate} disabled={busy !== null} className="ui-btn-primary">
              <Download className="h-3.5 w-3.5" />
              {t("settings.update.install")}
            </button>
          )}
          {configured && (
            <button type="button" onClick={openReleases} disabled={busy !== null} className="ui-btn-secondary">
              <ExternalLink className="h-3.5 w-3.5" />
              {t("settings.update.releases")}
            </button>
          )}
        </div>
      </div>
      {busy === "install" && (
        <div role="status" className="text-xs text-blue-600 dark:text-blue-400">
          {percentage === null
            ? t("settings.update.installing")
            : t("settings.update.progress", { percentage })}
        </div>
      )}
      {check && busy === null && !error && (
        <div role="status" className="break-words text-xs text-slate-600 dark:text-slate-300">
          {check.status === "available"
            ? t(check.installable ? "settings.update.available" : "settings.update.manual", { version: check.version })
            : t(`settings.update.${check.status}`)}
        </div>
      )}
      {error && (
        <div role="alert" className="ui-alert-err block break-words">
          {t("settings.update.error", { error })}
        </div>
      )}
    </div>
  );
}
