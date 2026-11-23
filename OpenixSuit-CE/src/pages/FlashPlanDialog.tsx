import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export interface FlashPlan {
  id: string;
  mode: string;
  firmware_sha256: string;
  mbr: { length: number; partitions: { name: string; address: number; sectors: number }[] };
  partitions: { name: string; source: string; length: number }[];
  boot_components: { component: string; filename: string | null; conditions: string[] }[];
  conditional_writes: { operation: string; partition: string; condition: string }[];
  ram_staging: { component: string; filename: string | null }[];
}

export function FlashPlanDialog({ plan, deviceId, onCancel, onConfirm }: {
  plan: FlashPlan;
  deviceId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="flash-plan-title"
      className="ui-card m-auto w-11/12 max-w-3xl overflow-hidden p-0 text-slate-800 backdrop:bg-black/50 dark:text-slate-100"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <div className="ui-card-header">
        <h2 id="flash-plan-title" className="ui-title">{t("flash.planTitle")}</h2>
      </div>
      <div className="max-h-[65vh] space-y-3 overflow-auto px-4 py-3 text-sm">
        <p className={plan.mode === "full_erase" ? "ui-alert-warn" : undefined}>
          {t(`flash.modeDescription.${plan.mode}`)}
        </p>
        {deviceId && <p>{t("flash.planDevice", { device: deviceId })}</p>}
        <details>
          <summary className="cursor-pointer font-medium">
            {t("flash.planMbr", { count: plan.mbr.partitions.length, bytes: plan.mbr.length })}
          </summary>
          <ul className="mt-1 space-y-1 pl-4 text-xs">
            {plan.mbr.partitions.map((entry, index) => (
              <li key={index}>{entry.name} · {t("flash.planSectors", entry)}</li>
            ))}
          </ul>
        </details>
        <div>
          <h3 className="font-medium">{t("flash.partitions")}</h3>
          {plan.partitions.length > 0 ? (
            <ul className="space-y-1 pt-1 text-xs">
              {plan.partitions.map((entry) => (
                <li key={entry.name} className="break-all">{entry.name} ← {entry.source} · {entry.length.toLocaleString()} B</li>
              ))}
            </ul>
          ) : <p>{t("flash.planNone")}</p>}
        </div>
        <div>
          <h3 className="font-medium">{t("flash.planBoot")}</h3>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{t("flash.planBootDetail")}</p>
          <ul className="space-y-1 pt-1 text-xs">
            {plan.boot_components.filter((entry) => entry.filename).map((entry, index) => (
              <li key={index} className="break-all">
                <details>
                  <summary className="cursor-pointer">{entry.component} · {entry.filename}</summary>
                  <p className="pl-4">{entry.conditions.join(" / ")}</p>
                </details>
              </li>
            ))}
          </ul>
        </div>
        {plan.conditional_writes.map((entry) => (
          <p key={entry.operation} className="text-xs">{t("flash.planUbifs", { partition: entry.partition })}</p>
        ))}
        <details>
          <summary className="cursor-pointer font-medium">{t("flash.planRam")}</summary>
          <ul className="space-y-1 pl-4 pt-1 text-xs">
            {plan.ram_staging.filter((entry) => entry.filename).map((entry) => (
              <li key={entry.component}>{entry.component} · {entry.filename}</li>
            ))}
          </ul>
        </details>
        <p className="break-all font-mono text-xs">SHA-256 · {plan.firmware_sha256}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
        <button type="button" autoFocus onClick={onCancel} className="ui-btn-secondary">{t("common.cancel")}</button>
        <button type="button" onClick={onConfirm} className={plan.mode === "full_erase" ? "ui-btn-danger" : "ui-btn-primary"}>
          {t("flash.confirmWrite")}
        </button>
      </div>
    </dialog>
  );
}
