import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BookmarkPlus,
  CornerDownLeft,
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
  Send,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AnsiText } from "../utils/ansi";

interface AdbTerminalPageProps {
  serial: string;
  onLog: (msg: string) => void;
}

interface AdbTermDataPayload {
  session_id: string;
  data: string;
}

interface QuickCommandItem {
  id: string;
  label: string;
  cmd: string;
}

const MAX_TERMINAL_CHARS = 200_000;
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
  const { i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [buffer, setBuffer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [imeInput, setImeInput] = useState("");
  const [termSize, setTermSize] = useState({ cols: 100, rows: 28 });
  const [quickCommands, setQuickCommands] = useState<QuickCommandItem[]>(loadSavedQuickCommands);
  const [showShortcutDrawer, setShowShortcutDrawer] = useState(true);
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

  const openShortcutCreator = (prefillCmd = "") => {
    setShowShortcutDrawer(true);
    setEditingShortcutId(null);
    setShortcutCmd(prefillCmd);
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
    onLogRef.current(
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

  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  const computeTermSize = useCallback(() => {
    const el = termContainerRef.current;
    if (!el) return { cols: 100, rows: 28 };
    const cols = Math.max(40, Math.floor((el.clientWidth - 24) / 7.4));
    const rows = Math.max(12, Math.floor((el.clientHeight - 24) / 20));
    return { cols, rows };
  }, []);

  const closeSession = useCallback(
    async (targetId?: string | null) => {
      const sid = targetId ?? sessionIdRef.current;
      if (!sid) return;
      try {
        await invoke("adb_term_close", { sessionId: sid });
      } catch {
        // ignore already closed
      }
      if (sid === sessionIdRef.current) {
        setSessionId(null);
      }
    },
    []
  );

  const openSession = useCallback(async () => {
    if (!serial) {
      setError(isEn ? "No ADB device selected" : "未选择 ADB 设备");
      return;
    }
    setConnecting(true);
    setError(null);
    if (sessionIdRef.current) {
      await closeSession(sessionIdRef.current);
    }

    const dims = computeTermSize();
    setTermSize(dims);
    const newId = `adb-term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    sessionIdRef.current = newId;
    try {
      await invoke("adb_term_open", {
        sessionId: newId,
        serial,
      });
      setSessionId(newId);
      invoke("adb_term_resize", {
        sessionId: newId,
        cols: dims.cols,
        rows: dims.rows,
      }).catch(() => {});
      onLogRef.current(
        isEn
          ? `ADB PTY opened for ${serial} (${dims.cols}x${dims.rows})`
          : `ADB 交互终端已连接: ${serial} (${dims.cols}x${dims.rows})`
      );
      setTimeout(() => {
        termContainerRef.current?.focus();
      }, 50);
    } catch (err) {
      sessionIdRef.current = null;
      const msg = String(err);
      setError(msg);
      onLogRef.current(`adb_term_open error: ${msg}`);
    } finally {
      setConnecting(false);
    }
  }, [serial, closeSession, computeTermSize, isEn]);

  // Listen to adb-term-data events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<AdbTermDataPayload>("adb-term-data", (event) => {
      const payload = event.payload;
      if (!payload || payload.session_id !== sessionIdRef.current) return;
      setBuffer((prev) => {
        const combined = prev + payload.data;
        if (combined.length > MAX_TERMINAL_CHARS) {
          return combined.slice(combined.length - MAX_TERMINAL_CHARS);
        }
        return combined;
      });
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Auto scroll terminal on output
  useEffect(() => {
    const el = termContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [buffer]);

  // ResizeObserver for PTY resize
  useEffect(() => {
    const el = termContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const dims = computeTermSize();
      setTermSize(dims);
      if (sessionIdRef.current) {
        invoke("adb_term_resize", {
          sessionId: sessionIdRef.current,
          cols: dims.cols,
          rows: dims.rows,
        }).catch(() => {});
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [computeTermSize]);

  // Cleanup PTY on unmount or serial change
  useEffect(() => {
    return () => {
      if (sessionIdRef.current) {
        invoke("adb_term_close", { sessionId: sessionIdRef.current }).catch(() => {});
      }
    };
  }, [serial]);

  const sendRawData = useCallback(async (data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || !data) return;
    try {
      await invoke("adb_term_write", { sessionId: sid, data });
    } catch (err) {
      const msg = String(err);
      setError(msg);
      onLogRef.current(`adb_term_write error: ${msg}`);
    }
  }, []);

  const handleTerminalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sessionId) return;

    // Allow browser copy shortcut Ctrl+C when user actually highlighted text
    const selection = window.getSelection()?.toString();
    if (e.ctrlKey && e.key.toLowerCase() === "c" && selection) {
      return;
    }

    let seq: string | null = null;

    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (lower === "c") seq = "\x03";
      else if (lower === "d") seq = "\x04";
      else if (lower === "l") seq = "\x0c";
      else if (lower === "z") seq = "\x1a";
      else if (lower === "a") seq = "\x01";
      else if (lower === "e") seq = "\x05";
      else if (lower === "u") seq = "\x15";
      else if (lower === "w") seq = "\x17";
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      switch (e.key) {
        case "Enter":
          seq = "\r";
          break;
        case "Backspace":
          seq = "\x7f";
          break;
        case "Tab":
          seq = "\t";
          break;
        case "Escape":
          seq = "\x1b";
          break;
        case "ArrowUp":
          seq = "\x1b[A";
          break;
        case "ArrowDown":
          seq = "\x1b[B";
          break;
        case "ArrowRight":
          seq = "\x1b[C";
          break;
        case "ArrowLeft":
          seq = "\x1b[D";
          break;
        case "Home":
          seq = "\x1b[H";
          break;
        case "End":
          seq = "\x1b[F";
          break;
        case "Delete":
          seq = "\x1b[3~";
          break;
        default:
          if (e.key.length === 1) {
            seq = e.key;
          }
          break;
      }
    }

    if (seq !== null) {
      e.preventDefault();
      e.stopPropagation();
      sendRawData(seq);
    }
  };

  const handleTerminalPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    const text = e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      sendRawData(text);
    }
  };

  const handleSendImeBar = () => {
    if (!sessionId) return;
    sendRawData(`${imeInput}\r`);
    setImeInput("");
  };

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
            <TerminalIcon className="w-4 h-4 text-blue-500" />
            <span>{isEn ? "ADB PTY Terminal" : "ADB 终端"}</span>
          </div>

          <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
            {serial || (isEn ? "No device" : "未连接设备")}
          </span>

          <span
            className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
              sessionId
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-slate-200 dark:bg-slate-800 text-slate-500"
            }`}
          >
            {sessionId
              ? `${isEn ? "Connected" : "已连接"} (${termSize.cols}x${termSize.rows})`
              : isEn
              ? "Disconnected"
              : "未连接"}
          </span>

          {sessionId ? (
            <>
              <button
                onClick={openSession}
                disabled={connecting}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${connecting ? "animate-spin" : ""}`} />
                {isEn ? "Reconnect" : "重连"}
              </button>
              <button
                onClick={() => closeSession()}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-rose-500 hover:bg-rose-600 text-white transition"
              >
                <PlugZap className="w-3.5 h-3.5" />
                {isEn ? "Disconnect" : "断开"}
              </button>
            </>
          ) : (
            <button
              onClick={openSession}
              disabled={!serial || connecting}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 transition"
            >
              <Plug className="w-3.5 h-3.5" />
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
            className="px-2 py-1 rounded-md text-xs font-mono border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 disabled:opacity-40 transition"
          >
            Ctrl+C
          </button>
          <button
            onClick={() => sendRawData("\x04")}
            disabled={!sessionId}
            className="px-2 py-1 rounded-md text-xs font-mono border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 transition"
          >
            Ctrl+D
          </button>
          <button
            onClick={() => setBuffer("")}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <Eraser className="w-3.5 h-3.5" />
            Clear
          </button>

          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1 hidden sm:block" />

          <button
            type="button"
            onClick={() => setShowShortcutDrawer((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition ${
              showShortcutDrawer
                ? "border-blue-500 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <ListChecks className="w-3.5 h-3.5" />
            {isEn ? `Shortcuts (${quickCommands.length})` : `快捷指令 (${quickCommands.length})`}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {/* Main Split: Terminal + Quick Commands List */}
      <div className="flex-1 min-h-0 flex gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-2.5 min-h-0">
          {/* Interactive Terminal Viewport */}
          <div
            ref={termContainerRef}
            tabIndex={0}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleTerminalKeyDown}
            onPaste={handleTerminalPaste}
            onClick={() => termContainerRef.current?.focus()}
            className={`flex-1 overflow-auto p-3 rounded-xl border bg-slate-950 text-slate-100 font-mono text-xs cursor-text outline-none transition min-h-[260px] ${
              focused
                ? "border-blue-500 ring-2 ring-blue-500/20"
                : "border-slate-200 dark:border-slate-800"
            }`}
          >
            {buffer ? (
              <AnsiText text={buffer} ansiEnabled={true} className="text-slate-100" />
            ) : (
              <div className="text-slate-500 select-none">
                {sessionId
                  ? isEn
                    ? "Terminal ready. Click here and start typing..."
                    : "终端已就绪，点击此处即可直接输入指令..."
                  : isEn
                  ? "Click 'Connect Shell' above to open an interactive ADB PTY session."
                  : "点击上方「连接终端」即可开启 ADB 交互式 PTY 会话。"}
              </div>
            )}
          </div>

          {/* Bottom Paste / IME Command Bar */}
          <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2">
            <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
              {isEn ? "Command:" : "发送指令:"}
            </span>
            <input
              type="text"
              value={imeInput}
              onChange={(e) => setImeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sessionId) {
                  e.preventDefault();
                  handleSendImeBar();
                }
              }}
              placeholder={
                sessionId
                  ? isEn
                    ? "Enter long command or Chinese text and press Enter..."
                    : "输入或粘贴长指令、中文内容后回车发送..."
                  : isEn
                  ? "Connect terminal to run (you can still save shortcuts)..."
                  : "连接终端后可直接发送（未连接也可先输入并存为快捷指令）..."
              }
              className="flex-1 text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={() => openShortcutCreator(imeInput.trim())}
              disabled={!imeInput.trim()}
              title={isEn ? "Save current command to list" : "将当前输入保存到右侧快捷指令列表"}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition"
            >
              <BookmarkPlus className="w-3.5 h-3.5 text-blue-500" />
              {isEn ? "Save" : "存为快捷"}
            </button>
            <button
              onClick={handleSendImeBar}
              disabled={!sessionId}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition"
            >
              <Send className="w-3.5 h-3.5" />
              {isEn ? "Send" : "发送"}
            </button>
          </div>
        </div>

        {showShortcutDrawer && (
          <div className="w-80 shrink-0 flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <ListChecks className="w-4 h-4 text-blue-500" />
                <span>{isEn ? "Quick Commands" : "快捷指令列表"}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setQuickCommands(DEFAULT_QUICK_COMMANDS)}
                  title={isEn ? "Restore defaults" : "恢复默认指令"}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => openShortcutCreator(imeInput.trim())}
                  className="flex items-center gap-1 px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium"
                >
                  <Plus className="w-3 h-3" />
                  {isEn ? "New" : "新建"}
                </button>
              </div>
            </div>

            <div className="p-2 border-b border-slate-200 dark:border-slate-800">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2 pointer-events-none" />
                <input
                  value={shortcutQuery}
                  onChange={(e) => setShortcutQuery(e.target.value)}
                  placeholder={isEn ? "Search name or command..." : "搜索名称或长命令..."}
                  className="w-full pl-8 pr-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                />
              </div>
            </div>

            {shortcutEditorOpen && (
              <div className="p-2.5 space-y-2 border-b border-blue-500/30 bg-blue-500/5 text-xs">
                <div className="font-medium text-blue-600 dark:text-blue-400">
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
                  className="w-full px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
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
                  className="w-full font-mono text-[11px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 resize-y"
                />
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setShortcutEditorOpen(false);
                      setEditingShortcutId(null);
                    }}
                    className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                  >
                    {isEn ? "Cancel" : "取消"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveShortcut}
                    disabled={!shortcutCmd.trim()}
                    className="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-medium disabled:opacity-40"
                  >
                    {isEn ? "Save" : "保存"}
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {filteredShortcuts.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  {isEn ? "No saved shortcuts" : "暂无匹配的快捷指令，点击上方「新建」添加"}
                </div>
              ) : (
                filteredShortcuts.map((item) => (
                  <div
                    key={item.id}
                    className="group rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-2 hover:border-blue-500/40 transition"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span
                        className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate"
                        title={item.label}
                      >
                        {item.label}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={!sessionId}
                          onClick={() => sendRawData(`${item.cmd}\r`)}
                          title={isEn ? "Run now" : "立即执行"}
                          className="p-1 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-35"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setImeInput(item.cmd)}
                          title={isEn ? "Fill into input bar" : "填入下方输入框修改"}
                          className="p-1 rounded-md text-slate-500 hover:text-blue-500 hover:bg-blue-500/10"
                        >
                          <CornerDownLeft className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openShortcutEditor(item)}
                          title={isEn ? "Edit" : "编辑"}
                          className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteShortcut(item.id)}
                          title={isEn ? "Delete" : "删除"}
                          className="p-1 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-500/10"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!sessionId}
                      onClick={() => sendRawData(`${item.cmd}\r`)}
                      title={item.cmd}
                      className="mt-1 w-full text-left font-mono text-[11px] leading-4 text-slate-500 dark:text-slate-400 break-all line-clamp-2 hover:text-blue-600 dark:hover:text-blue-400 disabled:hover:text-slate-500"
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
