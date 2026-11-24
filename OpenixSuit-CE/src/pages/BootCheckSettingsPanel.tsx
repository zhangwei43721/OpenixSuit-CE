import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

type BootSlot = "" | "a" | "b";

interface BootCheckSettings {
  enabled: boolean;
  adbTarget: string;
  expectedSlot: BootSlot;
  executablePath: string;
  expectedSha256: string;
}

export interface BootCheckRequest {
  adbTarget: string;
  expectedSlot: Exclude<BootSlot, ""> | null;
  programCheck: { executablePath: string; expectedSha256: string } | null;
}

const STORAGE_KEY = "flash_boot_check";
const DEFAULT_SETTINGS: BootCheckSettings = {
  enabled: false,
  adbTarget: "",
  expectedSlot: "",
  executablePath: "",
  expectedSha256: "",
};

function validationError(settings: BootCheckSettings) {
  if (!settings.enabled) return null;
  if (!settings.adbTarget) return "flash.bootSetup.targetRequired";
  const { executablePath, expectedSha256 } = settings;
  if ((executablePath || expectedSha256) && (
    !executablePath.startsWith("/") || executablePath.includes("\n") || !/^[0-9a-f]{64}$/i.test(expectedSha256)
  )) {
    return "flash.bootSetup.programInvalid";
  }
  return null;
}

function loadSettings(): BootCheckSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
    const { enabled, adbTarget, expectedSlot, executablePath, expectedSha256 } =
      value as Partial<BootCheckSettings>;
    if (typeof enabled !== "boolean" || typeof adbTarget !== "string" ||
      typeof executablePath !== "string" || typeof expectedSha256 !== "string" ||
      (expectedSlot !== "" && expectedSlot !== "a" && expectedSlot !== "b")) {
      return DEFAULT_SETTINGS;
    }
    const settings: BootCheckSettings = { enabled, adbTarget, expectedSlot, executablePath, expectedSha256 };
    return validationError(settings) ? DEFAULT_SETTINGS : settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useBootCheckSettings() {
  const [saved, setSaved] = useState(loadSettings);
  const [draft, setDraft] = useState(saved);
  const [feedback, setFeedback] = useState<{ key: string; error?: boolean } | null>(null);
  const dirty = saved.enabled !== draft.enabled || saved.adbTarget !== draft.adbTarget ||
    saved.expectedSlot !== draft.expectedSlot || saved.executablePath !== draft.executablePath ||
    saved.expectedSha256 !== draft.expectedSha256;

  const request: BootCheckRequest | null = saved.enabled ? {
    adbTarget: saved.adbTarget,
    expectedSlot: saved.expectedSlot || null,
    programCheck: saved.executablePath ? {
      executablePath: saved.executablePath,
      expectedSha256: saved.expectedSha256,
    } : null,
  } : null;

  function update(values: Partial<BootCheckSettings>) {
    setDraft((previous) => ({ ...previous, ...values }));
    setFeedback(null);
  }

  function save() {
    const next = {
      ...draft,
      adbTarget: draft.adbTarget.trim(),
      executablePath: draft.executablePath.trim(),
      expectedSha256: draft.expectedSha256.trim(),
    };
    const error = validationError(next);
    if (error) {
      setFeedback({ key: error, error: true });
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(next);
      setDraft(next);
      setFeedback({ key: "flash.bootSetup.saved" });
    } catch {
      setFeedback({ key: "flash.bootSetup.saveError", error: true });
    }
  }

  function discard() {
    setDraft(saved);
    setFeedback(null);
  }

  return { request, draft, dirty, feedback, update, save, discard };
}

export function BootCheckSettingsPanel({ settings, afterPoweroff, disabled }: {
  settings: ReturnType<typeof useBootCheckSettings>;
  afterPoweroff: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { request, draft, dirty, feedback, update, save, discard } = settings;
  const status = afterPoweroff ? "skippedPoweroff" : request ? "enabled" : "disabled";

  return (
    <details className="ui-subcard group px-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-slate-500 group-open:rotate-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">{t("flash.result.boot")}</span>
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {request && !afterPoweroff && (
            <span className="max-w-full truncate text-slate-500 dark:text-slate-400" title={request.adbTarget}>{request.adbTarget}</span>
          )}
          <span className={status === "enabled" ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-slate-600 dark:text-slate-400"}>
            {t(`flash.bootSetup.${status}`)}
          </span>
          {dirty && <span className="font-medium text-amber-700 dark:text-amber-400">{t("flash.bootSetup.unsaved")}</span>}
        </span>
      </summary>
      <form className="border-t border-slate-200 py-2.5 dark:border-slate-700" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <fieldset disabled={disabled} className="min-w-0 space-y-2.5">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} className="accent-blue-600" />
            {t("flash.bootSetup.enable")}
          </label>
          {draft.enabled && (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span>{t("flash.adbTarget")}</span>
                <input className="ui-input w-full" value={draft.adbTarget} onChange={(e) => update({ adbTarget: e.target.value })} placeholder="adb-usb:usb:1-3#20080411" />
              </label>
              <label className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("flash.expectedSlot")}</span>
                <select className="ui-select" value={draft.expectedSlot} onChange={(e) => update({ expectedSlot: e.target.value as BootSlot })}>
                  <option value="">{t("flash.observeSlot")}</option>
                  <option value="a">A</option>
                  <option value="b">B</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span>{t("flash.executablePath")}</span>
                <input className="ui-input w-full" value={draft.executablePath} onChange={(e) => update({ executablePath: e.target.value })} placeholder="/usr/bin/app" />
              </label>
              <label className="block space-y-1">
                <span>{t("flash.expectedSha256")}</span>
                <input className="ui-input w-full" value={draft.expectedSha256} onChange={(e) => update({ expectedSha256: e.target.value })} />
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && <button type="button" className="ui-btn-secondary" onClick={discard}>{t("flash.bootSetup.discard")}</button>}
            <button type="submit" className="ui-btn-primary" disabled={!dirty}>{t("flash.bootSetup.save")}</button>
          </div>
          {feedback && (
            <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "ui-alert-err" : "text-emerald-700 dark:text-emerald-400"}>
              {t(feedback.key)}
            </p>
          )}
        </fieldset>
      </form>
    </details>
  );
}
