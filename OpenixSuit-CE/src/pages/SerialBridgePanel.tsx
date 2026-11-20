import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal, flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowRight, ChevronDown, Play, Settings2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LogProfile, LogSessionChange, SerialFormat, SerialLineCoding } from "../types/workbench";

interface BridgePort {
  sessionId: string;
  portName: string;
  restorePortName?: string;
  baudRate: number;
  lineCoding: SerialLineCoding;
  label: string;
  charset: string;
}

interface BridgeInfo {
  id: string;
  first_session_id: string;
  second_session_id: string;
  first_port: string;
  second_port: string;
  log_path: string;
}

interface BridgeData {
  id: string;
  from_session_id: string;
  to_session_id: string;
  from_port: string;
  to_port: string;
  timestamp: string;
  data_base64: string;
}

interface BridgeEnded {
  id: string;
  error: string | null;
  interrupted?: boolean;
}

interface BridgeRow {
  sequence: number;
  fromSessionId: string;
  timestamp: string;
  from: string;
  to: string;
  bytes: Uint8Array;
  text: string;
}

type BridgeDirection = "both" | "firstToSecond" | "secondToFirst";

interface BridgeDisplaySettings {
  format: SerialFormat;
  direction: BridgeDirection;
  showTimestamps: boolean;
  autoScroll: boolean;
}

const LIVE_ROW_LIMIT = 500;
const BRIDGE_DISPLAY_KEY = "openix_bridge_display";
const BRIDGE_SELECTION_KEY = "openix_bridge_selection";
const BRIDGE_RESTORE_KEY = "openix_bridge_running";
const HEX_BYTES = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0").toUpperCase());

interface BridgeSelection {
  first: string;
  second: string;
  profileId: string;
}

interface BridgeEndpoints {
  first: string;
  second: string;
}

interface BridgeRestoreTargets {
  endpoints: BridgeEndpoints;
  firstSessionId?: string;
  secondSessionId?: string;
}

function bridgePortKey(port: BridgePort): string {
  return port.restorePortName || port.portName;
}

function findBridgePort(ports: BridgePort[], name: string): BridgePort | undefined {
  return ports.find((port) => bridgePortKey(port) === name);
}

function bridgeSessionPair(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

function loadRunningBridge(): BridgeEndpoints | null {
  try {
    const saved = JSON.parse(localStorage.getItem(BRIDGE_RESTORE_KEY) ?? "null");
    return typeof saved?.first === "string" && saved.first
      && typeof saved.second === "string" && saved.second && saved.first !== saved.second
      ? { first: saved.first, second: saved.second } : null;
  } catch {
    return null;
  }
}

const PUBLIC_DIRECTIONS = {
  both: "both",
  first_to_second: "firstToSecond",
  second_to_first: "secondToFirst",
} as const;

interface BridgeSettingsSnapshot {
  profile_id: string | null;
  first_port: string | null;
  second_port: string | null;
  format: SerialFormat;
  direction: keyof typeof PUBLIC_DIRECTIONS;
  show_timestamps: boolean;
  auto_scroll: boolean;
  active: boolean;
}

export interface BridgeSettingsHandle {
  getSettings(): BridgeSettingsSnapshot;
  setSettings(params: unknown): Promise<BridgeSettingsSnapshot>;
  getProfileBridge(sources: LogProfile["sources"]): LogProfile["bridge"];
  loadProfile(profile: LogProfile): boolean;
}

function bridgeSettingsSnapshot(
  selection: BridgeSelection, display: BridgeDisplaySettings, active: BridgeInfo | null,
): BridgeSettingsSnapshot {
  return {
    profile_id: selection.profileId || null,
    first_port: (active?.first_port ?? selection.first) || null,
    second_port: (active?.second_port ?? selection.second) || null,
    format: display.format,
    direction: display.direction === "firstToSecond" ? "first_to_second"
      : display.direction === "secondToFirst" ? "second_to_first" : "both",
    show_timestamps: display.showTimestamps,
    auto_scroll: display.autoScroll,
    active: active !== null,
  };
}

function parseSettingsPatch(params: unknown): Partial<Omit<BridgeSettingsSnapshot, "active">> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Bridge settings must be a JSON object");
  }
  for (const [field, value] of Object.entries(params)) {
    let valid = false;
    switch (field) {
      case "profile_id":
      case "first_port":
      case "second_port":
        valid = value === null || (typeof value === "string" && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
        break;
      case "format":
        valid = value === "text" || value === "hex";
        break;
      case "direction":
        valid = value === "both" || value === "first_to_second" || value === "second_to_first";
        break;
      case "show_timestamps":
      case "auto_scroll":
        valid = typeof value === "boolean";
        break;
      default:
        throw new Error(`Unknown bridge setting: ${field}`);
    }
    if (!valid) throw new Error(`Invalid value for bridge setting ${field}`);
  }
  return params;
}

function loadBridgeSelection(): BridgeSelection {
  const defaults = { first: "", second: "", profileId: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(BRIDGE_SELECTION_KEY) ?? "null");
    return {
      first: typeof saved?.first === "string" ? saved.first : "",
      second: typeof saved?.second === "string" ? saved.second : "",
      profileId: typeof saved?.profileId === "string" ? saved.profileId : "",
    };
  } catch {
    return defaults;
  }
}

function loadDisplaySettings(): BridgeDisplaySettings {
  const defaults: BridgeDisplaySettings = {
    format: "text", direction: "both", showTimestamps: true, autoScroll: true,
  };
  try {
    const saved: Partial<BridgeDisplaySettings> | null = JSON.parse(localStorage.getItem(BRIDGE_DISPLAY_KEY) ?? "null");
    if (!saved) return defaults;
    return {
      format: saved.format === "hex" ? "hex" : defaults.format,
      direction: saved.direction === "firstToSecond" || saved.direction === "secondToFirst"
        ? saved.direction : defaults.direction,
      showTimestamps: saved.showTimestamps !== false,
      autoScroll: saved.autoScroll !== false,
    };
  } catch {
    return defaults;
  }
}

function portDisplayName(port: BridgePort | undefined, portName: string): string {
  return port?.label && port.label !== portName ? `${port.label} · ${portName}` : portName;
}

function showControlCharacters(text: string): string {
  return Array.from(text, (char) => {
    const value = char.charCodeAt(0);
    if ((value < 32 && char !== "\r" && char !== "\n" && char !== "\t") || value === 127) {
      return "\\x" + value.toString(16).padStart(2, "0");
    }
    return char;
  }).join("");
}

function lineSummary(baudRate: number, coding?: SerialLineCoding): string {
  const parity = coding?.parity === "even" ? "E" : coding?.parity === "odd" ? "O" : "N";
  const flow = coding?.flow_control === "hardware" ? " · RTS/CTS"
    : coding?.flow_control === "software" ? " · XON/XOFF" : "";
  return `${baudRate} baud · ${coding?.data_bits ?? 8}${parity}${coding?.stop_bits ?? 1}${flow}`;
}

const BridgeLogRecord = memo(function BridgeLogRecord({
  row, format, showTimestamps,
}: { row: BridgeRow; format: SerialFormat; showTimestamps: boolean }) {
  const { t } = useTranslation();
  const content = format === "hex" ? Array.from(row.bytes, (byte) => HEX_BYTES[byte]).join(" ") : row.text;
  return (
    <div className="border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-500 dark:text-slate-400">
        {showTimestamps && <time>{row.timestamp}</time>}
        <span className="max-w-full break-all font-semibold text-blue-700 dark:text-blue-400">{row.from}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="max-w-full break-all">{row.to}</span>
        <span>{t("multiLog.bridge.byteCount", { count: row.bytes.length })}</span>
      </div>
      {content && <pre className="mt-0.5 whitespace-pre-wrap break-all">{content}</pre>}
    </div>
  );
});

export function SerialBridgePanel({
  ports,
  visible,
  onBridgeError,
  onLog,
  settingsHost,
  onShowSettings,
  settingsRef,
  connectionsRestored = false,
}: {
  ports: BridgePort[];
  visible: boolean;
  onBridgeError: () => Promise<void>;
  onLog: (message: string) => void;
  settingsHost: HTMLElement | null;
  onShowSettings: () => void;
  settingsRef?: Ref<BridgeSettingsHandle>;
  connectionsRestored?: boolean;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(loadBridgeSelection);
  const [active, setActive] = useState<BridgeInfo | null>(null);
  const [lastBridge, setLastBridge] = useState<BridgeInfo | null>(null);
  const [loadedProfile, setLoadedProfile] = useState<LogProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logPath, setLogPath] = useState("");
  const [rows, setRows] = useState<BridgeRow[]>([]);
  const [display, setDisplay] = useState(loadDisplaySettings);
  const [followPaused, setFollowPaused] = useState(false);
  const [restoreEndpoints, setRestoreEndpoints] = useState(loadRunningBridge);
  const restoreTargets = useRef<BridgeRestoreTargets | null>(restoreEndpoints ? { endpoints: restoreEndpoints } : null);
  const lastRestoreAttempt = useRef("");
  const pendingRestore = useRef<{ endpoints: BridgeEndpoints; sessions: string } | null>(null);
  const rememberedBridgeId = useRef("");
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const endedId = useRef("");
  const outputBridgeId = useRef("");
  const sequence = useRef(0);
  const decoders = useRef(new Map<string, { charset: string; decoder: TextDecoder }>());
  const output = useRef<HTMLDivElement>(null);
  const configuredProfile = loadedProfile?.id === selection.profileId ? loadedProfile : null;
  const firstPort = active?.first_port ?? restoreEndpoints?.first ?? configuredProfile?.bridge?.first.port_name ?? selection.first;
  const secondPort = active?.second_port ?? restoreEndpoints?.second ?? configuredProfile?.bridge?.second.port_name ?? selection.second;
  const first = active?.first_session_id ?? findBridgePort(ports, firstPort)?.sessionId;
  const second = active?.second_session_id ?? findBridgePort(ports, secondPort)?.sessionId;
  const waitingForRestore = !active && restoreEndpoints !== null;
  const restoreFirst = restoreEndpoints && findBridgePort(ports, restoreEndpoints.first);
  const restoreSecond = restoreEndpoints && findBridgePort(ports, restoreEndpoints.second);
  if (restoreTargets.current) {
    if (restoreFirst) restoreTargets.current.firstSessionId = restoreFirst.sessionId;
    if (restoreSecond) restoreTargets.current.secondSessionId = restoreSecond.sessionId;
  }
  const currentSettings = useRef({ selection, display, active, busy, configuredProfile, waitingForRestore });
  currentSettings.current = { selection, display, active, busy, configuredProfile, waitingForRestore };

  useImperativeHandle(settingsRef, () => ({
    getProfileBridge(sources) {
      const { active, configuredProfile, selection } = currentSettings.current;
      if (!active && configuredProfile?.bridge) return configuredProfile.bridge;

      const endpoint = (side: "first" | "second") => {
        const session = active && portsRef.current.find((port) => port.sessionId === active[`${side}_session_id`]);
        const selectedPort = active?.[`${side}_port`] ?? selection[side];
        const port = session || findBridgePort(portsRef.current, selectedPort);
        if (port) {
          return {
            label: port.label, port_name: bridgePortKey(port), baud_rate: port.baudRate, line_coding: port.lineCoding,
          };
        }
        const source = sources.find((entry) => entry.type === "serial" && entry.port_name === selectedPort);
        if (source?.type === "serial") {
          const { label, port_name, baud_rate, line_coding } = source;
          return { label, port_name, baud_rate, line_coding };
        }
      };
      const first = endpoint("first");
      const second = endpoint("second");
      return first && second && first.port_name !== second.port_name ? { first, second } : undefined;
    },
    loadProfile(profile) {
      const { active, busy, waitingForRestore } = currentSettings.current;
      if (active || busy || waitingForRestore) return false;
      setLoadedProfile(profile.bridge ? profile : null);
      setSelection({
        profileId: profile.bridge ? profile.id : "",
        first: profile.bridge?.first.port_name ?? "",
        second: profile.bridge?.second.port_name ?? "",
      });
      return true;
    },
    getSettings() {
      const value = currentSettings.current;
      const profile = value.configuredProfile?.bridge;
      const selection = profile ? {
        ...value.selection, first: profile.first.port_name, second: profile.second.port_name,
      } : value.selection;
      return bridgeSettingsSnapshot(selection, value.display, value.active);
    },
    async setSettings(params) {
      const patch = parseSettingsPatch(params);
      const selectPorts = patch.first_port !== undefined || patch.second_port !== undefined;
      const changeSelection = selectPorts || patch.profile_id !== undefined;
      if (selectPorts && patch.profile_id) throw new Error("Select a profile or set manual ports in one request");
      const ensureStopped = () => {
        if (changeSelection && (currentSettings.current.active || currentSettings.current.busy
          || currentSettings.current.waitingForRestore)) {
          throw new Error("Stop the serial bridge before changing its profile or ports");
        }
      };
      ensureStopped();
      let profile: LogProfile | null = null;
      if (patch.profile_id) {
        const profiles = await invoke<LogProfile[]>("log_profiles_list");
        profile = profiles.find((entry) => entry.id === patch.profile_id && entry.bridge) ?? null;
        if (!profile) throw new Error(`Bridge profile not found: ${patch.profile_id}`);
      }
      ensureStopped();
      const current = currentSettings.current;
      const previousProfile = current.configuredProfile?.bridge;
      const nextSelection = changeSelection ? {
        first: profile?.bridge?.first.port_name ?? (patch.first_port === undefined
          ? previousProfile?.first.port_name ?? current.selection.first : patch.first_port ?? ""),
        second: profile?.bridge?.second.port_name ?? (patch.second_port === undefined
          ? previousProfile?.second.port_name ?? current.selection.second : patch.second_port ?? ""),
        profileId: profile?.id ?? "",
      } : previousProfile ? {
        ...current.selection, first: previousProfile.first.port_name, second: previousProfile.second.port_name,
      } : current.selection;
      if (changeSelection && nextSelection.first && nextSelection.first === nextSelection.second) {
        throw new Error("Choose two different ports for the serial bridge");
      }
      const nextDisplay = {
        format: patch.format ?? current.display.format,
        direction: patch.direction ? PUBLIC_DIRECTIONS[patch.direction] : current.display.direction,
        showTimestamps: patch.show_timestamps ?? current.display.showTimestamps,
        autoScroll: patch.auto_scroll ?? current.display.autoScroll,
      };
      // 在应答 CLI 前先写入和界面共用的存储，再提交界面状态。
      const previousDisplay = localStorage.getItem(BRIDGE_DISPLAY_KEY);
      localStorage.setItem(BRIDGE_DISPLAY_KEY, JSON.stringify(nextDisplay));
      try {
        if (changeSelection) localStorage.setItem(BRIDGE_SELECTION_KEY, JSON.stringify(nextSelection));
      } catch (reason) {
        if (previousDisplay === null) localStorage.removeItem(BRIDGE_DISPLAY_KEY);
        else localStorage.setItem(BRIDGE_DISPLAY_KEY, previousDisplay);
        throw reason;
      }
      flushSync(() => {
        if (changeSelection) {
          setSelection(nextSelection);
          setLoadedProfile(profile);
        }
        setDisplay(nextDisplay);
        if (patch.auto_scroll !== undefined) setFollowPaused(false);
      });
      return bridgeSettingsSnapshot(nextSelection, nextDisplay, current.active);
    },
  }), []);

  useEffect(() => {
    localStorage.setItem(BRIDGE_SELECTION_KEY, JSON.stringify(selection));
  }, [selection]);

  useEffect(() => {
    const id = selection.profileId;
    if (!id) return;
    let mounted = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const profiles = await invoke<LogProfile[]>("log_profiles_list");
        if (!mounted || request !== revision) return;
        const profile = profiles.find((entry) => entry.id === id && entry.bridge) ?? null;
        setLoadedProfile(profile);
        if (!profile) {
          setSelection((current) => current.profileId === id ? { ...current, profileId: "" } : current);
        }
      } catch (reason) {
        if (mounted && request === revision) onLog(`log_profiles_list error: ${String(reason)}`);
      }
    };
    const subscription = listen<string>("log-profiles-changed", ({ payload }) => {
      if (payload === id) void refresh();
    });
    void subscription.catch(() => {}).then(() => {
      if (mounted) void refresh();
    });
    return () => {
      mounted = false;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [onLog, selection.profileId]);

  useEffect(() => {
    localStorage.setItem(BRIDGE_DISPLAY_KEY, JSON.stringify(display));
  }, [display]);

  const prepareOutput = useCallback((bridgeId: string) => {
    if (outputBridgeId.current === bridgeId) return;
    outputBridgeId.current = bridgeId;
    decoders.current.clear();
    setFollowPaused(false);
    setRows([]);
  }, []);

  const showBridge = useCallback((bridge: BridgeInfo | null) => {
    if (!bridge || endedId.current === bridge.id) {
      setActive(null);
      return;
    }
    prepareOutput(bridge.id);
    setLogPath(bridge.log_path);
    setError(null);
    setActive(bridge);
    setLastBridge(bridge);
    if (rememberedBridgeId.current !== bridge.id) {
      const sessions = bridgeSessionPair(bridge.first_session_id, bridge.second_session_id);
      const logicalPort = (sessionId: string, physicalPort: string) =>
        portsRef.current.find((port) => port.sessionId === sessionId)?.restorePortName || physicalPort;
      const endpoints = pendingRestore.current?.sessions === sessions ? pendingRestore.current.endpoints : {
        first: logicalPort(bridge.first_session_id, bridge.first_port),
        second: logicalPort(bridge.second_session_id, bridge.second_port),
      };
      rememberedBridgeId.current = bridge.id;
      lastRestoreAttempt.current = sessions;
      restoreTargets.current = {
        endpoints, firstSessionId: bridge.first_session_id, secondSessionId: bridge.second_session_id,
      };
      setSelection((current) => current.profileId || current.first || current.second
        ? current : { ...endpoints, profileId: "" });
      setRestoreEndpoints(endpoints);
      localStorage.setItem(BRIDGE_RESTORE_KEY, JSON.stringify(endpoints));
    }
  }, [prepareOutput]);

  const clearRunningBridge = useCallback(() => {
    lastRestoreAttempt.current = "";
    pendingRestore.current = null;
    rememberedBridgeId.current = "";
    restoreTargets.current = null;
    setRestoreEndpoints(null);
    localStorage.removeItem(BRIDGE_RESTORE_KEY);
  }, []);

  useEffect(() => {
    let mounted = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const bridge = await invoke<BridgeInfo | null>("serial_bridge_status");
        if (mounted && current === request) {
          showBridge(bridge);
          setReady(true);
        }
      } catch (reason) {
        if (mounted && current === request) setError(String(reason));
      }
    };
    const dataListener = listen<BridgeData>("serial-bridge-data", ({ payload }) => {
      if (!mounted || payload.id === endedId.current) return;
      prepareOutput(payload.id);
      const sender = portsRef.current.find((port) => port.sessionId === payload.from_session_id);
      const receiver = portsRef.current.find((port) => port.sessionId === payload.to_session_id);
      const charset = sender?.charset ?? "utf-8";
      const bytes = Uint8Array.from(atob(payload.data_base64), (char) => char.charCodeAt(0));
      let text: string;
      if (charset === "latin1") {
        text = String.fromCharCode(...bytes);
      } else {
        let entry = decoders.current.get(payload.from_session_id);
        if (!entry || entry.charset !== charset) {
          entry = { charset, decoder: new TextDecoder(charset) };
          decoders.current.set(payload.from_session_id, entry);
        }
        text = entry.decoder.decode(bytes, { stream: true });
      }
      const row = {
        sequence: sequence.current++,
        fromSessionId: payload.from_session_id,
        timestamp: payload.timestamp,
        from: portDisplayName(sender, payload.from_port),
        to: portDisplayName(receiver, payload.to_port),
        bytes,
        text: showControlCharacters(text),
      };
      setRows((previous) => [...previous.slice(1 - LIVE_ROW_LIMIT), row]);
    });
    const endListener = listen<BridgeEnded>("serial-bridge-ended", ({ payload }) => {
      if (!mounted) return;
      endedId.current = payload.id;
      setActive((previous) => previous?.id === payload.id ? null : previous);
      if (rememberedBridgeId.current === payload.id && !payload.interrupted) clearRunningBridge();
      if (payload.error) {
        setError(payload.error);
        void onBridgeError();
      }
    });
    const changeListener = listen<BridgeInfo | null>("serial-bridge-changed", ({ payload }) => {
      if (mounted) {
        if (payload) showBridge(payload);
        void refresh();
      }
    });
    const stopListener = listen("serial-bridge-stopped", () => {
      if (mounted) clearRunningBridge();
    });
    const endpointListener = listen<LogSessionChange>("log-sessions-changed", ({ payload }) => {
      const targets = restoreTargets.current;
      const { kind, session } = payload;
      if (!mounted || !targets || kind !== "ended" || session.type !== "serial") return;
      if (session.id === targets.firstSessionId || session.id === targets.secondSessionId
        || session.port_name === targets.endpoints.first || session.port_name === targets.endpoints.second) {
        clearRunningBridge();
      }
    });
    const subscriptions = [dataListener, endListener, changeListener, stopListener, endpointListener];
    void Promise.all(subscriptions)
      .then(() => { if (mounted) return refresh(); })
      .catch((reason) => {
        if (mounted) setError(String(reason));
      });
    return () => {
      mounted = false;
      for (const listener of subscriptions) {
        void listener.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, [clearRunningBridge, onBridgeError, prepareOutput, showBridge]);

  useLayoutEffect(() => {
    const element = output.current;
    if (visible && element && display.autoScroll && !followPaused) element.scrollTop = element.scrollHeight;
  }, [rows, visible, display, followPaused]);

  const startBridge = useCallback(async (options: { profileId: string } | {
    firstSessionId: string; secondSessionId: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const bridge = "profileId" in options
        ? await invoke<BridgeInfo>("log_profile_bridge_start", options)
        : await invoke<BridgeInfo>("serial_bridge_start", options);
      if (endedId.current !== bridge.id) showBridge(bridge);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [showBridge]);

  useEffect(() => {
    if (!ready || !connectionsRestored || active || busy || !restoreTargets.current
      || !restoreEndpoints || !restoreFirst || !restoreSecond
      || restoreFirst.sessionId === restoreSecond.sessionId) return;
    const sessions = bridgeSessionPair(restoreFirst.sessionId, restoreSecond.sessionId);
    if (lastRestoreAttempt.current === sessions) return;
    lastRestoreAttempt.current = sessions;
    const pending = { endpoints: restoreEndpoints, sessions };
    pendingRestore.current = pending;
    void startBridge({ firstSessionId: restoreFirst.sessionId, secondSessionId: restoreSecond.sessionId }).finally(() => {
      if (pendingRestore.current === pending) pendingRestore.current = null;
    });
  }, [active, busy, connectionsRestored, ready, restoreEndpoints, restoreFirst, restoreSecond, startBridge]);

  const stopBridge = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("serial_bridge_stop");
      clearRunningBridge();
      setActive((previous) => previous?.id === active?.id ? null : previous);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const hasConnectedPair = !!first && !!second && first !== second;
  const canStart = ready && !busy && (selection.profileId ? !!configuredProfile : hasConnectedPair);
  const endpointSettingsLocked = busy || active !== null || waitingForRestore;
  const missingRestorePorts = waitingForRestore ? [
    restoreFirst ? null : restoreEndpoints.first,
    restoreSecond ? null : restoreEndpoints.second,
  ].filter(Boolean).join(", ") : "";
  const endpoints = [
    { key: "first", value: firstPort, other: secondPort, sessionId: first },
    { key: "second", value: secondPort, other: firstPort, sessionId: second },
  ] as const;
  const selectedDirection = display.direction === "firstToSecond" ? lastBridge?.first_session_id
    : display.direction === "secondToFirst" ? lastBridge?.second_session_id : undefined;
  const visibleRows = selectedDirection ? rows.filter((row) => row.fromSessionId === selectedDirection) : rows;
  const jumpToLatest = () => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
    setFollowPaused(false);
  };

  const settings = settingsHost && createPortal(
    <section className="border-t border-slate-200 dark:border-slate-800">
      <div className="space-y-3 p-4">
        <h3 className="font-medium">{t("multiLog.settingsPage.bridge")}</h3>
        {configuredProfile && !active && !waitingForRestore && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 max-w-full break-all font-medium">{configuredProfile.name}</span>
            <button
              type="button"
              onClick={() => setSelection((current) => ({
                first: configuredProfile.bridge?.first.port_name ?? current.first,
                second: configuredProfile.bridge?.second.port_name ?? current.second,
                profileId: "",
              }))}
              disabled={endpointSettingsLocked}
              className="ui-btn-secondary py-1"
            >
              {t("multiLog.bridge.useConnectedPorts")}
            </button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {endpoints.map(({ key, value, other, sessionId }) => {
            const port = ports.find((candidate) => candidate.sessionId === sessionId);
            const configuredEndpoint = active || waitingForRestore ? null : configuredProfile?.bridge?.[key];
            const details = configuredEndpoint
              ? lineSummary(configuredEndpoint.baud_rate, configuredEndpoint.line_coding)
              : port && lineSummary(port.baudRate, port.lineCoding);
            return (
              <label key={key} className="flex min-w-0 flex-col gap-1.5 text-xs">
                <span>{t(`multiLog.bridge.${key}`)}</span>
                {configuredEndpoint ? (
                  <span className="truncate font-mono" title={configuredEndpoint.port_name}>
                    {configuredEndpoint.label} · {configuredEndpoint.port_name}
                  </span>
                ) : (
                  <select
                    value={value}
                    onChange={(event) => {
                      const path = event.target.value;
                      setSelection((current) => ({ ...current, profileId: "", [key]: path }));
                    }}
                    disabled={endpointSettingsLocked}
                    className="ui-select w-full min-w-0 truncate py-1"
                  >
                    <option value="">{t("multiLog.bridge.selectPort")}</option>
                    {ports.map((candidate) => (
                      <option key={candidate.sessionId} value={bridgePortKey(candidate)} disabled={bridgePortKey(candidate) === other}>
                        {portDisplayName(candidate, candidate.portName)}
                      </option>
                    ))}
                    {value && !findBridgePort(ports, value) && (
                      <option value={value}>{value}</option>
                    )}
                  </select>
                )}
                {details && <span className="text-slate-500 dark:text-slate-400">{details}</span>}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("multiLog.bridge.editPortHint")}</p>
      </div>
      <div className="space-y-3 px-4 pb-4">
        <h3 className="font-medium">{t("multiLog.bridge.displaySettings")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
            {t("multiLog.bridge.displayFormat")}
            <select
              value={display.format}
              onChange={(event) => setDisplay((previous) => ({
                ...previous, format: event.target.value as SerialFormat,
              }))}
              className="ui-select min-w-[140px]"
            >
              <option value="text">{t("multiLog.formatText")}</option>
              <option value="hex">{t("multiLog.formatHex")}</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
            {t("multiLog.bridge.direction")}
            <select
              value={display.direction}
              onChange={(event) => setDisplay((previous) => ({
                ...previous, direction: event.target.value as BridgeDirection,
              }))}
              className="ui-select min-w-[140px]"
            >
              <option value="both">{t("multiLog.bridge.allDirections")}</option>
              <option value="firstToSecond">{t("multiLog.bridge.firstToSecond")}</option>
              <option value="secondToFirst">{t("multiLog.bridge.secondToFirst")}</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-xs">
            {t("multiLog.bridge.showTimestamps")}
            <input
              type="checkbox"
              checked={display.showTimestamps}
              onChange={(event) => {
                const showTimestamps = event.target.checked;
                setDisplay((previous) => ({ ...previous, showTimestamps }));
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-xs">
            {t("multiLog.autoScroll")}
            <input
              type="checkbox"
              checked={display.autoScroll}
              onChange={(event) => {
                const autoScroll = event.target.checked;
                setDisplay((previous) => ({ ...previous, autoScroll }));
                setFollowPaused(false);
              }}
            />
          </label>
        </div>
      </div>
    </section>,
    settingsHost,
  );

  return (
    <>
    <section className="ui-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 p-2 dark:border-slate-800">
        <button type="button" onClick={onShowSettings} className="ui-btn-secondary py-1">
          <Settings2 className="h-3.5 w-3.5" />
          {t("multiLog.bridge.openSettings")}
        </button>
        {active || waitingForRestore ? (
          <button type="button" onClick={stopBridge} disabled={busy} className="ui-btn-danger py-1">
            <Square className="h-3.5 w-3.5" />
            {t(active ? "multiLog.bridge.stop" : "multiLog.bridge.cancelRestore")}
          </button>
        ) : (
          <button type="button" onClick={() => {
            if (configuredProfile) void startBridge({ profileId: configuredProfile.id });
            else if (first && second) void startBridge({ firstSessionId: first, secondSessionId: second });
          }} disabled={!canStart} className="ui-btn-primary py-1">
            <Play className="h-3.5 w-3.5" />
            {t("multiLog.bridge.start")}
          </button>
        )}
        {active && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("multiLog.bridge.active")}</span>}
        {!active && !waitingForRestore && configuredProfile && <span className="min-w-0 max-w-full truncate text-xs" title={configuredProfile.name}>{configuredProfile.name}</span>}
      </div>
      {error && <div role="alert" className="ui-alert-err m-2 block max-h-24 shrink-0 overflow-y-auto break-all py-1.5 text-xs">{error}</div>}
      {missingRestorePorts && (
        <div role="status" className="shrink-0 break-all px-3 py-1 text-xs text-slate-500 dark:text-slate-400">
          {t("multiLog.bridge.restoreMissingPorts", { ports: missingRestorePorts })}
        </div>
      )}
      {logPath && (
        <div className="shrink-0 truncate border-b border-slate-200 px-3 py-1 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400" title={logPath}>
          {logPath}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={output}
          data-bridge-output
          onScroll={(event) => {
            const element = event.currentTarget;
            if (display.autoScroll && visible && element.clientHeight) {
              setFollowPaused(element.scrollHeight - element.clientHeight - element.scrollTop > 24);
            }
          }}
          className="h-full overflow-auto bg-slate-50 font-mono text-xs dark:bg-slate-950"
        >
        {visibleRows.length === 0 && (active || (!waitingForRestore && !canStart) || rows.length > 0) && (
          <p className="p-3 font-sans text-slate-500 dark:text-slate-400">
            {t(rows.length > 0 ? "multiLog.bridge.noMatchingRows"
              : active ? "multiLog.bridge.waiting" : "multiLog.bridge.instructions")}
          </p>
        )}
        {visibleRows.map((row) => (
          <BridgeLogRecord key={row.sequence} row={row} format={display.format} showTimestamps={display.showTimestamps} />
        ))}
        </div>
        {visibleRows.length > 0 && (!display.autoScroll || followPaused) && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="ui-btn-secondary absolute bottom-2 right-3 px-2 py-1"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {t("multiLog.jumpToLatest")}
          </button>
        )}
      </div>
    </section>
    {settings}
    </>
  );
}
