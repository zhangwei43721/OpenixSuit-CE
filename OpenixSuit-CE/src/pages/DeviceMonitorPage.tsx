import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Battery,
  Cpu,
  FolderOpen,
  Gauge,
  HardDrive,
  LayoutGrid,
  List,
  MemoryStick,
  Network,
  Pause,
  Play,
  RefreshCw,
  Search,
  Thermometer,
  Trash2,
  Timer,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { MonitorLineChart } from "../components/MonitorLineChart";
import { BatteryInfo, CpuSnapshot, DeviceMetrics, StorageUsage } from "../types/workbench";
import { LogMarkedText } from "../utils/ansi";

interface DeviceMonitorPageProps {
  serial: string;
  onLog: (msg: string) => void;
  onNavigateAdbPath?: (remotePath: string) => void;
}

interface TopProcessRow {
  pid: string;
  user: string;
  stat: string;
  cpu: string;
  mem: string;
  command: string;
  paths: string[];
  extraCols: string[];
}

interface ParsedTopSnapshot {
  summaryLines: string[];
  headers: string[];
  rows: TopProcessRow[];
}

function extractUnixPaths(text: string): string[] {
  const matches = text.match(/\/[^\s'",;:|()<>{}[\]]+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.:]+$/, "");
    if (cleaned.length <= 1 || !cleaned.startsWith("/")) continue;
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function parseTopSnapshot(raw: string): ParsedTopSnapshot {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const summaryLines: string[] = [];
  let headerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i].toUpperCase();
    if (/^PID\s+/.test(upper)) {
      headerIdx = i;
      break;
    }
    summaryLines.push(lines[i]);
  }

  if (headerIdx < 0) {
    return { summaryLines: [], headers: [], rows: [] };
  }

  const headers = lines[headerIdx].split(/\s+/);
  const findCol = (candidates: string[]) =>
    headers.findIndex((h) => candidates.includes(h.toUpperCase()));

  const userIdx = findCol(["USER", "UID"]);
  const statIdx = findCol(["STAT", "S", "STATE"]);
  const cpuIdx = findCol(["%CPU", "CPU%", "CPU"]);
  const memIdx = findCol(["%MEM", "MEM%", "%VSZ", "RES", "VSZ"]);
  const cmdStartIdx = Math.max(0, headers.length - 1);

  const rows: TopProcessRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) continue;
    const cmdTokens = parts.slice(cmdStartIdx);
    const command = cmdTokens.length > 0 ? cmdTokens.join(" ") : parts[parts.length - 1];
    rows.push({
      pid: parts[0],
      user: userIdx >= 0 && parts[userIdx] ? parts[userIdx] : "-",
      stat: statIdx >= 0 && parts[statIdx] ? parts[statIdx] : "-",
      cpu: cpuIdx >= 0 && parts[cpuIdx] ? parts[cpuIdx] : "-",
      mem: memIdx >= 0 && parts[memIdx] ? parts[memIdx] : "-",
      command,
      paths: extractUnixPaths(command),
      extraCols: parts,
    });
  }

  return { summaryLines, headers, rows };
}

const MAX_HISTORY_POINTS = 300;

function kbToMb(kb: number): string {
  return (kb / 1024).toFixed(1);
}

function formatRate(kbps: number): string {
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps.toFixed(1)} KB/s`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function storageSize(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${kb} KB`;
}

export function DeviceMonitorPage({
  serial,
  onLog,
  onNavigateAdbPath,
}: DeviceMonitorPageProps) {
  const { i18n, t } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [samples, setSamples] = useState<DeviceMetrics[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(2000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statMode, setStatMode] = useState<"avg" | "max">("avg");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [topViewMode, setTopViewMode] = useState<"table" | "raw">("table");
  const [topQuery, setTopQuery] = useState("");
  const [selectedNetIface, setSelectedNetIface] = useState<string>("__all__");
  const [selectedDiskDev, setSelectedDiskDev] = useState<string>("__all__");
  const [storageBusy, setStorageBusy] = useState<string | null>(null);
  // 已卸载但记住的挂载点，用于重新挂载（df 不再列出它们）
  const [unmountedEntries, setUnmountedEntries] = useState<StorageUsage[]>([]);

  // 与后端同一白名单：只允许操作 /mnt/、/media/、/storage/ 下的路径
  const canManage = (mount: string) =>
    ["/mnt/", "/media/", "/storage/"].some((p) => mount.startsWith(p));

  const prevSnapshotRef = useRef<CpuSnapshot | null>(null);
  const cachedSlowRef = useRef<{
    kernel: string;
    storage: StorageUsage[];
    battery: BatteryInfo | null;
    top_output: string;
    lastSlowAt: number;
  }>({
    kernel: "",
    storage: [],
    battery: null,
    top_output: "",
    lastSlowAt: 0,
  });
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const fetchingRef = useRef(false);
  const lastErrRef = useRef<string | null>(null);
  const previousSerialRef = useRef(serial);

  const fetchMetrics = useCallback(
    async (forceSlow = false) => {
      if (!serial || fetchingRef.current) return;
      fetchingRef.current = true;
      setLoading(true);
      try {
        const now = Date.now();
        const needStatic = !cachedSlowRef.current.kernel;
        const needSlow = forceSlow || now - cachedSlowRef.current.lastSlowAt >= 10000;
        const data = await invoke<DeviceMetrics>("adb_get_metrics", {
          serial,
          prevSnapshot: prevSnapshotRef.current,
          includeStatic: needStatic,
          includeStorage: needSlow,
          includeTop: needSlow,
        });
        prevSnapshotRef.current = data.snapshot;
        if (needStatic && data.kernel) {
          cachedSlowRef.current.kernel = data.kernel;
        }
        if (needSlow) {
          cachedSlowRef.current.storage = data.storage;
          cachedSlowRef.current.battery = data.battery;
          cachedSlowRef.current.top_output = data.top_output;
          cachedSlowRef.current.lastSlowAt = now;
        }
        const merged: DeviceMetrics = {
          ...data,
          kernel: data.kernel || cachedSlowRef.current.kernel,
          storage: needSlow ? data.storage : cachedSlowRef.current.storage,
          battery: needSlow ? data.battery : cachedSlowRef.current.battery,
          top_output: needSlow ? data.top_output : cachedSlowRef.current.top_output,
        };
        // 已重新出现的挂载点从“已卸载”列表移除
        if (needSlow) {
          setUnmountedEntries((prev) =>
            prev.filter((u) => !merged.storage.some((s) => s.mount === u.mount))
          );
        }
        setSamples((prev) => {
          const next = [...prev, merged];
          return next.length > MAX_HISTORY_POINTS
            ? next.slice(next.length - MAX_HISTORY_POINTS)
            : next;
        });
        setError(null);
        lastErrRef.current = null;
      } catch (err) {
        const msg = String(err);
        setError(msg);
        if (lastErrRef.current !== msg) {
          lastErrRef.current = msg;
          onLogRef.current(`adb_get_metrics error: ${msg}`);
        }
      } finally {
        fetchingRef.current = false;
        setLoading(false);
      }
    },
    [serial]
  );

  const runStorageOp = useCallback(
    async (action: "mount" | "umount", entry: StorageUsage) => {
      if (!serial || storageBusy) return;
      setStorageBusy(entry.mount);
      try {
        const msg = await invoke<string>("adb_storage_mount", {
          serial,
          device: entry.device,
          mount: entry.mount,
          fstype: entry.fstype,
          mountIt: action === "mount",
        });
        onLogRef.current(`storage ${action} ${entry.mount}: ${msg || "OK"}`);
        setUnmountedEntries((prev) => {
          const rest = prev.filter((u) => u.mount !== entry.mount);
          return action === "umount" ? [...rest, entry] : rest;
        });
        setError(null);
        await fetchMetrics(true);
      } catch (err) {
        const m = String(err);
        setError(m);
        onLogRef.current(`storage ${action} ${entry.mount} error: ${m}`);
      } finally {
        setStorageBusy(null);
      }
    },
    [serial, storageBusy, fetchMetrics]
  );

  // Reset samples when serial changes
  useEffect(() => {
    if (serial) {
      if (previousSerialRef.current && previousSerialRef.current !== serial) {
        setSamples([]);
        setUnmountedEntries([]);
        prevSnapshotRef.current = null;
        cachedSlowRef.current = {
          kernel: "",
          storage: [],
          battery: null,
          top_output: "",
          lastSlowAt: 0,
        };
      }
      previousSerialRef.current = serial;
      lastErrRef.current = null;
      setError(null);
      fetchMetrics(true);
    }
  }, [serial, fetchMetrics]);

  // Poll at configured interval
  useEffect(() => {
    if (!serial || !autoRefresh) return;
    const timer = setInterval(() => {
      fetchMetrics(false);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [serial, autoRefresh, pollIntervalMs, fetchMetrics]);

  // 无窗口切换：始终展示全部保留采样
  const activeWindow = samples;
  const sampleTimes = useMemo(() => activeWindow.map((sample) => sample.timestamp_ms), [activeWindow]);

  const latest = samples[samples.length - 1] ?? null;

  const parsedTop = useMemo(() => parseTopSnapshot(latest?.top_output || ""), [latest?.top_output]);

  const filteredTopRows = useMemo(() => {
    const q = topQuery.trim().toLowerCase();
    if (!q) return parsedTop.rows;
    return parsedTop.rows.filter(
      (r) =>
        r.pid.includes(q) ||
        r.user.toLowerCase().includes(q) ||
        r.command.toLowerCase().includes(q)
    );
  }, [parsedTop.rows, topQuery]);

  const stats = useMemo(() => {
    if (activeWindow.length === 0) {
      return {
        cpuAvg: 0,
        cpuMax: 0,
        memAvg: 0,
        memMax: 0,
        netAvg: 0,
        netMax: 0,
        diskAvg: 0,
        diskMax: 0,
      };
    }
    let cpuSum = 0;
    let cpuMax = 0;
    let memSum = 0;
    let memMax = 0;
    let netSum = 0;
    let netMax = 0;
    let diskSum = 0;
    let diskMax = 0;
    for (const s of activeWindow) {
      cpuSum += s.cpu_total_pct;
      if (s.cpu_total_pct > cpuMax) cpuMax = s.cpu_total_pct;
      const memPct = s.mem_total_kb > 0 ? (s.mem_used_kb / s.mem_total_kb) * 100 : 0;
      memSum += memPct;
      if (memPct > memMax) memMax = memPct;
      const net =
        selectedNetIface === "__all__"
          ? { rx: s.net_rx_kbps, tx: s.net_tx_kbps }
          : (() => {
              const found = s.net_ifaces.find((i) => i.name === selectedNetIface);
              return { rx: found?.rx_kbps ?? 0, tx: found?.tx_kbps ?? 0 };
            })();
      const netRate = net.rx + net.tx;
      netSum += netRate;
      if (netRate > netMax) netMax = netRate;
      const disk =
        selectedDiskDev === "__all__"
          ? { r: s.disk_read_kbps, w: s.disk_write_kbps }
          : (() => {
              const found = s.disk_devices.find((d) => d.name === selectedDiskDev);
              return { r: found?.read_kbps ?? 0, w: found?.write_kbps ?? 0 };
            })();
      const diskRate = disk.r + disk.w;
      diskSum += diskRate;
      if (diskRate > diskMax) diskMax = diskRate;
    }
    const n = activeWindow.length;
    return {
      cpuAvg: cpuSum / n,
      cpuMax,
      memAvg: memSum / n,
      memMax,
      netAvg: netSum / n,
      netMax,
      diskAvg: diskSum / n,
      diskMax,
    };
  }, [activeWindow, selectedNetIface, selectedDiskDev]);

  const netIfaceNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of activeWindow) {
      for (const iface of s.net_ifaces) names.add(iface.name);
    }
    return Array.from(names);
  }, [activeWindow]);

  const diskDevNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of activeWindow) {
      for (const dev of s.disk_devices) names.add(dev.name);
    }
    return Array.from(names);
  }, [activeWindow]);

  const activeNetIface =
    selectedNetIface === "__all__" || netIfaceNames.includes(selectedNetIface)
      ? selectedNetIface
      : "__all__";
  const activeDiskDev =
    selectedDiskDev === "__all__" || diskDevNames.includes(selectedDiskDev)
      ? selectedDiskDev
      : "__all__";

  const cpuTotalSeries = useMemo(() => activeWindow.map((s) => s.cpu_total_pct), [activeWindow]);
  const cpuUserSeries = useMemo(() => activeWindow.map((s) => s.cpu_user_pct), [activeWindow]);
  const cpuSysSeries = useMemo(() => activeWindow.map((s) => s.cpu_sys_pct), [activeWindow]);
  const cpuIoSeries = useMemo(() => activeWindow.map((s) => s.cpu_io_pct), [activeWindow]);

  const memPctSeries = useMemo(
    () =>
      activeWindow.map((s) =>
        s.mem_total_kb > 0 ? (s.mem_used_kb / s.mem_total_kb) * 100 : 0
      ),
    [activeWindow]
  );
  const memCachedSeries = useMemo(
    () =>
      activeWindow.map((s) =>
        s.mem_total_kb > 0 ? ((s.mem_cached_kb + s.mem_buffers_kb) / s.mem_total_kb) * 100 : 0
      ),
    [activeWindow]
  );

  const netRxSeries = useMemo(
    () =>
      activeWindow.map((s) =>
        activeNetIface === "__all__"
          ? s.net_rx_kbps
          : s.net_ifaces.find((i) => i.name === activeNetIface)?.rx_kbps ?? 0
      ),
    [activeWindow, activeNetIface]
  );
  const netTxSeries = useMemo(
    () =>
      activeWindow.map((s) =>
        activeNetIface === "__all__"
          ? s.net_tx_kbps
          : s.net_ifaces.find((i) => i.name === activeNetIface)?.tx_kbps ?? 0
      ),
    [activeWindow, activeNetIface]
  );
  const diskReadSeries = useMemo(
    () =>
      activeWindow.map((s) =>
        activeDiskDev === "__all__"
          ? s.disk_read_kbps
          : s.disk_devices.find((d) => d.name === activeDiskDev)?.read_kbps ?? 0
      ),
    [activeWindow, activeDiskDev]
  );
  const diskWriteSeries = useMemo(
    () =>
      activeWindow.map((s) =>
        activeDiskDev === "__all__"
          ? s.disk_write_kbps
          : s.disk_devices.find((d) => d.name === activeDiskDev)?.write_kbps ?? 0
      ),
    [activeWindow, activeDiskDev]
  );

  const latestNetRx = latest
    ? activeNetIface === "__all__"
      ? latest.net_rx_kbps
      : latest.net_ifaces.find((i) => i.name === activeNetIface)?.rx_kbps ?? 0
    : 0;
  const latestNetTx = latest
    ? activeNetIface === "__all__"
      ? latest.net_tx_kbps
      : latest.net_ifaces.find((i) => i.name === activeNetIface)?.tx_kbps ?? 0
    : 0;
  const latestDiskRead = latest
    ? activeDiskDev === "__all__"
      ? latest.disk_read_kbps
      : latest.disk_devices.find((d) => d.name === activeDiskDev)?.read_kbps ?? 0
    : 0;
  const latestDiskWrite = latest
    ? activeDiskDev === "__all__"
      ? latest.disk_write_kbps
      : latest.disk_devices.find((d) => d.name === activeDiskDev)?.write_kbps ?? 0
    : 0;

  const latestMemPct =
    latest && latest.mem_total_kb > 0
      ? (latest.mem_used_kb / latest.mem_total_kb) * 100
      : 0;
  const latestCachedPct =
    latest && latest.mem_total_kb > 0
      ? (latest.mem_cached_kb / latest.mem_total_kb) * 100
      : 0;
  const latestBuffersPct =
    latest && latest.mem_total_kb > 0
      ? (latest.mem_buffers_kb / latest.mem_total_kb) * 100
      : 0;

  return (
    <div className="h-full flex flex-col gap-3 min-h-0 overflow-auto pr-0.5">
      {/* Top Control Bar */}
      <div className="ui-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <div className="ui-title">
            <Activity className="w-4 h-4 text-blue-500" />
            <span>{isEn ? "Device Performance Monitor" : "设备性能监控"}</span>
          </div>
          <span className="text-xs font-mono tabular-nums px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
            {serial || (isEn ? "No ADB Device" : "未连接设备")}
          </span>
          {latest && (
            <span className={`text-[11px] px-2 py-0.5 rounded-md border font-mono tabular-nums ${
              !serial || error
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20"
                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
            }`}>
              {!serial || error
                ? isEn ? "Stale snapshot" : "历史数据"
                : isEn ? "Live sample" : "实时采样"}
              {" · "}{new Date(latest.timestamp_ms).toLocaleTimeString()}
            </span>
          )}
          {latest && (
            <>
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-mono tabular-nums">
                {latest.cpu_cores} Cores · {latest.kernel || "Linux"}
              </span>
              <span
                className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border font-mono tabular-nums ${
                  latest.temp_celsius !== null && latest.temp_celsius >= 75
                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                }`}
              >
                <Thermometer className="w-3 h-3" />
                {latest.temp_celsius !== null ? `${latest.temp_celsius.toFixed(1)} °C` : "-- °C"}
              </span>
              <span
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border font-mono tabular-nums bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20"
                title={isEn ? "Load average (1/5/15 min)" : "负载均值（1/5/15 分钟）"}
              >
                <Gauge className="w-3 h-3" />
                {latest.load1.toFixed(2)} / {latest.load5.toFixed(2)} / {latest.load15.toFixed(2)}
              </span>
              <span
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border font-mono tabular-nums bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20"
                title={isEn ? "Uptime" : "运行时长"}
              >
                <Timer className="w-3 h-3" />
                {latest.uptime_s > 0 ? formatUptime(latest.uptime_s) : "--"}
              </span>
              {latest.battery && (
                <span
                  className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border font-mono tabular-nums bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                  title={`${latest.battery.name} · ${latest.battery.status}${
                    latest.battery.voltage_v != null
                      ? ` · ${latest.battery.voltage_v.toFixed(2)} V`
                      : ""
                  }${
                    latest.battery.current_ma != null
                      ? ` · ${latest.battery.current_ma.toFixed(0)} mA`
                      : ""
                  }${
                    latest.battery.temp_c != null ? ` · ${latest.battery.temp_c.toFixed(1)} °C` : ""
                  }`}
                >
                  <Battery className="w-3 h-3" />
                  {latest.battery.capacity_pct != null
                    ? `${latest.battery.capacity_pct.toFixed(0)}%`
                    : "--%"}
                  {latest.battery.status && ` · ${latest.battery.status}`}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Avg vs Max */}
          <div className="ui-segmented">
            <button
              onClick={() => setStatMode("avg")}
              className={`ui-segmented-btn ${
                statMode === "avg"
                  ? "bg-slate-800 text-white shadow-sm dark:bg-slate-700"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              {isEn ? "Avg" : "均值"}
            </button>
            <button
              onClick={() => setStatMode("max")}
              className={`ui-segmented-btn ${
                statMode === "max"
                  ? "bg-slate-800 text-white shadow-sm dark:bg-slate-700"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              {isEn ? "Max" : "峰值"}
            </button>
          </div>

          {/* Grid vs List */}
          <div className="ui-segmented">
            <button
              onClick={() => setLayoutMode("grid")}
              title={isEn ? "Grid View" : "网格布局"}
              className={`ui-segmented-btn px-2 ${
                layoutMode === "grid"
                  ? "bg-slate-800 text-white shadow-sm dark:bg-slate-700"
                  : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setLayoutMode("list")}
              title={isEn ? "List View" : "列表布局"}
              className={`ui-segmented-btn px-2 ${
                layoutMode === "list"
                  ? "bg-slate-800 text-white shadow-sm dark:bg-slate-700"
                  : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Auto-refresh toggle + interval */}
          <select
            value={pollIntervalMs}
            onChange={(e) => setPollIntervalMs(Number(e.target.value))}
            title={isEn ? "Sampling interval" : "采样间隔"}
            className="ui-select ui-select-compact text-xs font-mono"
          >
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>

          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={
              autoRefresh
                ? "inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
                : "ui-btn-secondary"
            }
          >
            {autoRefresh ? (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            ) : null}
            {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {autoRefresh ? (isEn ? "Pause" : "暂停轮询") : isEn ? "Resume" : "恢复轮询"}
          </button>

          <button
            onClick={() => fetchMetrics(true)}
            disabled={!serial || loading}
            className="ui-btn-secondary"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            {isEn ? "Refresh" : "刷新"}
          </button>

          <button
            onClick={() => setSamples([])}
            title={isEn ? "Clear History" : "清空记录"}
            className="ui-btn-secondary px-2 text-slate-500 hover:text-rose-500"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && <div className="ui-alert-err">{error}</div>}

      {/* Metrics Grid: 3-col aligned (CPU/Mem/Net on row 1, Disk 1/3 + Storage 2/3 on row 2) */}
      <div
        className={`grid gap-3 ${
          layoutMode === "grid" ? "grid-cols-1 lg:grid-cols-3" : "grid-cols-1"
        }`}
      >
        {/* CPU Chart Card */}
        <div className="ui-card p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="ui-title">
                <Cpu className="w-4 h-4 text-blue-500" />
                <span>{isEn ? "CPU Usage" : "CPU 使用率"}</span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono tabular-nums">
                <span className="text-blue-600 dark:text-blue-400">
                  Total: {latest ? `${latest.cpu_total_pct.toFixed(1)}%` : "--"}
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  User: {latest ? `${latest.cpu_user_pct.toFixed(1)}%` : "--"}
                </span>
                <span className="text-amber-600 dark:text-amber-400">
                  Sys: {latest ? `${latest.cpu_sys_pct.toFixed(1)}%` : "--"}
                </span>
                <span className="text-rose-600 dark:text-rose-400">
                  I/O: {latest ? `${latest.cpu_io_pct.toFixed(1)}%` : "--"}
                </span>
              </div>
            </div>

            <div className="text-right shrink-0 whitespace-nowrap">
              <div className="text-lg leading-tight font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {latest ? `${latest.cpu_total_pct.toFixed(1)}%` : "--"}
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                {statMode === "avg"
                  ? `${isEn ? "Avg" : "均值"}: ${stats.cpuAvg.toFixed(1)}%`
                  : `${isEn ? "Max" : "峰值"}: ${stats.cpuMax.toFixed(1)}%`}
              </div>
            </div>
          </div>

          <div className="ui-subcard w-full px-1.5 py-1">
            <MonitorLineChart
              id="cpuChart"
              sampleTimes={sampleTimes}
              locale={i18n.language}
              formatValue={(v) => `${v.toFixed(1)}%`}
              max={100}
              labelFor={(v) => `${Math.round(v)}%`}
              series={[
                { label: t("monitorChart.total"), values: cpuTotalSeries, color: "#0ea5e9", strokeWidth: 2.2, area: true },
                { label: t("monitorChart.user"), values: cpuUserSeries, color: "#10b981" },
                { label: t("monitorChart.system"), values: cpuSysSeries, color: "#f59e0b" },
                { label: t("monitorChart.io"), values: cpuIoSeries, color: "#f43f5e", strokeWidth: 1.3, dashed: true },
              ]}
            />
          </div>

          {/* Per-core usage bars */}
          {latest && latest.cpu_core_pcts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {latest.cpu_core_pcts.map((pct, idx) => (
                <div
                  key={idx}
                  title={`CPU${idx}: ${pct.toFixed(1)}%`}
                  className="ui-subcard flex items-center gap-1.5 px-2 py-1"
                >
                  <span className="text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    C{idx}
                  </span>
                  <div className="w-14 h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        pct >= 80
                          ? "bg-rose-500"
                          : pct >= 50
                          ? "bg-amber-500"
                          : "bg-blue-500"
                      }`}
                      style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono tabular-nums text-slate-600 dark:text-slate-300 w-8 text-right">
                    {pct.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Memory Chart Card */}
        <div className="ui-card p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="ui-title">
                <MemoryStick className="w-4 h-4 text-violet-500" />
                <span>{isEn ? "Memory Usage" : "内存使用率"}</span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono tabular-nums">
                <span className="text-violet-600 dark:text-violet-400">
                  Used: {latest ? `${kbToMb(latest.mem_used_kb)} MB` : "--"}
                </span>
                <span className="text-cyan-600 dark:text-cyan-400">
                  Cached: {latest ? `${kbToMb(latest.mem_cached_kb)} MB` : "--"}
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  Buffers: {latest ? `${kbToMb(latest.mem_buffers_kb)} MB` : "--"}
                </span>
                <span>
                  Total: {latest ? `${kbToMb(latest.mem_total_kb)} MB` : "--"}
                </span>
              </div>
            </div>

            <div className="text-right shrink-0 whitespace-nowrap">
              <div className="text-lg leading-tight font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {latest ? `${latestMemPct.toFixed(1)}%` : "--"}
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                {statMode === "avg"
                  ? `${isEn ? "Avg" : "均值"}: ${stats.memAvg.toFixed(1)}%`
                  : `${isEn ? "Max" : "峰值"}: ${stats.memMax.toFixed(1)}%`}
              </div>
            </div>
          </div>

          <div className="ui-subcard w-full px-1.5 py-1">
            <MonitorLineChart
              id="memChart"
              sampleTimes={sampleTimes}
              locale={i18n.language}
              formatValue={(v) => `${v.toFixed(1)}%`}
              max={100}
              labelFor={(v) => `${Math.round(v)}%`}
              series={[
                { label: t("monitorChart.used"), values: memPctSeries, color: "#8b5cf6", strokeWidth: 2.2, area: true },
                { label: t("monitorChart.cacheAndBuffers"), values: memCachedSeries, color: "#06b6d4", dashed: true },
              ]}
            />
          </div>

          {/* Memory Distribution Bar */}
          <div className="h-2 w-full rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800 flex">
            <div
              className="bg-violet-500 transition-all duration-300"
              style={{ width: `${Math.min(100, latestMemPct)}%` }}
              title="Used"
            />
            <div
              className="bg-cyan-500 transition-all duration-300"
              style={{ width: `${Math.min(100 - latestMemPct, latestCachedPct)}%` }}
              title="Cached"
            />
            <div
              className="bg-emerald-500 transition-all duration-300"
              style={{
                width: `${Math.min(
                  Math.max(0, 100 - latestMemPct - latestCachedPct),
                  latestBuffersPct
                )}%`,
              }}
              title="Buffers"
            />
          </div>
        </div>

        {/* Network Throughput Card */}
        <div className="ui-card p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="ui-title">
                <Network className="w-4 h-4 text-cyan-500" />
                <span>{isEn ? "Network Throughput" : "网络吞吐"}</span>
                {netIfaceNames.length > 0 && (
                  <select
                    value={activeNetIface}
                    onChange={(e) => setSelectedNetIface(e.target.value)}
                    className="ui-select ui-select-compact text-[11px] font-mono font-normal"
                  >
                    <option value="__all__">{isEn ? "All" : "全部"}</option>
                    {netIfaceNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono tabular-nums">
                <span className="text-cyan-600 dark:text-cyan-400">
                  ↓ {latest ? formatRate(latestNetRx) : "--"}
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  ↑ {latest ? formatRate(latestNetTx) : "--"}
                </span>
                {latest?.net_ifaces.slice(0, 4).map((iface) => (
                  <button
                    key={iface.name}
                    type="button"
                    onClick={() =>
                      setSelectedNetIface((cur) => (cur === iface.name ? "__all__" : iface.name))
                    }
                    className={`transition hover:text-slate-700 dark:hover:text-slate-200 ${
                      activeNetIface === iface.name
                        ? "font-semibold text-cyan-600 dark:text-cyan-400 underline underline-offset-2"
                        : "text-slate-400 dark:text-slate-500"
                    }`}
                  >
                    {iface.name}: ↓{iface.rx_kbps.toFixed(1)} ↑{iface.tx_kbps.toFixed(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-right shrink-0 whitespace-nowrap">
              <div className="text-lg leading-tight font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {latest ? formatRate(latestNetRx + latestNetTx) : "--"}
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                {statMode === "avg"
                  ? `${isEn ? "Avg" : "均值"}: ${formatRate(stats.netAvg)}`
                  : `${isEn ? "Max" : "峰值"}: ${formatRate(stats.netMax)}`}
              </div>
            </div>
          </div>

          <div className="ui-subcard w-full px-1.5 py-1">
            <MonitorLineChart
              id="netChart"
              sampleTimes={sampleTimes}
              locale={i18n.language}
              formatValue={formatRate}
              max={Math.max(...netRxSeries, ...netTxSeries, 0)}
              labelFor={(v) =>
                Math.max(...netRxSeries, ...netTxSeries, 0) > 0 ? formatRate(v) : "0"
              }
              series={[
                { label: t("monitorChart.receive"), values: netRxSeries, color: "#06b6d4", strokeWidth: 2.2, area: true },
                { label: t("monitorChart.send"), values: netTxSeries, color: "#10b981", dashed: true },
              ]}
            />
          </div>
        </div>

        {/* Disk I/O Card */}
        <div className="ui-card p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="ui-title">
                <HardDrive className="w-4 h-4 text-amber-500" />
                <span>{isEn ? "Disk I/O" : "磁盘 I/O"}</span>
                {diskDevNames.length > 0 && (
                  <select
                    value={activeDiskDev}
                    onChange={(e) => setSelectedDiskDev(e.target.value)}
                    className="ui-select ui-select-compact text-[11px] font-mono font-normal"
                  >
                    <option value="__all__">{isEn ? "All" : "全部"}</option>
                    {diskDevNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono tabular-nums">
                <span className="text-amber-600 dark:text-amber-400">
                  R: {latest ? formatRate(latestDiskRead) : "--"}
                </span>
                <span className="text-rose-600 dark:text-rose-400">
                  W: {latest ? formatRate(latestDiskWrite) : "--"}
                </span>
                {latest?.disk_devices.slice(0, 3).map((d) => (
                  <button
                    key={d.name}
                    type="button"
                    onClick={() =>
                      setSelectedDiskDev((cur) => (cur === d.name ? "__all__" : d.name))
                    }
                    className={`transition hover:text-slate-700 dark:hover:text-slate-200 ${
                      activeDiskDev === d.name
                        ? "font-semibold text-amber-600 dark:text-amber-400 underline underline-offset-2"
                        : "text-slate-400 dark:text-slate-500"
                    }`}
                  >
                    {d.name}: R{d.read_kbps.toFixed(1)} W{d.write_kbps.toFixed(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-right shrink-0 whitespace-nowrap">
              <div className="text-lg leading-tight font-bold font-mono tabular-nums text-slate-900 dark:text-white">
                {latest ? formatRate(latestDiskRead + latestDiskWrite) : "--"}
              </div>
              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                {statMode === "avg"
                  ? `${isEn ? "Avg" : "均值"}: ${formatRate(stats.diskAvg)}`
                  : `${isEn ? "Max" : "峰值"}: ${formatRate(stats.diskMax)}`}
              </div>
            </div>
          </div>

          <div className="ui-subcard w-full px-1.5 py-1">
            <MonitorLineChart
              id="diskChart"
              sampleTimes={sampleTimes}
              locale={i18n.language}
              formatValue={formatRate}
              max={Math.max(...diskReadSeries, ...diskWriteSeries, 0)}
              labelFor={(v) =>
                Math.max(...diskReadSeries, ...diskWriteSeries, 0) > 0 ? formatRate(v) : "0"
              }
              series={[
                { label: t("monitorChart.read"), values: diskReadSeries, color: "#f59e0b", strokeWidth: 2.2, area: true },
                { label: t("monitorChart.write"), values: diskWriteSeries, color: "#f43f5e", dashed: true },
              ]}
            />
          </div>
        </div>

        {/* Storage Usage Section (capability-gated) */}
        {latest && (latest.storage.length > 0 || unmountedEntries.length > 0) && (
          <div
            className={`ui-card p-3 flex flex-col gap-2 ${
              layoutMode === "grid" ? "lg:col-span-2" : ""
            }`}
          >
            <div className="ui-title">
              <HardDrive className="w-4 h-4 text-emerald-500" />
              <span>{isEn ? "Storage Usage" : "存储占用"}</span>
              <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300">
                {latest.storage.length +
                  unmountedEntries.filter((u) => !latest.storage.some((s) => s.mount === u.mount)).length}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[...latest.storage.map((s) => ({ entry: s, mounted: true })),
                ...unmountedEntries
                  .filter((u) => !latest.storage.some((s) => s.mount === u.mount))
                  .map((entry) => ({ entry, mounted: false }))].map(({ entry: m, mounted }) => (
                <div
                  key={m.mount}
                  className={`ui-subcard min-w-0 flex flex-col gap-1.5 px-2.5 py-2 ${
                    mounted ? "" : "opacity-60"
                  }`}
                  title={`${m.device} → ${m.mount}${m.fstype ? ` (${m.fstype})` : ""}`}
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="font-mono text-xs font-medium text-slate-700 dark:text-slate-200 truncate min-w-0">
                      {m.mount}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">
                        {storageSize(m.used_kb)} / {storageSize(m.total_kb)}
                      </span>
                      {canManage(m.mount) && (
                        <button
                          type="button"
                          disabled={storageBusy !== null}
                          onClick={() => runStorageOp(mounted ? "umount" : "mount", m)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition disabled:opacity-40 ${
                            mounted
                              ? "border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950"
                              : "border-emerald-300 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950"
                          }`}
                        >
                          {storageBusy === m.mount
                            ? "…"
                            : mounted
                            ? isEn
                              ? "Unmount"
                              : "卸载"
                            : isEn
                            ? "Mount"
                            : "挂载"}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          !mounted
                            ? "bg-slate-400"
                            : m.use_pct >= 90
                            ? "bg-rose-500"
                            : m.use_pct >= 75
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                        }`}
                        style={{
                          width: mounted
                            ? `${Math.min(100, Math.max(0, m.use_pct))}%`
                            : "0%",
                        }}
                      />
                    </div>
                    <span
                      className={`font-mono tabular-nums text-xs font-semibold w-10 text-right shrink-0 ${
                        !mounted
                          ? "text-slate-400 dark:text-slate-500"
                          : m.use_pct >= 90
                          ? "text-rose-600 dark:text-rose-400"
                          : m.use_pct >= 75
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {mounted ? `${m.use_pct.toFixed(0)}%` : isEn ? "off" : "未挂载"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Top Output Section */}
      <div className="ui-card flex-1 min-h-[260px] flex flex-col overflow-hidden">
        <div className="ui-card-header">
          <div className="flex items-center gap-2">
            <span className="ui-title">
              {isEn ? "Top Process Snapshot" : "Top 进程快照输出"}
            </span>
            {parsedTop.rows.length > 0 && (
              <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                {parsedTop.rows.length} procs
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {topViewMode === "table" && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={topQuery}
                  onChange={(e) => setTopQuery(e.target.value)}
                  placeholder={isEn ? "Filter PID / cmd / path..." : "过滤 PID / 进程 / 路径..."}
                  className="ui-input pl-7 w-44"
                />
              </div>
            )}

            <div className="ui-segmented">
              <button
                type="button"
                onClick={() => setTopViewMode("table")}
                className={`ui-segmented-btn ${
                  topViewMode === "table"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                }`}
              >
                {isEn ? "Table" : "结构化视图"}
              </button>
              <button
                type="button"
                onClick={() => setTopViewMode("raw")}
                className={`ui-segmented-btn ${
                  topViewMode === "raw"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                }`}
              >
                {isEn ? "Raw" : "原始输出"}
              </button>
            </div>

            <span className="text-[11px] font-mono tabular-nums text-slate-400">
              {latest ? new Date(latest.timestamp_ms).toLocaleTimeString() : "--:--:--"}
            </span>
          </div>
        </div>

        {topViewMode === "table" && parsedTop.rows.length > 0 ? (
          <div className="flex-1 overflow-auto p-4 space-y-3 bg-white dark:bg-slate-950">
            {parsedTop.summaryLines.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {parsedTop.summaryLines.map((line, i) => (
                  <span
                    key={i}
                    className="rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2 py-0.5 font-mono text-[11px] tabular-nums text-slate-600 dark:text-slate-300"
                  >
                    <LogMarkedText text={line} />
                  </span>
                ))}
              </div>
            )}

            <table className="w-full text-left font-mono text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-2 pr-3">PID</th>
                  <th className="py-2 pr-3">USER</th>
                  <th className="py-2 pr-3">STAT</th>
                  <th className="py-2 pr-3">CPU</th>
                  <th className="py-2 pr-3">MEM</th>
                  <th className="py-2">COMMAND &amp; PATH</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-900">
                {filteredTopRows.map((row) => {
                  const cpuNum = parseFloat(row.cpu.replace("%", "")) || 0;
                  return (
                    <tr key={`${row.pid}-${row.command}`} className="hover:bg-slate-50 dark:hover:bg-slate-900/60">
                      <td className="py-2 pr-3 tabular-nums text-slate-500"><LogMarkedText text={row.pid} /></td>
                      <td className="py-2 pr-3 text-slate-600 dark:text-slate-300"><LogMarkedText text={row.user} /></td>
                      <td className="py-2 pr-3 text-slate-500"><LogMarkedText text={row.stat} /></td>
                      <td className="py-2 pr-3 tabular-nums">
                        <span
                          className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] ${
                            cpuNum >= 50
                              ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                              : cpuNum >= 15
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : "text-slate-700 dark:text-slate-200"
                          }`}
                        >
                          <LogMarkedText text={row.cpu} />
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-slate-600 dark:text-slate-300"><LogMarkedText text={row.mem} /></td>
                      <td className="py-2 break-all">
                        <div className="text-slate-800 dark:text-slate-100"><LogMarkedText text={row.command} /></div>
                        {row.paths.length > 0 && onNavigateAdbPath && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {row.paths.map((p) => (
                              <button
                                key={p}
                                type="button"
                                onClick={() => onNavigateAdbPath(p)}
                                title={isEn ? `Locate ${p} in ADB Explorer` : `在 ADB 文件管理中定位 ${p}`}
                                className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-500/20 dark:text-blue-400"
                              >
                                <FolderOpen className="h-3 w-3 shrink-0" />
                                <span><LogMarkedText text={p} /></span>
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-5 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 whitespace-pre">
            {latest?.top_output ? (
              <LogMarkedText text={latest.top_output} />
            ) : serial
              ? isEn
                ? "Waiting for metrics sample..."
                : "等待采集设备性能数据..."
              : isEn
              ? "Please connect an ADB device first."
              : "请先连接一台 ADB 设备。"}
          </pre>
        )}
      </div>
    </div>
  );
}
