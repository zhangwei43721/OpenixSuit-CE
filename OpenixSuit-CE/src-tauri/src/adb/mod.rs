use adb_client::{ADBDeviceExt, ADBListItemType, ADBServer};
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::process::Command;

#[derive(Serialize)]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
}

#[derive(Serialize)]
pub struct AdbFileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

fn get_server_device(serial: &str) -> Result<adb_client::ADBServerDevice, String> {
    let mut server = ADBServer::default();
    if serial.is_empty() {
        server.get_device().map_err(|e| e.to_string())
    } else {
        server.get_device_by_name(serial).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn adb_list_devices() -> Result<Vec<AdbDevice>, String> {
    let mut server = ADBServer::default();
    let list = server.devices().map_err(|e| format!("连接 ADB 服务失败: {}", e))?;
    Ok(list
        .into_iter()
        .map(|d| AdbDevice {
            serial: d.identifier,
            state: format!("{:?}", d.state),
        })
        .collect())
}

#[tauri::command]
pub fn adb_list_dir(serial: String, remote_path: String) -> Result<Vec<AdbFileEntry>, String> {
    let mut device = get_server_device(&serial)?;
    let items = device.list(&remote_path).map_err(|e| e.to_string())?;
    let mut entries: Vec<AdbFileEntry> = items
        .into_iter()
        .filter(|item| item.name != "." && item.name != "..")
        .map(|item| AdbFileEntry {
            name: item.name,
            is_dir: matches!(item.item_type, ADBListItemType::Directory),
            size: item.size as u64,
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub fn adb_push_file(serial: String, local_path: String, remote_path: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    let file = File::open(&local_path).map_err(|e| e.to_string())?;
    device.push(file, &remote_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn adb_pull_file(serial: String, remote_path: String, local_path: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    let mut file = File::create(&local_path).map_err(|e| e.to_string())?;
    device.pull(&remote_path, &mut file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn adb_exec_shell(serial: String, command: String) -> Result<String, String> {
    let mut device = get_server_device(&serial)?;
    let mut out = Vec::new();
    match device.shell_command(&[command.as_str()], &mut out) {
        Ok(()) => Ok(String::from_utf8_lossy(&out).to_string()),
        Err(_) => {
            let mut cmd = Command::new("adb");
            if !serial.is_empty() {
                cmd.args(["-s", &serial]);
            }
            let output = cmd
                .args(["shell", &command])
                .output()
                .map_err(|e| format!("设备不支持 ShellV2，且本地 adb 回退失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(format!("{}{}", stdout, stderr))
        }
    }
}

#[tauri::command]
pub fn adb_root(serial: String) -> Result<String, String> {
    let mut cmd = Command::new("adb");
    if !serial.is_empty() {
        cmd.args(["-s", &serial]);
    }
    let output = cmd.arg("root").output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub fn adb_reboot(serial: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    device
        .reboot(adb_client::RebootType::System)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn adb_reboot_efex(serial: String) -> Result<String, String> {
    let mut cmd = Command::new("adb");
    if !serial.is_empty() {
        cmd.args(["-s", &serial]);
    }
    let out = cmd.args(["reboot", "efex"]).output();
    if let Ok(res) = out {
        if res.status.success() {
            return Ok("已发送 adb reboot efex，设备正在重启进入烧录模式".into());
        }
    }
    // 部分全志固件通过 shell 命令进入 efex/fel
    adb_exec_shell(serial, "reboot efex 2>/dev/null || reboot fel".into())
}

#[tauri::command]
pub fn adb_mkdir(serial: String, remote_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("mkdir -p '{}'", remote_path))
}

#[tauri::command]
pub fn adb_delete(serial: String, remote_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("rm -rf '{}'", remote_path))
}

#[tauri::command]
pub fn adb_rename(serial: String, old_path: String, new_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("mv '{}' '{}'", old_path, new_path))
}

#[tauri::command]
pub fn adb_copy(serial: String, src_path: String, dst_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("cp -r '{}' '{}'", src_path, dst_path))
}

#[tauri::command]
pub fn adb_read_text(serial: String, remote_path: String) -> Result<String, String> {
    let mut device = get_server_device(&serial)?;
    let mut buf = Vec::new();
    device.pull(&remote_path, &mut buf).map_err(|e| e.to_string())?;
    if buf.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，不支持在线文本编辑，请下载到本地查看".into());
    }
    let sample = &buf[..buf.len().min(8192)];
    if sample.contains(&0) || std::str::from_utf8(&buf).is_err() {
        return Err("检测到二进制或图片文件，不支持文本编辑，请使用下载功能".into());
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

#[tauri::command]
pub fn adb_write_text(serial: String, remote_path: String, content: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    let bytes = content.as_bytes();
    let mut cursor = std::io::Cursor::new(bytes);
    let _ = Read::bytes(&mut cursor);
    device
        .push(std::io::Cursor::new(bytes), &remote_path)
        .map_err(|e| e.to_string())
}
