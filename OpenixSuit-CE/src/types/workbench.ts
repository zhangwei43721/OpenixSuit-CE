export interface SerialPortInfo {
  port_name: string;
  port_type: string;
  vid?: number | null;
  pid?: number | null;
  manufacturer: string;
  product: string;
  serial_number: string;
  aliases?: string[];
  usb_interface?: number | null;
}

export interface SerialSessionInfo {
  id: string;
  port_name: string;
  baud_rate: number;
  log_path: string;
  connected: boolean;
}

export interface SerialDataPayload {
  session_id: string;
  port_name: string;
  chunk: string;
  timestamp: string;
  /** Raw received bytes (base64); present so the UI can decode with the chosen charset. */
  data_base64?: string;
}

export interface SerialLineCoding {
  data_bits: number;
  stop_bits: number;
  parity: string;
  flow_control: string;
}

export interface SerialLogEntry {
  file_name: string;
  path: string;
  directory?: string;
  size_bytes: number;
  modified_secs: number;
}

export interface PowerProfile {
  draft?: boolean;
  id: string;
  name: string;
  kind: "serial_relay" | "serial_dtr_rts" | "http" | "command";
  port_name: string;
  baud_rate: number;
  on_cmd: string;
  off_cmd: string;
  hex_mode: boolean;
  http_on_url: string;
  http_off_url: string;
  cmd_on: string;
  cmd_off: string;
  cycle_delay_ms: number;
}

export interface TriggerCondition {
  kind: "contains" | "contains_cs" | "regex" | "timeout" | "count";
  pattern: string;
  timeout_secs: number;
  count_threshold: number;
}

export interface TriggerAction {
  kind: "power_control" | "send_ai" | "adb_reboot" | "serial_send" | "notify_webhook";
  power_profile_id: string;
  power_action: string;
  prompt: string;
  include_serial_lines: number;
  serial_data: string;
  webhook_url: string;
}

export interface TriggerRule {
  draft?: boolean;
  id: string;
  name: string;
  enabled: boolean;
  target_session_id: string;
  condition: TriggerCondition;
  actions: TriggerAction[];
  cooldown_secs: number;
  trigger_count: number;
  last_triggered_at: number;
}

export interface IncidentReport {
  id: string;
  rule_id: string;
  rule_name: string;
  session_id: string;
  port_name: string;
  matched_text: string;
  prompt: string;
  log_tail: string[];
  created_at: number;
  action_results: string[];
}

export interface CoreCounter {
  total: number;
  idle: number;
}

export interface NetCounter {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface DiskCounter {
  name: string;
  read_sectors: number;
  write_sectors: number;
}

export interface CpuSnapshot {
  total: number;
  idle: number;
  user: number;
  sys: number;
  iowait: number;
  cores: CoreCounter[];
  net: NetCounter[];
  disk: DiskCounter[];
  timestamp_ms: number;
}

export interface NetIfaceRate {
  name: string;
  rx_kbps: number;
  tx_kbps: number;
}

export interface DiskRate {
  name: string;
  read_kbps: number;
  write_kbps: number;
}

export interface StorageUsage {
  device: string;
  mount: string;
  fstype: string;
  total_kb: number;
  used_kb: number;
  avail_kb: number;
  use_pct: number;
}

export interface BatteryInfo {
  name: string;
  status: string;
  capacity_pct: number | null;
  voltage_v: number | null;
  current_ma: number | null;
  temp_c: number | null;
}

export interface DeviceMetrics {
  kernel: string;
  cpu_cores: number;
  cpu_total_pct: number;
  cpu_user_pct: number;
  cpu_sys_pct: number;
  cpu_io_pct: number;
  cpu_core_pcts: number[];
  mem_total_kb: number;
  mem_used_kb: number;
  mem_cached_kb: number;
  mem_buffers_kb: number;
  temp_celsius: number | null;
  load1: number;
  load5: number;
  load15: number;
  uptime_s: number;
  net_ifaces: NetIfaceRate[];
  net_rx_kbps: number;
  net_tx_kbps: number;
  disk_devices: DiskRate[];
  disk_read_kbps: number;
  disk_write_kbps: number;
  storage: StorageUsage[];
  battery: BatteryInfo | null;
  top_output: string;
  snapshot: CpuSnapshot;
  timestamp_ms: number;
}

export interface WorkspaceSerialSlot {
  label: string;
  port_name: string;
  baud_rate: number;
}

export type SerialFormat = "text" | "hex";
export type SerialCharset = "utf-8" | "gb18030" | "big5" | "latin1";
export type SerialLineEnding = "lf" | "crlf" | "cr" | "none";

export interface SerialViewOptions {
  receive_format: SerialFormat;
  send_format: SerialFormat;
  charset: SerialCharset;
  line_ending: SerialLineEnding;
  auto_scroll: boolean;
}

type SerialProfileEndpoint = WorkspaceSerialSlot & { line_coding?: SerialLineCoding };

export type LogProfileSource =
  | ({ type: "serial"; serial_options?: SerialViewOptions } & SerialProfileEndpoint)
  | { type: "adb"; label: string; serial: string; command: string };

export interface LogProfile {
  id: string;
  name: string;
  notes?: string;
  sources: LogProfileSource[];
  bridge?: {
    first: SerialProfileEndpoint;
    second: SerialProfileEndpoint;
  } | null;
}

export type LogSession = { id: string; label?: string | null; log_path: string } & (
  | {
      type: "serial";
      port_name: string;
      baud_rate: number;
      line_coding?: SerialLineCoding;
      serial_options?: SerialViewOptions;
    }
  | { type: "adb"; serial: string; command: string }
);

export interface LogSessionChange {
  kind: "started" | "ended" | "interrupted";
  session: LogSession;
  error?: string | null;
}

export interface DeviceWorkspace {
  id: string;
  name: string;
  chip: string;
  adb_serial: string;
  workspace_dir: string;
  power_profile_id: string;
  serial_ports: WorkspaceSerialSlot[];
  notes: string;
}

export interface FlashHistoryItem {
  id: string;
  firmware_path: string;
  firmware_name: string;
  mode: string;
  status: string;
  message: string;
  timestamp: number;
}

export interface AdbDetailedFileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  permissions: string;
  modified_time: string;
}
