use super::{efex_device_id, open_efex_session};
use crate::state::AppState;
use libefex::{Context, DeviceMode, FesToolMode, ScannedDevice};
use libefex_sys::{
    sunxi_efex_cmd_t, sunxi_fes_set_tool_mode_t, sunxi_usb_fes_xfer, sunxi_usb_fes_xfer_type_t,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FesExitAction {
    Reboot,
    Fel,
}

fn select_target(devices: &[ScannedDevice], device_id: &str) -> Result<(u8, u8), String> {
    let mut matches = devices
        .iter()
        .filter(|dev| efex_device_id(dev.bus, dev.port) == device_id);
    let dev = matches
        .next()
        .ok_or_else(|| format!("未检测到指定的 USB 设备 {device_id}"))?;
    if matches.next().is_some() {
        return Err(format!(
            "多台 USB 设备共用地址 {device_id}，无法确定退出 FES 的目标"
        ));
    }
    Ok((dev.bus, dev.port))
}

fn request_fel(ctx: &Context) -> Result<(), String> {
    // 量产工具模式可能把非零后续动作当作重启。更新工具模式保留 REUPDATE，
    // 由支持该动作的 U-Boot 设置 FEL 标志并复位。
    const USB_TOOL_UPDATE: u32 = 0x08;
    const NEXT_ACTION_REUPDATE: u32 = 0x04;
    let request = sunxi_fes_set_tool_mode_t {
        tool_mode: USB_TOOL_UPDATE.to_le(),
        next_mode: NEXT_ACTION_REUPDATE.to_le(),
        reserved: 0,
    };
    // 请求结构与 libefex 的 FES_TOOL_MODE 一致，调用在结构体存活期间完成。
    let result = unsafe {
        sunxi_usb_fes_xfer(
            ctx.as_ptr(),
            sunxi_usb_fes_xfer_type_t::FES_XFER_NONE,
            sunxi_efex_cmd_t::EFEX_CMD_FES_TOOL_MODE as u32,
            (&request as *const sunxi_fes_set_tool_mode_t).cast(),
            std::mem::size_of_val(&request) as isize,
            std::ptr::null(),
            0,
        )
    };
    if result != 0 {
        return Err(format!(
            "FES 进入 FEL 请求未获确认，libefex 错误码 {result}"
        ));
    }
    Ok(())
}

pub(crate) async fn request_exit(
    state: &AppState,
    device_id: String,
    action: FesExitAction,
) -> Result<(), String> {
    let busy = state.try_acquire_busy("fes-exit")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let devices = Context::scan_usb_devices().map_err(|error| error.to_string())?;
        let (bus, port) = select_target(&devices, &device_id)?;
        let ctx = open_efex_session(Some(bus), Some(port))?;
        let mode = ctx.get_device_mode();
        if mode != DeviceMode::Srv {
            return Err(format!(
                "设备 {device_id} 当前处于 {mode:?}，请在 FES 模式下执行此操作"
            ));
        }
        match action {
            FesExitAction::Reboot => ctx
                .fes_tool_mode(FesToolMode::Normal, FesToolMode::Reboot)
                .map_err(|error| error.to_string()),
            FesExitAction::Fel => request_fel(&ctx),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(bus: u8, port: u8) -> ScannedDevice {
        ScannedDevice {
            bus,
            port,
            vid: 0x1f3a,
            pid: 0xefe8,
        }
    }

    #[test]
    fn exit_requires_the_exact_unambiguous_usb_target() {
        let devices = [device(1, 3), device(2, 3), device(2, 4), device(2, 4)];
        assert_eq!(select_target(&devices, "bus:2-port:3").unwrap(), (2, 3));
        assert!(select_target(&devices, "bus:2-port:4").is_err());
        assert!(select_target(&devices, "bus:1-port:4").is_err());
        assert!(select_target(&devices, "").is_err());
    }

    #[tokio::test]
    async fn exit_does_not_open_usb_while_flash_owns_the_device() {
        let state = AppState::default();
        let _flash = state.try_acquire_busy("flash").unwrap();
        let error = request_exit(&state, "bus:1-port:3".into(), FesExitAction::Reboot)
            .await
            .unwrap_err();
        assert_eq!(error, "Device busy: flash");
    }
}
