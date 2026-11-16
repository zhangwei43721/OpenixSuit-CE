pub mod convert;
pub mod imagewty;

use crate::state::emit_ai_sync;
use imagewty::{OpenixPacker, OpenixPartition, SunxiMbr};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
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
    pub sys_config: SysConfigInfo,
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

struct ImagewtyItem {
    name: String,
    offset: u64,
    size: u64,
}

fn read_u32_le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn read_u64_split(buf: &[u8], lo_off: usize) -> u64 {
    let lo = read_u32_le(buf, lo_off) as u64;
    let hi = read_u32_le(buf, lo_off + 4) as u64;
    lo | (hi << 32)
}

fn parse_imagewty_items(file: &mut File, file_size: u64) -> Result<(String, bool, Vec<ImagewtyItem>), String> {
    let mut hdr = [0u8; 1024];
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    file.read_exact(&mut hdr).map_err(|e| format!("读取 IMAGEWTY 头失败: {}", e))?;

    let magic = String::from_utf8_lossy(&hdr[0..8]).trim_end_matches('\0').to_string();
    if magic != "IMAGEWTY" {
        return Err(format!("非未加密 IMAGEWTY 固件格式 (magic: {})", magic));
    }

    let header_version = read_u32_le(&hdr, 8);
    if !matches!(header_version, 0x0100 | 0x0200 | 0x0300) {
        return Err(format!("未知 IMAGEWTY 头版本: 0x{:04x}", header_version));
    }

    // 与 OpenixCLI ImageHeaderV1 / ImageHeaderV3 精确对齐
    let num_files = if header_version == 0x0300 {
        read_u32_le(&hdr, 0x3c)
    } else {
        read_u32_le(&hdr, 0x38)
    } as usize;

    let max_entries = ((file_size.saturating_sub(1024)) / 1024) as usize;
    if num_files > max_entries || num_files > 4096 {
        return Err(format!("固件文件头数量异常: {}", num_files));
    }

    let mut items = Vec::with_capacity(num_files);
    for idx in 0..num_files {
        let entry_off = 1024u64 + (idx as u64) * 1024;
        let mut entry = [0u8; 1024];
        if file.seek(SeekFrom::Start(entry_off)).is_err() || file.read_exact(&mut entry).is_err() {
            break;
        }

        let (name_slice, size, offset) = if header_version == 0x0300 {
            // FileHeaderV3: data at 0x20 -> attr(4), filename(256 at 0x24), stored_len(8 at 0x124), orig_len(8 at 0x12c), offset(8 at 0x134)
            let name_raw = &entry[0x24..0x124];
            let orig_len = read_u64_split(&entry, 0x12c);
            let stored_len = read_u64_split(&entry, 0x124);
            let off = read_u64_split(&entry, 0x134);
            (name_raw, if orig_len > 0 { orig_len } else { stored_len }, off)
        } else {
            // FileHeaderV1: data at 0x20 -> attr(4), stored_len(4 at 0x24), orig_len(4 at 0x28), offset(4 at 0x2c), checksum(4 at 0x30), filename(256 at 0x34)
            let name_raw = &entry[0x34..0x134];
            let stored_len = read_u32_le(&entry, 0x24) as u64;
            let orig_len = read_u32_le(&entry, 0x28) as u64;
            let off = read_u32_le(&entry, 0x2c) as u64;
            (name_raw, if orig_len > 0 { orig_len } else { stored_len }, off)
        };

        let name = String::from_utf8_lossy(name_slice.split(|&b| b == 0).next().unwrap_or(&[]))
            .trim()
            .to_string();
        if !name.is_empty() && offset < file_size {
            let safe_size = size.min(file_size.saturating_sub(offset));
            items.push(ImagewtyItem {
                name,
                offset,
                size: safe_size,
            });
        }
    }

    Ok((magic, false, items))
}

fn read_item_bytes(file: &mut File, item: &ImagewtyItem, max_bytes: usize) -> Vec<u8> {
    let len = (item.size as usize).min(max_bytes);
    let mut buf = vec![0u8; len];
    if file.seek(SeekFrom::Start(item.offset)).is_ok() && file.read_exact(&mut buf).is_ok() {
        buf
    } else {
        vec![]
    }
}

fn parse_sunxi_mbr_bytes(data: &[u8]) -> Vec<PartitionEntry> {
    if data.len() < 160 || &data[8..16] != b"softw411" {
        return vec![];
    }
    let part_count = (read_u32_le(data, 24) as usize).min(120);
    let mut parts = Vec::with_capacity(part_count);
    for idx in 0..part_count {
        let off = 32 + idx * 128;
        if off + 128 > data.len() {
            break;
        }
        let addr_lo = read_u32_le(data, off) as u64;
        let len_lo = read_u32_le(data, off + 4) as u64;
        let name_raw = &data[off + 24..off + 40];
        let name = String::from_utf8_lossy(name_raw.split(|&b| b == 0).next().unwrap_or(&[])).to_string();
        let dl_raw = &data[off + 40..off + 56];
        let download_file =
            String::from_utf8_lossy(dl_raw.split(|&b| b == 0).next().unwrap_or(&[])).to_string();
        if !name.is_empty() {
            parts.push(PartitionEntry {
                index: idx,
                name,
                download_file,
                start_sector: addr_lo,
                sectors: len_lo,
                size_bytes: len_lo.saturating_mul(512),
                type_guid: "Sunxi-MBR".into(),
            });
        }
    }
    parts
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
                    "4" => "SPI NAND",
                    "5" => "UFS",
                    _ => "Auto",
                }
                .into();
            } else if section == "uart_para" {
                if key == "uart_debug_port" {
                    info.uart_port = val.into();
                } else if key == "uart_debug_tx" {
                    info.uart_tx = clean_pin_name(val);
                } else if key == "uart_debug_rx" {
                    info.uart_rx = clean_pin_name(val);
                }
            } else if section == "twi_para" {
                if key == "twi_port" {
                    info.i2c_port = val.into();
                } else if key == "twi_scl" {
                    info.i2c_scl = clean_pin_name(val);
                } else if key == "twi_sda" {
                    info.i2c_sda = clean_pin_name(val);
                }
            }
        }
    }
    info
}

#[tauri::command]
pub fn inspect_image(path: String) -> Result<ImageInspectResult, String> {
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    let (magic, encrypted, items) = parse_imagewty_items(&mut file, file_size)?;

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
    let mut boot0: Option<Boot0Info> = None;
    let mut mbr_parts: Vec<PartitionEntry> = Vec::new();
    let mut sys_parts: Vec<PartitionEntry> = Vec::new();

    for item in &items {
        let lower = item.name.to_lowercase();
        if lower.contains("sys_config") && lower.ends_with(".fex") {
            let bytes = read_item_bytes(&mut file, item, 512 * 1024);
            sys_config = parse_sys_config_text(&String::from_utf8_lossy(&bytes));
        } else if lower.contains("sys_partition") && lower.ends_with(".fex") && sys_parts.is_empty() {
            let bytes = read_item_bytes(&mut file, item, 512 * 1024);
            sys_parts = parse_sys_partition_fex(&String::from_utf8_lossy(&bytes));
        } else if lower.contains("sunxi_mbr") {
            let bytes = read_item_bytes(&mut file, item, 64 * 1024);
            let parsed = parse_sunxi_mbr_bytes(&bytes);
            if !parsed.is_empty() {
                mbr_parts = parsed;
            }
        } else if lower.contains("boot0") && boot0.is_none() {
            let bytes = read_item_bytes(&mut file, item, 512);
            if bytes.len() >= 32 {
                let b_magic: String = String::from_utf8_lossy(&bytes[4..12])
                    .chars()
                    .filter(|c| c.is_ascii_graphic())
                    .collect();
                let platform: String = String::from_utf8_lossy(&bytes[24..32])
                    .chars()
                    .filter(|c| c.is_ascii_graphic())
                    .collect();
                boot0 = Some(Boot0Info {
                    magic: b_magic,
                    platform,
                    dram_size_mb: 0,
                });
            }
        }
    }

    let files: Vec<PartitionEntry> = items
        .iter()
        .enumerate()
        .map(|(idx, item)| PartitionEntry {
            index: idx,
            name: item.name.clone(),
            download_file: item.name.clone(),
            start_sector: item.offset / 512,
            sectors: item.size.saturating_add(511) / 512,
            size_bytes: item.size,
            type_guid: "IMAGEWTY".into(),
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
        file_name: Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or(path),
        file_size,
        partition_size,
        file_count: files.len(),
        encrypted,
        magic,
        sys_config,
        boot0,
        partitions,
        files,
    })
}

#[tauri::command]
pub fn extract_partition(image_path: String, partition: String, out_dir: String) -> Result<String, String> {
    let mut file = File::open(&image_path).map_err(|e| e.to_string())?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    let (_, _, items) = parse_imagewty_items(&mut file, file_size)?;
    let target = items
        .into_iter()
        .find(|i| i.name == partition)
        .ok_or_else(|| format!("未找到分区/文件: {}", partition))?;

    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let safe_name = Path::new(&target.name)
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("partition.bin"));
    let out_path = Path::new(&out_dir).join(safe_name);

    file.seek(SeekFrom::Start(target.offset)).map_err(|e| e.to_string())?;
    let mut out = File::create(&out_path).map_err(|e| e.to_string())?;
    let mut remaining = target.size;
    let mut buf = vec![0u8; 65536];
    while remaining > 0 {
        let to_read = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..to_read]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        remaining -= n as u64;
    }

    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_mbr_binary(
    partitions: Vec<PartitionEntry>,
    include_copies: bool,
    out_path: String,
) -> Result<(), String> {
    let copy_count = if include_copies { 4usize } else { 1usize };
    let mbr_size = 16 * 1024;
    let mut full_buf = vec![0u8; mbr_size * copy_count];

    for copy_idx in 0..copy_count {
        let mut buf = vec![0u8; mbr_size];
        buf[4..8].copy_from_slice(&0x00000200u32.to_le_bytes());
        buf[8..16].copy_from_slice(b"softw411");
        buf[16..20].copy_from_slice(&(copy_count as u32).to_le_bytes());
        buf[20..24].copy_from_slice(&(copy_idx as u32).to_le_bytes());
        buf[24..28].copy_from_slice(&(partitions.len().min(120) as u32).to_le_bytes());

        for (i, part) in partitions.iter().take(120).enumerate() {
            let off = 32 + i * 128;
            buf[off..off + 4].copy_from_slice(&(part.start_sector as u32).to_le_bytes());
            buf[off + 4..off + 8].copy_from_slice(&(part.sectors as u32).to_le_bytes());
            let name_bytes = part.name.as_bytes();
            let nlen = name_bytes.len().min(16);
            buf[off + 24..off + 24 + nlen].copy_from_slice(&name_bytes[..nlen]);
            let dl_bytes = part.download_file.as_bytes();
            let dlen = dl_bytes.len().min(16);
            buf[off + 40..off + 40 + dlen].copy_from_slice(&dl_bytes[..dlen]);
        }

        let crc = crc32fast::hash(&buf[4..]);
        buf[0..4].copy_from_slice(&crc.to_le_bytes());
        let start = copy_idx * mbr_size;
        full_buf[start..start + mbr_size].copy_from_slice(&buf);
    }

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
    output_path: String,
) -> Result<String, String> {
    let target_enum = convert::ConvertTarget::parse(&target)?;
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

#[tauri::command]
pub fn dtb_to_dts(dtb_path: String) -> Result<String, String> {
    let data = fs::read(&dtb_path).map_err(|e| e.to_string())?;
    let fdt = fdt::Fdt::new(&data).map_err(|e| format!("DTB 解析失败: {:?}", e))?;
    let mut out = String::from("/dts-v1/;\n\n/ {\n");
    for node in fdt.all_nodes() {
        out.push_str(&format!("    {} {{\n", node.name));
        for prop in node.properties() {
            out.push_str(&format!("        {}; /* {} bytes */\n", prop.name, prop.value.len()));
        }
        out.push_str("    };\n");
    }
    out.push_str("};\n");
    Ok(out)
}
