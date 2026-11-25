import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Bot,
  Check,
  Copy,
  ChevronDown,
  RefreshCw,
  ShieldAlert,
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
const SKILL_REPOSITORY_URL = "https://github.com/zhangwei43721/openixsuit-ce-skill";

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
  const { t, i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, IncidentAnalysisRecord>>({});
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deviceFilter, setDeviceFilter] = useState("");
  const [ruleFilter, setRuleFilter] = useState("");
  const [analysisFilter, setAnalysisFilter] = useState("all");

  const filteredIncidents = useMemo(() => {
    const deviceQuery = deviceFilter.trim().toLowerCase();
    const ruleQuery = ruleFilter.trim().toLowerCase();
    return incidents.filter((incident) => {
      const device = `${incident.port_name} ${incident.session_id}`.toLowerCase();
      const analysisStatus = analyses[incident.id]?.status ?? "not-started";
      return (!deviceQuery || device.includes(deviceQuery)) &&
        (!ruleQuery || `${incident.rule_name} ${incident.rule_id}`.toLowerCase().includes(ruleQuery)) &&
        (analysisFilter === "all" || analysisStatus === analysisFilter);
    });
  }, [incidents, analyses, deviceFilter, ruleFilter, analysisFilter]);

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
      <div className="ui-toolbar">
        <h2 className="ui-title">
          <Bot className="size-4 text-violet-500" />
          {t("aiWorkbench.title")}
        </h2>
        <button
          type="button"
          onClick={() => copyText("skill-repository", SKILL_REPOSITORY_URL, t("aiWorkbench.skillCopied"))}
          className="ui-btn-secondary px-2.5 py-1"
          title={SKILL_REPOSITORY_URL}
        >
          {copiedId === "skill-repository" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {t(copiedId === "skill-repository" ? "aiWorkbench.copied" : "aiWorkbench.copySkill")}
        </button>
      </div>

      {/* Main Grid: Incidents + Timeline */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left: Captured Trigger Incidents */}
        <div className="ui-card flex min-h-[280px] flex-col overflow-hidden xl:col-span-7">
          <div className="ui-card-header">
            <div className="ui-title">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              <span>{t("aiWorkbench.incidents", { count: filteredIncidents.length })}</span>
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

          <div className="grid grid-cols-1 gap-2 border-b border-slate-100 p-3 dark:border-slate-800 sm:grid-cols-3">
            <input value={deviceFilter} onChange={(event) => setDeviceFilter(event.target.value)}
              placeholder={isEn ? "Filter device" : "筛选设备"} aria-label={isEn ? "Filter by device" : "按设备筛选"} className="ui-input min-w-0 text-xs" />
            <input value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)}
              placeholder={isEn ? "Filter rule" : "筛选规则"} aria-label={isEn ? "Filter by rule" : "按规则筛选"} className="ui-input min-w-0 text-xs" />
            <select value={analysisFilter} onChange={(event) => setAnalysisFilter(event.target.value)} aria-label={isEn ? "Filter analysis status" : "按分析状态筛选"} className="ui-select min-w-0 text-xs">
              <option value="all">{isEn ? "All analysis states" : "全部分析状态"}</option>
              <option value="not-started">{isEn ? "Not started" : "未分析"}</option>
              <option value="queued">{isEn ? "Queued" : "排队中"}</option>
              <option value="running">{isEn ? "Running" : "分析中"}</option>
              <option value="completed">{isEn ? "Completed" : "已完成"}</option>
              <option value="failed">{isEn ? "Failed" : "失败"}</option>
            </select>
          </div>

          <div className="flex-1 divide-y divide-slate-100 overflow-auto dark:divide-slate-800">
            {filteredIncidents.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">
                {incidents.length === 0 ? t("aiWorkbench.noIncidents") : isEn ? "No incidents match these filters." : "没有符合筛选条件的异常事件。"}
              </div>
            ) : (
              filteredIncidents.map((inc) => {
                const isCopied = copiedId === `inc-${inc.id}`;
                const analysis = analyses[inc.id];
                return (
                  <details key={inc.id} className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
                      <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-300">{inc.rule_name}</span>
                      <span className="font-mono text-xs text-slate-500">{inc.port_name || inc.session_id || "-"}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300">{inc.matched_text}</span>
                      <span className="font-mono text-[11px] tabular-nums text-slate-400">{new Date(inc.created_at * 1000).toLocaleString()}</span>
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-300">{analysis?.status ?? (isEn ? "Not analyzed" : "未分析")}</span>
                      <ChevronDown className="size-3.5 text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <div className="space-y-2.5 border-t border-slate-100 p-4 dark:border-slate-800">
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
                        {t(isCopied ? "aiWorkbench.copied" : "aiWorkbench.copyIncident")}
                      </button>
                    </div>

                    <div className="break-all rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 font-mono text-xs text-rose-600 dark:text-rose-400">
                      {inc.matched_text}
                    </div>

                    {inc.prompt && (
                      <div className="text-xs text-slate-600 dark:text-slate-300">
                        <span className="mr-1.5 text-slate-400">{t("aiWorkbench.incidentPrompt")}</span>
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
                  </details>
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
                <span>{t("aiWorkbench.cliHistory", { count: syncEvents.length })}</span>
              </div>
            </div>

            <div className="max-h-64 flex-1 divide-y divide-slate-100 overflow-auto dark:divide-slate-800">
              {syncEvents.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {t("aiWorkbench.noCliCalls")}
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
        </div>
      </div>
    </div>
  );
}
