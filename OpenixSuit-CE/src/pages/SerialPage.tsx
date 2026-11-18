import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Clock,
  Download,
  Eye,
  EyeOff,
  FileText,
  History,
  Palette,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Send,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DeviceWorkspace,
  SerialDataPayload,
  SerialLineCoding,
  SerialLogEntry,
  SerialPortInfo,
  SerialSessionInfo,
} from "../types/workbench";
import { AnsiText, stripAnsi } from "../utils/ansi";

interface SerialPageProps {
  activeWorkspace?: DeviceWorkspace | null;
  onLog: (msg: string) => void;
}

interface BufferedLine {
  ts: string;
  text: string;
}

interface SerialPaneState {
  paneId: string;
  label: string;
  portName: string;
  baudRate: number;
  customBaud: boolean;
  coding: SerialLineCoding;
  charset: Charset;
  sessionId: string | null;
  connected: boolean;
  connecting: boolean;
  dtr: boolean;
  rts: boolean;
  hidden: boolean;
  showTimestamps: boolean;
  ansiEnabled: boolean;
  autoScroll: boolean;
  filterOnly: boolean;
  searchQuery: string;
  lineEnding: "\n" | "\r\n" | "";
  inputText: string;
  cmdHistory: string[];
  historyIndex: number;
  lines: BufferedLine[];
  endsWithNewline: boolean;
  error: string | null;
}

const BAUD_RATES = [
  1200,
  2400,
  4800,
  9600,
  14400,
  19200,
  38400,
  57600,
  74880,
  115200,
  230400,
  250000,
  460800,
  500000,
  576000,
  921600,
  1000000,
  1500000,
  2000000,
  3000000,
];
const CUSTOM_BAUD = "__custom__";

const DATA_BITS_OPTIONS = [5, 6, 7, 8];
const STOP_BITS_OPTIONS = [1, 2];
const PARITY_OPTIONS = ["none", "even", "odd"] as const;
const FLOW_CONTROL_OPTIONS = ["none", "software", "hardware"] as const;
const CHARSET_OPTIONS = ["utf-8", "gb18030", "big5", "latin1"] as const;
type Charset = (typeof CHARSET_OPTIONS)[number];

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const decodeChunk = (bytes: Uint8Array, charset: Charset): string => {
  try {
    if (charset === "latin1") {
      let out = "";
      for (const b of bytes) out += String.fromCharCode(b);
      return out;
    }
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

const defaultCoding = (): SerialLineCoding => ({
  data_bits: 8,
  stop_bits: 1,
  parity: "none",
  flow_control: "none",
});

const MAX_BUFFER_LINES = 4000;

function formatNowTime(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUnixSecs(secs: number): string {
  if (!secs) return "-";
  return new Date(secs * 1000).toLocaleString();
}

function createPane(idx: number, portName = "", baudRate = 115200, label?: string): SerialPaneState {
  return {
    paneId: `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: label || `UART ${idx + 1}`,
    portName,
    baudRate,
    customBaud: !BAUD_RATES.includes(baudRate),
    coding: defaultCoding(),
    charset: "utf-8",
    sessionId: null,
    connected: false,
    connecting: false,
    dtr: false,
    rts: false,
    hidden: false,
    showTimestamps: true,
    ansiEnabled: true,
    autoScroll: true,
    filterOnly: false,
    searchQuery: "",
    lineEnding: "\n",
    inputText: "",
    cmdHistory: [],
    historyIndex: -1,
    lines: [],
    endsWithNewline: true,
    error: null,
  };
}

function appendChunkToLines(
  prevLines: BufferedLine[],
  endsWithNewline: boolean,
  chunk: string,
  timestamp: string
): { lines: BufferedLine[]; endsWithNewline: boolean } {
  if (!chunk) return { lines: prevLines, endsWithNewline };
  const ts = timestamp ? timestamp.slice(0, 12) : formatNowTime();
  const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  const next = prevLines.slice();

  let startIdx = 0;
  if (!endsWithNewline && next.length > 0) {
    next[next.length - 1] = {
      ...next[next.length - 1],
      text: next[next.length - 1].text + parts[0],
    };
    startIdx = 1;
  }

  for (let i = startIdx; i < parts.length; i++) {
    // Skip trailing empty segment after final newline until real chars arrive
    if (i === parts.length - 1 && parts[i] === "") {
      continue;
    }
    next.push({ ts, text: parts[i] });
  }

  const ended = normalized.endsWith("\n");
  const trimmed =
    next.length > MAX_BUFFER_LINES ? next.slice(next.length - MAX_BUFFER_LINES) : next;

  return { lines: trimmed, endsWithNewline: ended };
}

export function SerialPage({ activeWorkspace, onLog }: SerialPageProps) {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [subView, setSubView] = useState<"live" | "logs">("live");
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(false);

  const [panes, setPanes] = useState<SerialPaneState[]>(() => {
    if (activeWorkspace?.serial_ports?.length) {
      return activeWorkspace.serial_ports
        .slice(0, 4)
        .map((slot, idx) => createPane(idx, slot.port_name, slot.baud_rate || 115200, slot.label));
    }
    return [createPane(0)];
  });

  // Saved Log Browser state
  const [logFiles, setLogFiles] = useState<SerialLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [selectedLogFile, setSelectedLogFile] = useState<SerialLogEntry | null>(null);
  const [logContent, setLogContent] = useState("");
  const [loadingLogContent, setLoadingLogContent] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const [logAnsi, setLogAnsi] = useState(true);
  const [logShowTimestamps, setLogShowTimestamps] = useState(true);

  const scrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const refreshPorts = useCallback(async () => {
    setLoadingPorts(true);
    try {
      const list = await invoke<SerialPortInfo[]>("serial_list_ports");
      setPorts(Array.isArray(list) ? list : []);
    } catch (err) {
      onLog(`serial_list_ports error: ${String(err)}`);
    } finally {
      setLoadingPorts(false);
    }
  }, [onLog]);

  // Recover existing active sessions on mount if any
  const syncExistingSessions = useCallback(async () => {
    try {
      const sessions = await invoke<SerialSessionInfo[]>("serial_list_sessions");
      if (!Array.isArray(sessions) || sessions.length === 0) return;
      setPanes((prev) => {
        const next = [...prev];
        for (const sess of sessions) {
          if (!sess.connected) continue;
          const existingIdx = next.findIndex(
            (p) => p.sessionId === sess.id || (p.portName === sess.port_name && !p.connected)
          );
          if (existingIdx >= 0) {
            next[existingIdx] = {
              ...next[existingIdx],
              portName: sess.port_name,
              baudRate: sess.baud_rate,
              customBaud: !BAUD_RATES.includes(sess.baud_rate),
              sessionId: sess.id,
              connected: true,
            };
          } else if (next.length < 4) {
            const p = createPane(next.length, sess.port_name, sess.baud_rate);
            p.sessionId = sess.id;
            p.connected = true;
            next.push(p);
          }
        }
        return next;
      });
    } catch {
      // ignore if backend command not yet initialized
    }
  }, []);

  useEffect(() => {
    refreshPorts();
    syncExistingSessions();
  }, [refreshPorts, syncExistingSessions]);

  // Charset decoder state per pane (TextDecoder keeps incomplete multibyte
  // trailing bytes between chunks internally via stream: true)
  const decoderRefs = useRef<Record<string, { decoder: TextDecoder | null; charset: Charset }>>({});

  const getDecoder = (paneId: string, charset: Charset) => {
    let entry = decoderRefs.current[paneId];
    if (!entry || entry.charset !== charset) {
      entry = {
        decoder: charset === "latin1" ? null : new TextDecoder(charset, { fatal: false }),
        charset,
      };
      decoderRefs.current[paneId] = entry;
    }
    return entry;
  };

  const clearDecoder = (paneId: string) => {
    delete decoderRefs.current[paneId];
  };

  // Listen to serial-data events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SerialDataPayload>("serial-data", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setPanes((prev) =>
        prev.map((pane) => {
          if (pane.sessionId !== payload.session_id) return pane;
          // Prefer raw bytes decoded with the pane charset; fall back to backend lossy chunk.
          let text = payload.chunk;
          if (payload.data_base64 && payload.data_base64.length > 0) {
            try {
              const bytes = b64ToBytes(payload.data_base64);
              if (pane.charset === "latin1") {
                text = decodeChunk(bytes, pane.charset);
              } else {
                const entry = getDecoder(pane.paneId, pane.charset);
                // stream: true retains incomplete multibyte trailing bytes
                text = entry.decoder!.decode(bytes, { stream: true });
              }
            } catch {
              text = payload.chunk;
            }
          }
          const updated = appendChunkToLines(
            pane.lines,
            pane.endsWithNewline,
            text,
            payload.timestamp
          );
          return {
            ...pane,
            lines: updated.lines,
            endsWithNewline: updated.endsWithNewline,
          };
        })
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Auto scroll panes when lines update
  useEffect(() => {
    for (const pane of panes) {
      if (pane.autoScroll && !pane.hidden) {
        const el = scrollRefs.current[pane.paneId];
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }
    }
  }, [panes]);

  const updatePane = useCallback((paneId: string, patch: Partial<SerialPaneState>) => {
    setPanes((prev) => prev.map((p) => (p.paneId === paneId ? { ...p, ...patch } : p)));
  }, []);

  const handleLoadFromWorkspace = () => {
    if (!activeWorkspace?.serial_ports?.length) return;
    setPanes((prev) => {
      const connectedPanes = prev.filter((p) => p.connected);
      const slots = activeWorkspace.serial_ports.slice(0, 4);
      const next: SerialPaneState[] = [...connectedPanes];
      for (const slot of slots) {
        if (next.length >= 4) break;
        const already = next.some((p) => p.portName === slot.port_name);
        if (!already) {
          next.push(createPane(next.length, slot.port_name, slot.baud_rate || 115200, slot.label));
        }
      }
      return next.length > 0 ? next : [createPane(0)];
    });
    onLog(
      isEn
        ? `Loaded serial slots from workspace "${activeWorkspace.name}"`
        : `已从工作区「${activeWorkspace.name}」加载串口配置`
    );
  };

  const handleConnect = async (pane: SerialPaneState) => {
    const port = pane.portName || ports[0]?.port_name || "";
    if (!port) {
      updatePane(pane.paneId, {
        error: isEn ? "Please select a serial port" : "请先选择串口设备",
      });
      return;
    }
    updatePane(pane.paneId, { connecting: true, error: null, portName: port });
    try {
      const requestedId = pane.sessionId || `serial-${pane.paneId}-${Date.now()}`;
      const session = await invoke<SerialSessionInfo>("serial_open", {
        sessionId: requestedId,
        portName: port,
        baudRate: pane.baudRate,
        lineCoding: pane.coding,
      });
      clearDecoder(pane.paneId);
      updatePane(pane.paneId, {
        sessionId: session.id,
        connected: true,
        connecting: false,
        portName: session.port_name || port,
        baudRate: session.baud_rate || pane.baudRate,
        error: null,
      });
      onLog(
        isEn
          ? `Serial opened: ${port} @ ${pane.baudRate}`
          : `串口已连接: ${port} @ ${pane.baudRate}`
      );
    } catch (err) {
      const msg = String(err);
      updatePane(pane.paneId, { connecting: false, error: msg });
      onLog(`serial_open error: ${msg}`);
    }
  };

  const handleDisconnect = async (pane: SerialPaneState) => {
    if (!pane.sessionId) return;
    try {
      await invoke("serial_close", { sessionId: pane.sessionId });
      clearDecoder(pane.paneId);
      updatePane(pane.paneId, { connected: false, sessionId: null, dtr: false, rts: false });
      onLog(isEn ? `Serial closed: ${pane.portName}` : `串口已断开: ${pane.portName}`);
    } catch (err) {
      const msg = String(err);
      updatePane(pane.paneId, { error: msg });
      onLog(`serial_close error: ${msg}`);
    }
  };

  const handleConnectAllWorkspace = async () => {
    for (const pane of panesRef.current) {
      if (!pane.connected && pane.portName) {
        await handleConnect(pane);
      }
    }
  };

  const handleToggleSignal = async (pane: SerialPaneState, kind: "dtr" | "rts") => {
    if (!pane.sessionId || !pane.connected) return;
    const nextDtr = kind === "dtr" ? !pane.dtr : pane.dtr;
    const nextRts = kind === "rts" ? !pane.rts : pane.rts;
    try {
      await invoke("serial_set_signals", {
        sessionId: pane.sessionId,
        dtr: nextDtr,
        rts: nextRts,
      });
      updatePane(pane.paneId, { dtr: nextDtr, rts: nextRts });
    } catch (err) {
      const msg = String(err);
      updatePane(pane.paneId, { error: msg });
      onLog(`serial_set_signals error: ${msg}`);
    }
  };

  const handleSendCommand = async (pane: SerialPaneState) => {
    if (!pane.sessionId || !pane.connected) return;
    const raw = pane.inputText;
    const payload = `${raw}${pane.lineEnding}`;
    if (!payload) return;

    try {
      await invoke("serial_write", {
        sessionId: pane.sessionId,
        data: payload,
      });
      const nextHistory =
        raw.trim() && pane.cmdHistory[0] !== raw
          ? [raw, ...pane.cmdHistory].slice(0, 50)
          : pane.cmdHistory;
      updatePane(pane.paneId, {
        inputText: "",
        cmdHistory: nextHistory,
        historyIndex: -1,
      });
    } catch (err) {
      const msg = String(err);
      updatePane(pane.paneId, { error: msg });
      onLog(`serial_write error: ${msg}`);
    }
  };

  const handleExportLog = async (pane: SerialPaneState) => {
    const content = pane.lines
      .map((l) => (pane.showTimestamps ? `[${l.ts}] ${stripAnsi(l.text)}` : stripAnsi(l.text)))
      .join("\n");
    try {
      const defaultName = `${(pane.portName || "serial").replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.log`;
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "Log Files", extensions: ["log", "txt"] }],
      });
      if (path) {
        await writeTextFile(path, content);
        onLog(isEn ? `Exported serial log: ${path}` : `已导出串口日志: ${path}`);
      }
    } catch (err) {
      onLog(`Export log error: ${String(err)}`);
    }
  };

  const handleAddPane = () => {
    if (panes.length >= 4) return;
    setPanes((prev) => [...prev, createPane(prev.length)]);
  };

  const handleRemovePane = async (pane: SerialPaneState) => {
    if (pane.connected && pane.sessionId) {
      await handleDisconnect(pane);
    }
    setPanes((prev) => {
      const filtered = prev.filter((p) => p.paneId !== pane.paneId);
      return filtered.length > 0 ? filtered : [createPane(0)];
    });
  };

  // Saved Log Browser helpers
  const loadLogList = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const entries = await invoke<SerialLogEntry[]>("serial_list_log_files");
      setLogFiles(Array.isArray(entries) ? entries : []);
    } catch (err) {
      onLog(`serial_list_log_files error: ${String(err)}`);
    } finally {
      setLoadingLogs(false);
    }
  }, [onLog]);

  useEffect(() => {
    if (subView === "logs") {
      loadLogList();
    }
  }, [subView, loadLogList]);

  const openLogFile = async (entry: SerialLogEntry) => {
    setSelectedLogFile(entry);
    setLoadingLogContent(true);
    try {
      const text = await invoke<string>("serial_read_log_file", {
        fileName: entry.file_name,
        tailLines: 1000,
      });
      setLogContent(text || "");
    } catch (err) {
      const msg = String(err);
      setLogContent(`Failed to read log: ${msg}`);
      onLog(`serial_read_log_file error: ${msg}`);
    } finally {
      setLoadingLogContent(false);
    }
  };

  const visiblePanes = useMemo(() => panes.filter((p) => !p.hidden), [panes]);
  const gridColsClass =
    visiblePanes.length <= 1
      ? "grid-cols-1"
      : visiblePanes.length === 2
      ? "grid-cols-1 xl:grid-cols-2"
      : "grid-cols-1 xl:grid-cols-2";

  const filteredLogText = useMemo(() => {
    if (!logSearch.trim()) return logContent;
    const q = logSearch.toLowerCase();
    return logContent
      .split("\n")
      .filter((l) => stripAnsi(l).toLowerCase().includes(q))
      .join("\n");
  }, [logContent, logSearch]);

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      {/* Top Toolbar */}
      <div className="ui-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <div className="ui-segmented">
            <button
              onClick={() => setSubView("live")}
              className={`ui-segmented-btn ${
                subView === "live"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              {t("serial.liveTab", { defaultValue: isEn ? "Live Multi-Pane" : "实时串口分屏" })}
            </button>
            <button
              onClick={() => setSubView("logs")}
              className={`ui-segmented-btn ${
                subView === "logs"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <History className="w-3.5 h-3.5" />
              {t("serial.logsTab", { defaultValue: isEn ? "Saved Logs" : "历史日志浏览" })}
            </button>
          </div>

          {activeWorkspace && (
            <div className="hidden md:flex items-center gap-2 pl-2 ml-1 border-l border-slate-200 dark:border-slate-700">
              <span className="text-xs px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-medium">
                {activeWorkspace.name} {activeWorkspace.chip ? `(${activeWorkspace.chip})` : ""}
              </span>
              {activeWorkspace.serial_ports.length > 0 && subView === "live" && (
                <>
                  <button
                    onClick={handleLoadFromWorkspace}
                    className="ui-btn-secondary py-1 px-2.5"
                  >
                    {isEn ? "Load Workspace Ports" : "载入工作区串口"}
                  </button>
                  <button
                    onClick={handleConnectAllWorkspace}
                    className="ui-btn-success py-1 px-2.5"
                  >
                    {isEn ? "Connect All" : "一键全连"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {subView === "live" ? (
          <div className="flex items-center gap-2">
            <button
              onClick={refreshPorts}
              disabled={loadingPorts}
              className="ui-btn-secondary"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingPorts ? "animate-spin" : ""}`} />
              {isEn ? "Refresh Ports" : "刷新串口"}
            </button>
            <button
              onClick={handleAddPane}
              disabled={panes.length >= 4}
              className="ui-btn-primary"
            >
              <Plus className="w-3.5 h-3.5" />
              {isEn ? `Add Pane (${panes.length}/4)` : `新增分屏 (${panes.length}/4)`}
            </button>
          </div>
        ) : (
          <button
            onClick={loadLogList}
            disabled={loadingLogs}
            className="ui-btn-secondary"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? "animate-spin" : ""}`} />
            {isEn ? "Refresh Logs" : "刷新日志列表"}
          </button>
        )}
      </div>

      {/* Live Multi-pane Serial Console */}
      {subView === "live" ? (
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          {visiblePanes.length === 0 ? (
            <div className="ui-card flex-1 flex flex-col items-center justify-center p-8 text-slate-500 dark:text-slate-400">
              <EyeOff className="w-8 h-8 mb-2 opacity-60" />
              <p className="text-sm">
                {isEn
                  ? "All serial panes are hidden. Click a pane chip below to show it."
                  : "当前所有分屏已隐藏，请点击下方状态栏芯片恢复显示。"}
              </p>
            </div>
          ) : (
            <div className={`flex-1 grid ${gridColsClass} gap-4 min-h-0 auto-rows-fr`}>
              {visiblePanes.map((pane) => {
                const displayLines = pane.lines
                  .filter((l) =>
                    !pane.filterOnly || !pane.searchQuery
                      ? true
                      : stripAnsi(l.text).toLowerCase().includes(pane.searchQuery.toLowerCase())
                  )
                  .map((l) => (pane.showTimestamps ? `[${l.ts}] ${l.text}` : l.text))
                  .join("\n");

                return (
                  <div
                    key={pane.paneId}
                    className="ui-card flex flex-col overflow-hidden min-h-[260px]"
                  >
                    {/* Pane Header */}
                    <div className="ui-card-header px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            pane.connected ? "bg-emerald-500 animate-pulse" : "bg-slate-400"
                          }`}
                        />
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 mr-1">
                          {pane.label}
                        </span>

                        <select
                          value={pane.portName}
                          disabled={pane.connected}
                          onChange={(e) => updatePane(pane.paneId, { portName: e.target.value })}
                          className="ui-select py-1 max-w-[160px] font-mono"
                        >
                          <option value="">{isEn ? "-- Port --" : "-- 选择串口 --"}</option>
                          {ports.map((p) => (
                            <option key={p.port_name} value={p.port_name}>
                              {p.port_name}
                              {p.product ? ` (${p.product})` : ""}
                            </option>
                          ))}
                          {pane.portName &&
                            !ports.some((p) => p.port_name === pane.portName) && (
                              <option value={pane.portName}>{pane.portName}</option>
                            )}
                        </select>

                        <select
                          value={pane.customBaud ? CUSTOM_BAUD : pane.baudRate}
                          disabled={pane.connected}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === CUSTOM_BAUD) {
                              updatePane(pane.paneId, { customBaud: true });
                            } else {
                              updatePane(pane.paneId, {
                                customBaud: false,
                                baudRate: Number(v),
                              });
                            }
                          }}
                          className="ui-select py-1 font-mono tabular-nums"
                        >
                          {BAUD_RATES.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                          <option value={CUSTOM_BAUD}>
                            {isEn ? "Custom..." : "自定义..."}
                          </option>
                        </select>

                        {pane.customBaud && (
                          <input
                            type="number"
                            min={1}
                            max={4000000}
                            value={pane.baudRate}
                            disabled={pane.connected}
                            onChange={(e) =>
                              updatePane(pane.paneId, {
                                baudRate: Math.max(1, Math.floor(Number(e.target.value) || 0)),
                              })
                            }
                            title={isEn ? "Custom baud rate" : "自定义波特率"}
                            className="ui-input w-24 py-1 font-mono tabular-nums border-blue-400 dark:border-blue-600"
                          />
                        )}

                        {pane.connected ? (
                          <button
                            onClick={() => handleDisconnect(pane)}
                            className="ui-btn-danger py-1 px-2.5"
                          >
                            <PlugZap className="w-3.5 h-3.5" />
                            {isEn ? "Disconnect" : "断开"}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleConnect(pane)}
                            disabled={pane.connecting}
                            className="ui-btn-success py-1 px-2.5"
                          >
                            <Plug className="w-3.5 h-3.5" />
                            {pane.connecting
                              ? isEn
                                ? "Opening..."
                                : "连接中..."
                              : isEn
                              ? "Connect"
                              : "连接"}
                          </button>
                        )}
                      </div>

                      {/* Pane Controls */}
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          onClick={() => handleToggleSignal(pane, "dtr")}
                          disabled={!pane.connected}
                          title="DTR"
                          className={`px-1.5 py-0.5 rounded-md text-[11px] font-mono border transition disabled:opacity-40 ${
                            pane.dtr
                              ? "bg-amber-500/20 border-amber-500 text-amber-600 dark:text-amber-300"
                              : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
                          }`}
                        >
                          DTR
                        </button>
                        <button
                          onClick={() => handleToggleSignal(pane, "rts")}
                          disabled={!pane.connected}
                          title="RTS"
                          className={`px-1.5 py-0.5 rounded-md text-[11px] font-mono border transition disabled:opacity-40 ${
                            pane.rts
                              ? "bg-amber-500/20 border-amber-500 text-amber-600 dark:text-amber-300"
                              : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
                          }`}
                        >
                          RTS
                        </button>

                        <button
                          onClick={() =>
                            updatePane(pane.paneId, { showTimestamps: !pane.showTimestamps })
                          }
                          title={isEn ? "Toggle Timestamps" : "时间戳开关"}
                          className={`p-1.5 rounded-md border transition ${
                            pane.showTimestamps
                              ? "bg-blue-500/15 border-blue-500/40 text-blue-600 dark:text-blue-400"
                              : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                          }`}
                        >
                          <Clock className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() =>
                            updatePane(pane.paneId, { ansiEnabled: !pane.ansiEnabled })
                          }
                          title={isEn ? "Toggle ANSI Colors" : "ANSI 彩色开关"}
                          className={`p-1.5 rounded-md border transition ${
                            pane.ansiEnabled
                              ? "bg-purple-500/15 border-purple-500/40 text-purple-600 dark:text-purple-400"
                              : "border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                          }`}
                        >
                          <Palette className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => updatePane(pane.paneId, { autoScroll: !pane.autoScroll })}
                          className={`px-1.5 py-0.5 rounded-md text-[11px] font-medium border transition ${
                            pane.autoScroll
                              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                              : "border-slate-200 dark:border-slate-700 text-slate-400"
                          }`}
                        >
                          {isEn ? "Scroll" : "滚屏"}
                        </button>

                        <button
                          onClick={() => updatePane(pane.paneId, { lines: [], endsWithNewline: true })}
                          title={isEn ? "Clear" : "清空"}
                          className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => handleExportLog(pane)}
                          title={isEn ? "Export .log" : "导出 .log"}
                          className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => updatePane(pane.paneId, { hidden: true })}
                          title={isEn ? "Hide Pane" : "隐藏分屏"}
                          className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition"
                        >
                          <EyeOff className="w-3.5 h-3.5" />
                        </button>

                        {panes.length > 1 && (
                          <button
                            onClick={() => handleRemovePane(pane)}
                            title={isEn ? "Close Pane" : "关闭分屏"}
                            className="p-1.5 rounded-md text-slate-400 hover:text-rose-500 transition"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Search Sub-bar */}
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900">
                      <div className="flex items-center gap-1.5 flex-1">
                        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <input
                          type="text"
                          value={pane.searchQuery}
                          onChange={(e) => updatePane(pane.paneId, { searchQuery: e.target.value })}
                          placeholder={isEn ? "Search / filter logs..." : "搜索或过滤串口输出..."}
                          className="w-full bg-transparent text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none"
                        />
                        {pane.searchQuery && (
                          <button
                            onClick={() => updatePane(pane.paneId, { searchQuery: "" })}
                            className="text-slate-400 hover:text-slate-600"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={pane.filterOnly}
                          onChange={(e) => updatePane(pane.paneId, { filterOnly: e.target.checked })}
                          className="rounded-md border-slate-300 dark:border-slate-700"
                        />
                        {isEn ? "Filter" : "仅看匹配"}
                      </label>
                    </div>

                    {/* Line coding / charset sub-bar (applied on next connect) */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        {isEn ? "Line" : "线路参数"}
                      </span>
                      <select
                        value={pane.coding.data_bits}
                        disabled={pane.connected}
                        onChange={(e) =>
                          updatePane(pane.paneId, {
                            coding: { ...pane.coding, data_bits: Number(e.target.value) },
                          })
                        }
                        title={isEn ? "Data bits" : "数据位"}
                        className="ui-select py-0.5 px-1.5 text-[11px] font-mono tabular-nums"
                      >
                        {DATA_BITS_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      <select
                        value={pane.coding.parity}
                        disabled={pane.connected}
                        onChange={(e) =>
                          updatePane(pane.paneId, {
                            coding: { ...pane.coding, parity: e.target.value },
                          })
                        }
                        title={isEn ? "Parity" : "校验位"}
                        className="ui-select py-0.5 px-1.5 text-[11px]"
                      >
                        {PARITY_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p === "none" ? (isEn ? "No parity" : "无校验") : p === "even" ? (isEn ? "Even" : "偶校验") : isEn ? "Odd" : "奇校验"}
                          </option>
                        ))}
                      </select>
                      <select
                        value={pane.coding.stop_bits}
                        disabled={pane.connected}
                        onChange={(e) =>
                          updatePane(pane.paneId, {
                            coding: { ...pane.coding, stop_bits: Number(e.target.value) },
                          })
                        }
                        title={isEn ? "Stop bits" : "停止位"}
                        className="ui-select py-0.5 px-1.5 text-[11px] font-mono tabular-nums"
                      >
                        {STOP_BITS_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n === 1 ? "1" : "2"}
                          </option>
                        ))}
                      </select>
                      <select
                        value={pane.coding.flow_control}
                        disabled={pane.connected}
                        onChange={(e) =>
                          updatePane(pane.paneId, {
                            coding: { ...pane.coding, flow_control: e.target.value },
                          })
                        }
                        title={isEn ? "Flow control" : "流控"}
                        className="ui-select py-0.5 px-1.5 text-[11px]"
                      >
                        {FLOW_CONTROL_OPTIONS.map((f) => (
                          <option key={f} value={f}>
                            {f === "none"
                              ? isEn
                                ? "No flow"
                                : "无流控"
                              : f === "software"
                              ? isEn
                                ? "XON/XOFF"
                                : "软流控"
                              : isEn
                              ? "RTS/CTS"
                              : "硬流控"}
                          </option>
                        ))}
                      </select>
                      <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        {isEn ? "Charset" : "字符集"}
                      </span>
                      <select
                        value={pane.charset}
                        onChange={(e) =>
                          updatePane(pane.paneId, { charset: e.target.value as Charset })
                        }
                        title={isEn ? "Receive charset (live)" : "接收字符集（实时生效）"}
                        className="ui-select py-0.5 px-1.5 text-[11px] font-mono"
                      >
                        {CHARSET_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>

                    {pane.error && (
                      <div className="px-3 py-2 text-xs bg-rose-500/10 text-rose-600 dark:text-rose-400 border-b border-rose-500/20">
                        {pane.error}
                      </div>
                    )}

                    {/* Output Terminal Area */}
                    <div
                      ref={(el) => {
                        scrollRefs.current[pane.paneId] = el;
                      }}
                      className="flex-1 overflow-auto p-3 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
                    >
                      {pane.lines.length === 0 ? (
                        <div className="text-xs text-slate-400 dark:text-slate-600 font-mono">
                          {pane.connected
                            ? isEn
                              ? "Connected. Waiting for serial data..."
                              : "已连接，等待串口数据..."
                            : isEn
                            ? "Select a port and click Connect."
                            : "请选择串口设备并点击连接。"}
                        </div>
                      ) : (
                        <AnsiText
                          text={displayLines}
                          showTimestamps={pane.showTimestamps}
                          ansiEnabled={pane.ansiEnabled}
                          searchQuery={pane.searchQuery}
                        />
                      )}
                    </div>

                    {/* Bottom Command Input */}
                    <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60">
                      <select
                        value={pane.lineEnding}
                        onChange={(e) =>
                          updatePane(pane.paneId, {
                            lineEnding: e.target.value as "\n" | "\r\n" | "",
                          })
                        }
                        className="ui-select font-mono"
                      >
                        <option value={"\n"}>\n</option>
                        <option value={"\r\n"}>\r\n</option>
                        <option value="">none</option>
                      </select>
                      <input
                        type="text"
                        value={pane.inputText}
                        disabled={!pane.connected}
                        onChange={(e) => updatePane(pane.paneId, { inputText: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSendCommand(pane);
                          } else if (e.key === "ArrowUp") {
                            if (pane.cmdHistory.length === 0) return;
                            e.preventDefault();
                            const nextIdx = Math.min(
                              pane.historyIndex + 1,
                              pane.cmdHistory.length - 1
                            );
                            updatePane(pane.paneId, {
                              historyIndex: nextIdx,
                              inputText: pane.cmdHistory[nextIdx],
                            });
                          } else if (e.key === "ArrowDown") {
                            if (pane.historyIndex < 0) return;
                            e.preventDefault();
                            const nextIdx = pane.historyIndex - 1;
                            updatePane(pane.paneId, {
                              historyIndex: nextIdx,
                              inputText: nextIdx >= 0 ? pane.cmdHistory[nextIdx] : "",
                            });
                          }
                        }}
                        placeholder={
                          pane.connected
                            ? isEn
                              ? "Type command and press Enter (Up/Down for history)..."
                              : "输入指令回车发送（上下键切换历史）..."
                            : isEn
                            ? "Connect serial port to send..."
                            : "连接串口后可发送指令..."
                        }
                        className="ui-input flex-1 font-mono"
                      />
                      <button
                        onClick={() => handleSendCommand(pane)}
                        disabled={!pane.connected}
                        className="ui-btn-primary shrink-0"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {isEn ? "Send" : "发送"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Bottom Pane Chip Bar */}
          <div className="ui-card flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mr-1">
              {isEn ? "Active Panes:" : "串口分屏:"}
            </span>
            {panes.map((pane) => (
              <div
                key={pane.paneId}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition ${
                  pane.connected
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    pane.connected ? "bg-emerald-500" : "bg-slate-400"
                  }`}
                />
                <span className="font-medium">{pane.label}</span>
                <span className="opacity-75 font-mono">
                  {pane.portName || (isEn ? "Unset" : "未选")}
                </span>
                <button
                  onClick={() => updatePane(pane.paneId, { hidden: !pane.hidden })}
                  title={pane.hidden ? (isEn ? "Show" : "显示") : isEn ? "Hide" : "隐藏"}
                  className="ml-1 hover:text-blue-500"
                >
                  {pane.hidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
                {pane.connected && (
                  <button
                    onClick={() => handleDisconnect(pane)}
                    title={isEn ? "Disconnect" : "断开"}
                    className="hover:text-rose-500"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Saved Log Browser */
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0">
          <div className="ui-card lg:col-span-4 xl:col-span-3 flex flex-col overflow-hidden">
            <div className="ui-card-header">
              <span className="ui-title">
                {isEn ? `Saved Log Files (${logFiles.length})` : `历史日志文件 (${logFiles.length})`}
              </span>
            </div>
            <div className="flex-1 overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
              {logFiles.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {loadingLogs
                    ? isEn
                      ? "Loading..."
                      : "加载中..."
                    : isEn
                    ? "No saved serial log files found."
                    : "暂无已保存的串口日志文件。"}
                </div>
              ) : (
                logFiles.map((entry) => {
                  const active = selectedLogFile?.file_name === entry.file_name;
                  return (
                    <button
                      key={entry.file_name}
                      onClick={() => openLogFile(entry)}
                      className={`w-full text-left px-3 py-2.5 transition flex items-start gap-2 ${
                        active
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-200"
                      }`}
                    >
                      <FileText className="w-4 h-4 mt-0.5 shrink-0 opacity-70" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono truncate">{entry.file_name}</div>
                        <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5 flex justify-between">
                          <span>{formatBytes(entry.size_bytes)}</span>
                          <span>{formatUnixSecs(entry.modified_secs)}</span>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="ui-card lg:col-span-8 xl:col-span-9 flex flex-col overflow-hidden min-h-0">
            <div className="ui-card-header">
              <div className="text-xs font-mono text-slate-700 dark:text-slate-200 truncate">
                {selectedLogFile
                  ? `${selectedLogFile.file_name} (${isEn ? "last 1000 lines" : "末尾 1000 行"})`
                  : isEn
                  ? "Select a log file on the left"
                  : "请在左侧选择一个日志文件"}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder={isEn ? "Filter lines..." : "过滤关键字..."}
                    className="ui-input pl-7 w-40"
                  />
                </div>
                <button
                  onClick={() => setLogShowTimestamps((v) => !v)}
                  className={`p-1.5 rounded-md border text-xs transition ${
                    logShowTimestamps
                      ? "bg-blue-500/15 border-blue-500/40 text-blue-600 dark:text-blue-400"
                      : "border-slate-200 dark:border-slate-700 text-slate-400"
                  }`}
                  title={isEn ? "Highlight timestamps" : "时间戳高亮"}
                >
                  <Clock className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setLogAnsi((v) => !v)}
                  className={`p-1.5 rounded-md border text-xs transition ${
                    logAnsi
                      ? "bg-purple-500/15 border-purple-500/40 text-purple-600 dark:text-purple-400"
                      : "border-slate-200 dark:border-slate-700 text-slate-400"
                  }`}
                  title={isEn ? "ANSI Color" : "ANSI 彩色"}
                >
                  <Palette className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100">
              {loadingLogContent ? (
                <div className="text-xs text-slate-400 font-mono">
                  {isEn ? "Loading log..." : "正在读取日志..."}
                </div>
              ) : selectedLogFile ? (
                <AnsiText
                  text={filteredLogText}
                  showTimestamps={logShowTimestamps}
                  ansiEnabled={logAnsi}
                  searchQuery={logSearch}
                />
              ) : (
                <div className="text-xs text-slate-400 font-mono">
                  {isEn ? "No file selected." : "未选择日志文件。"}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
