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
    pub cores: Vec<CoreCounter>,
    pub net: Vec<NetCounter>,
    pub disk: Vec<DiskCounter>,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CoreCounter {
    pub total: u64,
    pub idle: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct NetCounter {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DiskCounter {
    pub name: String,
    pub read_sectors: u64,
    pub write_sectors: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NetIfaceRate {
    pub name: String,
    pub rx_kbps: f64,
    pub tx_kbps: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiskRate {
    pub name: String,
    pub read_kbps: f64,
    pub write_kbps: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageUsage {
    pub device: String,
    pub mount: String,
    #[serde(default)]
    pub fstype: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    pub use_pct: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatteryInfo {
    pub name: String,
    pub status: String,
    pub capacity_pct: Option<f64>,
    pub voltage_v: Option<f64>,
    pub current_ma: Option<f64>,
    pub temp_c: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceMetrics {
    pub kernel: String,
    pub cpu_cores: u32,
    pub cpu_total_pct: f64,
    pub cpu_user_pct: f64,
    pub cpu_sys_pct: f64,
    pub cpu_io_pct: f64,
    pub cpu_core_pcts: Vec<f64>,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub mem_cached_kb: u64,
    pub mem_buffers_kb: u64,
    pub temp_celsius: Option<f64>,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub uptime_s: f64,
    pub net_ifaces: Vec<NetIfaceRate>,
    pub net_rx_kbps: f64,
    pub net_tx_kbps: f64,
    pub disk_devices: Vec<DiskRate>,
    pub disk_read_kbps: f64,
    pub disk_write_kbps: f64,
    pub storage: Vec<StorageUsage>,
    pub battery: Option<BatteryInfo>,
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
            ..Default::default()
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

fn parse_loadavg(section: &str) -> (f64, f64, f64) {
    let line = section.lines().next().unwrap_or("").trim();
    let mut it = line.split_whitespace();
    let next = |it: &mut std::str::SplitWhitespace| {
        it.next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
    };
    (
        next(&mut it),
        next(&mut it),
        next(&mut it),
    )
}

fn parse_uptime(section: &str) -> f64 {
    section
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn parse_core_counters(section: &str) -> Vec<CoreCounter> {
    let mut out = Vec::new();
    for line in section.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("cpu") {
            continue;
        }
        let name_end = trimmed.find(char::is_whitespace).unwrap_or(0);
        let name = &trimmed[..name_end];
        if name == "cpu" || name.len() <= 3 || !name[3..].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let vals: Vec<u64> = trimmed[name_end..]
            .split_whitespace()
            .filter_map(|s| s.parse::<u64>().ok())
            .collect();
        if vals.len() < 4 {
            continue;
        }
        let idle = vals[3].saturating_add(vals.get(4).copied().unwrap_or(0));
        let total: u64 = vals.iter().sum();
        out.push(CoreCounter { total, idle });
    }
    out
}

fn parse_netdev(section: &str) -> Vec<NetCounter> {
    let mut out = Vec::new();
    for line in section.lines() {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let name = iface.trim();
        if name.is_empty() || name.contains('|') {
            continue;
        }
        if name == "lo" {
            continue;
        }
        let vals: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse::<u64>().ok())
            .collect();
        if vals.len() < 9 {
            continue;
        }
        out.push(NetCounter {
            name: name.to_string(),
            rx_bytes: vals[0],
            tx_bytes: vals[8],
        });
    }
    out
}

/// 仅保留物理整盘设备：排除 loop/ram/zram/dm/md 及各类分区，避免重复计数。
fn is_physical_whole_disk(name: &str) -> bool {
    for pfx in ["loop", "ram", "zram", "dm-", "md"] {
        if name.starts_with(pfx) {
            return false;
        }
    }
    if let Some(rest) = name.strip_prefix("mmcblk") {
        return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit());
    }
    if let Some(rest) = name.strip_prefix("nvme") {
        let Some(npos) = rest.find('n') else {
            return false;
        };
        let tail = &rest[npos + 1..];
        return !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit());
    }
    for pfx in ["xvd", "sd", "vd", "hd"] {
        if let Some(rest) = name.strip_prefix(pfx) {
            return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphabetic());
        }
    }
    false
}

fn parse_diskstats(section: &str) -> Vec<DiskCounter> {
    let mut out = Vec::new();
    for line in section.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 10 {
            continue;
        }
        let name = parts[2];
        if !is_physical_whole_disk(name) {
            continue;
        }
        let (Ok(read), Ok(write)) = (parts[5].parse::<u64>(), parts[9].parse::<u64>()) else {
            continue;
        };
        out.push(DiskCounter {
            name: name.to_string(),
            read_sectors: read,
            write_sectors: write,
        });
    }
    out
}

fn parse_df(section: &str) -> Vec<StorageUsage> {
    let mut out: Vec<StorageUsage> = Vec::new();
    let mut pending_device: Option<String> = None;
    for line in section.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        let Some(pct_i) = toks.iter().rposition(|t| {
            t.len() > 1 && t.ends_with('%') && t[..t.len() - 1].parse::<u64>().is_ok()
        }) else {
            // busybox df 可能把过长的设备名折到上一行
            if toks.len() == 1 && toks[0].starts_with("/dev/") {
                pending_device = Some(toks[0].to_string());
            }
            continue;
        };
        if pct_i < 3 {
            continue;
        }
        let (Ok(total), Ok(used), Ok(avail)) = (
            toks[pct_i - 3].parse::<u64>(),
            toks[pct_i - 2].parse::<u64>(),
            toks[pct_i - 1].parse::<u64>(),
        ) else {
            continue;
        };
        let dev_toks = &toks[..pct_i - 3];
        let device = if dev_toks.is_empty() {
            match pending_device.take() {
                Some(d) => d,
                None => continue,
            }
        } else {
            dev_toks.join(" ")
        };
        pending_device = None;
        if !device.starts_with("/dev/") {
            continue;
        }
        let mount = toks[pct_i + 1..].join(" ");
        if mount.is_empty() || out.iter().any(|s| s.mount == mount) {
            continue;
        }
        let use_pct = toks[pct_i][..toks[pct_i].len() - 1]
            .parse::<u64>()
            .unwrap_or(0) as f64;
        out.push(StorageUsage {
            device,
            mount,
            fstype: String::new(),
            total_kb: total,
            used_kb: used,
            avail_kb: avail,
            use_pct,
        });
    }
    out
}

fn parse_battery(section: &str) -> Option<BatteryInfo> {
    for line in section.lines() {
        let p: Vec<&str> = line.split('|').collect();
        if p.len() < 7 {
            continue;
        }
        let name = p[0].trim();
        if name.is_empty() || name.contains('*') {
            continue;
        }
        let typ = p[1].trim();
        let capacity = p[2]
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|c| (0.0..=100.0).contains(c));
        let status = p[3].trim().to_string();
        let voltage_v = p[4]
            .trim()
            .parse::<i64>()
            .ok()
            .map(|v| v as f64 / 1_000_000.0);
        let current_ma = p[5]
            .trim()
            .parse::<i64>()
            .ok()
            .map(|c| c as f64 / 1_000.0);
        let temp_c = p[6]
            .trim()
            .parse::<f64>()
            .ok()
            .map(|t| t / 10.0)
            .filter(|t| (-50.0..=150.0).contains(t));
        if !typ.eq_ignore_ascii_case("Battery") && capacity.is_none() {
            continue;
        }
        return Some(BatteryInfo {
            name: name.to_string(),
            status,
            capacity_pct: capacity,
            voltage_v,
            current_ma,
            temp_c,
        });
    }
    None
}

fn round1(val: f64) -> f64 {
    (val * 10.0).round() / 10.0
}

/// 解析 /proc/mounts：返回 (device, mount, fstype)
fn parse_mounts(section: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for line in section.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        // /proc/mounts 中空格转义为 \\040，还原后再匹配
        let mount = parts[1].replace("\\040", " ");
        out.push((parts[0].to_string(), mount, parts[2].to_string()));
    }
    out
}

fn validate_mount_path(mount: &str) -> Result<(), String> {
    const ALLOWED: [&str; 3] = ["/mnt/", "/media/", "/storage/"];
    if !ALLOWED.iter().any(|p| mount.starts_with(p)) {
        return Err(format!(
            "拒绝操作：只允许挂载/卸载 /mnt/、/media/、/storage/ 下的路径（收到: {}）",
            mount
        ));
    }
    if mount.contains("..")
        || !mount
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
    {
        return Err(format!("拒绝操作：挂载路径含非法字符（{}）", mount));
    }
    Ok(())
}

fn validate_device_path(device: &str) -> Result<(), String> {
    if !device.starts_with("/dev/")
        || device.contains("..")
        || !device
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
    {
        return Err(format!("拒绝操作：设备路径非法（{}）", device));
    }
    Ok(())
}

fn rate_kbps(delta_bytes: u64, dt_s: f64) -> f64 {
    if dt_s <= 0.0 {
        0.0
    } else {
        round1(delta_bytes as f64 / dt_s / 1024.0)
    }
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
pub async fn adb_get_metrics(
    serial: String,
    prev_snapshot: Option<CpuSnapshot>,
    include_static: Option<bool>,
    include_storage: Option<bool>,
    include_top: Option<bool>,
) -> Result<DeviceMetrics, String> {
    let want_static = include_static.unwrap_or(true);
    let want_storage = include_storage.unwrap_or(true);
    let want_top = include_top.unwrap_or(true);

    let mut script = String::with_capacity(1024);
    if want_static {
        script.push_str("echo '===KERNEL==='; (read -r k < /proc/sys/kernel/osrelease 2>/dev/null && echo \"$k\") || uname -r 2>/dev/null; ");
    }
    // 使用 shell 内置 read 替代 grep/cat/head 子进程，减少嵌入式端 fork 开销
    script.push_str(
        "echo '===STAT==='; while IFS= read -r l; do case \"$l\" in cpu*) echo \"$l\";; *) break;; esac; done < /proc/stat 2>/dev/null; \
         echo '===MEM==='; while IFS= read -r l; do case \"$l\" in MemTotal:*|MemFree:*|MemAvailable:*|Buffers:*|Cached:*|SReclaimable:*) echo \"$l\";; esac; done < /proc/meminfo 2>/dev/null; \
         echo '===TEMP==='; for f in /sys/class/thermal/thermal_zone*/temp; do [ -r \"$f\" ] && read -r t < \"$f\" 2>/dev/null && echo \"$t\"; done; \
         echo '===LOADAVG==='; read -r l < /proc/loadavg 2>/dev/null && echo \"$l\"; \
         echo '===UPTIME==='; read -r u < /proc/uptime 2>/dev/null && echo \"$u\"; \
         echo '===NETDEV==='; while IFS= read -r l; do echo \"$l\"; done < /proc/net/dev 2>/dev/null; \
         echo '===DISKSTATS==='; while IFS= read -r l; do echo \"$l\"; done < /proc/diskstats 2>/dev/null; ",
    );
    if want_storage {
        script.push_str(
            "echo '===DF==='; (df -kP 2>/dev/null || df -k 2>/dev/null) | head -n 80; \
             echo '===MOUNTS==='; while IFS= read -r l; do echo \"$l\"; done < /proc/mounts 2>/dev/null; \
             echo '===BATT==='; for d in /sys/class/power_supply/*; do [ -d \"$d\" ] || continue; n=${d##*/}; t=''; c=''; s=''; v=''; i=''; m=''; [ -r \"$d/type\" ] && read -r t < \"$d/type\" 2>/dev/null; [ -r \"$d/capacity\" ] && read -r c < \"$d/capacity\" 2>/dev/null; [ -r \"$d/status\" ] && read -r s < \"$d/status\" 2>/dev/null; [ -r \"$d/voltage_now\" ] && read -r v < \"$d/voltage_now\" 2>/dev/null; [ -r \"$d/current_now\" ] && read -r i < \"$d/current_now\" 2>/dev/null; [ -r \"$d/temp\" ] && read -r m < \"$d/temp\" 2>/dev/null; echo \"$n|$t|$c|$s|$v|$i|$m\"; done; ",
        );
    }
    if want_top {
        script.push_str("echo '===TOP==='; (top -bn1 2>/dev/null || ps -A 2>/dev/null || ps 2>/dev/null) | head -n 35");
    }

    const COMPLETE: &str = "===OPENIX_METRICS_DONE===";
    script.push_str("\nprintf '\\n===OPENIX_METRICS_DONE===\\n'");
    let output = adb::monitor_shell(&serial, &script).await?;
    let raw = output.trim_end().strip_suffix(COMPLETE)
        .ok_or_else(|| "ADB shell closed before metrics collection completed".to_string())?;
    let markers = [
        "===KERNEL===",
        "===STAT===",
        "===MEM===",
        "===TEMP===",
        "===LOADAVG===",
        "===UPTIME===",
        "===NETDEV===",
        "===DISKSTATS===",
        "===DF===",
        "===MOUNTS===",
        "===BATT===",
        "===TOP===",
    ];

    let kernel = if want_static {
        extract_section(&raw, "===KERNEL===", &markers[1..]).to_string()
    } else {
        String::new()
    };
    let stat_sec = extract_section(&raw, "===STAT===", &markers[2..]);
    let mem_sec = extract_section(&raw, "===MEM===", &markers[3..]);
    let temp_sec = extract_section(&raw, "===TEMP===", &markers[4..]);
    let load_sec = extract_section(&raw, "===LOADAVG===", &markers[5..]);
    let up_sec = extract_section(&raw, "===UPTIME===", &markers[6..]);
    let net_sec = extract_section(&raw, "===NETDEV===", &markers[7..]);
    let disk_sec = extract_section(&raw, "===DISKSTATS===", &markers[8..]);
    let df_sec = if want_storage {
        extract_section(&raw, "===DF===", &markers[9..])
    } else {
        ""
    };
    let mounts_sec = if want_storage {
        extract_section(&raw, "===MOUNTS===", &markers[10..])
    } else {
        ""
    };
    let batt_sec = if want_storage {
        extract_section(&raw, "===BATT===", &markers[11..])
    } else {
        ""
    };
    let top_output = if want_top {
        extract_section(&raw, "===TOP===", &[]).to_string()
    } else {
        String::new()
    };

    let now_ms = epoch_ms();
    let uptime_s = parse_uptime(up_sec);
    let (load1, load5, load15) = parse_loadavg(load_sec);
    let cores = parse_core_counters(stat_sec);
    let cpu_cores = (cores.len() as u32).max(1);
    let net_counters = parse_netdev(net_sec);
    let disk_counters = parse_diskstats(disk_sec);
    let mut storage = parse_df(df_sec);
    let mounts = parse_mounts(mounts_sec);
    for s in &mut storage {
        if let Some((_, _, ft)) = mounts.iter().find(|(_, m, _)| m.as_str() == s.mount) {
            s.fstype = ft.clone();
        }
    }
    let battery = parse_battery(batt_sec);

    // 距上一采样的间隔；无有效上一采样时退回开机以来平均值
    let dt_s: Option<f64> = prev_snapshot.as_ref().and_then(|p| {
        if p.timestamp_ms > 0 && now_ms > p.timestamp_ms {
            Some((now_ms - p.timestamp_ms) as f64 / 1000.0)
        } else {
            None
        }
    });
    let fallback_dt = if uptime_s > 0.0 { uptime_s } else { 0.0 };

    let snapshot = parse_proc_stat(stat_sec);
    let (cpu_total_pct, cpu_user_pct, cpu_sys_pct, cpu_io_pct) = match prev_snapshot.as_ref() {
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

    let cpu_core_pcts: Vec<f64> = cores
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let prev_c = prev_snapshot.as_ref().and_then(|p| p.cores.get(i));
            match prev_c {
                Some(pc) if c.total > pc.total => {
                    let dt = (c.total - pc.total) as f64;
                    let d_idle = c.idle.saturating_sub(pc.idle) as f64;
                    round_pct((dt - d_idle) / dt * 100.0)
                }
                _ if c.total > 0 => {
                    round_pct((c.total.saturating_sub(c.idle) as f64) / c.total as f64 * 100.0)
                }
                _ => 0.0,
            }
        })
        .collect();

    let mut net_ifaces = Vec::new();
    let mut net_rx_sum = 0.0f64;
    let mut net_tx_sum = 0.0f64;
    for c in &net_counters {
        let prev_c = prev_snapshot
            .as_ref()
            .and_then(|p| p.net.iter().find(|n| n.name == c.name));
        let (rx, tx) = match (prev_c, dt_s) {
            (Some(pc), Some(dt)) => (
                rate_kbps(c.rx_bytes.saturating_sub(pc.rx_bytes), dt),
                rate_kbps(c.tx_bytes.saturating_sub(pc.tx_bytes), dt),
            ),
            _ => (
                rate_kbps(c.rx_bytes, fallback_dt),
                rate_kbps(c.tx_bytes, fallback_dt),
            ),
        };
        net_rx_sum += rx;
        net_tx_sum += tx;
        net_ifaces.push(NetIfaceRate {
            name: c.name.clone(),
            rx_kbps: rx,
            tx_kbps: tx,
        });
    }

    let mut disk_devices = Vec::new();
    let mut disk_read_sum = 0.0f64;
    let mut disk_write_sum = 0.0f64;
    for c in &disk_counters {
        let prev_c = prev_snapshot
            .as_ref()
            .and_then(|p| p.disk.iter().find(|d| d.name == c.name));
        let (r, w) = match (prev_c, dt_s) {
            (Some(pc), Some(dt)) => (
                rate_kbps(c.read_sectors.saturating_sub(pc.read_sectors) * 512, dt),
                rate_kbps(c.write_sectors.saturating_sub(pc.write_sectors) * 512, dt),
            ),
            _ => (
                rate_kbps(c.read_sectors * 512, fallback_dt),
                rate_kbps(c.write_sectors * 512, fallback_dt),
            ),
        };
        disk_read_sum += r;
        disk_write_sum += w;
        disk_devices.push(DiskRate {
            name: c.name.clone(),
            read_kbps: r,
            write_kbps: w,
        });
    }

    let mut snapshot = snapshot;
    snapshot.cores = cores;
    snapshot.net = net_counters;
    snapshot.disk = disk_counters;
    snapshot.timestamp_ms = now_ms;

    Ok(DeviceMetrics {
        kernel,
        cpu_cores,
        cpu_total_pct,
        cpu_user_pct,
        cpu_sys_pct,
        cpu_io_pct,
        cpu_core_pcts,
        mem_total_kb,
        mem_used_kb,
        mem_cached_kb,
        mem_buffers_kb,
        temp_celsius,
        load1,
        load5,
        load15,
        uptime_s,
        net_ifaces,
        net_rx_kbps: round1(net_rx_sum),
        net_tx_kbps: round1(net_tx_sum),
        disk_devices,
        disk_read_kbps: round1(disk_read_sum),
        disk_write_kbps: round1(disk_write_sum),
        storage,
        battery,
        top_output,
        snapshot,
        timestamp_ms: now_ms,
    })
}

/// 挂载/卸载存储。两端（Android toybox / Tina busybox）都有 mount/umount，
/// 同一条代码路径；只允许 /mnt/、/media/、/storage/ 下的路径。
#[tauri::command]
pub fn adb_storage_mount(
    serial: String,
    device: String,
    mount: String,
    fstype: String,
    mount_it: bool,
) -> Result<String, String> {
    validate_mount_path(&mount)?;
    let out = if mount_it {
        validate_device_path(&device)?;
        if !fstype.is_empty() && !fstype.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("拒绝操作：文件系统类型非法（{}）", fstype));
        }
        let cmd = if fstype.is_empty() {
            format!("mount '{}' '{}' 2>&1; echo __rc=$?", device, mount)
        } else {
            format!(
                "mount -t '{}' '{}' '{}' 2>&1; echo __rc=$?",
                fstype, device, mount
            )
        };
        adb::adb_exec_shell(serial, cmd)?
    } else {
        let cmd = format!("umount '{}' 2>&1; echo __rc=$?", mount);
        adb::adb_exec_shell(serial, cmd)?
    };
    let rc_ok = out.lines().any(|l| l.trim() == "__rc=0");
    let clean = out
        .lines()
        .filter(|l| !l.trim().starts_with("__rc="))
        .collect::<Vec<_>>()
        .join("\n");
    if rc_ok {
        Ok(clean.trim().to_string())
    } else {
        Err(if clean.trim().is_empty() {
            "操作失败，设备未返回错误信息".to_string()
        } else {
            clean.trim().to_string()
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const STAT_SAMPLE: &str = "cpu  412 0 825 1021 91 0 2 0 0 0\ncpu0 344 0 588 185 50 0 2 0 0 0\ncpu1 68 0 236 835 41 0 0 0 0 0\n";

    #[test]
    fn test_parse_proc_stat_aggregate_only() {
        let s = parse_proc_stat(STAT_SAMPLE);
        assert_eq!(s.total, 412 + 0 + 825 + 1021 + 91 + 0 + 2);
        assert_eq!(s.idle, 1021 + 91);
    }

    #[test]
    fn test_parse_core_counters() {
        let cores = parse_core_counters(STAT_SAMPLE);
        assert_eq!(cores.len(), 2);
        assert!(cores[0].total > 0);
        assert!(cores[1].idle > 0);
    }

    #[test]
    fn test_parse_loadavg() {
        let (a, b, c) = parse_loadavg("0.39 0.08 0.03 2/94 478\n");
        assert!((a - 0.39).abs() < 1e-9);
        assert!((b - 0.08).abs() < 1e-9);
        assert!((c - 0.03).abs() < 1e-9);
        assert_eq!(parse_loadavg(""), (0.0, 0.0, 0.0));
    }

    #[test]
    fn test_parse_uptime() {
        assert!((parse_uptime("12.06 10.21\n") - 12.06).abs() < 1e-9);
        assert_eq!(parse_uptime(""), 0.0);
    }

    #[test]
    fn test_parse_netdev_skips_loopback_and_headers() {
        let raw = "Inter-|   Receive\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n wlan0:    1024      10    0    0    0     0          0         0     2048      20    0    0    0     0       0          0\n";
        let nets = parse_netdev(raw);
        assert_eq!(nets.len(), 1);
        assert_eq!(nets[0].name, "wlan0");
        assert_eq!(nets[0].rx_bytes, 1024);
        assert_eq!(nets[0].tx_bytes, 2048);
    }

    #[test]
    fn test_is_physical_whole_disk() {
        assert!(is_physical_whole_disk("mmcblk0"));
        assert!(is_physical_whole_disk("sda"));
        assert!(is_physical_whole_disk("nvme0n1"));
        assert!(!is_physical_whole_disk("mmcblk0p12"));
        assert!(!is_physical_whole_disk("sda1"));
        assert!(!is_physical_whole_disk("loop0"));
        assert!(!is_physical_whole_disk("dm-0"));
        assert!(!is_physical_whole_disk("zram0"));
        assert!(!is_physical_whole_disk("ram0"));
    }

    #[test]
    fn test_parse_diskstats() {
        let raw = "   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n 179       0 mmcblk0 100 0 200 0 50 0 400 0 0 0 0 0 0 0 0 0\n 179      12 mmcblk0p12 10 0 20 0 5 0 40 0 0 0 0 0 0 0 0 0\n   8       0 sda 7 0 14 0 3 0 28 0 0 0 0 0 0 0 0 0\n";
        let disks = parse_diskstats(raw);
        let names: Vec<&str> = disks.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["mmcblk0", "sda"]);
        let mmc = disks.iter().find(|d| d.name == "mmcblk0").unwrap();
        assert_eq!(mmc.read_sectors, 200);
        assert_eq!(mmc.write_sectors, 400);
    }

    #[test]
    fn test_parse_df_single_line() {
        let raw = "Filesystem           1024-blocks    Used Available Capacity Mounted on\n/dev/root                13568     13568         0 100% /\n/dev/mmcblk0p12        7304004     35992   7251628   0% /mnt/UDISK\n";
        let st = parse_df(raw);
        assert_eq!(st.len(), 2);
        assert_eq!(st[0].mount, "/");
        assert_eq!(st[0].used_kb, 13568);
        assert_eq!(st[0].use_pct, 100.0);
        assert_eq!(st[1].device, "/dev/mmcblk0p12");
        assert_eq!(st[1].mount, "/mnt/UDISK");
    }

    #[test]
    fn test_parse_df_wrapped_device_name() {
        // busybox df 对过长设备名折行：设备名单独一行，数值在下一行
        let raw = "/dev/by-name/rootfs_data\n                          3892       190      3600   5% /etc\n";
        let st = parse_df(raw);
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].device, "/dev/by-name/rootfs_data");
        assert_eq!(st[0].mount, "/etc");
        assert_eq!(st[0].total_kb, 3892);
    }

    #[test]
    fn test_parse_df_skips_pseudo_fs() {
        let raw = "tmpfs                  18184         4     18180   0% /tmp\nproc                       0         0         0   -% /proc\n/dev/mmcblk1p1        60988864  18419520  42569344  30% /mnt/SDCARD\n";
        let st = parse_df(raw);
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].mount, "/mnt/SDCARD");
    }

    #[test]
    fn test_parse_battery() {
        let raw = "usb|USB|||||\nbattery|Battery|85|Charging|4200000|-350000|320\n";
        let b = parse_battery(raw).expect("battery should parse");
        assert_eq!(b.name, "battery");
        assert_eq!(b.capacity_pct, Some(85.0));
        assert_eq!(b.status, "Charging");
        assert_eq!(b.voltage_v, Some(4.2));
        assert_eq!(b.current_ma, Some(-350.0));
        assert_eq!(b.temp_c, Some(32.0));
        assert!(parse_battery("").is_none());
        assert!(parse_battery("usb|USB|||||\n").is_none());
    }

    #[test]
    fn test_rate_kbps() {
        assert_eq!(rate_kbps(2048, 1.0), 2.0);
        assert_eq!(rate_kbps(2048, 0.0), 0.0);
        assert_eq!(rate_kbps(0, 2.0), 0.0);
    }

    #[test]
    fn test_extract_sections_roundtrip() {
        // 模拟完整脚本输出的分段顺序
        let raw = "===KERNEL===\n6.6.0\n===NPROC===\n2\n===STAT===\n";
        raw.to_string();
        let raw = format!(
            "===KERNEL===\n6.6.0\n===NPROC===\n2\n===STAT===\n{}\n===MEM===\nMemTotal: 100 kB\n===TEMP===\n45000\n===LOADAVG===\n0.39 0.08 0.03 2/94 478\n===UPTIME===\n12.06 10.21\n===NETDEV===\nwlan0: 1024 0 0 0 0 0 0 0 2048 0 0 0 0 0 0 0\n===DISKSTATS===\n===DF===\n===BATT===\n===TOP===\ntop output\n",
            STAT_SAMPLE.trim_end()
        );
        let markers = [
            "===KERNEL===",
            "===NPROC===",
            "===STAT===",
            "===MEM===",
            "===TEMP===",
            "===LOADAVG===",
            "===UPTIME===",
            "===NETDEV===",
            "===DISKSTATS===",
            "===DF===",
            "===BATT===",
            "===TOP===",
        ];
        let load_sec = extract_section(&raw, "===LOADAVG===", &markers[6..]);
        let (a, _, _) = parse_loadavg(load_sec);
        assert!((a - 0.39).abs() < 1e-9);
        let top = extract_section(&raw, "===TOP===", &[]);
        assert_eq!(top, "top output");
    }
}

#[cfg(test)]
mod dryrun_tests {
    use super::*;

    // 用本机 sh 干跑采集脚本的真实输出做端到端分段+解析验证（不连接任何设备）
    #[test]
    fn test_parse_real_dryrun_output() {
        let Ok(raw) = std::fs::read_to_string("/tmp/metrics_dryrun.txt") else {
            return; // 文件不存在时跳过
        };
        let markers = [
            "===KERNEL===",
            "===NPROC===",
            "===STAT===",
            "===MEM===",
            "===TEMP===",
            "===LOADAVG===",
            "===UPTIME===",
            "===NETDEV===",
            "===DISKSTATS===",
            "===DF===",
            "===BATT===",
            "===TOP===",
        ];
        let stat_sec = extract_section(&raw, "===STAT===", &markers[3..]);
        let load_sec = extract_section(&raw, "===LOADAVG===", &markers[6..]);
        let up_sec = extract_section(&raw, "===UPTIME===", &markers[7..]);
        let net_sec = extract_section(&raw, "===NETDEV===", &markers[8..]);
        let disk_sec = extract_section(&raw, "===DISKSTATS===", &markers[9..]);
        let df_sec = extract_section(&raw, "===DF===", &markers[10..]);
        let batt_sec = extract_section(&raw, "===BATT===", &markers[11..]);

        let snap = parse_proc_stat(stat_sec);
        assert!(snap.total > 0, "aggregate cpu counters should parse");
        let cores = parse_core_counters(stat_sec);
        assert!(!cores.is_empty(), "per-core counters should parse");

        let (l1, _, _) = parse_loadavg(load_sec);
        assert!(l1 >= 0.0);
        assert!(parse_uptime(up_sec) > 0.0);

        let nets = parse_netdev(net_sec);
        assert!(!nets.is_empty(), "should find non-lo interfaces");
        assert!(nets.iter().all(|n| n.name != "lo"));

        let disks = parse_diskstats(disk_sec);
        assert!(!disks.is_empty(), "should find whole-disk devices");
        assert!(disks.iter().all(|d| is_physical_whole_disk(&d.name)));

        let storage = parse_df(df_sec);
        assert!(!storage.is_empty(), "should find /dev/ mounts");
        assert!(storage.iter().all(|s| s.device.starts_with("/dev/")));
        // 中文本地化 df 输出同样应解析出百分比
        assert!(storage.iter().all(|s| (0.0..=100.0).contains(&s.use_pct)));

        let _ = parse_battery(batt_sec); // 本机可能无电池，None 合法
    }
}

#[cfg(test)]
mod mount_tests {
    use super::*;

    #[test]
    fn test_parse_mounts() {
        let raw = "/dev/root / squashfs ro,relatime 0 0\n/dev/mmcblk0p12 /mnt/UDISK ext4 rw,relatime 0 0\n/dev/mmcblk1p1 /mnt/SDCARD vfat rw,noatime,fmask=0077 0 0\nproc /proc proc rw,relatime 0 0\n/dev/mapper/a\\040b /mnt/media/x ext4 rw 0 0\n";
        let m = parse_mounts(raw);
        assert_eq!(m.len(), 5);
        assert_eq!(m[1], ("/dev/mmcblk0p12".to_string(), "/mnt/UDISK".to_string(), "ext4".to_string()));
        assert_eq!(m[4].1, "/mnt/media/x"); // \040 还原为空格
    }

    #[test]
    fn test_validate_mount_path() {
        assert!(validate_mount_path("/mnt/SDCARD").is_ok());
        assert!(validate_mount_path("/mnt/UDISK").is_ok());
        assert!(validate_mount_path("/storage/emulated/0").is_ok());
        // 系统挂载点拒绝
        assert!(validate_mount_path("/").is_err());
        assert!(validate_mount_path("/etc").is_err());
        assert!(validate_mount_path("/proc").is_err());
        assert!(validate_mount_path("/sys").is_err());
        // 路径穿越与注入拒绝
        assert!(validate_mount_path("/mnt/../etc").is_err());
        assert!(validate_mount_path("/mnt/a;rm -rf /").is_err());
        assert!(validate_mount_path("/mnt/$(reboot)").is_err());
        assert!(validate_mount_path("/mnt/a b").is_err());
    }

    #[test]
    fn test_validate_device_path() {
        assert!(validate_device_path("/dev/mmcblk1p1").is_ok());
        assert!(validate_device_path("/dev/block/sda1").is_ok());
        assert!(validate_device_path("/etc/passwd").is_err());
        assert!(validate_device_path("/dev/../etc").is_err());
        assert!(validate_device_path("/dev/sda1;reboot").is_err());
        assert!(validate_device_path("mmcblk1p1").is_err());
    }
}
