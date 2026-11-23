use crate::adb;
use crate::efex;
use crate::efex::standard_flash::{self, StandardFlashOptions};
use crate::log_capture;
use crate::log_profiles;
use crate::log_sessions;
use crate::log_ui;
use crate::monitor;
use crate::packer;
use crate::plugins;
use crate::power;
use crate::serial;
use crate::state::{emit_ai_sync, AppState, UsbBackend};
use crate::triggers;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const IPC_LISTEN_ADDR: &str = "127.0.0.1:28765";

#[derive(Clone, Serialize)]
struct AdbSyncPayload {
    serial: String,
    local_path: String,
    remote_path: String,
}

#[derive(Deserialize)]
struct AdbShellReq {
    #[serde(default)]
    serial: String,
    command: String,
}

#[derive(Deserialize)]
struct AdbPushReq {
    #[serde(default)]
    serial: String,
    local_path: String,
    remote_path: String,
}

#[derive(Deserialize)]
struct AdbPullReq {
    #[serde(default)]
    serial: String,
    remote_path: String,
    local_path: String,
}

#[derive(Deserialize)]
struct AdbSerialReq {
    #[serde(default)]
    serial: String,
}

#[derive(Deserialize)]
struct FesExitReq {
    device_id: String,
    action: efex::FesExitAction,
}

#[derive(Deserialize)]
struct InspectReq {
    firmware_path: String,
}

#[derive(Deserialize)]
struct UnpackReq {
    firmware_path: String,
    out_dir: String,
}

#[derive(Deserialize)]
struct ConvertReq {
    firmware_path: String,
    #[serde(default = "default_target")]
    target: String,
    output_path: String,
    #[serde(default)]
    logic_offset: Option<u64>,
    #[serde(default)]
    uboot_start: Option<u64>,
    #[serde(default = "default_nor_size")]
    nor_size: u64,
    #[serde(default = "default_storage_size")]
    storage_size: String,
}

fn default_target() -> String {
    "emmc".to_string()
}
fn default_nor_size() -> u64 {
    16
}
fn default_storage_size() -> String {
    "auto".to_string()
}

#[derive(Deserialize)]
struct RawReq {
    boot_firmware: String,
    raw_image: String,
    #[serde(default = "default_raw_mode")]
    mode: String,
    #[serde(default = "default_raw_storage")]
    storage: String,
    #[serde(default)]
    logic_offset: Option<u64>,
    #[serde(default)]
    bus: Option<u8>,
    #[serde(default)]
    port: Option<u8>,
}

fn default_raw_mode() -> String {
    "logic-offset".to_string()
}
fn default_raw_storage() -> String {
    "sdmmc".to_string()
}

#[derive(Deserialize)]
struct EfelReadReq {
    address: u32,
    #[serde(default = "default_efel_len")]
    length: usize,
}

fn default_efel_len() -> usize {
    64
}

#[derive(Deserialize)]
struct EfelWriteReq {
    address: u32,
    data: Vec<u8>,
}

#[derive(Deserialize)]
struct EfelExecReq {
    address: u32,
}

#[derive(Deserialize)]
struct PluginInstallReq {
    package_path: String,
}

#[derive(Deserialize)]
struct PluginUninstallReq {
    plugin_id: String,
}

#[derive(Deserialize)]
struct PluginRunReq {
    plugin_id: String,
    tab_id: Option<String>,
    #[serde(default)]
    serial: String,
    #[serde(default)]
    inputs: Map<String, Value>,
}

#[derive(Deserialize)]
struct SerialOpenReq {
    port_name: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    baud_rate: u32,
}

#[derive(Deserialize)]
struct SessionIdReq {
    session_id: String,
}

#[derive(Deserialize)]
struct LogStartReq {
    profile_id: String,
    source: String,
}

#[derive(Deserialize)]
struct BridgeStartReq {
    profile_id: String,
}

#[derive(Deserialize)]
struct SerialWriteReq {
    session_id: String,
    data: String,
    #[serde(default)]
    append_newline: Option<String>,
    #[serde(default)]
    hex: bool,
}

#[derive(Deserialize)]
struct PowerActionReq {
    profile_id: String,
    #[serde(default = "default_power_action")]
    action: String,
}

fn default_power_action() -> String {
    "cycle".to_string()
}

async fn sample_metrics(
    serial: String,
    sample_ms: u64,
) -> Result<(monitor::DeviceMetrics, u64), (u16, String)> {
    let serial = if serial.is_empty() {
        let devices = run_blocking(adb::adb_list_devices).await?;
        match &devices[..] {
            [device] => device.target().to_owned(),
            [] => return Err((400, "No ADB device is connected".to_string())),
            _ => {
                return Err((
                    400,
                    "Specify --serial when multiple ADB devices are connected".to_string(),
                ));
            }
        }
    } else {
        serial
    };
    let first_serial = serial.clone();
    let first = run_blocking(move || {
        monitor::adb_get_metrics(first_serial, None, Some(false), Some(false), Some(false))
    })
    .await?;
    let first_time = first.snapshot.timestamp_ms;
    let first_cpu_total = first.snapshot.total;
    let first_uptime = first.uptime_s;
    tokio::time::sleep(Duration::from_millis(sample_ms)).await;
    let second = run_blocking(move || {
        monitor::adb_get_metrics(serial, Some(first.snapshot), None, None, None)
    })
    .await?;
    let interval_ms = second.snapshot.timestamp_ms.saturating_sub(first_time);
    if interval_ms == 0
        || first_cpu_total == 0
        || second.snapshot.total <= first_cpu_total
        || second.uptime_s < first_uptime
    {
        return Err((
            500,
            "Cannot calculate interval metrics from the two device samples".to_string(),
        ));
    }
    Ok((second, interval_ms))
}

pub fn start_ipc_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(IPC_LISTEN_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[ipc_server] Failed to bind {}: {}", IPC_LISTEN_ADDR, e);
                return;
            }
        };

        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_connection(stream, app_clone).await;
                    });
                }
                Err(e) => {
                    eprintln!("[ipc_server] Accept error: {}", e);
                }
            }
        }
    });
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query_string(qs: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        if let Some((k, v)) = pair.split_once('=') {
            map.insert(percent_decode(k), percent_decode(v));
        } else {
            map.insert(percent_decode(pair), String::new());
        }
    }
    map
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, (u16, String)> {
    const MAX_HEADER_BYTES: usize = 64 * 1024;
    const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 2048];
    let header_end;

    loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos;
            break;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err((400, "HTTP header too large".to_string()));
        }
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| (400, format!("Read error: {}", e)))?;
        if n == 0 {
            return Err((400, "Empty HTTP request".to_string()));
        }
        buf.extend_from_slice(&tmp[..n]);
    }

    let header_str = std::str::from_utf8(&buf[..header_end])
        .map_err(|_| (400, "Invalid UTF-8 in HTTP headers".to_string()))?;
    let mut lines = header_str.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| (400, "Missing HTTP request line".to_string()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| (400, "Missing HTTP method".to_string()))?
        .to_ascii_uppercase();
    let raw_target = parts
        .next()
        .ok_or_else(|| (400, "Missing HTTP path".to_string()))?;
    let (path, query) = match raw_target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query_string(q)),
        None => (raw_target.to_string(), HashMap::new()),
    };

    let mut content_length: usize = 0;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| (400, "Invalid Content-Length".to_string()))?;
            }
        }
    }

    if content_length > MAX_BODY_BYTES {
        return Err((400, "Request body too large".to_string()));
    }

    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| (400, format!("Body read error: {}", e)))?;
        if n == 0 {
            return Err((400, "Unexpected EOF while reading body".to_string()));
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);

    Ok(HttpRequest {
        method,
        path,
        query,
        body,
    })
}

async fn write_json_response(stream: &mut TcpStream, status: u16, payload: Value) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    };
    let body = serde_json::to_vec(&payload)
        .unwrap_or_else(|_| b"{\"ok\":false,\"error\":\"json encode failed\"}".to_vec());
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&body).await;
    let _ = stream.flush().await;
}

fn parse_json<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, (u16, String)> {
    serde_json::from_slice(body).map_err(|e| (400, format!("Invalid JSON payload: {}", e)))
}

fn map_op_error(err: String) -> (u16, String) {
    if err.starts_with("Device busy:") {
        (409, err)
    } else {
        (500, err)
    }
}

async fn run_blocking<F, T>(f: F) -> Result<T, (u16, String)>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| (500, format!("Task join error: {}", e)))?
        .map_err(map_op_error)
}

async fn handle_connection(mut stream: TcpStream, app: AppHandle) {
    let req = match read_http_request(&mut stream).await {
        Ok(r) => r,
        Err((code, msg)) => {
            write_json_response(&mut stream, code, json!({ "ok": false, "error": msg })).await;
            return;
        }
    };

    let (status, payload) = dispatch(&app, req).await;
    write_json_response(&mut stream, status, payload).await;
}

fn log_storage_response(
    result: Result<log_capture::LogCaptureReply, (u16, String)>,
) -> (u16, Value) {
    match result {
        Ok(reply) => (200, json!({
            "ok": true,
            "directory": reply.directory,
            "default_directory": reply.default_directory,
            "settings": reply.settings,
        })),
        Err((code, error)) => (code, json!({ "ok": false, "error": error })),
    }
}

async fn dispatch(app: &AppHandle, req: HttpRequest) -> (u16, Value) {
    let state = app.state::<AppState>();

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/status") => {
            emit_ai_sync(app, "ai", "status", "started", "Querying device status");
            let backend = state
                .usb_backend
                .lock()
                .map(|g| g.clone())
                .unwrap_or(UsbBackend::Auto);
            let busy = state.current_busy();

            let res = run_blocking(move || {
                let fel_devices = efex::scan_devices_with_backend(&backend);
                let adb_devices = adb::adb_list_devices().unwrap_or_default();
                Ok(json!({
                    "ok": true,
                    "fel_devices": fel_devices,
                    "adb_devices": adb_devices,
                    "busy": busy,
                }))
            })
            .await;

            match res {
                Ok(val) => {
                    emit_ai_sync(app, "ai", "status", "completed", "Status queried");
                    (200, val)
                }
                Err((code, err)) => {
                    emit_ai_sync(app, "ai", "status", "error", err.clone());
                    (code, json!({ "ok": false, "error": err }))
                }
            }
        }

        ("POST", "/api/adb/shell") => {
            let body: AdbShellReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            emit_ai_sync(
                app,
                "ai",
                "adb-shell",
                "started",
                format!("adb shell: {}", body.command),
            );
            let res = run_blocking(move || adb::adb_exec_shell(body.serial, body.command)).await;
            match res {
                Ok(output) => {
                    emit_ai_sync(app, "ai", "adb-shell", "completed", "adb shell completed");
                    (200, json!({ "ok": true, "output": output }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "adb-shell", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/adb/push") => {
            let body: AdbPushReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let local_path = body.local_path.clone();
            let remote_path = body.remote_path.clone();
            emit_ai_sync(
                app,
                "ai",
                "adb-push",
                "started",
                format!("adb push {} -> {}", local_path, remote_path),
            );
            let res = run_blocking(move || {
                adb::push_file_to_device(body.serial, body.local_path, body.remote_path)
            })
            .await;
            match res {
                Ok(serial) => {
                    let _ = app.emit(
                        "adb-sync",
                        AdbSyncPayload {
                            serial,
                            local_path: local_path.clone(),
                            remote_path: remote_path.clone(),
                        },
                    );
                    emit_ai_sync(
                        app,
                        "ai",
                        "adb-push",
                        "completed",
                        format!("Pushed {} -> {}", local_path, remote_path),
                    );
                    (200, json!({ "ok": true }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "adb-push", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/adb/pull") => {
            let body: AdbPullReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let remote_path = body.remote_path.clone();
            let local_path = body.local_path.clone();
            emit_ai_sync(
                app,
                "ai",
                "adb-pull",
                "started",
                format!("adb pull {} -> {}", remote_path, local_path),
            );
            let res = run_blocking(move || {
                adb::adb_pull_file(body.serial, body.remote_path, body.local_path)
            })
            .await;
            match res {
                Ok(()) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "adb-pull",
                        "completed",
                        format!("Pulled {} -> {}", remote_path, local_path),
                    );
                    (200, json!({ "ok": true }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "adb-pull", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/adb/reboot-efex") => {
            let body: AdbSerialReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            emit_ai_sync(app, "ai", "reboot-efex", "started", "Rebooting to EFEX/FEL");
            let res = run_blocking(move || adb::adb_reboot_efex(body.serial)).await;
            match res {
                Ok(msg) => {
                    emit_ai_sync(app, "ai", "reboot-efex", "completed", msg.clone());
                    (200, json!({ "ok": true, "message": msg }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "reboot-efex", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/adb/root") => {
            let body: AdbSerialReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            emit_ai_sync(app, "ai", "adb-root", "started", "Running adb root");
            let res = run_blocking(move || adb::adb_root(body.serial)).await;
            match res {
                Ok(output) => {
                    emit_ai_sync(app, "ai", "adb-root", "completed", "adb root completed");
                    (200, json!({ "ok": true, "output": output }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "adb-root", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/inspect") => {
            let body: InspectReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let fw = body.firmware_path.clone();
            emit_ai_sync(
                app,
                "ai",
                "inspect",
                "started",
                format!("Inspecting {}", fw),
            );
            let res = run_blocking(move || packer::inspect_image(body.firmware_path)).await;
            match res {
                Ok(info) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "inspect",
                        "completed",
                        format!("Inspected {}", fw),
                    );
                    (200, json!({ "ok": true, "info": info }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "inspect", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/unpack") => {
            let body: UnpackReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let fw = body.firmware_path.clone();
            let od = body.out_dir.clone();
            emit_ai_sync(
                app,
                "ai",
                "unpack",
                "started",
                format!("Unpacking {} -> {}", fw, od),
            );
            let res = run_blocking(move || packer::unpack_firmware_sync(&fw, &od)).await;
            match res {
                Ok(count) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "unpack",
                        "completed",
                        format!("Unpacked {} files -> {}", count, body.out_dir),
                    );
                    (
                        200,
                        json!({ "ok": true, "count": count, "out_dir": body.out_dir }),
                    )
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "unpack", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/convert") => {
            let body: ConvertReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let fw = body.firmware_path.clone();
            let out = body.output_path.clone();
            emit_ai_sync(
                app,
                "ai",
                "convert",
                "started",
                format!("Converting {} -> {}", fw, out),
            );
            let app_clone = app.clone();
            let res = run_blocking(move || {
                packer::convert_firmware_sync(
                    &app_clone,
                    body.firmware_path,
                    body.target,
                    body.logic_offset,
                    body.uboot_start,
                    body.nor_size,
                    body.storage_size,
                    None,
                    body.output_path,
                )
            })
            .await;
            match res {
                Ok(output_path) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "convert",
                        "completed",
                        format!("Converted -> {}", output_path),
                    );
                    (200, json!({ "ok": true, "output_path": output_path }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "convert", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/flash/plan" | "/api/flash" | "/api/flash/execute") => {
            let body: StandardFlashOptions = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            if req.path == "/api/flash/plan" {
                return match standard_flash::preview(body).await {
                    Ok(plan) => (200, json!({ "ok": true, "dry_run": true, "plan": plan })),
                    Err(error) => (400, json!({ "ok": false, "error": error })),
                };
            }
            if body.confirm_plan.as_deref().is_none_or(str::is_empty) {
                return (400, json!({ "ok": false, "error": "Run flash --dry-run and pass the plan ID using --confirm-plan" }));
            }
            match standard_flash::run(app, &state, "ai", body).await {
                Ok(result) => (200, json!({ "ok": result.ok(), "flash": result.flash, "boot": result.boot })),
                Err(e) => {
                    let (code, error) = map_op_error(e);
                    (code, json!({ "ok": false, "error": error }))
                }
            }
        }

        ("POST", "/api/raw") => {
            let body: RawReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            match efex::run_raw_flash_image(
                app,
                &state,
                "ai",
                body.boot_firmware,
                body.raw_image,
                body.mode,
                body.storage,
                body.logic_offset,
                body.bus,
                body.port,
            )
            .await
            {
                Ok(()) => (200, json!({ "ok": true })),
                Err(e) => {
                    let (code, msg) = map_op_error(e);
                    if code == 409 {
                        emit_ai_sync(app, "ai", "raw", "error", msg.clone());
                    }
                    (code, json!({ "ok": false, "error": msg }))
                }
            }
        }

        ("POST", "/api/fes/exit") => {
            let body: FesExitReq = match parse_json(&req.body) {
                Ok(body) => body,
                Err((code, error)) => return (code, json!({ "ok": false, "error": error })),
            };
            match efex::request_fes_exit(&state, body.device_id.clone(), body.action).await {
                Ok(()) => {
                    let message = format!("FES exit request acknowledged by {}", body.device_id);
                    emit_ai_sync(app, "ai", "fes-exit", "completed", &message);
                    (200, json!({ "ok": true, "device_id": body.device_id, "action": body.action, "message": message }))
                }
                Err(error) => {
                    emit_ai_sync(app, "ai", "fes-exit", "error", &error);
                    (500, json!({ "ok": false, "error": error }))
                }
            }
        }

        ("POST", "/api/efel/read") => {
            let body: EfelReadReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let _busy = match state.try_acquire_busy("efel-read") {
                Ok(g) => g,
                Err(e) => {
                    emit_ai_sync(app, "ai", "efel-read", "error", e.clone());
                    return (409, json!({ "ok": false, "error": e }));
                }
            };
            let addr = body.address;
            let len = body.length;
            emit_ai_sync(
                app,
                "ai",
                "efel-read",
                "started",
                format!("FEL read 0x{:08x} ({} bytes)", addr, len),
            );
            let res = run_blocking(move || efex::efel_read_sync(addr, len)).await;
            match res {
                Ok(data) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "efel-read",
                        "completed",
                        format!("FEL read {} bytes from 0x{:08x}", data.len(), addr),
                    );
                    (
                        200,
                        json!({
                            "ok": true,
                            "address": format!("0x{:08x}", addr),
                            "data": data,
                        }),
                    )
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "efel-read", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/efel/write") => {
            let body: EfelWriteReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let _busy = match state.try_acquire_busy("efel-write") {
                Ok(g) => g,
                Err(e) => {
                    emit_ai_sync(app, "ai", "efel-write", "error", e.clone());
                    return (409, json!({ "ok": false, "error": e }));
                }
            };
            let addr = body.address;
            let len = body.data.len();
            emit_ai_sync(
                app,
                "ai",
                "efel-write",
                "started",
                format!("FEL write 0x{:08x} ({} bytes)", addr, len),
            );
            let res = run_blocking(move || efex::efel_write_sync(addr, body.data)).await;
            match res {
                Ok(()) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "efel-write",
                        "completed",
                        format!("FEL wrote {} bytes to 0x{:08x}", len, addr),
                    );
                    (200, json!({ "ok": true }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "efel-write", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/efel/exec") => {
            let body: EfelExecReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let _busy = match state.try_acquire_busy("efel-exec") {
                Ok(g) => g,
                Err(e) => {
                    emit_ai_sync(app, "ai", "efel-exec", "error", e.clone());
                    return (409, json!({ "ok": false, "error": e }));
                }
            };
            let addr = body.address;
            emit_ai_sync(
                app,
                "ai",
                "efel-exec",
                "started",
                format!("FEL exec 0x{:08x}", addr),
            );
            let res = run_blocking(move || efex::efel_exec_sync(addr)).await;
            match res {
                Ok(()) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "efel-exec",
                        "completed",
                        format!("FEL executed 0x{:08x}", addr),
                    );
                    (200, json!({ "ok": true }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "efel-exec", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("GET", "/api/plugins") => {
            let res = run_blocking(plugins::list_plugins).await;
            match res {
                Ok(list) => (200, json!({ "ok": true, "plugins": list })),
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("POST", "/api/plugins/install") => {
            let body: PluginInstallReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let pkg = body.package_path.clone();
            emit_ai_sync(
                app,
                "ai",
                "plugin-install",
                "started",
                format!("Installing plugin {}", pkg),
            );
            let res = run_blocking(move || plugins::install_plugin(body.package_path)).await;
            match res {
                Ok(manifest) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "plugin-install",
                        "completed",
                        format!("Installed plugin {} ({})", manifest.name, manifest.id),
                    );
                    (200, json!({ "ok": true, "plugin": manifest }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "plugin-install", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/plugins/uninstall") => {
            let body: PluginUninstallReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let id = body.plugin_id.clone();
            emit_ai_sync(
                app,
                "ai",
                "plugin-uninstall",
                "started",
                format!("Uninstalling plugin {}", id),
            );
            let res = run_blocking(move || plugins::uninstall_plugin(body.plugin_id)).await;
            match res {
                Ok(()) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "plugin-uninstall",
                        "completed",
                        format!("Uninstalled plugin {}", id),
                    );
                    (200, json!({ "ok": true }))
                }
                Err((c, e)) => {
                    emit_ai_sync(app, "ai", "plugin-uninstall", "error", e.clone());
                    (c, json!({ "ok": false, "error": e }))
                }
            }
        }

        ("POST", "/api/plugins/run") => {
            let body: PluginRunReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            match plugins::execute_plugin_with_handle(
                app,
                &state,
                "ai",
                body.plugin_id,
                body.tab_id,
                body.serial,
                body.inputs,
            )
            .await
            {
                Ok(logs) => (200, json!({ "ok": true, "logs": logs })),
                Err(e) => {
                    let (code, msg) = map_op_error(e);
                    if code == 409 {
                        emit_ai_sync(app, "ai", "plugin-run", "error", msg.clone());
                    }
                    (code, json!({ "ok": false, "error": msg }))
                }
            }
        }

        ("GET", "/api/serial/ports") => {
            let res = run_blocking(serial::serial_list_ports).await;
            match res {
                Ok(ports) => (200, json!({ "ok": true, "ports": ports })),
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("POST", "/api/serial/open") => {
            let body: SerialOpenReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let worker_app = app.clone();
            match run_blocking(move || {
                serial::serial_open(
                    worker_app.clone(),
                    worker_app.state::<AppState>(),
                    body.session_id,
                    body.port_name,
                    body.baud_rate,
                    None,
                    None,
                )
            })
            .await
            {
                Ok(session) => {
                    emit_ai_sync(app, "ai", "serial-open", "completed", session.id.clone());
                    (200, json!({ "ok": true, "session": session }))
                }
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("POST", "/api/serial/close") => {
            let body: SessionIdReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let session_id = body.session_id;
            let worker_session_id = session_id.clone();
            let worker_app = app.clone();
            match run_blocking(move || {
                serial::serial_close_with_state(
                    &worker_app,
                    &worker_app.state::<AppState>(),
                    &worker_session_id,
                )
            })
            .await
            {
                Ok(()) => {
                    emit_ai_sync(app, "ai", "serial-close", "completed", session_id.clone());
                    (200, json!({ "ok": true, "session_id": session_id }))
                }
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("GET", "/api/serial/logs") => {
            let tail_lines = req
                .query
                .get("tail_lines")
                .and_then(|v| v.parse::<usize>().ok());
            if let Some(session_id) = req.query.get("session_id").filter(|s| !s.is_empty()) {
                match serial::serial_get_buffer_with_state(&state, session_id, tail_lines) {
                    Ok(lines) => (
                        200,
                        json!({
                            "ok": true,
                            "session_id": session_id,
                            "lines": lines,
                        }),
                    ),
                    Err(e) => {
                        let (c, msg) = map_op_error(e);
                        (c, json!({ "ok": false, "error": msg }))
                    }
                }
            } else if let Some(file_name) = req.query.get("file_name").filter(|s| !s.is_empty()) {
                let fname = file_name.clone();
                let fname_resp = fname.clone();
                let policy = state.log_capture.clone();
                let directory = req.query.get("directory").cloned();
                let res = run_blocking(move || {
                    serial::read_log_file(&policy, &fname, tail_lines, directory.as_deref())
                })
                .await;
                match res {
                    Ok(content) => (
                        200,
                        json!({
                            "ok": true,
                            "file_name": fname_resp,
                            "content": content,
                        }),
                    ),
                    Err((c, e)) => (c, json!({ "ok": false, "error": e })),
                }
            } else {
                let sessions = state
                    .serial_sessions
                    .lock()
                    .map(|g| g.values().map(|s| s.info()).collect::<Vec<_>>())
                    .unwrap_or_default();
                let policy = state.log_capture.clone();
                let res = run_blocking(move || serial::list_log_files(&policy)).await;
                match res {
                    Ok(files) => (
                        200,
                        json!({
                            "ok": true,
                            "sessions": sessions,
                            "files": files,
                        }),
                    ),
                    Err((c, e)) => (c, json!({ "ok": false, "error": e })),
                }
            }
        }

        ("POST", "/api/serial/write") => {
            let body: SerialWriteReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            emit_ai_sync(
                app,
                "ai",
                "serial-write",
                "started",
                format!("Serial write -> {}", body.session_id),
            );
            let write = if body.hex {
                serial::serial_write_hex_with_state
            } else {
                serial::serial_write_with_state
            };
            match write(
                &state,
                &body.session_id,
                &body.data,
                body.append_newline.as_deref(),
            ) {
                Ok(()) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "serial-write",
                        "completed",
                        format!("Wrote to serial session {}", body.session_id),
                    );
                    (200, json!({ "ok": true }))
                }
                Err(e) => {
                    emit_ai_sync(app, "ai", "serial-write", "error", e.clone());
                    let (c, msg) = map_op_error(e);
                    (c, json!({ "ok": false, "error": msg }))
                }
            }
        }

        ("POST", "/api/power/action") => {
            let body: PowerActionReq = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            emit_ai_sync(
                app,
                "ai",
                "power",
                "started",
                format!("Power '{}' on '{}'", body.action, body.profile_id),
            );
            match power::power_execute_async(&body.profile_id, &body.action).await {
                Ok(msg) => {
                    emit_ai_sync(app, "ai", "power", "completed", msg.clone());
                    (200, json!({ "ok": true, "message": msg }))
                }
                Err(e) => {
                    emit_ai_sync(app, "ai", "power", "error", e.clone());
                    let (c, msg) = map_op_error(e);
                    (c, json!({ "ok": false, "error": msg }))
                }
            }
        }

        ("POST", "/api/log-ui") => {
            let request: log_ui::LogUiRequest = match parse_json(&req.body) {
                Ok(request) => request,
                Err((code, error)) => return (code, json!({ "ok": false, "error": error })),
            };
            match state.log_ui.request(app, request).await {
                Ok(settings) => (200, json!({ "ok": true, "settings": settings })),
                Err(error) => (400, json!({ "ok": false, "error": error })),
            }
        }

        ("GET", "/api/log-storage") => {
            log_storage_response(log_capture::capture_settings(&state.log_capture).map_err(map_op_error))
        }

        ("POST", "/api/log-storage") => {
            let patch: Map<String, Value> = match parse_json(&req.body) {
                Ok(patch) => patch,
                Err((code, error)) => return (code, json!({ "ok": false, "error": error })),
            };
            let policy = state.log_capture.clone();
            let worker_app = app.clone();
            log_storage_response(
                run_blocking(move || log_capture::patch_capture_settings(&worker_app, &policy, patch)).await,
            )
        }

        ("GET", "/api/log-profiles") => match run_blocking(log_profiles::log_profiles_list).await {
            Ok(profiles) => (200, json!({ "ok": true, "profiles": profiles })),
            Err((c, e)) => (c, json!({ "ok": false, "error": e })),
        },

        ("POST", "/api/log-profiles") => {
            let profile: log_profiles::LogProfile = match parse_json(&req.body) {
                Ok(profile) => profile,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            if let Err(error) = profile.validate() {
                return (400, json!({ "ok": false, "error": error }));
            }
            let worker_app = app.clone();
            match run_blocking(move || log_profiles::save_profile(&worker_app, profile)).await {
                Ok(profile) => {
                    emit_ai_sync(
                        app,
                        "ai",
                        "log-profile-save",
                        "completed",
                        profile.id.clone(),
                    );
                    (200, json!({ "ok": true, "profile": profile }))
                }
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("GET", "/api/log-sessions") => match log_sessions::log_sessions_list(state) {
            Ok(sessions) => (200, json!({ "ok": true, "sessions": sessions })),
            Err(error) => (500, json!({ "ok": false, "error": error })),
        },

        ("POST", "/api/log-sessions/start") => {
            let body: LogStartReq = match parse_json(&req.body) {
                Ok(body) => body,
                Err((code, error)) => return (code, json!({ "ok": false, "error": error })),
            };
            match log_sessions::log_session_start(app.clone(), state, body.profile_id, body.source)
                .await
            {
                Ok(session) => (200, json!({ "ok": true, "session": session })),
                Err(error) => {
                    let (code, error) = map_op_error(error);
                    (code, json!({ "ok": false, "error": error }))
                }
            }
        }

        ("POST", "/api/log-sessions/stop") => {
            let body: SessionIdReq = match parse_json(&req.body) {
                Ok(body) => body,
                Err((code, error)) => return (code, json!({ "ok": false, "error": error })),
            };
            match log_sessions::log_session_stop(app.clone(), state, body.session_id.clone()).await
            {
                Ok(()) => (200, json!({ "ok": true, "session_id": body.session_id })),
                Err(error) => {
                    let (code, error) = map_op_error(error);
                    (code, json!({ "ok": false, "error": error }))
                }
            }
        }

        ("GET", "/api/serial/bridge") => match serial::bridge::serial_bridge_status(state) {
            Ok(bridge) => (200, json!({ "ok": true, "bridge": bridge })),
            Err(error) => (500, json!({ "ok": false, "error": error })),
        },

        ("POST", "/api/serial/bridge/start") => {
            let body: BridgeStartReq = match parse_json(&req.body) {
                Ok(body) => body,
                Err((code, error)) => return (code, json!({ "ok": false, "error": error })),
            };
            match log_sessions::log_profile_bridge_start(app.clone(), state, body.profile_id).await
            {
                Ok(bridge) => (200, json!({ "ok": true, "bridge": bridge })),
                Err(error) => {
                    let (code, error) = map_op_error(error);
                    (code, json!({ "ok": false, "error": error }))
                }
            }
        }

        ("POST", "/api/serial/bridge/stop") => {
            match serial::bridge::serial_bridge_stop(app.clone()).await {
                Ok(()) => (200, json!({ "ok": true })),
                Err(error) => {
                    let (code, error) = map_op_error(error);
                    (code, json!({ "ok": false, "error": error }))
                }
            }
        }

        ("GET", "/api/monitor/metrics") => {
            let serial = req.query.get("serial").cloned().unwrap_or_default();
            if let Some(sample_ms) = req.query.get("sample_ms") {
                let Ok(sample_ms @ 1..=30_000) = sample_ms.parse::<u64>() else {
                    return (
                        400,
                        json!({ "ok": false, "error": "sample_ms must be an integer from 1 to 30000" }),
                    );
                };
                return match sample_metrics(serial, sample_ms).await {
                    Ok((metrics, interval_ms)) => (
                        200,
                        json!({
                            "ok": true, "metrics": metrics, "sample_interval_ms": interval_ms,
                        }),
                    ),
                    Err((c, e)) => (c, json!({ "ok": false, "error": e })),
                };
            }
            let res =
                run_blocking(move || monitor::adb_get_metrics(serial, None, None, None, None))
                    .await;
            match res {
                Ok(metrics) => (200, json!({ "ok": true, "metrics": metrics })),
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("GET", "/api/power/profiles") => match run_blocking(power::power_list_profiles).await {
            Ok(profiles) => (200, json!({ "ok": true, "profiles": profiles })),
            Err((c, e)) => (c, json!({ "ok": false, "error": e })),
        },

        ("POST", "/api/power/profiles") => {
            let profile: power::PowerProfile = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let worker_app = app.clone();
            match run_blocking(move || power::save_profile_draft(&worker_app, profile)).await {
                Ok(profile) => (200, json!({ "ok": true, "profile": profile })),
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("GET", "/api/triggers/rules") => match run_blocking(triggers::trigger_list_rules).await {
            Ok(rules) => (200, json!({ "ok": true, "rules": rules })),
            Err((c, e)) => (c, json!({ "ok": false, "error": e })),
        },

        ("POST", "/api/triggers/rules") => {
            let rule: triggers::TriggerRule = match parse_json(&req.body) {
                Ok(v) => v,
                Err((c, e)) => return (c, json!({ "ok": false, "error": e })),
            };
            let worker_app = app.clone();
            match run_blocking(move || triggers::save_rule_draft(&worker_app, rule)).await {
                Ok(rule) => (200, json!({ "ok": true, "rule": rule })),
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        ("GET", "/api/triggers/incidents") => {
            let res = run_blocking(triggers::trigger_list_incidents).await;
            match res {
                Ok(incidents) => (200, json!({ "ok": true, "incidents": incidents })),
                Err((c, e)) => (c, json!({ "ok": false, "error": e })),
            }
        }

        _ => (
            404,
            json!({ "ok": false, "error": format!("Unknown endpoint: {} {}", req.method, req.path) }),
        ),
    }
}
