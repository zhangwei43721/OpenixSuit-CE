export type PluginFieldType = "text" | "file" | "select" | "boolean" | "number" | "json";

export interface PluginField {
  id: string;
  label: string;
  type: PluginFieldType;
  required?: boolean;
  default?: unknown;
  options?: string[];
  description?: string;
}

export interface PluginAction {
  id: string;
  label: string;
  description?: string;
  inputs: PluginField[];
  output?: PluginField[];
  entry: {
    kind: "javascript" | "process";
    file?: string;
    export?: string;
    program?: string;
    binding?: string;
    interpreter?: string;
    args?: string[];
    interpreter_args?: string[];
    protocol?: "ndjson" | "stdio";
    platforms?: Record<string, string>;
  };
  timeout_ms?: number;
}

export interface PluginPage {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  actions: string[];
}

export interface PluginProvider {
  id: string;
  label: string;
  kind: "log" | "device" | "power";
  actions: Record<string, string>;
  reconnect_ms?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  permissions: string[];
  settings: PluginField[];
  actions: PluginAction[];
  pages: PluginPage[];
  providers: PluginProvider[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  grants: string[];
  settings: Record<string, unknown>;
  bindings: Record<string, { program?: string; interpreter?: string }>;
  source?: string;
}

export interface PluginRun {
  id: string;
  plugin_id: string;
  action: string;
  origin: string;
  device?: string;
  status: "running" | "awaiting_confirmation" | "succeeded" | "failed" | "cancelled" | "timed_out";
  logs: string[];
  result?: unknown;
  error?: string;
  confirmation?: {
    token: string;
    capability: string;
    device?: string;
    summary: string;
    details: unknown;
  };
}

export interface PluginProviderSession {
  id: string;
  plugin_id: string;
  provider: string;
  status: string;
  logs: string[];
  error?: string;
}

export interface PluginTabItem {
  key: `ext:${string}`;
  pluginId: string;
  pageId?: string;
  label: string;
  icon?: string;
  plugin: InstalledPlugin;
  page?: PluginPage;
}

export function getExtensionTabs(plugins: InstalledPlugin[]): PluginTabItem[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    const pages = plugin.manifest.pages ?? [];
    if (pages.length) {
      return pages.map((page) => ({
        key: `ext:${plugin.manifest.id}:${page.id}` as const,
        pluginId: plugin.manifest.id,
        pageId: page.id,
        label: page.label || plugin.manifest.name,
        icon: page.icon || plugin.manifest.icon,
        plugin,
        page,
      }));
    }
    if (plugin.manifest.actions.length || plugin.manifest.providers.length) {
      return [{ key: `ext:${plugin.manifest.id}` as const, pluginId: plugin.manifest.id, label: plugin.manifest.name, icon: plugin.manifest.icon, plugin }];
    }
    return [];
  });
}
