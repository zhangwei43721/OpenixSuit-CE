import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FileUp, Play, Terminal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ExtensionTabItem, PluginFileFilter, PluginInput } from "../types/plugin";
import { ExtensionIcon } from "../components/ExtensionIcon";

interface PluginRunnerProps {
  item: ExtensionTabItem;
  serial: string;
  onLog: (msg: string) => void;
}

interface PluginLogPayload {
  plugin_id: string;
  line: string;
}

function getInputKey(field: PluginInput): string {
  return field.id || field.name || "";
}

function getInputLabel(field: PluginInput): string {
  return field.label || field.name || field.id || "";
}

function getInputType(field: PluginInput): "file" | "text" | "select" | "boolean" {
  const raw = field.type ?? field.kind;
  if (raw === "file" || raw === "select" || raw === "boolean") return raw;
  return "text";
}

function normalizeOptions(
  options?: Array<string | { label?: string; value: string }>
): Array<{ label: string; value: string }> {
  if (!Array.isArray(options)) return [];
  return options.map((opt) =>
    typeof opt === "string"
      ? { label: opt, value: opt }
      : { label: opt.label || opt.value, value: opt.value }
  );
}

function normalizeFilters(field: PluginInput): PluginFileFilter[] | undefined {
  if (Array.isArray(field.filters) && field.filters.length > 0) {
    if (typeof field.filters[0] === "string") {
      const exts = (field.filters as string[])
        .map((e) => e.replace(/^\./, "").trim())
        .filter(Boolean);
      return exts.length > 0 ? [{ name: getInputLabel(field) || "File", extensions: exts }] : undefined;
    }
    return field.filters as PluginFileFilter[];
  }
  if (Array.isArray(field.extensions) && field.extensions.length > 0) {
    return [{ name: getInputLabel(field) || "File", extensions: field.extensions }];
  }
  return undefined;
}

function buildDefaults(inputs: PluginInput[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of inputs) {
    const key = getInputKey(field);
    if (!key) continue;
    const fType = getInputType(field);
    if (fType === "boolean") {
      out[key] =
        typeof field.default === "boolean"
          ? field.default
          : String(field.default ?? "").toLowerCase() === "true";
    } else if (fType === "select") {
      const opts = normalizeOptions(field.options);
      out[key] =
        field.default !== undefined ? String(field.default) : opts[0]?.value ?? "";
    } else {
      out[key] = field.default !== undefined ? String(field.default) : "";
    }
  }
  return out;
}

export function PluginRunner({ item, serial, onLog }: PluginRunnerProps) {
  const { t } = useTranslation();
  const inputSpecs = useMemo(
    () => item.tab?.inputs ?? item.plugin.inputs ?? [],
    [item]
  );

  const [formValues, setFormValues] = useState<Record<string, string | boolean>>(() =>
    buildDefaults(inputSpecs)
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFormValues((prev) => {
      const defaults = buildDefaults(inputSpecs);
      const merged: Record<string, string | boolean> = { ...defaults };
      for (const key of Object.keys(defaults)) {
        if (prev[key] !== undefined && prev[key] !== "") {
          merged[key] = prev[key];
        }
      }
      return merged;
    });
  }, [inputSpecs]);

  useEffect(() => {
    const unlisten = listen<PluginLogPayload>("plugin-log", (event) => {
      const { plugin_id, line } = event.payload;
      if (plugin_id === item.pluginId) {
        const time = new Date().toLocaleTimeString();
        setLogs((prev) => [...prev.slice(-499), `[${time}] ${line}`]);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [item.pluginId]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs.length]);

  const setFieldValue = (key: string, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  };

  const browseInputFile = async (field: PluginInput) => {
    try {
      const filters = normalizeFilters(field);
      const file = await open(filters ? { filters } : undefined);
      if (typeof file === "string") {
        setFieldValue(getInputKey(field), file);
      }
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setErrorMsg(null);
    const title = item.tab ? `${item.plugin.name} / ${item.tab.label}` : item.plugin.name;
    onLog(`运行拓展 [${title}]`);
    try {
      const res = await invoke<string[] | string | void>("run_plugin", {
        pluginId: item.pluginId,
        tabId: item.tabId ?? null,
        serial,
        inputs: formValues,
      });
      if (typeof res === "string" && res) {
        const time = new Date().toLocaleTimeString();
        setLogs((prev) => [...prev.slice(-499), `[${time}] ${res}`]);
      }
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      const time = new Date().toLocaleTimeString();
      setLogs((prev) => [...prev.slice(-499), `[${time}] ERROR: ${msg}`]);
      onLog(`拓展运行失败 [${title}]: ${msg}`);
    } finally {
      setRunning(false);
    }
  };

  const title = item.tab ? item.tab.label : item.plugin.name;
  const description = item.tab?.description || item.plugin.description;

  return (
    <div className="flex h-full flex-col space-y-4">
      <div className="ui-toolbar items-start py-3 sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <ExtensionIcon icon={item.icon} className="h-5 w-5 shrink-0 text-blue-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            <span className="rounded-md bg-blue-600/15 px-2 py-0.5 font-mono text-[11px] font-medium text-blue-600 dark:text-blue-400">
              {item.plugin.name} v{item.plugin.version}
            </span>
          </div>
          {description && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {description}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>{t("plugins.targetDevice")}:</span>
          <code className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono tabular-nums text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {serial || t("plugins.noDevice")}
          </code>
        </div>
      </div>

      {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}

      <div className="ui-card overflow-hidden p-4">
        {inputSpecs.length === 0 ? (
          <div className="ui-subcard border-dashed p-4 text-center text-xs text-slate-400">
            {t("plugins.noInputs")}
          </div>
        ) : (
          <div className="space-y-3.5">
            {inputSpecs.map((field) => {
              const key = getInputKey(field);
              const label = getInputLabel(field);
              const fType = getInputType(field);
              const val = formValues[key];
              const options = normalizeOptions(field.options);

              return (
                <div key={key} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                    <span>{label}</span>
                    {field.required && <span className="text-rose-500">*</span>}
                    <span className="font-mono text-[11px] font-normal text-slate-400">
                      ({key})
                    </span>
                  </div>
                  {field.description && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {field.description}
                    </div>
                  )}

                  {fType === "file" && (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={typeof val === "string" ? val : ""}
                        onChange={(e) => setFieldValue(key, e.target.value)}
                        placeholder={field.placeholder || t("plugins.selectFile")}
                        className="ui-input flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => browseInputFile(field)}
                        className="ui-btn-secondary shrink-0"
                      >
                        <FileUp className="h-3.5 w-3.5" />
                        {t("common.browse")}
                      </button>
                    </div>
                  )}

                  {fType === "text" && (
                    <input
                      type="text"
                      value={typeof val === "string" ? val : ""}
                      onChange={(e) => setFieldValue(key, e.target.value)}
                      placeholder={field.placeholder || ""}
                      className="ui-input w-full"
                    />
                  )}

                  {fType === "select" && (
                    <select
                      value={typeof val === "string" ? val : ""}
                      onChange={(e) => setFieldValue(key, e.target.value)}
                      className="ui-select w-full"
                    >
                      {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  )}

                  {fType === "boolean" && (
                    <label className="ui-subcard inline-flex w-fit cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={Boolean(val)}
                        onChange={(e) => setFieldValue(key, e.target.checked)}
                        className="h-4 w-4 accent-blue-600"
                      />
                      <span className="font-mono text-[11px]">{Boolean(val) ? "ON" : "OFF"}</span>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex justify-end border-t border-slate-200 pt-3 dark:border-slate-800">
          <button
            type="button"
            disabled={running}
            onClick={handleRun}
            className="ui-btn-success px-4 py-2"
          >
            <Play className="h-3.5 w-3.5" />
            {running ? t("plugins.running") : t("plugins.run")}
          </button>
        </div>
      </div>

      <div className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="ui-card-header">
          <span className="ui-title">
            <Terminal className="h-4 w-4 text-blue-500" />
            <span>{t("plugins.logs")}</span>
          </span>
          {logs.length > 0 && (
            <button
              type="button"
              onClick={() => setLogs([])}
              className="ui-btn-secondary px-2 py-1 text-[11px]"
            >
              <Trash2 className="h-3 w-3" />
              {t("log.clear")}
            </button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <div
            ref={logBoxRef}
            className="ui-terminal min-h-[160px] flex-1 overflow-auto p-3"
          >
            {logs.length === 0 ? (
              <span className="text-slate-500">{t("log.empty")}</span>
            ) : (
              logs.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all leading-5">
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
