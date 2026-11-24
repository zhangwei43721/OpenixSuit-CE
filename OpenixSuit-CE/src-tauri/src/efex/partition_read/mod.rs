mod layout;

use super::{build_flash_logger, exit::select_target};
use crate::state::AppState;
use layout::{read_layout, Partition, CHUNK_SIZE, SECTOR_SIZE};
use libefex::{Context, FesDataType};
use openixcli::firmware::OpenixPacker;
use openixcli::flash::{DeviceSelector, FlashMode, FlashRequest, Flasher, PostAction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};

const OPERATION: &str = "partition-read";

#[derive(Deserialize)]
pub(crate) struct Target {
    device_id: String,
    boot_firmware: Option<PathBuf>,
}

#[derive(Serialize)]
pub(crate) struct PartitionTable {
    device_id: String,
    storage_type: u32,
    reported_sectors: u64,
    format: &'static str,
    table_id: String,
    partitions: Vec<Partition>,
}

#[derive(Deserialize)]
pub(crate) struct ExportRequest {
    #[serde(flatten)]
    target: Target,
    table_id: Option<String>,
    #[serde(default)]
    partition_ids: Vec<usize>,
    #[serde(default)]
    partition_names: Vec<String>,
    out_dir: PathBuf,
}

#[derive(Serialize)]
struct FileResult {
    partition_id: usize,
    name: String,
    path: PathBuf,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    device_id: &'a str,
    partition_id: usize,
    name: &'a str,
    read_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize, Default)]
pub(crate) struct ExportResult {
    pub(crate) error: Option<String>,
    files: Vec<FileResult>,
}

fn check_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("读取已取消".into());
    }
    Ok(())
}

fn connect(
    app: &AppHandle,
    target: &Target,
    cancel: std::sync::Arc<AtomicBool>,
) -> Result<Context, String> {
    check_cancelled(&cancel)?;
    let candidates = Context::scan_usb_devices().map_err(|error| error.to_string())?;
    let (bus, port) = select_target(&candidates, &target.device_id)?;
    let request = FlashRequest::new(
        DeviceSelector::new(Some(bus), Some(port)),
        false,
        FlashMode::Partition,
        None,
        PostAction::Reboot,
    );
    let mut connector = Flasher::new(OpenixPacker::new(), request, build_flash_logger(app))
        .with_cancel_flag(cancel);
    tauri::async_runtime::block_on(connector.connect_for_readback(target.boot_firmware.as_deref()))
        .map_err(|error| error.to_string())
}

fn read_at(
    ctx: &Context,
    cancel: &AtomicBool,
    sector: u32,
    bytes: &mut [u8],
) -> Result<(), String> {
    check_cancelled(cancel)?;
    ctx.fes_up(bytes, sector, FesDataType::Flash)
        .map_err(|error| format!("读取逻辑扇区 {sector} 失败: {error}"))?;
    check_cancelled(cancel)
}

fn inspect(ctx: &Context, target: &Target, cancel: &AtomicBool) -> Result<PartitionTable, String> {
    check_cancelled(cancel)?;
    let storage_type = ctx
        .fes_query_storage()
        .map_err(|error| format!("读取存储类型失败: {error}"))?;
    let mut sectors = ctx
        .fes_probe_flash_size()
        .map_err(|error| format!("读取存储容量失败: {error}"))?;
    if sectors == 0 {
        let mut first_sector = [0_u8; SECTOR_SIZE as usize];
        read_at(ctx, cancel, 0, &mut first_sector)?;
        sectors = ctx
            .fes_probe_flash_size()
            .map_err(|error| format!("读取存储容量失败: {error}"))?;
    }
    let reported_sectors = u64::from(sectors);
    let layout = read_layout(
        |sector, bytes| read_at(ctx, cancel, sector, bytes),
        reported_sectors,
        storage_type,
    )?;
    let canonical = serde_json::to_vec(&(
        &target.device_id,
        storage_type,
        reported_sectors,
        layout.format,
        &layout.partitions,
    ))
    .map_err(|error| error.to_string())?;
    Ok(PartitionTable {
        device_id: target.device_id.clone(),
        storage_type,
        reported_sectors,
        format: layout.format,
        table_id: format!("{:x}", Sha256::digest(canonical)),
        partitions: layout.partitions,
    })
}

fn select_partitions<'a>(
    table: &'a PartitionTable,
    request: &ExportRequest,
) -> Result<Vec<&'a Partition>, String> {
    if request
        .table_id
        .as_ref()
        .is_some_and(|id| id != &table.table_id)
    {
        return Err("设备的分区布局已变化，请重新读取分区表".into());
    }
    let mut ids = BTreeSet::new();
    for id in &request.partition_ids {
        if !table.partitions.iter().any(|part| part.id == *id) {
            return Err(format!("设备没有编号为 {id} 的分区"));
        }
        ids.insert(*id);
    }
    for name in &request.partition_names {
        let mut matches = table.partitions.iter().filter(|part| &part.name == name);
        let part = matches
            .next()
            .ok_or_else(|| format!("设备没有分区 {name}"))?;
        if matches.next().is_some() {
            return Err(format!("存在重名分区 {name}，请使用分区编号"));
        }
        ids.insert(part.id);
    }
    if ids.is_empty() {
        return Err("至少选择一个分区".into());
    }
    let selected = table
        .partitions
        .iter()
        .filter(|part| ids.contains(&part.id))
        .collect::<Vec<_>>();
    if let Some(part) = selected.iter().find(|part| part.sectors == 0) {
        return Err(format!("设备未报告分区 {} 的明确长度，无法导出", part.name));
    }
    Ok(selected)
}

fn output_path(out_dir: &Path, partition: &Partition) -> PathBuf {
    let name: String = partition
        .name
        .chars()
        .take(80)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    out_dir.join(format!("{:02}-{name}.bin", partition.id))
}

fn export_one(
    out_dir: &Path,
    path: &Path,
    part: &Partition,
    mut read: impl FnMut(u32, &mut [u8]) -> Result<(), String>,
    mut progress: impl FnMut(u64, u64),
) -> Result<FileResult, String> {
    let mut file = tempfile::Builder::new()
        .prefix(".openix-read-")
        .suffix(".part")
        .tempfile_in(out_dir)
        .map_err(|error| format!("创建临时文件失败: {error}"))?;
    let mut buffer = vec![0_u8; CHUNK_SIZE];
    let mut checksum = Sha256::new();
    let total = part.sectors * SECTOR_SIZE;
    let mut written = 0;
    progress(written, total);
    while written < total {
        let len = (total - written).min(CHUNK_SIZE as u64) as usize;
        let sector = u32::try_from(part.start_sector + written / SECTOR_SIZE)
            .map_err(|_| "分区地址超出 FES 可寻址范围")?;
        let bytes = &mut buffer[..len];
        read(sector, bytes)?;
        file.write_all(bytes)
            .map_err(|error| format!("保存镜像失败: {error}"))?;
        checksum.update(bytes);
        written += len as u64;
        progress(written, total);
    }
    file.as_file()
        .sync_all()
        .map_err(|error| format!("镜像落盘失败: {error}"))?;
    file.persist_noclobber(path)
        .map_err(|error| format!("保存 {} 失败: {}", path.display(), error.error))?;
    Ok(FileResult {
        partition_id: part.id,
        name: part.name.clone(),
        path: path.to_owned(),
        bytes: written,
        sha256: format!("{:x}", checksum.finalize()),
    })
}

pub(crate) async fn list(
    app: &AppHandle,
    state: &AppState,
    target: Target,
) -> Result<PartitionTable, String> {
    let busy = state.try_acquire_busy(OPERATION)?;
    let cancel = state.cancel_partition_read.clone();
    cancel.store(false, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let ctx = connect(&app, &target, cancel.clone())?;
        inspect(&ctx, &target, &cancel)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn export(
    app: &AppHandle,
    state: &AppState,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    if !request.out_dir.is_absolute() || !request.out_dir.is_dir() {
        return Err("请选择已存在的绝对导出目录".into());
    }
    let busy = state.try_acquire_busy(OPERATION)?;
    let cancel = state.cancel_partition_read.clone();
    cancel.store(false, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let ctx = connect(&app, &request.target, cancel.clone())?;
        let table = inspect(&ctx, &request.target, &cancel)?;
        let selected = select_partitions(&table, &request)?;
        let paths = selected
            .iter()
            .map(|part| output_path(&request.out_dir, part))
            .collect::<Vec<_>>();
        for path in &paths {
            match fs::symlink_metadata(path) {
                Ok(_) => return Err(format!("导出文件已存在: {}", path.display())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(format!("检查导出路径失败: {error}")),
            }
        }

        let mut result = ExportResult::default();
        for (part, path) in selected.into_iter().zip(paths) {
            let mut last_update = std::time::Instant::now();
            match export_one(
                &request.out_dir,
                &path,
                part,
                |sector, bytes| read_at(&ctx, &cancel, sector, bytes),
                |read_bytes, total_bytes| {
                    if read_bytes == 0
                        || read_bytes == total_bytes
                        || last_update.elapsed().as_millis() >= 100
                    {
                        last_update = std::time::Instant::now();
                        let _ = app.emit(
                            "partition-read-progress",
                            Progress {
                                device_id: &table.device_id,
                                partition_id: part.id,
                                name: &part.name,
                                read_bytes,
                                total_bytes,
                            },
                        );
                    }
                },
            ) {
                Ok(file) => result.files.push(file),
                Err(error) => {
                    result.error = Some(format!("{}: {error}", part.name));
                    break;
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn cancel(state: &AppState) -> bool {
    if state.current_busy().as_deref() != Some(OPERATION) {
        return false;
    }
    state.cancel_partition_read.store(true, Ordering::SeqCst);
    true
}

#[tauri::command]
pub(crate) async fn list_device_partitions(
    app: AppHandle,
    state: State<'_, AppState>,
    target: Target,
) -> Result<PartitionTable, String> {
    list(&app, &state, target).await
}

#[tauri::command]
pub(crate) async fn export_device_partitions(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    export(&app, &state, request).await
}

#[tauri::command]
pub(crate) fn cancel_partition_read(state: State<'_, AppState>) -> bool {
    cancel(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_sectors_and_preserves_existing_images() {
        let dir = tempfile::tempdir().unwrap();
        let partition = Partition {
            id: 2,
            name: "rootfsB".into(),
            start_sector: 512,
            sectors: 129,
        };
        let path = output_path(dir.path(), &partition);
        let mut reads = Vec::new();
        let result = export_one(
            dir.path(),
            &path,
            &partition,
            |sector, buffer| {
                reads.push((sector, buffer.len()));
                buffer.fill((sector / 128) as u8);
                Ok(())
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(reads, [(512, CHUNK_SIZE), (640, 512)]);
        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.len() as u64, result.bytes);
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), result.sha256);
        let replacement = export_one(dir.path(), &path, &partition, |_, _| Ok(()), |_, _| {});
        assert!(replacement.is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn incomplete_read_leaves_no_image() {
        let dir = tempfile::tempdir().unwrap();
        let partition = Partition {
            id: 1,
            name: "../boot".into(),
            start_sector: 512,
            sectors: 129,
        };
        let path = output_path(dir.path(), &partition);
        assert_eq!(path.parent(), Some(dir.path()));
        let result = export_one(
            dir.path(),
            &path,
            &partition,
            |sector, _| {
                if sector == 512 {
                    Ok(())
                } else {
                    Err("cancelled".into())
                }
            },
            |_, _| {},
        );
        assert!(result.is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
