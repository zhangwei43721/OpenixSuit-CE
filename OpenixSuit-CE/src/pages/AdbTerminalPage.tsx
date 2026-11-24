import { useEffect, useState } from "react";
import {
  Eraser,
  ListChecks,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAdbTerminal } from "./useAdbTerminal";

interface AdbTerminalPageProps {
  serial: string;
  onLog: (msg: string) => void;
}

interface QuickCommandItem {
  id: string;
  label: string;
  cmd: string;
}

const STORAGE_QUICK_CMDS_KEY = "adb_terminal_quick_commands";
const DEFAULT_QUICK_COMMANDS: QuickCommandItem[] = [
  { id: "def-1", label: "dmesg | tail -n 50", cmd: "dmesg | tail -n 50" },
  { id: "def-2", label: "logcat -d", cmd: "logcat -d" },
  { id: "def-3", label: "df -h", cmd: "df -h" },
];

function loadSavedQuickCommands(): QuickCommandItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_QUICK_CMDS_KEY);
    if (!raw) return DEFAULT_QUICK_COMMANDS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is QuickCommandItem =>
          x && typeof x.id === "string" && typeof x.cmd === "string" && x.cmd.trim().length > 0
      );
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_QUICK_COMMANDS;
}

export function AdbTerminalPage({ serial, onLog }: AdbTerminalPageProps) {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");
  const {
    hostRef, ready, sessionId, connecting, hasScreen, termSize, error,
    openSession, closeSession, sendRawData, clearTerminal, focusTerminal,
  } = useAdbTerminal(serial, onLog);
  const [quickCommands, setQuickCommands] = useState<QuickCommandItem[]>(loadSavedQuickCommands);
  const [showShortcutDrawer, setShowShortcutDrawer] = useState(false);
  const [shortcutQuery, setShortcutQuery] = useState("");
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [shortcutLabel, setShortcutLabel] = useState("");
  const [shortcutCmd, setShortcutCmd] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_QUICK_CMDS_KEY, JSON.stringify(quickCommands));
    } catch {
      // ignore
    }
  }, [quickCommands]);

  const openShortcutCreator = () => {
    setShowShortcutDrawer(true);
    setEditingShortcutId(null);
    setShortcutCmd("");
    setShortcutLabel("");
    setShortcutEditorOpen(true);
  };

  const openShortcutEditor = (item: QuickCommandItem) => {
    setShowShortcutDrawer(true);
    setEditingShortcutId(item.id);
    setShortcutLabel(item.label);
    setShortcutCmd(item.cmd);
    setShortcutEditorOpen(true);
  };

  const handleSaveShortcut = () => {
    const cmdText = shortcutCmd.trim();
    if (!cmdText) return;
    const labelText = shortcutLabel.trim() || cmdText;
    if (editingShortcutId) {
      setQuickCommands((prev) =>
        prev.map((item) =>
          item.id === editingShortcutId
            ? { ...item, label: labelText, cmd: cmdText }
            : item
        )
      );
    } else {
      setQuickCommands((prev) => [
        ...prev,
        { id: `qc-${Date.now()}`, label: labelText, cmd: cmdText },
      ]);
    }
    setEditingShortcutId(null);
    setShortcutLabel("");
    setShortcutCmd("");
    setShortcutEditorOpen(false);
    onLog(
      isEn ? `Saved shortcut: ${labelText}` : `已保存 ADB 快捷指令: ${labelText}`
    );
  };

  const handleDeleteShortcut = (id: string) => {
    setQuickCommands((prev) => prev.filter((item) => item.id !== id));
    if (editingShortcutId === id) {
      setEditingShortcutId(null);
      setShortcutEditorOpen(false);
    }
  };

  const filteredShortcuts = quickCommands.filter((item) => {
    const q = shortcutQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      item.label.toLowerCase().includes(q) || item.cmd.toLowerCase().includes(q)
    );
  });

  const sendCommand = (command: string) => {
    sendRawData(`${command}\r`);
    focusTerminal();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Top Toolbar */}
      <div className="ui-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <div className="ui-title">
            <TerminalIcon className="h-4 w-4 text-blue-500" />
            <span>{isEn ? "ADB PTY Terminal" : "ADB 终端"}</span>
          </div>

          <span className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-xs tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {serial || (isEn ? "No device" : "未连接设备")}
          </span>

          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums ${
              sessionId
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            }`}
          >
            {sessionId
              ? `${isEn ? "Connected" : "已连接"} (${termSize.cols}x${termSize.rows})`
              : isEn
              ? "Disconnected"
              : "未连接"}
          </span>

          {sessionId ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={openSession}
                disabled={connecting}
                className="ui-btn-secondary"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${connecting ? "animate-spin" : ""}`} />
                {isEn ? "Reconnect" : "重连"}
              </button>
              <button
                onClick={() => closeSession()}
                className="ui-btn-danger"
              >
                <PlugZap className="h-3.5 w-3.5" />
                {isEn ? "Disconnect" : "断开"}
              </button>
            </div>
          ) : (
            <button
              onClick={openSession}
              disabled={!serial || !ready || connecting}
              className="ui-btn-success"
            >
              <Plug className="h-3.5 w-3.5" />
              {connecting
                ? isEn
                  ? "Connecting..."
                  : "连接中..."
                : isEn
                ? "Connect Shell"
                : "连接终端"}
            </button>
          )}
        </div>

        {/* Quick Actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => sendRawData("\x03")}
            disabled={!sessionId}
            className="inline-flex items-center justify-center rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 font-mono text-xs font-medium text-rose-600 transition hover:bg-rose-500/20 disabled:pointer-events-none disabled:opacity-45 dark:text-rose-400"
          >
            Ctrl+C
          </button>
          <button
            onClick={() => sendRawData("\x04")}
            disabled={!sessionId}
            className="inline-flex items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 font-mono text-xs font-medium text-amber-600 transition hover:bg-amber-500/20 disabled:pointer-events-none disabled:opacity-45 dark:text-amber-400"
          >
            Ctrl+D
          </button>
          <button
            onClick={clearTerminal}
            className="ui-btn-secondary"
          >
            <Eraser className="h-3.5 w-3.5" />
            {t("adbTerminal.clearScrollback")}
          </button>

          <div className="mx-1 hidden h-4 w-px bg-slate-200 dark:bg-slate-700 sm:block" />

          <button
            type="button"
            onClick={() => setShowShortcutDrawer((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
              showShortcutDrawer
                ? "border-blue-500 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700/80"
            }`}
          >
            <ListChecks className="h-3.5 w-3.5" />
            {isEn ? `Shortcuts (${quickCommands.length})` : `快捷指令 (${quickCommands.length})`}
          </button>
        </div>
      </div>

      {error && <div className="ui-alert-err">{error}</div>}

      {/* Main Split: Terminal + Quick Commands List */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-2 focus-within:border-blue-500">
            <div
              ref={hostRef}
              onClick={focusTerminal}
              className="h-full min-h-0 w-full cursor-text"
            />
            {!hasScreen && (
              <p className="pointer-events-none absolute left-4 top-4 m-0 select-none text-xs text-slate-400">
                {t("adbTerminal.connectHint")}
              </p>
            )}
          </div>

        </div>

        {showShortcutDrawer && (
          <div className="ui-card flex w-72 max-w-[40%] shrink-0 flex-col overflow-hidden">
            <div className="ui-card-header">
              <div className="ui-title">
                <ListChecks className="h-4 w-4 text-blue-500" />
                <span>{isEn ? "Quick Commands" : "快捷指令列表"}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setQuickCommands(DEFAULT_QUICK_COMMANDS)}
                  title={isEn ? "Restore defaults" : "恢复默认指令"}
                  className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={openShortcutCreator}
                  className="ui-btn-primary !px-2.5 !py-1 text-[11px]"
                >
                  <Plus className="h-3 w-3" />
                  {isEn ? "New" : "新建"}
                </button>
              </div>
            </div>

            <div className="border-b border-slate-200 p-3 dark:border-slate-800">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
                <input
                  value={shortcutQuery}
                  onChange={(e) => setShortcutQuery(e.target.value)}
                  placeholder={isEn ? "Search name or command..." : "搜索名称或长命令..."}
                  className="ui-input w-full pl-8"
                />
              </div>
            </div>

            {shortcutEditorOpen && (
              <div className="space-y-2.5 border-b border-blue-500/30 bg-blue-500/5 p-3 text-xs">
                <div className="font-semibold text-blue-600 dark:text-blue-400">
                  {editingShortcutId
                    ? isEn
                      ? "Edit Shortcut"
                      : "编辑快捷指令"
                    : isEn
                    ? "New Shortcut"
                    : "添加快捷指令"}
                </div>
                <input
                  type="text"
                  value={shortcutLabel}
                  onChange={(e) => setShortcutLabel(e.target.value)}
                  placeholder={isEn ? "Label (e.g. Pinmux Dump)" : "名称（如 查看 GPIO 复用）"}
                  className="ui-input w-full bg-white dark:bg-slate-950"
                />
                <textarea
                  rows={3}
                  value={shortcutCmd}
                  onChange={(e) => setShortcutCmd(e.target.value)}
                  placeholder={
                    isEn
                      ? "Long shell command..."
                      : "输入完整命令（支持长命令或管道组合）..."
                  }
                  className="ui-input w-full resize-y bg-white font-mono text-[11px] dark:bg-slate-950"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setShortcutEditorOpen(false);
                      setEditingShortcutId(null);
                    }}
                    className="ui-btn-secondary !px-2.5 !py-1"
                  >
                    {isEn ? "Cancel" : "取消"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveShortcut}
                    disabled={!shortcutCmd.trim()}
                    className="ui-btn-primary !px-3 !py-1"
                  >
                    {isEn ? "Save" : "保存"}
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {filteredShortcuts.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  {isEn ? "No saved shortcuts" : "暂无匹配的快捷指令，点击上方「新建」添加"}
                </div>
              ) : (
                filteredShortcuts.map((item) => (
                  <div
                    key={item.id}
                    className="ui-subcard group p-2.5 transition hover:border-blue-500/40"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span
                        className="truncate text-xs font-medium text-slate-800 dark:text-slate-100"
                        title={item.label}
                      >
                        {item.label}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={!sessionId}
                          onClick={() => sendCommand(item.cmd)}
                          title={isEn ? "Run now" : "立即执行"}
                          className="rounded-md p-1 text-emerald-600 transition hover:bg-emerald-500/15 disabled:opacity-35 dark:text-emerald-400"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openShortcutEditor(item)}
                          title={isEn ? "Edit" : "编辑"}
                          className="rounded-md p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteShortcut(item.id)}
                          title={isEn ? "Delete" : "删除"}
                          className="rounded-md p-1 text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-500"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!sessionId}
                      onClick={() => sendCommand(item.cmd)}
                      title={item.cmd}
                      className="mt-1 line-clamp-2 w-full break-all text-left font-mono text-[11px] leading-4 text-slate-500 transition hover:text-blue-600 disabled:hover:text-slate-500 dark:text-slate-400 dark:hover:text-blue-400"
                    >
                      {item.cmd}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
