use crate::adb::AdbTermHandle;
use crate::adb_log::AdbLogHandle;
use crate::log_capture::LogCapturePolicy;
use crate::log_ui::LogUiBroker;
use crate::serial::bridge::SerialBridgeState;
use crate::serial::SerialSessionHandle;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UsbBackend {
    Auto,
    Winusb,
    Libusb,
}

impl Default for UsbBackend {
    fn default() -> Self {
        Self::Auto
    }
}

pub struct AppState {
    pub usb_backend: Mutex<UsbBackend>,
    pub cancel_flash_flag: Arc<AtomicBool>,
    pub busy_op: Arc<Mutex<Option<String>>>,
    pub serial_sessions: Arc<Mutex<HashMap<String, Arc<SerialSessionHandle>>>>,
    pub(crate) serial_bridge: SerialBridgeState,
    pub(crate) serial_bridge_operation: Mutex<()>,
    pub adb_term_sessions: Arc<Mutex<HashMap<String, Arc<AdbTermHandle>>>>,
    pub adb_log_sessions: Arc<Mutex<HashMap<String, AdbLogHandle>>>,
    pub(crate) log_capture: LogCapturePolicy,
    pub(crate) log_ui: LogUiBroker,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            usb_backend: Mutex::new(UsbBackend::Auto),
            cancel_flash_flag: Arc::new(AtomicBool::new(false)),
            busy_op: Arc::new(Mutex::new(None)),
            serial_sessions: Arc::new(Mutex::new(HashMap::new())),
            serial_bridge: SerialBridgeState::default(),
            serial_bridge_operation: Mutex::new(()),
            adb_term_sessions: Arc::new(Mutex::new(HashMap::new())),
            adb_log_sessions: Arc::new(Mutex::new(HashMap::new())),
            log_capture: LogCapturePolicy::load(),
            log_ui: LogUiBroker::default(),
        }
    }
}

/// RAII guard for exclusive device/flash/EFEL operation locking.
pub struct BusyGuard {
    lock: Arc<Mutex<Option<String>>>,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.lock.lock() {
            *guard = None;
        }
    }
}

impl AppState {
    /// Try acquiring the exclusive device/operation lock.
    pub fn try_acquire_busy(&self, operation: &str) -> Result<BusyGuard, String> {
        let mut guard = self
            .busy_op
            .lock()
            .map_err(|_| "Busy lock poisoned".to_string())?;
        if let Some(ref current) = *guard {
            return Err(format!("Device busy: {}", current));
        }
        *guard = Some(operation.to_string());
        Ok(BusyGuard {
            lock: Arc::clone(&self.busy_op),
        })
    }

    pub fn current_busy(&self) -> Option<String> {
        self.busy_op.lock().ok().and_then(|g| g.clone())
    }
}

#[derive(Clone, Serialize)]
pub struct AiSyncEventPayload {
    pub source: String,
    pub action: String,
    pub status: String,
    pub message: String,
}

pub fn emit_ai_sync(
    app: &AppHandle,
    source: &str,
    action: &str,
    status: &str,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "ai-sync-event",
        AiSyncEventPayload {
            source: source.to_string(),
            action: action.to_string(),
            status: status.to_string(),
            message: message.into(),
        },
    );
}

/// Base directory for OpenixSuit-CE persisted data (~/.openixsuit-ce).
pub fn app_data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(home.join(".openixsuit-ce"))
}

pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn epoch_secs() -> u64 {
    epoch_ms() / 1000
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m as u32, d as u32)
}

fn utc_parts(secs: u64) -> (i64, u32, u32, u64, u64, u64) {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (year, month, day) = civil_from_days(days);
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    (year, month, day, hour, min, sec)
}

pub fn format_utc_timestamp(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let (y, m, d, hh, mm, ss) = utc_parts(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hh, mm, ss, millis
    )
}

pub fn format_compact_utc(secs: u64) -> String {
    let (y, m, d, hh, mm, ss) = utc_parts(secs);
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", y, m, d, hh, mm, ss)
}

pub fn load_json_or_default<T>(path: &PathBuf) -> Result<T, String>
where
    T: Default + for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn save_json_pretty<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
