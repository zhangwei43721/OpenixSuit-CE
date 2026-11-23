use clap::{Parser, Subcommand};
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

const DEFAULT_ADDR: &str = "127.0.0.1:28765";

#[derive(Parser)]
#[command(name = "openixsuit-ai", about = "AI control CLI for OpenixSuit-CE")]
struct Cli {
    /// IPC server host:port
    #[arg(long, default_value = DEFAULT_ADDR, global = true)]
    addr: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Query connected FEL/ADB devices and busy state
    Status,
    /// Run a shell command over ADB
    AdbShell {
        #[arg(long, default_value = "")]
        serial: String,
        command: String,
    },
    /// Push a local file to device over ADB
    AdbPush {
        #[arg(long, default_value = "")]
        serial: String,
        local_path: String,
        remote_path: String,
    },
    /// Pull a remote file from device over ADB
    AdbPull {
        #[arg(long, default_value = "")]
        serial: String,
        remote_path: String,
        local_path: String,
    },
    /// Reboot device into EFEX/FEL mode via ADB
    RebootEfex {
        #[arg(long, default_value = "")]
        serial: String,
    },
    /// Exit a selected FES device by rebooting or requesting FEL
    FesExit {
        /// USB device ID from status, e.g. bus:1-port:3
        #[arg(long)]
        device_id: String,
        #[arg(long, value_enum)]
        action: crate::efex::FesExitAction,
    },
    /// Restart adbd as root
    AdbRoot {
        #[arg(long, default_value = "")]
        serial: String,
    },
    /// Inspect an IMAGEWTY firmware file
    Inspect { firmware_path: String },
    /// Unpack embedded files and partitions from an IMAGEWTY firmware
    Unpack {
        firmware_path: String,
        out_dir: String,
    },
    /// Convert IMAGEWTY firmware to raw programmer / SPI NOR image
    Convert {
        firmware_path: String,
        #[arg(long, default_value = "emmc")]
        target: String,
        #[arg(long)]
        output: String,
        #[arg(long)]
        logic_offset: Option<u64>,
        #[arg(long)]
        uboot_start: Option<u64>,
        #[arg(long, default_value_t = 16)]
        nor_size: u64,
        #[arg(long, default_value = "auto")]
        storage_size: String,
    },
    /// Flash an IMAGEWTY firmware to a FEL/FES device
    Flash {
        firmware_path: String,
        #[arg(long, value_parser = ["partition", "keep_data", "partition_erase", "full_erase"])]
        mode: String,
        /// Show the write plan without opening the flash device
        #[arg(long, conflicts_with = "confirm_plan", required_unless_present = "confirm_plan")]
        dry_run: bool,
        /// Plan ID returned by --dry-run for this firmware and selection
        #[arg(long)]
        confirm_plan: Option<String>,
        /// Exact ADB target to wait for after reboot
        #[arg(long)]
        adb_target: Option<String>,
        #[arg(long, requires = "adb_target")]
        expected_slot: Option<String>,
        #[arg(long, requires_all = ["adb_target", "expected_sha256"])]
        executable_path: Option<String>,
        #[arg(long, requires = "executable_path")]
        expected_sha256: Option<String>,
        #[arg(long, requires = "adb_target")]
        boot_timeout_ms: Option<u64>,
        #[arg(long = "partition")]
        partitions: Vec<String>,
        #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
        verify: bool,
        #[arg(long, default_value = "reboot")]
        post_action: String,
        #[arg(long)]
        bus: Option<u8>,
        #[arg(long)]
        port: Option<u8>,
    },
    /// Flash a raw disk image using a boot IMAGEWTY firmware
    Raw {
        boot_firmware: String,
        raw_image: String,
        #[arg(long, default_value = "logic-offset")]
        mode: String,
        #[arg(long, default_value = "sdmmc")]
        storage: String,
        #[arg(long)]
        logic_offset: Option<u64>,
        #[arg(long)]
        bus: Option<u8>,
        #[arg(long)]
        port: Option<u8>,
    },
    /// Read memory via FEL
    EfelRead {
        #[arg(value_parser = parse_u32_auto)]
        address: u32,
        #[arg(default_value_t = 64)]
        length: usize,
    },
    /// Write bytes to memory via FEL
    EfelWrite {
        #[arg(value_parser = parse_u32_auto)]
        address: u32,
        data: Vec<u8>,
    },
    /// Execute code at address via FEL
    EfelExec {
        #[arg(value_parser = parse_u32_auto)]
        address: u32,
    },
    /// List installed workflow plugins
    Plugins,
    /// Install a .oixplugin or .zip plugin package
    PluginInstall { package_path: String },
    /// Uninstall an installed plugin by ID
    PluginUninstall { plugin_id: String },
    /// Run an installed declarative workflow plugin
    PluginRun {
        plugin_id: String,
        #[arg(long, value_name = "TAB_ID")]
        tab: Option<String>,
        #[arg(long, default_value = "")]
        serial: String,
        #[arg(long, default_value = "{}")]
        inputs: String,
    },
    /// List available host serial ports
    SerialPorts,
    /// Open a serial session in the running desktop app
    SerialOpen {
        port_name: String,
        #[arg(long, default_value_t = 115200)]
        baud_rate: u32,
        #[arg(long, default_value = "")]
        session_id: String,
    },
    /// Close an active serial session
    SerialClose { session_id: String },
    /// List serial log files or read buffered/persisted serial logs
    SerialLogs {
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long)]
        file_name: Option<String>,
        #[arg(long)]
        tail: Option<usize>,
    },
    /// List saved log profiles
    LogProfiles,
    /// Save one log profile from a JSON file or stdin (-)
    LogProfileSave { json_file: PathBuf },
    /// Read or change the live log workspace in the running desktop
    LogUi {
        #[arg(value_parser = ["get", "pane-set", "layout-set", "bridge-set"])]
        action: String,
        /// Settings patch in a JSON file, or '-' for stdin (required for setters)
        json_file: Option<PathBuf>,
    },
    /// Read configured log directory and storage policy
    LogStorage,
    /// Patch log directory or storage policy using a JSON file or stdin (-)
    LogStorageSave { json_file: PathBuf },
    /// List the desktop app's active serial and ADB log sessions
    LogSessions,
    /// Start capturing a source from a saved log profile
    LogStart {
        profile_id: String,
        /// Exact source label from the saved profile
        source: String,
    },
    /// Stop an active log session
    LogStop { session_id: String },
    /// Start two-way forwarding between the serial ports in a saved profile
    BridgeStart { profile_id: String },
    /// Stop two-way serial forwarding
    BridgeStop,
    /// Show the active serial bridge
    BridgeStatus,
    /// Send data to an active serial session
    SerialSend {
        session_id: String,
        data: String,
        /// Interpret data as hexadecimal bytes, with optional whitespace
        #[arg(long)]
        hex: bool,
        /// Append none, lf, cr, or crlf (default lf for text, none for hex)
        #[arg(long, value_parser = ["none", "lf", "cr", "crlf"], ignore_case = true)]
        append_newline: Option<String>,
    },
    /// Execute a power control profile action (on | off | cycle)
    Power {
        profile_id: String,
        #[arg(default_value = "cycle")]
        action: String,
    },
    /// List the desktop app's power profiles
    PowerProfiles,
    /// Save a single power profile draft from a JSON file or stdin (-)
    PowerProfileSave { json_file: PathBuf },
    /// Query live CPU/memory/thermal/top metrics via ADB
    Metrics {
        #[arg(long, default_value = "")]
        serial: String,
        /// Wait this many milliseconds between two samples to measure interval rates
        #[arg(long)]
        sample_ms: Option<u64>,
    },
    /// List automation rules
    Rules,
    /// Save a single disabled automation rule draft from a JSON file or stdin (-)
    RuleSave { json_file: PathBuf },
    /// List recorded trigger incident reports
    Incidents,
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

fn parse_u32_auto(s: &str) -> Result<u32, String> {
    let trimmed = s.trim();
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).map_err(|e| e.to_string())
    } else {
        trimmed.parse::<u32>().map_err(|e| e.to_string())
    }
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    let result = if path == Path::new("-") {
        serde_json::from_reader(io::stdin().lock())
    } else {
        let file =
            File::open(path).map_err(|e| format!("Cannot open {}: {}", path.display(), e))?;
        serde_json::from_reader(file)
    };
    result.map_err(|e| format!("Invalid JSON object from {}: {}", path.display(), e))
}

fn send_http(addr: &str, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
    let mut stream = TcpStream::connect(addr)
        .map_err(|e| format!("Failed to connect to OpenixSuit-CE IPC ({}): {}", addr, e))?;
    let read_timeout_secs = if path == "/api/flash/execute" { 720 } else { 600 };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(read_timeout_secs)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let body_bytes = match body {
        Some(v) => serde_json::to_vec(&v).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };

    let req = if body_bytes.is_empty() && method == "GET" {
        format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            path, addr
        )
    } else {
        format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            method,
            path,
            addr,
            body_bytes.len()
        )
    };

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("Failed to write HTTP request: {}", e))?;
    if !body_bytes.is_empty() {
        stream
            .write_all(&body_bytes)
            .map_err(|e| format!("Failed to write HTTP body: {}", e))?;
    }
    let _ = stream.flush();

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("Failed to read HTTP response: {}", e))?;

    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "Malformed HTTP response from IPC server".to_string())?;
    let head = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "Invalid UTF-8 in HTTP response headers".to_string())?;
    let status_code = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(500);

    let json_bytes = &raw[header_end + 4..];
    let parsed: Value = serde_json::from_slice(json_bytes)
        .map_err(|e| format!("Invalid JSON response: {}", e))?;
    Ok((status_code, parsed))
}

pub fn run_from_args<I, T>(itr: I) -> ExitCode
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = Cli::parse_from(itr);

    let (method, path, payload): (&str, String, Option<Value>) = match cli.command {
        Commands::Status => ("GET", "/api/status".to_string(), None),
        Commands::AdbShell { serial, command } => (
            "POST",
            "/api/adb/shell".to_string(),
            Some(json!({ "serial": serial, "command": command })),
        ),
        Commands::AdbPush {
            serial,
            local_path,
            remote_path,
        } => (
            "POST",
            "/api/adb/push".to_string(),
            Some(json!({
                "serial": serial,
                "local_path": local_path,
                "remote_path": remote_path,
            })),
        ),
        Commands::AdbPull {
            serial,
            remote_path,
            local_path,
        } => (
            "POST",
            "/api/adb/pull".to_string(),
            Some(json!({
                "serial": serial,
                "remote_path": remote_path,
                "local_path": local_path,
            })),
        ),
        Commands::RebootEfex { serial } => (
            "POST",
            "/api/adb/reboot-efex".to_string(),
            Some(json!({ "serial": serial })),
        ),
        Commands::FesExit { device_id, action } => (
            "POST",
            "/api/fes/exit".to_string(),
            Some(json!({ "device_id": device_id, "action": action })),
        ),
        Commands::AdbRoot { serial } => (
            "POST",
            "/api/adb/root".to_string(),
            Some(json!({ "serial": serial })),
        ),
        Commands::Inspect { firmware_path } => (
            "POST",
            "/api/inspect".to_string(),
            Some(json!({ "firmware_path": firmware_path })),
        ),
        Commands::Unpack {
            firmware_path,
            out_dir,
        } => (
            "POST",
            "/api/unpack".to_string(),
            Some(json!({
                "firmware_path": firmware_path,
                "out_dir": out_dir,
            })),
        ),
        Commands::Convert {
            firmware_path,
            target,
            output,
            logic_offset,
            uboot_start,
            nor_size,
            storage_size,
        } => (
            "POST",
            "/api/convert".to_string(),
            Some(json!({
                "firmware_path": firmware_path,
                "target": target,
                "output_path": output,
                "logic_offset": logic_offset,
                "uboot_start": uboot_start,
                "nor_size": nor_size,
                "storage_size": storage_size,
            })),
        ),
        Commands::Flash {
            firmware_path,
            mode,
            dry_run,
            confirm_plan,
            adb_target,
            expected_slot,
            executable_path,
            expected_sha256,
            boot_timeout_ms,
            partitions,
            verify,
            post_action,
            bus,
            port,
        } => (
            "POST",
            if dry_run { "/api/flash/plan" } else { "/api/flash/execute" }.to_string(),
            Some(json!({
                "confirm_plan": confirm_plan,
                "boot_check": adb_target.map(|target| json!({
                    "adbTarget": target,
                    "expectedSlot": expected_slot,
                    "programCheck": executable_path.map(|path| json!({
                        "executablePath": path,
                        "expectedSha256": expected_sha256,
                    })),
                    "timeoutMs": boot_timeout_ms,
                })),
                "firmware_path": firmware_path,
                "mode": mode,
                "partitions": partitions,
                "verify": verify,
                "post_action": post_action,
                "bus": bus,
                "port": port,
            })),
        ),
        Commands::Raw {
            boot_firmware,
            raw_image,
            mode,
            storage,
            logic_offset,
            bus,
            port,
        } => (
            "POST",
            "/api/raw".to_string(),
            Some(json!({
                "boot_firmware": boot_firmware,
                "raw_image": raw_image,
                "mode": mode,
                "storage": storage,
                "logic_offset": logic_offset,
                "bus": bus,
                "port": port,
            })),
        ),
        Commands::EfelRead { address, length } => (
            "POST",
            "/api/efel/read".to_string(),
            Some(json!({ "address": address, "length": length })),
        ),
        Commands::EfelWrite { address, data } => (
            "POST",
            "/api/efel/write".to_string(),
            Some(json!({ "address": address, "data": data })),
        ),
        Commands::EfelExec { address } => (
            "POST",
            "/api/efel/exec".to_string(),
            Some(json!({ "address": address })),
        ),
        Commands::Plugins => ("GET", "/api/plugins".to_string(), None),
        Commands::PluginInstall { package_path } => (
            "POST",
            "/api/plugins/install".to_string(),
            Some(json!({ "package_path": package_path })),
        ),
        Commands::PluginUninstall { plugin_id } => (
            "POST",
            "/api/plugins/uninstall".to_string(),
            Some(json!({ "plugin_id": plugin_id })),
        ),
        Commands::PluginRun {
            plugin_id,
            tab,
            serial,
            inputs,
        } => {
            let parsed_inputs: Map<String, Value> = match serde_json::from_str(&inputs) {
                Ok(m) => m,
                Err(e) => {
                    println!(
                        "{}",
                        json!({
                            "ok": false,
                            "error": format!("Invalid --inputs JSON object: {}", e)
                        })
                    );
                    return ExitCode::from(1);
                }
            };
            (
                "POST",
                "/api/plugins/run".to_string(),
                Some(json!({
                    "plugin_id": plugin_id,
                    "tab_id": tab,
                    "serial": serial,
                    "inputs": parsed_inputs,
                })),
            )
        }
        Commands::SerialPorts => ("GET", "/api/serial/ports".to_string(), None),
        Commands::SerialOpen {
            port_name,
            baud_rate,
            session_id,
        } => (
            "POST",
            "/api/serial/open".to_string(),
            Some(json!({
                "port_name": port_name,
                "baud_rate": baud_rate,
                "session_id": session_id,
            })),
        ),
        Commands::SerialClose { session_id } => (
            "POST",
            "/api/serial/close".to_string(),
            Some(json!({ "session_id": session_id })),
        ),
        Commands::SerialLogs {
            session_id,
            file_name,
            tail,
        } => {
            let mut params = Vec::new();
            if let Some(sid) = session_id {
                params.push(format!("session_id={}", percent_encode(&sid)));
            }
            if let Some(fname) = file_name {
                params.push(format!("file_name={}", percent_encode(&fname)));
            }
            if let Some(n) = tail {
                params.push(format!("tail_lines={}", n));
            }
            let p = if params.is_empty() {
                "/api/serial/logs".to_string()
            } else {
                format!("/api/serial/logs?{}", params.join("&"))
            };
            ("GET", p, None)
        }
        Commands::SerialSend {
            session_id,
            data,
            hex,
            append_newline,
        } => (
            "POST",
            "/api/serial/write".to_string(),
            Some(json!({
                "session_id": session_id,
                "data": data,
                "hex": hex,
                "append_newline": append_newline.as_deref().unwrap_or(if hex { "none" } else { "lf" }),
            })),
        ),
        Commands::Power { profile_id, action } => (
            "POST",
            "/api/power/action".to_string(),
            Some(json!({
                "profile_id": profile_id,
                "action": action,
            })),
        ),
        Commands::Metrics { serial, sample_ms } => {
            let mut params = Vec::new();
            if !serial.is_empty() {
                params.push(format!("serial={}", percent_encode(&serial)));
            }
            if let Some(sample_ms) = sample_ms {
                params.push(format!("sample_ms={}", sample_ms));
            }
            let mut path = "/api/monitor/metrics".to_string();
            if !params.is_empty() {
                path.push('?');
                path.push_str(&params.join("&"));
            }
            ("GET", path, None)
        }
        Commands::Rules => ("GET", "/api/triggers/rules".to_string(), None),
        Commands::PowerProfiles => ("GET", "/api/power/profiles".to_string(), None),
        Commands::LogProfiles => ("GET", "/api/log-profiles".to_string(), None),
        Commands::LogStorage => ("GET", "/api/log-storage".to_string(), None),
        Commands::LogUi { ref action, ref json_file } => {
            let params = match json_file.as_deref() {
                Some(path) => read_json_object(path),
                None if action == "get" => Ok(Map::new()),
                None => Err(format!("log-ui {action} requires a JSON file or '-' for stdin")),
            };
            match params {
                Ok(params) => (
                    "POST",
                    "/api/log-ui".to_string(),
                    Some(json!({ "action": action, "params": params })),
                ),
                Err(error) => {
                    println!("{}", json!({ "ok": false, "error": error }));
                    return ExitCode::FAILURE;
                }
            }
        }
        Commands::LogSessions => ("GET", "/api/log-sessions".to_string(), None),
        Commands::LogStart { profile_id, source } => (
            "POST",
            "/api/log-sessions/start".to_string(),
            Some(json!({ "profile_id": profile_id, "source": source })),
        ),
        Commands::LogStop { session_id } => (
            "POST",
            "/api/log-sessions/stop".to_string(),
            Some(json!({ "session_id": session_id })),
        ),
        Commands::BridgeStart { profile_id } => (
            "POST",
            "/api/serial/bridge/start".to_string(),
            Some(json!({ "profile_id": profile_id })),
        ),
        Commands::BridgeStop => ("POST", "/api/serial/bridge/stop".to_string(), None),
        Commands::BridgeStatus => ("GET", "/api/serial/bridge".to_string(), None),
        Commands::RuleSave { ref json_file }
        | Commands::PowerProfileSave { ref json_file }
        | Commands::LogStorageSave { ref json_file }
        | Commands::LogProfileSave { ref json_file } => {
            let path = match cli.command {
                Commands::RuleSave { .. } => "/api/triggers/rules",
                Commands::PowerProfileSave { .. } => "/api/power/profiles",
                Commands::LogStorageSave { .. } => "/api/log-storage",
                _ => "/api/log-profiles",
            };
            match read_json_object(json_file) {
                Ok(draft) => ("POST", path.to_string(), Some(Value::Object(draft))),
                Err(err) => {
                    println!("{}", json!({ "ok": false, "error": err }));
                    return ExitCode::from(1);
                }
            }
        }
        Commands::Incidents => ("GET", "/api/triggers/incidents".to_string(), None),
    };

    match send_http(&cli.addr, method, &path, payload) {
        Ok((status, val)) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string())
            );
            let ok = val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if status < 400 && ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Err(err) => {
            let err_json = json!({ "ok": false, "error": err });
            println!("{}", err_json);
            ExitCode::from(1)
        }
    }
}

pub fn run() -> ExitCode {
    run_from_args(std::env::args_os())
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::{error::ErrorKind, Parser};

    #[test]
    fn standard_flash_requires_mode_and_one_confirmation_route() {
        let parse = |args: &[&str]| Cli::try_parse_from(["openixsuit-ai", "flash", "firmware.img"].into_iter().chain(args.iter().copied()));
        let missing = parse(&["--dry-run"]).err().unwrap();
        assert_eq!(missing.kind(), ErrorKind::MissingRequiredArgument);
        assert!(missing.to_string().contains("--mode"));
        assert!(parse(&["--mode", "full_erase"]).is_err());
        assert!(parse(&["--mode", "full_erase", "--dry-run"]).is_ok());
        assert!(parse(&["--mode", "full_erase", "--confirm-plan", "plan"]).is_ok());
        assert!(parse(&["--mode", "full_erase", "--dry-run", "--confirm-plan", "plan"]).is_err());
    }
}
