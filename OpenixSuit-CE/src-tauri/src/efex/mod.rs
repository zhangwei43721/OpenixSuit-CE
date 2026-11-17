pub mod ffi;
pub mod flasher;

use crate::hotplug::watcher::scan_sunxi_devices;
use crate::state::{emit_ai_sync, AppState, UsbBackend};
use flasher::{
    execute_flash_sync, prepare_raw_flash_request, scan_efex_devices, EfexSession, FlashMode,
    FlashRequest, PostAction, RawMode, RawStorage,
};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub chip: String,
    pub mode: String,
    pub backend: String,
}

#[derive(Clone, Serialize)]
pub struct FlashProgressPayload {
    pub partition: String,
    pub written: u64,
    pub total: u64,
    pub percent: f64,
}

#[derive(Clone, Serialize)]
pub struct FlashLogPayload {
    pub stage: String,
    pub level: String,
    pub message: String,
}

#[tauri::command]
pub fn scan_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, String> {
    let backend = state.usb_backend.lock().map_err(|e| e.to_string())?.clone();
    let is_busy = state.current_busy().is_some();
    Ok(scan_devices_with_probe(&backend, !is_busy))
}

pub fn scan_devices_with_backend(backend: &UsbBackend) -> Vec<DeviceInfo> {
    scan_devices_with_probe(backend, false)
}

fn scan_devices_with_probe(backend: &UsbBackend, probe_details: bool) -> Vec<DeviceInfo> {
    let backend_name = format!("{:?}", backend);
    let libefex_devs = scan_efex_devices();
    if !libefex_devs.is_empty() {
        return libefex_devs
            .into_iter()
            .map(|d| {
                let id = format!("bus:{}-port:{}", d.bus, d.port);
                if probe_details {
                    if let Ok(session) = EfexSession::open_at(Some(d.bus), Some(d.port)) {
                        let chip_id = session.ctx.resp.id;
                        let mode_str = unsafe {
                            let ptr = ffi::sunxi_efex_get_device_mode_str(&session.ctx);
                            if ptr.is_null() {
                                "Sunxi SoC".to_string()
                            } else {
                                CStr::from_ptr(ptr).to_string_lossy().to_string()
                            }
                        };
                        let mode_label = match session.device_mode() {
                            x if x == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_FEL => {
                                "FEL (USB Boot)"
                            }
                            x if x == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_SRV => {
                                "FES (U-Boot)"
                            }
                            _ => "FEL/FES",
                        };
                        return DeviceInfo {
                            id,
                            chip: format!("{} (0x{:08x})", mode_str, chip_id),
                            mode: mode_label.into(),
                            backend: backend_name.clone(),
                        };
                    }
                }
                DeviceInfo {
                    id,
                    chip: "Sunxi SoC (0x1f3a:0xefe8)".into(),
                    mode: "FEL/FES".into(),
                    backend: backend_name.clone(),
                }
            })
            .collect();
    }
    scan_sunxi_devices()
        .into_iter()
        .map(|id| DeviceInfo {
            id,
            chip: "Sunxi SoC (0x1f3a:0xefe8)".into(),
            mode: "FEL/FES".into(),
            backend: backend_name.clone(),
        })
        .collect()
}

#[tauri::command]
pub fn set_usb_backend(backend: UsbBackend, state: State<'_, AppState>) -> Result<(), String> {
    let c_backend = match backend {
        UsbBackend::Auto => ffi::usb_backend_type_USB_BACKEND_AUTO,
        UsbBackend::Libusb => ffi::usb_backend_type_USB_BACKEND_LIBUSB,
        UsbBackend::Winusb => ffi::usb_backend_type_USB_BACKEND_WINUSB,
    };
    let rc = unsafe { ffi::sunxi_efex_set_usb_backend(c_backend) };
    if rc < 0 && backend != UsbBackend::Winusb {
        return Err(format!("设置 USB 后端失败 (code {})", rc));
    }
    let mut guard = state.usb_backend.lock().map_err(|e| e.to_string())?;
    *guard = backend;
    Ok(())
}

fn require_fel_mode(session: &EfexSession) -> Result<(), String> {
    let mode = session.device_mode();
    if mode == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_FEL {
        return Ok(());
    }
    let mode_label = match mode {
        x if x == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_SRV => "FES (U-Boot / DEVICE_MODE_SRV)",
        x if x == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_UPDATE_COOL => "UPDATE_COOL",
        x if x == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_UPDATE_HOT => "UPDATE_HOT",
        _ => "非 FEL 模式",
    };
    Err(format!(
        "当前设备处于 {}，不支持 FEL 内存读写与反汇编（仅固件刷写可用）。请按住板卡 FEL 键重新上电或复位进入 BROM FEL 模式后再调试。",
        mode_label
    ))
}

pub fn efel_read_sync(address: u32, length: usize) -> Result<Vec<u8>, String> {
    if length == 0 || length > 1024 * 1024 {
        return Err("读取长度必须在 1B ~ 1MB 之间".into());
    }
    let session = EfexSession::open_at(None, None)?;
    require_fel_mode(&session)?;
    let mut buf = vec![0u8; length];
    session.fel_read(address, &mut buf)?;
    Ok(buf)
}

pub fn efel_write_sync(address: u32, data: Vec<u8>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let session = EfexSession::open_at(None, None)?;
    require_fel_mode(&session)?;
    session.fel_write(address, &data)
}

pub fn efel_exec_sync(address: u32) -> Result<(), String> {
    let session = EfexSession::open_at(None, None)?;
    require_fel_mode(&session)?;
    session.fel_exec(address)
}

#[tauri::command]
pub fn fel_read_mem(
    state: State<'_, AppState>,
    address: u32,
    length: usize,
) -> Result<Vec<u8>, String> {
    let _busy = state.try_acquire_busy("fel_read_mem")?;
    efel_read_sync(address, length)
}

#[tauri::command]
pub fn fel_write_mem(
    state: State<'_, AppState>,
    address: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let _busy = state.try_acquire_busy("fel_write_mem")?;
    efel_write_sync(address, data)
}

#[tauri::command]
pub fn fel_write_file(
    state: State<'_, AppState>,
    address: u32,
    file_path: String,
) -> Result<usize, String> {
    let _busy = state.try_acquire_busy("fel_write_file")?;
    let data = std::fs::read(&file_path).map_err(|e| format!("读取文件失败: {}", e))?;
    let len = data.len();
    efel_write_sync(address, data)?;
    Ok(len)
}

#[tauri::command]
pub fn fel_exec(state: State<'_, AppState>, address: u32) -> Result<(), String> {
    let _busy = state.try_acquire_busy("fel_exec")?;
    efel_exec_sync(address)
}

#[tauri::command]
pub fn fel_init_dram(state: State<'_, AppState>, file_path: String) -> Result<Vec<String>, String> {
    let _busy = state.try_acquire_busy("fel_init_dram")?;
    let data = std::fs::read(&file_path).map_err(|e| format!("读取初始化镜像失败: {}", e))?;
    if data.len() < 96 {
        return Err("镜像文件过小，无法解析 DRAM 参数".into());
    }
    let session = EfexSession::open_at(None, None)?;
    require_fel_mode(&session)?;
    let load_addr: u32 = 0x00020000;
    session.fel_write(load_addr, &data)?;
    session.fel_exec(load_addr)?;
    let mut logs = Vec::new();
    for i in 0..8 {
        let off = 0x38 + i * 4;
        if off + 4 <= data.len() {
            let val = u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]);
            logs.push(format!("Param[{}]: 0x{:08x}", i, val));
        }
    }
    logs.push("Initialization complete".into());
    Ok(logs)
}

#[tauri::command]
pub fn fes_query_storage(state: State<'_, AppState>) -> Result<String, String> {
    let _busy = state.try_acquire_busy("fes_query_storage")?;
    let session = EfexSession::open_at(None, None)?;
    let storage_type = session.fes_query_storage()?;
    let name = match storage_type {
        0 => "NAND",
        1 => "SDCard",
        2 => "eMMC",
        3 => "SPI NOR",
        4 => "SPI NAND",
        5 => "UFS",
        _ => "Unknown",
    };
    Ok(format!("{} (type={})", name, storage_type))
}

#[tauri::command]
pub fn fes_tool_mode(state: State<'_, AppState>, action: String) -> Result<(), String> {
    let _busy = state.try_acquire_busy("fes_tool_mode")?;
    let session = EfexSession::open_at(None, None)?;
    let mode = match action.as_str() {
        "reboot" => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_REBOOT,
        "poweroff" | "shutdown" => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_POWEROFF,
        _ => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_NORMAL,
    };
    session.fes_tool_mode(mode, ffi::sunxi_fes_tool_mode_t_TOOL_MODE_NORMAL)
}

#[tauri::command]
pub fn cancel_flash(state: State<'_, AppState>) {
    state.cancel_flash_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn fes_download_partition(
    app: AppHandle,
    state: State<'_, AppState>,
    partition: String,
    file_path: String,
    verify: Option<bool>,
) -> Result<(), String> {
    let _busy = state.try_acquire_busy("fes_download_partition")?;
    state.cancel_flash_flag.store(false, Ordering::Relaxed);
    let cancel_flag = state.cancel_flash_flag.clone();

    tokio::task::spawn_blocking(move || {
        let mut file = File::open(&file_path).map_err(|e| format!("打开文件失败: {}", e))?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();
        let session = EfexSession::open_at(None, None)?;

        let mut buf = vec![0u8; 65536];
        let mut written: u64 = 0;
        let mut sector_addr: u32 = 0;
        let mut hasher = crc32fast::Hasher::new();

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("刷写已由用户取消".into());
            }
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            let rc = unsafe {
                ffi::sunxi_efex_fes_down(
                    &session.ctx,
                    buf.as_ptr() as *const c_char,
                    n as isize,
                    sector_addr,
                    0,
                )
            };
            if rc < 0 {
                return Err(format!("FES 分区写入失败 (code {})", rc));
            }

            written += n as u64;
            sector_addr = sector_addr.saturating_add((n / 512) as u32);

            let percent = if total > 0 {
                (written as f64 / total as f64) * 100.0
            } else {
                100.0
            };
            let _ = app.emit(
                "flash-progress",
                FlashProgressPayload {
                    partition: partition.clone(),
                    written,
                    total,
                    percent,
                },
            );
        }

        if verify.unwrap_or(false) {
            let mut status: ffi::sunxi_fes_verify_resp_t = unsafe { std::mem::zeroed() };
            let _crc = hasher.finalize();
            let rc = unsafe {
                ffi::sunxi_efex_fes_verify_value(&session.ctx, 0, written, &mut status)
            };
            if rc < 0 {
                return Err(format!("分区 {} 写入校验失败 (code {})", partition, rc));
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("刷写任务异常: {}", e))?
}

pub(crate) async fn run_flash_firmware_full_unlocked(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    firmware_path: String,
    mode: String,
    partitions: Vec<String>,
    verify: bool,
    post_action: String,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<(), String> {
    let flash_mode: FlashMode = mode.parse()?;
    let action: PostAction = post_action.parse()?;
    let selected_partitions = if partitions.is_empty() {
        None
    } else {
        Some(partitions)
    };
    let request = FlashRequest {
        bus,
        port,
        verify,
        mode: flash_mode,
        partitions: selected_partitions,
        post_action: action,
        custom_layout: None,
        custom_mbr_override: None,
        custom_download_files: None,
    };

    emit_ai_sync(
        app,
        source,
        "flash",
        "started",
        format!("Flashing {} (mode={})", firmware_path, mode),
    );

    let app_clone = app.clone();
    let cancel_flag = state.cancel_flash_flag.clone();
    let fw_path = PathBuf::from(&firmware_path);

    let result = tokio::task::spawn_blocking(move || {
        execute_flash_sync(&app_clone, &fw_path, request, &cancel_flag)
    })
    .await
    .map_err(|e| format!("刷写任务异常: {}", e))?;

    match &result {
        Ok(()) => emit_ai_sync(
            app,
            source,
            "flash",
            "completed",
            format!("Flash completed: {}", firmware_path),
        ),
        Err(err) => emit_ai_sync(app, source, "flash", "error", err.clone()),
    }
    result
}

pub async fn run_flash_firmware_full(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    firmware_path: String,
    mode: String,
    partitions: Vec<String>,
    verify: bool,
    post_action: String,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<(), String> {
    let _busy = state.try_acquire_busy("flash")?;
    run_flash_firmware_full_unlocked(
        app,
        state,
        source,
        firmware_path,
        mode,
        partitions,
        verify,
        post_action,
        bus,
        port,
    )
    .await
}

#[tauri::command]
pub async fn flash_firmware_full(
    app: AppHandle,
    state: State<'_, AppState>,
    firmware_path: String,
    mode: String,
    partitions: Vec<String>,
    verify: bool,
    post_action: String,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<(), String> {
    run_flash_firmware_full(
        &app,
        &state,
        "gui",
        firmware_path,
        mode,
        partitions,
        verify,
        post_action,
        bus,
        port,
    )
    .await
}

#[tauri::command]
pub async fn flash_custom_mbr_layout(
    app: AppHandle,
    state: State<'_, AppState>,
    firmware_path: String,
    partitions: Vec<crate::packer::PartitionEntry>,
    include_copies: bool,
    verify: bool,
    post_action: String,
) -> Result<(), String> {
    let _busy = state.try_acquire_busy("flash")?;
    let mbr_bytes = crate::packer::build_mbr_binary(&partitions, include_copies)?;
    let action: PostAction = post_action.parse()?;
    let mut dl_map = HashMap::new();
    let mut selected = Vec::new();
    for part in &partitions {
        let dl = part.download_file.trim();
        if !dl.is_empty() && dl != "-" {
            dl_map.insert(part.name.clone(), dl.to_string());
            selected.push(part.name.clone());
        }
    }
    let request = FlashRequest {
        bus: None,
        port: None,
        verify,
        mode: FlashMode::PartitionErase,
        partitions: if selected.is_empty() {
            None
        } else {
            Some(selected)
        },
        post_action: action,
        custom_layout: None,
        custom_mbr_override: Some(mbr_bytes),
        custom_download_files: Some(dl_map),
    };

    emit_ai_sync(
        &app,
        "gui",
        "flash",
        "started",
        format!("Flashing custom MBR layout from {}", firmware_path),
    );
    let app_clone = app.clone();
    let cancel_flag = state.cancel_flash_flag.clone();
    let fw_path = PathBuf::from(&firmware_path);
    let result = tokio::task::spawn_blocking(move || {
        execute_flash_sync(&app_clone, &fw_path, request, &cancel_flag)
    })
    .await
    .map_err(|e| format!("扇区刷写任务异常: {}", e))?;

    match &result {
        Ok(()) => emit_ai_sync(
            &app,
            "gui",
            "flash",
            "completed",
            format!("Custom MBR flash completed: {}", firmware_path),
        ),
        Err(err) => emit_ai_sync(&app, "gui", "flash", "error", err.clone()),
    }
    result
}

pub(crate) async fn run_raw_flash_image_unlocked(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    boot_firmware: String,
    raw_image: String,
    mode: String,
    storage: String,
    logic_offset: Option<u64>,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<(), String> {
    let raw_mode: RawMode = mode.parse()?;
    let raw_storage: RawStorage = storage.parse()?;
    let boot_path = PathBuf::from(&boot_firmware);
    let raw_path = PathBuf::from(&raw_image);
    let request = prepare_raw_flash_request(
        &boot_path,
        &raw_path,
        raw_mode,
        raw_storage,
        logic_offset,
        bus,
        port,
    )?;

    emit_ai_sync(
        app,
        source,
        "raw",
        "started",
        format!("Raw flashing {} (mode={}, storage={})", raw_image, mode, storage),
    );

    let app_clone = app.clone();
    let cancel_flag = state.cancel_flash_flag.clone();
    let result = tokio::task::spawn_blocking(move || {
        execute_flash_sync(&app_clone, &boot_path, request, &cancel_flag)
    })
    .await
    .map_err(|e| format!("Raw 刷写任务异常: {}", e))?;

    match &result {
        Ok(()) => emit_ai_sync(
            app,
            source,
            "raw",
            "completed",
            format!("Raw flash completed: {}", raw_image),
        ),
        Err(err) => emit_ai_sync(app, source, "raw", "error", err.clone()),
    }
    result
}

pub async fn run_raw_flash_image(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    boot_firmware: String,
    raw_image: String,
    mode: String,
    storage: String,
    logic_offset: Option<u64>,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<(), String> {
    let _busy = state.try_acquire_busy("raw")?;
    run_raw_flash_image_unlocked(
        app,
        state,
        source,
        boot_firmware,
        raw_image,
        mode,
        storage,
        logic_offset,
        bus,
        port,
    )
    .await
}

#[tauri::command]
pub async fn raw_flash_image(
    app: AppHandle,
    state: State<'_, AppState>,
    boot_firmware: String,
    raw_image: String,
    mode: String,
    storage: String,
    logic_offset: Option<u64>,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<(), String> {
    run_raw_flash_image(
        &app,
        &state,
        "gui",
        boot_firmware,
        raw_image,
        mode,
        storage,
        logic_offset,
        bus,
        port,
    )
    .await
}
