use super::*;

#[cfg(unix)]
use crate::log_capture::{LogCapturePolicy, LogCaptureSettings};
#[cfg(unix)]
use std::path::PathBuf;

#[test]
fn adb_log_command_leaves_terminal_mode_automatic() {
    let mut command = std::process::Command::new("adb");
    command.args(["-t", "383"]);
    let adb = adb_log_command(command, "-leading-option");
    let args = adb.as_std().get_args().collect::<Vec<_>>();
    assert_eq!(
        args,
        ["-t", "383", "shell", "--", "-leading-option"]
    );
}

#[test]
fn accepts_device_command_and_common_adb_prefixes() {
    assert_eq!(
        device_command("  tail -f '/tmp/my log' ").unwrap(),
        "tail -f '/tmp/my log'"
    );
    assert_eq!(device_command("adb   shell  dmesg -w").unwrap(), "dmesg -w");
    assert_eq!(
        device_command("adb logcat -s MyApp").unwrap(),
        "logcat -s MyApp"
    );
    assert_eq!(device_command("adb logcat").unwrap(), "logcat");
    assert!(device_command("adb shell   ").is_err());
    assert!(device_command("adb devices").is_err());
    assert!(device_command(" ").is_err());
}

#[cfg(unix)]
fn mock_child(script: &str) -> Child {
    Command::new("sh")
        .args(["-c", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

#[cfg(unix)]
struct TestDirectory(PathBuf);

#[cfg(unix)]
impl TestDirectory {
    fn new() -> Self {
        let sequence = LOG_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "openix-adb-capture-{}-{}-{sequence}",
            std::process::id(),
            epoch_ms()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

#[cfg(unix)]
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streams_both_outputs_and_preserves_tail_before_exit() {
    let child = mock_child("printf 'normal\\n'; printf 'diagnostic\\n' >&2; printf 'tail'; exit 7");
    let (_signal, stop) = watch::channel(None);
    let directory = TestDirectory::new();
    let path = directory.0.join("adb.log");
    let policy = LogCapturePolicy::with_settings(LogCaptureSettings::default());
    let writer = CaptureWriter::new(policy, path.clone()).unwrap();
    let mut events = Vec::new();
    let error = collect(child, writer, stop, |stream, _, bytes| {
        events.push((stream, bytes.to_vec()));
    })
    .await
    .unwrap_err();
    assert!(error.contains("7"), "{error}");
    let stdout = events
        .iter()
        .filter(|(stream, _)| matches!(stream, Stream::Stdout))
        .flat_map(|(_, bytes)| bytes.iter().copied())
        .collect::<Vec<_>>();
    assert_eq!(stdout, b"normal\ntail");
    assert!(events
        .iter()
        .any(|(stream, bytes)| { matches!(stream, Stream::Stderr) && bytes == b"diagnostic\n" }));
    let log = std::fs::read_to_string(path).unwrap();
    assert!(log.contains("] normal\n"));
    assert!(log.contains("] [stderr] diagnostic\n"));
    assert!(log.contains("] tail\n"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captures_keyword_context_without_creating_continuous_file() {
    let child = mock_child("printf 'before\\nError line\\nafter\\noutside\\n'");
    let (_signal, stop) = watch::channel(None);
    let directory = TestDirectory::new();
    let path = directory.0.join("adb.log");
    let policy = LogCapturePolicy::with_settings(LogCaptureSettings {
        save_continuous: false,
        keywords: vec!["error".to_string()],
        before_lines: 1,
        after_lines: 1,
        ..LogCaptureSettings::default()
    });
    let writer = CaptureWriter::new(policy, path.clone()).unwrap();
    let mut events = Vec::new();
    collect(child, writer, stop, |_, _, data| {
        events.extend_from_slice(data)
    })
    .await
    .unwrap();
    assert_eq!(events, b"before\nError line\nafter\noutside\n");
    assert!(!path.exists());
    let entries: Vec<_> = std::fs::read_dir(&directory.0).unwrap().collect();
    assert_eq!(entries.len(), 1);
    let entry = entries.into_iter().next().unwrap().unwrap();
    assert!(entry.file_name().to_string_lossy().starts_with("trigger_"));
    let log = std::fs::read_to_string(entry.path()).unwrap();
    assert!(
        log.contains("] before\n") && log.contains("] Error line\n") && log.contains("] after\n")
    );
    assert!(!log.contains("outside"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stops_and_reaps_the_local_process() {
    for reason in [StopReason::Requested, StopReason::AppExit] {
        assert_stops_and_reaps(reason).await;
    }
}

#[cfg(unix)]
async fn assert_stops_and_reaps(reason: StopReason) {
    let child = mock_child("printf 'ready\\n'; exec sleep 60");
    let pid = child.id().unwrap();
    let (signal, stop) = watch::channel(None);
    let directory = TestDirectory::new();
    let path = directory.0.join("adb.log");
    let policy = LogCapturePolicy::with_settings(LogCaptureSettings::default());
    let writer = CaptureWriter::new(policy, path).unwrap();
    let capture = collect(child, writer, stop, |_, _, bytes| {
        assert_eq!(bytes, b"ready\n");
        signal.send_replace(Some(reason));
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), capture)
        .await
        .expect("stop should promptly kill and reap the child")
        .unwrap();
    // 信号 0 只查询这个测试启动的进程是否仍存在。
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    assert_eq!(rc, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
