//! 刷写完成后的可选启动核验。

use crate::adb::{adb_command, parse_devices, select_device, AdbDevice};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 45_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFlashVerificationRequest {
    /// 用户明确选定的 ADB target，例如 adb-usb:usb:1-3#20080411。
    pub adb_target: Option<String>,
    /// Android 启动槽位，可填 a、b、_a 或 _b。
    pub expected_slot: Option<String>,
    pub program_check: Option<ProgramCheckRequest>,
    /// 总超时毫秒数，默认 45 秒，最大 120 秒。
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramCheckRequest {
    /// 设备上正在运行的可执行文件绝对路径。
    pub executable_path: String,
    /// 预期 SHA-256，64 位十六进制字符串。
    pub expected_sha256: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Passed,
    Failed,
    TimedOut,
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub status: CheckStatus,
    pub expected: Option<String>,
    pub observed: Option<String>,
    pub evidence: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Passed,
    Failed,
    TimedOut,
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFlashVerificationReport {
    pub status: VerificationStatus,
    pub adb_reconnect: CheckReport,
    pub boot_slot: CheckReport,
    pub program: CheckReport,
}

impl PostFlashVerificationReport {
    pub fn skipped(message: &str) -> Self {
        let mut report = Self {
            status: VerificationStatus::Skipped,
            adb_reconnect: skipped(message),
            boot_slot: skipped(message),
            program: skipped(message),
        };
        report.adb_reconnect.message = Some(message.into());
        report
    }

    pub fn failed(message: &str) -> Self {
        let mut report = Self::skipped(message);
        report.status = VerificationStatus::Failed;
        report.adb_reconnect.status = CheckStatus::Failed;
        report
    }

    pub fn ok(&self) -> bool {
        matches!(
            self.status,
            VerificationStatus::Passed | VerificationStatus::Skipped
        )
    }
}

/// 在刷写开始前调用，及早拒绝无法执行或缺少目标设备的配置。
pub fn validate_request(request: &PostFlashVerificationRequest) -> Result<(), String> {
    let has_check = request.expected_slot.is_some() || request.program_check.is_some();
    if request
        .adb_target
        .as_deref()
        .is_some_and(|target| target.trim().is_empty())
    {
        return Err("adbTarget 已提供但内容为空".into());
    }
    if has_check
        && request
            .adb_target
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err("启动槽位或程序核验需要明确的 ADB 设备目标".into());
    }
    if let Some(slot) = request.expected_slot.as_deref() {
        if !matches!(slot.trim().trim_start_matches('_'), "a" | "b") {
            return Err("expectedSlot 仅支持 a、b、_a 或 _b".into());
        }
    }
    if let Some(program) = &request.program_check {
        if !program.executable_path.starts_with('/') || program.executable_path.contains('\n') {
            return Err("程序核验路径必须是设备上的绝对路径".into());
        }
        if program.expected_sha256.len() != 64
            || !program
                .expected_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err("expectedSha256 必须是 64 位十六进制 SHA-256".into());
        }
    }
    if request.timeout_ms == Some(0) {
        return Err("timeoutMs 必须大于 0".into());
    }
    if request
        .timeout_ms
        .is_some_and(|timeout| timeout > MAX_TIMEOUT_MS)
    {
        return Err(format!("timeoutMs 不能超过 {MAX_TIMEOUT_MS}"));
    }
    Ok(())
}

/// 刷写前确认指定 ADB 身份当前离线，避免把仍在线的其他设备认作本次刷写后的启动结果。
pub async fn preflight_post_flash(request: &PostFlashVerificationRequest) -> Result<(), String> {
    validate_request(request)?;
    let Some(target) = request
        .adb_target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    let target = target.to_owned();
    tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut version = adb_command();
        version.arg("version");
        run_bounded(version, deadline)
            .map_err(|error| format!("启动核验需要可用的系统 adb 命令: {}", error.message))?;
        match resolve_device_bounded(&target, deadline) {
            Ok(device) if device.state == "Device" => Err(format!(
                "刷写前指定 ADB 目标仍在线（{}，state={}），请先确认设备进入 FEL 并重试",
                device.target(),
                device.state
            )),
            Ok(_) => Ok(()),
            Err(error) if error.contains("is not connected") || error.contains("未连接") => {
                Ok(())
            }
            Err(error) => Err(format!("无法确认刷写前 ADB 目标状态: {error}")),
        }
    })
    .await
    .map_err(|error| format!("刷写前 ADB 检查任务异常退出: {error}"))?
}

/// 使用指定 ADB target 检查设备重连、启动槽位和可选运行程序。
pub async fn verify_post_flash(
    request: PostFlashVerificationRequest,
) -> Result<PostFlashVerificationReport, String> {
    validate_request(&request)?;
    tokio::task::spawn_blocking(move || verify_blocking(request))
        .await
        .map_err(|error| format!("启动核验任务异常退出: {error}"))
}

fn skipped(message: &str) -> CheckReport {
    CheckReport {
        status: CheckStatus::Skipped,
        expected: None,
        observed: None,
        evidence: None,
        message: Some(message.into()),
    }
}

fn verify_blocking(request: PostFlashVerificationRequest) -> PostFlashVerificationReport {
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );
    let deadline = Instant::now() + timeout;
    let target = request
        .adb_target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let Some(target) = target else {
        return PostFlashVerificationReport {
            status: VerificationStatus::Skipped,
            adb_reconnect: skipped("未启用 ADB 启动核验"),
            boot_slot: skipped("未提供 expectedSlot"),
            program: skipped("未提供 programCheck"),
        };
    };

    let mut adb_reconnect = CheckReport {
        status: CheckStatus::TimedOut,
        expected: Some(target.to_owned()),
        observed: None,
        evidence: None,
        message: Some("等待指定 ADB 设备重新上线".into()),
    };
    let device = loop {
        if Instant::now() >= deadline {
            break None;
        }
        match resolve_device_bounded(target, deadline) {
            Ok(device) if device.state == "Device" => {
                adb_reconnect.status = CheckStatus::Passed;
                adb_reconnect.observed = Some(device.target().to_owned());
                adb_reconnect.evidence = Some(format!("ADB state={}", device.state));
                adb_reconnect.message = Some("指定 ADB 设备已重新上线".into());
                break Some(device);
            }
            Ok(device) => {
                adb_reconnect.status = CheckStatus::TimedOut;
                adb_reconnect.observed = Some(device.state.clone());
            }
            Err(error) => adb_reconnect.evidence = Some(error),
        }
        thread::sleep(
            Duration::from_millis(750).min(deadline.saturating_duration_since(Instant::now())),
        );
    };

    let Some(device) = device else {
        return PostFlashVerificationReport {
            status: VerificationStatus::TimedOut,
            adb_reconnect,
            boot_slot: CheckReport {
                status: CheckStatus::Skipped,
                expected: request.expected_slot.as_deref().map(normalize_slot),
                observed: None,
                evidence: None,
                message: Some("ADB 设备未在超时前上线".into()),
            },
            program: request
                .program_check
                .map(|_| CheckReport {
                    status: CheckStatus::Skipped,
                    expected: None,
                    observed: None,
                    evidence: None,
                    message: Some("ADB 设备未在超时前上线".into()),
                })
                .unwrap_or_else(|| skipped("未提供 programCheck")),
        };
    };

    let expected_slot = request.expected_slot.clone();
    let program_request = request.program_check;
    let (boot_slot, program) = thread::scope(|scope| {
        let slot_device = &device;
        let slot_expected = expected_slot.as_deref();
        let slot_check = scope.spawn(move || check_slot(slot_device, slot_expected, deadline));
        let program_check = program_request.map(|program| {
            let program_device = &device;
            scope.spawn(move || check_program(program_device, program, deadline))
        });
        let slot = slot_check.join().unwrap_or_else(|_| CheckReport {
            status: CheckStatus::Failed,
            expected: expected_slot.as_deref().map(normalize_slot),
            observed: None,
            evidence: None,
            message: Some("启动槽位核验线程异常退出".into()),
        });
        let program = program_check
            .map(|check| {
                check.join().unwrap_or_else(|_| CheckReport {
                    status: CheckStatus::Failed,
                    expected: None,
                    observed: None,
                    evidence: None,
                    message: Some("程序核验线程异常退出".into()),
                })
            })
            .unwrap_or_else(|| skipped("未提供 programCheck"));
        (slot, program)
    });

    let checks = [&adb_reconnect, &boot_slot, &program];
    let status = if checks
        .iter()
        .any(|check| matches!(check.status, CheckStatus::TimedOut))
    {
        VerificationStatus::TimedOut
    } else if checks
        .iter()
        .any(|check| matches!(check.status, CheckStatus::Failed))
    {
        VerificationStatus::Failed
    } else if checks
        .iter()
        .all(|check| matches!(check.status, CheckStatus::Skipped))
    {
        VerificationStatus::Skipped
    } else {
        VerificationStatus::Passed
    };
    PostFlashVerificationReport {
        status,
        adb_reconnect,
        boot_slot,
        program,
    }
}

fn normalize_slot(slot: &str) -> String {
    slot.trim().trim_start_matches('_').to_ascii_lowercase()
}

fn parse_slot_report(output: &str, expected: Option<&str>) -> CheckReport {
    let observed = output
        .lines()
        .find_map(|line| line.strip_prefix("slot="))
        .unwrap_or_default()
        .trim()
        .to_owned();
    let evidence = output
        .lines()
        .find_map(|line| line.strip_prefix("source="))
        .unwrap_or_default()
        .trim()
        .to_owned();
    let expected = expected.map(normalize_slot);
    let slot_found = matches!(observed.as_str(), "a" | "b");
    let matched = expected
        .as_ref()
        .map_or(true, |expected| slot_found && observed == *expected);
    let status = if !slot_found && expected.is_none() {
        CheckStatus::Skipped
    } else if matched {
        CheckStatus::Passed
    } else {
        CheckStatus::Failed
    };
    let message = if slot_found && matched {
        "当前启动槽位符合预期"
    } else if !slot_found && expected.is_none() {
        "设备未提供可识别的启动槽位证据（rootfsA/B、rootfs_a/b 或明确槽位后缀）"
    } else {
        "当前启动槽位与预期不符或设备未报告槽位"
    };
    CheckReport {
        status,
        expected,
        observed: (!observed.is_empty()).then_some(observed),
        evidence: (!evidence.is_empty()).then_some(evidence),
        message: Some(message.into()),
    }
}

fn parse_running_program(output: &str) -> Option<(String, String)> {
    let mut fields = output.split_whitespace();
    let pid = fields.next()?.trim_end_matches("/exe");
    let hash = fields.next()?.to_ascii_lowercase();
    if pid.is_empty() || hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((pid.to_owned(), hash))
}

fn running_hash_matches(observed: &str, expected: &str) -> bool {
    observed.eq_ignore_ascii_case(expected)
}

fn check_slot(
    device: &crate::adb::AdbDevice,
    expected: Option<&str>,
    deadline: Instant,
) -> CheckReport {
    let expected = expected.map(normalize_slot);
    let mut last_observed = None;
    let mut last_error = None;
    loop {
        let script = r#"slot=; source=; root_label=; android_slot=; for arg in $(cat /proc/cmdline 2>/dev/null); do case "$arg" in androidboot.slot_suffix=*) android_slot=${arg#*=};; root=PARTLABEL=*) root_label=${arg#root=PARTLABEL=};; esac; done; mm=$(awk '$5=="/" {print $3; exit}' /proc/self/mountinfo 2>/dev/null); if [ -n "$mm" ] && [ -r "/sys/dev/block/$mm/uevent" ]; then partname=$(sed -n 's/^PARTNAME=//p' "/sys/dev/block/$mm/uevent" | head -n 1); partlabel=$(sed -n 's/^PARTLABEL=//p' "/sys/dev/block/$mm/uevent" | head -n 1); for name in "$partname" "$partlabel"; do case "$name" in rootfsA|rootfs_a) slot=a; source="mounted_root:$name"; break;; rootfsB|rootfs_b) slot=b; source="mounted_root:$name"; break;; esac; done; fi; if [ -z "$slot" ]; then case "$root_label" in rootfsA|rootfs_a) slot=a; source="cmdline:PARTLABEL=$root_label";; rootfsB|rootfs_b) slot=b; source="cmdline:PARTLABEL=$root_label";; esac; fi; if [ -z "$slot" ]; then case "$android_slot" in a|_a) slot=a; source="cmdline:androidboot.slot_suffix=$android_slot";; b|_b) slot=b; source="cmdline:androidboot.slot_suffix=$android_slot";; esac; fi; if [ -z "$slot" ]; then prop=$(getprop ro.boot.slot_suffix 2>/dev/null); case "$prop" in a|_a) slot=a; source="getprop:ro.boot.slot_suffix=$prop";; b|_b) slot=b; source="getprop:ro.boot.slot_suffix=$prop";; esac; fi; printf 'slot=%s\nsource=%s\n' "$slot" "$source""#;
        match run_shell(device, script, deadline) {
            Ok(output) => {
                let report = parse_slot_report(&output, expected.as_deref());
                if matches!(report.status, CheckStatus::Passed | CheckStatus::Skipped) {
                    return report;
                }
                last_observed = Some(report);
            }
            Err(error) if error.timed_out => break,
            Err(error) => last_error = Some(error),
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(
            Duration::from_millis(750).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    if let Some(report) = last_observed {
        report
    } else if let Some(error) = last_error {
        if let Some(expected) = expected {
            command_failure(expected, error)
        } else {
            CheckReport {
                status: CheckStatus::Skipped,
                expected: None,
                observed: None,
                evidence: error.evidence,
                message: Some(format!("设备未提供可读取的启动槽位: {}", error.message)),
            }
        }
    } else {
        CheckReport {
            status: CheckStatus::TimedOut,
            expected,
            observed: None,
            evidence: None,
            message: Some("等待读取启动槽位时超时".into()),
        }
    }
}

fn check_program(
    device: &crate::adb::AdbDevice,
    program: ProgramCheckRequest,
    deadline: Instant,
) -> CheckReport {
    let path = shell_quote(&program.executable_path);
    let script = format!(
        r#"for p in /proc/[0-9]*/exe; do t=$(readlink "$p" 2>/dev/null) || continue; case "$t" in {path}|{path}\ \(deleted\)) d=$(sha256sum "$p" 2>/dev/null) || continue; printf '%s %s\n' "${{p#/proc/}}" "${{d%% *}}"; exit 0;; esac; done; printf 'NONE\n'; exit 0"#
    );
    let expected = program.expected_sha256.to_ascii_lowercase();
    let mut last_mismatch = None;
    let mut last_error = None;
    loop {
        match run_shell(device, &script, deadline) {
            Ok(output) => {
                if let Some((pid, observed_hash)) = parse_running_program(&output) {
                    if running_hash_matches(&observed_hash, &expected) {
                        return CheckReport {
                            status: CheckStatus::Passed,
                            expected: Some(expected),
                            observed: Some(observed_hash.clone()),
                            evidence: Some(format!(
                                "运行进程 PID {pid} 的 /proc/{pid}/exe SHA-256={observed_hash}"
                            )),
                            message: Some("指定程序正在运行且内容哈希符合预期".into()),
                        };
                    }
                    last_mismatch = Some((pid, observed_hash));
                }
            }
            Err(error) if error.timed_out => last_error = Some(error),
            Err(error) => last_error = Some(error),
        }
        if Instant::now() >= deadline {
            return if let Some((pid, hash)) = last_mismatch {
                CheckReport {
                    status: CheckStatus::Failed,
                    expected: Some(expected),
                    observed: Some(hash.clone()),
                    evidence: Some(format!(
                        "运行进程 PID {pid} 的 /proc/{pid}/exe SHA-256={hash}"
                    )),
                    message: Some("超时前检测到运行程序哈希与预期不符".into()),
                }
            } else {
                last_error
                    .map(|error| command_failure(expected.clone(), error))
                    .unwrap_or(CheckReport {
                        status: CheckStatus::TimedOut,
                        expected: Some(expected),
                        observed: None,
                        evidence: None,
                        message: Some("超时前未检测到指定程序运行".into()),
                    })
            };
        }
        thread::sleep(
            Duration::from_millis(1_000).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn command_failure(expected: String, error: CommandFailure) -> CheckReport {
    CheckReport {
        status: if error.timed_out {
            CheckStatus::TimedOut
        } else {
            CheckStatus::Failed
        },
        expected: Some(expected),
        observed: None,
        evidence: error.evidence,
        message: Some(error.message),
    }
}

fn resolve_device_bounded(selector: &str, deadline: Instant) -> Result<AdbDevice, String> {
    let mut command = adb_command();
    command.args(["devices", "-l"]);
    let output = run_bounded(command, deadline).map_err(|error| error.message)?;
    select_device(parse_devices(&output), selector)
}

fn run_bounded(mut command: Command, deadline: Instant) -> Result<String, CommandFailure> {
    if Instant::now() >= deadline {
        return Err(CommandFailure {
            timed_out: true,
            evidence: None,
            message: "ADB 检查超时".into(),
        });
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CommandFailure {
            timed_out: false,
            evidence: None,
            message: format!("启动 adb 命令失败: {error}"),
        })?;
    wait_child(&mut child, deadline)
}

struct CommandFailure {
    timed_out: bool,
    evidence: Option<String>,
    message: String,
}

fn run_shell(
    device: &crate::adb::AdbDevice,
    script: &str,
    deadline: Instant,
) -> Result<String, CommandFailure> {
    if Instant::now() >= deadline {
        return Err(CommandFailure {
            timed_out: true,
            evidence: None,
            message: "启动核验超时".into(),
        });
    }
    let mut child = device
        .command()
        .args(["shell", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CommandFailure {
            timed_out: false,
            evidence: None,
            message: format!("启动 ADB shell 失败: {error}"),
        })?;
    wait_child(&mut child, deadline)
}

fn wait_child(child: &mut Child, deadline: Instant) -> Result<String, CommandFailure> {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let status = child.wait().map_err(|error| CommandFailure {
                    timed_out: false,
                    evidence: None,
                    message: format!("等待 ADB shell 结束失败: {error}"),
                })?;
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut stream) = child.stdout.take() {
                    stream
                        .read_to_end(&mut stdout)
                        .map_err(|error| CommandFailure {
                            timed_out: false,
                            evidence: None,
                            message: format!("读取 ADB shell 输出失败: {error}"),
                        })?;
                }
                if let Some(mut stream) = child.stderr.take() {
                    stream
                        .read_to_end(&mut stderr)
                        .map_err(|error| CommandFailure {
                            timed_out: false,
                            evidence: None,
                            message: format!("读取 ADB shell 错误输出失败: {error}"),
                        })?;
                }
                let stdout = String::from_utf8_lossy(&stdout).trim().to_owned();
                return if status.success() {
                    Ok(stdout)
                } else {
                    Err(CommandFailure {
                        timed_out: false,
                        evidence: Some(format!(
                            "exit={:?}; stderr={}",
                            status.code(),
                            String::from_utf8_lossy(&stderr).trim()
                        )),
                        message: "设备未能提供所需启动核验证据".into(),
                    })
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CommandFailure {
                    timed_out: true,
                    evidence: None,
                    message: "启动核验超时".into(),
                });
            }
            Err(error) => {
                return Err(CommandFailure {
                    timed_out: false,
                    evidence: None,
                    message: format!("等待 ADB shell 失败: {error}"),
                })
            }
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mounted_root_slot_mismatch_is_reported_with_evidence() {
        let report = parse_slot_report("slot=b\nsource=mounted_root:rootfsB\n", Some("_a"));
        assert!(matches!(report.status, CheckStatus::Failed));
        assert_eq!(report.expected.as_deref(), Some("a"));
        assert_eq!(report.observed.as_deref(), Some("b"));
        assert_eq!(report.evidence.as_deref(), Some("mounted_root:rootfsB"));
    }

    #[test]
    fn running_process_sha256_is_compared_to_expected() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let parsed = parse_running_program(&format!("123/exe {hash}\n")).unwrap();
        assert_eq!(parsed.0, "123");
        assert_eq!(parsed.1, hash);
        assert!(running_hash_matches(&parsed.1, hash));
        assert!(!running_hash_matches(
            &parsed.1,
            "f123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(parse_running_program("NONE\n").is_none());
    }
}
