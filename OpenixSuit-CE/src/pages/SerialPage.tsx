import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Cable,
  ChevronDown,
  ChevronUp,
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
  Settings2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { adbDeviceKey, adbDeviceOnline, adbSerialAmbiguous, resolveAdbDevice, type AdbDevice } from "../components/TopBar";
import {
  DeviceWorkspace,
  LogProfile,
  LogProfileSource,
  LogSession,
  LogSessionChange,
  SerialDataPayload,
  SerialCharset,
  SerialFormat,
  SerialLineCoding,
  SerialLineEnding,
  SerialLogEntry,
  SerialPortInfo,
  SerialSessionInfo,
  SerialViewOptions,
} from "../types/workbench";
import { AnsiText, stripAnsi } from "../utils/ansi";
import { configuredHighlightRules, detectLogLevelFormat, type LogHighlightRule } from "../utils/logHighlight";
import { useAdbLogOutput, type AdbLogStream } from "./useAdbLogOutput";
import { SerialBridgePanel, type BridgeSettingsHandle } from "./SerialBridgePanel";
import { LogProfileControls } from "./LogProfileControls";
import { BAUD_RATES, SerialPaneSettings } from "./SerialPaneSettings";
import { PaneSettingsPopover } from "./PaneSettingsPopover";
import { LogColorSettings } from "./LogColorSettings";
import { useLogColorSettings } from "../store/logColors";
import { LogCaptureSettings } from "./LogCaptureSettings";
import { layoutPatch, panePatch, sharedHighlightPatch, paneSettings as cliPaneSettings, settingsObject, type LogUiRequest } from "./logUiPaneSettings";
import { appendHexRows, hexToBase64, SERIAL_LINE_SUFFIX, type BufferedLine } from "./serialFormats";
import { findSerialPort, portHasName, readSerialPortBinding, type SerialPortBinding } from "./serialPortBinding";

interface SerialPageProps {
  activeWorkspace?: DeviceWorkspace | null;
  adbDevices: AdbDevice[];
  selectedAdbSerial: string;
  onRefreshDevices: () => Promise<unknown>;
  onLog: (msg: string) => void;
}

type LogPanePanel = "search" | "command";

export interface SerialPaneState {
  paneId: string;
  label?: string;
  source: "serial" | "adb";
  adbSerial: string;
  adbCommand: string;
  lastAdbStream?: AdbLogStream;
  portName: string;
  connectedPortName?: string;
  serialBinding?: SerialPortBinding;
  baudRate: number;
  customBaud: boolean;
  coding: SerialLineCoding;
  charset: SerialCharset;
  receiveFormat: SerialFormat;
  sendFormat: SerialFormat;
  sessionId: string | null;
  connected: boolean;
  resumeConnected: boolean;
  connecting: boolean;
  stopping: boolean;
  dtr: boolean;
  rts: boolean;
  hidden: boolean;
  panel?: LogPanePanel;
  showTimestamps: boolean;
  ansiEnabled: boolean;
  highlightRules: LogHighlightRule[];
  levelColors: boolean;
  autoScroll: boolean;
  followPaused: boolean;
  followNewLines: number;
  filterOnly: boolean;
  searchQuery: string;
  lineEnding: SerialLineEnding;
  inputText: string;
  cmdHistory: Record<SerialFormat, string[]>;
  historyIndex: number;
  lines: BufferedLine[];
  hexRows: BufferedLine[];
  endsWithNewline: boolean;
  error: string | null;
}

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const decodeChunk = (bytes: Uint8Array, charset: SerialCharset): string => {
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
const LOG_COLUMNS_KEY = "openix_log_columns";
const LOG_PANES_KEY = "openix_log_panes_v1";

const PANE_SETTING_KEYS = [
  "paneId", "label", "source", "adbSerial", "adbCommand", "portName", "serialBinding", "baudRate", "customBaud",
  "coding", "charset", "receiveFormat", "sendFormat", "hidden", "showTimestamps",
  "ansiEnabled", "highlightRules", "levelColors", "autoScroll", "filterOnly", "searchQuery", "lineEnding", "resumeConnected",
] as const satisfies readonly (keyof SerialPaneState)[];

function loadPaneSettings(): SerialPaneState[] | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LOG_PANES_KEY) ?? "null");
    if (!Array.isArray(saved)) return null;
    const ids = new Set<string>();
    return saved.flatMap((item) => {
      if (!item || (item.source !== "serial" && item.source !== "adb")) return [];
      const values = Object.fromEntries(PANE_SETTING_KEYS.filter((key) => key in item).map((key) => [key, item[key]]));
      const { paneId, ...settings } = values;
      const pane = { ...createPane(), ...settings };
      if (typeof paneId === "string" && paneId && !ids.has(paneId)) pane.paneId = paneId;
      ids.add(pane.paneId);
      pane.resumeConnected = values.resumeConnected === true;
      return [pane];
    });
  } catch {
    return null;
  }
}

function serializePaneSettings(panes: SerialPaneState[]): string {
  return JSON.stringify(panes.map((pane) =>
    Object.fromEntries(PANE_SETTING_KEYS.map((key) => [key, pane[key]]))
  ));
}

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

function createPane(portName = "", baudRate = 115200, label?: string): SerialPaneState {
  return {
    paneId: `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    source: "serial",
    adbSerial: "",
    adbCommand: "",
    portName,
    baudRate,
    customBaud: !BAUD_RATES.includes(baudRate),
    coding: defaultCoding(),
    charset: "utf-8",
    receiveFormat: "text",
    sendFormat: "text",
    sessionId: null,
    connected: false,
    resumeConnected: false,
    connecting: false,
    stopping: false,
    dtr: false,
    rts: false,
    hidden: false,
    showTimestamps: true,
    ansiEnabled: true,
    highlightRules: [],
    levelColors: true,
    autoScroll: true,
    followPaused: false,
    followNewLines: 0,
    filterOnly: false,
    searchQuery: "",
    lineEnding: "lf",
    inputText: "",
    cmdHistory: { text: [], hex: [] },
    historyIndex: -1,
    lines: [],
    hexRows: [],
    endsWithNewline: true,
    error: null,
  };
}

function serialViewOptions(pane: SerialPaneState): SerialViewOptions {
  return {
    receive_format: pane.receiveFormat,
    send_format: pane.sendFormat,
    charset: pane.charset,
    line_ending: pane.lineEnding,
    auto_scroll: pane.autoScroll,
  };
}

function loadSerialView(options?: SerialViewOptions): Partial<SerialPaneState> {
  if (!options) return {};
  return {
    receiveFormat: options.receive_format,
    sendFormat: options.send_format,
    charset: options.charset,
    lineEnding: options.line_ending,
    autoScroll: options.auto_scroll,
  };
}

function paneLines(pane: SerialPaneState): BufferedLine[] {
  return pane.source === "serial" && pane.receiveFormat === "hex" ? pane.hexRows : pane.lines;
}

function createProfilePane(source: LogProfileSource): SerialPaneState {
  if (source.type === "serial") {
    const pane = createPane(source.port_name, source.baud_rate, source.label);
    return {
      ...pane,
      coding: source.line_coding ?? pane.coding,
      ...loadSerialView(source.serial_options),
      highlightRules: source.highlight_rules ?? [],
      levelColors: source.level_colors ?? true,
    };
  }
  const pane = { ...createPane("", 115200, source.label), source: "adb" as const, adbSerial: source.serial, adbCommand: source.command };
  return { ...pane, highlightRules: source.highlight_rules ?? [], levelColors: source.level_colors ?? true };
}

function normalizeAdbCommand(command: string): string {
  return command.trim().replace(/^adb\s+(?:shell\s+|(?=logcat(?:\s|$)))/, "");
}

function adbTarget(value: string, devices: AdbDevice[]): string {
  const device = resolveAdbDevice(value, devices);
  return device ? adbDeviceKey(device) : value;
}

function matchesProfilePane(
  pane: SerialPaneState,
  profilePane: SerialPaneState,
  selectedAdbSerial: string,
  adbDevices: AdbDevice[],
): boolean {
  if (pane.source !== profilePane.source) return false;
  return pane.source === "serial"
    ? pane.portName === profilePane.portName && pane.baudRate === profilePane.baudRate
    : adbTarget(pane.adbSerial || selectedAdbSerial, adbDevices) === adbTarget(profilePane.adbSerial, adbDevices) &&
        normalizeAdbCommand(pane.adbCommand) === normalizeAdbCommand(profilePane.adbCommand);
}

function emptyPane(pane: SerialPaneState): boolean {
  return pane.source === "serial" && !pane.label && !pane.portName && !pane.sessionId &&
    !pane.adbSerial && !pane.adbCommand && !pane.connecting && !pane.stopping && !pane.error &&
    !pane.lines.length && !pane.hexRows.length;
}

function attachLogSession(
  panes: SerialPaneState[],
  session: LogSession,
  selectedAdbSerial: string,
  ports: SerialPortInfo[],
  adbDevices: AdbDevice[],
): SerialPaneState[] {
  let index = panes.findIndex((pane) => pane.sessionId === session.id);
  const sourcePane = createProfilePane({ ...session, label: session.label || "" });
  const livePort = session.type === "serial" ? findSerialPort(ports, session.port_name) : undefined;
  if (index < 0) {
    const matches = (pane: SerialPaneState) => {
      if (pane.sessionId || pane.connecting || pane.stopping) return false;
      if (session.type === "serial" && livePort) {
        return pane.source === "serial" && pane.baudRate === session.baud_rate &&
          findSerialPort(ports, pane.portName, pane.serialBinding) === livePort;
      }
      return matchesProfilePane(pane, sourcePane, selectedAdbSerial, adbDevices);
    };
    index = panes.findIndex((pane) => pane.resumeConnected && matches(pane));
    if (index < 0) index = panes.findIndex(matches);
  }
  if (index < 0) index = panes.findIndex((pane) => emptyPane(pane) && !pane.panel);

  const existing = panes[index];
  const next = {
    ...sourcePane,
    ...existing,
    label: existing?.label || session.label || undefined,
    source: sourcePane.source,
    sessionId: session.id,
    connected: true,
    resumeConnected: true,
    connecting: false,
    error: null,
    ...(session.type === "serial"
      ? {
          portName: existing?.portName || sourcePane.portName,
          connectedPortName: sourcePane.portName,
          serialBinding: existing?.serialBinding ?? readSerialPortBinding(livePort),
          baudRate: sourcePane.baudRate,
          customBaud: sourcePane.customBaud,
          coding: session.line_coding ?? existing?.coding ?? sourcePane.coding,
          ...((!existing || emptyPane(existing)) && loadSerialView(session.serial_options)),
        }
      : {
          adbSerial: sourcePane.adbSerial,
          adbCommand: existing?.adbCommand || sourcePane.adbCommand,
          ...(existing?.sessionId !== session.id && {
            lines: [],
            endsWithNewline: true,
            lastAdbStream: undefined,
          }),
        }),
    ...((!existing || emptyPane(existing)) && session.display_options && {
      highlightRules: session.display_options.highlight_rules,
      levelColors: session.display_options.level_colors,
    }),
  };
  return index < 0 ? [...panes, next] : panes.map((pane, i) => i === index ? next : pane);
}

function endLogSession(
  panes: SerialPaneState[],
  sessionId: string,
  error?: string | null,
  interrupted = false
): SerialPaneState[] {
  return panes.map((pane) => pane.sessionId === sessionId ? {
    ...pane, sessionId: null, connected: false, connecting: false, stopping: false,
    resumeConnected: interrupted && !pane.stopping,
    connectedPortName: undefined, dtr: false, rts: false, error: error || null,
  } : pane);
}

function adbDeviceAvailable(devices: AdbDevice[], serial: string): boolean {
  return adbDeviceOnline(resolveAdbDevice(serial, devices));
}

function appendChunkToLines(
  prevLines: BufferedLine[],
  endsWithNewline: boolean,
  chunk: string,
  timestamp: string
): { lines: BufferedLine[]; endsWithNewline: boolean; addedLines: number } {
  if (!chunk) return { lines: prevLines, endsWithNewline, addedLines: 0 };
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

  let addedLines = 0;
  for (let i = startIdx; i < parts.length; i++) {
    // Skip trailing empty segment after final newline until real chars arrive
    if (i === parts.length - 1 && parts[i] === "") {
      continue;
    }
    next.push({ ts, text: parts[i] });
    addedLines++;
  }

  const ended = normalized.endsWith("\n");
  const trimmed =
    next.length > MAX_BUFFER_LINES ? next.slice(next.length - MAX_BUFFER_LINES) : next;

  return { lines: trimmed, endsWithNewline: ended, addedLines };
}

export function SerialPage({
  activeWorkspace,
  adbDevices,
  selectedAdbSerial,
  onRefreshDevices,
  onLog,
}: SerialPageProps) {
  const { t, i18n } = useTranslation();
  const { rules: sharedHighlightRules, save: saveSharedHighlightRules } = useLogColorSettings();
  const isEn = i18n.language.startsWith("en");

  const [subView, setSubView] = useState<"live" | "logs" | "bridge" | "settings">("live");
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const bridgeSettingsRef = useRef<BridgeSettingsHandle>(null);
  const [paneSettings, setPaneSettings] = useState<{ paneId: string; anchor: HTMLButtonElement } | null>(null);
  const paneSettingsId = useId();
  const closePaneSettings = useCallback(() => setPaneSettings(null), []);
  useEffect(() => {
    if (subView !== "live") closePaneSettings();
  }, [subView, closePaneSettings]);
  const [bridgeSettingsHost, setBridgeSettingsHost] = useState<HTMLDivElement | null>(null);
  const showBridgeSettings = useRef(false);
  useLayoutEffect(() => {
    if (subView !== "settings" || !bridgeSettingsHost || !showBridgeSettings.current) return;
    showBridgeSettings.current = false;
    bridgeSettingsHost.scrollIntoView({ block: "start", inline: "nearest" });
    bridgeSettingsHost.focus({ preventScroll: true });
  }, [bridgeSettingsHost, subView]);
  const [enlargedPaneId, setEnlargedPaneId] = useState<string | null>(null);
  const [columnCount, setColumnCount] = useState(() => {
    const saved = Number(localStorage.getItem(LOG_COLUMNS_KEY));
    return saved === 3 || saved === 4 ? saved : 2;
  });
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [refreshingDevices, setRefreshingDevices] = useState(false);

  const [panes, setPanes] = useState<SerialPaneState[]>(() => {
    const saved = loadPaneSettings();
    if (saved) return saved;
    if (activeWorkspace?.serial_ports?.length) {
      return activeWorkspace.serial_ports.map(
        (slot) => createPane(slot.port_name, slot.baud_rate || 115200, slot.label)
      );
    }
    return [createPane()];
  });

  const paneSettingsSnapshot = serializePaneSettings(panes);
  useLayoutEffect(() => {
    try {
      if (localStorage.getItem(LOG_PANES_KEY) !== paneSettingsSnapshot) {
        localStorage.setItem(LOG_PANES_KEY, paneSettingsSnapshot);
      }
    } catch (error) {
      onLog(`Failed to save log pane settings: ${String(error)}`);
    }
  }, [paneSettingsSnapshot, onLog]);

  // Saved Log Browser state
  const [logFiles, setLogFiles] = useState<SerialLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [selectedLogFile, setSelectedLogFile] = useState<SerialLogEntry | null>(null);
  const [logContent, setLogContent] = useState("");
  const [loadingLogContent, setLoadingLogContent] = useState(false);
  const logReadRevision = useRef(0);
  const [logSearch, setLogSearch] = useState("");
  const [logAnsi, setLogAnsi] = useState(true);
  const [logShowTimestamps, setLogShowTimestamps] = useState(true);

  const scrollRefs = useRef<Record<string, HTMLDivElement>>({});
  const formatScrollPositions = useRef<Record<string, Partial<Record<SerialFormat, number>>>>({});
  const searchMatchPositions = useRef<Record<string, number>>({});
  const pendingFormatScroll = useRef(new Map<string, symbol>());
  const gridRef = useRef<HTMLDivElement>(null);
  const gridScrollBeforeEnlarge = useRef<number | null>(null);
  const newPaneId = useRef<string | null>(null);
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const selectedAdbSerialRef = useRef(selectedAdbSerial);
  selectedAdbSerialRef.current = selectedAdbSerial;
  const adbDevicesRef = useRef(adbDevices);
  adbDevicesRef.current = adbDevices;
  const pendingSessionSnapshot = useRef<Set<string> | null>(null);
  const restoreSerialRef = useRef<(ports: SerialPortInfo[]) => void>(() => {});
  const serialRestoreAttempts = useRef(new Map<string, string>());
  const restoreAdbRef = useRef<(devices: AdbDevice[]) => void>(() => {});
  const cliSettingsHandler = useRef<(request: LogUiRequest) => Promise<unknown>>(async () => null);

  const refreshPorts = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingPorts(true);
    try {
      const list = await invoke<SerialPortInfo[]>("serial_list_ports");
      setPorts(Array.isArray(list) ? list : []);
    } catch (err) {
      if (!quiet) onLog(`serial_list_ports error: ${String(err)}`);
    } finally {
      if (!quiet) setLoadingPorts(false);
    }
  }, [onLog]);

  const syncExistingSessions = useCallback(async () => {
    const changedIds = new Set<string>();
    pendingSessionSnapshot.current = changedIds;
    try {
      const sessions = await invoke<LogSession[]>("log_sessions_list");
      if (!Array.isArray(sessions) || pendingSessionSnapshot.current !== changedIds) return false;
      // 先收到的实时事件比会话列表的快照更新，优先采用实时状态。
      const unchanged = sessions.filter((session) => !changedIds.has(session.id));
      flushSync(() => setPanes((prev) => unchanged.reduce(
        (next, session) => attachLogSession(next, session, selectedAdbSerialRef.current, portsRef.current, adbDevicesRef.current), prev
      )));
      return true;
    } catch (error) {
      onLog(`log_sessions_list error: ${String(error)}`);
      return false;
    } finally {
      if (pendingSessionSnapshot.current === changedIds) pendingSessionSnapshot.current = null;
    }
  }, [onLog]);

  const refreshExistingSessions = useCallback(async () => {
    await syncExistingSessions();
  }, [syncExistingSessions]);

  useEffect(() => {
    refreshPorts();
  }, [refreshPorts]);

  const waitingForSerial = panes.some((pane) => pane.source === "serial" && pane.resumeConnected && !pane.connected);
  useEffect(() => {
    if (!sessionsLoaded || !waitingForSerial) return;
    void refreshPorts(true);
    const timer = setInterval(() => void refreshPorts(true), 3000);
    return () => clearInterval(timer);
  }, [refreshPorts, sessionsLoaded, waitingForSerial]);

  useEffect(() => {
    setPanes((current) => {
      const learned = current.map((pane) => {
        if (pane.source !== "serial" || !pane.connectedPortName || pane.serialBinding) return pane;
        const binding = readSerialPortBinding(findSerialPort(ports, pane.connectedPortName));
        return binding ? { ...pane, serialBinding: binding } : pane;
      });
      return learned.some((pane, index) => pane !== current[index]) ? learned : current;
    });
    if (sessionsLoaded) restoreSerialRef.current(ports);
  }, [ports, sessionsLoaded]);

  const refreshSources = async () => {
    setRefreshingDevices(true);
    try {
      await Promise.all([refreshPorts(), onRefreshDevices()]);
    } finally {
      setRefreshingDevices(false);
    }
  };

  // Charset decoder state per pane (TextDecoder keeps incomplete multibyte
  // trailing bytes between chunks internally via stream: true)
  const decoderRefs = useRef<Record<string, { decoder: TextDecoder | null; charset: SerialCharset }>>({});

  const getDecoder = (paneId: string, charset: SerialCharset) => {
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

  const clearDecoder = useCallback((paneId: string) => {
    delete decoderRefs.current[paneId];
  }, []);

  // Listen to serial-data events
  useEffect(() => {
    const listener = listen<SerialDataPayload>("serial-data", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setPanes((prev) =>
        prev.map((pane) => {
          if (pane.source !== "serial" || pane.sessionId !== payload.session_id) return pane;
          // Prefer raw bytes decoded with the pane charset; fall back to backend lossy chunk.
          let text = payload.chunk;
          let hexRows = pane.hexRows;
          if (payload.data_base64 && payload.data_base64.length > 0) {
            try {
              const bytes = b64ToBytes(payload.data_base64);
              hexRows = appendHexRows(hexRows, bytes, payload.timestamp ? payload.timestamp.slice(0, 12) : formatNowTime());
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
            hexRows,
            endsWithNewline: updated.endsWithNewline,
            followNewLines: pane.followPaused
              ? pane.followNewLines + updated.addedLines
              : 0,
          };
        })
      );
    });
    return () => {
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const onAdbChunk = useCallback((id: string, text: string, timestamp: string, stream: AdbLogStream) => {
    setPanes((prev) => prev.map((pane) => {
      if (pane.source !== "adb" || pane.sessionId !== id) return pane;
      const startsAnotherStream = pane.lastAdbStream !== undefined && pane.lastAdbStream !== stream;
      const updated = appendChunkToLines(
        pane.lines,
        pane.endsWithNewline || startsAnotherStream,
        text,
        timestamp
      );
      return {
        ...pane,
        ...updated,
        lastAdbStream: stream,
        followNewLines: pane.followPaused
          ? pane.followNewLines + updated.addedLines
          : 0,
      };
    }));
  }, []);

  const adbOutput = useAdbLogOutput(onAdbChunk);

  useEffect(() => {
    let mounted = true;
    const subscription = listen<LogSessionChange>("log-sessions-changed", ({ payload }) => {
      if (!mounted) return;
      const { kind, session, error } = payload;
      pendingSessionSnapshot.current?.add(session.id);
      if (kind === "started") {
        flushSync(() => setPanes((prev) => attachLogSession(
          prev, session, selectedAdbSerialRef.current, portsRef.current, adbDevicesRef.current,
        )));
        return;
      }
      const pane = panesRef.current.find((item) => item.sessionId === session.id);
      if (pane?.source === "serial") clearDecoder(pane.paneId);
      const interrupted = kind === "interrupted";
      flushSync(() => setPanes((prev) => endLogSession(prev, session.id, interrupted ? null : error, interrupted)));
    });
    void subscription.catch(() => {}).then(async () => {
      if (!mounted) return;
      if (await syncExistingSessions() && mounted) setSessionsLoaded(true);
    });
    return () => {
      mounted = false;
      pendingSessionSnapshot.current = null;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [clearDecoder, syncExistingSessions]);

  useEffect(() => {
    if (sessionsLoaded && adbOutput.ready) restoreAdbRef.current(adbDevices);
  }, [adbDevices, adbOutput.ready, sessionsLoaded]);

  useEffect(() => {
    let mounted = true;
    let queue = Promise.resolve();
    const subscription = listen<LogUiRequest>("log-ui-request", ({ payload }) => {
      queue = queue.then(async () => {
        if (!mounted) return;
        let value: unknown = null;
        let error: string | null = null;
        try {
          value = await cliSettingsHandler.current(payload);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        await invoke("log_ui_reply", { id: payload.id, value, error });
      }).catch((error) => onLog(`log_ui_reply error: ${String(error)}`));
    });
    void subscription.catch((error) => onLog(`log-ui-request error: ${String(error)}`));
    return () => {
      mounted = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [onLog]);

  useLayoutEffect(() => {
    for (const pane of panes) {
      const el = scrollRefs.current[pane.paneId];
      if (!el || pane.hidden || !el.clientHeight) continue;
      const pendingFormat = pendingFormatScroll.current.get(pane.paneId);
      if (pendingFormat) {
        if (!pane.autoScroll || pane.followPaused) {
          el.scrollTop = formatScrollPositions.current[pane.paneId]?.[pane.receiveFormat] ?? 0;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (pendingFormatScroll.current.get(pane.paneId) === pendingFormat) {
            pendingFormatScroll.current.delete(pane.paneId);
          }
        }));
      }
      if (pane.autoScroll && !pane.followPaused) {
        el.scrollTop = el.scrollHeight;
      }
    }
    if (newPaneId.current && panes.some((pane) => pane.paneId === newPaneId.current)) {
      const grid = gridRef.current;
      if (grid) grid.scrollTop = grid.scrollHeight;
      newPaneId.current = null;
    }
  }, [panes, enlargedPaneId, subView]);

  const updatePane = useCallback((paneId: string, patch: Partial<SerialPaneState>) => {
    setPanes((prev) => prev.map((p) => (p.paneId === paneId ? { ...p, ...patch } : p)));
  }, []);

  const rememberReceivePosition = (pane: SerialPaneState) => {
    const element = scrollRefs.current[pane.paneId];
    if (element?.clientHeight) {
      const positions = formatScrollPositions.current[pane.paneId] ?? {};
      positions[pane.receiveFormat] = element.scrollTop;
      formatScrollPositions.current[pane.paneId] = positions;
    }
  };

  const handleReceiveScroll = (pane: SerialPaneState, element: HTMLDivElement) => {
    if (!pane.autoScroll || pendingFormatScroll.current.has(pane.paneId)) return;
    const scrollable = element.scrollHeight > element.clientHeight;
    if (!scrollable) return;
    const paused = element.scrollHeight - element.clientHeight - element.scrollTop > 3;
    if (paused !== pane.followPaused) updatePane(pane.paneId, { followPaused: paused, ...(paused ? {} : { followNewLines: 0 }) });
  };

  const jumpToLatest = (pane: SerialPaneState) => {
    const element = scrollRefs.current[pane.paneId];
    if (element) element.scrollTop = element.scrollHeight;
    if (pane.followPaused) updatePane(pane.paneId, { followPaused: false, followNewLines: 0 });
  };

  const findMatch = (pane: SerialPaneState, direction: -1 | 1) => {
    const query = pane.searchQuery.trim().toLowerCase();
    if (!query) return;
    const matchingIndexes = paneLines(pane).flatMap((line, index) =>
      stripAnsi(line.text).toLowerCase().includes(query) ? [index] : []
    );
    if (!matchingIndexes.length) return;
    const current = searchMatchPositions.current[pane.paneId] ?? (direction > 0 ? -1 : 0);
    const next = (current + direction + matchingIndexes.length) % matchingIndexes.length;
    searchMatchPositions.current[pane.paneId] = next;
    const line = scrollRefs.current[pane.paneId]?.querySelector<HTMLElement>(`[data-log-line="${matchingIndexes[next]}"]`);
    line?.scrollIntoView({ block: "center" });
  };

  const handleLoadLogProfile = (profile: LogProfile) => {
    if (!bridgeSettingsRef.current?.loadProfile(profile)) {
      throw new Error(t("multiLog.profiles.stopBridgeToLoad"));
    }
    const profilePanes = profile.sources.map((source) => {
      const pane = createProfilePane(source);
      return source.type === "adb" ? { ...pane, adbSerial: adbTarget(source.serial, adbDevices) } : pane;
    });
    setPanes((previous) => {
      const next = [...previous];
      for (const [index, profilePane] of profilePanes.entries()) {
        const source = profile.sources[index];
        const matches = (pane: SerialPaneState) => matchesProfilePane(pane, profilePane, selectedAdbSerial, adbDevices);
        const activeIndex = next.findIndex((pane) => (pane.sessionId !== null || pane.connecting) && matches(pane));
        const matchingIndex = activeIndex >= 0 ? activeIndex : next.findIndex(matches);
        if (matchingIndex >= 0) {
          const pane = next[matchingIndex];
          next[matchingIndex] = {
            ...pane,
            label: profilePane.label,
            highlightRules: profilePane.highlightRules,
            levelColors: profilePane.levelColors,
            ...(pane.source === "adb" && { adbSerial: profilePane.adbSerial }),
            ...(source.type === "serial" && {
              ...loadSerialView(source.serial_options),
              ...(!pane.sessionId && source.line_coding && { coding: source.line_coding }),
            }),
          };
        } else {
          const emptyIndex = next.findIndex(emptyPane);
          if (emptyIndex >= 0) next[emptyIndex] = profilePane;
          else next.push(profilePane);
        }
      }
      return next;
    });
    onLog(t("multiLog.profiles.loaded", { name: profile.name }));
  };

  const handleLoadFromWorkspace = () => {
    if (!activeWorkspace?.serial_ports?.length) return;
    setPanes((prev) => {
      const next = prev.filter((p) => p.source === "adb" || p.connected || p.connecting || p.stopping);
      for (const slot of activeWorkspace.serial_ports) {
        const already = next.some((p) => p.source === "serial" && p.portName === slot.port_name);
        if (!already) {
          next.push(createPane(slot.port_name, slot.baud_rate || 115200, slot.label));
        }
      }
      return next.length > 0 ? next : [createPane()];
    });
    onLog(
      isEn
        ? `Loaded serial slots from workspace "${activeWorkspace.name}"`
        : `已从工作区「${activeWorkspace.name}」加载串口配置`
    );
  };

  const handleConnect = async (pane: SerialPaneState, restorePort?: SerialPortInfo) => {
    if (pane.source !== "serial" || pane.connected || pane.connecting) return;
    const port = restorePort && !portHasName(restorePort, pane.portName) ? restorePort.port_name : pane.portName;
    if (!port) {
      updatePane(pane.paneId, {
        resumeConnected: false,
        error: isEn ? "Please select a serial port" : "请先选择串口设备",
      });
      return;
    }
    const requestedId = `serial-${pane.paneId}-${Date.now()}`;
    clearDecoder(pane.paneId);
    updatePane(pane.paneId, { connecting: true, error: null, sessionId: requestedId, panel: undefined });
    try {
      const session = await invoke<SerialSessionInfo>("serial_open", {
        sessionId: requestedId,
        portName: port,
        baudRate: pane.baudRate,
        lineCoding: pane.coding,
        serialOptions: serialViewOptions(pane),
      });
      setPanes((prev) => prev.map((current) => current.sessionId === requestedId ? {
        ...current, sessionId: session.id, connected: true, connecting: false,
        connectedPortName: session.port_name, baudRate: session.baud_rate, resumeConnected: true,
      } : current));
      if (panesRef.current.some((current) => current.sessionId === requestedId)) {
        serialRestoreAttempts.current.delete(pane.paneId);
      }
      onLog(
        isEn
          ? `Serial opened: ${port} @ ${pane.baudRate}`
          : `串口已连接: ${port} @ ${pane.baudRate}`
      );
    } catch (err) {
      const msg = String(err);
      setPanes((prev) => endLogSession(prev, requestedId, msg, !!restorePort));
      onLog(`serial_open error: ${msg}`);
    }
  };

  cliSettingsHandler.current = async ({ action, params }) => {
    const values = settingsObject(params, action);
    const bridge = bridgeSettingsRef.current;
    if (!bridge) throw new Error("Log settings are still loading");

    let columns = columnCount;
    let highlightRules = sharedHighlightRules;
    switch (action) {
      case "get":
        if (Object.keys(values).length) throw new Error("get does not accept settings");
        break;
      case "pane-set": {
        if (typeof values.pane_id !== "string" || !values.pane_id) {
          throw new Error("pane_id must be a nonempty pane ID");
        }
        const pane = panesRef.current.find((item) => item.paneId === values.pane_id);
        if (!pane) throw new Error(`Unknown pane: ${values.pane_id}`);
        const patch = panePatch(values, pane, BAUD_RATES);
        const apply = (current: SerialPaneState[]) =>
          current.map((item) => item.paneId === pane.paneId ? { ...item, ...patch } : item);
        localStorage.setItem(LOG_PANES_KEY, serializePaneSettings(apply(panesRef.current)));
        if (patch.receiveFormat && patch.receiveFormat !== pane.receiveFormat) {
          rememberReceivePosition(pane);
          pendingFormatScroll.current.set(pane.paneId, Symbol());
        }
        if (patch.source && patch.source !== pane.source) clearDecoder(pane.paneId);
        flushSync(() => {
          setPanes(apply);
          if (patch.hidden) {
            setEnlargedPaneId((current) => current === pane.paneId ? null : current);
            setPaneSettings((current) => current?.paneId === pane.paneId ? null : current);
          }
        });
        break;
      }
      case "layout-set": {
        const patch = layoutPatch(values, panesRef.current);
        if (patch.columns !== undefined) {
          columns = patch.columns;
          localStorage.setItem(LOG_COLUMNS_KEY, String(columns));
        }
        const order = patch.order;
        const reorder = (current: SerialPaneState[]) => {
          const byId = new Map(current.map((pane) => [pane.paneId, pane]));
          return [...(order ?? []).flatMap((id) => {
            const pane = byId.get(id);
            byId.delete(id);
            return pane ? [pane] : [];
          }), ...byId.values()];
        };
        if (order) localStorage.setItem(LOG_PANES_KEY, serializePaneSettings(reorder(panesRef.current)));
        flushSync(() => {
          if (patch.columns !== undefined) setColumnCount(columns);
          if (order) setPanes(reorder);
        });
        break;
      }
      case "highlight-set":
        highlightRules = sharedHighlightPatch(values);
        flushSync(() => saveSharedHighlightRules(highlightRules));
        break;
      case "bridge-set":
        await bridge.setSettings(values);
        break;
      default:
        throw new Error(`Unknown log settings action: ${action}`);
    }
    return {
      panes: panesRef.current.map(cliPaneSettings), columns, bridge: bridge.getSettings(),
      shared_highlight_rules: configuredHighlightRules(highlightRules),
    };
  };

  const adbDeviceForPane = (pane: SerialPaneState) =>
    adbTarget(pane.adbSerial || selectedAdbSerial, adbDevices);

  const handleStartAdb = async (pane: SerialPaneState, serial = adbDeviceForPane(pane)) => {
    const command = pane.adbCommand.trim();
    if (!serial || !command || !adbOutput.ready || pane.sessionId) return;
    const sessionId = `adb-log-${pane.paneId}-${Date.now()}`;
    updatePane(pane.paneId, {
      sessionId,
      adbSerial: serial,
      connecting: true,
      panel: undefined,
      error: null,
      lines: pane.resumeConnected ? pane.lines : [],
      endsWithNewline: true,
      lastAdbStream: undefined,
    });
    try {
      await invoke("adb_log_open", { sessionId, serial, command });
      setPanes((prev) => prev.map((current) => current.sessionId === sessionId
        ? { ...current, connected: true, connecting: false, resumeConnected: true }
        : current));
    } catch (err) {
      adbOutput.forget(sessionId);
      setPanes((prev) => endLogSession(prev, sessionId, String(err)));
    }
  };

  restoreSerialRef.current = (available) => {
    const attempts = serialRestoreAttempts.current;
    for (const pane of panesRef.current) {
      if (pane.source !== "serial" || !pane.resumeConnected) {
        attempts.delete(pane.paneId);
        continue;
      }
      if (pane.sessionId) continue;
      const port = findSerialPort(available, pane.portName, pane.serialBinding);
      if (!port) {
        attempts.delete(pane.paneId);
      } else if (attempts.get(pane.paneId) !== port.port_name) {
        attempts.set(pane.paneId, port.port_name);
        void handleConnect(pane, port);
      }
    }
  };

  restoreAdbRef.current = (devices) => {
    for (const pane of panesRef.current) {
      if (pane.source !== "adb" || !pane.resumeConnected || pane.sessionId) continue;
      if (adbSerialAmbiguous(pane.adbSerial, devices)) {
        updatePane(pane.paneId, { resumeConnected: false, error: t("multiLog.adbSerialAmbiguous") });
      } else if (adbDeviceAvailable(devices, pane.adbSerial)) {
        void handleStartAdb(pane, adbTarget(pane.adbSerial, devices));
      }
    }
  };

  const handleDisconnect = async (pane: SerialPaneState): Promise<boolean> => {
    if (!pane.sessionId || pane.stopping) return false;
    const sessionId = pane.sessionId;
    updatePane(pane.paneId, { stopping: true });
    try {
      await invoke("log_session_stop", { sessionId });
      if (pane.source === "serial") {
        clearDecoder(pane.paneId);
        onLog(isEn ? `Serial closed: ${pane.portName}` : `串口已断开: ${pane.portName}`);
      }
      setPanes((prev) => endLogSession(prev, sessionId));
      return true;
    } catch (err) {
      const msg = String(err);
      setPanes((prev) => prev.map((current) => current.sessionId === sessionId
        ? { ...current, stopping: false, error: msg }
        : current));
      onLog(`log_session_stop error: ${msg}`);
      return false;
    }
  };

  const handleConnectAllWorkspace = async () => {
    for (const { paneId } of panesRef.current) {
      const pane = panesRef.current.find((item) => item.paneId === paneId);
      if (pane?.source === "serial" && !pane.connected && !pane.connecting && !pane.stopping && pane.portName) {
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
    try {
      if (pane.sendFormat === "hex") {
        const dataBase64 = hexToBase64(raw);
        if (dataBase64 === null) {
          updatePane(pane.paneId, { error: t("multiLog.hexError") });
          return;
        }
        if (!dataBase64) return;
        await invoke("serial_write_bytes", { sessionId: pane.sessionId, dataBase64 });
      } else {
        const data = raw + SERIAL_LINE_SUFFIX[pane.lineEnding];
        if (!data) return;
        await invoke("serial_write", { sessionId: pane.sessionId, data });
      }
      const history = pane.cmdHistory[pane.sendFormat];
      const nextHistory =
        raw.trim() && history[0] !== raw ? [raw, ...history].slice(0, 50) : history;
      updatePane(pane.paneId, {
        inputText: "",
        cmdHistory: { ...pane.cmdHistory, [pane.sendFormat]: nextHistory },
        historyIndex: -1,
        error: null,
      });
    } catch (err) {
      const msg = String(err);
      updatePane(pane.paneId, { error: msg });
      onLog(`serial_write error: ${msg}`);
    }
  };

  const handleExportLog = async (pane: SerialPaneState) => {
    const content = paneLines(pane)
      .map((l) => (pane.showTimestamps ? `[${l.ts}] ${stripAnsi(l.text)}` : stripAnsi(l.text)))
      .join("\n");
    try {
      const source = pane.source === "adb" ? `adb-${pane.adbSerial}` : pane.portName || "serial";
      const defaultName = `${source.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}.log`;
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "Log Files", extensions: ["log", "txt"] }],
      });
      if (path) {
        await writeTextFile(path, content);
        onLog(t("multiLog.exported", { path }));
      }
    } catch (err) {
      onLog(`Export log error: ${String(err)}`);
    }
  };

  const handleAddPane = () => {
    const pane = createPane();
    newPaneId.current = pane.paneId;
    setEnlargedPaneId(null);
    setPanes((prev) => [...prev, pane]);
  };

  const handleRemovePane = async (pane: SerialPaneState) => {
    if (pane.connecting || pane.stopping) return;
    if (pane.connected && pane.sessionId && !(await handleDisconnect(pane))) return;
    delete formatScrollPositions.current[pane.paneId];
    pendingFormatScroll.current.delete(pane.paneId);
    setEnlargedPaneId((id) => id === pane.paneId ? null : id);
    setPaneSettings((current) => current?.paneId === pane.paneId ? null : current);
    setPanes((prev) => prev.filter((p) => p.paneId !== pane.paneId));
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
    const revision = ++logReadRevision.current;
    setSelectedLogFile(entry);
    setLoadingLogContent(true);
    try {
      const text = await invoke<string>("serial_read_log_file", {
        fileName: entry.file_name,
        tailLines: 1000,
        directory: entry.directory,
      });
      if (revision === logReadRevision.current) setLogContent(text || "");
    } catch (err) {
      if (revision !== logReadRevision.current) return;
      const msg = String(err);
      setLogContent(`Failed to read log: ${msg}`);
      onLog(`serial_read_log_file error: ${msg}`);
    } finally {
      if (revision === logReadRevision.current) setLoadingLogContent(false);
    }
  };

  const visiblePanes = useMemo(() => panes.filter((p) => !p.hidden), [panes]);
  const enlarged = visiblePanes.some((pane) => pane.paneId === enlargedPaneId);
  const displayedPaneCount = enlarged ? 1 : visiblePanes.length;
  const columns = Math.max(1, Math.min(columnCount, displayedPaneCount));
  const compactHeader = columns > 2;
  const iconPadding = compactHeader ? "px-0.5 py-1" : "p-1.5";
  const hiddenPanes = panes.filter((pane) => pane.hidden);
  const settingsPane = visiblePanes.find((pane) => pane.paneId === paneSettings?.paneId);
  const paneName = (pane: SerialPaneState) =>
    pane.label?.trim() || t("multiLog.paneName", { number: panes.indexOf(pane) + 1 });
  const logProfileSnapshot = () => {
    const labels = new Set<string>();
    const sources: LogProfileSource[] = [];
    for (const pane of panes) {
      const serial = adbDeviceForPane(pane).trim();
      const command = pane.adbCommand.trim();
      const portName = pane.portName.trim();
      if (pane.source === "adb" ? !serial || !command : !portName) continue;
      const base = paneName(pane);
      let label = base;
      for (let suffix = 2; labels.has(label); suffix += 1) {
        label = `${base} (${suffix})`;
      }
      labels.add(label);
      sources.push(pane.source === "adb"
        ? { type: "adb", label, serial, command, highlight_rules: configuredHighlightRules(pane.highlightRules), level_colors: pane.levelColors }
        : {
            type: "serial", label, port_name: portName, baud_rate: pane.baudRate,
            line_coding: pane.coding, serial_options: serialViewOptions(pane),
            highlight_rules: configuredHighlightRules(pane.highlightRules), level_colors: pane.levelColors,
          });
    }
    const bridge = bridgeSettingsRef.current?.getProfileBridge(sources);
    return sources.length || bridge ? { sources, bridge } : null;
  };
  const togglePanel = (pane: SerialPaneState, panel: LogPanePanel) => {
    updatePane(pane.paneId, { panel: pane.panel === panel ? undefined : panel });
  };
  const togglePaneSettings = (paneId: string, anchor: HTMLButtonElement) => {
    setPaneSettings((current) => current?.paneId === paneId ? null : { paneId, anchor });
  };
  const openBridgeSettings = () => {
    showBridgeSettings.current = true;
    setSubView("settings");
  };

  const clearPane = (pane: SerialPaneState) => {
    clearDecoder(pane.paneId);
    delete formatScrollPositions.current[pane.paneId];
    updatePane(pane.paneId, { lines: [], hexRows: [], endsWithNewline: true, followPaused: false });
  };
  const toggleEnlargedPane = (paneId: string) => {
    if (enlargedPaneId === paneId) {
      setEnlargedPaneId(null);
    } else {
      gridScrollBeforeEnlarge.current = gridRef.current?.scrollTop ?? 0;
      setEnlargedPaneId(paneId);
    }
  };

  useLayoutEffect(() => {
    if (subView !== "live" || enlarged || gridScrollBeforeEnlarge.current === null) return;
    if (gridRef.current) gridRef.current.scrollTop = gridScrollBeforeEnlarge.current;
    gridScrollBeforeEnlarge.current = null;
  }, [enlarged, subView]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      {/* Top Toolbar */}
      <div className="ui-toolbar min-w-0 shrink-0 px-2.5 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="ui-segmented max-w-full flex-wrap">
            <button
              onClick={() => setSubView("live")}
              className={`ui-segmented-btn ${
                subView === "live"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              {t("multiLog.liveTab")}
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
            <button
              type="button"
              onClick={() => setSubView("bridge")}
              className={`ui-segmented-btn whitespace-nowrap ${
                subView === "bridge"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <Cable className="w-3.5 h-3.5" />
              {t("multiLog.bridge.tab")}
            </button>
            <button
              type="button"
              onClick={() => setSubView("settings")}
              className={`ui-segmented-btn ${
                subView === "settings"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t("multiLog.settingsPage.tab")}
            </button>
          </div>

          {activeWorkspace && activeWorkspace.serial_ports.length > 0 && subView === "live" && (
            <button onClick={handleConnectAllWorkspace} className="ui-btn-success px-2.5 py-1">
              {isEn ? "Connect All" : "一键全连"}
            </button>
          )}
        </div>

        {subView === "live" ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              onClick={refreshSources}
              disabled={loadingPorts || refreshingDevices}
              className="ui-btn-secondary px-2.5 py-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingPorts || refreshingDevices ? "animate-spin" : ""}`} />
              {t("multiLog.refreshSources")}
            </button>
            <button
              onClick={handleAddPane}
              className="ui-btn-primary px-2.5 py-1"
            >
              <Plus className="w-3.5 h-3.5" />
              {t("multiLog.addPane", { total: panes.length })}
            </button>
          </div>
        ) : subView === "logs" ? (
          <button
            onClick={loadLogList}
            disabled={loadingLogs}
            className="ui-btn-secondary"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? "animate-spin" : ""}`} />
            {isEn ? "Refresh Logs" : "刷新日志列表"}
          </button>
        ) : null}
      </div>

      {subView === "settings" && (
        <section aria-label={t("multiLog.settingsPage.tab")} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl space-y-4 p-1">
            <section className="ui-card text-sm">
              <div className="ui-card-header rounded-t-xl">
                <h2 className="ui-title text-sm">{t("multiLog.profiles.select")}</h2>
                <LogProfileControls onLoad={handleLoadLogProfile} onLog={onLog} snapshot={logProfileSnapshot} />
              </div>
              <section className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-medium">{t("multiLog.settingsPage.capture")}</h3>
                  {activeWorkspace && activeWorkspace.serial_ports.length > 0 && (
                    <button onClick={handleLoadFromWorkspace} className="ui-btn-secondary px-2.5 py-1">
                      {isEn ? "Load Workspace Ports" : "载入工作区串口"}
                    </button>
                  )}
                </div>
                <label className="flex flex-wrap items-center justify-between gap-3 text-xs">
                  {t("multiLog.columnCount")}
                  <select
                    value={columnCount}
                    onChange={(event) => {
                      setColumnCount(Number(event.target.value));
                      localStorage.setItem(LOG_COLUMNS_KEY, event.target.value);
                    }}
                    className="ui-select min-w-20"
                  >
                    {[2, 3, 4].map((count) => (
                      <option key={count} value={count}>{t("multiLog.columns", { count })}</option>
                    ))}
                  </select>
                </label>
              </section>
              <div
                ref={setBridgeSettingsHost}
                role="group"
                aria-label={t("multiLog.settingsPage.bridge")}
                tabIndex={-1}
                className="min-w-0 scroll-mt-1 rounded-b-xl"
              />
            </section>
            <LogColorSettings />
            <LogCaptureSettings />
          </div>
        </section>
      )}

      {/* Live Multi-pane Serial Console */}
      {subView === "live" || subView === "settings" ? (
        <div className={subView === "live" ? "flex min-h-0 flex-1 flex-col gap-2" : "hidden"}>
          {visiblePanes.length === 0 ? (
            <div className="ui-card flex-1 flex flex-col items-center justify-center p-8 text-slate-500 dark:text-slate-400">
              <p className="text-sm">
                {t(panes.length ? "multiLog.allHidden" : "multiLog.noPanes")}
              </p>
            </div>
          ) : (
            <div
              ref={gridRef}
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
              className={`grid min-h-0 flex-1 gap-2 overflow-y-auto ${displayedPaneCount > columns * 2 ? "auto-rows-[max(10rem,calc((100%_-_0.5rem)/2))]" : "auto-rows-fr"}`}
            >
              {visiblePanes.map((pane, index) => {
                const fillsLastRow = index % columns === 0 && index === visiblePanes.length - 1;
                const isAdb = pane.source === "adb";
                const isBusy = pane.connected || pane.connecting || pane.stopping;
                const waitingForDevice = !isBusy && pane.resumeConnected;
                const canStop = pane.connected || waitingForDevice;
                const adbSerial = adbDeviceForPane(pane);
                const adbReady = isAdb && adbDeviceAvailable(adbDevices, adbSerial);
                const sourceSummary = isAdb
                  ? adbSerial || t("multiLog.adbSource")
                  : pane.connectedPortName || pane.portName || t("multiLog.serialSource");
                const name = paneName(pane);
                const isEnlarged = enlargedPaneId === pane.paneId;
                const toggleLayoutHint = t(isEnlarged ? "multiLog.restorePaneLayout" : "multiLog.enlargePane");
                const closeLabel = t(pane.connected ? "multiLog.closeActivePane" : "multiLog.closePane");
                const connectionLabel = waitingForDevice ? t("multiLog.cancelRestore") : isAdb
                  ? t(pane.stopping ? "multiLog.stopping" : pane.connected ? "multiLog.stop" : pane.connecting ? "multiLog.starting" : "multiLog.start")
                  : pane.connected
                    ? (isEn ? "Disconnect" : "断开")
                    : pane.connecting ? (isEn ? "Opening..." : "连接中...") : (isEn ? "Connect" : "连接");
                const receivedLines = paneLines(pane);
                const hexOutput = !isAdb && pane.receiveFormat === "hex";
                const history = pane.cmdHistory[pane.sendFormat];
                const searchNeedle = pane.searchQuery.trim().toLowerCase();
                const matchingLineCount = searchNeedle
                  ? receivedLines.reduce((count, line) => count + Number(stripAnsi(line.text).toLowerCase().includes(searchNeedle)), 0)
                  : 0;
                const displayLines = receivedLines
                  .map((l) => (pane.showTimestamps ? `[${l.ts}] ${l.text}` : l.text))
                  .join("\n");

                return (
                  <div
                    key={pane.paneId}
                    className={`ui-card min-h-0 min-w-0 flex-col overflow-hidden ${enlarged && !isEnlarged ? "hidden" : "flex"} ${fillsLastRow ? "col-span-full" : ""}`}
                  >
                    <div className={`flex min-w-0 shrink-0 flex-wrap items-center border-b border-slate-200 py-1 dark:border-slate-800 ${compactHeader ? "gap-0.5 px-1.5" : "gap-1 px-2"}`}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${pane.connected ? "bg-emerald-500" : "bg-slate-400"}`} />
                      <button
                        type="button"
                        data-pane-title
                        aria-pressed={isEnlarged}
                        onDoubleClick={() => toggleEnlargedPane(pane.paneId)}
                        onClick={(event) => {
                          if (event.detail === 0) toggleEnlargedPane(pane.paneId);
                        }}
                        title={`${name} · ${sourceSummary}\n${toggleLayoutHint}`}
                        className="flex min-w-12 flex-1 select-none items-baseline gap-1.5 text-left"
                      >
                        <span className="truncate text-xs font-semibold">
                          {name}
                        </span>
                        <span className={`truncate text-[11px] text-slate-500 dark:text-slate-400 ${compactHeader ? "sr-only" : ""}`}>{sourceSummary}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => togglePanel(pane, "search")}
                        aria-expanded={pane.panel === "search"}
                        aria-label={t("multiLog.toggleSearch")}
                        title={t("multiLog.toggleSearch")}
                        className={`shrink-0 rounded-md ${iconPadding} ${pane.panel === "search" || pane.searchQuery ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
                      >
                        <Search className="h-3.5 w-3.5" />
                      </button>
                      {!isAdb && (
                        <button
                          type="button"
                          onClick={() => togglePanel(pane, "command")}
                          aria-expanded={pane.panel === "command"}
                          aria-label={t("multiLog.toggleCommand")}
                          title={t("multiLog.toggleCommand")}
                          className={`shrink-0 rounded-md ${iconPadding} ${pane.panel === "command" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
                        >
                          <Terminal className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(event) => togglePaneSettings(pane.paneId, event.currentTarget)}
                        aria-label={t("multiLog.settings")}
                        aria-haspopup="dialog"
                        aria-expanded={paneSettings?.paneId === pane.paneId}
                        aria-controls={paneSettings?.paneId === pane.paneId ? paneSettingsId : undefined}
                        title={t("multiLog.settings")}
                        className={`shrink-0 rounded-md ${iconPadding} ${paneSettings?.paneId === pane.paneId ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </button>
                      {!compactHeader && (
                        <button
                          type="button"
                          onClick={() => handleExportLog(pane)}
                          title={isEn ? "Export .log" : "导出 .log"}
                          className="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (waitingForDevice) updatePane(pane.paneId, { resumeConnected: false });
                          else if (pane.connected) void handleDisconnect(pane);
                          else if (isAdb) void handleStartAdb(pane);
                          else void handleConnect(pane);
                        }}
                        disabled={pane.connecting || pane.stopping || (!canStop && isAdb && (
                          !adbReady || !pane.adbCommand.trim() || !adbOutput.ready
                        ))}
                        title={connectionLabel}
                        className={`${canStop ? "ui-btn-danger" : "ui-btn-success"} shrink-0 whitespace-nowrap py-1 ${compactHeader ? "px-0.5" : "px-2"}`}
                      >
                        {canStop ? <PlugZap className="w-3.5 h-3.5" /> : <Plug className="w-3.5 h-3.5" />}
                        <span className={compactHeader ? "sr-only" : undefined}>{connectionLabel}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isEnlarged) setEnlargedPaneId(null);
                          if (paneSettings?.paneId === pane.paneId) closePaneSettings();
                          updatePane(pane.paneId, { hidden: true, panel: undefined });
                        }}
                        title={t("multiLog.hidePane")}
                        aria-label={t("multiLog.hidePane")}
                        className={`shrink-0 rounded-md ${iconPadding} text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800`}
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemovePane(pane)}
                        disabled={pane.connecting || pane.stopping}
                        title={closeLabel}
                        aria-label={closeLabel}
                        className={`shrink-0 rounded-md ${iconPadding} text-slate-400 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40 dark:hover:text-rose-400`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {pane.panel === "search" && (
                      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-1 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900">
                        <div className="flex min-w-0 items-center gap-1.5 flex-1">
                          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <input
                            type="text"
                            autoFocus
                            value={pane.searchQuery}
                            onChange={(e) => {
                              delete searchMatchPositions.current[pane.paneId];
                              updatePane(pane.paneId, { searchQuery: e.target.value });
                            }}
                            placeholder={t("multiLog.search")}
                            className="min-w-0 flex-1 bg-transparent text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 focus:outline-none"
                          />
                          {pane.searchQuery && (
                            <>
                              <span className="whitespace-nowrap text-[11px] text-slate-500" aria-live="polite">{matchingLineCount}</span>
                              <button type="button" onClick={() => findMatch(pane, -1)} disabled={!matchingLineCount} aria-label={isEn ? "Previous match" : "上一个匹配项"} title={isEn ? "Previous match" : "上一个匹配项"} className="rounded p-0.5 text-slate-500 hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-slate-800">
                                <ChevronUp className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" onClick={() => findMatch(pane, 1)} disabled={!matchingLineCount} aria-label={isEn ? "Next match" : "下一个匹配项"} title={isEn ? "Next match" : "下一个匹配项"} className="rounded p-0.5 text-slate-500 hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-slate-800">
                                <ChevronDown className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  delete searchMatchPositions.current[pane.paneId];
                                  updatePane(pane.paneId, { searchQuery: "" });
                                }}
                                aria-label={isEn ? "Clear search" : "清除搜索"}
                                className="text-slate-400 hover:text-slate-600"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={pane.filterOnly}
                            onChange={(e) => updatePane(pane.paneId, { filterOnly: e.target.checked })}
                            className="rounded-md border-slate-300 dark:border-slate-700"
                          />
                          {isEn ? "Filter" : "仅看匹配"}
                        </label>
                      </div>
                    )}
                    {(pane.error || (isAdb && adbOutput.listenerError)) && (
                      <div className="max-h-14 shrink-0 overflow-y-auto break-all border-b border-rose-500/20 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-600 dark:text-rose-400">
                        {pane.error || t("multiLog.listenerError", { error: adbOutput.listenerError })}
                      </div>
                    )}
                    {waitingForDevice && (
                      <div className="shrink-0 truncate px-2.5 py-1 text-xs text-amber-700 dark:text-amber-400" role="status">
                        {t(isAdb ? "multiLog.adbRestoreWaiting" : "multiLog.serialRestoreWaiting")}
                      </div>
                    )}

                    <div className="relative min-h-0 flex-1">
                      {/* Output Terminal Area */}
                      <div
                        ref={(el) => {
                          if (el) scrollRefs.current[pane.paneId] = el;
                          else delete scrollRefs.current[pane.paneId];
                        }}
                        onScroll={(event) => handleReceiveScroll(pane, event.currentTarget)}
                        data-log-output
                        className="h-full overflow-auto px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
                      >
                        {receivedLines.length === 0 ? (
                          <div className="text-xs text-slate-400 dark:text-slate-600 font-mono">
                            {!waitingForDevice && (isAdb
                              ? t(isBusy ? "multiLog.adbWaiting" : "multiLog.adbHint")
                              : pane.connected
                                ? isEn
                                ? "Connected. Waiting for serial data..."
                                : "已连接，等待串口数据..."
                              : t("multiLog.serialHint"))}
                          </div>
                        ) : (
                          <AnsiText
                            text={displayLines}
                            showTimestamps={pane.showTimestamps}
                            ansiEnabled={pane.ansiEnabled && !hexOutput}
                            searchQuery={pane.searchQuery}
                            filterOnly={pane.filterOnly}
                            highlightRules={hexOutput ? undefined : pane.highlightRules}
                            levelFormat={pane.levelColors && !hexOutput
                              ? (isAdb ? detectLogLevelFormat(normalizeAdbCommand(pane.adbCommand)) : "serial")
                              : undefined}
                          />
                        )}
                      </div>
                      {!pane.panel && receivedLines.length > 0 && (!pane.autoScroll || pane.followPaused) && (
                        <button
                          type="button"
                          onClick={() => jumpToLatest(pane)}
                          className="ui-btn-secondary absolute bottom-2 right-3 px-2 py-1"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                          {pane.followPaused && pane.followNewLines > 0
                            ? `${isEn ? "New" : "新增"} ${pane.followNewLines} · ${t("multiLog.jumpToLatest")}`
                            : t("multiLog.jumpToLatest")}
                        </button>
                      )}
                    </div>

                    {/* Bottom Command Input */}
                    {!isAdb && pane.panel === "command" && (
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60">
                        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                          {t(pane.sendFormat === "hex" ? "multiLog.formatHex" : "multiLog.formatText")}
                          {pane.sendFormat === "text" && ` · ${pane.lineEnding === "none" ? t("multiLog.noLineEnding") : pane.lineEnding.toUpperCase()}`}
                        </span>
                        <input
                          type="text"
                          autoFocus
                          aria-label={t("multiLog.sendInput")}
                          value={pane.inputText}
                          disabled={!pane.connected}
                          onChange={(e) => updatePane(pane.paneId, { inputText: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSendCommand(pane);
                            } else if (e.key === "ArrowUp") {
                              if (history.length === 0) return;
                              e.preventDefault();
                              const nextIdx = Math.min(
                                pane.historyIndex + 1,
                                history.length - 1
                              );
                              updatePane(pane.paneId, {
                                historyIndex: nextIdx,
                                inputText: history[nextIdx],
                              });
                            } else if (e.key === "ArrowDown") {
                              if (pane.historyIndex < 0) return;
                              e.preventDefault();
                              const nextIdx = pane.historyIndex - 1;
                              updatePane(pane.paneId, {
                                historyIndex: nextIdx,
                                inputText: nextIdx >= 0 ? history[nextIdx] : "",
                              });
                            }
                          }}
                          placeholder={
                            pane.connected
                              ? pane.sendFormat === "hex"
                                ? t("multiLog.hexExample")
                                : isEn
                                  ? "Type command and press Enter (Up/Down for history)..."
                                  : "输入指令回车发送（上下键切换历史）..."
                              : isEn
                              ? "Connect serial port to send..."
                              : "连接串口后可发送指令..."
                          }
                          className="ui-input min-w-12 flex-1 px-2 py-1 font-mono"
                        />
                        <button
                          onClick={() => handleSendCommand(pane)}
                          disabled={!pane.connected}
                          className="ui-btn-primary shrink-0 px-2 py-1"
                        >
                          <Send className="w-3.5 h-3.5" />
                          {isEn ? "Send" : "发送"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {hiddenPanes.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto">
              {hiddenPanes.map((pane) => {
                const name = paneName(pane);
                return (
                  <button
                    type="button"
                    key={pane.paneId}
                    onClick={() => {
                      setEnlargedPaneId(null);
                      updatePane(pane.paneId, { hidden: false });
                    }}
                    className="ui-btn-secondary shrink-0 px-2 py-1"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t("multiLog.showPane", { name })}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : subView === "logs" ? (
        /* Saved Log Browser */
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,min(35%,13rem))_minmax(0,1fr)] gap-2">
          <div className="ui-card flex min-h-0 flex-col overflow-hidden">
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
                    : t("multiLog.noSavedLogs")}
                </div>
              ) : (
                logFiles.map((entry) => {
                  const active = selectedLogFile?.path === entry.path;
                  return (
                    <button
                      key={entry.path}
                      title={entry.path}
                      onClick={() => openLogFile(entry)}
                      className={`flex w-full items-start gap-1.5 px-2.5 py-1.5 text-left transition ${
                        active
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-200"
                      }`}
                    >
                      <FileText className="w-4 h-4 mt-0.5 shrink-0 opacity-70" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono truncate">{entry.file_name}</div>
                        <div className="mt-0.5 flex flex-wrap justify-between gap-x-2 font-mono text-[11px] tabular-nums text-slate-400">
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

          <div className="ui-card flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="ui-card-header">
              <div title={selectedLogFile?.path} className="min-w-0 max-w-full flex-1 basis-32 truncate font-mono text-xs text-slate-700 dark:text-slate-200">
                {selectedLogFile
                  ? `${selectedLogFile.file_name} (${isEn ? "last 1000 lines" : "末尾 1000 行"})`
                  : isEn
                  ? "Select a log file on the left"
                  : "请在左侧选择一个日志文件"}
              </div>
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder={isEn ? "Filter lines..." : "过滤关键字..."}
                    className="ui-input w-40 max-w-full pl-7"
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
                  text={logContent}
                  showTimestamps={logShowTimestamps}
                  ansiEnabled={logAnsi}
                  searchQuery={logSearch}
                  filterOnly={Boolean(logSearch.trim())}
                  levelFormat="serial"
                />
              ) : (
                <div className="text-xs text-slate-400 font-mono">
                  {isEn ? "No file selected." : "未选择日志文件。"}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {subView === "live" && paneSettings && settingsPane && (
        <PaneSettingsPopover
          key={settingsPane.paneId}
          anchor={paneSettings.anchor}
          id={paneSettingsId}
          title={`${t("multiLog.settings")} · ${paneName(settingsPane)}`}
          closeLabel={t("multiLog.closeSettings")}
          onClose={closePaneSettings}
          actions={(
            <>
              <button type="button" onClick={() => handleExportLog(settingsPane)} className="ui-btn-secondary px-2.5 py-1">
                <Download className="h-3.5 w-3.5" />
                {t("log.export")}
              </button>
              <button type="button" onClick={() => clearPane(settingsPane)} className="ui-btn-secondary px-2.5 py-1">
                <Trash2 className="h-3.5 w-3.5" />
                {t("log.clear")}
              </button>
            </>
          )}
        >
          <SerialPaneSettings
            pane={settingsPane}
            paneNumber={panes.indexOf(settingsPane) + 1}
            ports={ports}
            adbDevices={adbDevices}
            adbSerial={adbDeviceForPane(settingsPane)}
            onChange={(patch) => {
              if (patch.receiveFormat && patch.receiveFormat !== settingsPane.receiveFormat) {
                rememberReceivePosition(settingsPane);
                pendingFormatScroll.current.set(settingsPane.paneId, Symbol());
              }
              const changedPort = (patch.portName !== undefined && patch.portName !== settingsPane.portName) ||
                (patch.source !== undefined && patch.source !== settingsPane.source);
              updatePane(settingsPane.paneId, changedPort ? { ...patch, serialBinding: undefined } : patch);
            }}
            onToggleSignal={(kind) => void handleToggleSignal(settingsPane, kind)}
          />
        </PaneSettingsPopover>
      )}
      <div className={subView === "bridge" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SerialBridgePanel
          visible={subView === "bridge"}
          settingsRef={bridgeSettingsRef}
          connectionsRestored={sessionsLoaded}
          settingsHost={bridgeSettingsHost}
          onShowSettings={openBridgeSettings}
          onBridgeError={refreshExistingSessions}
          onLog={onLog}
          ports={panes.flatMap((pane) =>
            pane.source === "serial" && pane.connected && !pane.stopping && pane.sessionId
              ? [{
                  sessionId: pane.sessionId,
                  portName: pane.connectedPortName || pane.portName,
                  restorePortName: pane.connectedPortName && pane.connectedPortName !== pane.portName
                    ? pane.portName : undefined,
                  baudRate: pane.baudRate,
                  lineCoding: pane.coding,
                  label: paneName(pane),
                  charset: pane.charset,
                }]
              : []
          )}
        />
      </div>
    </div>
  );
}
