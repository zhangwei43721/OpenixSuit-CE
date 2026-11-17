import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  Bot,
  CheckCircle2,
  Cpu,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  Webhook,
  Workflow,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  IncidentReport,
  PowerProfile,
  SerialPortInfo,
  SerialSessionInfo,
  TriggerAction,
  TriggerCondition,
  TriggerRule,
} from "../types/workbench";

interface AutomationPageProps {
  onLog: (msg: string) => void;
}

function createEmptyRule(idx: number): TriggerRule {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `Rule ${idx + 1}`,
    enabled: true,
    target_session_id: "",
    condition: {
      kind: "contains",
      pattern: "Kernel panic",
      timeout_secs: 30,
      count_threshold: 3,
    },
    actions: [
      {
        kind: "send_ai",
        power_profile_id: "",
        power_action: "cycle",
        prompt: "设备串口出现异常日志，请结合最近串口输出分析根因并给出排查建议。",
        include_serial_lines: 120,
        serial_data: "",
        webhook_url: "",
      },
    ],
    cooldown_secs: 30,
    trigger_count: 0,
    last_triggered_at: 0,
  };
}

function createEmptyAction(kind: TriggerAction["kind"] = "power_control"): TriggerAction {
  return {
    kind,
    power_profile_id: "",
    power_action: "cycle",
    prompt: "请分析该异常触发时的上下文日志并提出修复建议。",
    include_serial_lines: 100,
    serial_data: "reboot\n",
    webhook_url: "",
  };
}

function createEmptyPowerProfile(idx: number): PowerProfile {
  return {
    id: `pwr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `Power Relay ${idx + 1}`,
    kind: "serial_relay",
    port_name: "",
    baud_rate: 9600,
    on_cmd: "A0 01 01 A2",
    off_cmd: "A0 01 00 A1",
    hex_mode: true,
    http_on_url: "http://192.168.1.100/relay/0?turn=on",
    http_off_url: "http://192.168.1.100/relay/0?turn=off",
    cmd_on: "",
    cmd_off: "",
    cycle_delay_ms: 1500,
  };
}

export function AutomationPage({ onLog }: AutomationPageProps) {
  const { i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [activeTab, setActiveTab] = useState<"rules" | "power">("rules");

  // Trigger Rules State
  const [rules, setRules] = useState<TriggerRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string>("");
  const [sessions, setSessions] = useState<SerialSessionInfo[]>([]);
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [expandedIncidentId, setExpandedIncidentId] = useState<string | null>(null);
  const [testSampleText, setTestSampleText] = useState("Kernel panic - not syncing: VFS");
  const [savingRules, setSavingRules] = useState(false);
  const [testingRule, setTestingRule] = useState(false);

  // Power Profiles State
  const [profiles, setProfiles] = useState<PowerProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [powerBusy, setPowerBusy] = useState<string | null>(null);

  const [statusBanner, setStatusBanner] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const loadAll = useCallback(async () => {
    const [rulesRes, profilesRes, incidentsRes, sessRes, portsRes] = await Promise.all([
      invoke<TriggerRule[]>("trigger_list_rules").catch(() => []),
      invoke<PowerProfile[]>("power_list_profiles").catch(() => []),
      invoke<IncidentReport[]>("trigger_list_incidents").catch(() => []),
      invoke<SerialSessionInfo[]>("serial_list_sessions").catch(() => []),
      invoke<SerialPortInfo[]>("serial_list_ports").catch(() => []),
    ]);

    const safeRules = Array.isArray(rulesRes) ? rulesRes : [];
    const safeProfiles = Array.isArray(profilesRes) ? profilesRes : [];
    setRules(safeRules);
    setProfiles(safeProfiles);
    setIncidents(Array.isArray(incidentsRes) ? incidentsRes : []);
    setSessions(Array.isArray(sessRes) ? sessRes : []);
    setSerialPorts(Array.isArray(portsRes) ? portsRes : []);

    setSelectedRuleId((prev) =>
      prev && safeRules.some((r) => r.id === prev) ? prev : safeRules[0]?.id || ""
    );
    setSelectedProfileId((prev) =>
      prev && safeProfiles.some((p) => p.id === prev) ? prev : safeProfiles[0]?.id || ""
    );
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Listen to trigger-fired events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<IncidentReport>("trigger-fired", (event) => {
      const inc = event.payload;
      if (!inc) return;
      setIncidents((prev) => [inc, ...prev].slice(0, 200));
      setRules((prev) =>
        prev.map((r) =>
          r.id === inc.rule_id
            ? { ...r, trigger_count: r.trigger_count + 1, last_triggered_at: inc.created_at }
            : r
        )
      );
      onLog(`Trigger fired: ${inc.rule_name} (${inc.port_name})`);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [onLog]);

  const selectedRule = useMemo(
    () => rules.find((r) => r.id === selectedRuleId) ?? null,
    [rules, selectedRuleId]
  );

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId]
  );

  const updateSelectedRule = (patch: Partial<TriggerRule>) => {
    if (!selectedRule) return;
    setRules((prev) => prev.map((r) => (r.id === selectedRule.id ? { ...r, ...patch } : r)));
  };

  const updateCondition = (patch: Partial<TriggerCondition>) => {
    if (!selectedRule) return;
    updateSelectedRule({ condition: { ...selectedRule.condition, ...patch } });
  };

  const updateAction = (index: number, patch: Partial<TriggerAction>) => {
    if (!selectedRule) return;
    const nextActions = selectedRule.actions.map((a, i) =>
      i === index ? { ...a, ...patch } : a
    );
    updateSelectedRule({ actions: nextActions });
  };

  const moveAction = (index: number, dir: -1 | 1) => {
    if (!selectedRule) return;
    const target = index + dir;
    if (target < 0 || target >= selectedRule.actions.length) return;
    const next = [...selectedRule.actions];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    updateSelectedRule({ actions: next });
  };

  const handleSaveRules = async () => {
    setSavingRules(true);
    setStatusBanner(null);
    try {
      await invoke("trigger_save_rules", { rules });
      setStatusBanner({
        type: "ok",
        text: isEn ? "Trigger rules saved" : "触发规则已保存",
      });
      onLog(isEn ? `Saved ${rules.length} trigger rules` : `已保存 ${rules.length} 条触发规则`);
    } catch (err) {
      const msg = String(err);
      setStatusBanner({ type: "err", text: msg });
      onLog(`trigger_save_rules error: ${msg}`);
    } finally {
      setSavingRules(false);
    }
  };

  const handleTestRule = async () => {
    if (!selectedRule) return;
    setTestingRule(true);
    setStatusBanner(null);
    try {
      await invoke("trigger_save_rules", { rules });
      const result = await invoke<unknown>("trigger_test_rule", {
        ruleId: selectedRule.id,
        sampleLine: testSampleText,
      });
      setStatusBanner({
        type: "ok",
        text:
          typeof result === "string" && result
            ? result
            : isEn
            ? `Test executed for "${selectedRule.name}"`
            : `已触发规则「${selectedRule.name}」模拟测试`,
      });
      const updatedIncidents = await invoke<IncidentReport[]>("trigger_list_incidents").catch(
        () => []
      );
      if (Array.isArray(updatedIncidents)) {
        setIncidents(updatedIncidents);
      }
      onLog(`Tested rule ${selectedRule.name}`);
    } catch (err) {
      const msg = String(err);
      setStatusBanner({ type: "err", text: msg });
      onLog(`trigger_test_rule error: ${msg}`);
    } finally {
      setTestingRule(false);
    }
  };

  const handleClearIncidents = async () => {
    try {
      await invoke("trigger_clear_incidents");
      setIncidents([]);
      onLog(isEn ? "Cleared trigger incidents" : "已清空异常事件记录");
    } catch (err) {
      onLog(`trigger_clear_incidents error: ${String(err)}`);
    }
  };

  const updateSelectedProfile = (patch: Partial<PowerProfile>) => {
    if (!selectedProfile) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === selectedProfile.id ? { ...p, ...patch } : p))
    );
  };

  const handleSaveProfiles = async () => {
    setSavingProfiles(true);
    setStatusBanner(null);
    try {
      await invoke("power_save_profiles", { profiles });
      setStatusBanner({
        type: "ok",
        text: isEn ? "Power profiles saved" : "电源配置已保存",
      });
      onLog(isEn ? `Saved ${profiles.length} power profiles` : `已保存 ${profiles.length} 个电源配置`);
    } catch (err) {
      const msg = String(err);
      setStatusBanner({ type: "err", text: msg });
      onLog(`power_save_profiles error: ${msg}`);
    } finally {
      setSavingProfiles(false);
    }
  };

  const handleExecutePower = async (
    profile: PowerProfile,
    action: "on" | "off" | "cycle"
  ) => {
    setPowerBusy(`${profile.id}:${action}`);
    setStatusBanner(null);
    try {
      await invoke("power_save_profiles", { profiles });
      await invoke("power_execute", {
        profileId: profile.id,
        action,
      });
      setStatusBanner({
        type: "ok",
        text: isEn
          ? `Executed power "${action.toUpperCase()}" on ${profile.name}`
          : `已执行电源 ${action.toUpperCase()} (${profile.name})`,
      });
      onLog(`Power ${action} -> ${profile.name}`);
    } catch (err) {
      const msg = String(err);
      setStatusBanner({ type: "err", text: msg });
      onLog(`power_execute error: ${msg}`);
    } finally {
      setPowerBusy(null);
    }
  };

  const conditionLabel = (cond: TriggerCondition): string => {
    switch (cond.kind) {
      case "contains":
        return isEn ? `Contains "${cond.pattern}"` : `包含 "${cond.pattern}" (忽略大小写)`;
      case "contains_cs":
        return isEn ? `Exact "${cond.pattern}"` : `精确包含 "${cond.pattern}"`;
      case "regex":
        return `Regex /${cond.pattern}/`;
      case "timeout":
        return isEn ? `Silence > ${cond.timeout_secs}s` : `串口静默超时 > ${cond.timeout_secs}s`;
      case "count":
        return isEn
          ? `"${cond.pattern}" ≥ ${cond.count_threshold}x`
          : `"${cond.pattern}" 累计出现 ≥ ${cond.count_threshold} 次`;
    }
  };

  const actionMeta = (action: TriggerAction) => {
    switch (action.kind) {
      case "power_control": {
        const pName =
          profiles.find((p) => p.id === action.power_profile_id)?.name ||
          action.power_profile_id ||
          (isEn ? "Unset" : "未选择电源");
        return {
          title: isEn ? "Power Control" : "可编程电源控制",
          detail: `${pName} -> ${action.power_action.toUpperCase()}`,
          badge: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
          icon: <Power className="w-4 h-4 text-amber-500" />,
        };
      }
      case "send_ai":
        return {
          title: isEn ? "Send to AI CLI / Incident" : "生成 AI 排障上下文",
          detail: `${action.include_serial_lines} lines · ${action.prompt.slice(0, 48)}`,
          badge: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300",
          icon: <Bot className="w-4 h-4 text-violet-500" />,
        };
      case "adb_reboot":
        return {
          title: isEn ? "ADB Reboot Device" : "ADB 重启设备",
          detail: isEn ? "Execute adb reboot" : "执行 adb reboot 重启板卡",
          badge: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-300",
          icon: <RotateCcw className="w-4 h-4 text-blue-500" />,
        };
      case "serial_send":
        return {
          title: isEn ? "Send Serial Data" : "串口自动发送指令",
          detail: JSON.stringify(action.serial_data),
          badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
          icon: <Send className="w-4 h-4 text-emerald-500" />,
        };
      case "notify_webhook":
        return {
          title: isEn ? "Notify Webhook" : "Webhook 告警通知",
          detail: action.webhook_url || (isEn ? "No URL" : "未填写 Webhook URL"),
          badge: "border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
          icon: <Webhook className="w-4 h-4 text-indigo-500" />,
        };
    }
  };

  return (
    <div className="h-full flex flex-col gap-3 min-h-0 overflow-auto pr-0.5">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2.5 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab("rules")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === "rules"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <Workflow className="w-3.5 h-3.5" />
            {isEn ? "Event Trigger Rules" : "事件触发规则"}
          </button>
          <button
            onClick={() => setActiveTab("power")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              activeTab === "power"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            {isEn ? "Programmable Power" : "可编程电源配置"}
          </button>
        </div>

        <button
          onClick={loadAll}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {isEn ? "Reload" : "刷新配置"}
        </button>
      </div>

      {statusBanner && (
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border ${
            statusBanner.type === "ok"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400"
          }`}
        >
          {statusBanner.type === "ok" ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          )}
          <span>{statusBanner.text}</span>
        </div>
      )}

      {activeTab === "rules" ? (
        <div className="flex flex-col gap-3">
          {/* Split Rules Editor + Visual Flowchart */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
            {/* Left Rule List */}
            <div className="xl:col-span-3 flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  {isEn ? `Rules (${rules.length})` : `规则列表 (${rules.length})`}
                </span>
                <button
                  onClick={() => {
                    const nextRule = createEmptyRule(rules.length);
                    setRules((prev) => [...prev, nextRule]);
                    setSelectedRuleId(nextRule.id);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-blue-600 hover:bg-blue-500 text-white"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {isEn ? "New" : "新建"}
                </button>
              </div>
              <div className="flex-1 overflow-auto divide-y divide-slate-100 dark:divide-slate-800 max-h-[420px]">
                {rules.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-400">
                    {isEn ? "No trigger rules yet." : "暂无规则，点击右上角新建。"}
                  </div>
                ) : (
                  rules.map((r) => {
                    const active = r.id === selectedRuleId;
                    return (
                      <div
                        key={r.id}
                        onClick={() => setSelectedRuleId(r.id)}
                        className={`px-3 py-2.5 cursor-pointer transition flex items-start justify-between gap-2 ${
                          active
                            ? "bg-blue-500/10 border-l-2 border-l-blue-500"
                            : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                r.enabled ? "bg-emerald-500" : "bg-slate-400"
                              }`}
                            />
                            <span className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">
                              {r.name}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 truncate font-mono">
                            {conditionLabel(r.condition)}
                          </div>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono shrink-0">
                          {r.trigger_count}x
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="p-2.5 border-t border-slate-200 dark:border-slate-800 flex gap-2">
                <button
                  onClick={handleSaveRules}
                  disabled={savingRules}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingRules ? (isEn ? "Saving..." : "保存中...") : isEn ? "Save All" : "保存全部规则"}
                </button>
              </div>
            </div>

            {/* Middle Rule Editor */}
            <div className="xl:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col gap-3">
              {selectedRule ? (
                <>
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                      {isEn ? "Rule Editor" : "规则配置"}
                    </span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedRule.enabled}
                          onChange={(e) => updateSelectedRule({ enabled: e.target.checked })}
                          className="rounded-md"
                        />
                        {isEn ? "Enabled" : "启用"}
                      </label>
                      <button
                        onClick={() => {
                          const filtered = rules.filter((r) => r.id !== selectedRule.id);
                          setRules(filtered);
                          setSelectedRuleId(filtered[0]?.id || "");
                        }}
                        className="p-1 rounded-md text-slate-400 hover:text-rose-500"
                        title={isEn ? "Delete Rule" : "删除规则"}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        {isEn ? "Rule Name" : "规则名称"}
                      </label>
                      <input
                        type="text"
                        value={selectedRule.name}
                        onChange={(e) => updateSelectedRule({ name: e.target.value })}
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        {isEn ? "Target Serial Session" : "监听串口会话"}
                      </label>
                      <select
                        value={selectedRule.target_session_id}
                        onChange={(e) =>
                          updateSelectedRule({ target_session_id: e.target.value })
                        }
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100"
                      >
                        <option value="">{isEn ? "All Active Serials" : "全部活动串口"}</option>
                        {sessions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.port_name} ({s.id})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Condition Block */}
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                      {isEn ? "Trigger Condition" : "触发条件"}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <select
                        value={selectedRule.condition.kind}
                        onChange={(e) =>
                          updateCondition({
                            kind: e.target.value as TriggerCondition["kind"],
                          })
                        }
                        className="text-xs px-2 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                      >
                        <option value="contains">{isEn ? "Contains (nocase)" : "包含 (忽略大小写)"}</option>
                        <option value="contains_cs">{isEn ? "Contains (exact)" : "精确包含"}</option>
                        <option value="regex">{isEn ? "Regex" : "正则表达式"}</option>
                        <option value="timeout">{isEn ? "Silence Timeout" : "静默超时"}</option>
                        <option value="count">{isEn ? "Match Count" : "次数累计"}</option>
                      </select>

                      {selectedRule.condition.kind === "timeout" ? (
                        <input
                          type="number"
                          min={1}
                          value={selectedRule.condition.timeout_secs}
                          onChange={(e) =>
                            updateCondition({ timeout_secs: Number(e.target.value) || 1 })
                          }
                          placeholder="Seconds"
                          className="sm:col-span-2 text-xs px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                        />
                      ) : (
                        <input
                          type="text"
                          value={selectedRule.condition.pattern}
                          onChange={(e) => updateCondition({ pattern: e.target.value })}
                          placeholder={isEn ? "Pattern / Keyword" : "匹配关键字或正则..."}
                          className="sm:col-span-2 text-xs font-mono px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                        />
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {selectedRule.condition.kind === "count" && (
                        <div>
                          <label className="block text-[10px] text-slate-500 mb-0.5">
                            {isEn ? "Count Threshold" : "触发阈值次数"}
                          </label>
                          <input
                            type="number"
                            min={1}
                            value={selectedRule.condition.count_threshold}
                            onChange={(e) =>
                              updateCondition({
                                count_threshold: Number(e.target.value) || 1,
                              })
                            }
                            className="w-full text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">
                          {isEn ? "Cooldown (sec)" : "防抖冷却时间 (秒)"}
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={selectedRule.cooldown_secs}
                          onChange={(e) =>
                            updateSelectedRule({ cooldown_secs: Number(e.target.value) || 0 })
                          }
                          className="w-full text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Ordered Action Pipeline */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                        {isEn
                          ? `Action Pipeline (${selectedRule.actions.length})`
                          : `顺序执行动作流水线 (${selectedRule.actions.length})`}
                      </span>
                      <button
                        onClick={() =>
                          updateSelectedRule({
                            actions: [...selectedRule.actions, createEmptyAction("power_control")],
                          })
                        }
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-slate-100 dark:bg-slate-800 hover:bg-blue-500/15 hover:text-blue-600 text-slate-700 dark:text-slate-200"
                      >
                        <Plus className="w-3 h-3" />
                        {isEn ? "Add Step" : "添加步骤"}
                      </button>
                    </div>

                    <div className="space-y-2 max-h-[240px] overflow-auto pr-1">
                      {selectedRule.actions.map((act, idx) => (
                        <div
                          key={idx}
                          className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-mono font-semibold text-blue-600 dark:text-blue-400">
                              Step #{idx + 1}
                            </span>
                            <select
                              value={act.kind}
                              onChange={(e) =>
                                updateAction(idx, {
                                  kind: e.target.value as TriggerAction["kind"],
                                })
                              }
                              className="flex-1 text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100"
                            >
                              <option value="power_control">
                                {isEn ? "Power Control" : "电源控制 (上电/断电/循环)"}
                              </option>
                              <option value="send_ai">
                                {isEn ? "Send to AI Analysis" : "生成 AI 排障上下文"}
                              </option>
                              <option value="adb_reboot">
                                {isEn ? "ADB Reboot" : "ADB 重启设备"}
                              </option>
                              <option value="serial_send">
                                {isEn ? "Serial Send" : "串口发送指令"}
                              </option>
                              <option value="notify_webhook">
                                {isEn ? "Webhook Notify" : "钉钉/飞书 Webhook 通知"}
                              </option>
                            </select>

                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => moveAction(idx, -1)}
                                disabled={idx === 0}
                                className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                              >
                                <ArrowUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => moveAction(idx, 1)}
                                disabled={idx === selectedRule.actions.length - 1}
                                className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                              >
                                <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() =>
                                  updateSelectedRule({
                                    actions: selectedRule.actions.filter((_, i) => i !== idx),
                                  })
                                }
                                className="p-1 text-slate-400 hover:text-rose-500"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {act.kind === "power_control" && (
                            <div className="grid grid-cols-2 gap-2">
                              <select
                                value={act.power_profile_id}
                                onChange={(e) =>
                                  updateAction(idx, { power_profile_id: e.target.value })
                                }
                                className="text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                              >
                                <option value="">
                                  {isEn ? "-- Power Profile --" : "-- 选择电源配置 --"}
                                </option>
                                {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={act.power_action}
                                onChange={(e) =>
                                  updateAction(idx, { power_action: e.target.value })
                                }
                                className="text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                              >
                                <option value="cycle">{isEn ? "Power Cycle" : "电源循环 (Cycle)"}</option>
                                <option value="on">{isEn ? "Power ON" : "上电 (ON)"}</option>
                                <option value="off">{isEn ? "Power OFF" : "断电 (OFF)"}</option>
                              </select>
                            </div>
                          )}

                          {act.kind === "send_ai" && (
                            <div className="space-y-1.5">
                              <input
                                type="text"
                                value={act.prompt}
                                onChange={(e) => updateAction(idx, { prompt: e.target.value })}
                                placeholder={isEn ? "AI prompt..." : "AI 分析提示词..."}
                                className="w-full text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                              />
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] text-slate-500">
                                  {isEn ? "Attach serial lines:" : "附带串口尾部行数:"}
                                </span>
                                <input
                                  type="number"
                                  min={10}
                                  max={1000}
                                  value={act.include_serial_lines}
                                  onChange={(e) =>
                                    updateAction(idx, {
                                      include_serial_lines: Number(e.target.value) || 100,
                                    })
                                  }
                                  className="w-20 text-xs px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                                />
                              </div>
                            </div>
                          )}

                          {act.kind === "serial_send" && (
                            <input
                              type="text"
                              value={act.serial_data}
                              onChange={(e) => updateAction(idx, { serial_data: e.target.value })}
                              placeholder={isEn ? "Serial data (e.g. reboot\\n)" : "发送文本 (如 reboot)"}
                              className="w-full text-xs font-mono px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                          )}

                          {act.kind === "notify_webhook" && (
                            <input
                              type="text"
                              value={act.webhook_url}
                              onChange={(e) => updateAction(idx, { webhook_url: e.target.value })}
                              placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                              className="w-full text-xs font-mono px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Test Rule Box */}
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2">
                    <input
                      type="text"
                      value={testSampleText}
                      onChange={(e) => setTestSampleText(e.target.value)}
                      placeholder={isEn ? "Sample log line for test..." : "模拟测试日志文本..."}
                      className="flex-1 text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                    <button
                      onClick={handleTestRule}
                      disabled={testingRule}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50 transition"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {testingRule ? (isEn ? "Testing..." : "测试中...") : isEn ? "Test Rule" : "测试规则"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-slate-400">
                  {isEn ? "Select or create a rule to edit." : "请选择或新建一条规则。"}
                </div>
              )}
            </div>

            {/* Right Visual Rule Flowchart Preview */}
            <div className="xl:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                  <Sparkles className="w-4 h-4 text-blue-500" />
                  <span>{isEn ? "Rule Flowchart Preview" : "规则执行流程图预览"}</span>
                </div>
                {selectedRule && (
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      selectedRule.enabled
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-slate-200 dark:bg-slate-800 text-slate-500"
                    }`}
                  >
                    {selectedRule.enabled ? "ACTIVE" : "PAUSED"}
                  </span>
                )}
              </div>

              {selectedRule ? (
                <div className="flex-1 flex flex-col items-center justify-start gap-2 py-2 overflow-auto">
                  {/* Trigger Card */}
                  <div className="w-full rounded-xl border-2 border-blue-500/40 bg-blue-500/10 p-3">
                    <div className="flex items-center justify-between text-xs font-semibold text-blue-700 dark:text-blue-300">
                      <span className="flex items-center gap-1.5">
                        <Cpu className="w-4 h-4" />
                        {isEn ? "TRIGGER" : "触发条件"} · {selectedRule.name}
                      </span>
                      <span className="text-[10px] font-mono opacity-80">
                        CD {selectedRule.cooldown_secs}s
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-700 dark:text-slate-200 mt-1.5">
                      {conditionLabel(selectedRule.condition)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      {isEn ? "Scope:" : "作用范围:"}{" "}
                      {selectedRule.target_session_id || (isEn ? "All serial sessions" : "全部串口会话")}
                    </div>
                  </div>

                  {/* Pipeline Steps */}
                  {selectedRule.actions.map((act, idx) => {
                    const meta = actionMeta(act);
                    return (
                      <div key={idx} className="w-full flex flex-col items-center gap-2">
                        <div className="h-4 w-0.5 bg-slate-300 dark:bg-slate-700 relative">
                          <span className="absolute -bottom-1 -left-[3px] w-2 h-2 border-b-2 border-r-2 border-slate-400 dark:border-slate-500 rotate-45" />
                        </div>
                        <div className={`w-full rounded-xl border p-3 ${meta.badge}`}>
                          <div className="flex items-center justify-between text-xs font-semibold">
                            <span className="flex items-center gap-1.5">
                              {meta.icon}
                              Step #{idx + 1} · {meta.title}
                            </span>
                          </div>
                          <div className="text-[11px] font-mono mt-1 opacity-90 break-all">
                            {meta.detail}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Final Notify / Incident Card */}
                  <div className="h-4 w-0.5 bg-slate-300 dark:bg-slate-700 relative">
                    <span className="absolute -bottom-1 -left-[3px] w-2 h-2 border-b-2 border-r-2 border-slate-400 dark:border-slate-500 rotate-45" />
                  </div>
                  <div className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                      <Bell className="w-4 h-4 text-emerald-500" />
                      <span>{isEn ? "Record Incident & Notify" : "记录异常事件并同步 AI 工作台"}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      {isEn
                        ? `Triggered ${selectedRule.trigger_count} times so far`
                        : `累计触发 ${selectedRule.trigger_count} 次 · 自动归档现场日志`}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
                  {isEn ? "No rule selected" : "未选择规则"}
                </div>
              )}
            </div>
          </div>

          {/* Incident History Table */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <ShieldAlert className="w-4 h-4 text-amber-500" />
                <span>
                  {isEn
                    ? `Triggered Incidents (${incidents.length})`
                    : `异常事件记录 (${incidents.length})`}
                </span>
              </div>
              <button
                onClick={handleClearIncidents}
                disabled={incidents.length === 0}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-500 hover:text-rose-500 border border-slate-200 dark:border-slate-700 disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isEn ? "Clear" : "清空记录"}
              </button>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-auto">
              {incidents.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {isEn ? "No trigger incidents captured yet." : "暂无异常触发记录。"}
                </div>
              ) : (
                incidents.map((inc) => {
                  const expanded = expandedIncidentId === inc.id;
                  return (
                    <div key={inc.id} className="px-4 py-2.5 text-xs">
                      <div
                        onClick={() => setExpandedIncidentId(expanded ? null : inc.id)}
                        className="flex flex-wrap items-center justify-between gap-2 cursor-pointer"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-300 font-medium">
                            {inc.rule_name}
                          </span>
                          <span className="font-mono text-slate-500">{inc.port_name || "-"}</span>
                          <span className="font-mono text-slate-700 dark:text-slate-200 truncate max-w-md">
                            {inc.matched_text}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                          <span>{new Date(inc.created_at * 1000).toLocaleString()}</span>
                        </div>
                      </div>

                      {expanded && (
                        <div className="mt-2 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                          {inc.action_results.length > 0 && (
                            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">
                              {inc.action_results.join(" | ")}
                            </div>
                          )}
                          <pre className="text-[11px] font-mono text-slate-700 dark:text-slate-300 max-h-40 overflow-auto whitespace-pre-wrap">
                            {inc.log_tail || "(empty log tail)"}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Programmable Power Profiles Tab */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 min-h-0">
          {/* Profile List */}
          <div className="lg:col-span-4 flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {isEn ? `Power Profiles (${profiles.length})` : `电源设备列表 (${profiles.length})`}
              </span>
              <button
                onClick={() => {
                  const p = createEmptyPowerProfile(profiles.length);
                  setProfiles((prev) => [...prev, p]);
                  setSelectedProfileId(p.id);
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-blue-600 hover:bg-blue-500 text-white"
              >
                <Plus className="w-3.5 h-3.5" />
                {isEn ? "Add" : "新增"}
              </button>
            </div>

            <div className="flex-1 overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
              {profiles.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {isEn ? "No power profiles configured." : "暂无可编程电源配置。"}
                </div>
              ) : (
                profiles.map((p) => {
                  const active = p.id === selectedProfileId;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelectedProfileId(p.id)}
                      className={`p-3 cursor-pointer transition space-y-2 ${
                        active
                          ? "bg-blue-500/10 border-l-2 border-l-blue-500"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                          {p.name}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500">
                          {p.kind}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExecutePower(p, "on");
                          }}
                          disabled={powerBusy !== null}
                          className="flex-1 px-2 py-1 rounded-md text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                        >
                          {isEn ? "ON" : "上电"}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExecutePower(p, "off");
                          }}
                          disabled={powerBusy !== null}
                          className="flex-1 px-2 py-1 rounded-md text-[11px] font-medium bg-rose-500 hover:bg-rose-600 text-white disabled:opacity-40"
                        >
                          {isEn ? "OFF" : "断电"}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExecutePower(p, "cycle");
                          }}
                          disabled={powerBusy !== null}
                          className="flex-1 px-2 py-1 rounded-md text-[11px] font-medium bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-40"
                        >
                          {isEn ? "Cycle" : "循环"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="p-2.5 border-t border-slate-200 dark:border-slate-800">
              <button
                onClick={handleSaveProfiles}
                disabled={savingProfiles}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition"
              >
                <Save className="w-3.5 h-3.5" />
                {savingProfiles ? (isEn ? "Saving..." : "保存中...") : isEn ? "Save Profiles" : "保存电源配置"}
              </button>
            </div>
          </div>

          {/* Profile Editor */}
          <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col gap-4">
            {selectedProfile ? (
              <>
                <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {selectedProfile.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleExecutePower(selectedProfile, "on")}
                      disabled={powerBusy !== null}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                    >
                      {isEn ? "Power ON" : "上电 (ON)"}
                    </button>
                    <button
                      onClick={() => handleExecutePower(selectedProfile, "off")}
                      disabled={powerBusy !== null}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-500 hover:bg-rose-600 text-white disabled:opacity-40"
                    >
                      {isEn ? "Power OFF" : "断电 (OFF)"}
                    </button>
                    <button
                      onClick={() => handleExecutePower(selectedProfile, "cycle")}
                      disabled={powerBusy !== null}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-40"
                    >
                      {isEn ? "Power Cycle" : "电源循环 (Cycle)"}
                    </button>
                    <button
                      onClick={() => {
                        const filtered = profiles.filter((p) => p.id !== selectedProfile.id);
                        setProfiles(filtered);
                        setSelectedProfileId(filtered[0]?.id || "");
                      }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">
                      {isEn ? "Profile Name" : "名称"}
                    </label>
                    <input
                      type="text"
                      value={selectedProfile.name}
                      onChange={(e) => updateSelectedProfile({ name: e.target.value })}
                      className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">
                      {isEn ? "Control Kind" : "控制类型"}
                    </label>
                    <select
                      value={selectedProfile.kind}
                      onChange={(e) =>
                        updateSelectedProfile({
                          kind: e.target.value as PowerProfile["kind"],
                        })
                      }
                      className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    >
                      <option value="serial_relay">{isEn ? "Serial Relay (Hex/ASCII)" : "串口继电器 (Hex/ASCII)"}</option>
                      <option value="serial_dtr_rts">{isEn ? "Serial DTR/RTS Pin" : "串口 DTR/RTS 引脚控制"}</option>
                      <option value="http">{isEn ? "HTTP Smart Plug" : "HTTP 智能插座 / 继电器"}</option>
                      <option value="command">{isEn ? "Local Shell Command" : "本地命令 / USB Hub 控制"}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">
                      {isEn ? "Cycle Delay (ms)" : "Cycle 断电延迟 (ms)"}
                    </label>
                    <input
                      type="number"
                      min={100}
                      step={100}
                      value={selectedProfile.cycle_delay_ms}
                      onChange={(e) =>
                        updateSelectedProfile({
                          cycle_delay_ms: Number(e.target.value) || 1000,
                        })
                      }
                      className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                    />
                  </div>
                </div>

                {(selectedProfile.kind === "serial_relay" ||
                  selectedProfile.kind === "serial_dtr_rts") && (
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          {isEn ? "Serial Port" : "串口设备"}
                        </label>
                        <select
                          value={selectedProfile.port_name}
                          onChange={(e) =>
                            updateSelectedProfile({ port_name: e.target.value })
                          }
                          className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        >
                          <option value="">{isEn ? "-- Select Port --" : "-- 选择串口 --"}</option>
                          {serialPorts.map((sp) => (
                            <option key={sp.port_name} value={sp.port_name}>
                              {sp.port_name} {sp.product ? `(${sp.product})` : ""}
                            </option>
                          ))}
                          {selectedProfile.port_name &&
                            !serialPorts.some((sp) => sp.port_name === selectedProfile.port_name) && (
                              <option value={selectedProfile.port_name}>
                                {selectedProfile.port_name}
                              </option>
                            )}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          {isEn ? "Baud Rate" : "波特率"}
                        </label>
                        <input
                          type="number"
                          value={selectedProfile.baud_rate}
                          onChange={(e) =>
                            updateSelectedProfile({ baud_rate: Number(e.target.value) || 9600 })
                          }
                          className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                        />
                      </div>
                    </div>

                    {selectedProfile.kind === "serial_relay" && (
                      <>
                        <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedProfile.hex_mode}
                            onChange={(e) =>
                              updateSelectedProfile({ hex_mode: e.target.checked })
                            }
                          />
                          {isEn ? "Hex Mode (e.g. A0 01 01 A2)" : "Hex 字节模式 (如 A0 01 01 A2)"}
                        </label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">
                              {isEn ? "ON Command" : "上电指令 (ON)"}
                            </label>
                            <input
                              type="text"
                              value={selectedProfile.on_cmd}
                              onChange={(e) =>
                                updateSelectedProfile({ on_cmd: e.target.value })
                              }
                              className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">
                              {isEn ? "OFF Command" : "断电指令 (OFF)"}
                            </label>
                            <input
                              type="text"
                              value={selectedProfile.off_cmd}
                              onChange={(e) =>
                                updateSelectedProfile({ off_cmd: e.target.value })
                              }
                              className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {selectedProfile.kind === "http" && (
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        {isEn ? "HTTP ON URL" : "上电请求 URL"}
                      </label>
                      <input
                        type="text"
                        value={selectedProfile.http_on_url}
                        onChange={(e) =>
                          updateSelectedProfile({ http_on_url: e.target.value })
                        }
                        className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        {isEn ? "HTTP OFF URL" : "断电请求 URL"}
                      </label>
                      <input
                        type="text"
                        value={selectedProfile.http_off_url}
                        onChange={(e) =>
                          updateSelectedProfile({ http_off_url: e.target.value })
                        }
                        className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                  </div>
                )}

                {selectedProfile.kind === "command" && (
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        {isEn ? "Shell ON Command" : "上电 Shell 命令"}
                      </label>
                      <input
                        type="text"
                        value={selectedProfile.cmd_on}
                        onChange={(e) => updateSelectedProfile({ cmd_on: e.target.value })}
                        placeholder="uhubctl -l 1-1 -p 2 -a on"
                        className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        {isEn ? "Shell OFF Command" : "断电 Shell 命令"}
                      </label>
                      <input
                        type="text"
                        value={selectedProfile.cmd_off}
                        onChange={(e) => updateSelectedProfile({ cmd_off: e.target.value })}
                        placeholder="uhubctl -l 1-1 -p 2 -a off"
                        className="w-full text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">
                {isEn ? "Select or create a power profile." : "请选择或新建一个电源配置。"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
