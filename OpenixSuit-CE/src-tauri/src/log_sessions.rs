use crate::adb_log;
use crate::log_profiles::{get_profile, LogSource, SerialEndpoint};
use crate::serial::{
    self, bridge, open_serial_session, SerialLineCoding, SerialOpenOptions, SerialOptions,
    SerialSessionHandle,
};
use crate::state::{epoch_ms, AppState};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
pub struct LogSession {
    pub(crate) id: String,
    pub(crate) log_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(flatten)]
    pub(crate) source: LogSessionSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LogSessionSource {
    Serial {
        port_name: String,
        baud_rate: u32,
        line_coding: SerialLineCoding,
        #[serde(skip_serializing_if = "Option::is_none")]
        serial_options: Option<SerialOptions>,
    },
    Adb {
        serial: String,
        command: String,
    },
}

impl From<&SerialSessionHandle> for LogSession {
    fn from(handle: &SerialSessionHandle) -> Self {
        Self {
            id: handle.id.clone(),
            log_path: handle.log_path.clone(),
            label: handle.label.clone(),
            source: LogSessionSource::Serial {
                port_name: handle.port_name.clone(),
                baud_rate: handle.baud_rate,
                line_coding: handle.line_coding.clone(),
                serial_options: handle.serial_options.clone(),
            },
        }
    }
}

impl LogSession {
    pub(crate) fn adb(
        id: String,
        log_path: String,
        label: Option<String>,
        serial: String,
        command: String,
    ) -> Self {
        Self {
            id,
            log_path,
            label,
            source: LogSessionSource::Adb { serial, command },
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LogSessionChangeKind {
    Started,
    Ended,
    Interrupted,
}

#[derive(Clone, Serialize)]
struct LogSessionChange<'a> {
    kind: LogSessionChangeKind,
    session: &'a LogSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

pub(crate) fn notify_session(
    app: &AppHandle,
    kind: LogSessionChangeKind,
    session: &LogSession,
    error: Option<&str>,
) {
    let _ = app.emit(
        "log-sessions-changed",
        LogSessionChange {
            kind,
            session,
            error,
        },
    );
}

fn next_id(kind: &str) -> String {
    format!(
        "{kind}-{}-{}",
        epoch_ms(),
        SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[tauri::command]
pub fn log_sessions_list(state: State<'_, AppState>) -> Result<Vec<LogSession>, String> {
    let mut sessions = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?
        .values()
        .filter(|handle| handle.connected.load(Ordering::Relaxed))
        .map(|handle| LogSession::from(handle.as_ref()))
        .collect::<Vec<_>>();
    sessions.extend(adb_log::active_sessions(&state)?);
    sessions.sort_by(|first, second| first.id.cmp(&second.id));
    Ok(sessions)
}

#[tauri::command]
pub async fn log_session_start(
    app: AppHandle,
    _state: State<'_, AppState>,
    profile_id: String,
    source_label: String,
) -> Result<LogSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = get_profile(&profile_id)?;
        let source = profile
            .sources
            .into_iter()
            .find(|source| source.label() == source_label)
            .ok_or_else(|| {
                format!("Log source '{source_label}' not found in profile '{profile_id}'")
            })?;
        let state = app.state::<AppState>();
        match source {
            LogSource::Serial {
                label,
                port_name,
                baud_rate,
                line_coding,
                serial_options,
            } => {
                let (handle, _) = open_serial_session(
                    &app,
                    &state,
                    next_id("serial"),
                    port_name,
                    baud_rate,
                    SerialOpenOptions {
                        line_coding,
                        serial_options,
                    },
                    Some(label),
                )?;
                Ok(LogSession::from(handle.as_ref()))
            }
            LogSource::Adb {
                label,
                serial,
                command,
            } => adb_log::open_adb_log_session(
                &app,
                &state,
                next_id("adb-log"),
                serial,
                command,
                Some(label),
            ),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn log_session_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    if adb_log::stop_session(&state, &session_id).await? {
        return Ok(());
    }
    serial::serial_close(app, session_id).await
}

#[tauri::command]
pub async fn log_profile_bridge_start(
    app: AppHandle,
    _state: State<'_, AppState>,
    profile_id: String,
) -> Result<bridge::SerialBridgeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bridge_profile = get_profile(&profile_id)?
            .bridge
            .ok_or_else(|| format!("Log profile '{profile_id}' has no configured serial bridge"))?;
        let state = app.state::<AppState>();
        // 桥的两路配置和手动启动共用同一个操作锁，失败时才释放这次打开的串口。
        let _operation = state
            .serial_bridge_operation
            .lock()
            .map_err(|_| "Serial bridge operation lock poisoned".to_string())?;
        if bridge::serial_bridge_status(app.state())?.is_some() {
            return Err("A serial bridge is already running".into());
        }
        let mut opened = Vec::new();
        let mut open = |endpoint: SerialEndpoint| {
            let (handle, created) = open_serial_session(
                &app,
                &state,
                next_id("serial"),
                endpoint.port_name,
                endpoint.baud_rate,
                SerialOpenOptions {
                    line_coding: endpoint.line_coding,
                    serial_options: None,
                },
                Some(endpoint.label),
            )?;
            if created {
                opened.push(handle.id.clone());
            }
            Ok::<_, String>(handle)
        };
        let result = (|| {
            let first = open(bridge_profile.first)?;
            let second = open(bridge_profile.second)?;
            bridge::start_serial_bridge(&app, &state, &first.id, &second.id)
        })();
        if result.is_err() {
            for session_id in opened {
                let _ = serial::serial_close_with_state(&app, &state, &session_id);
            }
        }
        result
    })
    .await
    .map_err(|err| err.to_string())?
}
