import type { SerialLineCoding } from "../types/workbench";
import type { SerialPaneState } from "./SerialPage";
import { configuredHighlightRules, HIGHLIGHT_COLORS, MAX_HIGHLIGHT_KEYWORD_LENGTH, MAX_HIGHLIGHT_RULES, type LogHighlightRule } from "../utils/logHighlight";

type JsonObject = Record<string, unknown>;

export interface LogUiRequest {
  id: string;
  action: "get" | "pane-set" | "layout-set" | "bridge-set" | "highlight-set";
  params: unknown;
}

export function settingsObject(value: unknown, description: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return value as JsonObject;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${field} must be a string without NUL bytes`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false`);
  return value;
}

function choice<const T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (!found) throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  return found;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function highlightRules(value: unknown): LogHighlightRule[] {
  if (!Array.isArray(value) || value.length > MAX_HIGHLIGHT_RULES) throw new Error(`highlight_rules must contain at most ${MAX_HIGHLIGHT_RULES} rules`);
  return value.map((item, index) => {
    const rule = settingsObject(item, `highlight_rules[${index}]`);
    const keyword = text(rule.keyword, `highlight_rules[${index}].keyword`).trim();
    if (!keyword || /[\r\n]/.test(keyword) || keyword.length > MAX_HIGHLIGHT_KEYWORD_LENGTH) throw new Error(`highlight_rules[${index}].keyword must contain 1 to ${MAX_HIGHLIGHT_KEYWORD_LENGTH} characters`);
    return { keyword, color: choice(rule.color, `highlight_rules[${index}].color`, HIGHLIGHT_COLORS) };
  });
}

export function sharedHighlightPatch(params: JsonObject): LogHighlightRule[] {
  if (Object.keys(params).length !== 1 || !("highlight_rules" in params)) {
    throw new Error("highlight-set requires highlight_rules");
  }
  return highlightRules(params.highlight_rules);
}

function updateLineCoding(value: unknown, current: SerialLineCoding): SerialLineCoding {
  const next = { ...current };
  for (const [field, setting] of Object.entries(settingsObject(value, "line_coding"))) {
    switch (field) {
      case "data_bits": next.data_bits = integer(setting, field, 5, 8); break;
      case "stop_bits": next.stop_bits = integer(setting, field, 1, 2); break;
      case "parity": next.parity = choice(setting, field, ["none", "even", "odd"]); break;
      case "flow_control": next.flow_control = choice(setting, field, ["none", "software", "hardware"]); break;
      default: throw new Error(`Unknown line_coding field: ${field}`);
    }
  }
  return next;
}

export function paneSettings(pane: SerialPaneState) {
  return {
    pane_id: pane.paneId,
    session_id: pane.sessionId,
    active: pane.connected,
    connecting: pane.connecting,
    stopping: pane.stopping,
    restore_on_startup: pane.resumeConnected,
    error: pane.error,
    label: pane.label ?? "",
    source: pane.source,
    port_name: pane.portName,
    baud_rate: pane.baudRate,
    line_coding: pane.coding,
    adb_serial: pane.adbSerial,
    adb_command: pane.adbCommand,
    receive_format: pane.receiveFormat,
    send_format: pane.sendFormat,
    charset: pane.charset,
    line_ending: pane.lineEnding,
    hidden: pane.hidden,
    show_timestamps: pane.showTimestamps,
    ansi_colors: pane.ansiEnabled,
    auto_scroll: pane.autoScroll,
    search_query: pane.searchQuery,
    filter_only: pane.filterOnly,
    highlight_rules: configuredHighlightRules(pane.highlightRules),
    level_colors: pane.levelColors,
  };
}

export function panePatch(params: JsonObject, pane: SerialPaneState, presets: number[]): Partial<SerialPaneState> {
  const next: Partial<SerialPaneState> = {};
  for (const [field, value] of Object.entries(params)) {
    switch (field) {
      case "pane_id": break;
      case "label": next.label = text(value, field).trim(); break;
      case "source": next.source = choice(value, field, ["serial", "adb"]); break;
      case "port_name": next.portName = text(value, field).trim(); break;
      case "baud_rate":
        next.baudRate = integer(value, field, 1, 0xffffffff);
        next.customBaud = !presets.includes(next.baudRate);
        break;
      case "line_coding": next.coding = updateLineCoding(value, pane.coding); break;
      case "adb_serial": next.adbSerial = text(value, field).trim(); break;
      case "adb_command": next.adbCommand = text(value, field).trim(); break;
      case "restore_on_startup":
        if (value !== false || pane.sessionId) {
          throw new Error("Set restore_on_startup to false to cancel a pending restore");
        }
        next.resumeConnected = false;
        break;
      case "receive_format": next.receiveFormat = choice(value, field, ["text", "hex"]); break;
      case "send_format": next.sendFormat = choice(value, field, ["text", "hex"]); break;
      case "charset": next.charset = choice(value, field, ["utf-8", "gb18030", "big5", "latin1"]); break;
      case "line_ending": next.lineEnding = choice(value, field, ["lf", "crlf", "cr", "none"]); break;
      case "hidden": next.hidden = bool(value, field); break;
      case "show_timestamps": next.showTimestamps = bool(value, field); break;
      case "ansi_colors": next.ansiEnabled = bool(value, field); break;
      case "auto_scroll": next.autoScroll = bool(value, field); break;
      case "search_query": next.searchQuery = text(value, field); break;
      case "filter_only": next.filterOnly = bool(value, field); break;
      case "highlight_rules": next.highlightRules = highlightRules(value); break;
      case "level_colors": next.levelColors = bool(value, field); break;
      default: throw new Error(`Unknown pane setting: ${field}`);
    }
  }

  const transport = ["source", "portName", "baudRate", "adbSerial", "adbCommand"] as const;
  const codingChanged = next.coding && JSON.stringify(next.coding) !== JSON.stringify(pane.coding);
  if (codingChanged || transport.some((key) => key in next && next[key] !== pane[key])) {
    if (pane.sessionId || pane.connected || pane.connecting || pane.stopping) {
      throw new Error("Stop log capture for this pane before changing its source or connection parameters");
    }
    next.resumeConnected = false;
  }
  if ((next.portName !== undefined && next.portName !== pane.portName) ||
      (next.source !== undefined && next.source !== pane.source)) {
    next.serialBinding = undefined;
  }
  if (next.source && next.source !== pane.source) {
    Object.assign(next, {
      panel: undefined, error: null, lines: [], hexRows: [], endsWithNewline: true,
      lastAdbStream: undefined, followPaused: false,
    });
  }
  if (next.autoScroll !== undefined) next.followPaused = false;
  if (next.hidden) next.panel = undefined;
  if (next.sendFormat !== undefined && next.sendFormat !== pane.sendFormat) next.historyIndex = -1;
  return next;
}

export function layoutPatch(params: JsonObject, panes: SerialPaneState[]) {
  let columns: number | undefined;
  let order: string[] | undefined;
  for (const [field, value] of Object.entries(params)) {
    if (field === "columns") {
      columns = integer(value, field, 2, 4);
    } else if (field === "pane_order") {
      const byId = new Map(panes.map((pane) => [pane.paneId, pane]));
      if (!Array.isArray(value) || value.length !== panes.length || new Set(value).size !== panes.length ||
          value.some((id) => typeof id !== "string" || !byId.has(id))) {
        throw new Error("pane_order must include each pane ID exactly once");
      }
      order = value;
    } else {
      throw new Error(`Unknown layout setting: ${field}`);
    }
  }
  return { columns, order };
}
