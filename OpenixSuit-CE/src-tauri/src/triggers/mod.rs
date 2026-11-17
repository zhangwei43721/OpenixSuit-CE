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
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerCondition {
    pub kind: String, // "contains" | "contains_cs" | "regex" | "timeout" | "count"
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
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
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

static RULES_CACHE: OnceLock<Mutex<Vec<TriggerRule>>> = OnceLock::new();
static COUNTERS: OnceLock<Mutex<HashMap<(String, String), u32>>> = OnceLock::new();
static REGEX_CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();

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
    let tail_count = if tail_requested == 0 { 50 } else { tail_requested };

    let log_tail = {
        let state = app.state::<AppState>();
        if session_id.is_empty() {
            Vec::new()
        } else {
            serial::serial_get_buffer_with_state(&state, &session_id, Some(tail_count))
                .unwrap_or_default()
        }
    };

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
                        let body_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
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

    let created_at = epoch_secs();
    let id = format!("inc-{}-{}", epoch_ms(), rule.trigger_count);
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
        format!("[{}] {}: {}", report.rule_name, report.port_name, report.matched_text),
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
            let _ = execute_rule_and_report(app_clone, rule, sid, pname, line_owned).await;
        });
    }
}

pub fn start_trigger_watcher(app: AppHandle) {
    // Prime the rules cache on startup.
    let _ = rules_mutex();

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;

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
                    let _ = execute_rule_and_report(app_clone, rule, sid, pname, reason).await;
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
pub fn trigger_save_rules(rules: Vec<TriggerRule>) -> Result<(), String> {
    let path = rules_path()?;
    save_json_pretty(&path, &rules)?;
    if let Ok(mut guard) = rules_mutex().lock() {
        *guard = rules;
    }
    if let Ok(mut counters) = counters_mutex().lock() {
        counters.clear();
    }
    Ok(())
}

#[tauri::command]
pub async fn trigger_test_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    rule_id: String,
    sample_line: String,
) -> Result<IncidentReport, String> {
    let mut rule = {
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

    rule.trigger_count += 1;
    let matched_text = if sample_line.trim().is_empty() {
        format!("[test] {}", rule.name)
    } else {
        sample_line
    };

    Ok(execute_rule_and_report(app, rule, session_id, port_name, matched_text).await)
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
pub fn trigger_clear_incidents() -> Result<(), String> {
    let dir = incidents_dir()?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read incidents dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}
