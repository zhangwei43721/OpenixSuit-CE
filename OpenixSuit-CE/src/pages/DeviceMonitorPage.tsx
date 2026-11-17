import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  Cpu,
  FolderOpen,
  History,
  LayoutGrid,
  List,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
  Search,
  Thermometer,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { CpuSnapshot, DeviceMetrics } from "../types/workbench";

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
const REALTIME_WINDOW = 30;

function kbToMb(kb: number): string {
  return (kb / 1024).toFixed(1);
}

function buildPolylinePoints(
  values: number[],
  width: number,
  height: number,
  padX = 8,
  padY = 10
): string {
  if (values.length === 0) return "";
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;
  if (values.length === 1) {
    const y = padY + usableH * (1 - Math.min(100, Math.max(0, values[0])) / 100);
    return `${padX},${y.toFixed(1)} ${width - padX},${y.toFixed(1)}`;
  }
  return values
    .map((val, idx) => {
      const x = padX + (idx / (values.length - 1)) * usableW;
      const clamped = Math.min(100, Math.max(0, val));
      const y = padY + usableH * (1 - clamped / 100);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function buildAreaPath(
  values: number[],
  width: number,
  height: number,
  padX = 8,
  padY = 10
): string {
  const pts = buildPolylinePoints(values, width, height, padX, padY);
  if (!pts) return "";
  const baseY = height - padY;
  const firstX = padX;
  const lastX = width - padX;
  return `M ${firstX},${baseY} L ${pts.replace(/ /g, " L ")} L ${lastX},${baseY} Z`;
}

export function DeviceMonitorPage({
  serial,
  onLog,
  onNavigateAdbPath,
}: DeviceMonitorPageProps) {
  const { i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [samples, setSamples] = useState<DeviceMetrics[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"realtime" | "history">("realtime");
  const [statMode, setStatMode] = useState<"avg" | "max">("avg");
  const [layoutMode, setLayoutMode] = useState<"grid" | "list">("grid");
  const [topViewMode, setTopViewMode] = useState<"table" | "raw">("table");
  const [topQuery, setTopQuery] = useState("");

  const prevSnapshotRef = useRef<CpuSnapshot | null>(null);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const fetchingRef = useRef(false);
  const lastErrRef = useRef<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!serial || fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const data = await invoke<DeviceMetrics>("adb_get_metrics", {
        serial,
        prevSnapshot: prevSnapshotRef.current,
      });
      prevSnapshotRef.current = data.snapshot;
      setSamples((prev) => {
        const next = [...prev, data];
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
  }, [serial]);

  // Reset samples when serial changes
  useEffect(() => {
    setSamples([]);
    prevSnapshotRef.current = null;
    lastErrRef.current = null;
    setError(null);
    if (serial) {
      fetchMetrics();
    }
  }, [serial, fetchMetrics]);

  // Poll every 2s
  useEffect(() => {
    if (!serial || !autoRefresh) return;
    const timer = setInterval(() => {
      fetchMetrics();
    }, 2000);
    return () => clearInterval(timer);
  }, [serial, autoRefresh, fetchMetrics]);

  const activeWindow = useMemo(() => {
    if (viewMode === "history") return samples;
    return samples.slice(-REALTIME_WINDOW);
  }, [samples, viewMode]);

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
      };
    }
    let cpuSum = 0;
    let cpuMax = 0;
    let memSum = 0;
    let memMax = 0;
    for (const s of activeWindow) {
      cpuSum += s.cpu_total_pct;
      if (s.cpu_total_pct > cpuMax) cpuMax = s.cpu_total_pct;
      const memPct = s.mem_total_kb > 0 ? (s.mem_used_kb / s.mem_total_kb) * 100 : 0;
      memSum += memPct;
      if (memPct > memMax) memMax = memPct;
    }
    return {
      cpuAvg: cpuSum / activeWindow.length,
      cpuMax,
      memAvg: memSum / activeWindow.length,
      memMax,
    };
  }, [activeWindow]);

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

  const svgW = 560;
  const svgH = 170;

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
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
            <Activity className="w-4 h-4 text-blue-500" />
            <span>{isEn ? "Device Performance Monitor" : "设备性能监控"}</span>
          </div>
          <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
            {serial || (isEn ? "No ADB Device" : "未连接设备")}
          </span>
          {latest && (
            <>
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-mono">
                {latest.cpu_cores} Cores · {latest.kernel || "Linux"}
              </span>
              <span
                className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border font-mono ${
                  latest.temp_celsius !== null && latest.temp_celsius >= 75
                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                }`}
              >
                <Thermometer className="w-3 h-3" />
                {latest.temp_celsius !== null ? `${latest.temp_celsius.toFixed(1)} °C` : "-- °C"}
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Realtime vs History */}
          <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-950">
            <button
              onClick={() => setViewMode("realtime")}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                viewMode === "realtime"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {isEn ? "Realtime" : "实时监控"}
            </button>
            <button
              onClick={() => setViewMode("history")}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition ${
                viewMode === "history"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              <History className="w-3 h-3" />
              {isEn ? `History (${samples.length})` : `历史记录 (${samples.length})`}
            </button>
          </div>

          {/* Avg vs Max */}
          <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-950">
            <button
              onClick={() => setStatMode("avg")}
              className={`px-2 py-1 rounded-md text-xs font-medium transition ${
                statMode === "avg"
                  ? "bg-slate-800 dark:bg-slate-700 text-white"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {isEn ? "Avg" : "均值"}
            </button>
            <button
              onClick={() => setStatMode("max")}
              className={`px-2 py-1 rounded-md text-xs font-medium transition ${
                statMode === "max"
                  ? "bg-slate-800 dark:bg-slate-700 text-white"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {isEn ? "Max" : "峰值"}
            </button>
          </div>

          {/* Grid vs List */}
          <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-950">
            <button
              onClick={() => setLayoutMode("grid")}
              title={isEn ? "Grid View" : "网格布局"}
              className={`p-1.5 rounded-md transition ${
                layoutMode === "grid"
                  ? "bg-slate-800 dark:bg-slate-700 text-white"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setLayoutMode("list")}
              title={isEn ? "List View" : "列表布局"}
              className={`p-1.5 rounded-md transition ${
                layoutMode === "list"
                  ? "bg-slate-800 dark:bg-slate-700 text-white"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition ${
              autoRefresh
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            }`}
          >
            {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {autoRefresh ? (isEn ? "Live 2s" : "暂停轮询") : isEn ? "Resume" : "恢复轮询"}
          </button>

          <button
            onClick={fetchMetrics}
            disabled={!serial || loading}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 disabled:opacity-40 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            {isEn ? "Refresh" : "刷新"}
          </button>

          <button
            onClick={() => setSamples([])}
            title={isEn ? "Clear History" : "清空记录"}
            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-500 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {/* Charts Section */}
      <div
        className={`grid gap-3 ${
          layoutMode === "grid" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"
        }`}
      >
        {/* CPU Chart Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <Cpu className="w-4 h-4 text-blue-500" />
                <span>{isEn ? "CPU Usage" : "CPU 使用率"}</span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-3 font-mono">
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

            <div className="text-right">
              <div className="text-xl font-bold font-mono text-slate-900 dark:text-white">
                {latest ? `${latest.cpu_total_pct.toFixed(1)}%` : "--"}
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {statMode === "avg"
                  ? `${isEn ? "Avg" : "均值"}: ${stats.cpuAvg.toFixed(1)}%`
                  : `${isEn ? "Max" : "峰值"}: ${stats.cpuMax.toFixed(1)}%`}
              </div>
            </div>
          </div>

          <div className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2">
            <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-40 overflow-visible">
              <defs>
                <linearGradient id="cpuAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {[0, 25, 50, 75, 100].map((pct) => {
                const y = 10 + (svgH - 20) * (1 - pct / 100);
                return (
                  <g key={pct}>
                    <line
                      x1={8}
                      y1={y}
                      x2={svgW - 8}
                      y2={y}
                      stroke="currentColor"
                      className="text-slate-200 dark:text-slate-800"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={10}
                      y={y - 3}
                      fontSize="9"
                      className="fill-slate-400 dark:fill-slate-600 font-mono"
                    >
                      {pct}%
                    </text>
                  </g>
                );
              })}

              {cpuTotalSeries.length > 0 && (
                <>
                  <path
                    d={buildAreaPath(cpuTotalSeries, svgW, svgH)}
                    fill="url(#cpuAreaGrad)"
                  />
                  <polyline
                    fill="none"
                    stroke="#0ea5e9"
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                    points={buildPolylinePoints(cpuTotalSeries, svgW, svgH)}
                  />
                  <polyline
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="1.4"
                    strokeOpacity="0.85"
                    points={buildPolylinePoints(cpuUserSeries, svgW, svgH)}
                  />
                  <polyline
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="1.4"
                    strokeOpacity="0.85"
                    points={buildPolylinePoints(cpuSysSeries, svgW, svgH)}
                  />
                  <polyline
                    fill="none"
                    stroke="#f43f5e"
                    strokeWidth="1.3"
                    strokeDasharray="3 2"
                    strokeOpacity="0.85"
                    points={buildPolylinePoints(cpuIoSeries, svgW, svgH)}
                  />
                </>
              )}
            </svg>
          </div>
        </div>

        {/* Memory Chart Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <MemoryStick className="w-4 h-4 text-violet-500" />
                <span>{isEn ? "Memory Usage" : "内存使用率"}</span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-3 font-mono">
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

            <div className="text-right">
              <div className="text-xl font-bold font-mono text-slate-900 dark:text-white">
                {latest ? `${latestMemPct.toFixed(1)}%` : "--"}
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {statMode === "avg"
                  ? `${isEn ? "Avg" : "均值"}: ${stats.memAvg.toFixed(1)}%`
                  : `${isEn ? "Max" : "峰值"}: ${stats.memMax.toFixed(1)}%`}
              </div>
            </div>
          </div>

          <div className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2">
            <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-40 overflow-visible">
              <defs>
                <linearGradient id="memAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {[0, 25, 50, 75, 100].map((pct) => {
                const y = 10 + (svgH - 20) * (1 - pct / 100);
                return (
                  <g key={pct}>
                    <line
                      x1={8}
                      y1={y}
                      x2={svgW - 8}
                      y2={y}
                      stroke="currentColor"
                      className="text-slate-200 dark:text-slate-800"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={10}
                      y={y - 3}
                      fontSize="9"
                      className="fill-slate-400 dark:fill-slate-600 font-mono"
                    >
                      {pct}%
                    </text>
                  </g>
                );
              })}

              {memPctSeries.length > 0 && (
                <>
                  <path d={buildAreaPath(memPctSeries, svgW, svgH)} fill="url(#memAreaGrad)" />
                  <polyline
                    fill="none"
                    stroke="#8b5cf6"
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                    points={buildPolylinePoints(memPctSeries, svgW, svgH)}
                  />
                  <polyline
                    fill="none"
                    stroke="#06b6d4"
                    strokeWidth="1.4"
                    strokeDasharray="4 2"
                    points={buildPolylinePoints(memCachedSeries, svgW, svgH)}
                  />
                </>
              )}
            </svg>
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
      </div>

      {/* Top Output Section */}
      <div className="flex-1 min-h-[240px] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              {isEn ? "Top Process Snapshot" : "Top 进程快照输出"}
            </span>
            {parsedTop.rows.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                {parsedTop.rows.length} procs
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {topViewMode === "table" && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1.5 pointer-events-none" />
                <input
                  value={topQuery}
                  onChange={(e) => setTopQuery(e.target.value)}
                  placeholder={isEn ? "Filter PID / cmd / path..." : "过滤 PID / 进程 / 路径..."}
                  className="pl-7 pr-2 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-44"
                />
              </div>
            )}

            <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px]">
              <button
                type="button"
                onClick={() => setTopViewMode("table")}
                className={`px-2.5 py-1 ${
                  topViewMode === "table"
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"
                }`}
              >
                {isEn ? "Table" : "结构化视图"}
              </button>
              <button
                type="button"
                onClick={() => setTopViewMode("raw")}
                className={`px-2.5 py-1 ${
                  topViewMode === "raw"
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"
                }`}
              >
                {isEn ? "Raw" : "原始输出"}
              </button>
            </div>

            <span className="text-[11px] font-mono text-slate-400">
              {latest ? new Date(latest.timestamp_ms).toLocaleTimeString() : "--:--:--"}
            </span>
          </div>
        </div>

        {topViewMode === "table" && parsedTop.rows.length > 0 ? (
          <div className="flex-1 overflow-auto p-3 space-y-2 bg-white dark:bg-slate-950">
            {parsedTop.summaryLines.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {parsedTop.summaryLines.map((line, i) => (
                  <span
                    key={i}
                    className="rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-300"
                  >
                    {line}
                  </span>
                ))}
              </div>
            )}

            <table className="w-full text-left font-mono text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                <tr>
                  <th className="py-1.5 pr-3">PID</th>
                  <th className="py-1.5 pr-3">USER</th>
                  <th className="py-1.5 pr-3">STAT</th>
                  <th className="py-1.5 pr-3">CPU</th>
                  <th className="py-1.5 pr-3">MEM</th>
                  <th className="py-1.5">COMMAND &amp; PATH</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-900">
                {filteredTopRows.map((row) => {
                  const cpuNum = parseFloat(row.cpu.replace("%", "")) || 0;
                  return (
                    <tr key={`${row.pid}-${row.command}`} className="hover:bg-slate-50 dark:hover:bg-slate-900/60">
                      <td className="py-1.5 pr-3 text-slate-500">{row.pid}</td>
                      <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-300">{row.user}</td>
                      <td className="py-1.5 pr-3 text-slate-500">{row.stat}</td>
                      <td className="py-1.5 pr-3">
                        <span
                          className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] ${
                            cpuNum >= 50
                              ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                              : cpuNum >= 15
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : "text-slate-700 dark:text-slate-200"
                          }`}
                        >
                          {row.cpu}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-slate-600 dark:text-slate-300">{row.mem}</td>
                      <td className="py-1.5 break-all">
                        <div className="text-slate-800 dark:text-slate-100">{row.command}</div>
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
                                <span>{p}</span>
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
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 whitespace-pre">
            {latest?.top_output ||
              (serial
                ? isEn
                  ? "Waiting for metrics sample..."
                  : "等待采集设备性能数据..."
                : isEn
                ? "Please connect an ADB device first."
                : "请先连接一台 ADB 设备。")}
          </pre>
        )}
      </div>
    </div>
  );
}
