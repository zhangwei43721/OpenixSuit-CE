use crate::state::{app_data_dir, emit_ai_sync, load_json_or_default, save_json_pretty};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PowerProfile {
    pub id: String,
    pub name: String,
    pub draft: bool,
    pub kind: String,
    pub port_name: String,
    pub baud_rate: u32,
    pub on_cmd: String,
    pub off_cmd: String,
    pub hex_mode: bool,
    pub http_on_url: String,
    pub http_off_url: String,
    pub cmd_on: String,
    pub cmd_off: String,
    pub cycle_delay_ms: u64,
}

static PROFILE_LOCK: Mutex<()> = Mutex::new(());

fn lock_profiles() -> Result<MutexGuard<'static, ()>, String> {
    PROFILE_LOCK
        .lock()
        .map_err(|_| "Power profiles lock poisoned".to_string())
}

fn profiles_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("power_profiles.json"))
}

fn parse_hex_bytes(spec: &str) -> Result<Vec<u8>, String> {
    let cleaned = spec.replace(',', " ");
    let mut bytes = Vec::new();
    for token in cleaned.split_whitespace() {
        let hex = token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
            .unwrap_or(token);
        if hex.is_empty() {
            continue;
        }
        if hex.len() > 2 && hex.len() % 2 == 0 {
            for idx in (0..hex.len()).step_by(2) {
                let b = u8::from_str_radix(&hex[idx..idx + 2], 16)
                    .map_err(|e| format!("Invalid hex byte '{}': {}", &hex[idx..idx + 2], e))?;
                bytes.push(b);
            }
        } else {
            let b = u8::from_str_radix(hex, 16)
                .map_err(|e| format!("Invalid hex byte '{}': {}", token, e))?;
            bytes.push(b);
        }
    }
    if bytes.is_empty() {
        return Err("Hex command is empty".to_string());
    }
    Ok(bytes)
}

fn unescape_text_cmd(cmd: &str) -> Vec<u8> {
    let mut out = String::with_capacity(cmd.len());
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('r') => {
                    chars.next();
                    out.push('\r');
                }
                Some('n') => {
                    chars.next();
                    out.push('\n');
                }
                Some('t') => {
                    chars.next();
                    out.push('\t');
                }
                Some('\\') => {
                    chars.next();
                    out.push('\\');
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out.into_bytes()
}

fn parse_dtr_rts_spec(cmd: &str, default_level: bool) -> (Option<bool>, Option<bool>) {
    let trimmed = cmd.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return (Some(default_level), Some(default_level));
    }

    let parse_bool = |v: &str| -> Option<bool> {
        match v.trim() {
            "1" | "true" | "high" | "on" => Some(true),
            "0" | "false" | "low" | "off" => Some(false),
            _ => None,
        }
    };

    if let Some(level) = parse_bool(&trimmed) {
        return (Some(level), Some(level));
    }

    let mut dtr = None;
    let mut rts = None;
    for part in trimmed.split([',', ';', ' ']) {
        let p = part.trim();
        if let Some(val) = p.strip_prefix("dtr=") {
            dtr = parse_bool(val);
        } else if let Some(val) = p.strip_prefix("rts=") {
            rts = parse_bool(val);
        }
    }

    if dtr.is_none() && rts.is_none() {
        (Some(default_level), Some(default_level))
    } else {
        (dtr, rts)
    }
}

async fn execute_single_step(profile: &PowerProfile, is_on: bool) -> Result<String, String> {
    let verb = if is_on { "on" } else { "off" };
    match profile.kind.as_str() {
        "serial_relay" => {
            if profile.port_name.trim().is_empty() {
                return Err("Power profile serial port_name is empty".to_string());
            }
            let port_name = profile.port_name.clone();
            let baud = if profile.baud_rate == 0 {
                9600
            } else {
                profile.baud_rate
            };
            let cmd = if is_on {
                profile.on_cmd.clone()
            } else {
                profile.off_cmd.clone()
            };
            let payload = if profile.hex_mode {
                parse_hex_bytes(&cmd)?
            } else {
                unescape_text_cmd(&cmd)
            };
            if payload.is_empty() {
                return Err(format!("Power profile '{}' command is empty", verb));
            }
            let len = payload.len();
            tokio::task::spawn_blocking(move || {
                let mut port = serialport::new(&port_name, baud)
                    .timeout(Duration::from_millis(500))
                    .open()
                    .map_err(|e| format!("Failed to open relay port '{}': {}", port_name, e))?;
                port.write_all(&payload)
                    .map_err(|e| format!("Failed to write relay command: {}", e))?;
                port.flush()
                    .map_err(|e| format!("Failed to flush relay port: {}", e))?;
                Ok::<(), String>(())
            })
            .await
            .map_err(|e| format!("Power task join error: {}", e))??;

            Ok(format!(
                "serial_relay {} ({} bytes) -> {}",
                verb, len, profile.port_name
            ))
        }

        "serial_dtr_rts" => {
            if profile.port_name.trim().is_empty() {
                return Err("Power profile serial port_name is empty".to_string());
            }
            let port_name = profile.port_name.clone();
            let baud = if profile.baud_rate == 0 {
                9600
            } else {
                profile.baud_rate
            };
            let cmd = if is_on {
                &profile.on_cmd
            } else {
                &profile.off_cmd
            };
            let (dtr, rts) = parse_dtr_rts_spec(cmd, is_on);
            tokio::task::spawn_blocking(move || {
                let mut port = serialport::new(&port_name, baud)
                    .timeout(Duration::from_millis(500))
                    .open()
                    .map_err(|e| format!("Failed to open serial port '{}': {}", port_name, e))?;
                if let Some(level) = dtr {
                    port.write_data_terminal_ready(level)
                        .map_err(|e| format!("Failed to set DTR: {}", e))?;
                }
                if let Some(level) = rts {
                    port.write_request_to_send(level)
                        .map_err(|e| format!("Failed to set RTS: {}", e))?;
                }
                std::thread::sleep(Duration::from_millis(50));
                Ok::<(), String>(())
            })
            .await
            .map_err(|e| format!("Power task join error: {}", e))??;

            Ok(format!(
                "serial_dtr_rts {} (dtr={:?}, rts={:?}) -> {}",
                verb, dtr, rts, profile.port_name
            ))
        }

        "http" => {
            let url = if is_on {
                profile.http_on_url.trim()
            } else {
                profile.http_off_url.trim()
            };
            if url.is_empty() {
                return Err(format!("Power profile HTTP {} URL is empty", verb));
            }
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
            let resp = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("HTTP power request failed: {}", e))?;
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("HTTP power endpoint returned status {}", status));
            }
            Ok(format!("http {} -> {} ({})", verb, url, status))
        }

        "command" => {
            let cmd = if is_on {
                profile.cmd_on.trim()
            } else {
                profile.cmd_off.trim()
            };
            if cmd.is_empty() {
                return Err(format!("Power profile shell {} command is empty", verb));
            }
            let output = {
                #[cfg(windows)]
                {
                    tokio::process::Command::new("cmd")
                        .args(["/C", cmd])
                        .output()
                        .await
                }
                #[cfg(not(windows))]
                {
                    tokio::process::Command::new("sh")
                        .args(["-c", cmd])
                        .output()
                        .await
                }
            }
            .map_err(|e| format!("Failed to execute power command: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "Power command exited with {}: {}",
                    output.status,
                    stderr.trim()
                ));
            }
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                Ok(format!("command {} succeeded", verb))
            } else {
                Ok(format!("command {} succeeded: {}", verb, stdout))
            }
        }

        other => Err(format!("Unsupported power profile kind: '{}'", other)),
    }
}

pub async fn power_execute_async(profile_id: &str, action: &str) -> Result<String, String> {
    let profiles = power_list_profiles()?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Power profile not found: {}", profile_id))?;
    if profile.draft {
        return Err(format!(
            "Confirm the power profile '{}' before executing it",
            profile.name
        ));
    }

    let act = action.trim().to_ascii_lowercase();
    match act.as_str() {
        "on" => execute_single_step(&profile, true).await,
        "off" => execute_single_step(&profile, false).await,
        "cycle" => {
            let off_msg = execute_single_step(&profile, false).await?;
            let delay_ms = if profile.cycle_delay_ms == 0 {
                1000
            } else {
                profile.cycle_delay_ms
            };
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let on_msg = execute_single_step(&profile, true).await?;
            Ok(format!(
                "Power cycle completed ({} -> sleep {}ms -> {})",
                off_msg, delay_ms, on_msg
            ))
        }
        other => Err(format!(
            "Unsupported power action '{}', expected 'on', 'off', or 'cycle'",
            other
        )),
    }
}

#[allow(dead_code)]
pub fn power_execute_internal(profile_id: &str, action: &str) -> Result<String, String> {
    let pid = profile_id.to_string();
    let act = action.to_string();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("Failed to create Tokio runtime: {}", e))?;
        rt.block_on(power_execute_async(&pid, &act))
    })
    .join()
    .map_err(|_| "Power execution thread panicked".to_string())?
}

#[tauri::command]
pub fn power_list_profiles() -> Result<Vec<PowerProfile>, String> {
    let _guard = lock_profiles()?;
    load_json_or_default(&profiles_path()?)
}

#[tauri::command]
pub fn power_save_profiles(
    mut profiles: Vec<PowerProfile>,
    removed_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let _guard = lock_profiles()?;
    let path = profiles_path()?;
    if let Some(removed_ids) = removed_ids {
        let mut merged: Vec<PowerProfile> = load_json_or_default(&path)?;
        merged.retain(|profile| !removed_ids.contains(&profile.id));
        for profile in profiles {
            if let Some(previous) = merged.iter_mut().find(|previous| previous.id == profile.id) {
                *previous = profile;
            } else {
                merged.push(profile);
            }
        }
        profiles = merged;
    }
    save_json_pretty(&path, &profiles)
}

pub fn save_profile_draft(
    app: &AppHandle,
    mut profile: PowerProfile,
) -> Result<PowerProfile, String> {
    if profile.id.trim().is_empty() || profile.name.trim().is_empty() {
        return Err("A power profile draft requires an ID and a name".to_string());
    }
    if !matches!(
        profile.kind.as_str(),
        "serial_relay" | "serial_dtr_rts" | "http" | "command"
    ) {
        return Err(format!(
            "Unsupported power profile kind: '{}'",
            profile.kind
        ));
    }
    profile.draft = true;
    let _guard = lock_profiles()?;
    let path = profiles_path()?;
    let mut profiles: Vec<PowerProfile> = load_json_or_default(&path)?;
    if let Some(previous) = profiles
        .iter_mut()
        .find(|previous| previous.id == profile.id)
    {
        if !previous.draft {
            return Err(format!(
                "Power profile '{}' is already confirmed. Use a new draft ID",
                profile.id
            ));
        }
        *previous = profile.clone();
    } else {
        profiles.push(profile.clone());
    }
    save_json_pretty(&path, &profiles)?;
    let _ = app.emit("automation-power-draft-saved", &profile);
    Ok(profile)
}

#[tauri::command]
pub fn power_confirm_profile(mut profile: PowerProfile) -> Result<PowerProfile, String> {
    let _guard = lock_profiles()?;
    let path = profiles_path()?;
    let mut profiles: Vec<PowerProfile> = load_json_or_default(&path)?;
    let previous = profiles
        .iter_mut()
        .find(|previous| previous.id == profile.id && previous.draft)
        .ok_or_else(|| format!("Power profile draft not found: {}", profile.id))?;
    profile.draft = false;
    *previous = profile.clone();
    save_json_pretty(&path, &profiles)?;
    Ok(profile)
}

#[tauri::command]
pub async fn power_execute(
    app: AppHandle,
    profile_id: String,
    action: String,
) -> Result<String, String> {
    emit_ai_sync(
        &app,
        "ui",
        "power",
        "started",
        format!("Executing power '{}' on profile '{}'", action, profile_id),
    );
    match power_execute_async(&profile_id, &action).await {
        Ok(msg) => {
            emit_ai_sync(&app, "ui", "power", "completed", msg.clone());
            Ok(msg)
        }
        Err(err) => {
            emit_ai_sync(&app, "ui", "power", "error", err.clone());
            Err(err)
        }
    }
}
