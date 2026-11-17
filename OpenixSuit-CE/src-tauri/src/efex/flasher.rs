use crate::packer::imagewty::{
    add_sum, is_sparse_format, is_valid_mbr, sparse_format_probe, uboot_run_addr,
    uboot_set_work_mode, Boot0HeaderInfo, ChunkHeader, DramParamInfo, OpenixPacker,
    OpenixPartition, StorageType, SunxiMbr, ALIGNMENT_SIZE, BOOT_FILE_MODE_NORMAL,
    BOOT_FILE_MODE_PKG, BOOT_FILE_MODE_TOC, CHUNK_HEADER_SIZE, CHUNK_TYPE_CRC32,
    CHUNK_TYPE_DONT_CARE, CHUNK_TYPE_FILL, CHUNK_TYPE_RAW, EFEX_CRC32_VALID_FLAG, MAX_FILL_COUNT,
    MBR_MAGIC, MBR_SIZE, MBR_VERSION, MIN_DOWNLOAD_SIZE, SECTOR_SIZE, SPARSE_HEADER_SIZE,
    WORK_MODE_USB_PRODUCT,
};
use std::ffi::c_void;
use std::fs::File;
use std::io::Read;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use super::{ffi, FlashLogPayload, FlashProgressPayload};

const EFEX_CODE_MAX_SIZE: usize = 64 * 1024;
const EXTERNAL_FILE_CHUNK_SIZE: u64 = 10 * 1024 * 1024;
const FIRMWARE_CHUNK_SIZE: u64 = 256 * 1024 * 1024;
const SPARSE_BUFFER_SIZE: usize = 256 * 1024;

const UBOOT_SLOT_LEN: usize = 2 * 1024 * 1024;
const DTB_MAX_LEN: usize = 1024 * 1024;
const SYS_CONFIG_BIN00_MAX_LEN: usize = 512 * 1024;
const BOARD_CONFIG_BIN_MAX_LEN: usize = 512 * 1024;

const UBIFS_NODE_MAGIC: u32 = 0x06101831;
const UBIFS_CHECK_BUFFER_SIZE: usize = 4096;
const UBIFS_SKIP_PARTITIONS: [&str; 3] = ["UDISK", "SYSRECOVERY", "PRIVATE"];

const LOGIC_ADDRESS_LIMIT: u64 = 0x1_0000_0000;
const DEFAULT_LOGIC_OFFSET: u64 = 40960;
const DEFAULT_NOR_LOGIC_OFFSET: u64 = 2106;

extern "C" {
    fn free(ptr: *mut c_void);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlashMode {
    Partition,
    KeepData,
    PartitionErase,
    FullErase,
}

impl FlashMode {
    pub fn erase_flag(self) -> u32 {
        match self {
            FlashMode::Partition => 0x0,
            FlashMode::KeepData => 0x0,
            FlashMode::PartitionErase => 0x1,
            FlashMode::FullErase => 0x12,
        }
    }
}

impl FromStr for FlashMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "partition" => Ok(Self::Partition),
            "keep_data" => Ok(Self::KeepData),
            "partition_erase" => Ok(Self::PartitionErase),
            "full_erase" => Ok(Self::FullErase),
            _ => Err(format!("Invalid flash mode: {}", value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostAction {
    Reboot,
    PowerOff,
    Shutdown,
    Keep,
}

impl PostAction {
    pub fn fes_tool_mode(self) -> ffi::sunxi_fes_tool_mode_t {
        match self {
            PostAction::Reboot => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_REBOOT,
            PostAction::PowerOff | PostAction::Shutdown => {
                ffi::sunxi_fes_tool_mode_t_TOOL_MODE_POWEROFF
            }
            PostAction::Keep => ffi::sunxi_fes_tool_mode_t_TOOL_MODE_NORMAL,
        }
    }
}

impl FromStr for PostAction {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "reboot" => Ok(Self::Reboot),
            "poweroff" => Ok(Self::PowerOff),
            "shutdown" => Ok(Self::Shutdown),
            "keep" | "normal" => Ok(Self::Keep),
            _ => Err(format!("Invalid post action: {}", value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawMode {
    Command,
    LogicOffset,
}

impl FromStr for RawMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "command" => Ok(Self::Command),
            "logic-offset" | "logic_offset" => Ok(Self::LogicOffset),
            _ => Err(format!("Invalid raw mode: {}", value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawStorage {
    Sdmmc,
    Ufs,
    Nor,
}

impl RawStorage {
    pub fn default_logic_offset(self) -> u64 {
        match self {
            Self::Nor => DEFAULT_NOR_LOGIC_OFFSET,
            Self::Sdmmc | Self::Ufs => DEFAULT_LOGIC_OFFSET,
        }
    }
}

impl FromStr for RawStorage {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "sdmmc" | "emmc" | "sdcard" | "sdnand" => Ok(Self::Sdmmc),
            "ufs" => Ok(Self::Ufs),
            "nor" | "spinor" => Ok(Self::Nor),
            _ => Err(format!("Invalid raw storage: {}", value)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExternalPartition {
    pub name: String,
    pub path: PathBuf,
    pub address: u64,
    pub data_length: u64,
    pub wrap_address: bool,
}

#[derive(Debug, Clone)]
pub struct CustomFlashLayout {
    pub mbr_data: Vec<u8>,
    pub partitions: Vec<ExternalPartition>,
}

#[derive(Debug, Clone)]
pub struct FlashRequest {
    pub bus: Option<u8>,
    pub port: Option<u8>,
    pub verify: bool,
    pub mode: FlashMode,
    pub partitions: Option<Vec<String>>,
    pub post_action: PostAction,
    pub custom_layout: Option<CustomFlashLayout>,
    pub custom_mbr_override: Option<Vec<u8>>,
    pub custom_download_files: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct ScannedDeviceLocation {
    pub bus: u8,
    pub port: u8,
}

pub fn scan_efex_devices() -> Vec<ScannedDeviceLocation> {
    unsafe {
        let mut devices_ptr: *mut ffi::sunxi_scanned_device_t = std::ptr::null_mut();
        let mut count: usize = 0;
        let rc = ffi::sunxi_scan_usb_devices(&mut devices_ptr, &mut count);
        if rc < 0 || devices_ptr.is_null() || count == 0 {
            return Vec::new();
        }
        let slice = std::slice::from_raw_parts(devices_ptr, count);
        let list = slice
            .iter()
            .map(|d| ScannedDeviceLocation {
                bus: d.bus,
                port: d.port,
            })
            .collect();
        free(devices_ptr as *mut c_void);
        list
    }
}

pub struct EfexSession {
    pub ctx: ffi::sunxi_efex_ctx_t,
}

impl EfexSession {
    pub fn open_at(bus: Option<u8>, port: Option<u8>) -> Result<Self, String> {
        unsafe {
            let mut ctx: ffi::sunxi_efex_ctx_t = std::mem::zeroed();
            let rc = match (bus, port) {
                (Some(b), Some(p)) => ffi::sunxi_scan_usb_device_at(&mut ctx, b, p),
                _ => ffi::sunxi_scan_usb_device(&mut ctx),
            };
            if rc < 0 {
                return Err(format!(
                    "未检测到处于 FEL/FES 烧录模式的全志设备 ({})",
                    efex_err_str(rc)
                ));
            }
            let rc = ffi::sunxi_usb_init(&mut ctx);
            if rc < 0 {
                return Err(format!("USB 初始化失败 ({})", efex_err_str(rc)));
            }
            let rc = ffi::sunxi_efex_init(&mut ctx);
            if rc < 0 {
                ffi::sunxi_usb_exit(&mut ctx);
                return Err(format!("EFEX 协议握手失败 ({})", efex_err_str(rc)));
            }
            Ok(Self { ctx })
        }
    }

    pub fn device_mode(&self) -> ffi::sunxi_verify_device_mode_t {
        unsafe { ffi::sunxi_efex_get_device_mode(&self.ctx) }
    }

    pub fn fel_read(&self, addr: u32, buf: &mut [u8]) -> Result<(), String> {
        let rc = unsafe {
            ffi::sunxi_efex_fel_read(
                &self.ctx,
                addr,
                buf.as_mut_ptr() as *mut c_char,
                buf.len() as isize,
            )
        };
        if rc < 0 {
            return Err(format!(
                "FEL 读取失败 (0x{:08x}, {})",
                addr,
                efex_err_str(rc)
            ));
        }
        Ok(())
    }

    pub fn fel_write(&self, addr: u32, buf: &[u8]) -> Result<(), String> {
        if buf.is_empty() {
            return Ok(());
        }
        let rc = unsafe {
            ffi::sunxi_efex_fel_write(
                &self.ctx,
                addr,
                buf.as_ptr() as *const c_char,
                buf.len() as isize,
            )
        };
        if rc < 0 {
            return Err(format!(
                "FEL 写入失败 (0x{:08x}, {})",
                addr,
                efex_err_str(rc)
            ));
        }
        Ok(())
    }

    pub fn fel_exec(&self, addr: u32) -> Result<(), String> {
        let rc = unsafe { ffi::sunxi_efex_fel_exec(&self.ctx, addr) };
        if rc < 0 {
            return Err(format!(
                "FEL 执行失败 (0x{:08x}, {})",
                addr,
                efex_err_str(rc)
            ));
        }
        Ok(())
    }

    pub fn fes_query_storage(&self) -> Result<u32, String> {
        let mut storage_type = 0u32;
        let rc = unsafe { ffi::sunxi_efex_fes_query_storage(&self.ctx, &mut storage_type) };
        if rc < 0 {
            return Err(format!("FES 查询存储失败 ({})", efex_err_str(rc)));
        }
        Ok(storage_type)
    }

    pub fn fes_query_secure(&self) -> Result<u32, String> {
        let mut secure = 0u32;
        let rc = unsafe { ffi::sunxi_efex_fes_query_secure(&self.ctx, &mut secure) };
        if rc < 0 {
            return Err(format!("FES 查询安全模式失败 ({})", efex_err_str(rc)));
        }
        Ok(secure)
    }

    pub fn fes_probe_flash_size(&self) -> Result<u32, String> {
        let mut flash_size = 0u32;
        let rc = unsafe { ffi::sunxi_efex_fes_probe_flash_size(&self.ctx, &mut flash_size) };
        if rc < 0 {
            return Err(format!("FES 探测 Flash 容量失败 ({})", efex_err_str(rc)));
        }
        Ok(flash_size)
    }

    pub fn fes_flash_set_onoff(&self, storage_type: u32, on: bool) -> Result<(), String> {
        let on_off = if on { 1 } else { 0 };
        let rc = unsafe {
            ffi::sunxi_efex_fes_flash_set_onoff(&self.ctx, &storage_type, on_off)
        };
        if rc < 0 {
            return Err(format!("FES Flash 开关设置失败 ({})", efex_err_str(rc)));
        }
        Ok(())
    }

    pub fn fes_down(
        &self,
        buf: &[u8],
        addr: u32,
        data_type: ffi::sunxi_fes_data_type_t,
    ) -> Result<(), String> {
        if buf.is_empty() {
            return Ok(());
        }
        let rc = unsafe {
            ffi::sunxi_efex_fes_down(
                &self.ctx,
                buf.as_ptr() as *const c_char,
                buf.len() as isize,
                addr,
                data_type,
            )
        };
        if rc < 0 {
            return Err(format!("FES 下载失败 ({})", efex_err_str(rc)));
        }
        Ok(())
    }

    pub fn fes_down_with_progress<F>(
        &self,
        buf: &[u8],
        addr: u32,
        data_type: ffi::sunxi_fes_data_type_t,
        cancel_flag: &AtomicBool,
        mut on_progress: F,
    ) -> Result<u64, String>
    where
        F: FnMut(u64, u64),
    {
        if buf.is_empty() {
            return Ok(0);
        }
        let total = buf.len() as u64;
        let mut remain = buf.len();
        let mut offset = 0usize;
        let mut addr_cur = addr;

        let is_data_type = (data_type & ffi::sunxi_fes_data_type_t_SUNXI_EFEX_DATA_TYPE_MASK) != 0;

        while remain > 0 {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("刷写已由用户取消".to_string());
            }
            let chunk_len = remain.min(EFEX_CODE_MAX_SIZE);
            remain -= chunk_len;
            let mut flags = data_type;
            if remain == 0 {
                flags |= ffi::sunxi_fes_data_type_t_SUNXI_EFEX_TRANS_FINISH_TAG;
            }
            let trans = ffi::sunxi_fes_trans_t {
                addr: addr_cur,
                len: chunk_len as u32,
                flags,
            };
            let rc = unsafe {
                ffi::sunxi_usb_fes_xfer(
                    &self.ctx,
                    ffi::sunxi_usb_fes_xfer_type_t_FES_XFER_SEND,
                    ffi::sunxi_efex_cmd_t_EFEX_CMD_FES_DOWN,
                    &trans as *const ffi::sunxi_fes_trans_t as *const c_char,
                    std::mem::size_of::<ffi::sunxi_fes_trans_t>() as isize,
                    buf[offset..offset + chunk_len].as_ptr() as *const c_char,
                    chunk_len as isize,
                )
            };
            if rc < 0 {
                return Err(format!("FES 分区数据发送失败 ({})", efex_err_str(rc)));
            }
            addr_cur = addr_cur.wrapping_add(if is_data_type {
                chunk_len as u32
            } else {
                (chunk_len / 512) as u32
            });
            offset += chunk_len;
            on_progress(offset as u64, total);
        }

        Ok(total)
    }

    pub fn fes_verify_value(
        &self,
        addr: u32,
        size: u64,
    ) -> Result<ffi::sunxi_fes_verify_resp_t, String> {
        let mut resp: ffi::sunxi_fes_verify_resp_t = unsafe { std::mem::zeroed() };
        let rc = unsafe { ffi::sunxi_efex_fes_verify_value(&self.ctx, addr, size, &mut resp) };
        if rc < 0 {
            return Err(format!("FES 数值校验失败 ({})", efex_err_str(rc)));
        }
        Ok(resp)
    }

    pub fn fes_verify_status(&self, tag: u32) -> Result<ffi::sunxi_fes_verify_resp_t, String> {
        let mut resp: ffi::sunxi_fes_verify_resp_t = unsafe { std::mem::zeroed() };
        let rc = unsafe { ffi::sunxi_efex_fes_verify_status(&self.ctx, tag, &mut resp) };
        if rc < 0 {
            return Err(format!("FES 状态校验失败 ({})", efex_err_str(rc)));
        }
        Ok(resp)
    }

    pub fn fes_tool_mode(
        &self,
        tool_mode: ffi::sunxi_fes_tool_mode_t,
        next_mode: ffi::sunxi_fes_tool_mode_t,
    ) -> Result<(), String> {
        let rc = unsafe { ffi::sunxi_efex_fes_tool_mode(&self.ctx, tool_mode, next_mode) };
        if rc < 0 {
            return Err(format!("设置 Post Flash 模式失败 ({})", efex_err_str(rc)));
        }
        Ok(())
    }
}

impl Drop for EfexSession {
    fn drop(&mut self) {
        unsafe {
            ffi::sunxi_usb_exit(&mut self.ctx);
        }
    }
}

fn efex_err_str(code: i32) -> String {
    unsafe {
        let ptr = ffi::sunxi_efex_strerror(code);
        if ptr.is_null() {
            format!("code {}", code)
        } else {
            let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().to_string();
            format!("{} (code {})", s, code)
        }
    }
}

fn check_cancelled(cancel_flag: &AtomicBool) -> Result<(), String> {
    if cancel_flag.load(Ordering::Relaxed) {
        Err("刷写已由用户取消".to_string())
    } else {
        Ok(())
    }
}

fn sleep_cancellable(duration: Duration, cancel_flag: &AtomicBool) -> Result<(), String> {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        check_cancelled(cancel_flag)?;
        let step = (deadline - Instant::now()).min(Duration::from_millis(100));
        std::thread::sleep(step);
    }
    check_cancelled(cancel_flag)
}

fn emit_progress(app: &AppHandle, partition: &str, written: u64, total: u64, percent: f64) {
    let _ = app.emit(
        "flash-progress",
        FlashProgressPayload {
            partition: partition.to_string(),
            written,
            total,
            percent,
        },
    );
}

fn emit_flash_log(app: &AppHandle, stage: &str, level: &str, message: impl Into<String>) {
    let _ = app.emit(
        "flash-log",
        FlashLogPayload {
            stage: stage.to_string(),
            level: level.to_string(),
            message: message.into(),
        },
    );
}

fn storage_type_label(storage_type: u32) -> &'static str {
    match storage_type {
        0 => "NAND",
        1 => "SDCard",
        2 => "eMMC",
        3 => "SPI NOR",
        4 => "SPI NAND",
        5 => "UFS",
        _ => "Unknown",
    }
}

fn fel_init_dram(
    session: &EfexSession,
    fes_data: &[u8],
    cancel_flag: &AtomicBool,
) -> Result<(), String> {
    let fes_head = Boot0HeaderInfo::parse(fes_data).map_err(|e| e.to_string())?;
    let dram_buffer = DramParamInfo::create_empty().serialize();
    session.fel_write(fes_head.ret_addr, &dram_buffer)?;
    session.fel_write(fes_head.run_addr, fes_data)?;
    session.fel_exec(fes_head.run_addr)?;

    for _ in 0..60 {
        sleep_cancellable(Duration::from_secs(1), cancel_flag)?;
        let mut dram_result = vec![0u8; crate::packer::imagewty::DRAM_PARAM_INFO_LEN];
        if session.fel_read(fes_head.ret_addr, &mut dram_result).is_ok() {
            let dram_info = DramParamInfo::parse(&dram_result).map_err(|e| e.to_string())?;
            match dram_info.dram_init_flag {
                0 => {}
                1 => return Err("DRAM 初始化失败".to_string()),
                _ => return Ok(()),
            }
        }
    }
    Err("DRAM 初始化超时".to_string())
}

fn fel_download_uboot(
    session: &EfexSession,
    uboot_data: &[u8],
    dtb_data: Option<&[u8]>,
    sysconfig_data: &[u8],
    board_config_data: Option<&[u8]>,
) -> Result<(), String> {
    if dtb_data.is_some_and(|d| d.len() > DTB_MAX_LEN) {
        return Err(format!("DTB 超过 {} 字节限制", DTB_MAX_LEN));
    }
    if sysconfig_data.len() > SYS_CONFIG_BIN00_MAX_LEN {
        return Err(format!(
            "SysConfig 超过 {} 字节限制",
            SYS_CONFIG_BIN00_MAX_LEN
        ));
    }
    if board_config_data.is_some_and(|d| d.len() > BOARD_CONFIG_BIN_MAX_LEN) {
        return Err(format!(
            "BoardConfig 超过 {} 字节限制",
            BOARD_CONFIG_BIN_MAX_LEN
        ));
    }

    let mut uboot_buf = uboot_data.to_vec();
    uboot_set_work_mode(&mut uboot_buf, WORK_MODE_USB_PRODUCT);
    let run_addr = uboot_run_addr(&uboot_buf).map_err(|e| e.to_string())?;

    if let Some(dtb) = dtb_data {
        let addr = run_addr
            .checked_add(UBOOT_SLOT_LEN as u32)
            .ok_or("DTB 地址溢出")?;
        session.fel_write(addr, dtb)?;
    }

    let sys_addr = run_addr
        .checked_add((UBOOT_SLOT_LEN + DTB_MAX_LEN) as u32)
        .ok_or("SysConfig 地址溢出")?;
    session.fel_write(sys_addr, sysconfig_data)?;

    if let Some(board_cfg) = board_config_data {
        let addr = run_addr
            .checked_add((UBOOT_SLOT_LEN + DTB_MAX_LEN + SYS_CONFIG_BIN00_MAX_LEN) as u32)
            .ok_or("BoardConfig 地址溢出")?;
        session.fel_write(addr, board_cfg)?;
    }

    session.fel_write(run_addr, &uboot_buf)?;
    session.fel_exec(run_addr)?;
    Ok(())
}

fn reconnect_to_fes(cancel_flag: &AtomicBool) -> Result<EfexSession, String> {
    sleep_cancellable(Duration::from_secs(2), cancel_flag)?;
    let deadline = Instant::now() + Duration::from_secs(45);

    while Instant::now() < deadline {
        check_cancelled(cancel_flag)?;
        let scanned = scan_efex_devices();
        if scanned.is_empty() {
            if let Ok(session) = EfexSession::open_at(None, None) {
                if session.device_mode() == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_SRV {
                    return Ok(session);
                }
            }
        } else {
            for dev in scanned {
                if let Ok(session) = EfexSession::open_at(Some(dev.bus), Some(dev.port)) {
                    if session.device_mode() == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_SRV {
                        return Ok(session);
                    }
                }
            }
        }
        sleep_cancellable(Duration::from_secs(1), cancel_flag)?;
    }

    Err("等待 U-Boot 进入 FES USB 模式超时 (45s)".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PartitionSource {
    Firmware,
    ExternalFile(PathBuf),
}

#[derive(Debug, Clone)]
struct PartitionDownloadInfo {
    partition_name: String,
    partition_address: u64,
    download_filename: String,
    download_subtype: String,
    data_length: u64,
    source: PartitionSource,
    wrap_address: bool,
}

fn is_user_data_partition(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "udisk" | "private" | "reserve"
    )
}

fn should_include_partition(
    mode: FlashMode,
    selected: Option<&[String]>,
    name: &str,
) -> bool {
    if mode == FlashMode::KeepData && is_user_data_partition(name) {
        return false;
    }
    if mode == FlashMode::Partition {
        if let Some(list) = selected {
            return list.iter().any(|p| p == name);
        }
    }
    true
}

fn prepare_firmware_downloads(
    packer: &mut OpenixPacker,
    mbr: &SunxiMbr,
    request: &FlashRequest,
) -> Result<Vec<PartitionDownloadInfo>, String> {
    let mut cfg = OpenixPartition::new();
    if let Ok(data) = packer.get_sys_partition() {
        cfg.parse_from_data(&data);
    }
    let configs = cfg.get_partitions();
    let mut list = Vec::new();

    for part in &mbr.partitions {
        if !should_include_partition(request.mode, request.partitions.as_deref(), &part.name) {
            continue;
        }
        let custom_dl = request
            .custom_download_files
            .as_ref()
            .and_then(|map| map.get(&part.name))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "-");
        let sys_dl = configs
            .iter()
            .find(|c| c.name == part.name)
            .map(|c| c.downloadfile.clone())
            .filter(|s| !s.is_empty() && s != "-");
        let Some(dl_file) = custom_dl.or(sys_dl) else {
            continue;
        };
        let subtype = packer.build_subtype_by_filename(&dl_file);
        let data_info = packer
            .get_file_info_by_maintype_subtype("RFSFAT16", &subtype)
            .or_else(|| packer.get_file_info_by_maintype_subtype("12345678", &subtype))
            .or_else(|| packer.get_file_info_by_filename(&dl_file));

        if let Some((_, length)) = data_info {
            list.push(PartitionDownloadInfo {
                partition_name: part.name.clone(),
                partition_address: part.address(),
                download_filename: dl_file,
                download_subtype: subtype,
                data_length: length,
                source: PartitionSource::Firmware,
                wrap_address: false,
            });
        } else {
            let ext_path = PathBuf::from(&dl_file);
            if ext_path.is_file() {
                let length = std::fs::metadata(&ext_path)
                    .map_err(|e| format!("读取分区文件 {} 失败: {}", dl_file, e))?
                    .len();
                list.push(PartitionDownloadInfo {
                    partition_name: part.name.clone(),
                    partition_address: part.address(),
                    download_filename: dl_file,
                    download_subtype: String::new(),
                    data_length: length,
                    source: PartitionSource::ExternalFile(ext_path),
                    wrap_address: false,
                });
            }
        }
    }
    Ok(list)
}

fn prepare_custom_downloads(
    layout: &CustomFlashLayout,
    mbr: &SunxiMbr,
) -> Result<Vec<PartitionDownloadInfo>, String> {
    layout
        .partitions
        .iter()
        .map(|ext| {
            let part = mbr
                .partitions
                .iter()
                .find(|p| p.name == ext.name)
                .ok_or_else(|| format!("Custom MBR missing partition {}", ext.name))?;
            if part.address() != ext.address {
                return Err(format!(
                    "Custom partition {} address mismatch with MBR",
                    ext.name
                ));
            }
            let capacity = part
                .length()
                .checked_mul(512)
                .ok_or_else(|| format!("Custom partition {} capacity overflow", ext.name))?;
            if ext.data_length > capacity {
                return Err(format!(
                    "Custom partition {} data exceeds MBR capacity",
                    ext.name
                ));
            }
            Ok(PartitionDownloadInfo {
                partition_name: ext.name.clone(),
                partition_address: ext.address,
                download_filename: ext.path.display().to_string(),
                download_subtype: String::new(),
                data_length: ext.data_length,
                source: PartitionSource::ExternalFile(ext.path.clone()),
                wrap_address: ext.wrap_address,
            })
        })
        .collect()
}

fn configure_ubifs_if_needed(
    app: &AppHandle,
    session: &EfexSession,
    packer: &mut OpenixPacker,
    download_list: &[PartitionDownloadInfo],
    storage_type: StorageType,
) -> Result<(), String> {
    if storage_type == StorageType::Sdcard || storage_type == StorageType::Sd1 {
        return Ok(());
    }
    for info in download_list {
        if !matches!(info.source, PartitionSource::Firmware) {
            continue;
        }
        let upper = info.partition_name.to_ascii_uppercase();
        if UBIFS_SKIP_PARTITIONS.iter().any(|s| upper.starts_with(s)) {
            continue;
        }
        let data = packer
            .get_file_data_range_by_maintype_subtype("RFSFAT16", &info.download_subtype, 0, 4)
            .or_else(|_| {
                packer.get_file_data_range_by_maintype_subtype(
                    "12345678",
                    &info.download_subtype,
                    0,
                    4,
                )
            });
        if let Ok(bytes) = data {
            if bytes.len() >= 4 {
                let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                if magic == UBIFS_NODE_MAGIC {
                    let buffer = vec![0u8; UBIFS_CHECK_BUFFER_SIZE];
                    session.fes_down(
                        &buffer,
                        0,
                        ffi::sunxi_fes_data_type_t_SUNXI_EFEX_EXT4_UBIFS_TAG,
                    )?;
                    emit_flash_log(
                        app,
                        "UBIFS",
                        "info",
                        format!("检测到 UBIFS 分区 [{}]，已下发 UBIFS 配置标记", info.partition_name),
                    );
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

struct IncrementalChecksum {
    sum: u32,
    pending: Vec<u8>,
}

impl IncrementalChecksum {
    fn new() -> Self {
        Self {
            sum: 0,
            pending: Vec::new(),
        }
    }

    fn update(&mut self, data: &[u8]) {
        let buf = if !self.pending.is_empty() {
            let mut combined = self.pending.clone();
            combined.extend_from_slice(data);
            self.pending.clear();
            combined
        } else {
            data.to_vec()
        };
        let aligned = buf.len() & !0x03;
        for i in (0..aligned).step_by(4) {
            let val = u32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
            self.sum = self.sum.wrapping_add(val);
        }
        if aligned < buf.len() {
            self.pending = buf[aligned..].to_vec();
        }
    }

    fn finalize(&mut self) -> u32 {
        if !self.pending.is_empty() {
            let mut tail = [0u8; 4];
            tail[..self.pending.len()].copy_from_slice(&self.pending);
            self.sum = self.sum.wrapping_add(u32::from_le_bytes(tail));
            self.pending.clear();
        }
        self.sum
    }
}

fn read_firmware_range(
    packer: &mut OpenixPacker,
    info: &PartitionDownloadInfo,
    start: u64,
    len: u64,
) -> Result<Vec<u8>, String> {
    packer
        .get_file_data_range_by_maintype_subtype("RFSFAT16", &info.download_subtype, start, len)
        .or_else(|_| {
            packer.get_file_data_range_by_maintype_subtype(
                "12345678",
                &info.download_subtype,
                start,
                len,
            )
        })
        .or_else(|_| packer.get_file_data_range_by_filename(&info.download_filename, start, len))
        .map_err(|e| format!("读取分区 {} 失败: {}", info.partition_name, e))
}

fn download_raw_partition(
    app: &AppHandle,
    session: &EfexSession,
    packer: &mut OpenixPacker,
    info: &PartitionDownloadInfo,
    verify: bool,
    cancel_flag: &AtomicBool,
    written_total: &mut u64,
    grand_total: u64,
) -> Result<(), String> {
    let max_addr = match (&info.source, info.wrap_address) {
        (PartitionSource::ExternalFile(_), true) => u64::from(u32::MAX) + 1,
        _ => u64::from(u32::MAX),
    };
    if info.partition_address > max_addr {
        return Err(format!(
            "分区 {} 地址超出 FES 范围: {}",
            info.partition_name, info.partition_address
        ));
    }
    let start_sector = info.partition_address as u32;
    if info.data_length == 0 {
        return Ok(());
    }

    let chunk_limit = match info.source {
        PartitionSource::ExternalFile(_) => EXTERNAL_FILE_CHUNK_SIZE,
        PartitionSource::Firmware => FIRMWARE_CHUNK_SIZE,
    };
    let total_chunks = info.data_length.div_ceil(chunk_limit);
    let mut checksum = if verify {
        Some(IncrementalChecksum::new())
    } else {
        None
    };

    let mut ext_file = match &info.source {
        PartitionSource::Firmware => None,
        PartitionSource::ExternalFile(path) => {
            let f = File::open(path).map_err(|e| format!("打开 {} 失败: {}", path.display(), e))?;
            Some(f)
        }
    };

    for chunk_idx in 0..total_chunks {
        check_cancelled(cancel_flag)?;
        let chunk_offset = chunk_idx * chunk_limit;
        let chunk_size = chunk_limit.min(info.data_length.saturating_sub(chunk_offset));

        let chunk_data = if let Some(file) = ext_file.as_mut() {
            let mut buf = vec![0u8; chunk_size as usize];
            file.read_exact(&mut buf)
                .map_err(|e| format!("读取 {} 失败: {}", info.download_filename, e))?;
            buf
        } else {
            read_firmware_range(packer, info, chunk_offset, chunk_size)?
        };

        if let Some(ref mut cs) = checksum {
            cs.update(&chunk_data);
        }

        let sector_off = u32::try_from(chunk_offset / 512)
            .map_err(|_| format!("分区 {} 偏移超出范围", info.partition_name))?;
        let chunk_sector = if info.wrap_address {
            start_sector.wrapping_add(sector_off)
        } else {
            start_sector
                .checked_add(sector_off)
                .ok_or_else(|| format!("分区 {} 结束地址超出范围", info.partition_name))?
        };

        let base_written = *written_total;
        session.fes_down_with_progress(
            &chunk_data,
            chunk_sector,
            ffi::sunxi_fes_data_type_t_SUNXI_EFEX_FLASH_TAG,
            cancel_flag,
            |chunk_done, _| {
                let cur = base_written + chunk_done;
                let pct = if grand_total > 0 {
                    (cur as f64 / grand_total as f64) * 100.0
                } else {
                    100.0
                };
                emit_progress(app, &info.partition_name, cur, grand_total, pct);
            },
        )?;
        *written_total += chunk_data.len() as u64;
    }

    if let Some(mut cs) = checksum {
        let local_crc = cs.finalize();
        let resp = session.fes_verify_value(info.partition_address as u32, info.data_length)?;
        if resp.flag == EFEX_CRC32_VALID_FLAG {
            let media_crc = resp.media_crc as u32;
            if local_crc != media_crc {
                emit_flash_log(
                    app,
                    "PART",
                    "warn",
                    format!(
                        "分区 [{}] 校验值不一致 (local=0x{:08x}, device=0x{:08x})，按 OpenixCLI 策略继续刷写",
                        info.partition_name, local_crc, media_crc
                    ),
                );
            } else {
                emit_flash_log(
                    app,
                    "PART",
                    "ok",
                    format!(
                        "分区 [{}] 写入并校验通过 (CRC=0x{:08x})",
                        info.partition_name, local_crc
                    ),
                );
            }
        } else {
            let resp_flag = resp.flag;
            emit_flash_log(
                app,
                "PART",
                "warn",
                format!(
                    "分区 [{}] 未返回有效 CRC 标记 (flag=0x{:08x})，继续刷写",
                    info.partition_name, resp_flag
                ),
            );
        }
    } else {
        emit_flash_log(
            app,
            "PART",
            "ok",
            format!("分区 [{}] 写入完成", info.partition_name),
        );
    }

    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LastChunkType {
    Undefine,
    Raw,
    Fill,
    DontCare,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SparseParseState {
    TotalHead,
    ChunkHead,
    ChunkData,
    ChunkFillData,
    ChunkCrcData,
}

struct SparseStreamParser<'a> {
    app: &'a AppHandle,
    partition_name: &'a str,
    cancel_flag: &'a AtomicBool,
    written_total: &'a mut u64,
    grand_total: u64,
    state: SparseParseState,
    last_chunk_type: LastChunkType,
    block_size: u32,
    chunk_length: u64,
    flash_sector: u32,
    last_rest: Vec<u8>,
    rawdata_start_sector: u32,
    rawdata_size: u64,
    checksum: u32,
    verify_enabled: bool,
    chunks_seen: u32,
    logical_blocks: u64,
}

impl<'a> SparseStreamParser<'a> {
    fn new(
        app: &'a AppHandle,
        partition_name: &'a str,
        block_size: u32,
        start_sector: u32,
        verify_enabled: bool,
        cancel_flag: &'a AtomicBool,
        written_total: &'a mut u64,
        grand_total: u64,
    ) -> Self {
        Self {
            app,
            partition_name,
            cancel_flag,
            written_total,
            grand_total,
            state: SparseParseState::TotalHead,
            last_chunk_type: LastChunkType::Undefine,
            block_size,
            chunk_length: 0,
            flash_sector: start_sector,
            last_rest: Vec::new(),
            rawdata_start_sector: start_sector,
            rawdata_size: 0,
            checksum: 0,
            verify_enabled,
            chunks_seen: 0,
            logical_blocks: 0,
        }
    }

    fn feed(&mut self, session: &EfexSession, buffer: &[u8]) -> Result<(), String> {
        let combined;
        let work = if !self.last_rest.is_empty() {
            combined = [self.last_rest.as_slice(), buffer].concat();
            self.last_rest.clear();
            combined.as_slice()
        } else {
            buffer
        };

        let mut offset = 0usize;
        let mut rest = work.len();

        while rest > 0 {
            check_cancelled(self.cancel_flag)?;
            match self.state {
                SparseParseState::TotalHead => {
                    if rest < SPARSE_HEADER_SIZE {
                        self.last_rest = work[offset..offset + rest].to_vec();
                        return Ok(());
                    }
                    offset += SPARSE_HEADER_SIZE;
                    rest -= SPARSE_HEADER_SIZE;
                    self.state = SparseParseState::ChunkHead;
                }
                SparseParseState::ChunkHead => {
                    if rest < CHUNK_HEADER_SIZE {
                        self.last_rest = work[offset..offset + rest].to_vec();
                        return Ok(());
                    }
                    let chunk = ChunkHeader::parse(&work[offset..])
                        .ok_or_else(|| "Failed to parse sparse chunk header".to_string())?;
                    offset += CHUNK_HEADER_SIZE;
                    rest -= CHUNK_HEADER_SIZE;

                    self.chunks_seen += 1;
                    self.logical_blocks += u64::from(chunk.chunk_sz);
                    self.chunk_length = u64::from(chunk.chunk_sz) * u64::from(self.block_size);

                    if self.verify_enabled
                        && self.last_chunk_type == LastChunkType::Raw
                        && chunk.chunk_type != CHUNK_TYPE_RAW
                        && self.rawdata_size > 0
                    {
                        self.verify_last_raw(session)?;
                    }

                    match chunk.chunk_type {
                        CHUNK_TYPE_RAW => {
                            if u64::from(chunk.total_sz)
                                != self.chunk_length + CHUNK_HEADER_SIZE as u64
                            {
                                return Err("Invalid RAW sparse chunk size".to_string());
                            }
                            if self.last_chunk_type != LastChunkType::Raw {
                                self.checksum = 0;
                                self.rawdata_start_sector = self.flash_sector;
                                self.rawdata_size = 0;
                            }
                            self.state = SparseParseState::ChunkData;
                            self.last_chunk_type = LastChunkType::Raw;
                        }
                        CHUNK_TYPE_FILL => {
                            if chunk.total_sz != CHUNK_HEADER_SIZE as u32 + 4 {
                                return Err("Invalid FILL sparse chunk size".to_string());
                            }
                            self.state = SparseParseState::ChunkFillData;
                            self.last_chunk_type = LastChunkType::Fill;
                        }
                        CHUNK_TYPE_DONT_CARE => {
                            if chunk.total_sz != CHUNK_HEADER_SIZE as u32 {
                                return Err("Invalid DONT_CARE sparse chunk size".to_string());
                            }
                            let skip_sec = u32::try_from(self.chunk_length / SECTOR_SIZE)
                                .map_err(|_| "DONT_CARE sector overflow".to_string())?;
                            self.flash_sector = self
                                .flash_sector
                                .checked_add(skip_sec)
                                .ok_or_else(|| "DONT_CARE flash sector overflow".to_string())?;
                            self.chunk_length = 0;
                            self.state = SparseParseState::ChunkHead;
                            self.last_chunk_type = LastChunkType::DontCare;
                        }
                        CHUNK_TYPE_CRC32 => {
                            if chunk.total_sz != CHUNK_HEADER_SIZE as u32 + 4 || chunk.chunk_sz != 0
                            {
                                return Err("Invalid CRC32 sparse chunk".to_string());
                            }
                            self.state = SparseParseState::ChunkCrcData;
                            self.last_chunk_type = LastChunkType::DontCare;
                        }
                        other => {
                            return Err(format!("Unknown sparse chunk type: 0x{:04x}", other));
                        }
                    }
                }
                SparseParseState::ChunkData => {
                    let unenough = self.chunk_length.saturating_sub(rest as u64);
                    if unenough == 0 {
                        let len = self.chunk_length as usize;
                        self.write_data(session, &work[offset..offset + len], true)?;
                        offset += len;
                        rest -= len;
                        self.chunk_length = 0;
                        self.state = SparseParseState::ChunkHead;
                    } else {
                        if rest < MIN_DOWNLOAD_SIZE {
                            self.last_rest = work[offset..offset + rest].to_vec();
                            return Ok(());
                        }
                        let dl_size = if unenough < ALIGNMENT_SIZE as u64 {
                            rest + unenough as usize - ALIGNMENT_SIZE
                        } else {
                            rest & !(ALIGNMENT_SIZE - 1)
                        };
                        self.write_data(session, &work[offset..offset + dl_size], true)?;
                        offset += dl_size;
                        self.chunk_length -= dl_size as u64;
                        rest -= dl_size;
                        self.last_rest = work[offset..offset + rest].to_vec();
                        return Ok(());
                    }
                }
                SparseParseState::ChunkFillData => {
                    if rest < 4 {
                        self.last_rest = work[offset..offset + rest].to_vec();
                        return Ok(());
                    }
                    let fill_val = u32::from_le_bytes([
                        work[offset],
                        work[offset + 1],
                        work[offset + 2],
                        work[offset + 3],
                    ]);
                    offset += 4;
                    rest -= 4;
                    self.process_fill(session, fill_val)?;
                    self.chunk_length = 0;
                    self.state = SparseParseState::ChunkHead;
                }
                SparseParseState::ChunkCrcData => {
                    if rest < 4 {
                        self.last_rest = work[offset..offset + rest].to_vec();
                        return Ok(());
                    }
                    offset += 4;
                    rest -= 4;
                    self.state = SparseParseState::ChunkHead;
                }
            }
        }

        Ok(())
    }

    fn write_data(
        &mut self,
        session: &EfexSession,
        data: &[u8],
        update_verify: bool,
    ) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let sector_cnt = u32::try_from(data.len() as u64 / SECTOR_SIZE)
            .map_err(|_| "Sparse write sector overflow".to_string())?;
        let next_sector = self
            .flash_sector
            .checked_add(sector_cnt)
            .ok_or_else(|| "Sparse write address overflow".to_string())?;

        let base_written = *self.written_total;
        let grand_total = self.grand_total;
        let app = self.app;
        let part_name = self.partition_name;

        let written = session.fes_down_with_progress(
            data,
            self.flash_sector,
            ffi::sunxi_fes_data_type_t_SUNXI_EFEX_FLASH_TAG,
            self.cancel_flag,
            |done, _| {
                let cur = (base_written + done).min(grand_total);
                let pct = if grand_total > 0 {
                    (cur as f64 / grand_total as f64) * 100.0
                } else {
                    100.0
                };
                emit_progress(app, part_name, cur, grand_total, pct);
            },
        )?;

        if update_verify {
            self.checksum = add_sum(data, self.checksum);
            self.rawdata_size += written;
        }
        *self.written_total = base_written + written;
        self.flash_sector = next_sector;
        Ok(())
    }

    fn process_fill(&mut self, session: &EfexSession, fill_value: u32) -> Result<(), String> {
        if self.chunk_length == 0 {
            return Ok(());
        }
        if self.chunk_length % SECTOR_SIZE != 0 {
            return Err("Sparse FILL chunk is not sector aligned".to_string());
        }
        let fill_size = MAX_FILL_COUNT as usize * 16;
        let mut fill_buf = vec![0u8; fill_size];
        for chunk in fill_buf.chunks_exact_mut(4) {
            chunk.copy_from_slice(&fill_value.to_le_bytes());
        }
        let mut remaining = self.chunk_length;
        while remaining >= fill_size as u64 {
            self.write_data(session, &fill_buf, false)?;
            remaining -= fill_size as u64;
        }
        if remaining > 0 {
            self.write_data(session, &fill_buf[..remaining as usize], false)?;
        }
        Ok(())
    }

    fn verify_last_raw(&self, session: &EfexSession) -> Result<(), String> {
        if self.rawdata_size == 0 {
            return Ok(());
        }
        let resp = session.fes_verify_value(self.rawdata_start_sector, self.rawdata_size)?;
        if resp.flag == EFEX_CRC32_VALID_FLAG {
            let device_crc = resp.media_crc as u32;
            if self.checksum != device_crc {
                emit_flash_log(
                    self.app,
                    "PART",
                    "warn",
                    format!(
                        "Sparse 分区 [{}] 校验值不一致 (local=0x{:08x}, device=0x{:08x})，继续刷写",
                        self.partition_name, self.checksum, device_crc
                    ),
                );
            }
        } else {
            let resp_flag = resp.flag;
            emit_flash_log(
                self.app,
                "PART",
                "warn",
                format!(
                    "Sparse 分区 [{}] 未返回有效 CRC 标记 (flag=0x{:08x})，继续刷写",
                    self.partition_name, resp_flag
                ),
            );
        }
        Ok(())
    }

    fn finish(&self, session: &EfexSession, expected_chunks: u32, expected_blks: u32) -> Result<(), String> {
        if !self.last_rest.is_empty()
            || self.state != SparseParseState::ChunkHead
            || self.chunk_length != 0
        {
            return Err("Sparse chunk 数据被截断".to_string());
        }
        if self.chunks_seen != expected_chunks {
            return Err(format!(
                "Sparse chunk 数量不匹配: expected {}, got {}",
                expected_chunks, self.chunks_seen
            ));
        }
        if self.logical_blocks != u64::from(expected_blks) {
            return Err(format!(
                "Sparse block 数量不匹配: expected {}, got {}",
                expected_blks, self.logical_blocks
            ));
        }
        if self.verify_enabled && self.last_chunk_type == LastChunkType::Raw && self.rawdata_size > 0
        {
            self.verify_last_raw(session)?;
        }
        Ok(())
    }
}

fn download_sparse_partition(
    app: &AppHandle,
    session: &EfexSession,
    packer: &mut OpenixPacker,
    info: &PartitionDownloadInfo,
    verify: bool,
    cancel_flag: &AtomicBool,
    written_total: &mut u64,
    grand_total: u64,
) -> Result<(), String> {
    let start_sector = u32::try_from(info.partition_address)
        .map_err(|_| format!("分区 {} 地址超出 FES 范围", info.partition_name))?;
    let head = read_firmware_range(packer, info, 0, SPARSE_HEADER_SIZE as u64)?;
    let sparse_header = sparse_format_probe(&head)?;
    emit_flash_log(
        app,
        "PART",
        "info",
        format!(
            "Sparse [{}]: blk_sz={}, chunks={}, blocks={}",
            info.partition_name,
            sparse_header.blk_sz,
            sparse_header.total_chunks,
            sparse_header.total_blks
        ),
    );

    let mut parser = SparseStreamParser::new(
        app,
        &info.partition_name,
        sparse_header.blk_sz,
        start_sector,
        verify,
        cancel_flag,
        written_total,
        grand_total,
    );

    let mut offset = 0u64;
    while offset < info.data_length {
        check_cancelled(cancel_flag)?;
        let len = (info.data_length - offset).min(SPARSE_BUFFER_SIZE as u64);
        let buf = read_firmware_range(packer, info, offset, len)?;
        parser.feed(session, &buf)?;
        offset += len;
    }

    parser.finish(session, sparse_header.total_chunks, sparse_header.total_blks)?;
    emit_flash_log(
        app,
        "PART",
        "ok",
        format!(
            "Sparse 分区 [{}] 写入{}完成 ({} chunks)",
            info.partition_name,
            if verify { "与校验" } else { "" },
            sparse_header.total_chunks
        ),
    );
    Ok(())
}

fn download_boot_images(
    app: &AppHandle,
    session: &EfexSession,
    packer: &mut OpenixPacker,
    secure: u32,
    storage_type: u32,
) -> Result<(), String> {
    let preboot_subtype = match secure {
        BOOT_FILE_MODE_NORMAL | BOOT_FILE_MODE_PKG => Some("1234567890PREB_0"),
        BOOT_FILE_MODE_TOC => Some("TOC0_PREBOOT0000"),
        _ => None,
    };
    if let Some(sub) = preboot_subtype {
        if packer.find_file_header_by_subtype(sub).is_some() {
            let data = packer
                .find_file_data_by_subtype(sub)
                .map_err(|e| e.to_string())?;
            emit_flash_log(
                app,
                "BOOT",
                "info",
                format!("正在写入 Preboot ({}, {} bytes)...", sub, data.len()),
            );
            session.fes_down(
                &data,
                0,
                ffi::sunxi_fes_data_type_t_SUNXI_EFEX_PREBOOT_TAG,
            )?;
            let _ = session.fes_verify_status(ffi::sunxi_fes_data_type_t_SUNXI_EFEX_PREBOOT_TAG);
        }
    }

    let boot1_entry = match secure {
        BOOT_FILE_MODE_NORMAL => Some(("12345678", "UBOOT_0000000000")),
        BOOT_FILE_MODE_TOC => Some(("12345678", "TOC1_00000000000")),
        BOOT_FILE_MODE_PKG => {
            if StorageType::from(storage_type) == StorageType::Spinor {
                Some(("12345678", "BOOTPKG-NOR00000"))
            } else {
                Some(("12345678", "BOOTPKG-00000000"))
            }
        }
        _ => None,
    };
    if let Some((main, sub)) = boot1_entry {
        let boot1_data = packer
            .get_file_data_by_maintype_subtype(main, sub)
            .map_err(|_| format!("固件中缺少 Boot1 ({}/{})", main, sub))?;
        emit_flash_log(
            app,
            "BOOT",
            "info",
            format!("正在写入 Boot1/U-Boot ({}/{}, {} bytes)...", main, sub, boot1_data.len()),
        );
        session.fes_down(
            &boot1_data,
            0,
            ffi::sunxi_fes_data_type_t_SUNXI_EFEX_BOOT1_TAG,
        )?;
        let _ = session.fes_verify_status(ffi::sunxi_fes_data_type_t_SUNXI_EFEX_BOOT1_TAG);
        emit_flash_log(app, "BOOT", "ok", format!("Boot1 ({}) 写入完成", sub));
    }

    let boot0_entry = if secure == BOOT_FILE_MODE_NORMAL || secure == BOOT_FILE_MODE_PKG {
        match StorageType::from(storage_type) {
            StorageType::Nand | StorageType::Spinand => Some(("BOOT", "BOOT0_0000000000")),
            StorageType::Sdcard | StorageType::Emmc | StorageType::Emmc3 | StorageType::Emmc0 => {
                Some(("12345678", "1234567890BOOT_0"))
            }
            StorageType::Spinor => Some(("12345678", "1234567890BNOR_0")),
            StorageType::Ufs => Some(("12345678", "1234567890BUFS_0")),
            _ => Some(("12345678", "1234567890BOOT_0")),
        }
    } else if secure == BOOT_FILE_MODE_TOC {
        match StorageType::from(storage_type) {
            StorageType::Sdcard | StorageType::Sd1 => Some(("12345678", "TOC0_SDCARD00000")),
            StorageType::Nand | StorageType::Spinand => Some(("12345678", "TOC0_NAND0000000")),
            StorageType::Spinor => Some(("12345678", "TOC0_SPINOR00000")),
            StorageType::Ufs => Some(("12345678", "TOC0_UFS00000000")),
            _ => Some(("12345678", "TOC0_00000000000")),
        }
    } else {
        None
    };

    if let Some((main, sub)) = boot0_entry {
        let fallback = match secure {
            BOOT_FILE_MODE_NORMAL | BOOT_FILE_MODE_PKG => Some(("12345678", "1234567890BOOT_0")),
            BOOT_FILE_MODE_TOC => Some(("12345678", "TOC0_00000000000")),
            _ => None,
        };
        let boot0_data = packer
            .get_file_data_by_maintype_subtype(main, sub)
            .or_else(|_| match fallback {
                Some((fm, fs)) if (fm, fs) != (main, sub) => {
                    packer.get_file_data_by_maintype_subtype(fm, fs)
                }
                _ => Err(crate::packer::imagewty::PackerError::FileNotFound(format!(
                    "{}/{}",
                    main, sub
                ))),
            })
            .map_err(|_| format!("固件中缺少 Boot0 ({}/{})", main, sub))?;
        emit_flash_log(
            app,
            "BOOT",
            "info",
            format!("正在写入 Boot0 ({}/{}, {} bytes)...", main, sub, boot0_data.len()),
        );
        session.fes_down(
            &boot0_data,
            0,
            ffi::sunxi_fes_data_type_t_SUNXI_EFEX_BOOT0_TAG,
        )?;
        let _ = session.fes_verify_status(ffi::sunxi_fes_data_type_t_SUNXI_EFEX_BOOT0_TAG);
        emit_flash_log(app, "BOOT", "ok", format!("Boot0 ({}) 写入完成", sub));
    }

    Ok(())
}

pub fn execute_flash_sync(
    app: &AppHandle,
    firmware_path: &Path,
    request: FlashRequest,
    cancel_flag: &AtomicBool,
) -> Result<(), String> {
    if !firmware_path.exists() {
        return Err(format!("固件文件不存在: {}", firmware_path.display()));
    }
    let started_at = Instant::now();
    cancel_flag.store(false, Ordering::Relaxed);
    emit_flash_log(
        app,
        "LOAD",
        "info",
        format!(
            "开始刷写: {} (mode={:?}, verify={}, post={:?})",
            firmware_path.display(),
            request.mode,
            request.verify,
            request.post_action
        ),
    );

    let mut packer = OpenixPacker::new();
    packer
        .load(firmware_path)
        .map_err(|e| format!("加载固件失败: {}", e))?;

    let fes_data = packer.get_fes().map_err(|_| "固件中未找到 FES".to_string())?;
    let mut session = EfexSession::open_at(request.bus, request.port)?;

    let mode = session.device_mode();
    if mode == ffi::sunxi_verify_device_mode_t_DEVICE_MODE_FEL {
        emit_flash_log(
            app,
            "FEL",
            "info",
            format!("检测到设备处于 FEL 模式，正在使用 FES ({} bytes) 初始化 DRAM...", fes_data.len()),
        );
        emit_progress(app, "FEL: DRAM 初始化", 0, 100, 5.0);
        fel_init_dram(&session, &fes_data, cancel_flag)?;
        check_cancelled(cancel_flag)?;
        emit_flash_log(app, "FEL", "ok", "DRAM 初始化完成");

        emit_progress(app, "FEL: 加载 U-Boot", 10, 100, 10.0);
        let uboot_data = packer
            .get_uboot()
            .map_err(|_| "固件中未找到 U-Boot".to_string())?;
        let dtb_data = packer.get_dtb().ok();
        let sysconfig_data = packer
            .get_sys_config_bin()
            .map_err(|_| "固件中未找到 sys_config.bin".to_string())?;
        let board_config_data = packer.get_board_config().ok();
        emit_flash_log(
            app,
            "FEL",
            "info",
            format!(
                "加载启动组件: U-Boot={}B, DTB={}B, sys_config={}B, board_config={}B",
                uboot_data.len(),
                dtb_data.as_ref().map_or(0, |d| d.len()),
                sysconfig_data.len(),
                board_config_data.as_ref().map_or(0, |d| d.len())
            ),
        );

        fel_download_uboot(
            &session,
            &uboot_data,
            dtb_data.as_deref(),
            &sysconfig_data,
            board_config_data.as_deref(),
        )?;
        drop(session);

        emit_flash_log(app, "FEL", "info", "已跳转执行 U-Boot，等待设备重枚举进入 FES 模式...");
        emit_progress(app, "FEL: 等待设备进入 FES", 15, 100, 15.0);
        session = reconnect_to_fes(cancel_flag)?;
        emit_flash_log(app, "FES", "ok", "设备已进入 FES 模式并重新建立连接");
    } else {
        emit_flash_log(app, "FES", "info", "检测到设备已在 FES 模式，跳过 FEL 引导");
    }

    let secure = session.fes_query_secure()?;
    let storage_type = session.fes_query_storage()?;
    let flash_size = session.fes_probe_flash_size()?;
    emit_flash_log(
        app,
        "PROBE",
        "info",
        format!(
            "设备存储信息: storage={} ({}), secure_mode={}, flash_sectors={}",
            storage_type_label(storage_type),
            storage_type,
            secure,
            flash_size
        ),
    );

    if request.mode != FlashMode::Partition {
        emit_flash_log(
            app,
            "ERASE",
            "info",
            format!("下发擦除标志: mode={:?}, erase_flag=0x{:x}", request.mode, request.mode.erase_flag()),
        );
        emit_progress(app, "FES: 擦除标志", 20, 100, 20.0);
        let mut erase_data = vec![0u8; 16];
        erase_data[0..4].copy_from_slice(&request.mode.erase_flag().to_le_bytes());
        session.fes_down(
            &erase_data,
            0,
            ffi::sunxi_fes_data_type_t_SUNXI_EFEX_ERASE_TAG,
        )?;
        for _ in 0..5 {
            if let Ok(resp) =
                session.fes_verify_status(ffi::sunxi_fes_data_type_t_SUNXI_EFEX_ERASE_TAG)
            {
                if resp.flag == EFEX_CRC32_VALID_FLAG {
                    break;
                }
            }
        }
    }

    let mbr_data = if let Some(ref layout) = request.custom_layout {
        layout.mbr_data.clone()
    } else if let Some(ref custom_mbr) = request.custom_mbr_override {
        custom_mbr.clone()
    } else {
        packer
            .get_mbr()
            .map_err(|_| "固件中未找到 Sunxi MBR".to_string())?
    };
    let mbr = SunxiMbr::parse(&mbr_data).map_err(|e| e.to_string())?;
    let download_list = if let Some(ref layout) = request.custom_layout {
        prepare_custom_downloads(layout, &mbr)?
    } else {
        prepare_firmware_downloads(&mut packer, &mbr, &request)?
    };
    let plan_bytes: u64 = download_list.iter().map(|d| d.data_length).sum();
    emit_flash_log(
        app,
        "MBR",
        "info",
        format!(
            "分区计划: MBR 共 {} 个分区, 本次待刷写 {} 个分区 ({:.2} MB)",
            mbr.partitions.len(),
            download_list.len(),
            plan_bytes as f64 / (1024.0 * 1024.0)
        ),
    );

    configure_ubifs_if_needed(
        app,
        &session,
        &mut packer,
        &download_list,
        StorageType::from(storage_type),
    )?;

    if !is_valid_mbr(&mbr_data) {
        return Err("无效的 Sunxi MBR".to_string());
    }
    emit_progress(app, "FES: 写入 MBR", 25, 100, 25.0);
    session.fes_down(&mbr_data, 0, ffi::sunxi_fes_data_type_t_SUNXI_EFEX_MBR_TAG)?;
    for _ in 0..5 {
        sleep_cancellable(Duration::from_millis(100), cancel_flag)?;
        if let Ok(resp) = session.fes_verify_status(ffi::sunxi_fes_data_type_t_SUNXI_EFEX_MBR_TAG)
        {
            if resp.flag == EFEX_CRC32_VALID_FLAG && resp.media_crc == 0 {
                break;
            }
        }
    }
    emit_flash_log(app, "MBR", "ok", "Sunxi MBR 写入与校验完成");

    if !download_list.is_empty() {
        let grand_total: u64 = download_list.iter().map(|d| d.data_length).sum();
        let mut written_total: u64 = 0;

        session.fes_flash_set_onoff(0, true)?;
        let dl_res = (|| -> Result<(), String> {
            for info in &download_list {
                check_cancelled(cancel_flag)?;
                let is_sparse = match info.source {
                    PartitionSource::ExternalFile(_) => false,
                    PartitionSource::Firmware => {
                        match read_firmware_range(&mut packer, info, 0, SPARSE_HEADER_SIZE as u64) {
                            Ok(head) => is_sparse_format(&head),
                            Err(_) => false,
                        }
                    }
                };
                emit_flash_log(
                    app,
                    "PART",
                    "info",
                    format!(
                        "开始写入分区 [{}] ({}, {:.2} MB, {}, sector=0x{:08x})",
                        info.partition_name,
                        info.download_filename,
                        info.data_length as f64 / (1024.0 * 1024.0),
                        if is_sparse { "Sparse" } else { "Raw" },
                        info.partition_address
                    ),
                );
                if is_sparse {
                    download_sparse_partition(
                        app,
                        &session,
                        &mut packer,
                        info,
                        request.verify,
                        cancel_flag,
                        &mut written_total,
                        grand_total,
                    )?;
                } else {
                    download_raw_partition(
                        app,
                        &session,
                        &mut packer,
                        info,
                        request.verify,
                        cancel_flag,
                        &mut written_total,
                        grand_total,
                    )?;
                }
            }
            Ok(())
        })();
        let _ = session.fes_flash_set_onoff(0, false);
        dl_res?;
    }

    emit_progress(app, "FES: 写入 Boot0/Boot1", 98, 100, 98.0);
    download_boot_images(app, &session, &mut packer, secure, storage_type)?;

    let tool_mode = request.post_action.fes_tool_mode();
    session.fes_tool_mode(ffi::sunxi_fes_tool_mode_t_TOOL_MODE_NORMAL, tool_mode)?;
    emit_progress(app, "完成", 100, 100, 100.0);
    emit_flash_log(
        app,
        "DONE",
        "ok",
        format!(
            "刷写完成，已执行 Post-Action ({:?})，总耗时 {:.2}s",
            request.post_action,
            started_at.elapsed().as_secs_f64()
        ),
    );

    Ok(())
}

pub fn build_virtual_mbr(
    address: u64,
    length_sectors: u64,
    copy_count: u32,
) -> Result<Vec<u8>, String> {
    let copies = copy_count.max(1);
    let mut single = vec![0u8; MBR_SIZE];
    single[4..8].copy_from_slice(&MBR_VERSION.to_le_bytes());
    single[8..16].copy_from_slice(MBR_MAGIC.as_bytes());
    single[16..20].copy_from_slice(&copies.to_le_bytes());
    single[24..28].copy_from_slice(&1u32.to_le_bytes());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as u32;
    single[28..32].copy_from_slice(&stamp.to_le_bytes());

    let p = 32usize;
    single[p..p + 4].copy_from_slice(&((address >> 32) as u32).to_le_bytes());
    single[p + 4..p + 8].copy_from_slice(&(address as u32).to_le_bytes());
    single[p + 8..p + 12].copy_from_slice(&((length_sectors >> 32) as u32).to_le_bytes());
    single[p + 12..p + 16].copy_from_slice(&(length_sectors as u32).to_le_bytes());
    single[p + 16..p + 20].copy_from_slice(b"DISK");
    single[p + 32..p + 35].copy_from_slice(b"raw");

    let mut result = Vec::with_capacity(MBR_SIZE * copies as usize);
    for idx in 0..copies {
        single[20..24].copy_from_slice(&idx.to_le_bytes());
        let crc = crc32fast::hash(&single[4..]);
        single[0..4].copy_from_slice(&crc.to_le_bytes());
        result.extend_from_slice(&single);
    }
    Ok(result)
}

pub fn prepare_raw_flash_request(
    boot_firmware: &Path,
    raw_image: &Path,
    mode: RawMode,
    storage: RawStorage,
    logic_offset: Option<u64>,
    bus: Option<u8>,
    port: Option<u8>,
) -> Result<FlashRequest, String> {
    if !boot_firmware.exists() {
        return Err(format!("Boot 固件不存在: {}", boot_firmware.display()));
    }
    if !raw_image.exists() {
        return Err(format!("Raw 镜像不存在: {}", raw_image.display()));
    }
    let image_size = std::fs::metadata(raw_image)
        .map_err(|e| format!("读取 Raw 镜像信息失败: {}", e))?
        .len();
    if image_size == 0 {
        return Err("Raw 镜像为空".to_string());
    }

    let mut packer = OpenixPacker::new();
    packer
        .load(boot_firmware)
        .map_err(|e| format!("加载 Boot 固件失败: {}", e))?;

    let boot_mbr_copy = if mode == RawMode::LogicOffset {
        packer
            .get_mbr()
            .ok()
            .and_then(|d| d.get(..MBR_SIZE).map(|s| s.to_vec()))
            .and_then(|first| {
                let stored_crc = u32::from_le_bytes(first[..4].try_into().ok()?);
                if stored_crc != crc32fast::hash(&first[4..]) {
                    return None;
                }
                SunxiMbr::parse(&first).ok().map(|m| m.copy.max(1))
            })
            .unwrap_or(1)
    } else {
        1
    };

    let (address, copies) = match mode {
        RawMode::Command => (0u64, 1u32),
        RawMode::LogicOffset => {
            let off = logic_offset.unwrap_or_else(|| storage.default_logic_offset());
            if off > LOGIC_ADDRESS_LIMIT {
                return Err(format!(
                    "Logic offset 必须在 0 ~ {} 扇区之间",
                    LOGIC_ADDRESS_LIMIT
                ));
            }
            (LOGIC_ADDRESS_LIMIT - off, boot_mbr_copy.max(1))
        }
    };

    let length_sectors = image_size.div_ceil(SECTOR_SIZE);
    let mbr_data = build_virtual_mbr(address, length_sectors, copies)?;
    let layout = CustomFlashLayout {
        mbr_data,
        partitions: vec![ExternalPartition {
            name: "raw".to_string(),
            path: raw_image.to_path_buf(),
            address,
            data_length: image_size,
            wrap_address: mode == RawMode::LogicOffset,
        }],
    };

    Ok(FlashRequest {
        bus,
        port,
        verify: false,
        mode: FlashMode::FullErase,
        partitions: None,
        post_action: PostAction::Reboot,
        custom_layout: Some(layout),
        custom_mbr_override: None,
        custom_download_files: None,
    })
}
