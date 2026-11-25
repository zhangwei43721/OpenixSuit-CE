use crate::adb;
use crate::power;
use crate::serial;
use crate::state::{
    app_data_dir, emit_ai_sync, epoch_ms, epoch_secs, load_json_or_default, save_json_pretty,
    AppState,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerCondition {
    pub kind: String, // "contains" | "contains_cs" | "regex" | "timeout" | "count" | "device_online" | "flash_completed"
    pub pattern: String,
    pub timeout_secs: u64,
    pub count_threshold: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerAction {
    pub kind: String, // "power_control" | "send_ai" | "adb_reboot" | "serial_send" | "notify_webhook"
    pub power_profile_id: String,
    pub power_action: String,
    pub prompt: String,
    pub include_serial_lines: usize,
    pub serial_data: String,
    pub webhook_url: String,
    pub plugin_id: String,
    pub plugin_action: String,
    pub plugin_inputs: serde_json::Map<String, serde_json::Value>,
    pub adb_serial: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub draft: bool,
    pub target_session_id: String,
    pub condition: TriggerCondition,
    pub actions: Vec<TriggerAction>,
    pub cooldown_secs: u64,
    pub trigger_count: u64,
    pub last_triggered_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct IncidentReport {
    pub id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub session_id: String,
    pub port_name: String,
    pub matched_text: String,
    pub prompt: String,
    pub log_tail: Vec<String>,
    pub created_at: u64,
    pub action_results: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TriggerTestPreview {
    pub matched: bool,
    pub connected: bool,
    pub condition_result: String,
    pub session_id: String,
    pub port_name: String,
    pub matched_text: String,
}

static RULES_CACHE: OnceLock<Mutex<Vec<TriggerRule>>> = OnceLock::new();
static COUNTERS: OnceLock<Mutex<HashMap<(String, String), u32>>> = OnceLock::new();
static REGEX_CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
static INCIDENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn rules_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("trigger_rules.json"))
}

fn incidents_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("incidents");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create incidents dir: {}", e))?;
    Ok(dir)
}

fn rules_mutex() -> &'static Mutex<Vec<TriggerRule>> {
    RULES_CACHE.get_or_init(|| {
        let loaded = rules_path()
            .and_then(|p| load_json_or_default::<Vec<TriggerRule>>(&p))
            .unwrap_or_default();
        Mutex::new(loaded)
    })
}

fn counters_mutex() -> &'static Mutex<HashMap<(String, String), u32>> {
    COUNTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn regex_matches(pattern: &str, line: &str) -> bool {
    let cache = REGEX_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = cache.lock() {
        if let Some(re) = guard.get(pattern) {
            return re.is_match(line);
        }
        if let Ok(re) = Regex::new(pattern) {
            let matched = re.is_match(line);
            if guard.len() > 256 {
                guard.clear();
            }
            guard.insert(pattern.to_string(), re);
            return matched;
        }
    }
    false
}

fn line_matches_pattern(pattern: &str, line: &str, case_sensitive: bool) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if case_sensitive {
        line.contains(pattern)
    } else {
        line.to_lowercase().contains(&pattern.to_lowercase())
    }
}

fn preview_line_condition(
    condition: &TriggerCondition,
    sample_line: &str,
    current_count: u32,
) -> Result<bool, String> {
    Ok(match condition.kind.as_str() {
        "contains" => line_matches_pattern(&condition.pattern, sample_line, false),
        "contains_cs" => line_matches_pattern(&condition.pattern, sample_line, true),
        "regex" => Regex::new(&condition.pattern)
            .map_err(|e| format!("Invalid trigger regex: {e}"))?
            .is_match(sample_line),
        "count" => {
            let hit = condition.pattern.trim().is_empty()
                || line_matches_pattern(&condition.pattern, sample_line, false);
            hit && current_count.saturating_add(1) >= condition.count_threshold.max(1)
        }
        other => return Err(format!("Condition {other} requires live session state")),
    })
}

fn render_prompt_template(
    template: &str,
    rule_name: &str,
    session_id: &str,
    port_name: &str,
    matched_text: &str,
    log_tail: &[String],
) -> String {
    let tail_joined = log_tail.join("\n");
    template
        .replace("{{rule_name}}", rule_name)
        .replace("{{session_id}}", session_id)
        .replace("{{port_name}}", port_name)
        .replace("{{line}}", matched_text)
        .replace("{{matched_text}}", matched_text)
        .replace("{{log_tail}}", &tail_joined)
}

async fn execute_rule_and_report(
    app: AppHandle,
    rule: TriggerRule,
    session_id: String,
    port_name: String,
    matched_text: String,
) -> IncidentReport {
    let tail_requested = rule
        .actions
        .iter()
        .map(|a| a.include_serial_lines)
        .max()
        .unwrap_or(50);
    let tail_count = if tail_requested == 0 {
        50
    } else {
        tail_requested
    };

    let log_tail = {
        let state = app.state::<AppState>();
        if session_id.is_empty() {
            Vec::new()
        } else {
            crate::plugins::provider_logs(&app, &session_id, tail_count)
                .or_else(|| crate::adb_log::recent_lines(&state, &session_id, tail_count))
                .unwrap_or_else(|| serial::serial_get_buffer_with_state(&state, &session_id, Some(tail_count)).unwrap_or_default())
        }
    };

    let created_at = epoch_secs();
    let sequence = INCIDENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let id = format!("inc-{}-{sequence:020}", epoch_ms());
    let mut combined_prompts = Vec::new();
    let mut action_results = Vec::new();

    for action in &rule.actions {
        match action.kind.as_str() {
            "power_control" => {
                let act = if action.power_action.trim().is_empty() {
                    "cycle"
                } else {
                    action.power_action.trim()
                };
                let res = power::power_execute_async(&action.power_profile_id, act).await;
                match res {
                    Ok(msg) => action_results.push(format!("power_control: OK - {}", msg)),
                    Err(err) => action_results.push(format!("power_control: ERR - {}", err)),
                }
            }

            "adb_reboot" => {
                let target_serial = action.serial_data.trim().to_string();
                let res = tokio::task::spawn_blocking(move || adb::adb_reboot(target_serial)).await;
                match res {
                    Ok(Ok(())) => action_results.push("adb_reboot: OK".to_string()),
                    Ok(Err(err)) => action_results.push(format!("adb_reboot: ERR - {}", err)),
                    Err(err) => action_results.push(format!("adb_reboot: ERR - {}", err)),
                }
            }

            "serial_send" => {
                if session_id.is_empty() {
                    action_results.push("serial_send: SKIPPED (no active session_id)".to_string());
                } else {
                    let state = app.state::<AppState>();
                    let data = render_prompt_template(
                        &action.serial_data,
                        &rule.name,
                        &session_id,
                        &port_name,
                        &matched_text,
                        &log_tail,
                    );
                    match serial::serial_write_with_state(&state, &session_id, &data, Some("lf")) {
                        Ok(()) => action_results.push(format!("serial_send: OK ({})", data)),
                        Err(err) => action_results.push(format!("serial_send: ERR - {}", err)),
                    }
                }
            }

            "notify_webhook" => {
                let url = action.webhook_url.trim();
                if url.is_empty() {
                    action_results.push("notify_webhook: ERR - empty webhook_url".to_string());
                } else {
                    let msg_body = if action.prompt.trim().is_empty() {
                        format!(
                            "[OpenixSuit-CE Trigger] {}\nSession: {} ({})\nMatched: {}",
                            rule.name, session_id, port_name, matched_text
                        )
                    } else {
                        render_prompt_template(
                            &action.prompt,
                            &rule.name,
                            &session_id,
                            &port_name,
                            &matched_text,
                            &log_tail,
                        )
                    };
                    let payload = json!({
                        "msgtype": "text",
                        "text": {
                            "content": msg_body
                        }
                    });
                    let send_res = async {
                        let client = reqwest::Client::builder()
                            .timeout(Duration::from_secs(10))
                            .build()
                            .map_err(|e| e.to_string())?;
                        let body_str =
                            serde_json::to_string(&payload).map_err(|e| e.to_string())?;
                        let resp = client
                            .post(url)
                            .header("Content-Type", "application/json")
                            .body(body_str)
                            .send()
                            .await
                            .map_err(|e| e.to_string())?;
                        let status = resp.status();
                        if !status.is_success() {
                            return Err(format!("HTTP {}", status));
                        }
                        Ok::<String, String>(status.to_string())
                    }
                    .await;

                    match send_res {
                        Ok(st) => action_results.push(format!("notify_webhook: OK ({})", st)),
                        Err(err) => action_results.push(format!("notify_webhook: ERR - {}", err)),
                    }
                }
            }

            "plugin_action" => {
                let lifecycle_device = matches!(rule.condition.kind.as_str(), "device_online" | "flash_completed")
                    .then(|| port_name.as_str());
                let incident = json!({
                    "event":rule.condition.kind, "device":lifecycle_device, "id":id, "rule_id":rule.id, "rule_name":rule.name, "session_id":session_id,
                    "port_name":port_name, "matched_text":matched_text, "created_at":created_at,
                    "log_tail": log_tail.iter().rev().take(100).rev()
                        .map(|line| line.chars().take(1500).collect::<String>()).collect::<Vec<_>>()
                });
                let device = (!action.adb_serial.trim().is_empty())
                    .then(|| action.adb_serial.trim().to_owned())
                    .or_else(|| lifecycle_device.map(str::to_owned));
                let result = crate::plugins::run_trigger(&app, action.plugin_id.clone(), action.plugin_action.clone(),
                    device, action.plugin_inputs.clone(), incident).await;
                match result {
                    Ok(run_id) => action_results.push(format!("plugin_action: {run_id}")),
                    Err(error) => action_results.push(format!("plugin_action: ERR - {error}")),
                }
            }

            "send_ai" => {
                let rendered = if action.prompt.trim().is_empty() {
                    format!(
                        "Analyze serial trigger '{}' on {} ({}): {}",
                        rule.name, session_id, port_name, matched_text
                    )
                } else {
                    render_prompt_template(
                        &action.prompt,
                        &rule.name,
                        &session_id,
                        &port_name,
                        &matched_text,
                        &log_tail,
                    )
                };
                combined_prompts.push(rendered.clone());
                action_results.push(format!("send_ai: OK ({})", rendered));
            }

            other => {
                action_results.push(format!("unknown action '{}': skipped", other));
            }
        }
    }

    let report = IncidentReport {
        id: id.clone(),
        rule_id: rule.id.clone(),
        rule_name: rule.name.clone(),
        session_id,
        port_name: port_name.clone(),
        matched_text: matched_text.clone(),
        prompt: combined_prompts.join("\n\n"),
        log_tail,
        created_at,
        action_results,
    };

    if let Ok(dir) = incidents_dir() {
        let path = dir.join(format!("{}.json", id));
        let _ = save_json_pretty(&path, &report);
    }

    let _ = app.emit("trigger-fired", &report);
    emit_ai_sync(
        &app,
        "trigger",
        "incident",
        "completed",
        format!(
            "[{}] {}: {}",
            report.rule_name, report.port_name, report.matched_text
        ),
    );

    report
}

pub fn on_serial_line(app: &AppHandle, session_id: &str, port_name: &str, line: &str) {
    let now = epoch_secs();
    let mut fired_rules: Vec<TriggerRule> = Vec::new();
    let mut dirty = false;

    {
        let mut rules_guard = match rules_mutex().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let mut counters_guard = match counters_mutex().lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        for rule in rules_guard.iter_mut() {
            if !rule.enabled {
                continue;
            }
            if !rule.target_session_id.is_empty() && rule.target_session_id != session_id {
                continue;
            }
            if rule.cooldown_secs > 0
                && rule.last_triggered_at > 0
                && now.saturating_sub(rule.last_triggered_at) < rule.cooldown_secs
            {
                continue;
            }

            let matched = match rule.condition.kind.as_str() {
                "contains" => line_matches_pattern(&rule.condition.pattern, line, false),
                "contains_cs" => line_matches_pattern(&rule.condition.pattern, line, true),
                "regex" => regex_matches(&rule.condition.pattern, line),
                "count" => {
                    let hit = if rule.condition.pattern.trim().is_empty() {
                        true
                    } else {
                        line_matches_pattern(&rule.condition.pattern, line, false)
                    };
                    if hit {
                        let key = (rule.id.clone(), session_id.to_string());
                        let count = counters_guard.entry(key.clone()).or_insert(0);
                        *count += 1;
                        let threshold = rule.condition.count_threshold.max(1);
                        if *count >= threshold {
                            counters_guard.insert(key, 0);
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
                _ => false,
            };

            if matched {
                rule.trigger_count += 1;
                rule.last_triggered_at = now;
                dirty = true;
                fired_rules.push(rule.clone());
            }
        }

        if dirty {
            if let Ok(path) = rules_path() {
                let _ = save_json_pretty(&path, &*rules_guard);
            }
        }
    }

    for rule in fired_rules {
        let app_clone = app.clone();
        let sid = session_id.to_string();
        let pname = port_name.to_string();
        let line_owned = line.to_string();
        tauri::async_runtime::spawn(async move {
            let report =
                execute_rule_and_report(app_clone.clone(), rule, sid, pname, line_owned).await;
            crate::incident_analysis::enqueue(&app_clone, report);
        });
    }
}

pub(crate) fn on_device_event(app: &AppHandle, kind: &str, device: &str) {
    let now = epoch_secs();
    let Ok(mut rules) = rules_mutex().lock() else { return };
    let mut matched = Vec::new();
    for rule in rules.iter_mut().filter(|rule| rule.enabled && rule.condition.kind == kind) {
        let filter = rule.condition.pattern.trim();
        if (!filter.is_empty() && filter != device)
            || (rule.last_triggered_at > 0 && now.saturating_sub(rule.last_triggered_at) < rule.cooldown_secs)
        {
            continue;
        }
        rule.trigger_count += 1;
        rule.last_triggered_at = now;
        matched.push(rule.clone());
    }
    if matched.is_empty() {
        return;
    }
    if let Ok(path) = rules_path() {
        let _ = save_json_pretty(&path, &*rules);
    }
    drop(rules);
    for rule in matched {
        let app = app.clone();
        let device = device.to_owned();
        let event = format!("{kind}: {device}");
        tauri::async_runtime::spawn(async move {
            let report = execute_rule_and_report(app.clone(), rule, String::new(), device, event).await;
            crate::incident_analysis::enqueue(&app, report);
        });
    }
}

async fn poll_device_edges(app: &AppHandle, previous: &mut Option<std::collections::BTreeSet<String>>) {
    let needed = rules_mutex().lock().is_ok_and(|rules|
        rules.iter().any(|rule| rule.enabled && rule.condition.kind == "device_online"));
    if !needed {
        *previous = None;
        return;
    }
    let backend = {
        let state = app.state::<AppState>();
        let Ok(backend) = state.usb_backend.lock() else { return };
        backend.clone()
    };
    let result = tokio::task::spawn_blocking(move || {
        let adb = adb::adb_list_devices().map(|devices| devices.into_iter()
            .filter(|device| device.is_online()).map(|device| device.target().to_owned()).collect::<Vec<_>>());
        let fel = crate::efex::scan_devices_with_backend(&backend)
            .into_iter().map(|device| device.id).collect::<Vec<_>>();
        (adb, fel)
    }).await;
    if let Ok((adb, fel)) = result {
        let mut current = fel.into_iter().collect::<std::collections::BTreeSet<_>>();
        match adb {
            Ok(devices) => current.extend(devices),
            Err(_) => {
                if let Some(previous) = previous.as_ref() {
                    current.extend(previous.iter().filter(|id| !id.starts_with("bus:")).cloned());
                }
            }
        }
        if let Some(previous) = previous.as_ref() {
            for device in current.difference(previous) {
                on_device_event(app, "device_online", device);
            }
        }
        *previous = Some(current);
    }
}

pub fn start_trigger_watcher(app: AppHandle) {
    // Prime the rules cache on startup.
    let _ = rules_mutex();

    tauri::async_runtime::spawn(async move {
        let mut online = None;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            poll_device_edges(&app, &mut online).await;

            let now_ms = epoch_ms();
            let now_secs = now_ms / 1000;

            let sessions_snapshot: Vec<(String, String, u64)> = {
                let state = app.state::<AppState>();
                let Ok(guard) = state.serial_sessions.lock() else {
                    continue;
                };
                guard
                    .values()
                    .filter(|s| s.connected.load(Ordering::Relaxed))
                    .map(|s| {
                        (
                            s.id.clone(),
                            s.port_name.clone(),
                            s.last_rx_epoch_ms.load(Ordering::Relaxed),
                        )
                    })
                    .collect()
            };

            if sessions_snapshot.is_empty() {
                continue;
            }

            let mut to_fire: Vec<(TriggerRule, String, String, String)> = Vec::new();
            let mut dirty = false;

            if let Ok(mut rules_guard) = rules_mutex().lock() {
                for rule in rules_guard.iter_mut() {
                    if !rule.enabled || rule.condition.kind != "timeout" {
                        continue;
                    }
                    let timeout_secs = rule.condition.timeout_secs;
                    if timeout_secs == 0 {
                        continue;
                    }
                    let effective_cooldown = rule.cooldown_secs.max(timeout_secs);
                    if rule.last_triggered_at > 0
                        && now_secs.saturating_sub(rule.last_triggered_at) < effective_cooldown
                    {
                        continue;
                    }

                    for (sid, pname, last_rx_ms) in &sessions_snapshot {
                        if !rule.target_session_id.is_empty() && &rule.target_session_id != sid {
                            continue;
                        }
                        if now_ms.saturating_sub(*last_rx_ms) >= timeout_secs * 1000 {
                            rule.trigger_count += 1;
                            rule.last_triggered_at = now_secs;
                            dirty = true;
                            to_fire.push((
                                rule.clone(),
                                sid.clone(),
                                pname.clone(),
                                format!("Serial RX timeout ({}s without data)", timeout_secs),
                            ));
                            break;
                        }
                    }
                }

                if dirty {
                    if let Ok(path) = rules_path() {
                        let _ = save_json_pretty(&path, &*rules_guard);
                    }
                }
            }

            for (rule, sid, pname, reason) in to_fire {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let report =
                        execute_rule_and_report(app_clone.clone(), rule, sid, pname, reason).await;
                    crate::incident_analysis::enqueue(&app_clone, report);
                });
            }
        }
    });
}

#[tauri::command]
pub fn trigger_list_rules() -> Result<Vec<TriggerRule>, String> {
    let guard = rules_mutex()
        .lock()
        .map_err(|_| "Trigger rules lock poisoned".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn trigger_save_rules(
    mut rules: Vec<TriggerRule>,
    removed_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let mut current = rules_mutex()
        .lock()
        .map_err(|_| "Trigger rules lock poisoned".to_string())?;
    if let Some(removed_ids) = removed_ids {
        let mut merged = current.clone();
        merged.retain(|rule| !removed_ids.contains(&rule.id));
        for rule in rules {
            if let Some(previous) = merged.iter_mut().find(|previous| previous.id == rule.id) {
                let mut rule = rule;
                rule.trigger_count = previous.trigger_count;
                rule.last_triggered_at = previous.last_triggered_at;
                *previous = rule;
            } else {
                merged.push(rule);
            }
        }
        rules = merged;
    }
    for rule in &mut rules {
        if rule.enabled {
            rule.draft = false;
        }
    }
    save_json_pretty(&rules_path()?, &rules)?;
    *current = rules;
    if let Ok(mut counters) = counters_mutex().lock() {
        counters.clear();
    }
    Ok(())
}

pub fn save_rule_draft(app: &AppHandle, mut rule: TriggerRule) -> Result<TriggerRule, String> {
    if rule.id.trim().is_empty() || rule.name.trim().is_empty() {
        return Err("A rule draft requires an ID and a name".to_string());
    }
    if !matches!(
        rule.condition.kind.as_str(),
        "contains" | "contains_cs" | "regex" | "timeout" | "count" | "device_online" | "flash_completed"
    ) {
        return Err(format!(
            "Unknown trigger condition: {}",
            rule.condition.kind
        ));
    }
    if rule.condition.kind == "regex" {
        Regex::new(&rule.condition.pattern).map_err(|e| format!("Invalid trigger regex: {e}"))?;
    }
    if rule.condition.kind == "timeout"
        && rule
            .condition
            .timeout_secs
            .checked_mul(1000)
            .filter(|&ms| ms > 0)
            .is_none()
    {
        return Err("Trigger timeout must be positive and fit in milliseconds".to_string());
    }
    if let Some(action) = rule.actions.iter().find(|action| {
        !matches!(
            action.kind.as_str(),
            "power_control" | "send_ai" | "adb_reboot" | "serial_send" | "notify_webhook" | "plugin_action"
        )
    }) {
        return Err(format!("Unknown trigger action: {}", action.kind));
    }
    rule.enabled = false;
    rule.draft = true;
    rule.trigger_count = 0;
    rule.last_triggered_at = 0;

    let mut current = rules_mutex()
        .lock()
        .map_err(|_| "Trigger rules lock poisoned".to_string())?;
    let mut updated = current.clone();
    if let Some(previous) = updated.iter_mut().find(|previous| previous.id == rule.id) {
        if !previous.draft || previous.enabled {
            return Err(format!(
                "Rule '{}' is already confirmed. Use a new draft ID",
                rule.id
            ));
        }
        *previous = rule.clone();
    } else {
        updated.push(rule.clone());
    }
    save_json_pretty(&rules_path()?, &updated)?;
    *current = updated;
    let _ = app.emit("automation-rule-draft-saved", &rule);
    Ok(rule)
}

#[tauri::command]
pub async fn trigger_test_rule(
    _app: AppHandle,
    state: State<'_, AppState>,
    rule_id: String,
    sample_line: String,
) -> Result<IncidentReport, String> {
    let rule = {
        let guard = rules_mutex()
            .lock()
            .map_err(|_| "Trigger rules lock poisoned".to_string())?;
        guard
            .iter()
            .find(|r| r.id == rule_id)
            .cloned()
            .ok_or_else(|| format!("Trigger rule not found: {}", rule_id))?
    };

    let (session_id, port_name) = {
        let guard = state
            .serial_sessions
            .lock()
            .map_err(|_| "Serial sessions lock poisoned".to_string())?;
        if !rule.target_session_id.is_empty() {
            let pname = guard
                .get(&rule.target_session_id)
                .map(|s| s.port_name.clone())
                .unwrap_or_default();
            (rule.target_session_id.clone(), pname)
        } else if let Some(first) = guard.values().next() {
            (first.id.clone(), first.port_name.clone())
        } else {
            (String::new(), String::new())
        }
    };
    let (matched, condition_result) =
        preview_test_condition(&rule, &sample_line, &session_id, &state)?;
    if !matched {
        return Err(format!("Rule condition does not match: {condition_result}"));
    }
    let now = epoch_secs();
    Ok(IncidentReport {
        id: format!("preview-{}", epoch_ms()),
        rule_id: rule.id,
        rule_name: rule.name,
        session_id,
        port_name,
        matched_text: sample_line,
        prompt: String::new(),
        log_tail: Vec::new(),
        created_at: now,
        action_results: rule
            .actions
            .iter()
            .map(|action| format!("{}: preview only; action not executed", action.kind))
            .collect(),
    })
}

fn preview_test_condition(
    rule: &TriggerRule,
    sample_line: &str,
    session_id: &str,
    state: &AppState,
) -> Result<(bool, String), String> {
    if !rule.target_session_id.is_empty() && rule.target_session_id != session_id {
        return Ok((
            false,
            format!(
                "Rule is scoped to serial session {}",
                rule.target_session_id
            ),
        ));
    }
    let matched = match rule.condition.kind.as_str() {
        "device_online" | "flash_completed" => {
            let device = sample_line.trim();
            !device.is_empty() && (rule.condition.pattern.trim().is_empty() || rule.condition.pattern.trim() == device)
        }
        "contains" | "contains_cs" | "regex" | "count" => {
            let current = counters_mutex()
                .lock()
                .map_err(|_| "Trigger counters lock poisoned".to_string())?
                .get(&(rule.id.clone(), session_id.to_string()))
                .copied()
                .unwrap_or(0);
            preview_line_condition(&rule.condition, sample_line, current)?
        }
        "timeout" => {
            let sessions = state
                .serial_sessions
                .lock()
                .map_err(|_| "Serial sessions lock poisoned".to_string())?;
            let session = sessions
                .get(session_id)
                .filter(|session| session.connected.load(Ordering::Relaxed));
            session
                .map(|session| {
                    epoch_ms().saturating_sub(session.last_rx_epoch_ms.load(Ordering::Relaxed))
                        >= rule.condition.timeout_secs.saturating_mul(1000)
                })
                .unwrap_or(false)
        }
        other => return Err(format!("Unknown trigger condition: {other}")),
    };
    let detail = if matched {
        "Condition matches".to_string()
    } else if rule.condition.kind == "timeout" {
        format!(
            "Serial session has not been silent for {} seconds",
            rule.condition.timeout_secs
        )
    } else if rule.condition.kind == "count" {
        format!(
            "The next matching line does not reach the count threshold of {}",
            rule.condition.count_threshold.max(1)
        )
    } else {
        "Sample text does not match the condition".to_string()
    };
    Ok((matched, detail))
}

#[cfg(test)]
mod preview_tests {
    use super::{preview_line_condition, TriggerCondition};

    fn condition(kind: &str, pattern: &str, count_threshold: u32) -> TriggerCondition {
        TriggerCondition {
            kind: kind.to_string(),
            pattern: pattern.to_string(),
            timeout_secs: 0,
            count_threshold,
        }
    }

    #[test]
    fn preview_matches_literal_and_regex_conditions() {
        assert!(
            preview_line_condition(&condition("contains", "kernel", 0), "Kernel panic", 0).unwrap()
        );
        assert!(
            !preview_line_condition(&condition("contains_cs", "kernel", 0), "Kernel panic", 0)
                .unwrap()
        );
        assert!(preview_line_condition(
            &condition("regex", r"Kernel\s+panic", 0),
            "Kernel panic",
            0
        )
        .unwrap());
    }

    #[test]
    fn preview_count_checks_next_hit_without_advancing_counter() {
        let threshold = condition("count", "panic", 3);
        let current_count = 1;
        assert!(!preview_line_condition(&threshold, "panic", current_count).unwrap());
        assert!(preview_line_condition(&threshold, "panic", current_count + 1).unwrap());
        assert_eq!(current_count, 1);
    }
}

#[tauri::command]
pub fn trigger_preview_rule(
    state: State<'_, AppState>,
    rule: TriggerRule,
    sample_line: String,
    session_id: String,
) -> Result<TriggerTestPreview, String> {
    if rule.condition.kind == "regex" {
        Regex::new(&rule.condition.pattern).map_err(|e| format!("Invalid trigger regex: {e}"))?;
    }
    let session_id = if session_id.is_empty() {
        rule.target_session_id.clone()
    } else {
        session_id
    };
    let (port_name, connected) = {
        let sessions = state
            .serial_sessions
            .lock()
            .map_err(|_| "Serial sessions lock poisoned".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| {
                (
                    session.port_name.clone(),
                    session.connected.load(Ordering::Relaxed),
                )
            })
            .unwrap_or_default()
    };
    let (matched, condition_result) =
        preview_test_condition(&rule, &sample_line, &session_id, &state)?;
    Ok(TriggerTestPreview {
        matched,
        connected,
        condition_result,
        session_id,
        port_name,
        matched_text: sample_line,
    })
}

#[tauri::command]
pub async fn trigger_execute_test_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    rule: TriggerRule,
    sample_line: String,
    session_id: String,
    confirmed_session_id: String,
    confirmed_port_name: String,
    action_indexes: Vec<usize>,
) -> Result<IncidentReport, String> {
    if confirmed_session_id != session_id {
        return Err("Confirmed target changed after preview".to_string());
    }
    let (matched, condition_result) =
        preview_test_condition(&rule, &sample_line, &session_id, &state)?;
    if !matched {
        return Err(format!(
            "Rule condition no longer matches: {condition_result}"
        ));
    }
    if action_indexes.is_empty() {
        return Err("Select at least one action to execute".to_string());
    }
    let mut indexes = action_indexes;
    indexes.sort_unstable();
    indexes.dedup();
    let actions = rule
        .actions
        .iter()
        .enumerate()
        .filter(|(index, _)| indexes.binary_search(index).is_ok())
        .map(|(_, action)| action.clone())
        .collect::<Vec<_>>();
    if actions.len() != indexes.len() {
        return Err("An action changed after preview".to_string());
    }
    let port_name = {
        let sessions = state
            .serial_sessions
            .lock()
            .map_err(|_| "Serial sessions lock poisoned".to_string())?;
        sessions
            .get(&session_id)
            .filter(|session| session.connected.load(Ordering::Relaxed))
            .map(|session| session.port_name.clone())
            .ok_or_else(|| "Selected serial session is no longer connected".to_string())?
    };
    if port_name != confirmed_port_name {
        return Err("Confirmed serial port changed after preview".to_string());
    }
    let mut executable_rule = rule;
    executable_rule.actions = actions;
    executable_rule.trigger_count = executable_rule.trigger_count.saturating_add(1);
    Ok(execute_rule_and_report(app, executable_rule, session_id, port_name, sample_line).await)
}

#[tauri::command]
pub fn trigger_list_incidents() -> Result<Vec<IncidentReport>, String> {
    let dir = incidents_dir()?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read incidents dir: {}", e))?;
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(report) = serde_json::from_str::<IncidentReport>(&content) {
                list.push(report);
            }
        }
    }
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(list)
}

#[tauri::command]
pub fn trigger_clear_incidents(app: AppHandle) -> Result<(), String> {
    let dir = incidents_dir()?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read incidents dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let _ = fs::remove_file(&path);
        }
    }
    crate::incident_analysis::clear(&app)
}
