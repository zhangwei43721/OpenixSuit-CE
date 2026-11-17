use crate::adb;
use crate::state::{app_data_dir, epoch_ms, load_json_or_default, save_json_pretty};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CpuSnapshot {
    pub total: u64,
    pub idle: u64,
    pub user: u64,
    pub sys: u64,
    pub iowait: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceMetrics {
    pub kernel: String,
    pub cpu_cores: u32,
    pub cpu_total_pct: f64,
    pub cpu_user_pct: f64,
    pub cpu_sys_pct: f64,
    pub cpu_io_pct: f64,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub mem_cached_kb: u64,
    pub mem_buffers_kb: u64,
    pub temp_celsius: Option<f64>,
    pub top_output: String,
    pub snapshot: CpuSnapshot,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WorkspaceSerialSlot {
    pub label: String,
    pub port_name: String,
    pub baud_rate: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DeviceWorkspace {
    pub id: String,
    pub name: String,
    pub chip: String,
    pub adb_serial: String,
    pub workspace_dir: String,
    pub power_profile_id: String,
    pub serial_ports: Vec<WorkspaceSerialSlot>,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct FlashHistoryItem {
    pub id: String,
    pub firmware_path: String,
    pub firmware_name: String,
    pub mode: String,
    pub status: String,
    pub message: String,
    pub timestamp: u64,
}

fn workspaces_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("workspaces.json"))
}

fn flash_history_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("flash_history.json"))
}

fn extract_section<'a>(raw: &'a str, marker: &str, next_markers: &[&str]) -> &'a str {
    let Some(start) = raw.find(marker) else {
        return "";
    };
    let after = &raw[start + marker.len()..];
    let mut end = after.len();
    for m in next_markers {
        if let Some(pos) = after.find(m) {
            if pos < end {
                end = pos;
            }
        }
    }
    after[..end].trim()
}

fn parse_proc_stat(section: &str) -> CpuSnapshot {
    for line in section.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("cpu ") {
            continue;
        }
        let vals: Vec<u64> = trimmed
            .split_whitespace()
            .skip(1)
            .filter_map(|s| s.parse::<u64>().ok())
            .collect();
        if vals.len() < 4 {
            continue;
        }
        let user = vals[0].saturating_add(vals[1]);
        let sys_base = vals[2];
        let idle_only = vals[3];
        let iowait = vals.get(4).copied().unwrap_or(0);
        let irq = vals.get(5).copied().unwrap_or(0);
        let softirq = vals.get(6).copied().unwrap_or(0);
        let sys = sys_base.saturating_add(irq).saturating_add(softirq);
        let idle = idle_only.saturating_add(iowait);
        let total: u64 = vals.iter().copied().sum();
        return CpuSnapshot {
            total,
            idle,
            user,
            sys,
            iowait,
        };
    }
    CpuSnapshot::default()
}

fn parse_meminfo(section: &str) -> (u64, u64, u64, u64) {
    let mut total_kb = 0u64;
    let mut free_kb = 0u64;
    let mut available_kb: Option<u64> = None;
    let mut buffers_kb = 0u64;
    let mut cached_kb = 0u64;

    for line in section.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let val = rest
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        match key.trim() {
            "MemTotal" => total_kb = val,
            "MemFree" => free_kb = val,
            "MemAvailable" => available_kb = Some(val),
            "Buffers" => buffers_kb = val,
            "Cached" => cached_kb = val,
            _ => {}
        }
    }

    let used_kb = match available_kb {
        Some(avail) => total_kb.saturating_sub(avail),
        None => total_kb.saturating_sub(free_kb + buffers_kb + cached_kb),
    };

    (total_kb, used_kb, cached_kb, buffers_kb)
}

fn parse_temp(section: &str) -> Option<f64> {
    let mut best: Option<f64> = None;
    for line in section.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(raw) = trimmed.parse::<f64>() {
            let celsius = if raw.abs() > 1000.0 {
                raw / 1000.0
            } else {
                raw
            };
            if (-50.0..=150.0).contains(&celsius) {
                best = Some(match best {
                    Some(prev) => prev.max(celsius),
                    None => celsius,
                });
            }
        }
    }
    best.map(|t| (t * 10.0).round() / 10.0)
}

fn round_pct(val: f64) -> f64 {
    (val.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

#[tauri::command]
pub fn adb_get_metrics(
    serial: String,
    prev_snapshot: Option<CpuSnapshot>,
) -> Result<DeviceMetrics, String> {
    let script = concat!(
        "echo '===KERNEL==='; uname -r 2>/dev/null; ",
        "echo '===NPROC==='; (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1); ",
        "echo '===STAT==='; head -n 1 /proc/stat 2>/dev/null; ",
        "echo '===MEM==='; cat /proc/meminfo 2>/dev/null; ",
        "echo '===TEMP==='; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -n 6; ",
        "echo '===TOP==='; (top -bn1 2>/dev/null || ps -A 2>/dev/null || ps 2>/dev/null) | head -n 35"
    );

    let raw = adb::adb_exec_shell(serial, script.to_string())?;
    let markers = [
        "===KERNEL===",
        "===NPROC===",
        "===STAT===",
        "===MEM===",
        "===TEMP===",
        "===TOP===",
    ];

    let kernel = extract_section(&raw, "===KERNEL===", &markers[1..]).to_string();
    let nproc_str = extract_section(&raw, "===NPROC===", &markers[2..]);
    let cpu_cores = nproc_str
        .lines()
        .next()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(1)
        .max(1);
    let stat_sec = extract_section(&raw, "===STAT===", &markers[3..]);
    let mem_sec = extract_section(&raw, "===MEM===", &markers[4..]);
    let temp_sec = extract_section(&raw, "===TEMP===", &markers[5..]);
    let top_output = extract_section(&raw, "===TOP===", &[]).to_string();

    let snapshot = parse_proc_stat(stat_sec);
    let (cpu_total_pct, cpu_user_pct, cpu_sys_pct, cpu_io_pct) = match prev_snapshot {
        Some(prev) if snapshot.total > prev.total => {
            let dt = (snapshot.total - prev.total) as f64;
            let d_idle = snapshot.idle.saturating_sub(prev.idle) as f64;
            let d_user = snapshot.user.saturating_sub(prev.user) as f64;
            let d_sys = snapshot.sys.saturating_sub(prev.sys) as f64;
            let d_io = snapshot.iowait.saturating_sub(prev.iowait) as f64;
            (
                round_pct((dt - d_idle) / dt * 100.0),
                round_pct(d_user / dt * 100.0),
                round_pct(d_sys / dt * 100.0),
                round_pct(d_io / dt * 100.0),
            )
        }
        _ if snapshot.total > 0 => {
            let dt = snapshot.total as f64;
            (
                round_pct((snapshot.total.saturating_sub(snapshot.idle) as f64) / dt * 100.0),
                round_pct((snapshot.user as f64) / dt * 100.0),
                round_pct((snapshot.sys as f64) / dt * 100.0),
                round_pct((snapshot.iowait as f64) / dt * 100.0),
            )
        }
        _ => (0.0, 0.0, 0.0, 0.0),
    };

    let (mem_total_kb, mem_used_kb, mem_cached_kb, mem_buffers_kb) = parse_meminfo(mem_sec);
    let temp_celsius = parse_temp(temp_sec);

    Ok(DeviceMetrics {
        kernel,
        cpu_cores,
        cpu_total_pct,
        cpu_user_pct,
        cpu_sys_pct,
        cpu_io_pct,
        mem_total_kb,
        mem_used_kb,
        mem_cached_kb,
        mem_buffers_kb,
        temp_celsius,
        top_output,
        snapshot,
        timestamp_ms: epoch_ms(),
    })
}

#[tauri::command]
pub fn workspace_list() -> Result<Vec<DeviceWorkspace>, String> {
    let path = workspaces_path()?;
    load_json_or_default(&path)
}

#[tauri::command]
pub fn workspace_save(workspaces: Vec<DeviceWorkspace>) -> Result<(), String> {
    let path = workspaces_path()?;
    save_json_pretty(&path, &workspaces)
}

#[tauri::command]
pub fn flash_history_list() -> Result<Vec<FlashHistoryItem>, String> {
    let path = flash_history_path()?;
    load_json_or_default(&path)
}

#[tauri::command]
pub fn flash_history_add(item: FlashHistoryItem) -> Result<(), String> {
    let path = flash_history_path()?;
    let mut list: Vec<FlashHistoryItem> = load_json_or_default(&path)?;
    list.retain(|x| x.id != item.id);
    list.insert(0, item);
    if list.len() > 200 {
        list.truncate(200);
    }
    save_json_pretty(&path, &list)
}

#[tauri::command]
pub fn flash_history_delete(id: String) -> Result<(), String> {
    let path = flash_history_path()?;
    let mut list: Vec<FlashHistoryItem> = load_json_or_default(&path)?;
    list.retain(|x| x.id != id);
    save_json_pretty(&path, &list)
}

#[tauri::command]
pub fn flash_history_clear() -> Result<(), String> {
    let path = flash_history_path()?;
    let empty: Vec<FlashHistoryItem> = Vec::new();
    save_json_pretty(&path, &empty)
}
