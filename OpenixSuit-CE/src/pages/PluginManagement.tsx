import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, MoreHorizontal, Package, Puzzle, RefreshCw, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { InstalledPlugin, PluginField } from "../types/plugin";
import { ExtensionIcon } from "../components/ExtensionIcon";

interface Props {
  plugins: InstalledPlugin[];
  onRefresh: () => Promise<void>;
  onLog: (message: string) => void;
}

type BindingKind = "program" | "interpreter";
type Perform = (label: string, operation: () => Promise<unknown>) => Promise<boolean>;

const PACKAGE_FILTERS = [{ name: "Openix Plugin", extensions: ["oixplugin", "zip"] }];

function request<T>(action: string, args: Record<string, unknown>) {
  return invoke<T>("plugin_request", { action, args });
}

function bindingFields(plugin: InstalledPlugin) {
  const entries = new Map<string, Set<BindingKind>>();
  function add(key: string, kind: BindingKind) {
    const kinds = entries.get(key) ?? new Set();
    kinds.add(kind);
    entries.set(key, kinds);
  }
  for (const { entry } of plugin.manifest.actions) {
    if (entry.kind !== "process") continue;
    if (entry.binding) {
      add(entry.binding, "program");
      if (!entry.interpreter) add(entry.binding, "interpreter");
    }
    if (entry.interpreter) add(entry.interpreter, "interpreter");
  }
  return entries;
}

function SettingField({ field, value, onChange }: {
  field: PluginField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    return <input type="checkbox" className="accent-blue-600" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (field.type === "select") {
    return (
      <select className="ui-select w-full" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>{field.label}</option>
        {field.options?.map((option) => <option key={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === "json") {
    return (
      <textarea className="ui-input min-h-20 w-full font-mono" value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    );
  }
  return (
    <input className="ui-input w-full" type={field.type === "number" ? "number" : "text"}
      value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
  );
}

function InstalledCard({ plugin, busy, perform }: { plugin: InstalledPlugin; busy: boolean; perform: Perform }) {
  const { t } = useTranslation();
  const { manifest } = plugin;
  const [settingsDraft, setSettingsDraft] = useState<Record<string, unknown>>({});
  const [bindingDraft, setBindingDraft] = useState<InstalledPlugin["bindings"]>({});
  const [configured, setConfigured] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const configId = useId();
  const moreId = useId();
  const bindings = bindingFields(plugin);

  const configure = (config: Record<string, unknown>) =>
    perform(manifest.name, () => request("configure", { id: manifest.id, config }));
  const activationLabel = t(plugin.enabled ? "plugins.disable" : "plugins.enable");

  const setBinding = (key: string, kind: BindingKind, value: string) => {
    setBindingDraft((previous) => ({
      ...previous,
      [key]: { ...plugin.bindings[key], ...previous[key], [kind]: value },
    }));
  };

  const saveSettings = async () => {
    const saved = await perform(manifest.name, () => {
      const settings = { ...plugin.settings };
      for (const field of manifest.settings) {
        if (!Object.prototype.hasOwnProperty.call(settingsDraft, field.id)) continue;
        let value = settingsDraft[field.id];
        if (value === "") {
          delete settings[field.id];
          continue;
        }
        if (field.type === "json") {
          try {
            value = JSON.parse(String(value));
          } catch {
            throw new Error(t("plugins.invalidJson"));
          }
        } else if (field.type === "number") {
          value = Number(value);
        }
        settings[field.id] = value;
      }
      return request("configure", { id: manifest.id, config: { settings } });
    });
    if (saved) setSettingsDraft({});
  };

  const saveBindings = async () => {
    const updated: InstalledPlugin["bindings"] = {};
    for (const key of bindings.keys()) {
      const entry = bindingDraft[key] ?? plugin.bindings[key];
      if (!entry) continue;
      const program = entry.program?.trim() || undefined;
      const interpreter = entry.interpreter?.trim() || undefined;
      if (program || interpreter) updated[key] = { program, interpreter };
    }
    if (await configure({ bindings: updated })) setBindingDraft({});
  };

  return (
    <article className="min-w-0 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-2">
          <ExtensionIcon icon={manifest.icon} className="size-4 shrink-0 text-blue-500" />
          <strong className="min-w-0 truncate" title={manifest.name}>{manifest.name}</strong>
          <span className="max-w-20 truncate font-mono text-xs text-slate-500 dark:text-slate-400" title={manifest.version}>
            v{manifest.version}
          </span>
          <span role="status" className={"shrink-0 rounded px-1.5 py-0.5 text-xs font-medium " + (plugin.enabled
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
            {t(plugin.enabled ? "plugins.enabled" : "plugins.disabled")}
          </span>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-2">
          <button type="button" className={plugin.enabled ? "ui-btn-secondary" : "ui-btn-primary"}
            disabled={busy} aria-label={activationLabel + " " + manifest.name}
            onClick={() => void configure({ enabled: !plugin.enabled })}>
            {activationLabel}
          </button>
          <button type="button" className="ui-btn-secondary" aria-expanded={configured} aria-controls={configId}
            onClick={() => setConfigured((open) => !open)}>
            {t("plugins.configure")}
            <ChevronDown className={configured ? "size-3.5 rotate-180" : "size-3.5"} aria-hidden="true" />
          </button>
          <button type="button" className="ui-btn-secondary px-2" aria-expanded={showMore} aria-controls={moreId}
            aria-label={t("plugins.more")} title={t("plugins.more")}
            onClick={() => setShowMore((open) => !open)}>
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div id={moreId} hidden={!showMore}>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {plugin.source?.startsWith("github:") && (
            <button type="button" className="ui-btn-secondary" disabled={busy}
              onClick={() => void perform(manifest.name, () => request("update", { id: manifest.id }))}>
              <RefreshCw className="size-3.5" />{t("plugins.update")}
            </button>
          )}
          <button type="button" className="ui-btn-danger" disabled={busy}
            onClick={() => void perform(manifest.name, () => request("uninstall", { id: manifest.id }))}>
            <Trash2 className="size-3.5" />{t("plugins.uninstall")}
          </button>
        </div>
      </div>
      <div id={configId} hidden={!configured} className="mt-2 space-y-2 border-t border-slate-200 pt-2 dark:border-slate-800">
        <p className="break-all font-mono text-xs text-slate-500">{manifest.id}</p>
        {manifest.description && <p className="break-words text-xs text-slate-500">{manifest.description}</p>}
        {plugin.source && <p className="break-all font-mono text-xs text-slate-500">{plugin.source}</p>}
        <div className={manifest.settings.length ? "grid min-w-0 gap-3 lg:grid-cols-2" : "grid min-w-0"}>
          <section className="ui-subcard min-w-0 space-y-2 p-3">
            <h3 className="text-xs font-semibold">{t("plugins.permissions")}</h3>
            {manifest.permissions.length === 0 && <p className="text-xs text-slate-400">{t("plugins.noPermissions")}</p>}
            {manifest.permissions.map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-xs">
                <input type="checkbox" className="accent-blue-600" checked={plugin.grants.includes(permission)} disabled={busy}
                  onChange={(event) => {
                    const grants = event.target.checked
                      ? [...plugin.grants, permission]
                      : plugin.grants.filter((name) => name !== permission);
                    void configure({ grants });
                  }} />
                <code className="min-w-0 break-all">{permission}</code>
              </label>
            ))}
          </section>

          {manifest.settings.length > 0 && (
            <section className="ui-subcard min-w-0 space-y-3 p-3">
              <h3 className="text-xs font-semibold">{t("plugins.pluginSettings")}</h3>
              {manifest.settings.map((field) => {
                const current = plugin.settings[field.id] ?? field.default;
                const value = settingsDraft[field.id] ?? (field.type === "json" ? JSON.stringify(current ?? {}, null, 2) : current);
                return (
                  <label key={field.id} className="block space-y-1 text-xs">
                    <span>{field.label}</span>
                    {field.description && <span className="block text-slate-500">{field.description}</span>}
                    <SettingField field={field} value={value}
                      onChange={(next) => setSettingsDraft((draft) => ({ ...draft, [field.id]: next }))} />
                  </label>
                );
              })}
              <button className="ui-btn-secondary" disabled={busy || Object.keys(settingsDraft).length === 0}
                onClick={() => void saveSettings()}>{t("common.save")}</button>
            </section>
          )}
        </div>

        {bindings.size > 0 && (
          <section className="ui-subcard min-w-0 space-y-2 p-3">
            <h3 className="text-xs font-semibold">{t("plugins.processBindings")}</h3>
            {[...bindings.entries()].map(([key, kinds]) => (
              <div key={key} className="grid items-start gap-2 sm:grid-cols-[minmax(6rem,1fr)_minmax(0,3fr)]">
                <code className="break-all text-xs">{key}</code>
                <div className="grid min-w-0 gap-2">
                  {[...kinds].map((kind) => {
                    const label = t(kind === "program" ? "plugins.programPlaceholder" : "plugins.interpreterPlaceholder");
                    const value = (bindingDraft[key] ?? plugin.bindings[key])?.[kind] ?? "";
                    return (
                      <div key={kind} className="flex min-w-0 gap-2">
                        <input className="ui-input min-w-0 flex-1 font-mono text-xs" aria-label={label}
                          placeholder={label} value={value} onChange={(event) => setBinding(key, kind, event.target.value)} />
                        <button className="ui-btn-secondary" disabled={busy} title={label}
                          onClick={() => void perform(label, async () => {
                            const selected = await open({ multiple: false });
                            if (typeof selected === "string") setBinding(key, kind, selected);
                          })}>
                          <FolderOpen className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <button className="ui-btn-secondary" disabled={busy || Object.keys(bindingDraft).length === 0}
              onClick={() => void saveBindings()}>{t("common.save")}</button>
          </section>
        )}
      </div>
    </article>
  );
}

export function PluginManagement({ plugins, onRefresh, onLog }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const [repo, setRepo] = useState("");
  const [validation, setValidation] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const installId = useId();

  const perform: Perform = async (label, operation) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await onRefresh();
      onLog(label);
      return true;
    } catch (cause) {
      setError(String(cause));
      onLog(label + " · " + String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseSource = async (directory: boolean) => {
    try {
      const selected = await open({ directory, multiple: false, filters: directory ? undefined : PACKAGE_FILTERS });
      if (typeof selected === "string") {
        setPath(selected);
        setValidation(null);
      }
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <section className="ui-card min-w-0 divide-y divide-slate-200 text-sm dark:divide-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <h2 className="flex items-center gap-2 font-medium">
          <Puzzle className="size-3.5 shrink-0 text-blue-500" />{t("plugins.settingsTitle")}
        </h2>
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" className="ui-btn-secondary" aria-expanded={adding} aria-controls={installId}
            onClick={() => setAdding((open) => !open)}>
            <Upload className="size-3.5" />{t(adding ? "settings.collapseDetails" : "plugins.add")}
          </button>
          <button type="button" className="ui-btn-secondary px-2" aria-label={t("common.refresh")}
            title={t("common.refresh")} disabled={busy} onClick={() => void onRefresh()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && <div className="px-3 py-2"><div className="ui-alert-err block break-all" role="alert">{error}</div></div>}
      <div id={installId} hidden={!adding} className="min-w-0 space-y-2 px-3 py-2">
        <div className="flex flex-wrap gap-2">
          <input className="ui-input min-w-0 flex-[1_1_10rem] font-mono text-xs" value={path}
            placeholder={t("plugins.pathPlaceholder")}
            onChange={(event) => { setPath(event.target.value); setValidation(null); }} />
          <button className="ui-btn-secondary" disabled={busy} onClick={() => void chooseSource(true)}>
            <FolderOpen className="h-3.5 w-3.5" />{t("plugins.chooseSource")}
          </button>
          <button className="ui-btn-secondary" disabled={busy} onClick={() => void chooseSource(false)}>
            <Upload className="h-3.5 w-3.5" />{t("plugins.choosePackage")}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="ui-btn-secondary" disabled={busy || !path}
            onClick={() => void perform(t("plugins.validate"), async () => setValidation(await request("validate", { path })))}>
            {t("plugins.validate")}
          </button>
          <button className="ui-btn-primary" disabled={busy || !path}
            onClick={() => void perform(t("plugins.install"), () => request("install", { path }))}>
            <Upload className="h-3.5 w-3.5" />{t("plugins.install")}
          </button>
          <button className="ui-btn-secondary" disabled={busy || !path}
            onClick={() => void perform(t("plugins.pack"), async () => {
              const output = await save({ defaultPath: "plugin.oixplugin", filters: PACKAGE_FILTERS });
              if (output) await request("pack", { path, output });
            })}>
            <Package className="h-3.5 w-3.5" />{t("plugins.pack")}
          </button>
        </div>
        {validation !== null && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 font-mono text-[10px] text-slate-200">
            {JSON.stringify(validation, null, 2)}
          </pre>
        )}
        <div className="flex min-w-0 flex-wrap gap-2 border-t border-slate-200 pt-2 dark:border-slate-800">
          <input className="ui-input min-w-0 flex-[1_1_10rem] font-mono text-xs" value={repo}
            placeholder={t("plugins.githubPlaceholder")} onChange={(event) => setRepo(event.target.value)} />
          <button className="ui-btn-primary" disabled={busy || !repo.trim()}
            onClick={() => void perform(t("plugins.installGithub"), () => request("install_github", { repo: repo.trim() }))}>
            <Upload className="h-3.5 w-3.5" />{t("plugins.installGithub")}
          </button>
        </div>
      </div>
      {plugins.length === 0 && (
        <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{t("plugins.noPlugins")}</p>
      )}
      {plugins.map((plugin) => (
        <InstalledCard key={plugin.manifest.id + "@" + plugin.manifest.version} plugin={plugin} busy={busy} perform={perform} />
      ))}
    </section>
  );
}
