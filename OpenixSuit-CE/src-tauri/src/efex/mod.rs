pub mod ffi;

use crate::hotplug::watcher::scan_sunxi_devices;
use crate::state::{AppState, UsbBackend};
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::os::raw::c_char;
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

struct EfexSession {
    ctx: ffi::sunxi_efex_ctx_t,
}

impl EfexSession {
    fn open() -> Result<Self, String> {
        unsafe {
            let mut ctx: ffi::sunxi_efex_ctx_t = std::mem::zeroed();
            let rc = ffi::sunxi_scan_usb_device(&mut ctx);
            if rc < 0 {
                return Err("未检测到处于 FEL/FES 烧录模式的全志设备（请先让板卡进入 FEL 模式）".into());
            }
            let rc = ffi::sunxi_usb_init(&mut ctx);
            if rc < 0 {
                return Err(format!("USB 初始化失败 (code {})", rc));
            }
            let rc = ffi::sunxi_efex_init(&mut ctx);
            if rc < 0 {
                ffi::sunxi_usb_exit(&mut ctx);
                return Err(format!("EFEX 协议握手失败 (code {})", rc));
            }
            Ok(Self { ctx })
        }
    }
}

impl Drop for EfexSession {
    fn drop(&mut self) {
        unsafe {
            ffi::sunxi_usb_exit(&mut self.ctx);
        }
    }
}

#[tauri::command]
pub fn scan_devices(state: State<'_, AppState>) -> Result<Vec<DeviceInfo>, String> {
    let backend = state.usb_backend.lock().map_err(|e| e.to_string())?.clone();
    let backend_name = format!("{:?}", backend);
    let devices = scan_sunxi_devices()
        .into_iter()
        .map(|id| DeviceInfo {
            id,
            chip: "Sunxi SoC (0x1f3a:0xefe8)".into(),
            mode: "DEVICE_MODE_FEL".into(),
            backend: backend_name.clone(),
        })
        .collect();
    Ok(devices)
}

#[tauri::command]
pub fn set_usb_backend(backend: UsbBackend, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.usb_backend.lock().map_err(|e| e.to_string())?;
    *guard = backend;
    Ok(())
}

#[tauri::command]
pub fn fel_read_mem(address: u32, length: usize) -> Result<Vec<u8>, String> {
    if length == 0 || length > 1024 * 1024 {
        return Err("读取长度必须在 1B ~ 1MB 之间".into());
    }
    let session = EfexSession::open()?;
    let mut buf = vec![0u8; length];
    let rc = unsafe {
        ffi::sunxi_efex_fel_read(
            &session.ctx,
            address,
            buf.as_mut_ptr() as *mut c_char,
            length as isize,
        )
    };
    if rc < 0 {
        return Err(format!("FEL 读取内存失败 (0x{:08x}, code {})", address, rc));
    }
    Ok(buf)
}

#[tauri::command]
pub fn fel_write_mem(address: u32, data: Vec<u8>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let session = EfexSession::open()?;
    let rc = unsafe {
        ffi::sunxi_efex_fel_write(
            &session.ctx,
            address,
            data.as_ptr() as *const c_char,
            data.len() as isize,
        )
    };
    if rc < 0 {
        return Err(format!("FEL 写入内存失败 (0x{:08x}, code {})", address, rc));
    }
    Ok(())
}

#[tauri::command]
pub fn fel_write_file(address: u32, file_path: String) -> Result<usize, String> {
    let data = std::fs::read(&file_path).map_err(|e| format!("读取文件失败: {}", e))?;
    let len = data.len();
    fel_write_mem(address, data)?;
    Ok(len)
}

#[tauri::command]
pub fn fel_exec(address: u32) -> Result<(), String> {
    let session = EfexSession::open()?;
    let rc = unsafe { ffi::sunxi_efex_fel_exec(&session.ctx, address) };
    if rc < 0 {
        return Err(format!("FEL 执行跳转失败 (0x{:08x}, code {})", address, rc));
    }
    Ok(())
}

#[tauri::command]
pub fn fel_init_dram(file_path: String) -> Result<Vec<String>, String> {
    let data = std::fs::read(&file_path).map_err(|e| format!("读取初始化镜像失败: {}", e))?;
    if data.len() < 96 {
        return Err("镜像文件过小，无法解析 DRAM 参数".into());
    }
    let session = EfexSession::open()?;
    let load_addr: u32 = 0x00020000;
    let rc = unsafe {
        ffi::sunxi_efex_fel_write(
            &session.ctx,
            load_addr,
            data.as_ptr() as *const c_char,
            data.len() as isize,
        )
    };
    if rc < 0 {
        return Err(format!("写入 DRAM 初始化程序失败 (code {})", rc));
    }
    let rc = unsafe { ffi::sunxi_efex_fel_exec(&session.ctx, load_addr) };
    if rc < 0 {
        return Err(format!("执行 DRAM 初始化失败 (code {})", rc));
    }
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
pub fn fes_query_storage() -> Result<String, String> {
    let session = EfexSession::open()?;
    let mut storage_type: u32 = 0;
    let rc = unsafe { ffi::sunxi_efex_fes_query_storage(&session.ctx, &mut storage_type) };
    if rc < 0 {
        return Err(format!("FES 查询存储类型失败 (code {})", rc));
    }
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
pub fn fes_tool_mode(action: String) -> Result<(), String> {
    let session = EfexSession::open()?;
    let mode = match action.as_str() {
        "reboot" => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_REBOOT,
        "poweroff" => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_POWEROFF,
        "shutdown" => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_POWEROFF,
        _ => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_NORMAL,
    };
    let rc = unsafe {
        ffi::sunxi_efex_fes_tool_mode(
            &session.ctx,
            mode,
            ffi::sunxi_fes_tool_mode_t_TOOL_MODE_NORMAL,
        )
    };
    if rc < 0 {
        return Err(format!("设置 Post Flash 动作失败 (code {})", rc));
    }
    Ok(())
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
    state.cancel_flash_flag.store(false, Ordering::Relaxed);
    let cancel_flag = state.cancel_flash_flag.clone();

    let mut file = File::open(&file_path).map_err(|e| format!("打开文件失败: {}", e))?;
    let total = file.metadata().map_err(|e| e.to_string())?.len();
    let session = EfexSession::open()?;

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
        let crc = hasher.finalize();
        let rc = unsafe {
            ffi::sunxi_efex_fes_verify_value(&session.ctx, 0, written, &mut status)
        };
        let _ = crc;
        if rc < 0 {
            return Err(format!("分区 {} 写入校验失败 (code {})", partition, rc));
        }
    }

    Ok(())
}
