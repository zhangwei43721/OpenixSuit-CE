use crate::log_capture::{CaptureWriter, LogCapturePolicy};
use crate::log_sessions::{notify_session, LogSession, LogSessionChangeKind};
use crate::state::{epoch_ms, epoch_secs, format_compact_utc, format_utc_timestamp, AppState};
use base64::engine::general_purpose::STANDARD as B64_ENGINE;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serialport::SerialPortType;
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) mod bridge;
mod options;

use options::SerialLineEnding;
pub use options::SerialOptions;

const SERIAL_BUFFER_MAX_LINES: usize = 2000;
const PENDING_LINE_MAX_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: String,
    pub product: String,
    pub serial_number: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_interface: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialSessionInfo {
    pub id: String,
    pub port_name: String,
    pub baud_rate: u32,
    pub log_path: String,
    pub connected: bool,
    #[serde(default)]
    pub line_coding: SerialLineCoding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_options: Option<SerialOptions>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SerialDataPayload {
    pub session_id: String,
    pub port_name: String,
    pub chunk: String,
    pub timestamp: String,
    /// Raw received bytes (base64) so the UI can decode with the chosen charset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

/// Line coding parameters for opening a serial port.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerialLineCoding {
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
}

impl Default for SerialLineCoding {
    fn default() -> Self {
        Self {
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            flow_control: "none".into(),
        }
    }
}

impl SerialLineCoding {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(5..=8).contains(&self.data_bits)
            || !matches!(self.stop_bits, 1 | 2)
            || !matches!(self.parity.as_str(), "none" | "even" | "odd")
            || !matches!(self.flow_control.as_str(), "none" | "software" | "hardware")
        {
            return Err("Invalid serial line coding".to_string());
        }
        Ok(())
    }

    fn normalize(mut self) -> Self {
        if self.data_bits < 5 || self.data_bits > 8 {
            self.data_bits = 8;
        }
        if self.stop_bits != 2 {
            self.stop_bits = 1;
        }
        if !matches!(self.parity.as_str(), "even" | "odd") {
            self.parity = "none".into();
        }
        if !matches!(self.flow_control.as_str(), "software" | "hardware") {
            self.flow_control = "none".into();
        }
        self
    }

    fn to_data_bits(&self) -> serialport::DataBits {
        match self.data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        }
    }

    fn to_stop_bits(&self) -> serialport::StopBits {
        if self.stop_bits == 2 {
            serialport::StopBits::Two
        } else {
            serialport::StopBits::One
        }
    }

    fn to_parity(&self) -> serialport::Parity {
        match self.parity.as_str() {
            "even" => serialport::Parity::Even,
            "odd" => serialport::Parity::Odd,
            _ => serialport::Parity::None,
        }
    }

    fn to_flow_control(&self) -> serialport::FlowControl {
        match self.flow_control.as_str() {
            "software" => serialport::FlowControl::Software,
            "hardware" => serialport::FlowControl::Hardware,
            _ => serialport::FlowControl::None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialLogEntry {
    pub file_name: String,
    pub directory: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_secs: u64,
}

pub struct SerialSessionHandle {
    pub id: String,
    pub(crate) label: Option<String>,
    pub port_name: String,
    pub baud_rate: u32,
    pub(crate) line_coding: SerialLineCoding,
    pub(crate) serial_options: Option<SerialOptions>,
    pub log_path: String,
    writer: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    pub stop_flag: Arc<AtomicBool>,
    pub connected: Arc<AtomicBool>,
    pub buffer: Arc<Mutex<VecDeque<String>>>,
    pub last_rx_epoch_ms: Arc<AtomicU64>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl SerialSessionHandle {
    pub fn info(&self) -> SerialSessionInfo {
        SerialSessionInfo {
            id: self.id.clone(),
            port_name: self.port_name.clone(),
            baud_rate: self.baud_rate,
            log_path: self.log_path.clone(),
            connected: self.connected.load(Ordering::Relaxed),
            line_coding: self.line_coding.clone(),
            serial_options: self.serial_options.clone(),
        }
    }

    fn is_open(&self) -> bool {
        self.connected.load(Ordering::Relaxed) && !self.stop_flag.load(Ordering::Relaxed)
    }
}

pub(crate) fn sanitize_port_name(port_name: &str) -> String {
    let trimmed = port_name.trim_start_matches("/dev/");
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let clean = out.trim_matches('_');
    if clean.is_empty() {
        "serial".to_string()
    } else {
        clean.to_string()
    }
}

fn push_line_to_ring(buffer: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut guard) = buffer.lock() {
        while guard.len() >= SERIAL_BUFFER_MAX_LINES {
            guard.pop_front();
        }
        guard.push_back(line);
    }
}

fn record_complete_line(
    app: &AppHandle,
    session_id: &str,
    port_name: &str,
    line: String,
    ts_str: &str,
    buffer: &Arc<Mutex<VecDeque<String>>>,
    log_writer: &mut CaptureWriter,
) {
    let _ = log_writer.record_line(ts_str, &line);
    push_line_to_ring(buffer, line.clone());
    crate::triggers::on_serial_line(app, session_id, port_name, &line);
}

fn get_session(state: &AppState, session_id: &str) -> Result<Arc<SerialSessionHandle>, String> {
    let guard = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?;
    guard
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Serial session not found: {}", session_id))
}

pub fn serial_write_with_state(
    state: &AppState,
    session_id: &str,
    data: &str,
    append_newline: Option<&str>,
) -> Result<(), String> {
    serial_write_with_ending(state, session_id, data.as_bytes().to_vec(), append_newline)
}

pub(crate) fn serial_write_hex_with_state(
    state: &AppState,
    session_id: &str,
    data: &str,
    append_newline: Option<&str>,
) -> Result<(), String> {
    serial_write_with_ending(
        state,
        session_id,
        options::decode_hex(data)?,
        append_newline,
    )
}

fn serial_write_with_ending(
    state: &AppState,
    session_id: &str,
    mut payload: Vec<u8>,
    append_newline: Option<&str>,
) -> Result<(), String> {
    let ending = SerialLineEnding::parse(append_newline)?;
    payload.extend_from_slice(ending.bytes());
    serial_write_payload(state, session_id, &payload)
}

fn serial_write_base64_with_state(
    state: &AppState,
    session_id: &str,
    data_base64: &str,
) -> Result<(), String> {
    let payload = B64_ENGINE
        .decode(data_base64)
        .map_err(|error| format!("Invalid serial byte payload: {error}"))?;
    serial_write_payload(state, session_id, &payload)
}

fn serial_write_payload(state: &AppState, session_id: &str, payload: &[u8]) -> Result<(), String> {
    let session = get_session(state, session_id)?;
    let mut port = session
        .writer
        .lock()
        .map_err(|_| "Serial writer lock poisoned".to_string())?;
    let port = port
        .as_mut()
        .filter(|_| session.is_open())
        .ok_or_else(|| format!("Serial session '{session_id}' is disconnected"))?;
    port.write_all(payload)
        .map_err(|e| format!("Failed to write to serial port: {}", e))?;
    port.flush()
        .map_err(|e| format!("Failed to flush serial port: {}", e))
}

pub fn serial_get_buffer_with_state(
    state: &AppState,
    session_id: &str,
    tail_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let session = get_session(state, session_id)?;
    let guard = session
        .buffer
        .lock()
        .map_err(|_| "Serial buffer lock poisoned".to_string())?;
    let total = guard.len();
    let skip = match tail_lines {
        Some(n) => total.saturating_sub(n),
        None => 0,
    };
    Ok(guard.iter().skip(skip).cloned().collect())
}

#[tauri::command]
pub fn serial_list_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports()
        .map_err(|e| format!("Failed to enumerate serial ports: {}", e))?;
    let mut list: Vec<SerialPortInfo> = ports
        .into_iter()
        .map(|p| {
            let mut port = SerialPortInfo {
                port_name: p.port_name,
                port_type: match p.port_type {
                    SerialPortType::UsbPort(_) => "usb",
                    SerialPortType::PciPort => "pci",
                    SerialPortType::BluetoothPort => "bluetooth",
                    SerialPortType::Unknown => "unknown",
                }
                .to_string(),
                vid: None,
                pid: None,
                manufacturer: String::new(),
                product: String::new(),
                serial_number: String::new(),
                aliases: Vec::new(),
                usb_interface: None,
            };
            if let SerialPortType::UsbPort(usb) = p.port_type {
                port.vid = Some(usb.vid);
                port.pid = Some(usb.pid);
                port.manufacturer = usb.manufacturer.unwrap_or_default();
                port.product = usb.product.unwrap_or_default();
                port.serial_number = usb.serial_number.unwrap_or_default();
                port.usb_interface = usb.interface;
            }
            port
        })
        .collect();
    #[cfg(target_os = "linux")]
    add_serial_port_aliases(
        &mut list,
        &[
            Path::new("/dev/serial/by-path"),
            Path::new("/dev/serial/by-id"),
        ],
    );
    list.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    Ok(list)
}

#[cfg(target_os = "linux")]
fn add_serial_port_aliases(ports: &mut [SerialPortInfo], directories: &[&Path]) {
    use std::collections::HashMap;

    let mut aliases: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for directory in directories {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
                continue;
            }
            let path = entry.path();
            if let (Some(name), Ok(target)) = (path.to_str(), fs::canonicalize(&path)) {
                aliases.entry(target).or_default().push(name.to_owned());
            }
        }
    }
    if aliases.is_empty() {
        return;
    }
    for port in ports {
        if let Some(names) = fs::canonicalize(&port.port_name)
            .ok()
            .and_then(|target| aliases.get(&target))
        {
            port.aliases.clone_from(names);
            port.aliases.sort();
        }
    }
}

#[tauri::command]
pub fn serial_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    port_name: String,
    baud_rate: u32,
    line_coding: Option<SerialLineCoding>,
    serial_options: Option<SerialOptions>,
) -> Result<SerialSessionInfo, String> {
    open_serial_session(
        &app,
        &state,
        session_id,
        port_name,
        baud_rate,
        SerialOpenOptions {
            line_coding,
            serial_options,
        },
        None,
    )
    .map(|(handle, _)| handle.info())
}

pub(crate) fn same_port(first: &str, second: &str) -> bool {
    if first == second {
        return true;
    }
    #[cfg(windows)]
    {
        let port = |port: &str| port.trim_start_matches(r"\\.\").to_ascii_uppercase();
        port(first) == port(second)
    }
    #[cfg(not(windows))]
    {
        fs::canonicalize(first)
            .ok()
            .zip(fs::canonicalize(second).ok())
            .is_some_and(|(first, second)| first == second)
    }
}

// 通用发送错误只有在端口确实消失时才进入重连流程。
fn serial_write_interrupted(error: &io::Error, port_name: &str) -> bool {
    match error.kind() {
        ErrorKind::BrokenPipe
        | ErrorKind::NotConnected
        | ErrorKind::ConnectionReset
        | ErrorKind::NotFound => return true,
        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::InvalidInput => return false,
        _ => {}
    }
    #[cfg(unix)]
    {
        matches!(error.raw_os_error(), Some(libc::ENODEV | libc::ENXIO))
            || (Path::new(port_name).is_absolute()
                && fs::metadata(port_name).is_err_and(|err| err.kind() == ErrorKind::NotFound))
    }
    #[cfg(windows)]
    {
        // Windows ERROR_DEVICE_NOT_CONNECTED。
        const DEVICE_NOT_CONNECTED: i32 = 1167;
        error.raw_os_error() == Some(DEVICE_NOT_CONNECTED)
            || serialport::available_ports().is_ok_and(|ports| {
                !ports
                    .iter()
                    .any(|port| same_port(&port.port_name, port_name))
            })
    }
}

#[derive(Default)]
pub(crate) struct SerialOpenOptions {
    pub(crate) line_coding: Option<SerialLineCoding>,
    pub(crate) serial_options: Option<SerialOptions>,
}

pub(crate) fn open_serial_session(
    app: &AppHandle,
    state: &AppState,
    session_id: String,
    port_name: String,
    baud_rate: u32,
    options: SerialOpenOptions,
    label: Option<String>,
) -> Result<(Arc<SerialSessionHandle>, bool), String> {
    let sid = if session_id.trim().is_empty() {
        format!("serial-{}", epoch_ms())
    } else {
        session_id.trim().to_string()
    };

    let baud = if baud_rate == 0 { 115200 } else { baud_rate };
    let requested_coding = options.line_coding.map(SerialLineCoding::normalize);
    let mut sessions = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?;
    if sessions.get(&sid).is_some_and(|handle| {
        handle.connected.load(Ordering::Relaxed) || handle.stop_flag.load(Ordering::Relaxed)
    }) {
        return Err(format!("Serial session '{sid}' is already open"));
    }
    if let Some(active) = sessions.values().find(|handle| {
        (handle.connected.load(Ordering::Relaxed) || handle.stop_flag.load(Ordering::Relaxed))
            && same_port(&handle.port_name, &port_name)
    }) {
        if active.is_open()
            && label.is_some()
            && active.baud_rate == baud
            && requested_coding
                .as_ref()
                .is_none_or(|coding| *coding == active.line_coding)
        {
            return Ok((Arc::clone(active), false));
        }
        return Err(format!(
            "Serial port '{port_name}' is already open at {} baud ({} data bits, {} stop bits, {} parity, {} flow control)",
            active.baud_rate, active.line_coding.data_bits, active.line_coding.stop_bits,
            active.line_coding.parity, active.line_coding.flow_control
        ));
    }
    let coding = requested_coding.unwrap_or_default();
    let port = serialport::new(&port_name, baud)
        .data_bits(coding.to_data_bits())
        .stop_bits(coding.to_stop_bits())
        .parity(coding.to_parity())
        .flow_control(coding.to_flow_control())
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Failed to open serial port '{}': {}", port_name, e))?;

    let mut reader_port = port
        .try_clone()
        .map_err(|e| format!("Failed to clone serial port '{}': {}", port_name, e))?;

    let log_dir = state.log_capture.logs_directory()?;
    let log_file_name = format!(
        "{}_{}.log",
        sanitize_port_name(&port_name),
        format_compact_utc(epoch_secs())
    );
    let log_path = log_dir.join(&log_file_name);
    let log_path_str = log_path.to_string_lossy().to_string();
    let mut log_writer = CaptureWriter::new(state.log_capture.clone(), log_path)?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let connected = Arc::new(AtomicBool::new(true));
    let buffer = Arc::new(Mutex::new(VecDeque::with_capacity(SERIAL_BUFFER_MAX_LINES)));
    let last_rx_epoch_ms = Arc::new(AtomicU64::new(epoch_ms()));

    let handle = Arc::new(SerialSessionHandle {
        id: sid.clone(),
        label,
        port_name: port_name.clone(),
        baud_rate: baud,
        line_coding: coding,
        serial_options: options.serial_options,
        log_path: log_path_str.clone(),
        writer: Mutex::new(Some(port)),
        stop_flag: Arc::clone(&stop_flag),
        connected: Arc::clone(&connected),
        buffer: Arc::clone(&buffer),
        last_rx_epoch_ms: Arc::clone(&last_rx_epoch_ms),
        worker: Mutex::new(None),
    });

    let log_session = LogSession::from(handle.as_ref());
    sessions.retain(|id, handle| {
        id != &sid
            && (handle.connected.load(Ordering::Relaxed)
                || !same_port(&handle.port_name, &port_name))
    });
    sessions.insert(sid.clone(), Arc::clone(&handle));
    notify_session(app, LogSessionChangeKind::Started, &log_session, None);

    let bridge = state.serial_bridge.clone();
    let active_sessions = Arc::clone(&state.serial_sessions);
    let worker_handle = Arc::clone(&handle);
    let app = app.clone();
    let worker = std::thread::spawn(move || {
        let mut read_buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::with_capacity(1024);
        let mut read_error = None;

        while !stop_flag.load(Ordering::Relaxed) {
            match reader_port.read(&mut read_buf) {
                Ok(0) => {
                    read_error = Some(format!("Serial port '{port_name}' disconnected"));
                    break;
                }
                Ok(n) => {
                    let bridge_at_read = bridge.current().ok().flatten();
                    let now_ms = epoch_ms();
                    last_rx_epoch_ms.store(now_ms, Ordering::Relaxed);
                    let ts_str = format_utc_timestamp(now_ms);
                    let chunk_bytes = &read_buf[..n];
                    let chunk = String::from_utf8_lossy(chunk_bytes).to_string();
                    let data_base64 = B64_ENGINE.encode(chunk_bytes);

                    let _ = app.emit(
                        "serial-data",
                        SerialDataPayload {
                            session_id: sid.clone(),
                            port_name: port_name.clone(),
                            chunk,
                            timestamp: ts_str.clone(),
                            data_base64: Some(data_base64),
                        },
                    );

                    pending.extend_from_slice(chunk_bytes);
                    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                        let raw_line: Vec<u8> = pending.drain(..=pos).collect();
                        let mut text = String::from_utf8_lossy(&raw_line).to_string();
                        while text.ends_with('\n') || text.ends_with('\r') {
                            text.pop();
                        }
                        record_complete_line(
                            &app,
                            &sid,
                            &port_name,
                            text,
                            &ts_str,
                            &buffer,
                            &mut log_writer,
                        );
                    }

                    if pending.len() >= PENDING_LINE_MAX_BYTES {
                        let raw_line: Vec<u8> = pending.drain(..).collect();
                        let text = String::from_utf8_lossy(&raw_line).to_string();
                        record_complete_line(
                            &app,
                            &sid,
                            &port_name,
                            text,
                            &ts_str,
                            &buffer,
                            &mut log_writer,
                        );
                    }

                    let _ = log_writer.flush();
                    if let Some(active_bridge) = bridge_at_read {
                        bridge.forward(&app, &active_bridge, &worker_handle, &ts_str, chunk_bytes);
                    }
                }
                Err(ref e)
                    if matches!(
                        e.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(error) => {
                    read_error = Some(format!("Serial port '{port_name}': {error}"));
                    break;
                }
            }
        }

        if !pending.is_empty() {
            let ts_str = format_utc_timestamp(epoch_ms());
            let mut text = String::from_utf8_lossy(&pending).to_string();
            while text.ends_with('\n') || text.ends_with('\r') {
                text.pop();
            }
            if !text.is_empty() {
                record_complete_line(
                    &app,
                    &sid,
                    &port_name,
                    text,
                    &ts_str,
                    &buffer,
                    &mut log_writer,
                );
            }
        }
        let _ = log_writer.flush();
        drop(log_writer);
        drop(reader_port);
        worker_handle
            .writer
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();

        // 串口句柄先归还，再发布结束通知，确保重新打开排在旧会话通知之后。
        let _sessions = active_sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        connected.store(false, Ordering::Relaxed);
        let interrupted = !stop_flag.load(Ordering::Relaxed);
        bridge.end_for_session(&app, &worker_handle, interrupted);
        let (kind, error) = if interrupted {
            (LogSessionChangeKind::Interrupted, read_error.as_deref())
        } else {
            (LogSessionChangeKind::Ended, None)
        };
        notify_session(&app, kind, &log_session, error);
        worker_handle
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    });
    *handle.worker.lock().expect("serial worker is unpublished") = Some(worker);
    drop(sessions);

    Ok((handle, true))
}

#[tauri::command]
pub async fn serial_close(app: AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        serial_close_with_state(&app, &app.state::<AppState>(), &session_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

pub(crate) fn serial_close_with_state(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
) -> Result<(), String> {
    let guard = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?;
    let session = guard
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Serial session not found: {}", session_id))?;
    if session.stop_flag.swap(true, Ordering::Relaxed) {
        return Err(format!("Serial session '{session_id}' is already closing"));
    }
    let was_connected = session.connected.load(Ordering::Relaxed);
    drop(guard);
    state.serial_bridge.end_for_session(app, &session, false);
    // 读取线程先刷完末尾日志和释放句柄，再返回以便连续关闭和重开同一串口。
    let worker = session
        .worker
        .lock()
        .map_err(|_| "Serial worker lock poisoned".to_string())?
        .take();
    let result = worker.map(|worker| worker.join()).transpose();
    let mut sessions = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?;
    sessions.remove(session_id);
    if !was_connected {
        notify_session(
            app,
            LogSessionChangeKind::Ended,
            &LogSession::from(session.as_ref()),
            None,
        );
    }
    result.map_err(|_| "Serial reader panicked".to_string())?;
    Ok(())
}

#[tauri::command]
pub fn serial_list_sessions(state: State<'_, AppState>) -> Result<Vec<SerialSessionInfo>, String> {
    let guard = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?;
    let mut list: Vec<SerialSessionInfo> = guard.values().map(|s| s.info()).collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(list)
}

#[tauri::command]
pub fn serial_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
    append_newline: Option<String>,
) -> Result<(), String> {
    serial_write_with_state(&state, &session_id, &data, append_newline.as_deref())
}

#[tauri::command]
pub fn serial_write_bytes(
    state: State<'_, AppState>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    serial_write_base64_with_state(&state, &session_id, &data_base64)
}

#[tauri::command]
pub fn serial_set_signals(
    state: State<'_, AppState>,
    session_id: String,
    dtr: Option<bool>,
    rts: Option<bool>,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    let mut port = session
        .writer
        .lock()
        .map_err(|_| "Serial writer lock poisoned".to_string())?;
    let port = port
        .as_mut()
        .filter(|_| session.is_open())
        .ok_or_else(|| format!("Serial session '{session_id}' is disconnected"))?;
    if let Some(level) = dtr {
        port.write_data_terminal_ready(level)
            .map_err(|e| format!("Failed to set DTR: {}", e))?;
    }
    if let Some(level) = rts {
        port.write_request_to_send(level)
            .map_err(|e| format!("Failed to set RTS: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn serial_get_buffer(
    state: State<'_, AppState>,
    session_id: String,
    tail_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    serial_get_buffer_with_state(&state, &session_id, tail_lines)
}

fn is_log_path(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("log"))
}

#[tauri::command]
pub fn serial_list_log_files(state: State<'_, AppState>) -> Result<Vec<SerialLogEntry>, String> {
    list_log_files(&state.log_capture)
}

pub(crate) fn list_log_files(policy: &LogCapturePolicy) -> Result<Vec<SerialLogEntry>, String> {
    list_log_files_in(&policy.history_directories()?)
}

fn list_log_files_in(directories: &[PathBuf]) -> Result<Vec<SerialLogEntry>, String> {
    let mut list = Vec::new();
    for (index, dir) in directories.iter().enumerate() {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if index != 0 || error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to read serial logs in {}: {error}",
                    dir.display()
                ))
            }
        };
        let directory = dir.to_string_lossy();
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_log_path(&path) || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let modified_secs = meta
                .modified()
                .ok()
                .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |timestamp| timestamp.as_secs());
            list.push(SerialLogEntry {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                directory: directory.to_string(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: meta.len(),
                modified_secs,
            });
        }
    }
    list.sort_by(|a, b| {
        b.modified_secs
            .cmp(&a.modified_secs)
            .then(a.file_name.cmp(&b.file_name))
            .then(a.path.cmp(&b.path))
    });
    Ok(list)
}

#[tauri::command]
pub fn serial_read_log_file(
    state: State<'_, AppState>,
    file_name: String,
    tail_lines: Option<usize>,
    directory: Option<String>,
) -> Result<String, String> {
    read_log_file(
        &state.log_capture,
        &file_name,
        tail_lines,
        directory.as_deref(),
    )
}

pub(crate) fn read_log_file(
    policy: &LogCapturePolicy,
    file_name: &str,
    tail_lines: Option<usize>,
    directory: Option<&str>,
) -> Result<String, String> {
    let directories = policy.history_directories()?;
    read_log_file_in(&directories, file_name, tail_lines, directory)
}

fn read_log_file_in(
    directories: &[PathBuf],
    file_name: &str,
    tail_lines: Option<usize>,
    directory: Option<&str>,
) -> Result<String, String> {
    if file_name.is_empty()
        || file_name.contains(['/', '\\'])
        || file_name.contains("..")
        || Path::new(file_name).file_name() != Some(OsStr::new(file_name))
        || !is_log_path(Path::new(file_name))
    {
        return Err("Invalid serial log file name".to_string());
    }
    let target = directories
        .iter()
        .filter(|root| directory.is_none_or(|selected| root.as_path() == Path::new(selected)))
        .map(|root| root.join(file_name))
        .find(|candidate| fs::symlink_metadata(candidate).is_ok_and(|meta| meta.is_file()))
        .ok_or_else(|| format!("Log file not found: {file_name}"))?;

    let bytes = fs::read(&target).map_err(|e| format!("Failed to read log file: {}", e))?;
    let content = String::from_utf8_lossy(&bytes).to_string();

    match tail_lines {
        Some(n) => {
            let lines: Vec<&str> = content.lines().collect();
            let skip = lines.len().saturating_sub(n);
            Ok(lines[skip..].join("\n"))
        }
        None => Ok(content),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_duplicate_names_by_directory_and_skips_unmanaged_paths() {
        let temp = std::env::temp_dir().join(format!(
            "openix-log-history-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        let current = temp.join("current");
        let legacy = temp.join("legacy");
        let other = temp.join("other");
        for (dir, text) in [(&current, "new"), (&legacy, "old"), (&other, "ignored")] {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("same.log"), text).unwrap();
        }
        fs::write(current.join("unrelated.txt"), "not a log").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(other.join("same.log"), current.join("outside.log")).unwrap();

        let roots = [current, legacy.clone()];
        let entries = list_log_files_in(&roots).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.file_name == "same.log"));
        assert_eq!(
            read_log_file_in(&roots, "same.log", None, None).unwrap(),
            "new"
        );
        assert_eq!(
            read_log_file_in(&roots, "same.log", None, legacy.to_str()).unwrap(),
            "old"
        );
        assert!(read_log_file_in(&roots, "same.log", None, other.to_str()).is_err());
        assert!(read_log_file_in(&roots, "../other/same.log", None, None).is_err());
        assert!(read_log_file_in(&roots, "outside.log", None, None).is_err());
        fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn associates_serial_aliases_with_their_enumerated_ports() {
        use std::os::unix::fs::symlink;

        let temp = std::env::temp_dir().join(format!(
            "openix-serial-alias-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        let by_id = temp.join("by-id");
        let by_path = temp.join("by-path");
        fs::create_dir_all(&by_id).unwrap();
        fs::create_dir(&by_path).unwrap();
        for name in ["ttyUSB0", "ttyUSB1"] {
            fs::write(temp.join(name), []).unwrap();
        }
        symlink("../ttyUSB0", by_id.join("serial")).unwrap();
        symlink("../ttyUSB0", by_path.join("slot0")).unwrap();
        symlink("../ttyUSB1", by_path.join("slot1")).unwrap();
        symlink("../unplugged", by_path.join("missing")).unwrap();

        let mut ports = ["ttyUSB0", "ttyUSB1"].map(|name| SerialPortInfo {
            port_name: temp.join(name).into_os_string().into_string().unwrap(),
            port_type: "usb".into(),
            vid: Some(0x1a86),
            pid: Some(0x7523),
            manufacturer: String::new(),
            product: String::new(),
            serial_number: String::new(),
            aliases: Vec::new(),
            usb_interface: Some(0),
        });
        add_serial_port_aliases(&mut ports, &[&by_path, &by_id]);
        assert_eq!(
            ports[0].aliases,
            [by_id.join("serial"), by_path.join("slot0")].map(|path| path.display().to_string())
        );
        assert_eq!(
            ports[1].aliases,
            [by_path.join("slot1").display().to_string()]
        );
        fs::remove_dir_all(temp).unwrap();
    }
}
