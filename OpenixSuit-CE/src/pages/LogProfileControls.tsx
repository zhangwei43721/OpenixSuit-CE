import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { LogProfile } from "../types/workbench";

interface LogProfileControlsProps {
  onLoad: (profile: LogProfile) => void;
  onLog: (message: string) => void;
  snapshot: () => Pick<LogProfile, "sources" | "bridge"> | null;
}

const CAPTURE_PROFILE_KEY = "openix_selected_capture_profile";

export function LogProfileControls({
  onLoad, onLog, snapshot,
}: LogProfileControlsProps) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<LogProfile[]>([]);
  const [selectedId, setSelectedId] = useState(() =>
    localStorage.getItem(CAPTURE_PROFILE_KEY) ?? ""
  );
  const [showDetails, setShowDetails] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof snapshot>>(null);
  const [name, setName] = useState("");
  const [updateSelected, setUpdateSelected] = useState(false);
  const [target, setTarget] = useState<LogProfile | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const dialogTitle = useId();
  const selectedProfile = profiles.find((profile) => profile.id === selectedId);
  const bridge = selectedProfile?.bridge;

  useEffect(() => {
    if (selectedProfile) localStorage.setItem(CAPTURE_PROFILE_KEY, selectedProfile.id);
  }, [selectedProfile]);

  useEffect(() => {
    let mounted = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const list = await invoke<LogProfile[]>("log_profiles_list");
        if (!mounted || request !== revision) return;
        setProfiles(list);
        setSelectedId((current) => list.some((profile) => profile.id === current) ? current : list[0]?.id ?? "");
        setLoadError(false);
      } catch (error) {
        if (!mounted || request !== revision) return;
        setLoadError(true);
        onLog(`log_profiles_list error: ${String(error)}`);
      }
    };
    const subscription = listen<string>("log-profiles-changed", () => { void refresh(); });
    void subscription.catch(() => {}).then(() => {
      if (mounted) void refresh();
    });
    return () => {
      mounted = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [onLog]);

  useEffect(() => {
    if (editing && !dialog.current?.open) {
      dialog.current?.showModal();
      nameInput.current?.focus();
    }
  }, [editing]);

  const openSave = () => {
    setShowDetails(false);
    setName("");
    setUpdateSelected(false);
    setTarget(selectedProfile);
    const current = snapshot();
    setSaveError(current ? "" : t("multiLog.profiles.configureFirst"));
    setDraft(current);
    setEditing(true);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !name.trim() || saving) return;
    setSaving(true);
    setSaveError("");
    const existing = updateSelected && target
      ? profiles.find((profile) => profile.id === target.id) ?? target
      : undefined;
    const profile: LogProfile = {
      id: `logs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...existing,
      ...draft,
      name: name.trim(),
    };
    try {
      const saved = await invoke<LogProfile>("log_profile_save", { profile });
      setProfiles((previous) => previous.some((entry) => entry.id === saved.id)
        ? previous.map((entry) => entry.id === saved.id ? saved : entry)
        : [...previous, saved]);
      setSelectedId(saved.id);
      dialog.current?.close();
      onLog(t("multiLog.profiles.saved", { name: saved.name }));
    } catch (error) {
      setSaveError(t("multiLog.profiles.saveError", { error: String(error) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      <select
        aria-label={t("multiLog.profiles.select")}
        value={selectedId}
        disabled={!profiles.length}
        onChange={(event) => {
          setSelectedId(event.target.value);
          setApplyError("");
        }}
        title={selectedProfile?.name}
        className="ui-select ui-select-compact min-w-0 max-w-40 truncate"
      >
        {!profiles.length && (
          <option value="">{t(loadError
            ? "multiLog.profiles.unavailable"
            : "multiLog.profiles.empty")}</option>
        )}
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
      <button type="button" onClick={openSave} className="ui-btn-secondary whitespace-nowrap px-2.5 py-1">
        {t("multiLog.profiles.save")}
      </button>
      {selectedProfile && (
        <>
          <button
            type="button"
            onClick={() => setShowDetails((current) => !current)}
            aria-expanded={showDetails}
            className="ui-btn-secondary whitespace-nowrap px-2.5 py-1"
          >
            {t("multiLog.profiles.details")}
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                onLoad(selectedProfile);
                setShowDetails(false);
                setApplyError("");
              } catch (error) {
                setApplyError(error instanceof Error ? error.message : String(error));
              }
            }}
            className="ui-btn-secondary whitespace-nowrap px-2.5 py-1"
          >
            {t("multiLog.profiles.apply")}
          </button>
          {showDetails && (
            <section
              aria-label={t("multiLog.profiles.details")}
              className="ui-subcard mt-1 max-h-60 min-w-0 basis-full overflow-y-auto break-words p-3 text-xs"
            >
              <ul className="space-y-2">
                {selectedProfile.sources.map((source, index) => (
                  <li key={index}>
                    <div className="font-medium">{source.label}</div>
                    <div className="break-all font-mono text-slate-600 dark:text-slate-300">
                      {source.type === "serial" ? `${source.port_name} · ${source.baud_rate}` : source.serial}
                    </div>
                    {source.type === "adb" && <code className="whitespace-pre-wrap break-all">{source.command}</code>}
                  </li>
                ))}
                {bridge && (["first", "second"] as const).map((end) => {
                  const port = bridge[end];
                  return (
                    <li key={end}>
                      <div className="font-medium">
                        {t(`multiLog.bridge.${end}`)}{port.label ? ` · ${port.label}` : ""}
                      </div>
                      <div className="break-all font-mono text-slate-600 dark:text-slate-300">
                        {port.port_name} · {port.baud_rate}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {selectedProfile.notes && (
                <p className="mt-2 whitespace-pre-wrap break-words border-t border-slate-200 pt-2 text-slate-600 dark:border-slate-700 dark:text-slate-300">
                  {selectedProfile.notes}
                </p>
              )}
            </section>
          )}
        </>
      )}
      {applyError && <p role="alert" className="basis-full break-words text-xs text-rose-600 dark:text-rose-400">{applyError}</p>}
      <dialog
        ref={dialog}
        aria-labelledby={dialogTitle}
        onClose={() => setEditing(false)}
        onCancel={(event) => { if (saving) event.preventDefault(); }}
        className="ui-card max-h-[calc(100vh_-_2rem)] w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto p-4 text-slate-900 backdrop:bg-black/40 dark:text-slate-100"
      >
        <form onSubmit={saveProfile} className="space-y-3">
          <h2 id={dialogTitle} className="text-sm font-semibold">{t("multiLog.profiles.save")}</h2>
          {draft && target && (
            <label className="block space-y-1 text-xs">
              <span>{t("multiLog.profiles.saveMode")}</span>
              <select
                value={updateSelected ? "update" : "new"}
                disabled={saving}
                onChange={(event) => {
                  const update = event.target.value === "update";
                  setUpdateSelected(update);
                  setName(update ? target.name : "");
                }}
                className="ui-select block w-full min-w-0 truncate"
              >
                <option value="new">{t("multiLog.profiles.saveNew")}</option>
                <option value="update">{t("multiLog.profiles.update", { name: target.name })}</option>
              </select>
            </label>
          )}
          {draft && (
            <label className="block space-y-1 text-xs">
              <span>{t("multiLog.profiles.name")}</span>
              <input
                ref={nameInput}
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
                className="ui-input block w-full"
                required
              />
            </label>
          )}
          {saveError && <p role="alert" className="break-words text-xs text-rose-600 dark:text-rose-400">{saveError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} disabled={saving} className="ui-btn-secondary">
              {t("common.cancel")}
            </button>
            {draft && (
              <button type="submit" disabled={saving || !name.trim()} className="ui-btn-primary">
                {t("common.save")}
              </button>
            )}
          </div>
        </form>
      </dialog>
    </div>
  );
}
