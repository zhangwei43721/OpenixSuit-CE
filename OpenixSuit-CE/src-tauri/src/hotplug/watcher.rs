use rusb::{Context, Device, Hotplug, HotplugBuilder, UsbContext};
use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const ALLWINNER_VID: u16 = 0x1f3a;
const ALLWINNER_PID: u16 = 0xefe8;

#[derive(Clone, Serialize)]
pub struct UsbHotplugPayload {
    pub connected: bool,
    pub count: usize,
    pub devices: Vec<String>,
}

struct SunxiHotplugHandler {
    app: AppHandle,
}

impl<T: UsbContext> Hotplug<T> for SunxiHotplugHandler {
    fn device_arrived(&mut self, _device: Device<T>) {
        emit_current_devices(&self.app);
    }

    fn device_left(&mut self, _device: Device<T>) {
        emit_current_devices(&self.app);
    }
}

pub fn scan_sunxi_devices() -> Vec<String> {
    let mut list = Vec::new();
    if let Ok(devices) = rusb::devices() {
        for dev in devices.iter() {
            if let Ok(desc) = dev.device_descriptor() {
                if desc.vendor_id() == ALLWINNER_VID && desc.product_id() == ALLWINNER_PID {
                    list.push(format!("bus:{}-addr:{}", dev.bus_number(), dev.address()));
                }
            }
        }
    }
    list
}

fn emit_current_devices(app: &AppHandle) {
    let devices = scan_sunxi_devices();
    let _ = app.emit(
        "usb-hotplug",
        UsbHotplugPayload {
            connected: !devices.is_empty(),
            count: devices.len(),
            devices,
        },
    );
}

pub fn start_hotplug_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        if rusb::has_hotplug() {
            if let Ok(ctx) = Context::new() {
                let _reg: rusb::Result<rusb::Registration<Context>> = HotplugBuilder::new()
                    .vendor_id(ALLWINNER_VID)
                    .product_id(ALLWINNER_PID)
                    .enumerate(true)
                    .register(&ctx, Box::new(SunxiHotplugHandler { app: app.clone() }));
                loop {
                    let _ = ctx.handle_events(Some(Duration::from_millis(200)));
                }
            }
        }

        // Fallback: 200ms polling comparison
        let mut last_set: HashSet<String> = HashSet::new();
        loop {
            let current = scan_sunxi_devices();
            let current_set: HashSet<String> = current.iter().cloned().collect();
            if current_set != last_set {
                last_set = current_set;
                let _ = app.emit(
                    "usb-hotplug",
                    UsbHotplugPayload {
                        connected: !current.is_empty(),
                        count: current.len(),
                        devices: current,
                    },
                );
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}
