use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

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
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            usb_backend: Mutex::new(UsbBackend::Auto),
            cancel_flash_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}
