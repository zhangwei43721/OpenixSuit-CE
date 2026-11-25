use crate::hotplug::watcher::scan_sunxi_devices;
use crate::state::{emit_ai_sync, AppState, UsbBackend};
use libefex::{Context as EfexContext, DeviceMode, FesDataType};
use openixcli::firmware::OpenixPacker;
use openixcli::flash::{
    DeviceSelector, FlashCompletion, FlashEvent, FlashEventSink, FlashLogLevel, FlashMode, FlashRequest, Flasher,
    PostAction,
};
use openixcli::process::global_progress::set_tui_mode;
use openixcli::raw::{prepare as prepare_raw_flash, RawMode, RawOptions, RawStorage};
use openixcli::utils::Logger;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

mod boot_check;
mod exit;
pub(crate) mod partition_read;
pub(crate) mod standard_flash;
pub(crate) use exit::{request_exit as request_fes_exit, FesExitAction};

#[derive(Clone, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub chip: String,
    pub mode: String,
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_path: Option<String>,
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

fn open_efex_session(bus: Option<u8>, port: Option<u8>) -> Result<EfexContext, String> {
    let mut ctx = EfexContext::new();
    if let (Some(b), Some(p)) = (bus, port) {
        ctx.scan_usb_device_at(b, p).map_err(|e| e.to_string())?;
    } else {
        let devs = EfexContext::scan_usb_devices().map_err(|e| e.to_string())?;
        let first = devs
            .first()
            .ok_or_else(|| "未检测到任何 ALLWINNER FEL/FES USB 设备 (0x1f3a:0xefe8)".to_string())?;
        ctx.scan_usb_device_at(first.bus, first.port)
            .map_err(|e| e.to_string())?;
    }
    ctx.usb_init().map_err(|e| e.to_string())?;
    ctx.efex_init().map_err(|e| e.to_string())?;
    Ok(ctx)
}

fn efex_device_id(bus: u8, port: u8) -> String {
    format!("bus:{bus}-port:{port}")
}

fn require_fel_mode(ctx: &EfexContext) -> Result<(), String> {
    let mode_label = match ctx.get_device_mode() {
        DeviceMode::Fel => return Ok(()),
        DeviceMode::Srv => "FES (U-Boot / DEVICE_MODE_SRV)".to_string(),
        DeviceMode::UpdateCool => "UPDATE_COOL".to_string(),
        DeviceMode::UpdateHot => "UPDATE_HOT".to_string(),
        DeviceMode::Null => "NULL".to_string(),
        DeviceMode::Unknown(val) => format!("UNKNOWN (0x{:04x})", val),
    };
    Err(format!(
        "当前设备处于 {}，不支持 FEL 内存读写与反汇编（仅固件刷写可用）。请按住板卡 FEL 键重新上电或复位进入 BROM FEL 模式后再调试。",
        mode_label
    ))
}

fn build_flash_logger(app: &AppHandle) -> Logger {
    let app_clone = app.clone();
    let current_stage = Arc::new(Mutex::new("INIT".to_string()));
    let current_partition = Arc::new(Mutex::new(String::new()));
    let last_percent = Arc::new(Mutex::new(0.0_f64));

    let sink = FlashEventSink::from_fn(move |event| match event {
        FlashEvent::Log { level, message } => {
            let stage = current_stage
                .lock()
                .map(|s| s.clone())
                .unwrap_or_else(|_| "FLASH".to_string());
            let level_str = match level {
                FlashLogLevel::Info => "info",
                FlashLogLevel::Success => "success",
                FlashLogLevel::Warn => "warn",
                FlashLogLevel::Error => "error",
                FlashLogLevel::Debug => "debug",
            };
            let _ = app_clone.emit(
                "flash-log",
                FlashLogPayload {
                    stage,
                    level: level_str.to_string(),
                    message,
                },
            );
        }
        FlashEvent::StageStarted(stage_type) => {
            let name = stage_type.name().to_string();
            if let Ok(mut stage) = current_stage.lock() {
                *stage = name.clone();
            }
            let _ = app_clone.emit(
                "flash-log",
                FlashLogPayload {
                    stage: name.clone(),
                    level: "info".to_string(),
                    message: format!("开始阶段: {}", name),
                },
            );
        }
        FlashEvent::PartitionStarted(partition_name) => {
            if let Ok(mut part) = current_partition.lock() {
                *part = partition_name.clone();
            }
            let percent = last_percent.lock().map(|p| *p).unwrap_or(0.0);
            let _ = app_clone.emit(
                "flash-progress",
                FlashProgressPayload {
                    partition: partition_name,
                    written: 0,
                    total: 0,
                    percent,
                },
            );
        }
        FlashEvent::Progress {
            overall_percent,
            stage_progress,
            total,
            speed: _,
        } => {
            let clamped = overall_percent.clamp(0.0, 100.0);
            if let Ok(mut p) = last_percent.lock() {
                *p = clamped;
            }
            let partition = current_partition
                .lock()
                .map(|p| {
                    if p.is_empty() {
                        current_stage
                            .lock()
                            .map(|s| s.clone())
                            .unwrap_or_else(|_| "flashing".to_string())
                    } else {
                        p.clone()
                    }
                })
                .unwrap_or_else(|_| "flashing".to_string());
            let _ = app_clone.emit(
                "flash-progress",
                FlashProgressPayload {
                    partition,
                    written: stage_progress,
                    total,
                    percent: clamped,
                },
            );
        }
        FlashEvent::Finished { post_action } => {
            if let Ok(mut p) = last_percent.lock() {
                *p = 100.0;
            }
            let _ = app_clone.emit(
                "flash-progress",
                FlashProgressPayload {
                    partition: "完成".to_string(),
                    written: 100,
                    total: 100,
                    percent: 100.0,
                },
            );
            let _ = app_clone.emit(
                "flash-log",
                FlashLogPayload {
                    stage: "FINISH".to_string(),
                    level: "success".to_string(),
                    message: format!("刷写完成 ({})", post_action),
                },
            );
        }
        FlashEvent::StagesDefined(_)
        | FlashEvent::StageCompleted(_)
        | FlashEvent::PartitionStageWeight(_) => {}
    });

    Logger::for_events(true, sink)
}

fn execute_openix_flash_sync(
    app: &AppHandle,
    packer: OpenixPacker,
    request: FlashRequest,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    cancel_flag.store(false, Ordering::SeqCst);
    execute_openix_flash_with_outcome(app, packer, request, cancel_flag)?
        .post_action.map_err(|error| error.to_string())
}

fn execute_openix_flash_with_outcome(
    app: &AppHandle,
    packer: OpenixPacker,
    request: FlashRequest,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<FlashCompletion, String> {
    set_tui_mode(true);
    let logger = build_flash_logger(app);
    let mut flasher =
        Flasher::new(packer, request, logger).with_cancel_flag(Arc::clone(cancel_flag));
    let res = if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.block_on(flasher.execute_with_outcome())
    } else {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|e| format!("创建异步运行时失败: {}", e))?;
        rt.block_on(flasher.execute_with_outcome())
    };
    res.map_err(|e| e.to_string())
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

fn efex_usb_paths() -> BTreeMap<(u8, u8), Option<String>> {
    let mut paths = BTreeMap::new();
    if let Ok(devices) = rusb::devices() {
        for device in devices.iter() {
            if !device.device_descriptor().is_ok_and(|desc| {
                desc.vendor_id() == 0x1f3a && desc.product_id() == 0xefe8
            }) {
                continue;
            }
            let bus = device.bus_number();
            let port = device.port_number();
            let path = device.port_numbers().ok().filter(|ports| !ports.is_empty()).map(|ports| {
                let ports = ports.iter().map(u8::to_string).collect::<Vec<_>>().join(".");
                format!("usb:{bus}-{ports}")
            });
            // 相同的末级端口号可能出现在不同集线器上。
            paths.entry((bus, port)).and_modify(|value| *value = None).or_insert(path);
        }
    }
    paths
}

fn scan_devices_with_probe(backend: &UsbBackend, probe_details: bool) -> Vec<DeviceInfo> {
    let backend_name = format!("{:?}", backend);
    let paths = efex_usb_paths();
    if let Ok(libefex_devs) = EfexContext::scan_usb_devices() {
        if !libefex_devs.is_empty() {
            return libefex_devs
                .into_iter()
                .map(|d| {
                    let id = efex_device_id(d.bus, d.port);
                    let usb_path = paths.get(&(d.bus, d.port)).cloned().flatten();
                    if probe_details {
                        if let Ok(ctx) = open_efex_session(Some(d.bus), Some(d.port)) {
                            let chip_id = unsafe { (*ctx.as_ptr()).resp.id };
                            let mode_str = ctx.get_device_mode_str();
                            let mode_label = match ctx.get_device_mode() {
                                DeviceMode::Fel => "FEL (USB Boot)",
                                DeviceMode::Srv => "FES (U-Boot)",
                                DeviceMode::UpdateCool => "UPDATE_COOL",
                                DeviceMode::UpdateHot => "UPDATE_HOT",
                                _ => "FEL/FES",
                            };
                            return DeviceInfo {
                                id,
                                chip: format!("{} (0x{:08x})", mode_str, chip_id),
                                mode: mode_label.into(),
                                backend: backend_name.clone(),
                                usb_path,
                            };
                        }
                    }
                    DeviceInfo {
                        id,
                        chip: "Sunxi SoC (0x1f3a:0xefe8)".into(),
                        mode: "FEL/FES".into(),
                        backend: backend_name.clone(),
                        usb_path,
                    }
                })
                .collect();
        }
    }
    scan_sunxi_devices()
        .into_iter()
        .map(|id| DeviceInfo {
            id,
            chip: "Sunxi SoC (0x1f3a:0xefe8)".into(),
            mode: "FEL/FES".into(),
            backend: backend_name.clone(),
            usb_path: None,
        })
        .collect()
}

#[tauri::command]
pub fn set_usb_backend(backend: UsbBackend, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.usb_backend.lock().map_err(|e| e.to_string())?;
    *guard = backend;
    Ok(())
}

pub fn efel_read_sync(address: u32, length: usize) -> Result<Vec<u8>, String> {
    efel_read_target(address, length, None)
}

pub(crate) fn efel_read_target(
    address: u32,
    length: usize,
    device_id: Option<&str>,
) -> Result<Vec<u8>, String> {
    if length == 0 || length > 1024 * 1024 {
        return Err("读取长度必须在 1B ~ 1MB 之间".into());
    }
    let ctx = if let Some(device_id) = device_id {
        let devices = EfexContext::scan_usb_devices().map_err(|error| error.to_string())?;
        let (bus, port) = exit::select_target(&devices, device_id)?;
        open_efex_session(Some(bus), Some(port))?
    } else {
        open_efex_session(None, None)?
    };
    require_fel_mode(&ctx)?;
    let mut buf = vec![0u8; length];
    ctx.fel_read(address, &mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
pub(crate) fn open_partition_output_folder(app: AppHandle, directory: PathBuf) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let directory = directory.canonicalize().map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err(format!("{} 不是文件夹", directory.display()));
    }
    app.opener()
        .open_path(directory.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

pub fn efel_write_sync(address: u32, data: Vec<u8>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let ctx = open_efex_session(None, None)?;
    require_fel_mode(&ctx)?;
    ctx.fel_write(address, &data).map_err(|e| e.to_string())
}

pub fn efel_exec_sync(address: u32) -> Result<(), String> {
    let ctx = open_efex_session(None, None)?;
    require_fel_mode(&ctx)?;
    ctx.fel_exec(address).map_err(|e| e.to_string())
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
    let ctx = open_efex_session(None, None)?;
    require_fel_mode(&ctx)?;
    let load_addr: u32 = 0x00020000;
    ctx.fel_write(load_addr, &data).map_err(|e| e.to_string())?;
    ctx.fel_exec(load_addr).map_err(|e| e.to_string())?;
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
    let ctx = open_efex_session(None, None)?;
    let storage_type = ctx.fes_query_storage().map_err(|e| e.to_string())?;
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
pub(crate) async fn fes_exit(
    state: State<'_, AppState>,
    device_id: String,
    action: FesExitAction,
) -> Result<(), String> {
    request_fes_exit(&state, device_id, action).await
}

#[tauri::command]
pub fn cancel_flash(state: State<'_, AppState>) {
    state.cancel_flash_flag.store(true, Ordering::SeqCst);
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
    state.cancel_flash_flag.store(false, Ordering::SeqCst);
    let cancel_flag = state.cancel_flash_flag.clone();

    tokio::task::spawn_blocking(move || {
        let mut file = File::open(&file_path).map_err(|e| format!("打开文件失败: {}", e))?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();
        let ctx = open_efex_session(None, None)?;

        let mut buf = vec![0u8; 65536];
        let mut written: u64 = 0;
        let mut sector_addr: u32 = 0;
        let mut hasher = crc32fast::Hasher::new();

        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err("刷写已由用户取消".into());
            }
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            ctx.fes_down(&buf[..n], sector_addr, FesDataType::Flash)
                .map_err(|e| format!("FES 分区写入失败: {}", e))?;

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
            let _crc = hasher.finalize();
            ctx.fes_verify_value(0, written)
                .map_err(|e| format!("分区 {} 写入校验失败: {}", partition, e))?;
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("刷写任务异常: {}", e))?
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
    let mut dl_map = BTreeMap::new();
    let mut selected = Vec::new();
    for part in &partitions {
        let dl = part.download_file.trim();
        if !dl.is_empty() && dl != "-" {
            dl_map.insert(part.name.clone(), dl.to_string());
            selected.push(part.name.clone());
        }
    }
    let request = FlashRequest::new(
        DeviceSelector::default(),
        verify,
        FlashMode::PartitionErase,
        if selected.is_empty() {
            None
        } else {
            Some(selected)
        },
        action,
    )
    .with_mbr_override(mbr_bytes)
    .with_partition_download_files(dl_map);

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
        let mut packer = OpenixPacker::new();
        packer
            .load(&fw_path)
            .map_err(|e| format!("加载固件失败: {}", e))?;
        execute_openix_flash_sync(&app_clone, packer, request, &cancel_flag)
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

fn parse_raw_mode(value: &str) -> Result<RawMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "command" => Ok(RawMode::Command),
        "logic-offset" | "logic_offset" => Ok(RawMode::LogicOffset),
        _ => Err(format!("Unsupported raw mode: {}", value)),
    }
}

fn parse_raw_storage(value: &str) -> Result<RawStorage, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "sdmmc" | "emmc" => Ok(RawStorage::Sdmmc),
        "ufs" => Ok(RawStorage::Ufs),
        "nor" | "spinor" => Ok(RawStorage::Nor),
        _ => Err(format!("Unsupported raw storage: {}", value)),
    }
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
    let raw_mode = parse_raw_mode(&mode)?;
    let raw_storage = parse_raw_storage(&storage)?;
    let raw_options = RawOptions {
        firmware_path: PathBuf::from(&boot_firmware),
        image_path: PathBuf::from(&raw_image),
        mode: raw_mode,
        storage: raw_storage,
        logic_offset,
        bus,
        port,
        verbose: true,
    };

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
        let (packer, request) = prepare_raw_flash(&raw_options)?;
        execute_openix_flash_sync(&app_clone, packer, request, &cancel_flag)
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
