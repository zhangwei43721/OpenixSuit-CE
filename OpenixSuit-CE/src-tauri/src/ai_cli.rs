use clap::{Parser, Subcommand};
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::TcpStream;
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
        #[arg(long, default_value = "full_erase")]
        mode: String,
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
        #[arg(long, default_value = "")]
        serial: String,
        #[arg(long, default_value = "{}")]
        inputs: String,
    },
    /// List available host serial ports
    SerialPorts,
    /// List serial log files or read buffered/persisted serial logs
    SerialLogs {
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long)]
        file_name: Option<String>,
        #[arg(long)]
        tail: Option<usize>,
    },
    /// Send data to an active serial session
    SerialSend {
        session_id: String,
        data: String,
        #[arg(long, default_value = "lf")]
        append_newline: String,
    },
    /// Execute a power control profile action (on | off | cycle)
    Power {
        profile_id: String,
        #[arg(default_value = "cycle")]
        action: String,
    },
    /// Query live CPU/memory/thermal/top metrics via ADB
    Metrics {
        #[arg(long, default_value = "")]
        serial: String,
    },
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

fn send_http(addr: &str, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
    let mut stream = TcpStream::connect(addr)
        .map_err(|e| format!("Failed to connect to OpenixSuit-CE IPC ({}): {}", addr, e))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
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
            partitions,
            verify,
            post_action,
            bus,
            port,
        } => (
            "POST",
            "/api/flash".to_string(),
            Some(json!({
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
                    "serial": serial,
                    "inputs": parsed_inputs,
                })),
            )
        }
        Commands::SerialPorts => ("GET", "/api/serial/ports".to_string(), None),
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
            append_newline,
        } => (
            "POST",
            "/api/serial/write".to_string(),
            Some(json!({
                "session_id": session_id,
                "data": data,
                "append_newline": append_newline,
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
        Commands::Metrics { serial } => {
            let p = if serial.is_empty() {
                "/api/monitor/metrics".to_string()
            } else {
                format!("/api/monitor/metrics?serial={}", percent_encode(&serial))
            };
            ("GET", p, None)
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
