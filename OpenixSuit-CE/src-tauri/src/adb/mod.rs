use crate::state::AppState;
use adb_client::{ADBDeviceExt, ADBListItemType};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

mod devices;
pub use devices::AdbDevice;
use devices::get_server_device;
pub(crate) use devices::resolve_device;

#[derive(Serialize)]
pub struct AdbFileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub fn adb_list_devices() -> Result<Vec<AdbDevice>, String> {
    devices::list_devices()
}

#[tauri::command]
pub fn adb_list_dir(serial: String, remote_path: String) -> Result<Vec<AdbFileEntry>, String> {
    let mut device = get_server_device(&serial)?;
    let items = device.list(&remote_path).map_err(|e| e.to_string())?;
    let mut entries: Vec<AdbFileEntry> = items
        .into_iter()
        .filter(|item| item.name != "." && item.name != "..")
        .map(|item| AdbFileEntry {
            name: item.name,
            is_dir: matches!(item.item_type, ADBListItemType::Directory),
            size: item.size as u64,
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub fn adb_push_file(serial: String, local_path: String, remote_path: String) -> Result<(), String> {
    push_file_to_device(serial, local_path, remote_path).map(|_| ())
}

pub(crate) fn push_file_to_device(serial: String, local_path: String, remote_path: String) -> Result<String, String> {
    let target = resolve_device(&serial)?;
    let mut device = target.server_device();
    let file = File::open(&local_path).map_err(|e| e.to_string())?;
    device.push(file, &remote_path).map_err(|e| e.to_string())?;
    Ok(target.target().to_owned())
}

#[tauri::command]
pub fn adb_pull_file(serial: String, remote_path: String, local_path: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    let mut file = File::create(&local_path).map_err(|e| e.to_string())?;
    device.pull(&remote_path, &mut file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn adb_exec_shell(serial: String, command: String) -> Result<String, String> {
    let target = resolve_device(&serial)?;
    let mut device = target.server_device();
    let mut out = Vec::new();
    match device.shell_command(&[command.as_str()], &mut out) {
        Ok(()) => Ok(String::from_utf8_lossy(&out).to_string()),
        Err(_) => {
            let output = target
                .command()
                .args(["shell", &command])
                .output()
                .map_err(|e| format!("设备不支持 ShellV2，且本地 adb 回退失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Ok(format!("{}{}", stdout, stderr))
        }
    }
}

#[tauri::command]
pub fn adb_root(serial: String) -> Result<String, String> {
    let output = resolve_device(&serial)?
        .command()
        .arg("root")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("ADB root failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub fn adb_reboot(serial: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    device
        .reboot(adb_client::RebootType::System)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn adb_reboot_efex(serial: String) -> Result<String, String> {
    let target = resolve_device(&serial)?;
    let out = target.command().args(["reboot", "efex"]).output();
    if let Ok(res) = out {
        if res.status.success() {
            return Ok("已发送 adb reboot efex，设备正在重启进入烧录模式".into());
        }
    }
    // 部分全志固件通过 shell 命令进入 efex/fel
    adb_exec_shell(target.target().to_owned(), "reboot efex 2>/dev/null || reboot fel".into())
}

#[tauri::command]
pub fn adb_mkdir(serial: String, remote_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("mkdir -p '{}'", remote_path))
}

#[tauri::command]
pub fn adb_delete(serial: String, remote_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("rm -rf '{}'", remote_path))
}

#[tauri::command]
pub fn adb_rename(serial: String, old_path: String, new_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("mv '{}' '{}'", old_path, new_path))
}

#[tauri::command]
pub fn adb_copy(serial: String, src_path: String, dst_path: String) -> Result<String, String> {
    adb_exec_shell(serial, format!("cp -r '{}' '{}'", src_path, dst_path))
}

#[tauri::command]
pub fn adb_read_text(serial: String, remote_path: String) -> Result<String, String> {
    let mut device = get_server_device(&serial)?;
    let mut buf = Vec::new();
    device.pull(&remote_path, &mut buf).map_err(|e| e.to_string())?;
    if buf.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，不支持在线文本编辑，请下载到本地查看".into());
    }
    let sample = &buf[..buf.len().min(8192)];
    if sample.contains(&0) || std::str::from_utf8(&buf).is_err() {
        return Err("检测到二进制或图片文件，不支持文本编辑，请使用下载功能".into());
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

#[tauri::command]
pub fn adb_write_text(serial: String, remote_path: String, content: String) -> Result<(), String> {
    let mut device = get_server_device(&serial)?;
    let bytes = content.as_bytes();
    let mut cursor = std::io::Cursor::new(bytes);
    let _ = Read::bytes(&mut cursor);
    device
        .push(std::io::Cursor::new(bytes), &remote_path)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct AdbDetailedFileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: String,
    pub modified_time: String,
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if ch != '\r' {
            out.push(ch);
        }
    }
    out
}

fn parse_ls_line(line: &str) -> Option<AdbDetailedFileEntry> {
    let cleaned = strip_ansi_sequences(line);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed.starts_with("total ") {
        return None;
    }
    let first = trimmed.chars().next()?;
    if !matches!(first, '-' | 'd' | 'l' | 'c' | 'b' | 'p' | 's') {
        return None;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.len() < 7 {
        return None;
    }

    let permissions = tokens[0].to_string();
    let mut idx = 4;
    // Skip links/owner/group if possible; device nodes have "major, minor"
    let size = if tokens[idx].ends_with(',') && idx + 1 < tokens.len() {
        idx += 2;
        0
    } else if let Ok(sz) = tokens[idx].parse::<u64>() {
        idx += 1;
        sz
    } else if idx + 1 < tokens.len() && tokens[idx + 1].parse::<u64>().is_ok() {
        let sz = tokens[idx + 1].parse::<u64>().unwrap_or(0);
        idx += 2;
        sz
    } else {
        return None;
    };

    if idx >= tokens.len() {
        return None;
    }

    // Detect date/time format before filename:
    // 1) --full-time: YYYY-MM-DD HH:MM:SS.nnnnnnnnn +ZZZZ (3 tokens)
    // 2) ISO short:   YYYY-MM-DD HH:MM (2 tokens)
    // 3) POSIX:       Mon DD HH:MM or Mon DD YYYY (3 tokens)
    let (modified_time, name_start_idx) = if tokens[idx].len() == 10
        && tokens[idx].chars().nth(4) == Some('-')
        && tokens[idx].chars().nth(7) == Some('-')
    {
        if idx + 3 < tokens.len()
            && (tokens[idx + 2].starts_with('+') || tokens[idx + 2].starts_with('-'))
        {
            let short_time = tokens[idx + 1].split('.').next().unwrap_or(tokens[idx + 1]);
            (format!("{} {}", tokens[idx], short_time), idx + 3)
        } else if idx + 2 < tokens.len() {
            (format!("{} {}", tokens[idx], tokens[idx + 1]), idx + 2)
        } else {
            (String::new(), idx + 1)
        }
    } else if idx + 3 < tokens.len() {
        (
            format!("{} {} {}", tokens[idx], tokens[idx + 1], tokens[idx + 2]),
            idx + 3,
        )
    } else {
        return None;
    };

    if name_start_idx >= tokens.len() {
        return None;
    }

    // Reconstruct name from the original line after the date/time token to preserve spaces
    let raw_name = tokens[name_start_idx..].join(" ");
    let name = if permissions.starts_with('l') {
        raw_name
            .split(" -> ")
            .next()
            .unwrap_or(&raw_name)
            .to_string()
    } else {
        raw_name
    };

    if name == "." || name == ".." || name.is_empty() {
        return None;
    }

    Some(AdbDetailedFileEntry {
        name,
        is_dir: permissions.starts_with('d'),
        size,
        permissions,
        modified_time,
    })
}

#[tauri::command]
pub fn adb_list_dir_detailed(
    serial: String,
    remote_path: String,
) -> Result<Vec<AdbDetailedFileEntry>, String> {
    let fallback_map: HashMap<String, (bool, u64)> = adb_list_dir(serial.clone(), remote_path.clone())
        .map(|items| {
            items
                .into_iter()
                .map(|i| (i.name, (i.is_dir, i.size)))
                .collect()
        })
        .unwrap_or_default();

    let escaped = remote_path.replace('\'', "'\\''");
    let cmd = format!(
        "ls -la --color=never --full-time '{}' 2>/dev/null || ls -la --color=never '{}' 2>/dev/null || ls -la '{}'",
        escaped, escaped, escaped
    );
    let shell_res = adb_exec_shell(serial, cmd);

    let mut entries = Vec::new();
    if let Ok(output) = shell_res {
        for line in output.lines() {
            if let Some(mut entry) = parse_ls_line(line) {
                if let Some(&(fb_dir, fb_size)) = fallback_map.get(&entry.name) {
                    if entry.permissions.starts_with('l') && fb_dir {
                        entry.is_dir = true;
                    }
                    if entry.size == 0 && fb_size > 0 {
                        entry.size = fb_size;
                    }
                }
                entries.push(entry);
            }
        }
    }

    if entries.is_empty() && !fallback_map.is_empty() {
        for (name, (is_dir, size)) in fallback_map {
            entries.push(AdbDetailedFileEntry {
                name,
                is_dir,
                size,
                permissions: if is_dir {
                    "drwxr-xr-x".to_string()
                } else {
                    "-rw-r--r--".to_string()
                },
                modified_time: String::new(),
            });
        }
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[derive(Clone, Serialize)]
pub struct AdbTermDataPayload {
    pub session_id: String,
    pub data: String,
}

pub struct AdbTermHandle {
    pub stop_flag: Arc<AtomicBool>,
    pub child: Arc<Mutex<Child>>,
    #[cfg(unix)]
    pub writer: Arc<Mutex<File>>,
    #[cfg(not(unix))]
    pub writer: Arc<Mutex<std::process::ChildStdin>>,
}

#[tauri::command]
pub fn adb_term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    serial: String,
) -> Result<(), String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("ADB terminal session_id cannot be empty".to_string());
    }
    let mut cmd = resolve_device(&serial)?.command();

    {
        let mut guard = state
            .adb_term_sessions
            .lock()
            .map_err(|_| "ADB terminal lock poisoned".to_string())?;
        if let Some(old) = guard.remove(&sid) {
            old.stop_flag.store(true, Ordering::Relaxed);
            if let Ok(mut ch) = old.child.lock() {
                let _ = ch.kill();
                let _ = ch.wait();
            }
        }
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let sessions_map = Arc::clone(&state.adb_term_sessions);

    #[cfg(unix)]
    {
        let mut master_fd: libc::c_int = -1;
        let mut slave_fd: libc::c_int = -1;
        let mut ws = libc::winsize {
            ws_row: 24,
            ws_col: 80,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let rc = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut ws,
            )
        };
        if rc != 0 {
            return Err(format!(
                "Failed to allocate PTY (openpty): {}",
                std::io::Error::last_os_error()
            ));
        }

        unsafe {
            libc::fcntl(master_fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        let master_file = unsafe { File::from_raw_fd(master_fd) };
        let mut reader_file = master_file
            .try_clone()
            .map_err(|e| format!("Failed to clone PTY master: {}", e))?;

        cmd.arg("shell");
        cmd.env("TERM", "xterm-256color");
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(slave_fd, libc::STDIN_FILENO) == -1
                    || libc::dup2(slave_fd, libc::STDOUT_FILENO) == -1
                    || libc::dup2(slave_fd, libc::STDERR_FILENO) == -1
                {
                    return Err(std::io::Error::last_os_error());
                }
                if slave_fd > libc::STDERR_FILENO {
                    libc::close(slave_fd);
                }
                Ok(())
            });
        }

        let spawn_res = cmd.spawn();
        unsafe {
            libc::close(slave_fd);
        }
        let child = spawn_res.map_err(|e| format!("Failed to spawn adb shell: {}", e))?;

        let handle = Arc::new(AdbTermHandle {
            stop_flag: Arc::clone(&stop_flag),
            child: Arc::new(Mutex::new(child)),
            writer: Arc::new(Mutex::new(master_file)),
        });

        {
            let mut guard = state
                .adb_term_sessions
                .lock()
                .map_err(|_| "ADB terminal lock poisoned".to_string())?;
            guard.insert(sid.clone(), Arc::clone(&handle));
        }

        let sid_thread = sid.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while !stop_flag.load(Ordering::Relaxed) {
                match reader_file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app.emit(
                            "adb-term-data",
                            AdbTermDataPayload {
                                session_id: sid_thread.clone(),
                                data,
                            },
                        );
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if let Ok(mut ch) = handle.child.lock() {
                let _ = ch.try_wait();
            }
            if let Ok(mut guard) = sessions_map.lock() {
                if let Some(current) = guard.get(&sid_thread) {
                    if Arc::ptr_eq(current, &handle) {
                        guard.remove(&sid_thread);
                    }
                }
            }
        });

        Ok(())
    }

    #[cfg(not(unix))]
    {
        cmd.arg("shell");
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn adb shell: {}", e))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open adb shell stdin".to_string())?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let handle = Arc::new(AdbTermHandle {
            stop_flag: Arc::clone(&stop_flag),
            child: Arc::new(Mutex::new(child)),
            writer: Arc::new(Mutex::new(stdin)),
        });

        {
            let mut guard = state
                .adb_term_sessions
                .lock()
                .map_err(|_| "ADB terminal lock poisoned".to_string())?;
            guard.insert(sid.clone(), Arc::clone(&handle));
        }

        if let Some(mut out) = stdout {
            let app_out = app.clone();
            let sid_out = sid.clone();
            let stop_out = Arc::clone(&stop_flag);
            let sessions_out = Arc::clone(&sessions_map);
            let handle_out = Arc::clone(&handle);
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while !stop_out.load(Ordering::Relaxed) {
                    match out.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_out.emit(
                                "adb-term-data",
                                AdbTermDataPayload {
                                    session_id: sid_out.clone(),
                                    data,
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
                if let Ok(mut guard) = sessions_out.lock() {
                    if let Some(current) = guard.get(&sid_out) {
                        if Arc::ptr_eq(current, &handle_out) {
                            guard.remove(&sid_out);
                        }
                    }
                }
            });
        }

        if let Some(mut err_stream) = stderr {
            let app_err = app;
            let sid_err = sid;
            let stop_err = stop_flag;
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while !stop_err.load(Ordering::Relaxed) {
                    match err_stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_err.emit(
                                "adb-term-data",
                                AdbTermDataPayload {
                                    session_id: sid_err.clone(),
                                    data,
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(())
    }
}

#[tauri::command]
pub fn adb_term_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let handle = {
        let guard = state
            .adb_term_sessions
            .lock()
            .map_err(|_| "ADB terminal lock poisoned".to_string())?;
        guard
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("ADB terminal session not found: {}", session_id))?
    };

    let mut writer = handle
        .writer
        .lock()
        .map_err(|_| "ADB terminal writer lock poisoned".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to ADB terminal: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush ADB terminal: {}", e))
}

#[tauri::command]
pub fn adb_term_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle = {
        let guard = state
            .adb_term_sessions
            .lock()
            .map_err(|_| "ADB terminal lock poisoned".to_string())?;
        guard
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("ADB terminal session not found: {}", session_id))?
    };

    #[cfg(unix)]
    {
        let writer = handle
            .writer
            .lock()
            .map_err(|_| "ADB terminal writer lock poisoned".to_string())?;
        let ws = libc::winsize {
            ws_row: rows.max(1),
            ws_col: cols.max(1),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let rc = unsafe { libc::ioctl(writer.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
        if rc != 0 {
            return Err(format!(
                "Failed to resize ADB PTY: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (handle, cols, rows);
    }

    Ok(())
}

#[tauri::command]
pub fn adb_term_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let handle = {
        let mut guard = state
            .adb_term_sessions
            .lock()
            .map_err(|_| "ADB terminal lock poisoned".to_string())?;
        guard
            .remove(&session_id)
            .ok_or_else(|| format!("ADB terminal session not found: {}", session_id))?
    };

    handle.stop_flag.store(true, Ordering::Relaxed);
    if let Ok(mut child) = handle.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[derive(Serialize)]
pub struct AdbScreenInfo {
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn adb_screen_info(serial: String) -> Result<AdbScreenInfo, String> {
    let out = adb_exec_shell(
        serial,
        "wm size 2>/dev/null || cat /sys/class/graphics/fb0/virtual_size 2>/dev/null".to_string(),
    )?;

    let mut override_size: Option<(u32, u32)> = None;
    let mut physical_size: Option<(u32, u32)> = None;

    for line in out.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Override size:") {
            if let Some((w, h)) = rest.trim().split_once('x') {
                if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                    override_size = Some((w, h));
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("Physical size:") {
            if let Some((w, h)) = rest.trim().split_once('x') {
                if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                    physical_size = Some((w, h));
                }
            }
        } else if let Some((w, h)) = trimmed.split_once(',') {
            if let (Ok(w), Ok(h)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) {
                physical_size.get_or_insert((w, h));
            }
        }
    }

    let (width, height) = override_size
        .or(physical_size)
        .ok_or_else(|| format!("Unable to parse screen resolution from: {}", out.trim()))?;

    Ok(AdbScreenInfo { width, height })
}

#[tauri::command]
pub fn adb_screencap_png(serial: String) -> Result<String, String> {
    let output = resolve_device(&serial)?
        .command()
        .args(["exec-out", "screencap", "-p"])
        .output()
        .map_err(|e| format!("Failed to execute adb screencap: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("adb screencap failed: {}", stderr.trim()));
    }
    if output.stdout.len() < 8 || &output.stdout[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("Invalid PNG data returned by adb screencap".to_string());
    }

    let b64 = crate::plugins::base64_encode(&output.stdout);
    Ok(format!("data:image/png;base64,{}", b64))
}

#[tauri::command]
pub fn adb_input_tap(serial: String, x: i32, y: i32) -> Result<(), String> {
    let _ = adb_exec_shell(serial, format!("input tap {} {}", x, y))?;
    Ok(())
}

#[tauri::command]
pub fn adb_input_swipe(
    serial: String,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration_ms: u32,
) -> Result<(), String> {
    let _ = adb_exec_shell(
        serial,
        format!("input swipe {} {} {} {} {}", x1, y1, x2, y2, duration_ms),
    )?;
    Ok(())
}

#[tauri::command]
pub fn adb_input_keyevent(serial: String, keycode: i32) -> Result<(), String> {
    let _ = adb_exec_shell(serial, format!("input keyevent {}", keycode))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_ls_line;

    #[test]
    fn parse_ls_line_strips_ansi_sequences() {
        assert!(parse_ls_line("drwxr-xr-x 18 root root 263 2026-11-16 13:01:48 +0000 \x1b[1;34m.\x1b[m\r").is_none());
        assert!(parse_ls_line("drwxr-xr-x 18 root root 263 2026-11-16 13:01:48 +0000 \x1b[1;34m..\x1b[m\r").is_none());

        let dir = parse_ls_line("drwxr-xr-x 2 root root 812 2026-11-02 02:28:38 +0000 \x1b[1;34mbin\x1b[m\r").unwrap();
        assert_eq!(dir.name, "bin");
        assert!(dir.is_dir);

        let file = parse_ls_line("-rwxrwxr-x 1 root root 13642 2026-11-02 02:28:38 +0000 \x1b[1;32minit\x1b[m\r").unwrap();
        assert_eq!(file.name, "init");
        assert!(!file.is_dir);
        assert_eq!(file.size, 13642);

        let link = parse_ls_line("lrwxrwxrwx 1 root root 4 2026-11-02 02:28:38 +0000 \x1b[1;36mrdinit\x1b[m -> \x1b[1;32minit\x1b[m\r").unwrap();
        assert_eq!(link.name, "rdinit");
    }
}
