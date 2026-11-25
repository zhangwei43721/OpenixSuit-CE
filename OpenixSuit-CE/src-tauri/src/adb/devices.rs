use adb_client::{ADBServer, ADBServerDevice, DeviceState, TCPServerTransport};
use serde::Serialize;
use std::io::ErrorKind;
use std::net::SocketAddrV4;
use std::process::Command;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

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

    pub(super) fn transport_request(&self) -> String {
        match self.transport_id {
            Some(id) => format!("host:transport-id:{id}"),
            None => format!("host:transport:{}", self.server_selector()),
        }
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

pub(crate) fn adb_command() -> Command {
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

pub(crate) fn parse_devices(output: &str) -> Vec<AdbDevice> {
    parse_device_lines(
        output.lines()
            .skip_while(|line| !line.starts_with("List of devices attached"))
            .skip(1),
    )
}

pub(super) fn parse_device_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<AdbDevice> {
    lines
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

pub(crate) fn select_device(devices: Vec<AdbDevice>, selector: &str) -> Result<AdbDevice, String> {
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

pub(crate) async fn monitor_shell(serial: &str, script: &str) -> Result<String, String> {
    let address = TCPServerTransport::default().get_socketaddr();
    run_with_deadline(address, serial, script, Duration::from_secs(5)).await
}

async fn run_with_deadline(
    address: SocketAddrV4,
    serial: &str,
    script: &str,
    deadline: Duration,
) -> Result<String, String> {
    // 超时后丢弃本次采集的连接，下一轮重新连接。
    tokio::time::timeout(deadline, run_shell(address, serial, script))
        .await
        .map_err(|_| {
            format!(
                "ADB metrics collection timed out ({} s)",
                deadline.as_secs()
            )
        })?
}

async fn run_shell(address: SocketAddrV4, serial: &str, script: &str) -> Result<String, String> {
    let mut connection = connect(address).await?;
    request(&mut connection, "host:devices-l").await?;
    let listing = read_body(&mut connection).await?;
    let devices = parse_device_lines(String::from_utf8_lossy(&listing).lines());
    let device = select_device(devices, serial.trim())?;

    let mut shell = connect(address).await?;
    request(&mut shell, &device.transport_request()).await?;
    // 全志的旧版 adbd 同样支持 shell: 服务。
    request(&mut shell, &format!("shell:{script}")).await?;
    let mut output = Vec::new();
    shell
        .read_to_end(&mut output)
        .await
        .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

async fn connect(address: SocketAddrV4) -> Result<TcpStream, String> {
    TcpStream::connect(address)
        .await
        .map_err(|error| format!("ADB server connection failed: {error}"))
}

async fn request(stream: &mut TcpStream, service: &str) -> Result<(), String> {
    let length = u16::try_from(service.len()).map_err(|_| "ADB request is too long".to_string())?;
    stream
        .write_all(format!("{length:04x}{service}").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut status = [0; 4];
    stream
        .read_exact(&mut status)
        .await
        .map_err(|error| error.to_string())?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => Err(String::from_utf8_lossy(&read_body(stream).await?).into_owned()),
        _ => Err("Invalid response from ADB server".into()),
    }
}

async fn read_body(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut length = [0; 4];
    stream
        .read_exact(&mut length)
        .await
        .map_err(|error| error.to_string())?;
    let length = std::str::from_utf8(&length).map_err(|error| error.to_string())?;
    let length = u16::from_str_radix(length, 16).map_err(|error| error.to_string())?;
    let mut body = vec![0; usize::from(length)];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|error| error.to_string())?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

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

    async fn expect_request(stream: &mut TcpStream, expected: &str) {
        assert_eq!(read_body(stream).await.unwrap(), expected.as_bytes());
    }

    async fn accept_sample(listener: &TcpListener) -> TcpStream {
        let (mut listing, _) = listener.accept().await.unwrap();
        expect_request(&mut listing, "host:devices-l").await;
        let devices = "same device usb:1-1 transport_id:41\nsame device usb:1-2 transport_id:42\n";
        let reply = format!("OKAY{:04x}{devices}", devices.len());
        listing.write_all(reply.as_bytes()).await.unwrap();
        let (mut shell, _) = listener.accept().await.unwrap();
        expect_request(&mut shell, "host:transport-id:42").await;
        shell.write_all(b"OKAY").await.unwrap();
        expect_request(&mut shell, "shell:echo sample").await;
        shell.write_all(b"OKAY").await.unwrap();
        shell
    }

    #[tokio::test]
    async fn timeout_closes_stalled_sample_and_next_sample_can_connect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let std::net::SocketAddr::V4(address) = listener.local_addr().unwrap() else {
            unreachable!();
        };
        let server = tokio::spawn(async move {
            let mut stalled = accept_sample(&listener).await;
            assert_eq!(stalled.read(&mut [0]).await.unwrap(), 0);
            let mut next = accept_sample(&listener).await;
            next.write_all(b"sample\n").await.unwrap();
        });
        let serial = "adb-usb:usb:1-2#same";
        let error = run_with_deadline(address, serial, "echo sample", Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(error.contains("timed out"));
        let result = run_with_deadline(address, serial, "echo sample", Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(result, "sample\n");
        server.await.unwrap();
    }
}
