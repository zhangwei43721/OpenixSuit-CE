use super::{same_port, serial_write_interrupted, SerialSessionHandle};
use crate::log_capture::{CaptureWriter, LogCapturePolicy};
use crate::state::{epoch_ms, format_compact_utc, AppState};
use base64::engine::general_purpose::STANDARD as B64_ENGINE;
use base64::Engine as _;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};

static BRIDGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
pub struct SerialBridgeInfo {
    id: String,
    first_session_id: String,
    second_session_id: String,
    first_port: String,
    second_port: String,
    log_path: String,
}

#[derive(Clone, Serialize)]
struct SerialBridgeData<'a> {
    id: &'a str,
    from_session_id: &'a str,
    to_session_id: &'a str,
    from_port: &'a str,
    to_port: &'a str,
    timestamp: &'a str,
    data_base64: String,
}

#[derive(Clone, Serialize)]
struct SerialBridgeEnded {
    id: String,
    error: Option<String>,
    interrupted: bool,
}

enum BridgeFailure {
    Transport(String),
    Operation(String),
}

pub(super) struct SerialBridge {
    info: SerialBridgeInfo,
    first: Arc<SerialSessionHandle>,
    second: Arc<SerialSessionHandle>,
    active: RwLock<bool>,
    log: Mutex<CaptureWriter>,
}

impl SerialBridge {
    fn target(&self, source: &Arc<SerialSessionHandle>) -> Option<&SerialSessionHandle> {
        if Arc::ptr_eq(&self.first, source) {
            Some(&self.second)
        } else if Arc::ptr_eq(&self.second, source) {
            Some(&self.first)
        } else {
            None
        }
    }

    fn write_transfer(
        &self,
        source: &Arc<SerialSessionHandle>,
        timestamp: &str,
        bytes: &[u8],
        notify: impl FnOnce(SerialBridgeData<'_>),
    ) -> Result<(), BridgeFailure> {
        let Some(target) = self.target(source) else {
            return Ok(());
        };
        // 等待其他发送操作释放串口时，仍允许停止桥接。
        let mut writer = target
            .writer
            .lock()
            .map_err(|_| BridgeFailure::Operation("Serial writer lock poisoned".into()))?;
        let active = self
            .active
            .read()
            .map_err(|err| BridgeFailure::Operation(err.to_string()))?;
        if !*active
            || source.stop_flag.load(Ordering::Relaxed)
            || target.stop_flag.load(Ordering::Relaxed)
        {
            return Ok(());
        }
        for endpoint in [source.as_ref(), target] {
            if !endpoint.connected.load(Ordering::Relaxed) {
                return Err(BridgeFailure::Transport(format!(
                    "Serial port '{}' disconnected",
                    endpoint.port_name
                )));
            }
        }
        let port = writer.as_mut().ok_or_else(|| {
            BridgeFailure::Transport(format!("Serial port '{}' disconnected", target.port_name))
        })?;
        // 写入对端驱动队列即可。等待物理线路排空可能被硬件流控阻塞。
        if let Err(err) = port.write_all(bytes) {
            if target.stop_flag.load(Ordering::Relaxed) {
                return Ok(());
            }
            let message = format!(
                "Failed to forward {} -> {}: {err}",
                source.port_name, target.port_name
            );
            return Err(if serial_write_interrupted(&err, &target.port_name) {
                BridgeFailure::Transport(message)
            } else {
                BridgeFailure::Operation(message)
            });
        }
        drop(writer);

        let text = match std::str::from_utf8(bytes) {
            Ok(text) => text.escape_debug().to_string(),
            Err(_) => bytes.escape_ascii().to_string(),
        };
        let mut log = self.log.lock();
        let logged = match &mut log {
            Ok(writer) => {
                let line = format!("{} -> {}: {text}", source.port_name, target.port_name);
                writer
                    .record_line(timestamp, &line)
                    .and_then(|()| writer.flush())
                    .map_err(|error| format!("Failed to write serial bridge log: {error}"))
            }
            Err(_) => Err("Serial bridge log lock poisoned".to_string()),
        };
        // 发送实时事件时仍持有日志锁，让两个方向的显示顺序与文件一致。
        notify(SerialBridgeData {
            id: &self.info.id,
            from_session_id: &source.id,
            to_session_id: &target.id,
            from_port: &source.port_name,
            to_port: &target.port_name,
            timestamp,
            data_base64: B64_ENGINE.encode(bytes),
        });
        logged.map_err(BridgeFailure::Operation)
    }
}

#[derive(Default, Clone)]
pub(crate) struct SerialBridgeState(Arc<Mutex<Option<Arc<SerialBridge>>>>);

impl SerialBridgeState {
    fn start(
        &self,
        first: Arc<SerialSessionHandle>,
        second: Arc<SerialSessionHandle>,
        log_dir: &Path,
        log_policy: LogCapturePolicy,
    ) -> Result<SerialBridgeInfo, String> {
        let mut current = self.0.lock().map_err(|err| err.to_string())?;
        if current.is_some() {
            return Err("A serial bridge is already running".into());
        }
        if same_port(&first.port_name, &second.port_name) {
            return Err("Choose two different serial ports".into());
        }
        for endpoint in [&first, &second] {
            if !endpoint.is_open() {
                return Err(format!("Serial port '{}' disconnected", endpoint.port_name));
            }
        }

        let now = epoch_ms();
        let sequence = BRIDGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let id = format!(
            "{}_{:03}_{sequence}",
            format_compact_utc(now / 1000),
            now % 1000
        );
        let log_path = log_dir.join(format!("bridge_{id}.log"));
        let log = CaptureWriter::new(log_policy, log_path.clone())?
            .with_header(format!("{} <-> {}", first.port_name, second.port_name));
        let info = SerialBridgeInfo {
            id,
            first_session_id: first.id.clone(),
            second_session_id: second.id.clone(),
            first_port: first.port_name.clone(),
            second_port: second.port_name.clone(),
            log_path: log_path.to_string_lossy().into_owned(),
        };
        *current = Some(Arc::new(SerialBridge {
            info: info.clone(),
            first,
            second,
            active: RwLock::new(true),
            log: Mutex::new(log),
        }));
        Ok(info)
    }

    pub(super) fn current(&self) -> Result<Option<Arc<SerialBridge>>, String> {
        Ok(self.0.lock().map_err(|err| err.to_string())?.clone())
    }

    fn finish_if(
        &self,
        matches: impl FnOnce(&Arc<SerialBridge>) -> bool,
        failure: Option<BridgeFailure>,
    ) -> Result<Option<SerialBridgeEnded>, String> {
        let Some(bridge) = self.current()?.filter(matches) else {
            return Ok(None);
        };
        // 等在途转发收尾，再归还当前桥接位置。旧读取线程随后会看到停用标志。
        let mut active = bridge.active.write().map_err(|err| err.to_string())?;
        if !*active {
            return Ok(None);
        }
        let mut current = self.0.lock().map_err(|err| err.to_string())?;
        *active = false;
        let id = bridge.info.id.clone();
        *current = None;
        let (error, interrupted) = match failure {
            Some(BridgeFailure::Transport(error)) => (Some(error), true),
            Some(BridgeFailure::Operation(error)) => (Some(error), false),
            None => (None, false),
        };
        Ok(Some(SerialBridgeEnded {
            id,
            error,
            interrupted,
        }))
    }

    pub(super) fn forward(
        &self,
        app: &AppHandle,
        bridge: &Arc<SerialBridge>,
        source: &Arc<SerialSessionHandle>,
        timestamp: &str,
        bytes: &[u8],
    ) {
        let ended = self.transfer(bridge, source, timestamp, bytes, |payload| {
            let _ = app.emit("serial-bridge-data", payload);
        });
        emit_ended(app, ended);
    }

    fn transfer(
        &self,
        bridge: &Arc<SerialBridge>,
        source: &Arc<SerialSessionHandle>,
        timestamp: &str,
        bytes: &[u8],
        notify: impl FnOnce(SerialBridgeData<'_>),
    ) -> Result<Option<SerialBridgeEnded>, String> {
        match bridge.write_transfer(source, timestamp, bytes, notify) {
            Ok(()) => Ok(None),
            Err(err) => self.finish_if(|current| Arc::ptr_eq(current, bridge), Some(err)),
        }
    }

    pub(super) fn end_for_session(
        &self,
        app: &AppHandle,
        session: &Arc<SerialSessionHandle>,
        interrupted: bool,
    ) {
        emit_ended(app, self.finish_for_session(session, interrupted));
    }

    fn finish_for_session(
        &self,
        session: &Arc<SerialSessionHandle>,
        interrupted: bool,
    ) -> Result<Option<SerialBridgeEnded>, String> {
        self.finish_if(
            |bridge| bridge.target(session).is_some(),
            interrupted.then(|| {
                BridgeFailure::Transport(format!(
                    "Serial port '{}' disconnected",
                    session.port_name
                ))
            }),
        )
    }
}

fn emit_ended(app: &AppHandle, ended: Result<Option<SerialBridgeEnded>, String>) {
    if let Ok(Some(ended)) = ended {
        let _ = app.emit("serial-bridge-ended", ended);
        let _ = app.emit("serial-bridge-changed", None::<SerialBridgeInfo>);
    }
}

#[tauri::command]
pub async fn serial_bridge_start(
    app: AppHandle,
    first_session_id: String,
    second_session_id: String,
) -> Result<SerialBridgeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _operation = state
            .serial_bridge_operation
            .lock()
            .map_err(|_| "Serial bridge operation lock poisoned".to_string())?;
        start_serial_bridge(&app, &state, &first_session_id, &second_session_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

pub(crate) fn start_serial_bridge(
    app: &AppHandle,
    state: &AppState,
    first_session_id: &str,
    second_session_id: &str,
) -> Result<SerialBridgeInfo, String> {
    let sessions = state
        .serial_sessions
        .lock()
        .map_err(|err| err.to_string())?;
    let lookup = |id: &str| {
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Serial session '{id}' not found"))
    };
    let info = state.serial_bridge.start(
        lookup(first_session_id)?,
        lookup(second_session_id)?,
        &state.log_capture.logs_directory()?,
        state.log_capture.clone(),
    )?;
    let _ = app.emit("serial-bridge-changed", Some(&info));
    Ok(info)
}

#[tauri::command]
pub fn serial_bridge_status(
    state: State<'_, AppState>,
) -> Result<Option<SerialBridgeInfo>, String> {
    Ok(state
        .serial_bridge
        .current()?
        .map(|bridge| bridge.info.clone()))
}

#[tauri::command]
pub async fn serial_bridge_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _operation = state
            .serial_bridge_operation
            .lock()
            .map_err(|_| "Serial bridge operation lock poisoned".to_string())?;
        let ended = state.serial_bridge.finish_if(|_| true, None)?;
        if ended.is_none() {
            let _ = app.emit("serial-bridge-stopped", ());
        }
        emit_ended(&app, Ok(ended));
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::log_capture::LogCaptureSettings;
    use serialport::{SerialPort, TTYPort};
    use std::collections::VecDeque;
    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    struct TestDirectory(PathBuf);

    fn capture_policy() -> LogCapturePolicy {
        LogCapturePolicy::with_settings(LogCaptureSettings::default())
    }

    impl TestDirectory {
        fn new() -> Self {
            let sequence = BRIDGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "openix-bridge-test-{}-{}-{sequence}",
                std::process::id(),
                epoch_ms()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn serial_endpoint(id: &str) -> (Arc<SerialSessionHandle>, TTYPort, TTYPort) {
        let (mut peer, mut port) = TTYPort::pair().unwrap();
        peer.set_timeout(Duration::from_millis(500)).unwrap();
        port.set_timeout(Duration::from_millis(500)).unwrap();
        let reader = port.try_clone_native().unwrap();
        let port_name = port.name().unwrap();
        let session = Arc::new(SerialSessionHandle {
            label: None,
            id: id.to_string(),
            port_name,
            baud_rate: 115200,
            line_coding: Default::default(),
            serial_options: None,
            log_path: String::new(),
            writer: Mutex::new(Some(Box::new(port))),
            stop_flag: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(true)),
            buffer: Arc::new(Mutex::new(VecDeque::new())),
            last_rx_epoch_ms: Arc::new(AtomicU64::new(0)),
            worker: Mutex::new(None),
        });
        (session, reader, peer)
    }

    #[test]
    fn virtual_serial_port_sends_base64_and_hex_as_raw_bytes() {
        let (session, _, mut peer) = serial_endpoint("writer");
        let state = AppState::default();
        state
            .serial_sessions
            .lock()
            .unwrap()
            .insert(session.id.clone(), session.clone());

        let raw = [0x00, 0xff, 0xc3, 0x28];
        let encoded = B64_ENGINE.encode(raw);
        super::super::serial_write_base64_with_state(&state, &session.id, &encoded).unwrap();
        super::super::serial_write_hex_with_state(&state, &session.id, "04 fF", Some("cr"))
            .unwrap();
        super::super::serial_write_with_state(&state, &session.id, "Z", Some("LF")).unwrap();
        let mut received = [0; 9];
        peer.read_exact(&mut received).unwrap();
        assert_eq!(received, [0, 255, 195, 40, 4, 255, b'\r', b'Z', b'\n']);
        assert!(super::super::serial_write_base64_with_state(&state, &session.id, "%%%").is_err());
        assert!(
            super::super::serial_write_hex_with_state(&state, &session.id, "012", None).is_err()
        );
        assert_eq!(peer.bytes_to_read().unwrap(), 0);
    }

    #[test]
    fn virtual_serial_ports_forward_raw_bytes_in_both_directions() {
        let directory = TestDirectory::new();
        let (first, mut first_reader, mut first_peer) = serial_endpoint("first");
        let (second, mut second_reader, mut second_peer) = serial_endpoint("second");
        let bridge = SerialBridgeState::default();
        let info = bridge
            .start(
                first.clone(),
                second.clone(),
                &directory.0,
                capture_policy(),
            )
            .unwrap();
        let active = bridge.current().unwrap().unwrap();
        let first_bytes = [0x00, 0xff, b'A', b'\n'];
        let second_bytes = "设备B\r\n".as_bytes();

        first_peer.write_all(&first_bytes).unwrap();
        second_peer.write_all(second_bytes).unwrap();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut bytes = [0; 4];
                first_reader.read_exact(&mut bytes).unwrap();
                let ended = bridge
                    .transfer(&active, &first, "first-time", &bytes, |event| {
                        assert_eq!(event.id, info.id);
                        assert_eq!(event.from_session_id, first.id);
                        assert_eq!(event.to_session_id, second.id);
                        assert_eq!(event.from_port, first.port_name);
                        assert_eq!(event.to_port, second.port_name);
                        assert_eq!(B64_ENGINE.decode(event.data_base64).unwrap(), first_bytes);
                    })
                    .unwrap();
                assert!(ended.is_none());
            });
            scope.spawn(|| {
                let mut bytes = vec![0; second_bytes.len()];
                second_reader.read_exact(&mut bytes).unwrap();
                let ended = bridge
                    .transfer(&active, &second, "second-time", &bytes, |event| {
                        assert_eq!(event.from_session_id, second.id);
                        assert_eq!(event.to_session_id, first.id);
                        assert_eq!(B64_ENGINE.decode(event.data_base64).unwrap(), second_bytes);
                    })
                    .unwrap();
                assert!(ended.is_none());
            });
        });
        let mut received = [0; 4];
        second_peer.read_exact(&mut received).unwrap();
        assert_eq!(received, first_bytes);
        let mut received = vec![0; second_bytes.len()];
        first_peer.read_exact(&mut received).unwrap();
        assert_eq!(received, second_bytes);
        let log = std::fs::read_to_string(&info.log_path).unwrap();
        assert!(log.contains(&format!(
            "[first-time] {} -> {}: \\x00\\xffA\\n",
            first.port_name, second.port_name
        )));
        assert!(log.contains(&format!(
            "[second-time] {} -> {}: 设备B\\r\\n",
            second.port_name, first.port_name
        )));
    }

    #[test]
    fn closing_an_idle_endpoint_clears_the_bridge_without_closing_its_peer() {
        let directory = TestDirectory::new();
        let (first, _first_reader, _first_peer) = serial_endpoint("first");
        let (second, mut second_reader, second_peer) = serial_endpoint("second");
        let bridge = SerialBridgeState::default();
        assert!(bridge
            .start(first.clone(), first.clone(), &directory.0, capture_policy())
            .is_err());
        let info = bridge
            .start(
                first.clone(),
                second.clone(),
                &directory.0,
                capture_policy(),
            )
            .unwrap();
        let active = bridge.current().unwrap().unwrap();
        assert_eq!(active.info.id, info.id);
        assert!(bridge
            .start(
                first.clone(),
                second.clone(),
                &directory.0,
                capture_policy()
            )
            .is_err());
        let stopped = bridge.finish_for_session(&second, false).unwrap().unwrap();
        assert_eq!(stopped.id, info.id);
        assert!(stopped.error.is_none());
        assert!(!stopped.interrupted);
        let restarted = bridge
            .start(
                first.clone(),
                second.clone(),
                &directory.0,
                capture_policy(),
            )
            .unwrap();
        assert!(bridge
            .transfer(&active, &first, "stale", b"old", |_| panic!(
                "stale bridge sent data"
            ))
            .unwrap()
            .is_none());
        assert_ne!(restarted.id, info.id);
        drop(second_peer);
        assert!(second_reader.read(&mut [0]).is_err());
        second.connected.store(false, Ordering::Relaxed);
        let ended = bridge.finish_for_session(&second, true).unwrap().unwrap();
        assert_eq!(ended.id, restarted.id);
        assert!(ended.interrupted);
        assert!(ended.error.unwrap().contains(&second.port_name));
        assert!(bridge.current().unwrap().is_none());
        assert!(bridge.finish_for_session(&second, true).unwrap().is_none());
        assert!(first.connected.load(Ordering::Relaxed));
        assert!(bridge
            .start(first, second, &directory.0, capture_policy())
            .is_err());
        assert!(!*active.active.read().unwrap());
    }

    #[test]
    fn destination_write_failure_ends_bridge_without_reporting_success() {
        let directory = TestDirectory::new();
        let (first, _first_reader, _first_peer) = serial_endpoint("first");
        let (second, _second_reader, second_peer) = serial_endpoint("second");
        let bridge = SerialBridgeState::default();
        let info = bridge
            .start(first.clone(), second, &directory.0, capture_policy())
            .unwrap();
        let active = bridge.current().unwrap().unwrap();
        drop(second_peer);
        let ended = bridge
            .transfer(&active, &first, "time", b"out", |_| {
                panic!("failed write reported success")
            })
            .unwrap()
            .unwrap();
        assert_eq!(ended.id, info.id);
        assert!(ended.interrupted);
        let error = ended.error.unwrap();
        assert!(error.contains(&format!("{} -> {}", info.first_port, info.second_port)));
        assert!(bridge.current().unwrap().is_none());
    }

    #[test]
    fn a_full_destination_queue_stops_bridge_without_marking_a_disconnect() {
        use std::os::fd::AsRawFd;

        let directory = TestDirectory::new();
        let (first, _first_reader, _first_peer) = serial_endpoint("first");
        let (second, second_reader, _second_peer) = serial_endpoint("second");
        // 两个文件描述符共用打开状态，让写满的虚拟串口产生超时而非阻塞。
        let fd = second_reader.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
            0
        );
        let bridge = SerialBridgeState::default();
        let info = bridge
            .start(first.clone(), second, &directory.0, capture_policy())
            .unwrap();
        let active = bridge.current().unwrap().unwrap();
        let ended = bridge
            .transfer(&active, &first, "time", &[b'x'; 128 * 1024], |_| {
                panic!("partial write reported success")
            })
            .unwrap()
            .unwrap();
        assert_eq!(ended.id, info.id);
        assert!(!ended.interrupted);
        assert!(ended.error.is_some());
        assert!(bridge.current().unwrap().is_none());
    }

    #[test]
    fn keeps_forwarding_both_directions_when_only_keyword_context_is_saved() {
        let directory = TestDirectory::new();
        let (first, _first_reader, mut first_peer) = serial_endpoint("first");
        let (second, _second_reader, mut second_peer) = serial_endpoint("second");
        let bridge = SerialBridgeState::default();
        let policy = LogCapturePolicy::with_settings(LogCaptureSettings {
            save_continuous: false,
            keywords: vec!["match".to_string()],
            before_lines: 1,
            after_lines: 1,
            ..LogCaptureSettings::default()
        });
        let info = bridge
            .start(first.clone(), second.clone(), &directory.0, policy)
            .unwrap();
        let active = bridge.current().unwrap().unwrap();
        let records = [
            (true, "1", b"before".as_slice()),
            (true, "2", b"MATCH".as_slice()),
            (false, "3", b"after".as_slice()),
        ];
        for (from_first, timestamp, data) in records {
            let (source, peer) = if from_first {
                (&first, &mut second_peer)
            } else {
                (&second, &mut first_peer)
            };
            assert!(bridge
                .transfer(&active, source, timestamp, data, |_| {})
                .unwrap()
                .is_none());
            let mut received = vec![0; data.len()];
            peer.read_exact(&mut received).unwrap();
            assert_eq!(received, data);
        }
        bridge.finish_if(|_| true, None).unwrap();
        drop(active);
        assert!(!Path::new(&info.log_path).exists());
        let entries: Vec<_> = std::fs::read_dir(&directory.0).unwrap().collect();
        assert_eq!(entries.len(), 1);
        let entry = entries.into_iter().next().unwrap().unwrap();
        assert!(entry.file_name().to_string_lossy().starts_with("trigger_"));
        let log = std::fs::read_to_string(entry.path()).unwrap();
        assert!(log.contains(&format!(
            "[1] {} -> {}: before",
            info.first_port, info.second_port
        )));
        assert!(log.contains(&format!(
            "[2] {} -> {}: MATCH",
            info.first_port, info.second_port
        )));
        assert!(log.contains(&format!(
            "[3] {} -> {}: after",
            info.second_port, info.first_port
        )));
    }

    #[test]
    fn logging_failure_ends_bridge_after_reporting_the_forwarded_bytes() {
        let directory = TestDirectory::new();
        let (first, _first_reader, _first_peer) = serial_endpoint("first");
        let (second, _second_reader, mut second_peer) = serial_endpoint("second");
        let bridge = SerialBridgeState::default();
        let info = bridge
            .start(first.clone(), second, &directory.0, capture_policy())
            .unwrap();
        let active = bridge.current().unwrap().unwrap();
        *active.log.lock().unwrap() =
            CaptureWriter::new(capture_policy(), PathBuf::from("/dev/full")).unwrap();
        let mut reported = false;
        let ended = bridge
            .transfer(&active, &first, "time", b"out", |_| reported = true)
            .unwrap()
            .unwrap();
        assert!(reported);
        assert_eq!(ended.id, info.id);
        assert!(!ended.interrupted);
        assert!(ended.error.unwrap().contains("serial bridge log"));
        let mut bytes = [0; 3];
        second_peer.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"out");
        assert!(bridge.current().unwrap().is_none());
    }
}
