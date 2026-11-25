use super::jobs::Job;
use crate::efex::standard_flash::{self, StandardFlashOptions};
use crate::{adb, adb_log, efex, log_sessions, packer, power, serial, state::AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

pub(super) async fn call(job: &Job, method: &str, args: Value) -> Result<Value, String> {
    let app = &job.app;
    let state = app.state::<AppState>();
    match method {
        "logs.sessions" => {
            job.allow("logs.read")?;
            let mut sessions = log_sessions::log_sessions_list(state)?;
            sessions.sort_by(|a, b| a.id.cmp(&b.id));
            let mut result = serde_json::to_value(sessions).map_err(|e| e.to_string())?;
            if let Some(items) = result.as_array_mut() {
                items.extend(super::providers::list(app, None).into_iter()
                    .filter(|session| session.kind == "log" && session.status != "stopped")
                    .map(|session| json!({"id":session.id,"label":session.provider,"type":"plugin"})));
            }
            Ok(result)
        }
        "logs.recent" => {
            job.allow("logs.read")?;
            let id = string(&args, "session_id")?;
            let lines = args
                .get("lines")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .clamp(1, 200) as usize;
            let tail = super::providers::recent(app, id, lines)
                .or_else(|| adb_log::recent_lines(&state, id, lines))
                .map(Ok)
                .unwrap_or_else(|| serial::serial_get_buffer_with_state(&state, id, Some(lines)))?;
            Ok(json!(tail
                .into_iter()
                .map(|l| l.chars().take(900).collect::<String>())
                .collect::<Vec<_>>()))
        }
        "devices.list" => {
            job.allow("devices.read")?;
            let backend = state.usb_backend.lock().map_err(|e| e.to_string())?.clone();
            blocking(move || {
                let (adb_devices, adb_error) = match adb::adb_list_devices() {
                    Ok(devices) => (devices, None),
                    Err(error) => (vec![], Some(error)),
                };
                Ok(json!({
                    "adb": adb_devices, "adb_error": adb_error,
                    "fel": efex::scan_devices_with_backend(&backend)
                }))
            })
            .await
        }
        "firmware.inspect" => {
            job.allow("firmware.inspect")?;
            let file = local_path(job, string(&args, "path")?, true)?;
            blocking(move || serialize(packer::inspect_image(file)?)).await
        }
        "firmware.flash" => {
            job.allow("firmware.flash")?;
            let target = device(job)?;
            let (bus, port) = fel_target(&target)?;
            let mut options = deserialize::<StandardFlashOptions>(args)?;
            options.firmware_path = local_path(job, &options.firmware_path, true)?;
            options.bus = Some(bus);
            options.port = Some(port);
            options.confirm_plan = None;
            let plan = serialize(standard_flash::preview(options.clone()).await?)?;
            options.confirm_plan = plan.get("id").and_then(Value::as_str).map(str::to_owned);
            job.authorize(
                "firmware.flash",
                "Write firmware using the displayed plan",
                plan,
            )
            .await?;
            let _native = job.begin_native()?;
            let report = standard_flash::run(app, &state, "plugin", options).await?;
            let ok = report.ok();
            let result = serialize(report)?;
            if !ok {
                let reason = result["flash"]["error"]
                    .as_str()
                    .or_else(|| result["boot"]["adbReconnect"]["message"].as_str())
                    .unwrap_or("Firmware write or boot verification failed");
                return Err(reason.to_owned());
            }
            Ok(result)
        }
        "power.execute" => {
            job.allow("power.execute")?;
            let profile = string(&args, "profile_id")?.to_owned();
            let action = string(&args, "action")?.to_owned();
            if !matches!(action.as_str(), "on" | "off" | "cycle") {
                return Err("Unknown power action".into());
            }
            let profile_data = power::power_list_profiles()?
                .into_iter()
                .find(|item| item.id == profile)
                .ok_or("Unknown power profile")?;
            if profile_data.draft {
                return Err("Confirm the power profile before running it".into());
            }
            job.authorize(
                "power.execute",
                "Operate a power profile",
                json!({"profile_id":profile,"profile":profile_data.name,"action":action}),
            )
            .await?;
            let _native = job.begin_native()?;
            let _busy = state.try_acquire_busy("plugin:power")?;
            power::power_execute_async(&profile, &action)
                .await
                .map(|message| json!({"message":message}))
        }
        "adb.partition.inspect" => {
            job.allow("adb.partition")?;
            let target = adb_target(job).await?;
            let partition = string(&args, "partition")?.to_owned();
            blocking(move || serialize(inspect_partition(&target, &partition)?)).await
        }
        "adb.partition.write" => write_partition(job, &state, deserialize(args)?).await,
        "adb.deploy" => deploy(job, &state, deserialize(args)?).await,
        "adb.shell" | "adb.root" | "adb.reboot" | "adb.reboot_efex" | "adb.push" | "adb.pull" => {
            adb_operation(job, &state, method, args).await
        }
        _ => Err(format!("Unknown plugin host operation: {method}")),
    }
}

async fn adb_operation(
    job: &Job,
    state: &AppState,
    method: &str,
    args: Value,
) -> Result<Value, String> {
    let permission = match method {
        "adb.push" | "adb.pull" => "adb.transfer",
        "adb.reboot" | "adb.reboot_efex" => "adb.reboot",
        "adb.root" => "adb.root",
        _ => "adb.shell",
    };
    job.allow(permission)?;
    let target = adb_target(job).await?;
    let plan = match method {
        "adb.push" | "adb.pull" => json!({
            "local_path":local_path(job, string(&args, "local_path")?, method == "adb.push")?,
            "remote_path":remote_path(string(&args, "remote_path")?)?,
            "target":target
        }),
        "adb.shell" => json!({"command": string(&args, "command")?, "target":target}),
        _ => json!({"target":target}),
    };
    job.authorize(permission, method, plan.clone()).await?;
    let _native = job.begin_native()?;
    let _busy = state.try_acquire_busy("plugin:adb")?;
    let method = method.to_owned();
    blocking(move || match method.as_str() {
        "adb.shell" => exact_shell(&target, string(&plan, "command")?).map(Value::String),
        "adb.root" => adb::adb_root(target).map(Value::String),
        "adb.reboot" => adb::adb_reboot(target).map(|_| json!({"requested":true})),
        "adb.reboot_efex" => adb::adb_reboot_efex(target).map(Value::String),
        "adb.push" => adb::adb_push_file(
            target,
            string(&plan, "local_path")?.into(),
            string(&plan, "remote_path")?.into(),
        )
        .map(|_| json!({"transferred":true})),
        "adb.pull" => adb::adb_pull_file(
            target,
            string(&plan, "remote_path")?.into(),
            string(&plan, "local_path")?.into(),
        )
        .map(|_| json!({"transferred":true})),
        _ => unreachable!(),
    })
    .await
}

#[derive(Clone, serde::Serialize)]
struct Partition {
    current_slot: String,
    target_slot: String,
    remote_path: String,
}

fn slot(value: &str) -> Result<&str, String> {
    match value.trim().trim_start_matches('_') {
        "a" => Ok("a"),
        "b" => Ok("b"),
        _ => Err(format!("Unrecognized A/B slot: {}", value.trim())),
    }
}

fn inspect_partition(target: &str, name: &str) -> Result<Partition, String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid partition name".into());
    }
    let observed = exact_shell(target, "getprop ro.boot.slot_suffix")?;
    let current_slot = slot(&observed)?;
    let target_slot = if current_slot == "a" { "b" } else { "a" };
    Ok(Partition {
        current_slot: current_slot.to_owned(),
        target_slot: target_slot.to_owned(),
        remote_path: format!("/dev/block/by-name/{name}_{target_slot}"),
    })
}

#[derive(Deserialize)]
struct PartitionWrite {
    partition: String,
    local_path: String,
    expected_slot: String,
    #[serde(default)]
    reboot: bool,
}

async fn write_partition(
    job: &Job,
    state: &AppState,
    request: PartitionWrite,
) -> Result<Value, String> {
    job.allow("adb.partition")?;
    if request.reboot {
        job.allow("adb.reboot")?;
    }
    let target = adb_target(job).await?;
    let local = local_path(job, &request.local_path, true)?;
    let check_target = target.clone();
    let check_name = request.partition.clone();
    let check_image = local.clone();
    let (destination, size, hash) = blocking(move || {
        let destination = inspect_partition(&check_target, &check_name)?;
        let (size, hash) = image_identity(&check_image)?;
        Ok((destination, size, hash))
    })
    .await?;
    if destination.target_slot != slot(&request.expected_slot)? {
        return Err("Requested slot is active or changed since inspection".into());
    }
    job.authorize(
        "adb.partition",
        "Write and read back the inactive A/B partition",
        json!({
            "target":target, "destination":destination, "image":local,
            "bytes":size,"sha256":hash,"restart_adbd_as_root":true,"reboot":request.reboot
        }),
    )
    .await?;
    let _native = job.begin_native()?;
    let _busy = state.try_acquire_busy("plugin:partition-write")?;
    let temporary = format!("/tmp/{}.img", job.snapshot().id);
    blocking(move || {
        if image_identity(&local)? != (size, hash.clone()) {
            return Err("Image changed after confirmation".into());
        }
        adb::adb_root(target.clone())?;
        wait_after_root(&target)?;
        let write: Result<(), String> = (|| {
            adb::adb_push_file(target.clone(), local, temporary.clone())?;
            let active_path = format!(
                "/dev/block/by-name/{}_{}",
                request.partition, destination.current_slot
            );
            let current = inspect_partition(&target, &request.partition)?;
            if current.target_slot != destination.target_slot {
                return Err("Active slot changed after confirmation".into());
            }
            let actual = shell_quote(&destination.remote_path);
            let stage = shell_quote(&temporary);
            let active = shell_quote(&active_path);
            let command = format!(
                "set -e\n\
                 test -b {actual}\n\
                 test -b {active}\n\
                 test \"$(readlink -f {actual})\" != \"$(readlink -f {active})\"\n\
                 capacity=$(blockdev --getsize64 {actual} 2>/dev/null) || {{\n\
                   block=$(basename \"$(readlink -f {actual})\");\n\
                   sectors=$(cat \"/sys/class/block/$block/size\");\n\
                   capacity=$((sectors * 512));\n\
                 }}\n\
                 test \"$capacity\" -ge {size}\n\
                 uploaded=$(sha256sum {stage}); test \"\x24{{uploaded%% *}}\" = '{hash}'\n\
                 dd if={stage} of={actual} bs=1M conv=fsync\n\
                 observed=$(head -c {size} {actual} | sha256sum)\n\
                 test \"\x24{{observed%% *}}\" = '{hash}'\n\
                 printf 'OPENIX_VERIFIED\\n'"
            );
            let output = exact_shell(&target, &command)?;
            if !output.lines().any(|line| line.trim() == "OPENIX_VERIFIED") {
                return Err("The device did not confirm the read-back hash".into());
            }
            Ok(())
        })();
        let cleanup = exact_shell(&target, &format!("rm -f {}", shell_quote(&temporary)));
        write?;
        cleanup?;
        if request.reboot {
            adb::adb_reboot(target.clone())?;
        }
        Ok(
            json!({"target":target, "destination":destination, "bytes":size, "sha256":hash,
            "verified":true, "reboot_requested":request.reboot}),
        )
    })
    .await
}

#[derive(Deserialize)]
struct Deploy {
    local_path: String,
    remote_dir: String,
    remote_name: String,
    #[serde(default)]
    need_root: bool,
    #[serde(default)]
    restart_cmd: String,
}

async fn deploy(job: &Job, state: &AppState, request: Deploy) -> Result<Value, String> {
    job.allow("adb.transfer")?;
    if request.need_root {
        job.allow("adb.root")?;
    }
    if !request.restart_cmd.trim().is_empty() {
        job.allow("adb.shell")?;
    }
    let target = adb_target(job).await?;
    let local = local_path(job, &request.local_path, true)?;
    let directory = remote_path(&request.remote_dir)?
        .trim_end_matches('/')
        .to_owned();
    let name = request.remote_name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\r', '\n', '\0'])
    {
        return Err("Invalid device filename".into());
    }
    let destination = format!("{directory}/{name}");
    job.authorize(
        "adb.transfer",
        "Deploy an executable file to the selected device",
        json!({
            "target":target, "source":local, "destination":destination,
            "restart_adbd_as_root":request.need_root, "restart_command":request.restart_cmd
        }),
    )
    .await?;
    let _native = job.begin_native()?;
    let _busy = state.try_acquire_busy("plugin:adb-deploy")?;
    blocking(move || {
        if request.need_root {
            adb::adb_root(target.clone())?;
            wait_after_root(&target)?;
        }
        exact_shell(&target, &format!("mkdir -p {}", shell_quote(if directory.is_empty() { "/" } else { &directory })))?;
        adb::adb_push_file(target.clone(), local, destination.clone())?;
        exact_shell(&target, &format!("chmod +x {path} && test -x {path}", path = shell_quote(&destination)))?;
        let restart_output = if request.restart_cmd.trim().is_empty() { None }
            else { Some(exact_shell(&target, &request.restart_cmd)?) };
        Ok(json!({"target":target,"remote_path":destination,"executable":true,"restart_output":restart_output}))
    }).await
}

fn wait_after_root(target: &str) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        if exact_shell(target, "id -u").is_ok_and(|value| value.trim() == "0") {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("The selected ADB device did not reconnect as root".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn image_identity(path: &str) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let size = io::copy(&mut file, &mut sha).map_err(|e| e.to_string())?;
    if size == 0 {
        return Err("The image is empty".into());
    }
    Ok((size, format!("{:x}", sha.finalize())))
}

fn exact_shell(target: &str, command: &str) -> Result<String, String> {
    let output = adb::resolve_device(target)?
        .command()
        .args(["shell", command])
        .output()
        .map_err(|e| format!("Failed to execute adb shell: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "adb shell exited with {}: {} {}",
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\"'\"'"))
}

fn remote_path(path: &str) -> Result<&str, String> {
    if !path.starts_with('/') || path.contains(['\0', '\n', '\r']) {
        return Err("Expected an absolute path on the device".into());
    }
    Ok(path)
}

fn local_path(job: &Job, path: &str, must_exist: bool) -> Result<String, String> {
    let resolved = if let Some(path) = path.strip_prefix("plugin://") {
        super::packages::package_file(
            &super::packages::package_dir(&job.installed.manifest.id)?,
            path,
        )?
    } else {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err("Expected an absolute local path or a plugin:// resource".into());
        }
        PathBuf::from(path)
    };
    if must_exist && !resolved.is_file() {
        return Err(format!("File not found: {}", resolved.display()));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

fn device(job: &Job) -> Result<String, String> {
    job.snapshot()
        .device
        .ok_or_else(|| "Select a target device for this action".into())
}

async fn adb_target(job: &Job) -> Result<String, String> {
    let selected = device(job)?;
    blocking(move || adb::resolve_device(&selected).map(|device| device.target().to_owned())).await
}

fn fel_target(id: &str) -> Result<(u8, u8), String> {
    let (bus, port) = id
        .strip_prefix("bus:")
        .and_then(|value| value.split_once("-port:"))
        .ok_or("Select a FEL/FES device by its bus and port")?;
    Ok((
        bus.parse().map_err(|_| "Invalid USB bus")?,
        port.parse().map_err(|_| "Invalid USB port")?,
    ))
}

fn string<'a>(args: &'a Value, field: &str) -> Result<&'a str, String> {
    args.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Expected nonempty string: {field}"))
}

fn serialize<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn deserialize<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_fel_and_slot_selectors() {
        assert_eq!(fel_target("bus:1-port:7"), Ok((1, 7)));
        assert!(fel_target("auto").is_err());
        assert_eq!(slot("_b"), Ok("b"));
        assert!(slot("unknown").is_err());
        assert_eq!(
            shell_quote("/opt/test's files"),
            "'/opt/test'\"'\"'s files'"
        );
    }
}
