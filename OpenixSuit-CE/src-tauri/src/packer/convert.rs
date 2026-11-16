use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

use super::imagewty::{
    ChunkHeader, OpenixPacker, OpenixPartition, SparseHeader, CHUNK_TYPE_CRC32,
    CHUNK_TYPE_DONT_CARE, CHUNK_TYPE_FILL, CHUNK_TYPE_RAW, SECTOR_SIZE,
};

const MEBIBYTE: u64 = 1024 * 1024;
const BUFFER_SIZE: usize = 8 * 1024;
const GPT_SIZE: usize = 16 * 1024;
const MBR_LAYOUT_SIZE: u64 = 64 * 1024;
const BOOT0_OFFSET: u64 = 16 * SECTOR_SIZE;
const BOOT0_BACKUP_OFFSET: u64 = 256 * SECTOR_SIZE;
const UBOOT_OFFSET: u64 = 24_576 * SECTOR_SIZE;
const UBOOT_BACKUP_OFFSET: u64 = 32_800 * SECTOR_SIZE;

const GPT_SIGNATURE: &[u8; 8] = b"EFI PART";
const GPT_HEADER_SIZE: usize = 92;
const GPT_MIN_HEADER_SIZE: usize = SECTOR_SIZE as usize + GPT_HEADER_SIZE;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ConvertTarget {
    Spinor,
    Sdcard,
    Emmc,
    Sdnand,
    Ufs,
}

impl ConvertTarget {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "spinor" | "nor" => Ok(Self::Spinor),
            "sdcard" | "sd" => Ok(Self::Sdcard),
            "emmc" => Ok(Self::Emmc),
            "sdnand" => Ok(Self::Sdnand),
            "ufs" => Ok(Self::Ufs),
            _ => Err(format!("Unsupported convert target: {}", value)),
        }
    }

    fn flash_type(self) -> &'static str {
        match self {
            Self::Ufs => "ufs",
            Self::Sdnand | Self::Emmc => "emmc",
            Self::Sdcard => "sdcard",
            Self::Spinor => "spinor",
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SecureMode {
    Auto,
    Enabled,
    Disabled,
}

impl SecureMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Ok(Self::Auto),
            "enabled" | "true" | "1" => Ok(Self::Enabled),
            "disabled" | "false" | "0" => Ok(Self::Disabled),
            _ => Err(format!("Unsupported secure mode: {}", value)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConvertOptions {
    pub firmware_path: PathBuf,
    pub output_path: PathBuf,
    pub target: ConvertTarget,
    pub logic_offset: Option<u64>,
    pub uboot_start: Option<u64>,
    pub nor_size: u64,
    pub storage_size: String,
    pub secure: SecureMode,
}

#[derive(Debug, Clone)]
struct PartitionItem {
    name: String,
    size: u64,
    download_file: String,
}

#[derive(Debug, Clone, Copy, Default)]
struct FlashOffsets {
    sdmmc_logic_offset: Option<u64>,
    nor_logic_offset: Option<u64>,
    nor_uboot_start: Option<u64>,
}

fn property_u32(node: &fdt::node::FdtNode<'_, '_>, name: &str) -> Option<u64> {
    let value = node.property(name)?.value;
    let bytes: [u8; 4] = value.get(..4)?.try_into().ok()?;
    Some(u64::from(u32::from_be_bytes(bytes)))
}

fn parse_flash_offsets(data: &[u8]) -> Result<FlashOffsets, String> {
    let tree = fdt::Fdt::new(data).map_err(|e| format!("Failed to parse DTB: {e:?}"))?;
    let flashmap = tree
        .find_node("/soc/sunxi_flashmap")
        .ok_or_else(|| "sunxi_flashmap node not found".to_string())?;

    let mut offsets = FlashOffsets::default();
    for child in flashmap.children() {
        match child.name {
            "sdmmc_map" => {
                offsets.sdmmc_logic_offset = property_u32(&child, "logic_offset");
            }
            "nor_map" => {
                offsets.nor_logic_offset = property_u32(&child, "logic_offset");
                offsets.nor_uboot_start = property_u32(&child, "uboot_start");
            }
            _ => {}
        }
    }
    Ok(offsets)
}

fn extract_dtb_from_uboot(data: &[u8]) -> Option<&[u8]> {
    const DTB_MAGIC: [u8; 4] = [0xd0, 0x0d, 0xfe, 0xed];
    let mut offset = data.len() & !3;
    while offset >= 4 {
        offset -= 4;
        if data[offset..offset + 4] != DTB_MAGIC || offset + 8 > data.len() {
            continue;
        }
        let total_size = u32::from_be_bytes(data[offset + 4..offset + 8].try_into().ok()?) as usize;
        let end = offset.checked_add(total_size)?;
        if total_size > 0 && end <= data.len() {
            let candidate = &data[offset..end];
            if fdt::Fdt::new(candidate).is_ok() {
                return Some(candidate);
            }
        }
    }
    None
}

fn detect_flash_offsets(packer: &mut OpenixPacker) -> FlashOffsets {
    if let Ok(dtb) = packer.get_dtb() {
        if let Ok(offsets) = parse_flash_offsets(&dtb) {
            return offsets;
        }
    }
    if let Ok(uboot) = packer.get_uboot() {
        if let Some(dtb) = extract_dtb_from_uboot(&uboot) {
            if let Ok(offsets) = parse_flash_offsets(dtb) {
                return offsets;
            }
        }
    }
    FlashOffsets::default()
}

fn parse_storage_size(value: &str) -> Result<Option<u64>, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "auto" {
        return Ok(None);
    }

    let (number, multiplier) = if let Some(number) = normalized.strip_suffix("gb") {
        (number, 1024_u64.pow(3))
    } else if let Some(number) = normalized.strip_suffix("mb") {
        (number, 1024_u64.pow(2))
    } else if let Some(number) = normalized.strip_suffix("kb") {
        (number, 1024_u64)
    } else if let Some(number) = normalized.strip_suffix('g') {
        (number, 1024_u64.pow(3))
    } else if let Some(number) = normalized.strip_suffix('m') {
        (number, 1024_u64.pow(2))
    } else if let Some(number) = normalized.strip_suffix('k') {
        (number, 1024_u64)
    } else {
        (normalized.as_str(), 1)
    };

    let amount = number
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("Invalid storage size: {value}"))?;
    amount
        .checked_mul(multiplier)
        .map(Some)
        .ok_or_else(|| format!("Storage size overflows u64: {value}"))
}

fn checked_scale(value: u64, scale: u64, label: &str) -> Result<u64, String> {
    value
        .checked_mul(scale)
        .ok_or_else(|| format!("{label} overflows u64"))
}

fn load_partitions(packer: &mut OpenixPacker) -> Result<Vec<PartitionItem>, String> {
    let data = match packer.get_sys_partition() {
        Ok(data) => data,
        Err(_) => return Ok(Vec::new()),
    };
    let mut parser = OpenixPartition::new();
    parser.parse_from_data(&data);
    parser
        .get_partitions()
        .iter()
        .map(|p| {
            Ok(PartitionItem {
                name: p.name.clone(),
                size: checked_scale(p.size, SECTOR_SIZE, &format!("Partition {} size", p.name))?,
                download_file: p.downloadfile.clone(),
            })
        })
        .collect()
}

fn reject_input_as_output(input: &Path, output: &Path) -> Result<(), String> {
    if input == output {
        return Err("Output path must differ from the input firmware path".to_string());
    }
    if output.exists() {
        let input_c = input
            .canonicalize()
            .map_err(|e| format!("Failed to resolve input path: {e}"))?;
        let output_c = output
            .canonicalize()
            .map_err(|e| format!("Failed to resolve output path: {e}"))?;
        if input_c == output_c {
            return Err("Output path must differ from the input firmware path".to_string());
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct GptHeader {
    signature: [u8; 8],
    revision: u32,
    header_size: u32,
    header_crc32: u32,
    reserved: u32,
    my_lba: u64,
    alternate_lba: u64,
    first_usable_lba: u64,
    last_usable_lba: u64,
    disk_guid: [u8; 16],
    partition_entry_lba: u64,
    num_partition_entries: u32,
    size_of_partition_entry: u32,
    partition_entry_crc32: u32,
}

impl GptHeader {
    fn parse(data: &[u8]) -> Result<Self, String> {
        if data.len() < GPT_MIN_HEADER_SIZE {
            return Err(format!("GPT data is too small: {} bytes", data.len()));
        }
        let s = &data[SECTOR_SIZE as usize..];
        let mut signature = [0u8; 8];
        signature.copy_from_slice(&s[0..8]);
        if &signature != GPT_SIGNATURE {
            return Err("Invalid GPT signature".to_string());
        }
        let header_size = u32::from_le_bytes(s[12..16].try_into().unwrap());
        if header_size as usize != GPT_HEADER_SIZE {
            return Err(format!("Invalid GPT header size: {header_size}"));
        }
        let mut disk_guid = [0u8; 16];
        disk_guid.copy_from_slice(&s[56..72]);
        Ok(Self {
            signature,
            revision: u32::from_le_bytes(s[8..12].try_into().unwrap()),
            header_size,
            header_crc32: u32::from_le_bytes(s[16..20].try_into().unwrap()),
            reserved: u32::from_le_bytes(s[20..24].try_into().unwrap()),
            my_lba: u64::from_le_bytes(s[24..32].try_into().unwrap()),
            alternate_lba: u64::from_le_bytes(s[32..40].try_into().unwrap()),
            first_usable_lba: u64::from_le_bytes(s[40..48].try_into().unwrap()),
            last_usable_lba: u64::from_le_bytes(s[48..56].try_into().unwrap()),
            disk_guid,
            partition_entry_lba: u64::from_le_bytes(s[72..80].try_into().unwrap()),
            num_partition_entries: u32::from_le_bytes(s[80..84].try_into().unwrap()),
            size_of_partition_entry: u32::from_le_bytes(s[84..88].try_into().unwrap()),
            partition_entry_crc32: u32::from_le_bytes(s[88..92].try_into().unwrap()),
        })
    }

    fn to_bytes(&self) -> [u8; GPT_HEADER_SIZE] {
        let mut out = [0u8; GPT_HEADER_SIZE];
        out[0..8].copy_from_slice(&self.signature);
        out[8..12].copy_from_slice(&self.revision.to_le_bytes());
        out[12..16].copy_from_slice(&self.header_size.to_le_bytes());
        out[16..20].copy_from_slice(&self.header_crc32.to_le_bytes());
        out[20..24].copy_from_slice(&self.reserved.to_le_bytes());
        out[24..32].copy_from_slice(&self.my_lba.to_le_bytes());
        out[32..40].copy_from_slice(&self.alternate_lba.to_le_bytes());
        out[40..48].copy_from_slice(&self.first_usable_lba.to_le_bytes());
        out[48..56].copy_from_slice(&self.last_usable_lba.to_le_bytes());
        out[56..72].copy_from_slice(&self.disk_guid);
        out[72..80].copy_from_slice(&self.partition_entry_lba.to_le_bytes());
        out[80..84].copy_from_slice(&self.num_partition_entries.to_le_bytes());
        out[84..88].copy_from_slice(&self.size_of_partition_entry.to_le_bytes());
        out[88..92].copy_from_slice(&self.partition_entry_crc32.to_le_bytes());
        out
    }

    fn write_at_header_offset(&self, data: &mut [u8]) -> Result<(), String> {
        if data.len() < GPT_MIN_HEADER_SIZE {
            return Err(format!("GPT data is too small: {} bytes", data.len()));
        }
        let bytes = self.to_bytes();
        data[SECTOR_SIZE as usize..SECTOR_SIZE as usize + GPT_HEADER_SIZE].copy_from_slice(&bytes);
        Ok(())
    }

    fn update_crc32(&mut self) {
        self.header_crc32 = 0;
        let bytes = self.to_bytes();
        self.header_crc32 = crc32fast::hash(&bytes);
    }

    fn partition_entry_sectors(&self) -> Result<u64, String> {
        let bytes = u64::from(self.num_partition_entries)
            .checked_mul(u64::from(self.size_of_partition_entry))
            .ok_or_else(|| "GPT partition entry size overflows u64".to_string())?;
        Ok(bytes.div_ceil(SECTOR_SIZE))
    }
}

fn target_lbas(header: &GptHeader, total_size_bytes: u64) -> Result<(u64, u64), String> {
    let total_sectors = total_size_bytes / SECTOR_SIZE;
    let entries = header.partition_entry_sectors()?;
    let backup_lba = total_sectors
        .checked_sub(1)
        .ok_or_else(|| "GPT target size is too small".to_string())?;
    let last_usable_lba = backup_lba
        .checked_sub(entries + 1)
        .ok_or_else(|| "GPT target size is too small for partition entries".to_string())?;
    Ok((backup_lba, last_usable_lba))
}

fn modify_gpt_primary(data: &mut [u8], total_size_bytes: u64) -> Result<u64, String> {
    let mut header = GptHeader::parse(data)?;
    let (backup_lba, last_usable_lba) = target_lbas(&header, total_size_bytes)?;
    if last_usable_lba < header.last_usable_lba {
        header.last_usable_lba = last_usable_lba;
        header.alternate_lba = backup_lba;
        header.update_crc32();
        header.write_at_header_offset(data)?;
    }
    Ok(header.last_usable_lba)
}

fn modify_gpt_backup(
    backup_data: &mut [u8],
    total_size_bytes: u64,
    primary_data: &[u8],
) -> Result<(), String> {
    let primary = GptHeader::parse(primary_data)?;
    let (backup_lba, last_usable_lba) = target_lbas(&primary, total_size_bytes)?;
    let mut backup = primary;
    backup.my_lba = backup_lba;
    backup.alternate_lba = 1;
    backup.last_usable_lba = last_usable_lba;
    backup.partition_entry_lba = backup_lba
        .checked_sub(primary.partition_entry_sectors()?)
        .ok_or_else(|| "GPT target size is too small for backup entries".to_string())?;
    backup.update_crc32();
    backup.write_at_header_offset(backup_data)
}

fn sparse_expanded_size(data: &[u8]) -> Result<Option<u64>, String> {
    let Some(header) = SparseHeader::parse(data) else {
        return Ok(None);
    };
    if !header.is_valid() {
        return Ok(None);
    }
    u64::from(header.blk_sz)
        .checked_mul(u64::from(header.total_blks))
        .map(Some)
        .ok_or_else(|| "Sparse image expanded size overflows u64".to_string())
}

fn write_zeros(file: &mut File, length: u64) -> Result<(), String> {
    let zeros = [0u8; BUFFER_SIZE];
    let mut remaining = length;
    while remaining > 0 {
        let amount = remaining.min(zeros.len() as u64) as usize;
        file.write_all(&zeros[..amount])
            .map_err(|e| format!("Failed to write zero-filled sparse block: {e}"))?;
        remaining -= amount as u64;
    }
    Ok(())
}

fn write_fill(file: &mut File, pattern: [u8; 4], length: u64) -> Result<(), String> {
    let mut buffer = [0u8; BUFFER_SIZE];
    for chunk in buffer.chunks_exact_mut(4) {
        chunk.copy_from_slice(&pattern);
    }
    let mut remaining = length;
    while remaining > 0 {
        let amount = remaining.min(buffer.len() as u64) as usize;
        file.write_all(&buffer[..amount])
            .map_err(|e| format!("Failed to write sparse fill block: {e}"))?;
        remaining -= amount as u64;
    }
    Ok(())
}

fn decode_sparse(data: &[u8], file: &mut File) -> Result<u64, String> {
    let header = SparseHeader::parse(data)
        .filter(|h| h.is_valid())
        .ok_or_else(|| "Invalid Android sparse image header".to_string())?;
    let file_header_size = usize::from(header.file_hdr_sz);
    let chunk_header_size = usize::from(header.chunk_hdr_sz);
    let block_size = u64::from(header.blk_sz);
    let total_blocks = u64::from(header.total_blks);
    let total_chunks = header.total_chunks;
    let expected_total = block_size
        .checked_mul(total_blocks)
        .ok_or_else(|| "Sparse image expanded size overflows u64".to_string())?;

    let mut cursor = file_header_size;
    let mut written = 0u64;
    for index in 0..total_chunks {
        let header_end = cursor
            .checked_add(chunk_header_size)
            .ok_or_else(|| "Sparse chunk header offset overflows usize".to_string())?;
        let chunk_data = data
            .get(cursor..header_end)
            .ok_or_else(|| format!("Sparse chunk {index} header exceeds input"))?;
        let chunk = ChunkHeader::parse(chunk_data)
            .ok_or_else(|| format!("Sparse chunk {index} header is truncated"))?;
        let chunk_type = chunk.chunk_type;
        let chunk_blocks = u64::from(chunk.chunk_sz);
        let total_size = usize::try_from(chunk.total_sz)
            .map_err(|_| format!("Sparse chunk {index} size does not fit in memory"))?;
        if total_size < chunk_header_size {
            return Err(format!("Sparse chunk {index} total size is invalid"));
        }
        let payload_size = total_size - chunk_header_size;
        let payload_end = header_end
            .checked_add(payload_size)
            .ok_or_else(|| "Sparse chunk payload offset overflows usize".to_string())?;
        let payload = data
            .get(header_end..payload_end)
            .ok_or_else(|| format!("Sparse chunk {index} payload exceeds input"))?;
        let expanded = chunk_blocks
            .checked_mul(block_size)
            .ok_or_else(|| format!("Sparse chunk {index} expanded size overflows u64"))?;

        match chunk_type {
            CHUNK_TYPE_RAW => {
                if payload.len() as u64 != expanded {
                    return Err(format!(
                        "Sparse raw chunk {index} has an invalid payload size"
                    ));
                }
                file.write_all(payload)
                    .map_err(|e| format!("Failed to write sparse raw chunk: {e}"))?;
            }
            CHUNK_TYPE_FILL => {
                let pattern: [u8; 4] = payload
                    .try_into()
                    .map_err(|_| format!("Sparse fill chunk {index} must contain four bytes"))?;
                write_fill(file, pattern, expanded)?;
            }
            CHUNK_TYPE_DONT_CARE => {
                if !payload.is_empty() {
                    return Err(format!(
                        "Sparse skip chunk {index} has unexpected payload data"
                    ));
                }
                write_zeros(file, expanded)?;
            }
            CHUNK_TYPE_CRC32 => {
                if payload.len() != 4 || expanded != 0 {
                    return Err(format!("Sparse CRC chunk {index} is invalid"));
                }
            }
            other => return Err(format!("Unsupported sparse chunk type: 0x{other:04x}")),
        }
        written = written
            .checked_add(expanded)
            .ok_or_else(|| "Sparse output size overflows u64".to_string())?;
        cursor = payload_end;
    }

    if written != expected_total {
        return Err(format!(
            "Sparse output size mismatch: expected {expected_total}, wrote {written}"
        ));
    }
    Ok(written)
}

fn write_payload(file: &mut File, offset: u64, data: &[u8]) -> Result<u64, String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek to offset {offset}: {e}"))?;
    if sparse_expanded_size(data)?.is_some() {
        decode_sparse(data, file)
    } else {
        file.write_all(data)
            .map_err(|e| format!("Failed to write at offset {offset}: {e}"))?;
        Ok(data.len() as u64)
    }
}

fn component_subtypes(flash_type: &str, secure: bool) -> (&'static str, &'static str) {
    if secure {
        let toc0 = match flash_type {
            "ufs" => "TOC0_UFS00000000",
            _ => "TOC0_SDCARD00000",
        };
        (toc0, "TOC1_00000000000")
    } else {
        let boot0 = match flash_type {
            "ufs" => "1234567890BUFS_0",
            "nand" => "BOOT0_0000000000",
            _ => "1234567890BOOT_0",
        };
        (boot0, "BOOTPKG-00000000")
    }
}

fn write_component_twice(
    packer: &mut OpenixPacker,
    file: &mut File,
    name: &str,
    subtype: &str,
    primary: u64,
    backup: u64,
) -> Result<(), String> {
    if packer.find_file_header_by_subtype(subtype).is_none() {
        return Ok(());
    }
    let data = packer
        .find_file_data_by_subtype(subtype)
        .map_err(|e| format!("Failed to extract {name}: {e}"))?;
    write_payload(file, primary, &data)?;
    write_payload(file, backup, &data)?;
    Ok(())
}

fn convert_block<F>(
    packer: &mut OpenixPacker,
    output_path: &Path,
    logic_offset: u64,
    partitions: &[PartitionItem],
    flash_type: &'static str,
    is_secure: bool,
    storage_size: Option<u64>,
    mut progress: F,
) -> Result<u64, String>
where
    F: FnMut(f64, String),
{
    let partition_start = logic_offset
        .checked_add(MBR_LAYOUT_SIZE)
        .ok_or_else(|| "Partition start offset overflows u64".to_string())?;
    let end = partitions.iter().try_fold(partition_start, |offset, p| {
        offset
            .checked_add(p.size)
            .ok_or_else(|| format!("Partition {} range overflows u64", p.name))
    })?;
    let aligned_size = end
        .checked_add(SECTOR_SIZE - 1)
        .map(|v| v / SECTOR_SIZE * SECTOR_SIZE)
        .ok_or_else(|| "Aligned firmware size overflows u64".to_string())?;

    let gpt_target_size = match storage_size {
        Some(size) if size >= aligned_size => size,
        _ => aligned_size,
    };

    let mut file = File::create(output_path)
        .map_err(|e| format!("Failed to create output file {}: {e}", output_path.display()))?;
    file.set_len(aligned_size)
        .map_err(|e| format!("Failed to size output file: {e}"))?;

    progress(15.0, "写入引导组件 (Boot0/BOOTPKG)...".to_string());
    let (first_subtype, second_subtype) = component_subtypes(flash_type, is_secure);
    let (first_name, second_name) = if is_secure {
        ("TOC0", "TOC1")
    } else {
        ("Boot0", "BOOTPKG")
    };
    write_component_twice(
        packer,
        &mut file,
        first_name,
        first_subtype,
        BOOT0_OFFSET,
        BOOT0_BACKUP_OFFSET,
    )?;
    write_component_twice(
        packer,
        &mut file,
        second_name,
        second_subtype,
        UBOOT_OFFSET,
        UBOOT_BACKUP_OFFSET,
    )?;

    progress(25.0, "写入分区表 (GPT/MBR)...".to_string());
    if packer
        .find_file_header_by_subtype("1234567890___GPT")
        .is_some()
    {
        let data = packer
            .find_file_data_by_subtype("1234567890___GPT")
            .map_err(|e| format!("Failed to extract GPT: {e}"))?;
        let mut primary = data[..data.len().min(GPT_SIZE)].to_vec();
        if primary.len() >= GPT_MIN_HEADER_SIZE {
            let _ = modify_gpt_primary(&mut primary, gpt_target_size);
        }
        write_payload(&mut file, 0, &primary)?;
        let mut backup = primary.clone();
        let _ = modify_gpt_backup(&mut backup, gpt_target_size, &primary);
        write_payload(&mut file, logic_offset, &backup)?;
    } else if packer
        .find_file_header_by_subtype("1234567890___MBR")
        .is_some()
    {
        let data = packer
            .find_file_data_by_subtype("1234567890___MBR")
            .map_err(|e| format!("Failed to extract MBR: {e}"))?;
        write_payload(
            &mut file,
            logic_offset,
            &data[..data.len().min(MBR_LAYOUT_SIZE as usize)],
        )?;
    }

    let total_parts = partitions.len().max(1);
    let mut partition_offset = partition_start;
    for (idx, partition) in partitions.iter().enumerate() {
        let partition_end = partition_offset
            .checked_add(partition.size)
            .ok_or_else(|| format!("Partition {} range overflows u64", partition.name))?;
        if !partition.download_file.is_empty() {
            let subtype = packer.build_subtype_by_filename(&partition.download_file);
            if packer.find_file_header_by_subtype(&subtype).is_some() {
                let data = packer
                    .find_file_data_by_subtype(&subtype)
                    .map_err(|e| format!("Failed to extract partition {}: {e}", partition.name))?;
                let expanded = sparse_expanded_size(&data)?.unwrap_or(data.len() as u64);
                if expanded > partition.size {
                    return Err(format!(
                        "Partition {} data size {expanded} exceeds partition size {}",
                        partition.name, partition.size
                    ));
                }
                write_payload(&mut file, partition_offset, &data)?;
            }
        }
        let pct = 25.0 + ((idx + 1) as f64 / total_parts as f64) * 70.0;
        progress(pct, format!("写入分区 {}...", partition.name));
        partition_offset = partition_end;
    }

    let current_size = file
        .metadata()
        .map_err(|e| format!("Failed to read output size: {e}"))?
        .len();
    let output_size = current_size
        .max(aligned_size)
        .checked_add(SECTOR_SIZE - 1)
        .map(|v| v / SECTOR_SIZE * SECTOR_SIZE)
        .ok_or_else(|| "Output size alignment overflows u64".to_string())?;
    file.set_len(output_size)
        .map_err(|e| format!("Failed to finalize output size: {e}"))?;
    file.flush()
        .map_err(|e| format!("Failed to flush output file: {e}"))?;
    progress(100.0, "转换完成".to_string());
    Ok(output_size)
}

fn checked_range(
    offset: u64,
    length: u64,
    capacity: u64,
    component: &str,
) -> Result<Range<usize>, String> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| format!("{component} range overflows u64"))?;
    if end > capacity {
        return Err(format!("{component} exceeds NOR size"));
    }
    Ok(
        usize::try_from(offset).map_err(|_| format!("{component} offset does not fit in memory"))?
            ..usize::try_from(end)
                .map_err(|_| format!("{component} end offset does not fit in memory"))?,
    )
}

fn copy_nor_component(
    packer: &mut OpenixPacker,
    output: &mut [u8],
    subtype: &str,
    offset: u64,
    capacity: u64,
    name: &str,
) -> Result<(), String> {
    if packer.find_file_header_by_subtype(subtype).is_none() {
        return Ok(());
    }
    let data = packer
        .find_file_data_by_subtype(subtype)
        .map_err(|e| format!("Failed to extract {name}: {e}"))?;
    let range = checked_range(offset, data.len() as u64, capacity, name)?;
    output[range].copy_from_slice(&data);
    Ok(())
}

fn convert_spinor<F>(
    packer: &mut OpenixPacker,
    output_path: &Path,
    logic_start: u64,
    uboot_start: u64,
    partitions: &[PartitionItem],
    nor_size: u64,
    mut progress: F,
) -> Result<u64, String>
where
    F: FnMut(f64, String),
{
    if nor_size == 0 {
        return Err("NOR size must be greater than zero".to_string());
    }
    const NOR_GPT_SIZE: u64 = 16 * 1024;
    let mut check_offset = logic_start
        .checked_add(NOR_GPT_SIZE)
        .ok_or_else(|| "Partition start offset overflows u64".to_string())?;
    for p in partitions {
        check_offset = check_offset
            .checked_add(p.size)
            .ok_or_else(|| format!("Partition {} range overflows u64", p.name))?;
        if check_offset > nor_size {
            return Err(format!("Partition {} exceeds NOR size", p.name));
        }
    }

    let capacity =
        usize::try_from(nor_size).map_err(|_| "NOR size does not fit in memory".to_string())?;
    let mut output = vec![0xffu8; capacity];

    progress(15.0, "写入 SPI NOR 引导与 GPT...".to_string());
    copy_nor_component(packer, &mut output, "1234567890BNOR_0", 0, nor_size, "Boot0")?;
    copy_nor_component(
        packer,
        &mut output,
        "BOOTPKG-NOR00000",
        uboot_start,
        nor_size,
        "U-Boot",
    )?;
    copy_nor_component(
        packer,
        &mut output,
        "1234567890___GPT",
        logic_start,
        nor_size,
        "GPT",
    )?;

    let total_parts = partitions.len().max(1);
    let mut partition_offset = logic_start + NOR_GPT_SIZE;
    for (idx, p) in partitions.iter().enumerate() {
        let partition_end = partition_offset + p.size;
        if !p.download_file.is_empty() {
            let subtype = packer.build_subtype_by_filename(&p.download_file);
            if packer.find_file_header_by_subtype(&subtype).is_some() {
                let data = packer
                    .find_file_data_by_subtype(&subtype)
                    .map_err(|e| format!("Failed to extract partition {}: {e}", p.name))?;
                if data.len() as u64 > p.size {
                    return Err(format!("Partition {} file size exceeds partition size", p.name));
                }
                let range = checked_range(
                    partition_offset,
                    data.len() as u64,
                    nor_size,
                    &format!("Partition {}", p.name),
                )?;
                output[range].copy_from_slice(&data);
            }
        }
        let pct = 20.0 + ((idx + 1) as f64 / total_parts as f64) * 70.0;
        progress(pct, format!("写入 SPI NOR 分区 {}...", p.name));
        partition_offset = partition_end;
    }

    progress(95.0, "写入 SPI NOR 输出镜像...".to_string());
    let mut file = File::create(output_path)
        .map_err(|e| format!("Failed to create output file {}: {e}", output_path.display()))?;
    file.write_all(&output)
        .map_err(|e| format!("Failed to write output file: {e}"))?;
    file.flush()
        .map_err(|e| format!("Failed to flush output file: {e}"))?;
    progress(100.0, "SPI NOR 转换完成".to_string());
    Ok(nor_size)
}

pub fn run_convert<F>(options: ConvertOptions, mut progress: F) -> Result<u64, String>
where
    F: FnMut(f64, String),
{
    if !options.firmware_path.is_file() {
        return Err(format!(
            "Firmware file not found: {}",
            options.firmware_path.display()
        ));
    }
    reject_input_as_output(&options.firmware_path, &options.output_path)?;

    progress(5.0, "加载 IMAGEWTY 固件并解析分区表与 DTB...".to_string());
    let mut packer = OpenixPacker::new();
    packer
        .load(&options.firmware_path)
        .map_err(|e| format!("Failed to load firmware: {e}"))?;

    let partitions = load_partitions(&mut packer)?;
    let offsets = detect_flash_offsets(&mut packer);
    let is_secure = match options.secure {
        SecureMode::Auto => packer.is_secure_firmware(),
        SecureMode::Enabled => true,
        SecureMode::Disabled => false,
    };

    if options.target == ConvertTarget::Spinor {
        let logic_start = options
            .logic_offset
            .or(offsets.nor_logic_offset)
            .unwrap_or(1024);
        let uboot_start = options
            .uboot_start
            .or(offsets.nor_uboot_start)
            .unwrap_or(48);
        convert_spinor(
            &mut packer,
            &options.output_path,
            checked_scale(logic_start, SECTOR_SIZE, "Logic offset")?,
            checked_scale(uboot_start, SECTOR_SIZE, "U-Boot offset")?,
            &partitions,
            checked_scale(options.nor_size, MEBIBYTE, "NOR size")?,
            progress,
        )
    } else {
        let logic_offset = options
            .logic_offset
            .or(offsets.sdmmc_logic_offset)
            .unwrap_or(40960);
        convert_block(
            &mut packer,
            &options.output_path,
            checked_scale(logic_offset, SECTOR_SIZE, "Logic offset")?,
            &partitions,
            options.target.flash_type(),
            is_secure,
            parse_storage_size(&options.storage_size)?,
            progress,
        )
    }
}
