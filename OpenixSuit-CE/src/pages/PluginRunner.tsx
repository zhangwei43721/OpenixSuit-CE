import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, Play, RefreshCw, Square, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PluginField, PluginProvider, PluginProviderSession, PluginRun, PluginTabItem } from "../types/plugin";
import { AdbDevice, adbDeviceKey, adbDeviceLabel, FelDevice, efexDeviceLabel } from "../components/TopBar";
import { ExtensionIcon } from "../components/ExtensionIcon";
import { LogMarkedText } from "../utils/ansi";

interface PluginRunnerProps {
  item: PluginTabItem;
  serial: string;
  adbDevices: AdbDevice[];
  felDevices: FelDevice[];
  onLog: (msg: string) => void;
}

interface JsonDraft {
  __pluginJsonDraft: string;
}

async function pluginRequest<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("plugin_request", { action, args });
}

function initialValues(fields: PluginField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [
    field.id,
    field.default ?? (field.type === "boolean" ? false : field.type === "number" ? 0 : field.type === "json" ? {} : ""),
  ]));
}

function isJsonDraft(value: unknown): value is JsonDraft {
  return !!value && typeof value === "object" && "__pluginJsonDraft" in value;
}

function normalizeInputs(fields: PluginField[], values: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...values };
  for (const field of fields) {
    if (field.type !== "json") continue;
    const value = values[field.id];
    if (!isJsonDraft(value)) continue;
    try {
      normalized[field.id] = JSON.parse(value.__pluginJsonDraft);
    } catch {
      throw new Error(`${field.label}: ${"Invalid JSON"}`);
    }
  }
  const missing = fields.filter((field) => field.required && (normalized[field.id] === undefined || normalized[field.id] === null || normalized[field.id] === ""));
  if (missing.length) throw new Error(missing.map((field) => field.label).join(", "));
  return normalized;
}

function FieldInput({ field, value, onChange }: { field: PluginField; value: unknown; onChange: (value: unknown) => void }) {
  const { t } = useTranslation();
  const className = "ui-input w-full";

  if (field.type === "boolean") {
    return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (field.type === "select") {
    return (
      <select className="ui-select w-full" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === "file") {
    return (
      <div className="flex gap-2">
        <input className={className} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        <button className="ui-btn-secondary shrink-0" type="button" onClick={async () => {
          const selected = await open();
          if (typeof selected === "string") onChange(selected);
        }}>
          {t("common.browse")}
        </button>
      </div>
    );
  }
  if (field.type === "json") {
    const text = isJsonDraft(value) ? value.__pluginJsonDraft : JSON.stringify(value ?? {}, null, 2);
    return (
      <textarea
        className={`${className} min-h-24 font-mono`}
        value={text}
        onChange={(event) => {
          const draft = event.target.value;
          try { onChange(JSON.parse(draft)); }
          catch { onChange({ __pluginJsonDraft: draft } satisfies JsonDraft); }
        }}
      />
    );
  }
  return (
    <input
      className={className}
      type={field.type === "number" ? "number" : "text"}
      required={field.required}
      value={String(value ?? "")}
      onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
    />
  );
}

function JsonValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const columns = [...new Set(value.flatMap((item) => Object.keys(item as object)))];
      return (
        <div className="overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead><tr>{columns.map((column) => <th key={column} className="border-b border-slate-200 px-2 py-1 dark:border-slate-700">{column}</th>)}</tr></thead>
            <tbody>{value.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column} className="border-b border-slate-100 px-2 py-1 font-mono dark:border-slate-800">{formatValue((row as Record<string, unknown>)[column])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    return <ul className="list-disc space-y-0.5 pl-5 text-xs">{value.map((item, index) => <li key={index}>{formatValue(item)}</li>)}</ul>;
  }
  if (typeof value === "object") {
    return (
      <dl className="grid gap-2 sm:grid-cols-2">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key} className="rounded-lg border border-slate-200 bg-white/60 px-2.5 py-2 dark:border-slate-700 dark:bg-slate-900/50">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{key}</dt>
            <dd className="mt-1 break-all font-mono text-xs">{formatValue(item)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="break-all font-mono text-xs">{String(value)}</span>;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function ProviderCard({
  provider,
  manifestActions,
  sessions,
  providerInputs,
  providerCallInputs,
  busy,
  onProviderInput,
  onCallInput,
  onStart,
  onStop,
  onCall,
}: {
  provider: PluginProvider;
  manifestActions: PluginTabItem["plugin"]["manifest"]["actions"];
  sessions: PluginProviderSession[];
  providerInputs: Record<string, unknown>;
  providerCallInputs: Record<string, Record<string, unknown>>;
  busy: boolean;
  onProviderInput: (id: string, key: string, value: unknown) => void;
  onCallInput: (key: string, values: Record<string, unknown>) => void;
  onStart: () => void;
  onStop: (sessionId: string) => void;
  onCall: (sessionId: string, operation: string, inputs: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const connectId = provider.actions.connect;
  const connectAction = manifestActions.find((action) => action.id === connectId);
  const connectValues = providerInputs;

  return (
    <div className="ui-subcard space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-xs">{provider.label} <span className="font-normal text-slate-500">({provider.kind})</span></strong>
        <button className="ui-btn-primary" disabled={busy} onClick={onStart}><Play className="h-3 w-3" />{t("plugins.startProvider")}</button>
      </div>
      {connectAction?.inputs.map((field) => (
        <label key={field.id} className="block space-y-1 text-xs">
          <span>{field.label}{field.required ? " *" : ""}</span>
          {field.description && <span className="block text-slate-500">{field.description}</span>}
          <FieldInput field={field} value={connectValues[field.id] ?? initialValues([field])[field.id]} onChange={(value) => onProviderInput(provider.id, field.id, value)} />
        </label>
      ))}
      <div className="space-y-2">
        {sessions.filter((session) => session.provider === provider.id).map((session) => (
          <div key={session.id} className="ui-subcard space-y-2 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span><code>{session.id}</code> · {session.status}{session.error ? ` · ${session.error}` : ""}</span>
              <button className="ui-btn-secondary py-1" onClick={() => onStop(session.id)}><Square className="h-3 w-3" />{t("plugins.stopProvider")}</button>
            </div>
            {session.logs.length > 0 && <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-500">{session.logs.join("\n")}</pre>}
            <div className="space-y-2">
              {Object.entries(provider.actions).filter(([operation]) => operation.toLowerCase() !== "connect").map(([operation, actionId]) => {
                const callAction = manifestActions.find((action) => action.id === actionId);
                const inputKey = `${session.id}:${operation}`;
                const values = providerCallInputs[inputKey] ?? initialValues(callAction?.inputs ?? []);
                return (
                  <div key={operation} className="ui-subcard space-y-2 p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <strong>{operation}</strong>
                      <button className="ui-btn-secondary py-1" onClick={() => onCall(session.id, operation, values)}><Terminal className="h-3 w-3" />{t("plugins.callProvider")}</button>
                    </div>
                    {callAction?.inputs.map((field) => (
                      <label key={field.id} className="block space-y-1 text-[11px]">
                        <span>{field.label}{field.required ? " *" : ""}</span>
                        <FieldInput field={field} value={values[field.id]} onChange={(value) => onCallInput(inputKey, { ...values, [field.id]: value })} />
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunCard({
  run,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  run: PluginRun;
  action?: PluginTabItem["plugin"]["manifest"]["actions"][number];
  busy: boolean;
  onConfirm: (run: PluginRun) => void;
  onCancel: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const output = run.result && typeof run.result === "object" ? run.result as Record<string, unknown> : {};
  const canCancel = run.status === "running" || run.status === "awaiting_confirmation";

  return (
    <article className="ui-subcard space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong>{action?.label ?? run.action}</strong>
        <span className="rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-800">{run.status}</span>
        <span className="text-slate-500">{run.origin}{run.device ? ` · ${run.device}` : ""}</span>
        <span className="ml-auto font-mono text-[10px] text-slate-400">{run.id}</span>
        {canCancel && <button className="ui-btn-secondary py-1" disabled={busy} onClick={() => onCancel(run.id)}><Square className="h-3 w-3" />{t("plugins.cancel")}</button>}
      </div>
      {run.confirmation && (
        <div className="ui-alert-warn block space-y-2">
          <strong>{run.confirmation.summary}</strong>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-amber-500/20 px-2.5 py-2 text-xs"><span className="text-amber-700 dark:text-amber-300">{t("plugins.capability")}</span><div className="mt-1 font-mono">{run.confirmation.capability}</div></div>
            {run.confirmation.device && <div className="rounded-lg border border-amber-500/20 px-2.5 py-2 text-xs"><span className="text-amber-700 dark:text-amber-300">{t("plugins.targetDevice")}</span><div className="mt-1 font-mono">{run.confirmation.device}</div></div>}
          </div>
          {run.confirmation.details !== undefined && <JsonValue value={run.confirmation.details} />}
          <button className="ui-btn-primary" disabled={busy} onClick={() => onConfirm(run)}><Check className="h-3.5 w-3.5" />{t("plugins.confirm")}</button>
        </div>
      )}
      {run.error && <div className="text-xs text-rose-500">{run.error}</div>}
      {run.logs.length > 0 && <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-2 font-mono text-[10px] text-slate-200"><LogMarkedText text={run.logs.join("\n")} /></pre>}
      {run.result !== undefined && (
        <div className="space-y-2">
          {action?.output && action.output.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{action.output.map((field) => <div key={field.id} className="ui-subcard p-2"><div className="text-[10px] font-medium text-slate-500">{field.label}</div><div className="mt-1"><JsonValue value={output[field.id]} /></div></div>)}</div>}
          <details>
            <summary className="cursor-pointer text-xs text-slate-500">{t("plugins.result")}</summary>
            <div className="mt-2"><JsonValue value={run.result} /></div>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-500">{JSON.stringify(run.result, null, 2)}</pre>
          </details>
        </div>
      )}
    </article>
  );
}

export function PluginRunner({ item, serial, adbDevices, felDevices, onLog }: PluginRunnerProps) {
  const { t } = useTranslation();
  const { manifest } = item.plugin;
  const actions = useMemo(() => {
    const pageIds = item.page?.actions;
    return manifest.actions.filter((action) => !pageIds || pageIds.includes(action.id));
  }, [manifest.actions, item.page]);
  const [actionId, setActionId] = useState(actions[0]?.id ?? "");
  const action = actions.find((entry) => entry.id === actionId) ?? actions[0];
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => initialValues(action?.inputs ?? []));
  const [targetDevice, setTargetDevice] = useState(serial);
  const [runs, setRuns] = useState<PluginRun[]>([]);
  const [sessions, setSessions] = useState<PluginProviderSession[]>([]);
  const [providerInputs, setProviderInputs] = useState<Record<string, Record<string, unknown>>>({});
  const [providerCallInputs, setProviderCallInputs] = useState<Record<string, Record<string, unknown>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [runList, providerList] = await Promise.all([
      pluginRequest<PluginRun[]>("runs", { id: manifest.id }).catch(() => []),
      pluginRequest<PluginProviderSession[]>("providers", { id: manifest.id }).catch(() => []),
    ]);
    setRuns(Array.isArray(runList) ? runList.slice(-100).reverse() : []);
    setSessions(Array.isArray(providerList) ? providerList.slice(-50).reverse() : []);
  }, [manifest.id]);

  useEffect(() => {
    setActionId(actions[0]?.id ?? "");
    setInputs(initialValues(actions[0]?.inputs ?? []));
  }, [actions]);
  useEffect(() => { setTargetDevice(serial); }, [serial]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const runListener = listen<PluginRun>("plugin-run-changed", ({ payload }) => {
      if (payload.plugin_id === manifest.id) setRuns((previous) => [payload, ...previous.filter((run) => run.id !== payload.id)].slice(0, 100));
    });
    const providerListener = listen<PluginProviderSession>("plugin-provider-changed", ({ payload }) => {
      if (payload.plugin_id === manifest.id) setSessions((previous) => [payload, ...previous.filter((session) => session.id !== payload.id)].slice(0, 50));
    });
    return () => { runListener.then((unlisten) => unlisten()); providerListener.then((unlisten) => unlisten()); };
  }, [manifest.id]);

  const request = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const addRun = (run: PluginRun) => setRuns((previous) => [run, ...previous.filter((entry) => entry.id !== run.id)].slice(0, 100));
  const runAction = async (id: string, values: Record<string, unknown>) => {
    const selected = manifest.actions.find((entry) => entry.id === id);
    const run = await pluginRequest<PluginRun>("run", {
      id: manifest.id,
      action: id,
      inputs: normalizeInputs(selected?.inputs ?? [], values),
      device: targetDevice || undefined,
    });
    addRun(run);
    onLog(`Plugin ${manifest.id}/${id}: ${run.status}`);
  };

  const handleProviderStart = async (provider: PluginProvider) => {
    const connect = manifest.actions.find((entry) => entry.id === provider.actions.connect);
    const session = await pluginRequest<PluginProviderSession>("provider_start", {
      id: manifest.id,
      provider: provider.id,
      inputs: normalizeInputs(connect?.inputs ?? [], providerInputs[provider.id] ?? initialValues(connect?.inputs ?? [])),
      device: targetDevice || undefined,
    });
    setSessions((previous) => [session, ...previous.filter((entry) => entry.id !== session.id)].slice(0, 50));
  };

  const handleProviderCall = async (sessionId: string, operation: string, values: Record<string, unknown>) => {
    const provider = manifest.providers.find((entry) => entry.id === sessions.find((session) => session.id === sessionId)?.provider);
    const actionId = provider?.actions[operation];
    const action = manifest.actions.find((entry) => entry.id === actionId);
    const run = await pluginRequest<PluginRun>("provider_call", {
      session_id: sessionId,
      operation,
      inputs: normalizeInputs(action?.inputs ?? [], values),
    });
    addRun(run);
  };

  const title = item.page?.label ?? manifest.name;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto pr-1">
      <div className="ui-toolbar items-start">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ExtensionIcon icon={item.icon} className="h-5 w-5 text-blue-500" />
            <h2 className="ui-title text-sm">{title}</h2>
            <span className="rounded bg-slate-200 px-2 py-0.5 font-mono text-[10px] dark:bg-slate-800">v{manifest.version}</span>
          </div>
          {(item.page?.description || manifest.description) && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.page?.description || manifest.description}</p>}
        </div>
        <label className="flex min-w-60 items-center gap-2 text-xs text-slate-500">
          <span className="shrink-0">{t("plugins.targetDevice")}</span>
          <select className="ui-select min-w-0 flex-1" value={targetDevice} onChange={(event) => setTargetDevice(event.target.value)}>
            <option value="">{t("plugins.noDevice")}</option>
            {adbDevices.length > 0 && <optgroup label="ADB">{adbDevices.map((device) => <option key={adbDeviceKey(device)} value={adbDeviceKey(device)}>{adbDeviceLabel(device)}</option>)}</optgroup>}
            {felDevices.length > 0 && <optgroup label="FEL">{felDevices.map((device) => <option key={device.id} value={device.id}>{efexDeviceLabel(device)}</option>)}</optgroup>}
          </select>
        </label>
      </div>

      {error && <div className="ui-alert-err">{error}</div>}

      {actions.length > 0 && (
        <section className="ui-card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select className="ui-select min-w-48 flex-1" value={action?.id ?? ""} onChange={(event) => {
              const next = actions.find((entry) => entry.id === event.target.value);
              setActionId(event.target.value);
              setInputs(initialValues(next?.inputs ?? []));
            }}>
              {actions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
            <button className="ui-btn-primary" disabled={!action || busy} onClick={() => action && request(() => runAction(action.id, inputs))}>
              <Play className="h-3.5 w-3.5" />{t("plugins.run")}
            </button>
          </div>
          {action?.description && <p className="text-xs text-slate-500 dark:text-slate-400">{action.description}</p>}
          {action?.inputs.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {action.inputs.map((field) => (
                <label key={field.id} className="space-y-1 text-xs">
                  <span className="font-medium">{field.label}{field.required ? " *" : ""}</span>
                  {field.description && <span className="block text-slate-500">{field.description}</span>}
                  <FieldInput field={field} value={inputs[field.id]} onChange={(value) => setInputs((previous) => ({ ...previous, [field.id]: value }))} />
                </label>
              ))}
            </div>
          ) : <p className="text-xs text-slate-500">{t("plugins.noInputs")}</p>}
        </section>
      )}

      {manifest.providers.length > 0 && (
        <section className="ui-card space-y-3 p-4">
          <div className="ui-card-header p-0">
            <h3 className="ui-title text-sm">{t("plugins.providers")}</h3>
            <button className="ui-btn-secondary" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />{t("common.refresh")}</button>
          </div>
          {manifest.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              manifestActions={manifest.actions}
              sessions={sessions}
              providerInputs={providerInputs[provider.id] ?? initialValues(manifest.actions.find((entry) => entry.id === provider.actions.connect)?.inputs ?? [])}
              providerCallInputs={providerCallInputs}
              busy={busy}
              onProviderInput={(providerId, key, value) => setProviderInputs((previous) => ({
                ...previous,
                [providerId]: { ...(previous[providerId] ?? {}), [key]: value },
              }))}
              onCallInput={(key, values) => setProviderCallInputs((previous) => ({ ...previous, [key]: values }))}
              onStart={() => void request(() => handleProviderStart(provider))}
              onStop={(sessionId) => void request(async () => {
                const stopped = await pluginRequest<PluginProviderSession>("provider_stop", { session_id: sessionId });
                setSessions((previous) => [stopped, ...previous.filter((entry) => entry.id !== stopped.id)].slice(0, 50));
              })}
              onCall={(sessionId, operation, values) => void request(() => handleProviderCall(sessionId, operation, values))}
            />
          ))}
        </section>
      )}

      <section className="ui-card overflow-hidden">
        <div className="ui-card-header">
          <h3 className="ui-title text-sm">{t("plugins.runHistory")}</h3>
          <button className="ui-btn-secondary" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />{t("common.refresh")}</button>
        </div>
        {runs.length === 0 ? <p className="p-4 text-xs text-slate-500">{t("plugins.noRuns")}</p> : (
          <div className="max-h-[55vh] space-y-2 overflow-auto p-3">
            {runs.map((run) => <RunCard key={run.id} run={run} action={manifest.actions.find((entry) => entry.id === run.action)} busy={busy} onConfirm={(pendingRun) => void request(() => pluginRequest("confirm", { run_id: pendingRun.id, token: pendingRun.confirmation?.token }))} onCancel={(runId) => void request(() => pluginRequest("cancel", { run_id: runId }))} />)}
          </div>
        )}
      </section>
    </div>
  );
}
