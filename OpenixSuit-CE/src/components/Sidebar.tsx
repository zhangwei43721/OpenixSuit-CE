import { useTranslation } from "react-i18next";
import {
  Cpu,
  Download,
  FolderSync,
  Settings,
  Terminal,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

export type TabKey = "firmware" | "debugger" | "adb" | "gpio" | "settings";

interface SidebarProps {
  activeTab: TabKey;
  collapsed: boolean;
  locked: boolean;
  onSelect: (tab: TabKey) => void;
  onToggleCollapse: () => void;
}

export function Sidebar({
  activeTab,
  collapsed,
  locked,
  onSelect,
  onToggleCollapse,
}: SidebarProps) {
  const { t } = useTranslation();

  const items: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: "firmware", label: t("nav.flash"), icon: <Download className="h-4 w-4 shrink-0" /> },
    { key: "debugger", label: t("nav.debugger"), icon: <Terminal className="h-4 w-4 shrink-0" /> },
    { key: "adb", label: t("nav.adb"), icon: <FolderSync className="h-4 w-4 shrink-0" /> },
    { key: "gpio", label: t("nav.gpio"), icon: <Cpu className="h-4 w-4 shrink-0" /> },
  ];

  return (
    <aside
      style={{ width: collapsed ? 60 : 210 }}
      className="flex shrink-0 flex-col border-r border-slate-200 bg-slate-50 transition-all dark:border-slate-800 dark:bg-slate-900"
    >
      <button
        disabled={locked}
        onClick={onToggleCollapse}
        className="flex items-center gap-2 border-b border-slate-200 p-3 text-xs text-slate-500 hover:text-slate-900 disabled:opacity-50 dark:border-slate-800 dark:text-slate-400 dark:hover:text-white"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        {!collapsed && <span>{t("nav.collapse")}</span>}
      </button>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {items.map((item) => (
          <button
            key={item.key}
            disabled={locked}
            onClick={() => onSelect(item.key)}
            className={`flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm disabled:opacity-50 ${
              activeTab === item.key
                ? "bg-blue-600 text-white"
                : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {item.icon}
            {!collapsed && <span className="truncate">{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className="border-t border-slate-200 p-2 dark:border-slate-800">
        <button
          disabled={locked}
          onClick={() => onSelect("settings")}
          className={`flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm disabled:opacity-50 ${
            activeTab === "settings"
              ? "bg-blue-600 text-white"
              : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">{t("nav.settings")}</span>}
        </button>
      </div>
    </aside>
  );
}
