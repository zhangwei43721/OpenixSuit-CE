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
    inc.log_tail || "(no serial tail captured)",
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
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<IncidentReport[]>("trigger_list_incidents");
      setIncidents(Array.isArray(list) ? list : []);
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
    let unlisten: (() => void) | undefined;
    listen<IncidentReport>("trigger-fired", (event) => {
      if (event.payload) {
        setIncidents((prev) => [event.payload, ...prev].slice(0, 200));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
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
      onLog(isEn ? "Cleared incidents" : "已清空异常事件");
    } catch (err) {
      onLog(`trigger_clear_incidents error: ${String(err)}`);
    }
  };

  return (
    <div className="h-full flex flex-col gap-3 min-h-0 overflow-auto pr-0.5">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-400">
            <Bot className="w-5 h-5" />
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
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-700 dark:text-slate-200">
            <FileCode2 className="w-3.5 h-3.5 text-blue-500" />
            <span>{SKILL_PATH}</span>
            <button
              onClick={() =>
                copyText(
                  "skill-path",
                  SKILL_PATH,
                  isEn ? "Copied Skill path" : "已复制 Skill 路径"
                )
              }
              className="ml-1 text-slate-400 hover:text-blue-500 transition"
              title={isEn ? "Copy Skill Path" : "复制 Skill 路径"}
            >
              {copiedId === "skill-path" ? (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Grid: Incidents + Timeline */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 flex-1 min-h-0">
        {/* Left: Captured Trigger Incidents */}
        <div className="xl:col-span-7 flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden min-h-[280px]">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span>
                {isEn
                  ? `Captured Trigger Incidents (${incidents.length})`
                  : `自动捕获的异常现场 (${incidents.length})`}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={loadIncidents}
                disabled={loading}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                {isEn ? "Refresh" : "刷新"}
              </button>
              <button
                onClick={handleClearIncidents}
                disabled={incidents.length === 0}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-slate-200 dark:border-slate-700 hover:text-rose-500 text-slate-500 disabled:opacity-40"
              >
                <Trash2 className="w-3 h-3" />
                {isEn ? "Clear" : "清空"}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
            {incidents.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">
                {isEn
                  ? "No trigger incidents yet. Configure rules in Automation to capture serial crashes or panics."
                  : "暂无捕获的异常事件。可在「自动化与电源」页面配置串口触发规则自动抓拍现场。"}
              </div>
            ) : (
              incidents.map((inc) => {
                const isCopied = copiedId === `inc-${inc.id}`;
                return (
                  <div key={inc.id} className="p-3.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300">
                          {inc.rule_name}
                        </span>
                        <span className="text-xs font-mono text-slate-500">
                          {inc.port_name || inc.session_id || "-"}
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          {new Date(inc.created_at * 1000).toLocaleString()}
                        </span>
                      </div>

                      <button
                        onClick={() =>
                          copyText(
                            `inc-${inc.id}`,
                            buildIncidentPrompt(inc),
                            isEn
                              ? `Copied AI troubleshooting prompt for ${inc.rule_name}`
                              : `已复制「${inc.rule_name}」排障 Prompt 与串口日志`
                          )
                        }
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                          isCopied
                            ? "bg-emerald-600 text-white"
                            : "bg-blue-600 hover:bg-blue-500 text-white"
                        }`}
                      >
                        {isCopied ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
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

                    <div className="text-xs font-mono text-rose-600 dark:text-rose-400 bg-rose-500/5 border border-rose-500/15 rounded-md px-2.5 py-1.5 break-all">
                      {inc.matched_text}
                    </div>

                    {inc.prompt && (
                      <div className="text-xs text-slate-600 dark:text-slate-300">
                        <span className="text-slate-400 mr-1">Prompt:</span>
                        {inc.prompt}
                      </div>
                    )}

                    {inc.log_tail && (
                      <pre className="text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 max-h-36 overflow-auto text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                        {inc.log_tail}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Live ai-sync-event Timeline + CLI Cheatsheet */}
        <div className="xl:col-span-5 flex flex-col gap-3 min-h-0">
          {/* Live ai-sync-event Timeline */}
          <div className="flex-1 flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden min-h-[200px]">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <Activity className="w-4 h-4 text-blue-500" />
                <span>
                  {isEn
                    ? `Live CLI Sync Timeline (${syncEvents.length})`
                    : `CLI 实时协同时间线 (${syncEvents.length})`}
                </span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">ai-sync-event</span>
            </div>

            <div className="flex-1 overflow-auto divide-y divide-slate-100 dark:divide-slate-800 max-h-64">
              {syncEvents.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {isEn
                    ? "Waiting for CLI invocations (ai-sync-event)..."
                    : "暂无外部 CLI 调用记录，AI 工具执行命令后将在此实时同步。"}
                </div>
              ) : (
                [...syncEvents].reverse().map((ev, idx) => (
                  <div key={idx} className="px-3.5 py-2.5 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono uppercase ${
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
                      <span className="text-[10px] font-mono text-slate-400">{ev.time}</span>
                    </div>
                    {ev.message && (
                      <div className="text-[11px] text-slate-600 dark:text-slate-300 break-all">
                        {ev.message}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* CLI + Skill Quick Cheatsheet */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <Terminal className="w-4 h-4 text-emerald-500" />
                <span>{isEn ? "CLI + Skill Quick Cheatsheet" : "CLI + Skill 快速协同命令"}</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                Claude Code · Codex · OpenCode
              </span>
            </div>

            <div className="p-3 space-y-2 max-h-80 overflow-auto">
              {CLI_CHEATSHEET.map((item) => {
                const isCopied = copiedId === item.cmd;
                return (
                  <div
                    key={item.cmd}
                    className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-mono text-blue-600 dark:text-blue-400 truncate">
                        {item.cmd}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {isEn ? item.en : item.zh}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        copyText(item.cmd, item.cmd, `Copied CLI command: ${item.cmd}`)
                      }
                      className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 shrink-0"
                      title={isEn ? "Copy Command" : "复制命令"}
                    >
                      {isCopied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
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
