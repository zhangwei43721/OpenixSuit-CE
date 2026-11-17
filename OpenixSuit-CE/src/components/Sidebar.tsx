import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  Cable,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  FolderSync,
  GripVertical,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Smartphone,
  SquareTerminal,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { ExtensionTabItem } from "../types/plugin";
import { ExtensionIcon } from "./ExtensionIcon";
import { DeviceWorkspace } from "../types/workbench";

export type CoreTabKey =
  | "firmware"
  | "serial"
  | "debugger"
  | "adb"
  | "adb-term"
  | "monitor"
  | "screen"
  | "gpio"
  | "automation"
  | "ai"
  | "settings";
export type TabKey = CoreTabKey | `ext:${string}`;

type GroupId = "firmware" | "debug" | "automation";

interface SidebarLayoutConfig {
  groupOrder: GroupId[];
  itemOrder: Record<GroupId, CoreTabKey[]>;
  collapsedGroups: Record<string, boolean>;
  uncommonItems: CoreTabKey[];
}

const SIDEBAR_LAYOUT_STORAGE_KEY = "openix_sidebar_layout_v1";

const DEFAULT_GROUP_ORDER: GroupId[] = ["firmware", "debug", "automation"];

const DEFAULT_ITEM_ORDER: Record<GroupId, CoreTabKey[]> = {
  firmware: ["firmware", "debugger", "gpio"],
  debug: ["monitor", "serial", "adb-term", "adb", "screen"],
  automation: ["automation", "ai"],
};

function getDefaultLayout(): SidebarLayoutConfig {
  return {
    groupOrder: [...DEFAULT_GROUP_ORDER],
    itemOrder: {
      firmware: [...DEFAULT_ITEM_ORDER.firmware],
      debug: [...DEFAULT_ITEM_ORDER.debug],
      automation: [...DEFAULT_ITEM_ORDER.automation],
    },
    collapsedGroups: { uncommon: true },
    uncommonItems: [],
  };
}

function mergeOrder<T extends string>(saved: unknown, defaults: T[]): T[] {
  const arr = Array.isArray(saved) ? saved.filter((x): x is T => defaults.includes(x as T)) : [];
  const unique = Array.from(new Set(arr));
  for (const item of defaults) {
    if (!unique.includes(item)) unique.push(item);
  }
  return unique;
}

function loadSidebarLayout(): SidebarLayoutConfig {
  const def = getDefaultLayout();
  try {
    const raw = localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<SidebarLayoutConfig>;
    const allNavKeys = [
      ...DEFAULT_ITEM_ORDER.firmware,
      ...DEFAULT_ITEM_ORDER.debug,
      ...DEFAULT_ITEM_ORDER.automation,
    ];
    const uncommonItems = Array.isArray(parsed.uncommonItems)
      ? Array.from(
          new Set(parsed.uncommonItems.filter((k): k is CoreTabKey => allNavKeys.includes(k)))
        )
      : [];

    return {
      groupOrder: mergeOrder(parsed.groupOrder, DEFAULT_GROUP_ORDER),
      itemOrder: {
        firmware: mergeOrder(parsed.itemOrder?.firmware, DEFAULT_ITEM_ORDER.firmware),
        debug: mergeOrder(parsed.itemOrder?.debug, DEFAULT_ITEM_ORDER.debug),
        automation: mergeOrder(parsed.itemOrder?.automation, DEFAULT_ITEM_ORDER.automation),
      },
      collapsedGroups:
        parsed.collapsedGroups && typeof parsed.collapsedGroups === "object"
          ? { uncommon: true, ...parsed.collapsedGroups }
          : { uncommon: true },
      uncommonItems,
    };
  } catch {
    return def;
  }
}

function reorderList<T>(list: T[], fromIdx: number, toIdx: number): T[] {
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

interface SidebarProps {
  activeTab: TabKey;
  collapsed: boolean;
  locked: boolean;
  extensionTabs: ExtensionTabItem[];
  workspaces: DeviceWorkspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string | null) => void;
  onAddWorkspace: () => void;
  onEditWorkspace: (ws: DeviceWorkspace) => void;
  onDeleteWorkspace: (id: string) => void;
  onSelect: (tab: TabKey) => void;
  onToggleCollapse: () => void;
}

export function Sidebar({
  activeTab,
  collapsed,
  locked,
  extensionTabs,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onEditWorkspace,
  onDeleteWorkspace,
  onSelect,
  onToggleCollapse,
}: SidebarProps) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<SidebarLayoutConfig>(() => loadSidebarLayout());
  const [editingOrder, setEditingOrder] = useState(false);
  const [activeDrag, setActiveDrag] = useState<
    | { kind: "group"; groupId: GroupId }
    | { kind: "item"; groupId: GroupId | "uncommon"; key: CoreTabKey }
    | null
  >(null);

  useEffect(() => {
    if (!activeDrag) return;
    const onPointerMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;

      if (activeDrag.kind === "group") {
        const targetGroup = (el.closest("[data-sidebar-group]") as HTMLElement | null)?.dataset
          .sidebarGroup as GroupId | undefined;
        if (targetGroup && targetGroup !== activeDrag.groupId) {
          setLayout((prev) => {
            const fromIdx = prev.groupOrder.indexOf(activeDrag.groupId);
            const toIdx = prev.groupOrder.indexOf(targetGroup);
            if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
            return { ...prev, groupOrder: reorderList(prev.groupOrder, fromIdx, toIdx) };
          });
        }
        return;
      }

      const row = el.closest("[data-sidebar-item]") as HTMLElement | null;
      const targetGroup = row?.dataset.sidebarItemGroup;
      const targetKey = row?.dataset.sidebarItemKey as CoreTabKey | undefined;
      if (!row || targetGroup !== activeDrag.groupId || !targetKey || targetKey === activeDrag.key) {
        return;
      }

      setLayout((prev) => {
        if (activeDrag.groupId === "uncommon") {
          const fromIdx = prev.uncommonItems.indexOf(activeDrag.key);
          const toIdx = prev.uncommonItems.indexOf(targetKey);
          if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
          return { ...prev, uncommonItems: reorderList(prev.uncommonItems, fromIdx, toIdx) };
        }
        const raw = prev.itemOrder[activeDrag.groupId];
        const fromIdx = raw.indexOf(activeDrag.key);
        const toIdx = raw.indexOf(targetKey);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
        return {
          ...prev,
          itemOrder: {
            ...prev.itemOrder,
            [activeDrag.groupId]: reorderList(raw, fromIdx, toIdx),
          },
        };
      });
    };

    const stopDrag = () => setActiveDrag(null);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [activeDrag]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignore quota errors
    }
  }, [layout]);

  const itemMeta = useMemo<
    Record<Exclude<CoreTabKey, "settings">, { label: string; icon: React.ReactNode; defaultGroup: GroupId }>
  >(
    () => ({
      firmware: {
        label: t("nav.flash"),
        icon: <Download className="h-4 w-4 shrink-0" />,
        defaultGroup: "firmware",
      },
      debugger: {
        label: t("nav.debugger"),
        icon: <Terminal className="h-4 w-4 shrink-0" />,
        defaultGroup: "firmware",
      },
      gpio: {
        label: t("nav.gpio"),
        icon: <Cpu className="h-4 w-4 shrink-0" />,
        defaultGroup: "firmware",
      },
      monitor: {
        label: t("nav.monitor"),
        icon: <Activity className="h-4 w-4 shrink-0" />,
        defaultGroup: "debug",
      },
      serial: {
        label: t("nav.serial"),
        icon: <Cable className="h-4 w-4 shrink-0" />,
        defaultGroup: "debug",
      },
      "adb-term": {
        label: t("nav.adbTerm"),
        icon: <SquareTerminal className="h-4 w-4 shrink-0" />,
        defaultGroup: "debug",
      },
      adb: {
        label: t("nav.adb"),
        icon: <FolderSync className="h-4 w-4 shrink-0" />,
        defaultGroup: "debug",
      },
      screen: {
        label: t("nav.screen"),
        icon: <Smartphone className="h-4 w-4 shrink-0" />,
        defaultGroup: "debug",
      },
      automation: {
        label: t("nav.automation"),
        icon: <Zap className="h-4 w-4 shrink-0" />,
        defaultGroup: "automation",
      },
      ai: {
        label: t("nav.ai"),
        icon: <Bot className="h-4 w-4 shrink-0" />,
        defaultGroup: "automation",
      },
    }),
    [t]
  );

  const groupTitles: Record<GroupId, string> = {
    firmware: t("nav.groupFirmware"),
    debug: t("nav.groupDebug"),
    automation: t("nav.groupAutomation"),
  };

  const toggleGroupCollapsed = (groupId: string) => {
    setLayout((prev) => ({
      ...prev,
      collapsedGroups: {
        ...prev.collapsedGroups,
        [groupId]: !prev.collapsedGroups[groupId],
      },
    }));
  };

  const moveGroup = (groupId: GroupId, dir: -1 | 1) => {
    setLayout((prev) => {
      const idx = prev.groupOrder.indexOf(groupId);
      const nextOrder = reorderList(prev.groupOrder, idx, idx + dir);
      return { ...prev, groupOrder: nextOrder };
    });
  };

  const moveItem = (groupId: GroupId | "uncommon", key: CoreTabKey, dir: -1 | 1) => {
    setLayout((prev) => {
      if (groupId === "uncommon") {
        const idx = prev.uncommonItems.indexOf(key);
        return {
          ...prev,
          uncommonItems: reorderList(prev.uncommonItems, idx, idx + dir),
        };
      }
      const currentVisible = prev.itemOrder[groupId].filter((k) => !prev.uncommonItems.includes(k));
      const visIdx = currentVisible.indexOf(key);
      const targetKey = currentVisible[visIdx + dir];
      if (!targetKey) return prev;
      const raw = [...prev.itemOrder[groupId]];
      const a = raw.indexOf(key);
      const b = raw.indexOf(targetKey);
      if (a < 0 || b < 0) return prev;
      [raw[a], raw[b]] = [raw[b], raw[a]];
      return {
        ...prev,
        itemOrder: {
          ...prev.itemOrder,
          [groupId]: raw,
        },
      };
    });
  };

  const foldToUncommon = (key: CoreTabKey) => {
    setLayout((prev) => {
      if (prev.uncommonItems.includes(key)) return prev;
      return {
        ...prev,
        uncommonItems: [...prev.uncommonItems, key],
      };
    });
  };

  const restoreFromUncommon = (key: CoreTabKey) => {
    setLayout((prev) => ({
      ...prev,
      uncommonItems: prev.uncommonItems.filter((k) => k !== key),
    }));
  };

  const resetLayout = () => {
    setLayout(getDefaultLayout());
  };

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const showEditMode = editingOrder && !collapsed;

  return (
    <aside
      style={{ width: collapsed ? 60 : 226 }}
      className="flex shrink-0 flex-col border-r border-slate-200 bg-slate-50 transition-all dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-2.5 py-2.5 dark:border-slate-800">
        <button
          disabled={locked}
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-slate-500 hover:text-slate-900 disabled:opacity-50 dark:text-slate-400 dark:hover:text-white"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && <span>{t("nav.collapse")}</span>}
        </button>

        {!collapsed && (
          <div className="flex items-center gap-1">
            {showEditMode && (
              <button
                type="button"
                disabled={locked}
                onClick={resetLayout}
                title={t("nav.resetOrder")}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              disabled={locked}
              onClick={() => setEditingOrder((v) => !v)}
              title={showEditMode ? t("nav.doneEditing") : t("nav.customizeOrder")}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition disabled:opacity-50 ${
                showEditMode
                  ? "bg-blue-600 text-white"
                  : "text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
              }`}
            >
              {showEditMode ? <Check className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3" />}
              <span>{showEditMode ? t("nav.doneEditing") : t("nav.customizeOrder")}</span>
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="space-y-1.5 border-b border-slate-200 p-2.5 text-xs dark:border-slate-800">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span>{t("nav.workspaces")}</span>
            <button
              type="button"
              disabled={locked}
              onClick={onAddWorkspace}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
              title={t("nav.addDevice")}
            >
              <Plus className="h-3 w-3" />
              {t("nav.addDevice")}
            </button>
          </div>
          <div className="flex items-center gap-1">
            <select
              disabled={locked}
              value={activeWorkspaceId || ""}
              onChange={(e) => onSelectWorkspace(e.target.value || null)}
              className="ui-select min-w-0 flex-1 py-1"
            >
              <option value="">{t("nav.globalDefault")}</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.chip})
                </option>
              ))}
            </select>
            {activeWs && (
              <>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onEditWorkspace(activeWs)}
                  className="rounded-md p-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => onDeleteWorkspace(activeWs.id)}
                  className="rounded-md p-1 text-slate-400 hover:bg-rose-500/10 hover:text-rose-500"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <nav className="flex-1 overflow-y-auto p-2">
        {layout.groupOrder.map((groupId, gIdx) => {
          const visibleKeys = layout.itemOrder[groupId].filter(
            (k) => !layout.uncommonItems.includes(k)
          );
          if (visibleKeys.length === 0 && !showEditMode) return null;
          const isGroupCollapsed = Boolean(layout.collapsedGroups[groupId]) && !showEditMode;

          return (
            <div
              key={groupId}
              data-sidebar-group={groupId}
              className={
                gIdx > 0 ? "mt-2.5 border-t border-slate-200 pt-2.5 dark:border-slate-800" : ""
              }
            >
              {!collapsed && (
                <div className="mb-1 flex items-center justify-between px-2">
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      if (!showEditMode || e.button !== 0) return;
                      e.preventDefault();
                      setActiveDrag({ kind: "group", groupId });
                    }}
                    onClick={() => !showEditMode && toggleGroupCollapsed(groupId)}
                    className={`flex flex-1 select-none items-center gap-1 rounded-md px-1 py-0.5 text-left text-[11px] font-medium uppercase tracking-wider transition ${
                      activeDrag?.kind === "group" && activeDrag.groupId === groupId
                        ? "cursor-grabbing text-blue-600 dark:text-blue-400"
                        : showEditMode
                        ? "cursor-grab text-slate-600 dark:text-slate-300"
                        : "text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300"
                    }`}
                  >
                    {showEditMode ? (
                      <GripVertical className="h-3 w-3 shrink-0 text-slate-400" />
                    ) : isGroupCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    <span className="truncate">{groupTitles[groupId]}</span>
                    {isGroupCollapsed && (
                      <span className="ml-auto rounded-md bg-slate-200/80 px-1 text-[10px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        {visibleKeys.length}
                      </span>
                    )}
                  </button>

                  {showEditMode && (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        disabled={gIdx === 0}
                        onClick={() => moveGroup(groupId, -1)}
                        title={t("nav.moveUp")}
                        className="rounded-md p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        disabled={gIdx === layout.groupOrder.length - 1}
                        onClick={() => moveGroup(groupId, 1)}
                        title={t("nav.moveDown")}
                        className="rounded-md p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {(!isGroupCollapsed || collapsed) && (
                <div className="space-y-1">
                  {visibleKeys.map((key, idx) => {
                    const meta = itemMeta[key as Exclude<CoreTabKey, "settings">];
                    if (!meta) return null;
                    const isDraggingThis =
                      activeDrag?.kind === "item" &&
                      activeDrag.groupId === groupId &&
                      activeDrag.key === key;
                    return (
                      <div
                        key={key}
                        data-sidebar-item="true"
                        data-sidebar-item-group={groupId}
                        data-sidebar-item-key={key}
                        className={`flex items-center gap-1 rounded-lg ${
                          isDraggingThis ? "bg-blue-500/10 ring-2 ring-blue-500/40" : ""
                        }`}
                      >
                        <button
                          disabled={locked}
                          title={collapsed ? meta.label : undefined}
                          onPointerDown={(e) => {
                            if (!showEditMode || e.button !== 0) return;
                            e.preventDefault();
                            setActiveDrag({ kind: "item", groupId, key });
                          }}
                          onClick={() => !showEditMode && onSelect(key)}
                          className={`flex min-w-0 flex-1 select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                            isDraggingThis
                              ? "cursor-grabbing text-blue-600 dark:text-blue-400"
                              : showEditMode
                              ? "cursor-grab text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                              : activeTab === key
                              ? "bg-blue-600 text-white shadow-sm"
                              : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                          }`}
                        >
                          {showEditMode && <GripVertical className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                          {meta.icon}
                          {!collapsed && <span className="truncate">{meta.label}</span>}
                        </button>

                        {showEditMode && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveItem(groupId, key, -1)}
                              title={t("nav.moveUp")}
                              className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === visibleKeys.length - 1}
                              onClick={() => moveItem(groupId, key, 1)}
                              title={t("nav.moveDown")}
                              className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => foldToUncommon(key)}
                              title={t("nav.foldItem")}
                              className="rounded-md p-1 text-slate-400 hover:bg-amber-500/15 hover:text-amber-600 dark:hover:text-amber-400"
                            >
                              <Archive className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {visibleKeys.length === 0 && showEditMode && (
                    <div className="rounded-md border border-dashed border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-400 dark:border-slate-800">
                      —
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {layout.uncommonItems.length > 0 && (
          <div className="mt-2.5 border-t border-slate-200 pt-2.5 dark:border-slate-800">
            {!collapsed && (
              <button
                type="button"
                onClick={() => toggleGroupCollapsed("uncommon")}
                className="mb-1 flex w-full items-center gap-1 rounded-md px-3 py-0.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300"
              >
                {layout.collapsedGroups.uncommon && !showEditMode ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{t("nav.groupUncommon")}</span>
                <span className="ml-auto rounded-md bg-slate-200/80 px-1 text-[10px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {layout.uncommonItems.length}
                </span>
              </button>
            )}

            {(!layout.collapsedGroups.uncommon || showEditMode || collapsed) && (
              <div className="space-y-1">
                {layout.uncommonItems.map((key, idx) => {
                  const meta = itemMeta[key as Exclude<CoreTabKey, "settings">];
                  if (!meta) return null;
                  const isDraggingThis =
                    activeDrag?.kind === "item" &&
                    activeDrag.groupId === "uncommon" &&
                    activeDrag.key === key;
                  return (
                    <div
                      key={key}
                      data-sidebar-item="true"
                      data-sidebar-item-group="uncommon"
                      data-sidebar-item-key={key}
                      className={`flex items-center gap-1 rounded-lg ${
                        isDraggingThis ? "bg-blue-500/10 ring-2 ring-blue-500/40" : ""
                      }`}
                    >
                      <button
                        disabled={locked}
                        title={collapsed ? meta.label : undefined}
                        onPointerDown={(e) => {
                          if (!showEditMode || e.button !== 0) return;
                          e.preventDefault();
                          setActiveDrag({ kind: "item", groupId: "uncommon", key });
                        }}
                        onClick={() => !showEditMode && onSelect(key)}
                        className={`flex min-w-0 flex-1 select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                          isDraggingThis
                            ? "cursor-grabbing text-blue-600 dark:text-blue-400"
                            : showEditMode
                            ? "cursor-grab text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"
                            : activeTab === key
                            ? "bg-blue-600 text-white shadow-sm"
                            : "text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"
                        }`}
                      >
                        {showEditMode && <GripVertical className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                        {meta.icon}
                        {!collapsed && <span className="truncate">{meta.label}</span>}
                      </button>

                      {showEditMode && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => moveItem("uncommon", key, -1)}
                            title={t("nav.moveUp")}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === layout.uncommonItems.length - 1}
                            onClick={() => moveItem("uncommon", key, 1)}
                            title={t("nav.moveDown")}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => restoreFromUncommon(key)}
                            title={t("nav.unfoldItem")}
                            className="rounded-md p-1 text-slate-400 hover:bg-emerald-500/15 hover:text-emerald-600 dark:hover:text-emerald-400"
                          >
                            <ArchiveRestore className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {extensionTabs.length > 0 && (
          <div className="mt-2.5 border-t border-slate-200 pt-2.5 dark:border-slate-800">
            {!collapsed && (
              <button
                type="button"
                onClick={() => toggleGroupCollapsed("extensions")}
                className="mb-1 flex w-full items-center gap-1 rounded-md px-3 py-0.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300"
              >
                {layout.collapsedGroups.extensions ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{t("nav.extensions")}</span>
                {layout.collapsedGroups.extensions && (
                  <span className="ml-auto rounded-md bg-slate-200/80 px-1 text-[10px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {extensionTabs.length}
                  </span>
                )}
              </button>
            )}

            {(!layout.collapsedGroups.extensions || collapsed) && (
              <div className="space-y-1">
                {extensionTabs.map((ext) => (
                  <button
                    key={ext.key}
                    disabled={locked}
                    title={collapsed ? ext.label : ext.plugin.name}
                    onClick={() => onSelect(ext.key)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                      activeTab === ext.key
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                    }`}
                  >
                    <ExtensionIcon icon={ext.icon} className="h-4 w-4 shrink-0" />
                    {!collapsed && <span className="truncate">{ext.label}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      <div className="border-t border-slate-200 p-2 dark:border-slate-800">
        <button
          disabled={locked}
          title={collapsed ? t("nav.settings") : undefined}
          onClick={() => onSelect("settings")}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:opacity-50 ${
            activeTab === "settings"
              ? "bg-blue-600 text-white shadow-sm"
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
