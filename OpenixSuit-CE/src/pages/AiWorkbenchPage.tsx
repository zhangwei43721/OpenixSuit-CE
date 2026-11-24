import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Bot,
  Check,
  Copy,
  FileCode2,
  RefreshCw,
  ShieldAlert,
  Terminal,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { IncidentReport } from "../types/workbench";
import {
  IncidentAnalysisOptions,
  IncidentAnalysisRecord,
  IncidentAnalysisResult,
} from "../components/IncidentAnalysis";
import { LogMarkedText } from "../utils/ansi";

export interface AiSyncTimelineItem {
  time: string;
  source: string;
  action: string;
  status: string;
  message: string;
}

interface AiWorkbenchPageProps {
  syncEvents: AiSyncTimelineItem[];
  onLog: (msg: string) => void;
}

const SKILL_PATH = "skills/openixsuit-ce/SKILL.md";

const CLI_CHEATSHEET = [
  {
    cmd: "openixsuit-ce ai status",
    zh: "查看当前 FEL / ADB / 串口会话与工作区状态",
    en: "Inspect FEL, ADB, serial sessions, and workspace status",
  },
  {
    cmd: "openixsuit-ce ai serial-ports",
    zh: "列出可用串口设备及当前打开的会话",
    en: "List available serial ports and active sessions",
  },
  {
    cmd: "openixsuit-ce ai serial-logs --tail 120",
    zh: "读取最近串口输出日志，供 AI 定位 Boot / Kernel 异常",
    en: "Read recent serial logs for AI boot/kernel diagnosis",
  },
  {
    cmd: "openixsuit-ce ai power --profile <id> --action cycle",
    zh: "控制可编程电源执行上电 / 断电 / 重启循环",
    en: "Control programmable power (on / off / cycle)",
  },
  {
    cmd: "openixsuit-ce ai metrics --serial <adb_serial>",
    zh: "获取 ADB 设备 CPU、内存、温度及 top 快照",
    en: "Fetch ADB device CPU, memory, thermal, and top metrics",
  },
  {
    cmd: "openixsuit-ce ai incidents",
    zh: "查看自动化规则捕获的异常事件与日志现场",
    en: "Inspect captured trigger incidents and log snapshots",
  },
];

function buildIncidentPrompt(inc: IncidentReport): string {
  return [
    `请基于 ${SKILL_PATH} 的 OpenixSuit-CE CLI 规范协助排查以下设备异常：`,
    "",
    `- 触发规则: ${inc.rule_name} (${inc.rule_id})`,
    `- 串口设备: ${inc.port_name || "N/A"} (Session: ${inc.session_id || "N/A"})`,
    `- 触发时间: ${new Date(inc.created_at * 1000).toLocaleString()}`,
    `- 命中文本: ${inc.matched_text}`,
    inc.prompt ? `- 排查指令: ${inc.prompt}` : "",
    inc.action_results.length > 0
      ? `- 已执行动作: ${inc.action_results.join("; ")}`
      : "",
    "",
    "### 最近串口日志现场",
    "```log",
    inc.log_tail.join("\n") || "(no serial tail captured)",
    "```",
    "",
    "如需要进一步获取设备状态、读取日志或执行电源循环，请直接调用 `openixsuit-ce ai ...` CLI 命令。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function AiWorkbenchPage({ syncEvents, onLog }: AiWorkbenchPageProps) {
  const { i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, IncidentAnalysisRecord>>({});
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<IncidentReport[]>("trigger_list_incidents");
      setIncidents(Array.isArray(list) ? list : []);
      if (Array.isArray(list) && list.length > 0) {
        const saved = await invoke<Record<string, IncidentAnalysisRecord>>(
          "incident_analysis_results",
          { incidentIds: list.map((incident) => incident.id) }
        );
        setAnalyses((current) => {
          const merged = { ...current };
          for (const [id, incoming] of Object.entries(saved)) {
            const status = merged[id]?.status;
            if (status !== "completed" && status !== "failed" &&
                !(status === "running" && incoming.status === "queued")) {
              merged[id] = incoming;
            }
          }
          return merged;
        });
      }
    } catch (err) {
      onLog(`trigger_list_incidents error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  useEffect(() => {
    loadIncidents();
  }, [loadIncidents]);

  useEffect(() => {
    const unlistenIncident = listen<IncidentReport>("trigger-fired", (event) => {
      if (event.payload) {
        setIncidents((prev) => [
          event.payload,
          ...prev.filter((incident) => incident.id !== event.payload.id),
        ].slice(0, 200));
      }
    });
    const unlistenAnalysis = listen<IncidentAnalysisRecord>("incident-analysis-updated", (event) => {
      const analysis = event.payload;
      setAnalyses((current) => ({ ...current, [analysis.incident_id]: analysis }));
    });
    return () => {
      unlistenIncident.then((unlisten) => unlisten());
      unlistenAnalysis.then((unlisten) => unlisten());
    };
  }, []);

  const copyText = async (key: string, text: string, logMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => {
        setCopiedId((cur) => (cur === key ? null : cur));
      }, 1800);
      onLog(logMsg);
    } catch (err) {
      onLog(`Clipboard error: ${String(err)}`);
    }
  };

  const handleClearIncidents = async () => {
    try {
      await invoke("trigger_clear_incidents");
      setIncidents([]);
      setAnalyses({});
      onLog(isEn ? "Cleared incidents" : "已清空异常事件");
    } catch (err) {
      onLog(`trigger_clear_incidents error: ${String(err)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto pr-0.5">
      {/* Header Banner */}
      <div className="ui-toolbar py-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg bg-violet-500/15 p-2 text-violet-600 dark:text-violet-400">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {isEn ? "AI CLI + Skill Collaboration Hub" : "AI 协同工作台 (CLI + Skill 模式)"}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isEn
                ? "Zero-config local collaboration with Claude Code, Codex, and OpenCode CLI via Skill + openixsuit-ce CLI."
                : "无需配置 MCP，直接通过 Skill 规范与 openixsuit-ce CLI 与 Claude Code / Codex / OpenCode 协同排障。"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="ui-subcard flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-xs text-slate-700 dark:text-slate-200">
            <FileCode2 className="h-3.5 w-3.5 text-blue-500" />
            <span>{SKILL_PATH}</span>
            <button
              type="button"
              onClick={() =>
                copyText(
                  "skill-path",
                  SKILL_PATH,
                  isEn ? "Copied Skill path" : "已复制 Skill 路径"
                )
              }
              className="ml-1 text-slate-400 transition hover:text-blue-500"
              title={isEn ? "Copy Skill Path" : "复制 Skill 路径"}
            >
              {copiedId === "skill-path" ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Grid: Incidents + Timeline */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left: Captured Trigger Incidents */}
        <div className="ui-card flex min-h-[280px] flex-col overflow-hidden xl:col-span-7">
          <div className="ui-card-header">
            <div className="ui-title">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              <span>
                {isEn
                  ? `Captured Trigger Incidents (${incidents.length})`
                  : `自动捕获的异常现场 (${incidents.length})`}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={loadIncidents}
                disabled={loading}
                className="ui-btn-secondary px-2.5 py-1"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                {isEn ? "Refresh" : "刷新"}
              </button>
              <button
                type="button"
                onClick={handleClearIncidents}
                disabled={loading || incidents.length === 0}
                className="ui-btn-secondary px-2.5 py-1 hover:text-rose-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {isEn ? "Clear" : "清空"}
              </button>
            </div>
          </div>

          <div className="flex-1 divide-y divide-slate-100 overflow-auto dark:divide-slate-800">
            {incidents.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">
                {isEn
                  ? "No trigger incidents yet. Configure rules in Automation to capture serial crashes or panics."
                  : "暂无捕获的异常事件。可在「自动化与电源」页面配置串口触发规则自动抓拍现场。"}
              </div>
            ) : (
              incidents.map((inc) => {
                const isCopied = copiedId === `inc-${inc.id}`;
                const analysis = analyses[inc.id];
                return (
                  <div key={inc.id} className="space-y-2.5 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300">
                          {inc.rule_name}
                        </span>
                        <span className="font-mono text-xs tabular-nums text-slate-500">
                          {inc.port_name || inc.session_id || "-"}
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-slate-400">
                          {new Date(inc.created_at * 1000).toLocaleString()}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          copyText(
                            `inc-${inc.id}`,
                            buildIncidentPrompt(inc),
                            isEn
                              ? `Copied AI troubleshooting prompt for ${inc.rule_name}`
                              : `已复制「${inc.rule_name}」排障 Prompt 与串口日志`
                          )
                        }
                        className={isCopied ? "ui-btn-success" : "ui-btn-primary"}
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {isCopied
                          ? isEn
                            ? "Copied!"
                            : "已复制"
                          : isEn
                          ? "Copy AI Prompt + Logs"
                          : "复制排障 Prompt + 串口日志"}
                      </button>
                    </div>

                    <div className="break-all rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 font-mono text-xs text-rose-600 dark:text-rose-400">
                      {inc.matched_text}
                    </div>

                    {inc.prompt && (
                      <div className="text-xs text-slate-600 dark:text-slate-300">
                        <span className="mr-1.5 text-slate-400">Prompt:</span>
                        {inc.prompt}
                      </div>
                    )}

                    {inc.log_tail.length > 0 && (
                      <pre className="ui-terminal max-h-36 overflow-auto whitespace-pre-wrap p-3 text-[11px]">
                        <LogMarkedText text={inc.log_tail.join("\n")} />
                      </pre>
                    )}
                    {analysis && <IncidentAnalysisResult analysis={analysis} />}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Live ai-sync-event Timeline + CLI Cheatsheet */}
        <div className="flex min-h-0 flex-col gap-4 xl:col-span-5">
          <IncidentAnalysisOptions />
          {/* Live ai-sync-event Timeline */}
          <div className="ui-card flex min-h-[200px] flex-1 flex-col overflow-hidden">
            <div className="ui-card-header">
              <div className="ui-title">
                <Activity className="h-4 w-4 text-blue-500" />
                <span>
                  {isEn
                    ? `Live CLI Sync Timeline (${syncEvents.length})`
                    : `CLI 实时协同时间线 (${syncEvents.length})`}
                </span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">ai-sync-event</span>
            </div>

            <div className="max-h-64 flex-1 divide-y divide-slate-100 overflow-auto dark:divide-slate-800">
              {syncEvents.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {isEn
                    ? "Waiting for CLI invocations (ai-sync-event)..."
                    : "暂无外部 CLI 调用记录，AI 工具执行命令后将在此实时同步。"}
                </div>
              ) : (
                [...syncEvents].reverse().map((ev, idx) => (
                  <div key={idx} className="space-y-1 px-4 py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                            ev.status === "completed"
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              : ev.status === "error"
                              ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                              : "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                          }`}
                        >
                          {ev.status}
                        </span>
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          {ev.source}
                        </span>
                        <span className="font-mono text-slate-500">{ev.action}</span>
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-slate-400">
                        {ev.time}
                      </span>
                    </div>
                    {ev.message && (
                      <div className="break-all text-[11px] text-slate-600 dark:text-slate-300">
                        {ev.message}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* CLI + Skill Quick Cheatsheet */}
          <div className="ui-card overflow-hidden">
            <div className="ui-card-header">
              <div className="ui-title">
                <Terminal className="h-4 w-4 text-emerald-500" />
                <span>{isEn ? "CLI + Skill Quick Cheatsheet" : "CLI + Skill 快速协同命令"}</span>
              </div>
              <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Claude Code · Codex · OpenCode
              </span>
            </div>

            <div className="max-h-80 space-y-2 overflow-auto p-3">
              {CLI_CHEATSHEET.map((item) => {
                const isCopied = copiedId === item.cmd;
                return (
                  <div
                    key={item.cmd}
                    className="ui-subcard flex items-center justify-between gap-2 p-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-blue-600 dark:text-blue-400">
                        {item.cmd}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        {isEn ? item.en : item.zh}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        copyText(item.cmd, item.cmd, `Copied CLI command: ${item.cmd}`)
                      }
                      className="ui-btn-secondary shrink-0 p-1.5"
                      title={isEn ? "Copy Command" : "复制命令"}
                    >
                      {isCopied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
