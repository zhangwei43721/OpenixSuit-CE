//! Offline preview of the writes performed by the standard IMAGEWTY flash path.

use crate::config::boot_header::{
    BOOT_FILE_MODE_NORMAL, BOOT_FILE_MODE_PKG, BOOT_FILE_MODE_RESERVED0, BOOT_FILE_MODE_RESERVED1,
    BOOT_FILE_MODE_TOC,
};
use crate::config::mbr_parser::{MbrInfo, SunxiMbr};
use crate::firmware::{OpenixPacker, StorageType};
use crate::flash::fes_handler::types::PartitionSource;
use crate::flash::fes_handler::{BootDownload, PartitionPlanner, UbifsConfig};
use crate::flash::{FlashMode, FlashRequest};
use crate::utils::{FlashError, FlashResult, Logger};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct FlashWritePlan {
    pub schema_version: u32,
    pub mode: String,
    pub erase: Option<ErasePlan>,
    pub mbr: MbrPlan,
    pub partitions: Vec<PayloadPlan>,
    pub boot_components: Vec<BootComponentPlan>,
    pub ram_staging: Vec<RamStagingPlan>,
    pub conditional_writes: Vec<ConditionalWritePlan>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConditionalWritePlan {
    pub operation: String,
    pub partition: String,
    pub condition: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErasePlan {
    pub flag: u32,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MbrPlan {
    pub source: String,
    pub length: u64,
    pub partitions: Vec<MbrPartitionPlan>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MbrPartitionPlan {
    pub name: String,
    pub address: u64,
    pub sectors: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayloadPlan {
    pub name: String,
    pub address: u64,
    pub length: u64,
    pub source: String,
    pub wrap_address: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BootComponentPlan {
    pub component: String,
    pub conditions: Vec<String>,
    pub maintype: Option<String>,
    pub subtype: Option<String>,
    pub filename: Option<String>,
    pub length: Option<u64>,
    pub required: bool,
    pub fallback_for: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RamStagingPlan {
    pub component: String,
    pub filename: Option<String>,
    pub length: Option<u64>,
    pub required: bool,
}

pub(crate) struct ResolvedWriteInputs {
    pub mbr_data: Vec<u8>,
    pub mbr_source: &'static str,
    pub mbr_info: MbrInfo,
    pub downloads: Vec<crate::flash::fes_handler::types::PartitionDownloadInfo>,
}

/// Build the standard IMAGEWTY write plan without communicating with a device.
pub fn preview_write_plan(
    packer: &mut OpenixPacker,
    request: &FlashRequest,
) -> FlashResult<FlashWritePlan> {
    let resolved = resolve_write_inputs(packer, request)?;
    let ResolvedWriteInputs {
        mbr_data,
        mbr_source,
        mbr_info,
        downloads,
    } = resolved;
    let partitions = downloads
        .iter()
        .map(|entry| PayloadPlan {
            name: entry.partition_name.clone(),
            address: entry.partition_address,
            length: entry.data_length,
            source: match &entry.source {
                PartitionSource::Firmware => format!("IMAGEWTY:{}", entry.download_filename),
                PartitionSource::ExternalFile(path) => path.display().to_string(),
            },
            wrap_address: entry.wrap_address,
        })
        .collect();
    let mbr_plan = MbrPlan {
        source: mbr_source.into(),
        length: mbr_data.len() as u64,
        partitions: mbr_info
            .partitions
            .iter()
            .map(|p| MbrPartitionPlan {
                name: p.name.clone(),
                address: p.address(),
                sectors: p.length(),
            })
            .collect(),
    };
    let boot_components = boot_variants(packer);
    let ram_staging = ram_staging(packer);
    let logger = Logger::for_events(false, crate::flash::FlashEventSink::none());
    let conditional_writes = UbifsConfig::new(&logger)
        .find_partition(packer, &downloads)?
        .map(|name| ConditionalWritePlan {
            operation: "ubifs_config".into(),
            partition: name.into(),
            condition: "storage is not SD/SD1".into(),
        })
        .into_iter()
        .collect();
    let erase = (request.mode != FlashMode::Partition).then(|| ErasePlan {
        flag: request.mode.erase_flag(),
        description: request.mode.display_name().into(),
    });
    Ok(FlashWritePlan {
        schema_version: 1,
        mode: request.mode.to_string(),
        erase,
        mbr: mbr_plan,
        partitions,
        boot_components,
        ram_staging,
        conditional_writes,
    })
}

pub(crate) fn resolve_write_inputs(
    packer: &mut OpenixPacker,
    request: &FlashRequest,
) -> FlashResult<ResolvedWriteInputs> {
    if !packer.is_image_loaded() {
        return Err(FlashError::InvalidFirmwareFormat(
            "IMAGEWTY firmware is not loaded".into(),
        ));
    }
    let (mbr_data, mbr_source) = if let Some(layout) = &request.custom_layout {
        (layout.mbr_data.clone(), "custom_layout")
    } else if let Some(data) = &request.mbr_override {
        (data.clone(), "mbr_override")
    } else {
        (
            packer.get_mbr().map_err(|_| FlashError::MbrNotFound)?,
            "firmware",
        )
    };
    let mbr =
        SunxiMbr::parse(&mbr_data).map_err(|e| FlashError::InvalidFirmwareFormat(e.to_string()))?;
    let mbr_info = mbr.to_mbr_info();
    let names = mbr_info
        .partitions
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>();
    validate_explicit_selection(request, &names)?;
    let logger = Logger::for_events(false, crate::flash::FlashEventSink::none());
    let downloads = if let Some(layout) = &request.custom_layout {
        crate::flash::fes_handler::prepare_custom_downloads_for_plan(layout, &mbr_info)?
    } else {
        PartitionPlanner::new(&logger).prepare(packer, &mbr_info, request)?
    };
    validate_explicit_payloads(request, &downloads)?;
    Ok(ResolvedWriteInputs {
        mbr_data,
        mbr_source,
        mbr_info,
        downloads,
    })
}

fn validate_explicit_selection(request: &FlashRequest, mbr_names: &[&str]) -> FlashResult<()> {
    if request.mode != FlashMode::Partition {
        return Ok(());
    }
    if let Some(selected) = &request.partitions {
        for name in selected {
            if !mbr_names.contains(&name.as_str()) {
                return Err(FlashError::InvalidFirmwareFormat(format!(
                    "Selected partition is missing from MBR: {name}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_explicit_payloads(
    request: &FlashRequest,
    downloads: &[crate::flash::fes_handler::types::PartitionDownloadInfo],
) -> FlashResult<()> {
    if request.mode == FlashMode::Partition {
        if let Some(selected) = &request.partitions {
            for name in selected {
                if !downloads.iter().any(|item| &item.partition_name == name) {
                    return Err(FlashError::InvalidFirmwareFormat(format!(
                        "Selected partition has no payload: {name}"
                    )));
                }
            }
        }
    }
    for item in downloads {
        if let PartitionSource::ExternalFile(path) = &item.source {
            let actual = std::fs::metadata(path)
                .map_err(|e| {
                    FlashError::InvalidFirmwareFormat(format!(
                        "External payload {} is unavailable: {e}",
                        path.display()
                    ))
                })?
                .len();
            if item.data_length > actual {
                return Err(FlashError::InvalidFirmwareFormat(format!(
                    "External payload {} is shorter than planned ({} < {})",
                    path.display(),
                    actual,
                    item.data_length
                )));
            }
        }
    }
    Ok(())
}

fn boot_variants(packer: &OpenixPacker) -> Vec<BootComponentPlan> {
    let logger = Logger::for_events(false, crate::flash::FlashEventSink::none());
    let selector = BootDownload::new(&logger);
    let modes = [
        (BOOT_FILE_MODE_NORMAL, "normal"),
        (BOOT_FILE_MODE_PKG, "package"),
        (BOOT_FILE_MODE_TOC, "toc"),
        (BOOT_FILE_MODE_RESERVED0, "reserved0"),
        (BOOT_FILE_MODE_RESERVED1, "reserved1"),
    ];
    let storages = [
        StorageType::Nand,
        StorageType::Sdcard,
        StorageType::Emmc,
        StorageType::Spinor,
        StorageType::Emmc3,
        StorageType::Spinand,
        StorageType::Sd1,
        StorageType::Emmc0,
        StorageType::Ufs,
        StorageType::Auto,
    ];
    let mut map: BTreeMap<(String, String, String), BootComponentPlan> = BTreeMap::new();
    for (mode, mode_name) in modes {
        for storage in storages {
            let storage_name = format!("{:?}", storage).to_lowercase();
            let condition = format!("boot_mode={mode_name}, storage={storage_name}");
            if let Some(subtype) = selector.get_preboot_subtype(mode) {
                let header = packer.find_file_header_by_subtype(subtype);
                add_boot_candidate(
                    packer,
                    &mut map,
                    "preboot",
                    header
                        .map(|h| h.maintype_str())
                        .as_deref()
                        .unwrap_or("12345678"),
                    subtype,
                    &condition,
                    false,
                    None,
                );
            }
            if let Some((main, sub)) = selector.get_boot1_subtype(mode, storage as i32 as u32) {
                add_boot_candidate(packer, &mut map, "boot1", main, sub, &condition, true, None);
            }
            if let Some((main, sub)) = selector.get_boot0_entry(mode, storage as i32 as u32) {
                let primary_exists = has_valid_entry(packer, main, sub);
                let (actual_main, actual_sub, fallback) = if primary_exists {
                    (main, sub, None)
                } else if let Some((fm, fs)) = selector.get_boot0_fallback_entry(mode) {
                    (fm, fs, Some(format!("{main}/{sub}")))
                } else {
                    (main, sub, None)
                };
                add_boot_candidate(
                    packer,
                    &mut map,
                    "boot0",
                    actual_main,
                    actual_sub,
                    &condition,
                    true,
                    fallback,
                );
            }
        }
    }
    map.into_values().collect()
}

/// Validate the boot payloads selected for a connected device before any write operation.
pub fn validate_boot_payloads_for_device(
    packer: &mut OpenixPacker,
    secure: u32,
    storage_type: u32,
) -> FlashResult<()> {
    let logger = Logger::for_events(false, crate::flash::FlashEventSink::none());
    BootDownload::new(&logger)
        .prepare_images(packer, secure, storage_type)
        .map(|_| ())
}

fn add_boot_candidate(
    packer: &OpenixPacker,
    map: &mut BTreeMap<(String, String, String), BootComponentPlan>,
    component: &str,
    maintype: &str,
    subtype: &str,
    condition: &str,
    required: bool,
    fallback_for: Option<String>,
) {
    let key = (
        component.to_string(),
        maintype.to_string(),
        subtype.to_string(),
    );
    let version = packer.get_image_info().header.header_version;
    let header = packer
        .get_file_header_by_maintype_subtype(maintype, subtype)
        .filter(|h| {
            let range = (h.offset(version), h.original_length(version));
            packer.contains_image_range(range.0, range.1)
        });
    let entry = map.entry(key).or_insert_with(|| BootComponentPlan {
        component: component.into(),
        conditions: Vec::new(),
        maintype: Some(maintype.into()),
        subtype: Some(subtype.into()),
        filename: header.map(|h| h.filename_str(version)),
        length: header.map(|h| h.original_length(version)),
        required,
        fallback_for,
    });
    entry.conditions.push(condition.into());
}

fn has_valid_entry(packer: &OpenixPacker, maintype: &str, subtype: &str) -> bool {
    packer
        .get_file_info_by_maintype_subtype(maintype, subtype)
        .is_some_and(|(offset, length)| packer.contains_image_range(offset, length))
}

fn ram_staging(packer: &OpenixPacker) -> Vec<RamStagingPlan> {
    let version = packer.get_image_info().header.header_version;
    let entries = [
        ("FES", "FES", "FES_1-0000000000", true),
        ("U-Boot", "12345678", "UBOOT_0000000000", true),
        ("DTB", "COMMON", "DTB_CONFIG000000", false),
        ("System configuration", "COMMON", "SYS_CONFIG_BIN00", true),
        ("Board configuration", "COMMON", "BOARD_CONFIG_BIN", false),
    ];
    entries
        .into_iter()
        .map(|(component, maintype, subtype, required)| {
            let header = packer
                .get_file_header_by_maintype_subtype(maintype, subtype)
                .filter(|h| {
                    let range = (h.offset(version), h.original_length(version));
                    packer.contains_image_range(range.0, range.1)
                });
            RamStagingPlan {
                component: component.into(),
                filename: header.map(|h| h.filename_str(version)),
                length: header.map(|h| h.original_length(version)),
                required,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flash::{DeviceSelector, PostAction};
    use crate::test_support::{mbr_bytes, test_firmware, FirmwareEntry};

    #[test]
    fn preview_reports_erase_mbr_partition_boot_variants_and_ram_staging() {
        let mbr = mbr_bytes(&[("system", 0x20, 3, false)]);
        let entries = [
            FirmwareEntry {
                filename: "sunxi_mbr.fex",
                maintype: "12345678",
                subtype: "1234567890___MBR",
                data: &mbr,
            },
            FirmwareEntry {
                filename: "sys_partition.fex",
                maintype: "COMMON",
                subtype: "SYS_CONFIG000000",
                data: b"[partition_start]\n[partition]\nname=system\ndownloadfile=system.img\n",
            },
            FirmwareEntry {
                filename: "system.img",
                maintype: "RFSFAT16",
                subtype: "SYSTEM_IMG000000",
                data: b"rootfs",
            },
            FirmwareEntry {
                filename: "preboot.fex",
                maintype: "12345678",
                subtype: "1234567890PREB_0",
                data: b"pre",
            },
            FirmwareEntry {
                filename: "uboot.fex",
                maintype: "12345678",
                subtype: "UBOOT_0000000000",
                data: b"u-boot",
            },
            FirmwareEntry {
                filename: "boot0.fex",
                maintype: "12345678",
                subtype: "1234567890BOOT_0",
                data: b"boot0",
            },
            FirmwareEntry {
                filename: "fes.fex",
                maintype: "FES",
                subtype: "FES_1-0000000000",
                data: b"fes",
            },
        ];
        let fw = test_firmware(&entries);
        let mut packer = OpenixPacker::new();
        packer.load(fw.path()).unwrap();
        let request = FlashRequest::new(
            DeviceSelector::default(),
            true,
            FlashMode::FullErase,
            None,
            PostAction::Reboot,
        );
        let plan = preview_write_plan(&mut packer, &request).unwrap();
        validate_boot_payloads_for_device(
            &mut packer,
            BOOT_FILE_MODE_NORMAL,
            StorageType::Sdcard as u32,
        )
        .unwrap();
        assert!(validate_boot_payloads_for_device(
            &mut packer,
            BOOT_FILE_MODE_PKG,
            StorageType::Spinor as u32,
        )
        .is_err());
        assert_eq!(plan.erase.as_ref().unwrap().flag, 0x12);
        assert_eq!(plan.mbr.partitions[0].name, "system");
        assert_eq!(plan.partitions[0].name, "system");
        assert!(plan.boot_components.iter().any(|b| b.component == "boot1"
            && b.conditions.iter().any(|c| c.contains("boot_mode=normal"))));
        assert!(plan.ram_staging.iter().any(|p| p.component == "FES"));
        assert!(plan.schema_version == 1);

        let invalid_selection = FlashRequest::new(
            DeviceSelector::default(),
            true,
            FlashMode::Partition,
            Some(vec!["ghost".into()]),
            PostAction::Reboot,
        );
        assert!(preview_write_plan(&mut packer, &invalid_selection).is_err());

        let missing_entries = entries
            .iter()
            .copied()
            .filter(|entry| entry.filename != "system.img")
            .collect::<Vec<_>>();
        let missing_firmware = test_firmware(&missing_entries);
        let mut missing_packer = OpenixPacker::new();
        missing_packer.load(missing_firmware.path()).unwrap();
        let selected_without_payload = FlashRequest::new(
            DeviceSelector::default(),
            true,
            FlashMode::Partition,
            Some(vec!["system".into()]),
            PostAction::Reboot,
        );
        assert!(preview_write_plan(&mut missing_packer, &selected_without_payload).is_err());
    }
}
