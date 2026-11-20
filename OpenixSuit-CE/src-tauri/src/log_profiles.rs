use crate::adb_log::device_command;
use crate::serial::{SerialLineCoding, SerialOptions};
use crate::state::{app_data_dir, load_json_or_default};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static PROFILES_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LogProfile {
    pub id: String,
    name: String,
    #[serde(default)]
    pub(crate) sources: Vec<LogSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bridge: Option<BridgeProfile>,
    #[serde(default)]
    notes: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum LogSource {
    Serial {
        label: String,
        port_name: String,
        baud_rate: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_coding: Option<SerialLineCoding>,
        #[serde(skip_serializing_if = "Option::is_none")]
        serial_options: Option<SerialOptions>,
    },
    Adb {
        label: String,
        serial: String,
        command: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BridgeProfile {
    pub(crate) first: SerialEndpoint,
    pub(crate) second: SerialEndpoint,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SerialEndpoint {
    pub(crate) label: String,
    pub(crate) port_name: String,
    pub(crate) baud_rate: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) line_coding: Option<SerialLineCoding>,
}

impl LogSource {
    pub(crate) fn label(&self) -> &str {
        match self {
            Self::Serial { label, .. } | Self::Adb { label, .. } => label,
        }
    }
}

fn require_value(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(format!("{field} must be nonempty and contain no NUL bytes"));
    }
    Ok(())
}

impl LogProfile {
    pub(crate) fn validate(&self) -> Result<(), String> {
        require_value("Profile id", &self.id)?;
        if self.id != self.id.trim() {
            return Err("Profile id must not have surrounding whitespace".into());
        }
        require_value("Profile name", &self.name)?;
        if self.sources.is_empty() && self.bridge.is_none() {
            return Err("A log profile requires at least one source or a serial bridge".into());
        }
        let mut labels = HashSet::new();
        let mut serial_ports = HashSet::new();
        let mut adb_commands = HashSet::new();
        for source in &self.sources {
            let label = source.label();
            require_value("Source label", label)?;
            if label != label.trim() || !labels.insert(label) {
                return Err(format!(
                    "The source label '{label}' must be unique and have no surrounding whitespace"
                ));
            }
            match source {
                LogSource::Serial {
                    port_name,
                    baud_rate,
                    line_coding,
                    ..
                } => {
                    check_serial(port_name, *baud_rate)?;
                    if let Some(coding) = line_coding {
                        coding.validate()?;
                    }
                    if !serial_ports.insert(port_name) {
                        return Err(format!("Repeated serial port '{port_name}'"));
                    }
                }
                LogSource::Adb {
                    serial, command, ..
                } => {
                    require_value("ADB serial", serial)?;
                    require_value("ADB command", command)?;
                    if serial.contains(char::is_whitespace) {
                        return Err("ADB serial must not contain whitespace".into());
                    }
                    if !adb_commands.insert((serial, device_command(command)?)) {
                        return Err(format!("Repeated ADB command for device '{serial}'"));
                    }
                }
            }
        }
        if let Some(bridge) = &self.bridge {
            for endpoint in [&bridge.first, &bridge.second] {
                require_value("Bridge endpoint label", &endpoint.label)?;
                check_serial(&endpoint.port_name, endpoint.baud_rate)?;
                if let Some(coding) = &endpoint.line_coding {
                    coding.validate()?;
                }
            }
            if bridge.first.port_name == bridge.second.port_name {
                return Err("A serial bridge requires two different serial ports".into());
            }
        }
        Ok(())
    }
}

fn check_serial(port_name: &str, baud_rate: u32) -> Result<(), String> {
    require_value("Serial port name", port_name)?;
    if port_name != port_name.trim() || baud_rate == 0 {
        return Err(
            "Serial port names must have no surrounding whitespace and baud rates must be positive"
                .into(),
        );
    }
    Ok(())
}

fn profiles_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("log-profiles.json"))
}

#[tauri::command]
pub fn log_profiles_list() -> Result<Vec<LogProfile>, String> {
    load_json_or_default(&profiles_path()?)
}

pub(crate) fn save_profile(app: &AppHandle, profile: LogProfile) -> Result<LogProfile, String> {
    let saved = upsert_profile(&profiles_path()?, profile)?;
    let _ = app.emit("log-profiles-changed", &saved.id);
    Ok(saved)
}

#[tauri::command]
pub async fn log_profile_save(app: AppHandle, profile: LogProfile) -> Result<LogProfile, String> {
    profile.validate()?;
    tauri::async_runtime::spawn_blocking(move || save_profile(&app, profile))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn get_profile(id: &str) -> Result<LogProfile, String> {
    log_profiles_list()?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| format!("Log profile '{id}' not found"))
}

fn upsert_profile(path: &PathBuf, profile: LogProfile) -> Result<LogProfile, String> {
    let _guard = PROFILES_LOCK
        .lock()
        .map_err(|_| "Log profile storage lock poisoned".to_string())?;
    let mut profiles: Vec<LogProfile> = load_json_or_default(path)?;
    if let Some(existing) = profiles
        .iter_mut()
        .find(|candidate| candidate.id == profile.id)
    {
        *existing = profile.clone();
    } else {
        profiles.push(profile.clone());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&profiles).map_err(|err| err.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    // 先完成同目录临时文件，再替换旧配置，读取端始终能读到完整版本。
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|err| err.to_string())?;
    let result = out.write_all(&json).and_then(|_| out.sync_all());
    drop(out);
    if let Err(error) = result.and_then(|_| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to update log profiles: {error}"));
    }
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retains_mixed_sources_and_only_replaces_the_profile_with_the_same_id() {
        let root = std::env::temp_dir().join(format!(
            "openix-log-profiles-{}-{}",
            std::process::id(),
            crate::state::epoch_ms()
        ));
        let path = root.join("log-profiles.json");
        let first: LogProfile = serde_json::from_value(json!({
            "id": "bench",
            "name": "Bench logs",
            "notes": "离线日志",
            "sources": [
                {"type": "serial", "label": "USB", "port_name": "/dev/ttyACM3", "baud_rate": 1000000},
                {"type": "adb", "label": "Kernel", "serial": "test-device", "command": "  adb shell cat /dev/kmsg  "}
            ]
        }))
        .unwrap();
        first.validate().unwrap();
        assert_eq!(upsert_profile(&path, first.clone()).unwrap(), first);

        let mut second = first.clone();
        second.id = "other".into();
        upsert_profile(&path, second.clone()).unwrap();
        let mut edited = first;
        edited.name = "台架日志".into();
        upsert_profile(&path, edited.clone()).unwrap();
        assert_eq!(
            load_json_or_default::<Vec<LogProfile>>(&path).unwrap(),
            vec![edited, second]
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn round_trips_serial_parameters_and_formats_with_legacy_endpoints() {
        let input = json!({
            "id": "serial-formats",
            "name": "Serial formats",
            "sources": [{
                "type": "serial",
                "label": "USB",
                "port_name": "/dev/ttyACM3",
                "baud_rate": 9600,
                "line_coding": {
                    "data_bits": 7,
                    "stop_bits": 2,
                    "parity": "even",
                    "flow_control": "software"
                },
                "serial_options": {
                    "receive_format": "hex",
                    "send_format": "text",
                    "charset": "utf-8",
                    "line_ending": "crlf",
                    "auto_scroll": false
                }
            }],
            "bridge": {
                "first": { "label": "A", "port_name": "/dev/ttyUSB0", "baud_rate": 115200 },
                "second": { "label": "B", "port_name": "/dev/ttyUSB1", "baud_rate": 115200 }
            },
            "notes": ""
        });
        let profile: LogProfile = serde_json::from_value(input.clone()).unwrap();
        profile.validate().unwrap();
        assert_eq!(serde_json::to_value(&profile).unwrap(), input);

        let mut invalid = input;
        invalid["sources"][0]["line_coding"]["data_bits"] = json!(4);
        let invalid: LogProfile = serde_json::from_value(invalid).unwrap();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn rejects_duplicate_sources_and_invalid_adb_commands() {
        let mut profile: LogProfile = serde_json::from_value(json!({
            "id": "fixture",
            "name": "Fixture",
            "sources": [
                {"type": "adb", "label": "first", "serial": "test-device", "command": "cat /dev/kmsg"},
                {"type": "adb", "label": "second", "serial": "test-device", "command": "adb shell cat /dev/kmsg"}
            ]
        }))
        .unwrap();
        assert!(profile.notes.is_empty());
        assert!(profile.validate().unwrap_err().contains("Repeated ADB"));
        if let LogSource::Adb { command, .. } = &mut profile.sources[1] {
            *command = "adb reboot".into();
        }
        assert!(profile.validate().is_err());
    }

    #[test]
    fn accepts_bridge_only_profiles_and_rejects_an_endpoint_reused_as_its_peer() {
        let mut profile: LogProfile = serde_json::from_value(json!({
            "id": "bridge",
            "name": "Bridge",
            "bridge": {
                "first": {"label": "A", "port_name": "/dev/ttyUSB0", "baud_rate": 115200},
                "second": {"label": "B", "port_name": "/dev/ttyUSB1", "baud_rate": 9600}
            }
        }))
        .unwrap();
        assert!(profile.sources.is_empty());
        assert!(profile.validate().is_ok());
        let bridge = profile.bridge.as_mut().unwrap();
        bridge.second.port_name = bridge.first.port_name.clone();
        assert!(profile.validate().is_err());
    }
}
