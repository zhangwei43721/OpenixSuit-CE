#![allow(dead_code)]

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const IMAGEWTY_MAGIC: &str = "IMAGEWTY";
pub const IMAGEWTY_MAGIC_LEN: usize = 8;
pub const IMAGEWTY_FILEHDR_LEN: usize = 1024;
pub const IMAGEWTY_FHDR_MAINTYPE_LEN: usize = 8;
pub const IMAGEWTY_FHDR_SUBTYPE_LEN: usize = 16;
pub const IMAGEWTY_FHDR_FILENAME_LEN: usize = 256;
const PARTITION_DOWNLOADFILE_SUFFIX: &str = "0000000000";

pub const MBR_MAGIC: &str = "softw411";
pub const MBR_VERSION: u32 = 0x00000200;
pub const MBR_SIZE: usize = 16 * 1024;
pub const PART_NAME_MAX_LEN: usize = 16;
pub const PART_SIZE_RES_LEN: usize = 68;
pub const MBR_MAX_PART_CNT: usize = 120;
pub const EFEX_CRC32_VALID_FLAG: u32 = 0x6a617603;

pub const WORK_MODE_USB_PRODUCT: u32 = 0x10;
pub const BOOT_FILE_MODE_NORMAL: u32 = 0;
pub const BOOT_FILE_MODE_TOC: u32 = 1;
pub const BOOT_FILE_MODE_PKG: u32 = 4;

pub const SPARSE_HEADER_MAGIC: u32 = 0xed26ff3a;
pub const SPARSE_HEADER_MAJOR_VER: u16 = 1;
pub const CHUNK_TYPE_RAW: u16 = 0xcac1;
pub const CHUNK_TYPE_FILL: u16 = 0xcac2;
pub const CHUNK_TYPE_DONT_CARE: u16 = 0xcac3;
pub const CHUNK_TYPE_CRC32: u16 = 0xcac4;
pub const SPARSE_HEADER_SIZE: usize = 28;
pub const CHUNK_HEADER_SIZE: usize = 12;
pub const SECTOR_SIZE: u64 = 512;
pub const MIN_DOWNLOAD_SIZE: usize = 8 * 1024;
pub const ALIGNMENT_SIZE: usize = 4 * 1024;
pub const MAX_FILL_COUNT: u32 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageType {
    Nand = 0,
    Sdcard = 1,
    Emmc = 2,
    Spinor = 3,
    Emmc3 = 4,
    Spinand = 5,
    Sd1 = 6,
    Emmc0 = 7,
    Ufs = 8,
    Auto = -1,
}

impl From<i32> for StorageType {
    fn from(value: i32) -> Self {
        match value {
            0 => StorageType::Nand,
            1 => StorageType::Sdcard,
            2 => StorageType::Emmc,
            3 => StorageType::Spinor,
            4 => StorageType::Emmc3,
            5 => StorageType::Spinand,
            6 => StorageType::Sd1,
            7 => StorageType::Emmc0,
            8 => StorageType::Ufs,
            _ => StorageType::Auto,
        }
    }
}

impl From<u32> for StorageType {
    fn from(value: u32) -> Self {
        StorageType::from(value as i32)
    }
}

impl std::fmt::Display for StorageType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageType::Auto => write!(f, "Auto"),
            StorageType::Nand => write!(f, "NAND"),
            StorageType::Spinand => write!(f, "SPI NAND"),
            StorageType::Spinor => write!(f, "SPI NOR"),
            StorageType::Sdcard => write!(f, "SD Card"),
            StorageType::Emmc => write!(f, "eMMC"),
            StorageType::Emmc3 => write!(f, "eMMC3"),
            StorageType::Emmc0 => write!(f, "eMMC0"),
            StorageType::Sd1 => write!(f, "SD1"),
            StorageType::Ufs => write!(f, "UFS"),
        }
    }
}

pub fn get_sunxi_boot_file_mode_string(mode: u32) -> &'static str {
    match mode {
        BOOT_FILE_MODE_NORMAL => "Normal Boot File",
        BOOT_FILE_MODE_TOC => "TOC Boot File",
        2 => "Reserved Boot File 0",
        3 => "Reserved Boot File 1",
        BOOT_FILE_MODE_PKG => "Boot Package File",
        _ => "Unknown Boot File Type",
    }
}

#[inline]
fn read_u16_le(data: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([data[off], data[off + 1]])
}

#[inline]
fn read_u32_le(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}

#[inline]
fn read_u64_split(data: &[u8], lo_off: usize) -> u64 {
    let lo = read_u32_le(data, lo_off) as u64;
    let hi = read_u32_le(data, lo_off + 4) as u64;
    lo | (hi << 32)
}

#[derive(Debug, Clone)]
pub struct ImageHeader {
    pub magic: String,
    pub header_version: u32,
    pub image_size: u64,
    pub num_files: u32,
    pub pid: u32,
    pub vid: u32,
    pub hardware_id: u32,
    pub firmware_id: u32,
}

impl ImageHeader {
    pub fn parse(data: &[u8]) -> Result<Self, &'static str> {
        if data.len() < 100 {
            return Err("Data too short for ImageHeader");
        }
        let magic = String::from_utf8_lossy(&data[0..8]).to_string();
        let header_version = read_u32_le(data, 8);
        if header_version == 0x0300 {
            let image_size = read_u64_split(data, 24);
            let pid = read_u32_le(data, 36);
            let vid = read_u32_le(data, 40);
            let hardware_id = read_u32_le(data, 44);
            let firmware_id = read_u32_le(data, 48);
            let num_files = read_u32_le(data, 0x3c);
            Ok(Self {
                magic,
                header_version,
                image_size,
                num_files,
                pid,
                vid,
                hardware_id,
                firmware_id,
            })
        } else {
            let image_size = read_u32_le(data, 24) as u64;
            let pid = read_u32_le(data, 32);
            let vid = read_u32_le(data, 36);
            let hardware_id = read_u32_le(data, 40);
            let firmware_id = read_u32_le(data, 44);
            let num_files = read_u32_le(data, 0x38);
            Ok(Self {
                magic,
                header_version,
                image_size,
                num_files,
                pid,
                vid,
                hardware_id,
                firmware_id,
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileInfo {
    pub filename: String,
    pub maintype: String,
    pub subtype: String,
    pub stored_length: u64,
    pub original_length: u64,
    pub offset: u64,
}

impl FileInfo {
    fn parse(data: &[u8], header_version: u32) -> Result<Self, &'static str> {
        if data.len() < IMAGEWTY_FILEHDR_LEN {
            return Err("Data too short for FileHeader");
        }
        let maintype = String::from_utf8_lossy(&data[8..16])
            .trim_end_matches(['\0', ' '])
            .to_string();
        let subtype = String::from_utf8_lossy(&data[16..32])
            .trim_end_matches(['\0', ' '])
            .to_string();

        if header_version == 0x0300 {
            let name_slice = &data[0x24..0x124];
            let end = name_slice
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(name_slice.len());
            let filename = String::from_utf8_lossy(&name_slice[..end]).to_string();
            let stored_length = read_u64_split(data, 0x124);
            let original_length = read_u64_split(data, 0x12c);
            let offset = read_u64_split(data, 0x134);
            Ok(Self {
                filename,
                maintype,
                subtype,
                stored_length,
                original_length,
                offset,
            })
        } else {
            let stored_length = read_u32_le(data, 0x24) as u64;
            let original_length = read_u32_le(data, 0x28) as u64;
            let offset = read_u32_le(data, 0x2c) as u64;
            let name_slice = &data[0x34..0x134];
            let end = name_slice
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(name_slice.len());
            let filename = String::from_utf8_lossy(&name_slice[..end]).to_string();
            Ok(Self {
                filename,
                maintype,
                subtype,
                stored_length,
                original_length,
                offset,
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImageInfo {
    pub files: Vec<FileInfo>,
    pub is_encrypted: bool,
    pub image_size: u64,
    pub num_files: u32,
}

pub struct ImageDataEntry {
    pub name: &'static str,
    pub maintype: &'static str,
    pub subtype: &'static str,
}

pub const IMAGE_DATA_TABLE: &[ImageDataEntry] = &[
    ImageDataEntry {
        name: "fes",
        maintype: "FES",
        subtype: "FES_1-0000000000",
    },
    ImageDataEntry {
        name: "uboot",
        maintype: "12345678",
        subtype: "UBOOT_0000000000",
    },
    ImageDataEntry {
        name: "uboot_crash",
        maintype: "12345678",
        subtype: "UBOOT_CRASH_0000",
    },
    ImageDataEntry {
        name: "mbr",
        maintype: "12345678",
        subtype: "1234567890___MBR",
    },
    ImageDataEntry {
        name: "gpt",
        maintype: "12345678",
        subtype: "1234567890___GPT",
    },
    ImageDataEntry {
        name: "sys_config",
        maintype: "COMMON",
        subtype: "SYS_CONFIG100000",
    },
    ImageDataEntry {
        name: "sys_config_bin",
        maintype: "COMMON",
        subtype: "SYS_CONFIG_BIN00",
    },
    ImageDataEntry {
        name: "sys_partition",
        maintype: "COMMON",
        subtype: "SYS_CONFIG000000",
    },
    ImageDataEntry {
        name: "board_config",
        maintype: "COMMON",
        subtype: "BOARD_CONFIG_BIN",
    },
    ImageDataEntry {
        name: "dtb",
        maintype: "COMMON",
        subtype: "DTB_CONFIG000000",
    },
    ImageDataEntry {
        name: "boot0_nand",
        maintype: "BOOT",
        subtype: "BOOT0_0000000000",
    },
    ImageDataEntry {
        name: "boot0_card",
        maintype: "12345678",
        subtype: "1234567890BOOT_0",
    },
    ImageDataEntry {
        name: "boot0_nor",
        maintype: "12345678",
        subtype: "1234567890BNOR_0",
    },
    ImageDataEntry {
        name: "bootpkg",
        maintype: "12345678",
        subtype: "BOOTPKG-00000000",
    },
    ImageDataEntry {
        name: "bootpkg_nor",
        maintype: "12345678",
        subtype: "BOOTPKG-NOR00000",
    },
];

pub fn get_image_data_entry(name: &str) -> Option<&'static ImageDataEntry> {
    IMAGE_DATA_TABLE.iter().find(|entry| entry.name == name)
}

#[derive(Debug, thiserror::Error)]
pub enum PackerError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Encrypted firmware not supported")]
    EncryptedNotSupported,
    #[error("Unknown header version: 0x{0:04x}")]
    UnknownHeaderVersion(u32),
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Image not loaded")]
    ImageNotLoaded,
    #[error("Parse error: {0}")]
    ParseError(&'static str),
    #[error("Invalid data range: start={start}, length={length}, available={available}")]
    InvalidRange {
        start: u64,
        length: u64,
        available: u64,
    },
}

pub struct OpenixPacker {
    file: Option<File>,
    image_header: Option<ImageHeader>,
    file_headers: Vec<FileInfo>,
    is_encrypted: bool,
    image_loaded: bool,
}

impl Default for OpenixPacker {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenixPacker {
    pub fn new() -> Self {
        Self {
            file: None,
            image_header: None,
            file_headers: Vec::new(),
            is_encrypted: false,
            image_loaded: false,
        }
    }

    pub fn load<P: AsRef<Path>>(&mut self, path: P) -> Result<(), PackerError> {
        self.file = None;
        self.image_header = None;
        self.file_headers.clear();
        self.is_encrypted = false;
        self.image_loaded = false;

        let mut file = File::open(path)?;
        let file_size = file.metadata()?.len();

        let mut magic_buf = [0u8; IMAGEWTY_MAGIC_LEN];
        file.read_exact(&mut magic_buf)?;
        if magic_buf != IMAGEWTY_MAGIC.as_bytes() {
            self.is_encrypted = true;
            return Err(PackerError::EncryptedNotSupported);
        }

        file.seek(SeekFrom::Start(0))?;
        let mut header_buf = [0u8; IMAGEWTY_FILEHDR_LEN];
        file.read_exact(&mut header_buf)?;

        let image_header = ImageHeader::parse(&header_buf).map_err(PackerError::ParseError)?;
        if !matches!(image_header.header_version, 0x0100 | 0x0200 | 0x0300) {
            return Err(PackerError::UnknownHeaderVersion(
                image_header.header_version,
            ));
        }

        let num_files = image_header.num_files;
        let headers_size = u64::from(num_files)
            .checked_add(1)
            .and_then(|c| c.checked_mul(IMAGEWTY_FILEHDR_LEN as u64))
            .ok_or(PackerError::ParseError("File header count overflow"))?;
        if headers_size > file_size {
            return Err(PackerError::ParseError(
                "File header table exceeds firmware size",
            ));
        }

        let mut file_headers = Vec::with_capacity(num_files as usize);
        for i in 0..num_files {
            let offset = IMAGEWTY_FILEHDR_LEN as u64 + (i as u64) * IMAGEWTY_FILEHDR_LEN as u64;
            file.seek(SeekFrom::Start(offset))?;
            let mut fh_buf = [0u8; IMAGEWTY_FILEHDR_LEN];
            file.read_exact(&mut fh_buf)?;
            let fh = FileInfo::parse(&fh_buf, image_header.header_version)
                .map_err(PackerError::ParseError)?;
            file_headers.push(fh);
        }

        self.file = Some(file);
        self.image_header = Some(image_header);
        self.file_headers = file_headers;
        self.image_loaded = true;
        Ok(())
    }

    pub fn get_image_info(&self) -> ImageInfo {
        ImageInfo {
            files: self.file_headers.clone(),
            is_encrypted: self.is_encrypted,
            image_size: self.image_header.as_ref().map(|h| h.image_size).unwrap_or(0),
            num_files: self.image_header.as_ref().map(|h| h.num_files).unwrap_or(0),
        }
    }

    pub fn get_file_header_by_filename(&self, filename: &str) -> Option<&FileInfo> {
        self.file_headers.iter().find(|fh| fh.filename == filename)
    }

    pub fn get_file_header_by_maintype_subtype(
        &self,
        maintype: &str,
        subtype: &str,
    ) -> Option<&FileInfo> {
        self.file_headers
            .iter()
            .find(|fh| fh.maintype == maintype && fh.subtype == subtype)
    }

    pub fn find_file_header_by_subtype(&self, subtype: &str) -> Option<&FileInfo> {
        self.file_headers.iter().find(|fh| fh.subtype == subtype)
    }

    fn effective_length(fh: &FileInfo) -> u64 {
        if fh.original_length > 0 {
            fh.original_length
        } else {
            fh.stored_length
        }
    }

    pub fn find_file_data_by_subtype(&mut self, subtype: &str) -> Result<Vec<u8>, PackerError> {
        if !self.image_loaded {
            return Err(PackerError::ImageNotLoaded);
        }
        let fh = self
            .find_file_header_by_subtype(subtype)
            .ok_or_else(|| PackerError::FileNotFound(subtype.to_string()))?
            .clone();
        self.read_data_at_offset(fh.offset, Self::effective_length(&fh))
    }

    pub fn get_file_data_by_maintype_subtype(
        &mut self,
        maintype: &str,
        subtype: &str,
    ) -> Result<Vec<u8>, PackerError> {
        if !self.image_loaded {
            return Err(PackerError::ImageNotLoaded);
        }
        let fh = self
            .get_file_header_by_maintype_subtype(maintype, subtype)
            .ok_or_else(|| PackerError::FileNotFound(format!("{}/{}", maintype, subtype)))?
            .clone();
        self.read_data_at_offset(fh.offset, Self::effective_length(&fh))
    }

    pub fn get_file_info_by_maintype_subtype(
        &self,
        maintype: &str,
        subtype: &str,
    ) -> Option<(u64, u64)> {
        if !self.image_loaded {
            return None;
        }
        let fh = self.get_file_header_by_maintype_subtype(maintype, subtype)?;
        Some((fh.offset, Self::effective_length(fh)))
    }

    pub fn get_file_info_by_filename(&self, filename: &str) -> Option<(u64, u64)> {
        if !self.image_loaded {
            return None;
        }
        let fh = self.get_file_header_by_filename(filename)?;
        Some((fh.offset, Self::effective_length(fh)))
    }

    fn read_data_at_offset(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, PackerError> {
        let file = self.file.as_mut().ok_or(PackerError::ImageNotLoaded)?;
        let file_size = file.metadata()?.len();
        let end = offset.checked_add(length).ok_or(PackerError::InvalidRange {
            start: offset,
            length,
            available: file_size,
        })?;
        if end > file_size {
            return Err(PackerError::InvalidRange {
                start: offset,
                length,
                available: file_size,
            });
        }
        let buffer_len = usize::try_from(length).map_err(|_| PackerError::InvalidRange {
            start: offset,
            length,
            available: file_size,
        })?;
        file.seek(SeekFrom::Start(offset))?;
        let mut buffer = vec![0u8; buffer_len];
        file.read_exact(&mut buffer)?;
        Ok(buffer)
    }

    pub fn get_file_data_range_by_maintype_subtype(
        &mut self,
        maintype: &str,
        subtype: &str,
        start: u64,
        length: u64,
    ) -> Result<Vec<u8>, PackerError> {
        if !self.image_loaded {
            return Err(PackerError::ImageNotLoaded);
        }
        let fh = self
            .get_file_header_by_maintype_subtype(maintype, subtype)
            .ok_or_else(|| PackerError::FileNotFound(format!("{}/{}", maintype, subtype)))?
            .clone();
        let original_length = Self::effective_length(&fh);
        let end = start.checked_add(length).ok_or(PackerError::InvalidRange {
            start,
            length,
            available: original_length,
        })?;
        if end > original_length {
            return Err(PackerError::InvalidRange {
                start,
                length,
                available: original_length,
            });
        }
        let abs_start = fh.offset.checked_add(start).ok_or(PackerError::InvalidRange {
            start,
            length,
            available: original_length,
        })?;
        self.read_data_at_offset(abs_start, length)
    }

    pub fn get_file_data_range_by_filename(
        &mut self,
        filename: &str,
        start: u64,
        length: u64,
    ) -> Result<Vec<u8>, PackerError> {
        if !self.image_loaded {
            return Err(PackerError::ImageNotLoaded);
        }
        let fh = self
            .get_file_header_by_filename(filename)
            .ok_or_else(|| PackerError::FileNotFound(filename.to_string()))?
            .clone();
        let original_length = Self::effective_length(&fh);
        let end = start.checked_add(length).ok_or(PackerError::InvalidRange {
            start,
            length,
            available: original_length,
        })?;
        if end > original_length {
            return Err(PackerError::InvalidRange {
                start,
                length,
                available: original_length,
            });
        }
        let abs_start = fh.offset.checked_add(start).ok_or(PackerError::InvalidRange {
            start,
            length,
            available: original_length,
        })?;
        self.read_data_at_offset(abs_start, length)
    }

    pub fn build_subtype_by_filename(&self, partition_name: &str) -> String {
        let suffix = format!(
            "{}{}",
            partition_name.to_uppercase().replace('.', "_"),
            PARTITION_DOWNLOADFILE_SUFFIX
        );
        let mut subtype = String::with_capacity(16);
        for ch in suffix.chars() {
            if subtype.len() + ch.len_utf8() > 16 {
                break;
            }
            subtype.push(ch);
        }
        while subtype.len() < 16 {
            subtype.push('0');
        }
        subtype
    }

    pub fn get_image_data_by_name(&mut self, name: &str) -> Result<Vec<u8>, PackerError> {
        if let Some(entry) = get_image_data_entry(name) {
            self.get_file_data_by_maintype_subtype(entry.maintype, entry.subtype)
        } else {
            Err(PackerError::FileNotFound(name.to_string()))
        }
    }

    pub fn get_sys_partition(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("sys_partition")
    }

    pub fn get_fes(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("fes")
    }

    pub fn get_uboot(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("uboot")
    }

    pub fn is_secure_firmware(&mut self) -> bool {
        self.get_uboot()
            .ok()
            .and_then(|uboot| uboot_secure_mode(&uboot))
            .unwrap_or(0)
            != 0
    }

    pub fn get_mbr(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("mbr")
    }

    pub fn get_dtb(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("dtb")
    }

    pub fn get_sys_config_bin(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("sys_config_bin")
    }

    pub fn get_board_config(&mut self) -> Result<Vec<u8>, PackerError> {
        self.get_image_data_by_name("board_config")
    }
}

#[derive(Debug, Clone)]
pub struct Boot0HeaderInfo {
    pub magic: String,
    pub ret_addr: u32,
    pub run_addr: u32,
    pub platform: String,
}

impl Boot0HeaderInfo {
    pub fn parse(data: &[u8]) -> Result<Self, &'static str> {
        if data.len() < 48 {
            return Err("Data too short for Boot0 header");
        }
        Ok(Self {
            magic: String::from_utf8_lossy(&data[4..12]).to_string(),
            ret_addr: read_u32_le(data, 28),
            run_addr: read_u32_le(data, 32),
            platform: String::from_utf8_lossy(&data[40..48]).to_string(),
        })
    }
}

pub const UBOOT_BASE_HEADER_LEN: usize = 48;
pub const UBOOT_DATA_HEADER_LEN: usize = 1248;
pub const UBOOT_HEADER_LEN: usize = UBOOT_BASE_HEADER_LEN + UBOOT_DATA_HEADER_LEN;
const UBOOT_WORK_MODE_OFFSET: usize = UBOOT_BASE_HEADER_LEN + 176;
const UBOOT_SECURE_MODE_OFFSET: usize = UBOOT_BASE_HEADER_LEN + 1238;

pub fn uboot_run_addr(data: &[u8]) -> Result<u32, &'static str> {
    if data.len() < UBOOT_HEADER_LEN {
        return Err("Data too short for U-Boot header");
    }
    Ok(read_u32_le(data, 44))
}

pub fn uboot_magic_str(data: &[u8]) -> String {
    if data.len() < 12 {
        return String::new();
    }
    String::from_utf8_lossy(&data[4..12]).to_string()
}

pub fn uboot_set_work_mode(data: &mut [u8], mode: u32) {
    if data.len() >= UBOOT_HEADER_LEN {
        data[UBOOT_WORK_MODE_OFFSET..UBOOT_WORK_MODE_OFFSET + 4]
            .copy_from_slice(&(mode as i32).to_le_bytes());
    }
}

pub fn uboot_secure_mode(data: &[u8]) -> Option<u8> {
    data.get(UBOOT_SECURE_MODE_OFFSET).copied()
}

#[derive(Debug, Clone)]
pub struct DramParamInfo {
    pub dram_init_flag: u32,
    pub dram_update_flag: u32,
    pub dram_para: [u32; 32],
}

pub const DRAM_PARAM_INFO_LEN: usize = 136;

impl DramParamInfo {
    pub fn create_empty() -> Self {
        Self {
            dram_init_flag: 0,
            dram_update_flag: 0,
            dram_para: [0u32; 32],
        }
    }

    pub fn parse(data: &[u8]) -> Result<Self, &'static str> {
        if data.len() < DRAM_PARAM_INFO_LEN {
            return Err("Data too short for DRAM param");
        }
        let mut dram_para = [0u32; 32];
        for (i, slot) in dram_para.iter_mut().enumerate() {
            *slot = read_u32_le(data, 8 + i * 4);
        }
        Ok(Self {
            dram_init_flag: read_u32_le(data, 0),
            dram_update_flag: read_u32_le(data, 4),
            dram_para,
        })
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut out = vec![0u8; DRAM_PARAM_INFO_LEN];
        out[0..4].copy_from_slice(&self.dram_init_flag.to_le_bytes());
        out[4..8].copy_from_slice(&self.dram_update_flag.to_le_bytes());
        for (i, val) in self.dram_para.iter().enumerate() {
            out[8 + i * 4..12 + i * 4].copy_from_slice(&val.to_le_bytes());
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct SunxiPartition {
    pub addrhi: u32,
    pub addrlo: u32,
    pub lenhi: u32,
    pub lenlo: u32,
    pub classname: String,
    pub name: String,
    pub user_type: u32,
    pub keydata: u32,
    pub ro: u32,
}

impl SunxiPartition {
    pub fn address(&self) -> u64 {
        ((self.addrhi as u64) << 32) | (self.addrlo as u64)
    }

    pub fn length(&self) -> u64 {
        ((self.lenhi as u64) << 32) | (self.lenlo as u64)
    }

    pub fn readonly(&self) -> bool {
        self.ro != 0
    }
}

#[derive(Debug, Clone)]
pub struct SunxiMbr {
    pub crc32: u32,
    pub version: u32,
    pub magic: String,
    pub copy: u32,
    pub index: u32,
    pub part_count: u32,
    pub stamp: u32,
    pub partitions: Vec<SunxiPartition>,
}

impl SunxiMbr {
    pub fn parse(data: &[u8]) -> Result<Self, &'static str> {
        if data.len() < MBR_SIZE {
            return Err("Data too short for Sunxi MBR");
        }
        let magic = String::from_utf8_lossy(&data[8..16]).to_string();
        if magic != MBR_MAGIC {
            return Err("Invalid MBR magic");
        }
        let part_count = read_u32_le(data, 24);
        if part_count as usize > MBR_MAX_PART_CNT {
            return Err("Partition count exceeds MBR capacity");
        }
        let mut partitions = Vec::with_capacity(part_count as usize);
        for i in 0..part_count as usize {
            let off = 32 + i * 128;
            let addrhi = read_u32_le(data, off);
            let addrlo = read_u32_le(data, off + 4);
            let lenhi = read_u32_le(data, off + 8);
            let lenlo = read_u32_le(data, off + 12);
            let classname = String::from_utf8_lossy(&data[off + 16..off + 32])
                .trim_end_matches('\0')
                .to_string();
            let name = String::from_utf8_lossy(&data[off + 32..off + 48])
                .trim_end_matches('\0')
                .to_string();
            let user_type = read_u32_le(data, off + 48);
            let keydata = read_u32_le(data, off + 52);
            let ro = read_u32_le(data, off + 56);
            partitions.push(SunxiPartition {
                addrhi,
                addrlo,
                lenhi,
                lenlo,
                classname,
                name,
                user_type,
                keydata,
                ro,
            });
        }
        Ok(Self {
            crc32: read_u32_le(data, 0),
            version: read_u32_le(data, 4),
            magic,
            copy: read_u32_le(data, 16),
            index: read_u32_le(data, 20),
            part_count,
            stamp: read_u32_le(data, 28),
            partitions,
        })
    }
}

pub fn is_valid_mbr(data: &[u8]) -> bool {
    SunxiMbr::parse(data).is_ok()
}

#[derive(Debug, Clone, Default)]
pub struct PartitionConfig {
    pub name: String,
    pub size: u64,
    pub downloadfile: String,
    pub user_type: u32,
    pub keydata: bool,
    pub encrypt: bool,
    pub verify: bool,
    pub readonly: bool,
}

#[derive(Default)]
pub struct OpenixPartition {
    partitions: Vec<PartitionConfig>,
}

impl OpenixPartition {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn parse_from_data(&mut self, data: &[u8]) -> bool {
        let content = String::from_utf8_lossy(data);
        self.parse_from_content(&content)
    }

    fn parse_from_content(&mut self, content: &str) -> bool {
        self.partitions.clear();
        let mut in_partition_section = false;
        let mut current = PartitionConfig::default();

        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with(';') || line.starts_with("//") {
                continue;
            }
            if line == "[partition_start]" {
                in_partition_section = true;
                continue;
            }
            if line == "[partition]" {
                if !current.name.is_empty() {
                    self.partitions.push(current.clone());
                }
                current = PartitionConfig::default();
                in_partition_section = true;
                continue;
            }
            if line.starts_with('[') && line.ends_with(']') {
                if line != "[partition]" && line != "[partition_start]" && line != "[mbr]" {
                    if in_partition_section && !current.name.is_empty() {
                        self.partitions.push(current.clone());
                        current = PartitionConfig::default();
                    }
                    in_partition_section = false;
                }
                continue;
            }
            if in_partition_section {
                Self::parse_partition_line(line, &mut current);
            }
        }

        if in_partition_section && !current.name.is_empty() {
            self.partitions.push(current);
        }
        true
    }

    fn parse_partition_line(line: &str, partition: &mut PartitionConfig) {
        let Some((k, v)) = line.split_once('=') else {
            return;
        };
        let key = k.trim();
        let value = v.trim().trim_matches('"');
        match key {
            "name" => partition.name = value.to_string(),
            "size" => {
                partition.size = if value.starts_with("0x") || value.starts_with("0X") {
                    u64::from_str_radix(&value[2..], 16).unwrap_or(0)
                } else {
                    value.parse().unwrap_or(0)
                };
            }
            "downloadfile" => partition.downloadfile = value.to_string(),
            "user_type" => {
                partition.user_type = if value.starts_with("0x") || value.starts_with("0X") {
                    u32::from_str_radix(&value[2..], 16).unwrap_or(0)
                } else {
                    value.parse().unwrap_or(0)
                };
            }
            "keydata" => partition.keydata = value != "0",
            "encrypt" => partition.encrypt = value != "0",
            "verify" => partition.verify = value != "0",
            "ro" => partition.readonly = value != "0",
            _ => {}
        }
    }

    pub fn get_partitions(&self) -> &[PartitionConfig] {
        &self.partitions
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SparseHeader {
    pub magic: u32,
    pub major_version: u16,
    pub minor_version: u16,
    pub file_hdr_sz: u16,
    pub chunk_hdr_sz: u16,
    pub blk_sz: u32,
    pub total_blks: u32,
    pub total_chunks: u32,
    pub image_checksum: u32,
}

impl SparseHeader {
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < SPARSE_HEADER_SIZE {
            return None;
        }
        Some(Self {
            magic: read_u32_le(data, 0),
            major_version: read_u16_le(data, 4),
            minor_version: read_u16_le(data, 6),
            file_hdr_sz: read_u16_le(data, 8),
            chunk_hdr_sz: read_u16_le(data, 10),
            blk_sz: read_u32_le(data, 12),
            total_blks: read_u32_le(data, 16),
            total_chunks: read_u32_le(data, 20),
            image_checksum: read_u32_le(data, 24),
        })
    }

    pub fn is_valid(&self) -> bool {
        self.magic == SPARSE_HEADER_MAGIC
            && self.major_version == SPARSE_HEADER_MAJOR_VER
            && self.file_hdr_sz as usize == SPARSE_HEADER_SIZE
            && self.chunk_hdr_sz as usize == CHUNK_HEADER_SIZE
            && self.blk_sz != 0
            && self.blk_sz % (SECTOR_SIZE as u32) == 0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ChunkHeader {
    pub chunk_type: u16,
    pub reserved: u16,
    pub chunk_sz: u32,
    pub total_sz: u32,
}

impl ChunkHeader {
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < CHUNK_HEADER_SIZE {
            return None;
        }
        Some(Self {
            chunk_type: read_u16_le(data, 0),
            reserved: read_u16_le(data, 2),
            chunk_sz: read_u32_le(data, 4),
            total_sz: read_u32_le(data, 8),
        })
    }
}

pub fn is_sparse_format(data: &[u8]) -> bool {
    SparseHeader::parse(data)
        .map(|h| h.is_valid())
        .unwrap_or(false)
}

pub fn sparse_format_probe(data: &[u8]) -> Result<SparseHeader, String> {
    let header = SparseHeader::parse(data)
        .ok_or_else(|| "Failed to parse sparse header: insufficient data".to_string())?;
    if header.magic != SPARSE_HEADER_MAGIC {
        return Err(format!(
            "Invalid sparse magic: expected 0x{:08x}, got 0x{:08x}",
            SPARSE_HEADER_MAGIC, header.magic
        ));
    }
    if header.major_version != SPARSE_HEADER_MAJOR_VER {
        return Err(format!(
            "Unsupported sparse version: {}",
            header.major_version
        ));
    }
    if header.file_hdr_sz as usize != SPARSE_HEADER_SIZE {
        return Err(format!(
            "Invalid file header size: expected {}, got {}",
            SPARSE_HEADER_SIZE, header.file_hdr_sz
        ));
    }
    if header.chunk_hdr_sz as usize != CHUNK_HEADER_SIZE {
        return Err(format!(
            "Invalid chunk header size: expected {}, got {}",
            CHUNK_HEADER_SIZE, header.chunk_hdr_sz
        ));
    }
    if header.blk_sz == 0 || header.blk_sz % (SECTOR_SIZE as u32) != 0 {
        return Err(format!("Invalid sparse block size: {}", header.blk_sz));
    }
    Ok(header)
}

pub fn add_sum(data: &[u8], initial: u32) -> u32 {
    let mut sum = initial;
    let aligned_len = data.len() & !0x03;
    for i in (0..aligned_len).step_by(4) {
        let value = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        sum = sum.wrapping_add(value);
    }
    if aligned_len < data.len() {
        let mut tail = [0u8; 4];
        tail[..data.len() - aligned_len].copy_from_slice(&data[aligned_len..]);
        sum = sum.wrapping_add(u32::from_le_bytes(tail));
    }
    sum
}
