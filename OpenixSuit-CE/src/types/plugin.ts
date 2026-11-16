export interface PluginFileFilter {
  name: string;
  extensions: string[];
}

export interface PluginInput {
  id?: string;
  name?: string;
  label?: string;
  type?: "file" | "text" | "select" | "boolean";
  kind?: "file" | "text" | "select" | "boolean";
  required?: boolean;
  default?: string | boolean;
  placeholder?: string;
  description?: string;
  options?: Array<string | { label?: string; value: string }>;
  filters?: Array<string | PluginFileFilter>;
  extensions?: string[];
}

export interface PluginTabSpec {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  inputs?: PluginInput[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  icon?: string;
  description?: string;
  author?: string;
  inputs?: PluginInput[];
  tabs?: PluginTabSpec[];
}

export interface ExtensionTabItem {
  key: `ext:${string}`;
  pluginId: string;
  tabId?: string;
  label: string;
  icon?: string;
  plugin: PluginManifest;
  tab?: PluginTabSpec;
}

export function getExtensionTabs(plugins: PluginManifest[]): ExtensionTabItem[] {
  const items: ExtensionTabItem[] = [];
  for (const plugin of plugins) {
    const tabs = Array.isArray(plugin.tabs) ? plugin.tabs : [];
    if (tabs.length > 0) {
      for (const tab of tabs) {
        items.push({
          key: `ext:${plugin.id}:${tab.id}`,
          pluginId: plugin.id,
          tabId: tab.id,
          label: tab.label || plugin.name,
          icon: tab.icon || plugin.icon,
          plugin,
          tab,
        });
      }
    } else {
      items.push({
        key: `ext:${plugin.id}`,
        pluginId: plugin.id,
        label: plugin.name,
        icon: plugin.icon,
        plugin,
      });
    }
  }
  return items;
}
