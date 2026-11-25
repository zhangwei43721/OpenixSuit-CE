use super::boot_check::{self, PostFlashVerificationReport, PostFlashVerificationRequest};
use super::execute_openix_flash_with_outcome;
use crate::state::{emit_ai_sync, AppState};
use libefex::Context;
use openixcli::firmware::OpenixPacker;
use openixcli::flash::{
    preview_write_plan, DeviceSelector, FlashMode, FlashRequest, FlashWritePlan, PostAction,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Deserialize)]
pub(crate) struct StandardFlashOptions {
    pub firmware_path: String,
    pub mode: String,
    #[serde(default)]
    pub partitions: Vec<String>,
    #[serde(default = "default_verify")]
    pub verify: bool,
    #[serde(default = "default_post_action")]
    pub post_action: String,
    pub bus: Option<u8>,
    pub port: Option<u8>,
    pub confirm_plan: Option<String>,
    pub boot_check: Option<PostFlashVerificationRequest>,
}

fn default_verify() -> bool {
    true
}

fn default_post_action() -> String {
    "reboot".into()
}

#[derive(Serialize)]
pub(crate) struct StandardFlashPlan {
    id: String,
    firmware_sha256: String,
    bus: Option<u8>,
    port: Option<u8>,
    verify: bool,
    post_action: String,
    #[serde(flatten)]
    writes: FlashWritePlan,
}

#[derive(Serialize)]
pub(crate) struct FlashStageResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct StandardFlashResult {
    pub flash: FlashStageResult,
    pub boot: PostFlashVerificationReport,
}

impl StandardFlashResult {
    pub fn ok(&self) -> bool {
        self.flash.status == "completed" && self.boot.ok()
    }
}

fn prepare(
    options: &StandardFlashOptions,
) -> Result<(OpenixPacker, FlashRequest, StandardFlashPlan), String> {
    let mode: FlashMode = options.mode.parse()?;
    let action: PostAction = options.post_action.parse()?;
    if options.bus.is_some() != options.port.is_some() {
        return Err("--bus and --port must be supplied together".into());
    }
    if mode == FlashMode::Partition && options.partitions.is_empty() {
        return Err("Partition mode requires at least one --partition".into());
    }
    if mode != FlashMode::Partition && !options.partitions.is_empty() {
        return Err("--partition requires --mode partition".into());
    }
    if let Some(check) = &options.boot_check {
        if action != PostAction::Reboot {
            return Err("ADB boot verification requires post_action=reboot".into());
        }
        boot_check::validate_request(check)?;
    }

    let request = FlashRequest::new(
        DeviceSelector::new(options.bus, options.port),
        options.verify,
        mode,
        (!options.partitions.is_empty()).then(|| options.partitions.clone()),
        action,
    );
    let mut packer = OpenixPacker::new();
    packer
        .load(&options.firmware_path)
        .map_err(|e| format!("加载固件失败: {e}"))?;
    let writes = preview_write_plan(&mut packer, &request).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    packer
        .copy_image_to(&mut digest)
        .map_err(|e| format!("读取固件失败: {e}"))?;
    let firmware_sha256 = format!("{:x}", digest.finalize());
    let post_action = action.to_string();
    let identity = serde_json::to_vec(&(
        &firmware_sha256,
        options.bus,
        options.port,
        options.verify,
        &post_action,
        &writes,
    ))
    .map_err(|e| e.to_string())?;
    let plan = StandardFlashPlan {
        id: format!("{:x}", Sha256::digest(identity)),
        firmware_sha256,
        bus: options.bus,
        port: options.port,
        verify: options.verify,
        post_action,
        writes,
    };
    Ok((packer, request, plan))
}

pub(crate) async fn preview(options: StandardFlashOptions) -> Result<StandardFlashPlan, String> {
    tokio::task::spawn_blocking(move || prepare(&options).map(|(_, _, plan)| plan))
        .await
        .map_err(|e| format!("生成刷写清单失败: {e}"))?
}

fn resolve_device(selector: DeviceSelector) -> Result<DeviceSelector, String> {
    let devices = Context::scan_usb_devices().map_err(|e| e.to_string())?;
    let selected = selector.selected_pair();
    let candidates = devices
        .iter()
        .filter(|dev| selected.is_none_or(|pair| pair == (dev.bus, dev.port)))
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [device] => Ok(DeviceSelector::new(Some(device.bus), Some(device.port))),
        [] => Err("找不到要刷写的 FEL/FES 设备".into()),
        _ if selected.is_some() => {
            Err("有多个 FEL/FES 设备使用相同的总线和端口编号，请更换 USB 接口".into())
        }
        _ => Err("连接了多个 FEL/FES 设备，请先指定要刷写的总线和端口".into()),
    }
}

#[cfg(target_os = "linux")]
fn verify_usb_path(selector: DeviceSelector, adb_target: &str) -> Result<(), String> {
    let Some(adb_path) = adb_target
        .strip_prefix("adb-usb:usb:")
        .and_then(|target| target.split_once('#'))
        .map(|(path, _)| path)
    else {
        return Ok(());
    };
    let devices =
        rusb::devices().map_err(|error| format!("无法核对刷机目标的 USB 路径: {error}"))?;
    let usb_path = devices
        .iter()
        .find_map(|device| {
            if selector.selected_pair() != Some((device.bus_number(), device.port_number())) {
                return None;
            }
            let descriptor = device.device_descriptor().ok()?;
            if (descriptor.vendor_id(), descriptor.product_id()) != (0x1f3a, 0xefe8) {
                return None;
            }
            let ports = device.port_numbers().ok()?;
            let path = ports
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(".");
            Some(format!("{}-{path}", device.bus_number()))
        })
        .ok_or("找不到刷机目标的 USB 路径")?;
    if usb_path != adb_path {
        return Err(format!(
            "ADB 目标的 USB 路径 {adb_path} 与刷机设备的 USB 路径 {usb_path} 不一致"
        ));
    }
    Ok(())
}

pub(crate) async fn run(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    options: StandardFlashOptions,
) -> Result<StandardFlashResult, String> {
    if options.confirm_plan.as_deref().is_none_or(str::is_empty) {
        return Err("请先预览刷写清单并确认".into());
    }
    let _busy = state.try_acquire_busy("flash")?;
    execute(app, state, source, options).await
}

async fn execute(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    options: StandardFlashOptions,
) -> Result<StandardFlashResult, String> {
    state.cancel_flash_flag.store(false, Ordering::SeqCst);
    let ((packer, mut request, plan), options) = tokio::task::spawn_blocking(move || {
        let prepared = prepare(&options)?;
        if let Some(expected) = &options.confirm_plan {
            if expected != &prepared.2.id {
                return Err("固件或刷写配置已变化，请重新预览和确认刷写清单".into());
            }
        }
        Ok::<_, String>((prepared, options))
    })
    .await
    .map_err(|e| format!("准备刷写任务失败: {e}"))??;

    if let Some(check) = &options.boot_check {
        boot_check::preflight_post_flash(check).await?;
    }
    let _ = app.emit("standard-flash-plan", &plan);
    emit_ai_sync(
        app,
        source,
        "flash",
        "started",
        format!("Flashing {} (mode={})", options.firmware_path, options.mode),
    );
    let app_clone = app.clone();
    let cancel_flag = state.cancel_flash_flag.clone();
    let post_action = request.post_action;
    #[cfg(target_os = "linux")]
    let adb_target = options
        .boot_check
        .as_ref()
        .and_then(|check| check.adb_target.clone());
    let result = tokio::task::spawn_blocking(move || {
        request.device = resolve_device(request.device)?;
        #[cfg(target_os = "linux")]
        if let Some(target) = adb_target {
            verify_usb_path(request.device, target.trim())?;
        }
        let pair = request.device.selected_pair();
        execute_openix_flash_with_outcome(&app_clone, packer, request, &cancel_flag)
            .map(|outcome| (outcome, pair))
    });
    let (flash, transition_error, write_target) = match result.await.map_err(|e| format!("刷写任务异常: {e}"))?
    {
        Ok((outcome, pair)) => (
            FlashStageResult {
                status: "completed",
                error: None,
            },
            outcome.post_action.err(),
            pair.map(|(bus, port)| format!("bus:{bus}-port:{port}")),
        ),
        Err(error) => (
            FlashStageResult {
                status: "failed",
                error: Some(error),
            },
            None,
            None,
        ),
    };
    let boot = if let Some(error) = &flash.error {
        emit_ai_sync(app, source, "flash", "error", error);
        PostFlashVerificationReport::skipped("刷写未完成")
    } else if let Some(error) = transition_error {
        PostFlashVerificationReport::failed(&format!(
            "刷写完成后请求设备{post_action}失败: {error}"
        ))
    } else if post_action != PostAction::Reboot {
        PostFlashVerificationReport::skipped("刷写后关机")
    } else if let Some(check) = options.boot_check {
        let _ = app.emit("standard-flash-verifying", ());
        emit_ai_sync(
            app,
            source,
            "flash",
            "running",
            "Firmware written. Waiting for ADB boot verification.",
        );
        boot_check::verify_post_flash(check)
            .await
            .unwrap_or_else(|error| PostFlashVerificationReport::failed(&error))
    } else {
        PostFlashVerificationReport::skipped("未配置启动核验的 ADB 目标")
    };
    let result = StandardFlashResult { flash, boot };
    if result.flash.error.is_none() {
        emit_ai_sync(
            app,
            source,
            "flash",
            if result.ok() { "completed" } else { "error" },
            format!("Flash task finished: {}", options.firmware_path),
        );
    }
    let _ = app.emit("standard-flash-result", &result);
    if let Some(device) = write_target {
        crate::triggers::on_device_event(app, "flash_completed", &device);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn flash_firmware_plan(
    options: StandardFlashOptions,
) -> Result<StandardFlashPlan, String> {
    preview(options).await
}

#[tauri::command]
pub(crate) async fn flash_firmware_full(
    app: AppHandle,
    state: State<'_, AppState>,
    options: StandardFlashOptions,
) -> Result<StandardFlashResult, String> {
    run(&app, &state, "gui", options).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_value, json};

    #[test]
    fn ipc_requires_explicit_flash_mode_and_partition_selection() {
        let absent_mode = from_value::<StandardFlashOptions>(json!({"firmware_path": "test.img"}));
        assert!(absent_mode
            .err()
            .unwrap()
            .to_string()
            .contains("missing field `mode`"));
        for (mode, partitions, error) in [
            (
                "partition",
                vec![],
                "Partition mode requires at least one --partition",
            ),
            (
                "full_erase",
                vec!["rootfsB"],
                "--partition requires --mode partition",
            ),
        ] {
            let options = from_value::<StandardFlashOptions>(json!({
                "firmware_path": "test.img", "mode": mode, "partitions": partitions,
            }))
            .unwrap();
            assert_eq!(prepare(&options).err().as_deref(), Some(error));
        }
    }
}
