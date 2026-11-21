use crate::adb::resolve_device;
use crate::log_capture::CaptureWriter;
use crate::log_sessions::{notify_session, LogSession, LogSessionChangeKind, LogSessionSource};
use crate::serial::sanitize_port_name;
use crate::state::{epoch_ms, format_compact_utc, format_utc_timestamp, AppState};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::watch;

const READ_BUFFER_BYTES: usize = 4096;
const MAX_PENDING_BYTES: usize = 16 * 1024;
static LOG_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Requested,
    AppExit,
}

#[derive(Clone)]
pub struct AdbLogHandle {
    session: LogSession,
    stop: watch::Sender<Option<StopReason>>,
    done: watch::Receiver<Option<Result<(), String>>>,
}

impl AdbLogHandle {
    fn stop(&self, reason: StopReason) {
        self.stop.send_if_modified(|stop| {
            if stop.is_some() {
                return false;
            }
            *stop = Some(reason);
            true
        });
    }

    async fn wait(mut self) -> Result<(), String> {
        self.done
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "ADB log collection task stopped unexpectedly".to_string())?
            .clone()
            .expect("completion was observed")
    }
}

#[derive(Serialize)]
pub struct AdbLogSession {
    id: String,
    log_path: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Stream {
    Stdout,
    Stderr,
}

#[derive(Clone, Serialize)]
struct LogData<'a> {
    session_id: &'a str,
    timestamp: &'a str,
    data_base64: String,
    stream: Stream,
}

#[derive(Clone, Serialize)]
struct LogEnded<'a> {
    session_id: &'a str,
    error: Option<&'a str>,
}

fn adb_device_available(serial: &str) -> bool {
    resolve_device(serial).is_ok_and(|device| device.is_online())
}

fn split_word(input: &str) -> (&str, &str) {
    input
        .split_once(char::is_whitespace)
        .map_or((input, ""), |(word, rest)| (word, rest.trim_start()))
}

pub(crate) fn device_command(input: &str) -> Result<String, String> {
    let input = input.trim();
    let (program, rest) = split_word(input);
    let command = if program == "adb" {
        let (operation, args) = split_word(rest);
        match operation {
            "shell" => args,
            "logcat" => rest,
            _ => return Err("Enter adb shell <command> or adb logcat [options] and select the device separately".to_string()),
        }
    } else {
        input
    };
    if command.is_empty() {
        return Err("Enter an ADB device command to collect logs".to_string());
    }
    Ok(command.to_string())
}

fn adb_log_command(adb: std::process::Command, command: &str) -> Command {
    let mut adb = Command::from(adb);
    // ADB 根据设备协议选择无终端模式或旧设备所需的伪终端。
    adb.args(["shell", "--", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    adb
}

#[tauri::command]
pub async fn adb_log_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    serial: String,
    command: String,
) -> Result<AdbLogSession, String> {
    let session = open_adb_log_session(&app, &state, session_id, serial, command, None)?;
    Ok(AdbLogSession {
        id: session.id,
        log_path: session.log_path,
    })
}

pub(crate) fn open_adb_log_session(
    app: &AppHandle,
    state: &AppState,
    session_id: String,
    serial: String,
    command: String,
    label: Option<String>,
) -> Result<LogSession, String> {
    let id = session_id.trim().to_string();
    if id.is_empty() {
        return Err("ADB log session ID cannot be empty".to_string());
    }
    let serial = serial.trim();
    if serial.is_empty() {
        return Err("Select an ADB device to collect logs".to_string());
    }
    let command = device_command(&command)?;
    let device = resolve_device(serial)?;
    if !device.is_online() {
        return Err(format!("ADB device '{}' is {}", device.target(), device.state));
    }
    let serial = device.target();
    let sessions = Arc::clone(&state.adb_log_sessions);
    let mut active = sessions
        .lock()
        .map_err(|_| "ADB log sessions lock poisoned".to_string())?;
    if active.contains_key(&id) {
        return Err(format!("ADB log session '{id}' is already open"));
    }
    if let Some(handle) = active.values().find(|handle| {
        matches!(&handle.session.source, LogSessionSource::Adb {
                serial: active_serial, command: active_command
            } if active_serial == serial && active_command == &command)
    }) {
        if label.is_some() {
            return Ok(handle.session.clone());
        }
        return Err(format!(
            "ADB log '{}' is already collecting this command",
            handle.session.id
        ));
    }

    let now_ms = epoch_ms();
    let serial_name = sanitize_port_name(serial);
    let name = format!(
        "adb_{}_{}_{:03}_{}.log",
        serial_name,
        format_compact_utc(now_ms / 1000),
        now_ms % 1000,
        LOG_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let serial = serial.to_owned();
    let path = state.log_capture.logs_directory()?.join(name);
    let log_path = path.to_string_lossy().into_owned();
    let writer = CaptureWriter::new(state.log_capture.clone(), path)?;
    let child = adb_log_command(device.command(), &command)
        .spawn()
        .map_err(|error| format!("Failed to start adb: {error}"))?;
    let (stop, stopped) = watch::channel(None);
    let (finished, done) = watch::channel(None);
    let session = LogSession::adb(id.clone(), log_path, label, serial.clone(), command);
    active.insert(
        id.clone(),
        AdbLogHandle {
            session: session.clone(),
            stop,
            done,
        },
    );
    // 短命令可能立即产出并退出，注册分屏的事件需先发。
    notify_session(app, LogSessionChangeKind::Started, &session, None);
    drop(active);

    let worker_session = session.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stop_reason = stopped.clone();
        let result = collect(child, writer, stopped, |stream, timestamp, bytes| {
            let _ = app.emit(
                "adb-log-data",
                LogData {
                    session_id: &worker_session.id,
                    timestamp,
                    data_base64: STANDARD.encode(bytes),
                    stream,
                },
            );
        })
        .await;
        let interrupted = if stop_reason.borrow().is_none() {
            // 设备断线也可能让旧版 ADB 以成功状态退出，因此另查实际连接。
            tokio::select! {
                _ = stop_reason.wait_for(Option::is_some) => false,
                available = tokio::task::spawn_blocking(move || adb_device_available(&serial)) => {
                    matches!(available, Ok(false))
                }
            }
        } else {
            false
        };
        // 应用退出仍回收进程并刷盘，保留分屏的下次恢复记录。
        let reason = *stop_reason.borrow();
        let report_end = reason != Some(StopReason::AppExit);
        if report_end {
            let _ = app.emit(
                "adb-log-ended",
                LogEnded {
                    session_id: &worker_session.id,
                    error: result.as_ref().err().map(String::as_str),
                },
            );
        }
        if let Ok(mut active) = sessions.lock() {
            active.remove(&worker_session.id);
        }
        if report_end {
            let kind = if interrupted && reason.is_none() {
                LogSessionChangeKind::Interrupted
            } else {
                LogSessionChangeKind::Ended
            };
            notify_session(
                &app,
                kind,
                &worker_session,
                result.as_ref().err().map(String::as_str),
            );
        }
        finished.send_replace(Some(result));
    });
    Ok(session)
}

#[tauri::command]
pub async fn adb_log_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    stop_session(&state, &session_id).await.map(|_| ())
}

pub(crate) async fn stop_session(state: &AppState, session_id: &str) -> Result<bool, String> {
    let session = state
        .adb_log_sessions
        .lock()
        .map_err(|_| "ADB log sessions lock poisoned".to_string())?
        .get(session_id)
        .cloned();
    if let Some(session) = session {
        session.stop(StopReason::Requested);
        session.wait().await?;
        return Ok(true);
    }
    Ok(false)
}

pub(crate) fn active_sessions(state: &AppState) -> Result<Vec<LogSession>, String> {
    let sessions = state
        .adb_log_sessions
        .lock()
        .map_err(|_| "ADB log sessions lock poisoned".to_string())?;
    Ok(sessions
        .values()
        .map(|handle| handle.session.clone())
        .collect())
}

pub async fn stop_all(state: &AppState) {
    let sessions = match state.adb_log_sessions.lock() {
        Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
        Err(_) => return,
    };
    for session in &sessions {
        session.stop(StopReason::AppExit);
    }
    for session in sessions {
        let _ = session.wait().await;
    }
}

async fn collect(
    mut child: Child,
    mut writer: CaptureWriter,
    stop: watch::Receiver<Option<StopReason>>,
    mut emit: impl FnMut(Stream, &str, &[u8]),
) -> Result<(), String> {
    let result = collect_streams(&mut child, &mut writer, stop, &mut emit).await;
    if result.is_err() {
        let _ = child.kill().await;
    }
    let flushed = tokio::task::block_in_place(move || {
        writer
            .flush()
            .map_err(|error| format!("Failed to flush ADB log: {error}"))
    });
    result.and(flushed)
}

async fn collect_streams(
    child: &mut Child,
    writer: &mut CaptureWriter,
    mut stop: watch::Receiver<Option<StopReason>>,
    emit: &mut impl FnMut(Stream, &str, &[u8]),
) -> Result<(), String> {
    let mut stdout = child.stdout.take().expect("adb stdout is piped");
    let mut stderr = child.stderr.take().expect("adb stderr is piped");
    let mut stdout_buf = [0; READ_BUFFER_BYTES];
    let mut stderr_buf = [0; READ_BUFFER_BYTES];
    let mut stdout_pending = Vec::new();
    let mut stderr_pending = Vec::new();
    let (mut stdout_open, mut stderr_open) = (true, true);
    let mut exit_status = None;
    let mut stopped = false;

    while stdout_open || stderr_open || exit_status.is_none() {
        let (stream, count) = tokio::select! {
            _ = stop.wait_for(Option::is_some), if !stopped => {
                stopped = true;
                if exit_status.is_none() {
                    exit_status = child.try_wait().map_err(|e| format!("Failed to check adb child: {e}"))?;
                    if exit_status.is_none() {
                        child.start_kill().map_err(|e| format!("Failed to stop adb child: {e}"))?;
                    }
                }
                continue;
            },
            result = child.wait(), if exit_status.is_none() => {
                exit_status = Some(result.map_err(|e| format!("Failed to wait for adb child: {e}"))?);
                continue;
            },
            read = stdout.read(&mut stdout_buf), if stdout_open => (Stream::Stdout, read),
            read = stderr.read(&mut stderr_buf), if stderr_open => (Stream::Stderr, read),
        };
        let count = count.map_err(|e| format!("Failed to read ADB log output: {e}"))?;
        let (buffer, pending, open) = match stream {
            Stream::Stdout => (&stdout_buf, &mut stdout_pending, &mut stdout_open),
            Stream::Stderr => (&stderr_buf, &mut stderr_pending, &mut stderr_open),
        };
        *open = count != 0;
        pending.extend_from_slice(&buffer[..count]);
        let commit = if !*open || pending.len() >= MAX_PENDING_BYTES {
            pending.len()
        } else {
            pending
                .iter()
                .rposition(|&byte| byte == b'\n')
                .map_or(0, |index| index + 1)
        };
        if commit == 0 {
            continue;
        }

        let bytes = &pending[..commit];
        let timestamp = format_utc_timestamp(epoch_ms());
        emit(stream, &timestamp, bytes);
        // 每批已解析的日志一次提交，磁盘写入期间让其他 ADB 会话继续读取。
        tokio::task::block_in_place(|| {
            for line in bytes.split_inclusive(|&byte| byte == b'\n') {
                let decoded = String::from_utf8_lossy(line);
                let line = decoded.trim_end_matches(['\r', '\n']);
                let result = match stream {
                    Stream::Stdout => writer.record_line(&timestamp, line),
                    Stream::Stderr => writer.record_line(&timestamp, &format!("[stderr] {line}")),
                };
                result.map_err(|error| format!("Failed to save ADB log: {error}"))?;
            }
            writer
                .flush()
                .map_err(|error| format!("Failed to flush ADB log: {error}"))
        })?;
        pending.drain(..commit);
    }

    let status = exit_status.expect("adb child was reaped");
    if stopped || status.success() {
        Ok(())
    } else {
        Err(format!("ADB log command exited with {status}"))
    }
}

#[cfg(test)]
mod tests;
