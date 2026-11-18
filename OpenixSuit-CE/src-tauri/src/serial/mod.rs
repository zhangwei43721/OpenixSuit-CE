use crate::state::{
    app_data_dir, epoch_ms, epoch_secs, format_compact_utc, format_utc_timestamp, AppState,
};
use base64::engine::general_purpose::STANDARD as B64_ENGINE;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serialport::SerialPortType;
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialSessionInfo {
    pub id: String,
    pub port_name: String,
    pub baud_rate: u32,
    pub log_path: String,
    pub connected: bool,
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
#[derive(Clone, Debug, Serialize, Deserialize)]
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
    pub path: String,
    pub size_bytes: u64,
    pub modified_secs: u64,
}

pub struct SerialSessionHandle {
    pub id: String,
    pub port_name: String,
    pub baud_rate: u32,
    pub log_path: String,
    pub writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    pub stop_flag: Arc<AtomicBool>,
    pub connected: Arc<AtomicBool>,
    pub buffer: Arc<Mutex<VecDeque<String>>>,
    pub last_rx_epoch_ms: Arc<AtomicU64>,
}

impl SerialSessionHandle {
    pub fn info(&self) -> SerialSessionInfo {
        SerialSessionInfo {
            id: self.id.clone(),
            port_name: self.port_name.clone(),
            baud_rate: self.baud_rate,
            log_path: self.log_path.clone(),
            connected: self.connected.load(Ordering::Relaxed),
        }
    }
}

fn serial_logs_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("logs").join("serial");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create serial log dir: {}", e))?;
    Ok(dir)
}

fn sanitize_port_name(port_name: &str) -> String {
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
    log_writer: &mut BufWriter<File>,
) {
    let _ = writeln!(log_writer, "[{}] {}", ts_str, line);
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
    let session = get_session(state, session_id)?;
    if !session.connected.load(Ordering::Relaxed) {
        return Err(format!("Serial session '{}' is disconnected", session_id));
    }
    let suffix = match append_newline.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("lf") => "\n",
        Some("crlf") => "\r\n",
        Some("none") | None => "",
        Some(other) => return Err(format!("Invalid append_newline mode: {}", other)),
    };
    let mut payload = Vec::with_capacity(data.len() + suffix.len());
    payload.extend_from_slice(data.as_bytes());
    payload.extend_from_slice(suffix.as_bytes());

    let mut port = session
        .writer
        .lock()
        .map_err(|_| "Serial writer lock poisoned".to_string())?;
    port.write_all(&payload)
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
        .map(|p| match p.port_type {
            SerialPortType::UsbPort(usb) => SerialPortInfo {
                port_name: p.port_name,
                port_type: "usb".to_string(),
                vid: Some(usb.vid),
                pid: Some(usb.pid),
                manufacturer: usb.manufacturer.unwrap_or_default(),
                product: usb.product.unwrap_or_default(),
                serial_number: usb.serial_number.unwrap_or_default(),
            },
            SerialPortType::PciPort => SerialPortInfo {
                port_name: p.port_name,
                port_type: "pci".to_string(),
                vid: None,
                pid: None,
                manufacturer: String::new(),
                product: String::new(),
                serial_number: String::new(),
            },
            SerialPortType::BluetoothPort => SerialPortInfo {
                port_name: p.port_name,
                port_type: "bluetooth".to_string(),
                vid: None,
                pid: None,
                manufacturer: String::new(),
                product: String::new(),
                serial_number: String::new(),
            },
            SerialPortType::Unknown => SerialPortInfo {
                port_name: p.port_name,
                port_type: "unknown".to_string(),
                vid: None,
                pid: None,
                manufacturer: String::new(),
                product: String::new(),
                serial_number: String::new(),
            },
        })
        .collect();
    list.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    Ok(list)
}

#[tauri::command]
pub fn serial_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    port_name: String,
    baud_rate: u32,
    line_coding: Option<SerialLineCoding>,
) -> Result<SerialSessionInfo, String> {
    let sid = if session_id.trim().is_empty() {
        format!("serial-{}", epoch_ms())
    } else {
        session_id.trim().to_string()
    };

    {
        let mut guard = state
            .serial_sessions
            .lock()
            .map_err(|_| "Serial sessions lock poisoned".to_string())?;
        if let Some(existing) = guard.get(&sid) {
            if existing.connected.load(Ordering::Relaxed) {
                return Err(format!("Serial session '{}' is already open", sid));
            }
            existing.stop_flag.store(true, Ordering::Relaxed);
            guard.remove(&sid);
        }
    }

    let baud = if baud_rate == 0 { 115200 } else { baud_rate };
    let coding = line_coding.unwrap_or_default().normalize();
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

    let log_dir = serial_logs_dir()?;
    let log_file_name = format!(
        "{}_{}.log",
        sanitize_port_name(&port_name),
        format_compact_utc(epoch_secs())
    );
    let log_path = log_dir.join(&log_file_name);
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create serial log file: {}", e))?;
    let log_path_str = log_path.to_string_lossy().to_string();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let connected = Arc::new(AtomicBool::new(true));
    let buffer = Arc::new(Mutex::new(VecDeque::with_capacity(SERIAL_BUFFER_MAX_LINES)));
    let last_rx_epoch_ms = Arc::new(AtomicU64::new(epoch_ms()));

    let handle = Arc::new(SerialSessionHandle {
        id: sid.clone(),
        port_name: port_name.clone(),
        baud_rate: baud,
        log_path: log_path_str.clone(),
        writer: Arc::new(Mutex::new(port)),
        stop_flag: Arc::clone(&stop_flag),
        connected: Arc::clone(&connected),
        buffer: Arc::clone(&buffer),
        last_rx_epoch_ms: Arc::clone(&last_rx_epoch_ms),
    });

    let info = handle.info();

    {
        let mut guard = state
            .serial_sessions
            .lock()
            .map_err(|_| "Serial sessions lock poisoned".to_string())?;
        guard.insert(sid.clone(), handle);
    }

    std::thread::spawn(move || {
        let mut log_writer = BufWriter::new(log_file);
        let mut read_buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::with_capacity(1024);

        while !stop_flag.load(Ordering::Relaxed) {
            match reader_port.read(&mut read_buf) {
                Ok(0) => continue,
                Ok(n) => {
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
                }
                Err(ref e)
                    if matches!(
                        e.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(_) => {
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
        connected.store(false, Ordering::Relaxed);
    });

    Ok(info)
}

#[tauri::command]
pub fn serial_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut guard = state
        .serial_sessions
        .lock()
        .map_err(|_| "Serial sessions lock poisoned".to_string())?;
    let session = guard
        .remove(&session_id)
        .ok_or_else(|| format!("Serial session not found: {}", session_id))?;
    session.stop_flag.store(true, Ordering::Relaxed);
    session.connected.store(false, Ordering::Relaxed);
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

#[tauri::command]
pub fn serial_list_log_files() -> Result<Vec<SerialLogEntry>, String> {
    let dir = serial_logs_dir()?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read serial logs: {}", e))?;
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let file_name = entry.file_name().to_string_lossy().to_string();
        list.push(SerialLogEntry {
            file_name,
            path: path.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            modified_secs,
        });
    }
    list.sort_by(|a, b| b.modified_secs.cmp(&a.modified_secs).then(a.file_name.cmp(&b.file_name)));
    Ok(list)
}

#[tauri::command]
pub fn serial_read_log_file(file_name: String, tail_lines: Option<usize>) -> Result<String, String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || Path::new(&file_name).file_name() != Some(OsStr::new(&file_name))
    {
        return Err("Invalid serial log file name".to_string());
    }

    let dir = serial_logs_dir()?;
    let target = dir.join(&file_name);
    if !target.is_file() {
        return Err(format!("Log file not found: {}", file_name));
    }

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
