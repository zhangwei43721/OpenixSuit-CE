use adb_client::{ADBServer, ADBServerDevice, DeviceState};
use serde::Serialize;
use std::io::ErrorKind;
use std::process::Command;

#[derive(Serialize)]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport_id: Option<u64>,
}

impl AdbDevice {
    pub(crate) fn target(&self) -> &str {
        self.target.as_deref().unwrap_or(&self.serial)
    }

    pub(crate) fn is_online(&self) -> bool {
        matches!(self.state.as_str(), "Device" | "Recovery")
    }

    fn server_selector(&self) -> &str {
        self.usb_path.as_deref().unwrap_or(&self.serial)
    }

    pub(super) fn server_device(&self) -> ADBServerDevice {
        ADBServerDevice::new(self.server_selector().to_owned(), None)
    }

    pub(crate) fn command(&self) -> Command {
        let mut adb = adb_command();
        if let Some(id) = self.transport_id {
            adb.args(["-t", &id.to_string()]);
        } else {
            adb.args(["-s", self.server_selector()]);
        }
        adb
    }
}

fn adb_command() -> Command {
    let command = Command::new("adb");
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    };
    command
}

fn parse_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .skip_while(|line| !line.starts_with("List of devices attached"))
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?.to_owned();
            let state = match fields.next()? {
                "no" if fields.next() == Some("permissions") => DeviceState::NoPerm,
                state => state.parse::<DeviceState>().ok()?,
            };
            let mut usb_path = None;
            let mut transport_id = None;
            for field in fields {
                if field.starts_with("usb:") {
                    usb_path = Some(field.to_owned());
                } else if let Some(id) = field.strip_prefix("transport_id:") {
                    transport_id = id.parse().ok();
                }
            }
            // USB 路径区分同序列号的设备，序列号防止复用端口时匹配到不同设备。
            let target = usb_path
                .as_ref()
                .map(|path| format!("adb-usb:{path}#{serial}"));
            Some(AdbDevice {
                serial,
                state: format!("{state:?}"),
                target,
                usb_path,
                transport_id,
            })
        })
        .collect()
}

pub(super) fn list_devices() -> Result<Vec<AdbDevice>, String> {
    match adb_command().args(["devices", "-l"]).output() {
        Ok(output) if output.status.success() => {
            Ok(parse_devices(&String::from_utf8_lossy(&output.stdout)))
        }
        Ok(output) => Err(format!(
            "连接 ADB 服务失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // 系统未安装 adb 时，仍可通过已有 ADB 服务使用原生文件和 Shell 功能。
            let mut server = ADBServer::default();
            server
                .devices()
                .map(|devices| {
                    devices
                        .into_iter()
                        .map(|d| AdbDevice {
                            serial: d.identifier,
                            state: format!("{:?}", d.state),
                            target: None,
                            usb_path: None,
                            transport_id: None,
                        })
                        .collect()
                })
                .map_err(|e| format!("连接 ADB 服务失败: {e}"))
        }
        Err(error) => Err(format!("连接 ADB 服务失败: {error}")),
    }
}

fn select_device(devices: Vec<AdbDevice>, selector: &str) -> Result<AdbDevice, String> {
    let mut matches = devices.into_iter().filter(|device| {
        selector.is_empty() || device.target() == selector || device.serial == selector
    });
    let device = matches.next().ok_or_else(|| {
        if selector.is_empty() {
            "No ADB device is connected".into()
        } else {
            format!("ADB device '{selector}' is not connected")
        }
    })?;
    if matches.next().is_some() {
        return Err("Multiple ADB devices match. Select a device by USB path in the app or pass its target with --serial.".into());
    }
    Ok(device)
}

pub(crate) fn resolve_device(selector: &str) -> Result<AdbDevice, String> {
    select_device(list_devices()?, selector.trim())
}

pub(super) fn get_server_device(selector: &str) -> Result<ADBServerDevice, String> {
    Ok(resolve_device(selector)?.server_device())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_DEVICES: &str = "List of devices attached\n\
        20080411 device usb:1-3 product:\u{fffd} model:____ transport_id:383\n\
        20080411 device usb:1-1.1 transport_id:380\n";

    #[test]
    fn duplicate_serials_require_a_usb_target() {
        assert!(select_device(parse_devices(TWO_DEVICES), "20080411").is_err());
        assert!(select_device(parse_devices(TWO_DEVICES), "").is_err());
        for (target, path, id) in [
            ("adb-usb:usb:1-3#20080411", "usb:1-3", "383"),
            ("adb-usb:usb:1-1.1#20080411", "usb:1-1.1", "380"),
        ] {
            let device = select_device(parse_devices(TWO_DEVICES), target).unwrap();
            assert_eq!(device.serial, "20080411");
            assert_eq!(device.server_selector(), path);
            assert_eq!(device.command().get_args().collect::<Vec<_>>(), ["-t", id]);
        }
    }

    #[test]
    fn saved_usb_target_follows_reconnect_but_not_a_different_device() {
        let target = "adb-usb:usb:1-3#20080411";
        let reconnected =
            parse_devices("List of devices attached\n20080411 device usb:1-3 transport_id:402\n");
        let replacement =
            parse_devices("List of devices attached\nOTHER device usb:1-3 transport_id:403\n");
        assert_eq!(
            select_device(reconnected, target).unwrap().transport_id,
            Some(402)
        );
        assert!(select_device(replacement, target).is_err());
    }
}
