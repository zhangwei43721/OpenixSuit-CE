import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import { useLogColorRules } from "../store/logColors";
import { createAdbTerminalHighlightOverlay, type AdbTerminalHighlightOverlay } from "./adbTerminalHighlight";
import "@xterm/xterm/css/xterm.css";

interface TerminalSession {
  session_id: string;
}

interface TerminalOutput extends TerminalSession {
  data_base64?: string;
  data?: string;
}

interface ShellConnection {
  id: string;
  open: boolean;
  writes: Promise<void>;
}

const closeShell = (id: string) => invoke("adb_term_close", { sessionId: id }).catch(() => {});

function fitTerminal(host: HTMLDivElement, fit: () => void) {
  if (host.clientWidth > 0 && host.clientHeight > 0) fit();
}

export function useAdbTerminal(serial: string, onLog: (message: string) => void) {
  const logColorRules = useLogColorRules();
  const logColorRulesRef = useRef(logColorRules);
  logColorRulesRef.current = logColorRules;
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const highlightOverlayRef = useRef<AdbTerminalHighlightOverlay | null>(null);
  const connectionRef = useRef<ShellConnection | null>(null);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const [ready, setReady] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasScreen, setHasScreen] = useState(false);
  const [termSize, setTermSize] = useState({ cols: 80, rows: 24 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    highlightOverlayRef.current?.updateRules(logColorRules);
  }, [logColorRules]);

  const resetConnection = useCallback(() => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    setSessionId(null);
    setConnecting(false);
    return connection;
  }, []);

  const sendRawData = useCallback((data: string) => {
    const connection = connectionRef.current;
    if (!connection?.open || !data) return;
    // 输入、粘贴和快捷命令共用同一条写入队列，保证字节顺序。
    connection.writes = connection.writes.then(async () => {
      if (connectionRef.current !== connection) return;
      try {
        await invoke("adb_term_write", { sessionId: connection.id, data });
      } catch (cause) {
        if (connectionRef.current !== connection) return;
        const message = String(cause);
        setError(message);
        onLogRef.current(`adb_term_write error: ${message}`);
      }
    });
  }, []);

  const closeSession = useCallback(() => {
    const connection = resetConnection();
    if (connection) void closeShell(connection.id);
  }, [resetConnection]);

  const openSession = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!serial || !terminal || !ready || connectionRef.current?.open === false) return;
    const previous = connectionRef.current;
    const connection: ShellConnection = {
      id: `adb-term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      open: false,
      writes: Promise.resolve(),
    };
    connectionRef.current = connection;
    terminal.options.disableStdin = true;
    setSessionId(null);
    setConnecting(true);
    setError(null);
    if (previous) await closeShell(previous.id);
    if (connectionRef.current !== connection) return;

    // 复位也进入输出队列，避免重连前尚未绘制的内容出现在新会话。
    terminal.write("\x1bc");
    setHasScreen(true);
    const cols = terminal.cols;
    const rows = terminal.rows;
    try {
      await invoke("adb_term_open", { sessionId: connection.id, serial, cols, rows });
      if (connectionRef.current !== connection) {
        await closeShell(connection.id);
        return;
      }
      connection.open = true;
      setSessionId(connection.id);
      setConnecting(false);
      terminal.options.disableStdin = false;
      terminal.focus();
      if (cols !== terminal.cols || rows !== terminal.rows) {
        void invoke("adb_term_resize", {
          sessionId: connection.id, cols: terminal.cols, rows: terminal.rows,
        }).catch(() => {});
      }
    } catch (cause) {
      if (connectionRef.current !== connection) return;
      resetConnection();
      const message = String(cause);
      setError(message);
      onLogRef.current(`adb_term_open error: ${message}`);
    }
  }, [ready, resetConnection, serial]);

  useEffect(() => {
    closeSession();
  }, [serial, closeSession]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;

    const subscriptions = [
      listen<TerminalOutput>("adb-term-data", ({ payload }) => {
        if (!active || !payload || payload.session_id !== connectionRef.current?.id) return;
        if (payload.data_base64 !== undefined) {
          terminal?.write(Uint8Array.from(atob(payload.data_base64), (char) => char.charCodeAt(0)));
        } else if (payload.data !== undefined) {
          terminal?.write(payload.data);
        }
      }),
      listen<TerminalSession>("adb-term-ended", ({ payload }) => {
        if (active && payload?.session_id === connectionRef.current?.id) resetConnection();
      }),
    ];

    const mountTerminal = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (!active) return;
      const screen = new Terminal({
        disableStdin: true,
        cursorBlink: true,
        scrollback: 5000,
        fontFamily: "'DejaVu Sans Mono', Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace",
        fontSize: 14,
        letterSpacing: 0,
        lineHeight: 1.2,
        theme: {
          background: "#0f172a",
          foreground: "#e2e8f0",
          cursor: "#e2e8f0",
          selectionBackground: "#334d72",
        },
      });
      terminal = screen;
      const fit = new FitAddon();
      screen.loadAddon(fit);
      screen.open(host);
      terminalRef.current = screen;
      highlightOverlayRef.current = createAdbTerminalHighlightOverlay(screen, host, logColorRulesRef.current);
      screen.onData(sendRawData);
      screen.onResize(({ cols, rows }) => {
        setTermSize({ cols, rows });
        const connection = connectionRef.current;
        if (connection?.open) {
          void invoke("adb_term_resize", { sessionId: connection.id, cols, rows }).catch(() => {});
        }
      });
      screen.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase();
        const clipboardShortcut = event.metaKey || (event.ctrlKey && event.shiftKey);
        if (!clipboardShortcut || event.altKey || event.type !== "keydown") return true;
        if (key === "c") {
          event.preventDefault();
          if (screen.hasSelection()) document.execCommand("copy");
          return false;
        }
        // 让 WebView 的原生粘贴事件送入 xterm，由组件处理多行和括号粘贴。
        return key !== "v";
      });
      observer = new ResizeObserver(() => fitTerminal(host, () => fit.fit()));
      observer.observe(host);
      fitTerminal(host, () => fit.fit());
      setTermSize({ cols: screen.cols, rows: screen.rows });
    };

    void Promise.all([mountTerminal(), ...subscriptions]).then(() => {
      if (active) setReady(true);
    }).catch((cause) => {
      if (!active) return;
      const message = String(cause);
      setError(message);
      onLogRef.current(`ADB terminal initialization error: ${message}`);
    });

    return () => {
      active = false;
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) void closeShell(connection.id);
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten()).catch(() => {});
      }
      observer?.disconnect();
      highlightOverlayRef.current?.dispose();
      terminal?.dispose();
      highlightOverlayRef.current = null;
      terminalRef.current = null;
    };
  }, [resetConnection, sendRawData]);

  const focusTerminal = () => terminalRef.current?.focus();
  const clearTerminal = () => {
    terminalRef.current?.clear();
    focusTerminal();
  };

  return {
    hostRef, ready, sessionId, connecting, hasScreen, termSize, error,
    openSession, closeSession, sendRawData, clearTerminal, focusTerminal,
  };
}
