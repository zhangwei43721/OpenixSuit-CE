use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
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
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            usb_backend: Mutex::new(UsbBackend::Auto),
            cancel_flash_flag: Arc::new(AtomicBool::new(false)),
            busy_op: Arc::new(Mutex::new(None)),
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
