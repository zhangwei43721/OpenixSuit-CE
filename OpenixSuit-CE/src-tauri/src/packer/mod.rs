pub mod convert;
pub mod imagewty;

use crate::state::emit_ai_sync;
use imagewty::{
    is_sparse_format, Boot0HeaderInfo, OpenixPacker, OpenixPartition, SunxiMbr, MBR_MAGIC,
    MBR_SIZE, MBR_VERSION, SPARSE_HEADER_SIZE,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Deserialize)]
pub struct PartitionEntry {
    pub index: usize,
    pub name: String,
    pub download_file: String,
    pub start_sector: u64,
    pub sectors: u64,
    pub size_bytes: u64,
    pub type_guid: String,
    #[serde(default)]
    pub sparse: bool,
}

#[derive(Clone, Serialize)]
pub struct Boot0Info {
    pub magic: String,
    pub platform: String,
    pub dram_size_mb: u32,
}

#[derive(Clone, Serialize)]
pub struct SysConfigInfo {
    pub debug_print: String,
    pub storage_type: String,
    pub i2c_port: String,
    pub i2c_scl: String,
    pub i2c_sda: String,
    pub uart_port: String,
    pub uart_baud: String,
    pub uart_tx: String,
    pub uart_rx: String,
}

#[derive(Clone, Serialize)]
pub struct ImageInspectResult {
    pub file_name: String,
    pub file_size: u64,
    pub partition_size: u64,
    pub file_count: usize,
    pub encrypted: bool,
    pub magic: String,
    pub header_version: String,
    pub sys_config: SysConfigInfo,
    pub sys_config_raw: String,
    pub boot0: Option<Boot0Info>,
    pub partitions: Vec<PartitionEntry>,
    pub files: Vec<PartitionEntry>,
}

#[derive(Clone, Serialize)]
pub struct GenericImageInfo {
    pub image_size: u64,
    pub sectors: u64,
    pub image_type: String,
    pub disk_guid: String,
    pub partitions: Vec<PartitionEntry>,
}

#[derive(Clone, Serialize)]
pub struct ConvertProgressPayload {
    pub percent: f64,
    pub message: String,
}

fn clean_pin_name(val: &str) -> String {
    let after_colon = val.split(':').nth(1).unwrap_or(val);
    after_colon.split('<').next().unwrap_or(after_colon).trim().to_string()
}

fn parse_sys_partition_fex(text: &str) -> Vec<PartitionEntry> {
    let mut parts = Vec::new();
    let mut in_part = false;
    let mut cur_name = String::new();
    let mut cur_dl = String::new();
    let mut cur_size: u64 = 0;

    let flush = |parts: &mut Vec<PartitionEntry>, name: &mut String, dl: &mut String, size: &mut u64| {
        if !name.is_empty() {
            let sectors = *size;
            parts.push(PartitionEntry {
                index: parts.len(),
                name: name.clone(),
                download_file: if dl.is_empty() { "-".into() } else { dl.clone() },
                start_sector: 0,
                sectors,
                size_bytes: sectors.saturating_mul(512),
                type_guid: "sys_partition".into(),
                sparse: false,
            });
        }
        name.clear();
        dl.clear();
        *size = 0;
    };

    for raw in text.lines() {
        let line = raw.split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            if in_part {
                flush(&mut parts, &mut cur_name, &mut cur_dl, &mut cur_size);
            }
            in_part = line.eq_ignore_ascii_case("[partition]");
            continue;
        }
        if in_part {
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim();
                let val = v.trim().trim_matches('"');
                if key == "name" {
                    cur_name = val.to_string();
                } else if key == "downloadfile" {
                    cur_dl = val.to_string();
                } else if key == "size" {
                    cur_size = val.parse::<u64>().unwrap_or(0);
                }
            }
        }
    }
    if in_part {
        flush(&mut parts, &mut cur_name, &mut cur_dl, &mut cur_size);
    }
    parts
}

fn parse_sys_config_text(text: &str) -> SysConfigInfo {
    let mut info = SysConfigInfo {
        debug_print: "On".into(),
        storage_type: "Auto".into(),
        i2c_port: "0".into(),
        i2c_scl: "-".into(),
        i2c_sda: "-".into(),
        uart_port: "0".into(),
        uart_baud: "115200".into(),
        uart_tx: "-".into(),
        uart_rx: "-".into(),
    };

    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.split(';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            let val = v.trim();
            if key == "debug_mode" {
                info.debug_print = if val == "0" { "Off" } else { "On" }.into();
            } else if key == "storage_type" {
                info.storage_type = match val {
                    "0" => "NAND",
                    "1" => "SDCard",
                    "2" => "eMMC",
                    "3" => "SPI NOR",
                    "4" => "eMMC3",
                    "5" => "SPI NAND",
                    _ => "Auto",
                }
                .into();
            } else if section == "uart_para" || section == "uart0" {
                if key == "uart_debug_port" {
                    info.uart_port = val.into();
                } else if key == "uart_debug_tx" || key == "uart0_tx" || key == "uart_tx" {
                    info.uart_tx = clean_pin_name(val);
                } else if key == "uart_debug_rx" || key == "uart0_rx" || key == "uart_rx" {
                    info.uart_rx = clean_pin_name(val);
                }
            } else if section == "twi_para" || section == "twi0" {
                if key == "twi_port" {
                    info.i2c_port = val.into();
                } else if key == "twi_scl" || key == "twi0_scl" {
                    info.i2c_scl = clean_pin_name(val);
                } else if key == "twi_sda" || key == "twi0_sda" {
                    info.i2c_sda = clean_pin_name(val);
                }
            }
        }
    }
    info
}

#[tauri::command]
pub fn inspect_image(path: String) -> Result<ImageInspectResult, String> {
    let fw_path = Path::new(&path);
    let file_size = fs::metadata(fw_path)
        .map_err(|e| format!("读取固件文件 {} 失败: {}", path, e))?
        .len();

    let mut packer = OpenixPacker::new();
    packer.load(fw_path).map_err(|e| format!("加载固件失败: {}", e))?;
    let info = packer.get_image_info();

    let mut sys_config = SysConfigInfo {
        debug_print: "On".into(),
        storage_type: "Auto".into(),
        i2c_port: "0".into(),
        i2c_scl: "-".into(),
        i2c_sda: "-".into(),
        uart_port: "0".into(),
        uart_baud: "115200".into(),
        uart_tx: "-".into(),
        uart_rx: "-".into(),
    };
    let mut sys_config_raw = String::new();
    if let Ok(bytes) = packer
        .get_image_data_by_name("sys_config")
        .or_else(|_| {
            info.files
                .iter()
                .find(|f| {
                    let lower = f.filename.to_ascii_lowercase();
                    lower == "sys_config.fex" || (lower.contains("sys_config") && lower.ends_with(".fex"))
                })
                .ok_or(imagewty::PackerError::FileNotFound("sys_config.fex".into()))
                .and_then(|f| packer.get_file_data_by_maintype_subtype(&f.maintype, &f.subtype))
        })
    {
        let text = String::from_utf8_lossy(&bytes).to_string();
        sys_config = parse_sys_config_text(&text);
        sys_config_raw = text.chars().take(256 * 1024).collect();
    }

    let mut sys_parts: Vec<PartitionEntry> = Vec::new();
    let mut cfg = OpenixPartition::new();
    if let Ok(data) = packer.get_sys_partition() {
        sys_parts = parse_sys_partition_fex(&String::from_utf8_lossy(&data));
        cfg.parse_from_data(&data);
    }
    let cfg_parts = cfg.get_partitions();

    let mut mbr_parts: Vec<PartitionEntry> = Vec::new();
    if let Ok(mbr_bytes) = packer.get_mbr() {
        if let Ok(mbr) = SunxiMbr::parse(&mbr_bytes) {
            mbr_parts = mbr
                .partitions
                .iter()
                .enumerate()
                .map(|(idx, p)| {
                    let dl_file = cfg_parts
                        .iter()
                        .find(|c| c.name == p.name)
                        .map(|c| c.downloadfile.clone())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "-".to_string());
                    let sectors = p.length();
                    PartitionEntry {
                        index: idx,
                        name: p.name.clone(),
                        download_file: dl_file,
                        start_sector: p.address(),
                        sectors,
                        size_bytes: sectors.saturating_mul(512),
                        type_guid: "Sunxi-MBR".into(),
                        sparse: false,
                    }
                })
                .collect();
        }
    }

    let mut boot0: Option<Boot0Info> = None;
    for candidate in &info.files {
        let lower = candidate.filename.to_ascii_lowercase();
        if lower.contains("boot0") || candidate.subtype.starts_with("TOC0") {
            if let Ok(head) = packer.get_file_data_range_by_maintype_subtype(
                &candidate.maintype,
                &candidate.subtype,
                0,
                512,
            ) {
                if let Ok(parsed) = Boot0HeaderInfo::parse(&head) {
                    let magic = parsed.magic.trim_matches('\0').to_string();
                    let platform = parsed.platform.trim_matches('\0').to_string();
                    boot0 = Some(Boot0Info {
                        magic: if magic.is_empty() { "BOOT0".into() } else { magic },
                        platform,
                        dram_size_mb: 0,
                    });
                    break;
                }
            }
        }
    }

    let files: Vec<PartitionEntry> = info
        .files
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let size = if item.original_length > 0 {
                item.original_length
            } else {
                item.stored_length
            };
            let sparse = packer
                .get_file_data_range_by_maintype_subtype(
                    &item.maintype,
                    &item.subtype,
                    0,
                    SPARSE_HEADER_SIZE as u64,
                )
                .map(|head| is_sparse_format(&head))
                .unwrap_or(false);
            PartitionEntry {
                index: idx,
                name: item.filename.clone(),
                download_file: item.filename.clone(),
                start_sector: item.offset / 512,
                sectors: size.saturating_add(511) / 512,
                size_bytes: size,
                type_guid: if sparse {
                    format!("{}/{} [sparse]", item.maintype, item.subtype)
                } else {
                    format!("{}/{}", item.maintype, item.subtype)
                },
                sparse,
            }
        })
        .collect();

    let partitions = if !mbr_parts.is_empty() {
        mbr_parts
    } else if !sys_parts.is_empty() {
        sys_parts
    } else {
        files.clone()
    };
    let partition_size = partitions
        .iter()
        .fold(0u64, |acc, p| acc.saturating_add(p.size_bytes));

    Ok(ImageInspectResult {
        file_name: fw_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(path),
        file_size,
        partition_size,
        file_count: files.len(),
        encrypted: info.is_encrypted,
        magic: "IMAGEWTY".into(),
        header_version: if info.is_encrypted {
            "Encrypted IMAGEWTY".into()
        } else {
            "Standard IMAGEWTY".into()
        },
        sys_config,
        sys_config_raw,
        boot0,
        partitions,
        files,
    })
}

#[tauri::command]
pub fn extract_partition(image_path: String, partition: String, out_dir: String) -> Result<String, String> {
    let mut packer = OpenixPacker::new();
    packer
        .load(Path::new(&image_path))
        .map_err(|e| format!("加载固件失败: {}", e))?;
    let info = packer.get_image_info();
    let target = info
        .files
        .into_iter()
        .find(|f| f.filename == partition)
        .ok_or_else(|| format!("未找到分区/文件: {}", partition))?;

    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let safe_name = sanitize_unpack_filename(&target.filename);
    let out_path = Path::new(&out_dir).join(safe_name);
    let len = if target.original_length > 0 {
        target.original_length
    } else {
        target.stored_length
    };
    stream_packer_entry(&mut packer, &target.maintype, &target.subtype, len, &out_path)?;

    Ok(out_path.to_string_lossy().to_string())
}

pub fn build_mbr_binary(
    partitions: &[PartitionEntry],
    include_copies: bool,
) -> Result<Vec<u8>, String> {
    if partitions.len() > 120 {
        return Err("Sunxi MBR 最多支持 120 个分区".to_string());
    }
    let copy_count = if include_copies { 4usize } else { 1usize };
    let mut full_buf = vec![0u8; MBR_SIZE * copy_count];

    for copy_idx in 0..copy_count {
        let mut buf = vec![0u8; MBR_SIZE];
        buf[4..8].copy_from_slice(&MBR_VERSION.to_le_bytes());
        buf[8..16].copy_from_slice(MBR_MAGIC.as_bytes());
        buf[16..20].copy_from_slice(&(copy_count as u32).to_le_bytes());
        buf[20..24].copy_from_slice(&(copy_idx as u32).to_le_bytes());
        buf[24..28].copy_from_slice(&(partitions.len() as u32).to_le_bytes());

        for (i, part) in partitions.iter().enumerate() {
            let off = 32 + i * 128;
            buf[off..off + 4].copy_from_slice(&((part.start_sector >> 32) as u32).to_le_bytes());
            buf[off + 4..off + 8].copy_from_slice(&(part.start_sector as u32).to_le_bytes());
            buf[off + 8..off + 12].copy_from_slice(&((part.sectors >> 32) as u32).to_le_bytes());
            buf[off + 12..off + 16].copy_from_slice(&(part.sectors as u32).to_le_bytes());
            buf[off + 16..off + 20].copy_from_slice(b"DISK");
            let name_bytes = part.name.as_bytes();
            let nlen = name_bytes.len().min(16);
            buf[off + 32..off + 32 + nlen].copy_from_slice(&name_bytes[..nlen]);
        }

        let crc = crc32fast::hash(&buf[4..]);
        buf[0..4].copy_from_slice(&crc.to_le_bytes());
        let start = copy_idx * MBR_SIZE;
        full_buf[start..start + MBR_SIZE].copy_from_slice(&buf);
    }

    Ok(full_buf)
}

#[tauri::command]
pub fn export_mbr_binary(
    partitions: Vec<PartitionEntry>,
    include_copies: bool,
    out_path: String,
) -> Result<(), String> {
    let full_buf = build_mbr_binary(&partitions, include_copies)?;
    fs::write(&out_path, full_buf).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_partition_table(disk_image_path: String) -> Result<GenericImageInfo, String> {
    let mut file = File::open(&disk_image_path).map_err(|e| e.to_string())?;
    let image_size = file.metadata().map_err(|e| e.to_string())?.len();
    let sectors = image_size / 512;

    if let Ok(gpt) = gptman::GPT::find_from(&mut file) {
        let mut entries = Vec::new();
        for (idx, part) in gpt.iter() {
            if part.is_used() {
                let sec = part.ending_lba.saturating_sub(part.starting_lba) + 1;
                entries.push(PartitionEntry {
                    index: idx as usize,
                    name: part.partition_name.as_str().to_string(),
                    download_file: String::new(),
                    start_sector: part.starting_lba,
                    sectors: sec,
                    size_bytes: sec.saturating_mul(512),
                    type_guid: format!("{:02x?}", part.partition_type_guid),
                    sparse: false,
                });
            }
        }
        return Ok(GenericImageInfo {
            image_size,
            sectors,
            image_type: "GPT Image".into(),
            disk_guid: format!("{:02x?}", gpt.header.disk_guid),
            partitions: entries,
        });
    }

    let mbr = mbrman::MBR::read_from(&mut file, 512).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for (idx, part) in mbr.iter() {
        if part.is_used() {
            let sec = part.sectors as u64;
            entries.push(PartitionEntry {
                index: idx,
                name: format!("MBR-{}", idx),
                download_file: String::new(),
                start_sector: part.starting_lba as u64,
                sectors: sec,
                size_bytes: sec.saturating_mul(512),
                type_guid: format!("0x{:02x}", part.sys),
                sparse: false,
            });
        }
    }
    Ok(GenericImageInfo {
        image_size,
        sectors,
        image_type: "MBR Image".into(),
        disk_guid: "-".into(),
        partitions: entries,
    })
}

pub fn convert_firmware_sync(
    app: &AppHandle,
    firmware_path: String,
    target: String,
    logic_offset: Option<u64>,
    uboot_start: Option<u64>,
    nor_size: u64,
    storage_size: String,
    secure: Option<String>,
    output_path: String,
) -> Result<String, String> {
    let target_enum = convert::ConvertTarget::parse(&target)?;
    let secure_mode = convert::SecureMode::parse(secure.as_deref().unwrap_or("auto"))?;
    let out_str = output_path.clone();
    let app_clone = app.clone();
    convert::run_convert(
        convert::ConvertOptions {
            firmware_path: PathBuf::from(firmware_path),
            output_path: PathBuf::from(output_path),
            target: target_enum,
            logic_offset,
            uboot_start,
            nor_size,
            storage_size,
            secure: secure_mode,
        },
        move |percent, message| {
            let _ = app_clone.emit(
                "convert-progress",
                ConvertProgressPayload { percent, message },
            );
        },
    )?;
    Ok(out_str)
}

#[tauri::command]
pub async fn convert_firmware(
    app: AppHandle,
    firmware_path: String,
    target: String,
    logic_offset: Option<u64>,
    uboot_start: Option<u64>,
    nor_size: u64,
    storage_size: String,
    secure: Option<String>,
    output_path: String,
) -> Result<String, String> {
    emit_ai_sync(
        &app,
        "gui",
        "convert",
        "started",
        format!("Converting {} -> {}", firmware_path, output_path),
    );
    let app_for_task = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        convert_firmware_sync(
            &app_for_task,
            firmware_path,
            target,
            logic_offset,
            uboot_start,
            nor_size,
            storage_size,
            secure,
            output_path,
        )
    })
    .await
    .map_err(|e| format!("转换任务异常: {}", e))?;

    match &res {
        Ok(out) => emit_ai_sync(&app, "gui", "convert", "completed", format!("Converted -> {}", out)),
        Err(err) => emit_ai_sync(&app, "gui", "convert", "error", err.clone()),
    }
    res
}

fn sanitize_unpack_filename(s: &str) -> String {
    let trimmed = s.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | ' ' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let result = cleaned
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();
    if result.is_empty() {
        "unnamed.bin".to_string()
    } else {
        result
    }
}

fn stream_packer_entry(
    packer: &mut OpenixPacker,
    maintype: &str,
    subtype: &str,
    total: u64,
    out_path: &Path,
) -> Result<(), String> {
    const CHUNK_SIZE: u64 = 4 * 1024 * 1024;
    let mut file = File::create(out_path).map_err(|e| e.to_string())?;
    let mut written = 0u64;
    while written < total {
        let len = (total - written).min(CHUNK_SIZE);
        let data = packer
            .get_file_data_range_by_maintype_subtype(maintype, subtype, written, len)
            .map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?;
        written += len;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn unpack_firmware_sync(firmware_path: &str, out_dir: &str) -> Result<usize, String> {
    let fw_path = Path::new(firmware_path);
    if !fw_path.exists() {
        return Err(format!("Firmware file not found: {}", firmware_path));
    }
    let out_base = Path::new(out_dir);
    let files_dir = out_base.join("files");
    let parts_dir = out_base.join("partitions");
    fs::create_dir_all(&files_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&parts_dir).map_err(|e| e.to_string())?;

    let mut packer = OpenixPacker::new();
    packer.load(fw_path).map_err(|e| e.to_string())?;
    let info = packer.get_image_info();

    let mut count = 0usize;
    for f in &info.files {
        let file_name = sanitize_unpack_filename(&f.filename);
        let out_path = files_dir.join(&file_name);
        let len = if f.original_length > 0 {
            f.original_length
        } else {
            f.stored_length
        };
        if stream_packer_entry(&mut packer, &f.maintype, &f.subtype, len, &out_path).is_ok() {
            count += 1;
        }
    }

    let mut cfg = OpenixPartition::new();
    if let Ok(data) = packer.get_sys_partition() {
        cfg.parse_from_data(&data);
    }
    let configs = cfg.get_partitions();

    if let Ok(mbr_data) = packer.get_mbr() {
        if let Ok(mbr) = SunxiMbr::parse(&mbr_data) {
            for p in &mbr.partitions {
                let Some(dl) = configs
                    .iter()
                    .find(|c| c.name == p.name)
                    .map(|c| c.downloadfile.clone())
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let subtype = packer.build_subtype_by_filename(&dl);
                let resolved = packer
                    .get_file_info_by_maintype_subtype("RFSFAT16", &subtype)
                    .map(|(_, len)| ("RFSFAT16", len))
                    .or_else(|| {
                        packer
                            .get_file_info_by_maintype_subtype("12345678", &subtype)
                            .map(|(_, len)| ("12345678", len))
                    });
                let Some((maintype, length)) = resolved else {
                    continue;
                };
                let out_path = parts_dir.join(format!("{}.img", sanitize_unpack_filename(&p.name)));
                if stream_packer_entry(&mut packer, maintype, &subtype, length, &out_path).is_ok() {
                    count += 1;
                }
            }
        }
    }

    Ok(count)
}

#[tauri::command]
pub async fn unpack_firmware(
    app: AppHandle,
    firmware_path: String,
    out_dir: String,
) -> Result<usize, String> {
    emit_ai_sync(
        &app,
        "gui",
        "unpack",
        "started",
        format!("Unpacking {} -> {}", firmware_path, out_dir),
    );
    let fw = firmware_path.clone();
    let od = out_dir.clone();
    let res = tokio::task::spawn_blocking(move || unpack_firmware_sync(&fw, &od))
        .await
        .map_err(|e| format!("解包任务异常: {}", e))?;
    match &res {
        Ok(cnt) => emit_ai_sync(
            &app,
            "gui",
            "unpack",
            "completed",
            format!("Unpacked {} files -> {}", cnt, out_dir),
        ),
        Err(err) => emit_ai_sync(&app, "gui", "unpack", "error", err.clone()),
    }
    res
}

fn format_dts_value(raw: &[u8]) -> String {
    if raw.is_empty() {
        return String::new();
    }
    // Check if value is a null-terminated printable ASCII string list
    if raw.last() == Some(&0) {
        let parts: Vec<&[u8]> = raw[..raw.len() - 1].split(|&b| b == 0).collect();
        let all_printable = parts.iter().all(|p| {
            !p.is_empty()
                && p.iter()
                    .all(|&b| matches!(b, 0x20..=0x7e | b'\t'))
        });
        if all_printable {
            let formatted: Vec<String> = parts
                .iter()
                .map(|p| {
                    let s = String::from_utf8_lossy(p)
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"");
                    format!("\"{}\"", s)
                })
                .collect();
            return format!(" = {}", formatted.join(", "));
        }
    }
    if raw.len() % 4 == 0 {
        let cells: Vec<String> = raw
            .chunks_exact(4)
            .map(|c| format!("0x{:x}", u32::from_be_bytes([c[0], c[1], c[2], c[3]])))
            .collect();
        return format!(" = <{}>", cells.join(" "));
    }
    let hex_bytes: Vec<String> = raw.iter().map(|b| format!("{:02x}", b)).collect();
    format!(" = [{}]", hex_bytes.join(" "))
}

fn emit_dts_node(node: fdt::node::FdtNode<'_, '_>, indent: usize, out: &mut String) {
    let pad = "    ".repeat(indent);
    let name = if node.name == "/" { "/" } else { node.name };
    out.push_str(&format!("{}{} {{\n", pad, name));
    for prop in node.properties() {
        let val_str = format_dts_value(prop.value);
        out.push_str(&format!("{}    {}{};\n", pad, prop.name, val_str));
    }
    for child in node.children() {
        emit_dts_node(child, indent + 1, out);
    }
    out.push_str(&format!("{}}};\n", pad));
}

#[tauri::command]
pub fn dtb_to_dts(dtb_path: String) -> Result<String, String> {
    let data = fs::read(&dtb_path).map_err(|e| e.to_string())?;
    let fdt = fdt::Fdt::new(&data).map_err(|e| format!("DTB 解析失败: {:?}", e))?;
    let mut out = String::from("/dts-v1/;\n\n");
    if let Some(root) = fdt.find_node("/") {
        emit_dts_node(root, 0, &mut out);
    } else {
        out.push_str("/ {\n};\n");
    }
    Ok(out)
}
