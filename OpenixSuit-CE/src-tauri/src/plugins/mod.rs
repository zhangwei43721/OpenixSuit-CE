use crate::adb;
use crate::efex;
use crate::state::{emit_ai_sync, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

const MAX_PLUGIN_EXTRACT_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginInputType {
    File,
    Text,
    Select,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInput {
    #[serde(alias = "name", alias = "key")]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "type")]
    pub input_type: PluginInputType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub filters: Vec<String>,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssertOp {
    Eq,
    Neq,
    Contains,
    NotEmpty,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BoolOrVar {
    Bool(bool),
    Expr(String),
}

impl Default for BoolOrVar {
    fn default() -> Self {
        Self::Bool(true)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StringListOrVar {
    List(Vec<String>),
    Expr(String),
}

impl Default for StringListOrVar {
    fn default() -> Self {
        Self::List(Vec::new())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum U64OrVar {
    Num(u64),
    Expr(String),
}

fn default_flash_mode() -> String {
    "full_erase".to_string()
}

fn default_post_action() -> String {
    "reboot".to_string()
}

fn default_raw_mode() -> String {
    "logic-offset".to_string()
}

fn default_raw_storage() -> String {
    "sdmmc".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum StepAction {
    #[serde(rename = "log")]
    Log {
        #[serde(alias = "text")]
        message: String,
    },
    #[serde(rename = "assert")]
    Assert {
        left: String,
        op: AssertOp,
        #[serde(default)]
        right: String,
        #[serde(default)]
        message: String,
    },
    #[serde(rename = "adb.root")]
    AdbRoot,
    #[serde(rename = "adb.reboot")]
    AdbReboot,
    #[serde(rename = "adb.reboot_efex")]
    AdbRebootEfex,
    #[serde(rename = "adb.shell")]
    AdbShell {
        command: String,
        #[serde(default)]
        save_as: Option<String>,
    },
    #[serde(rename = "adb.push")]
    AdbPush {
        local_path: String,
        remote_path: String,
    },
    #[serde(rename = "adb.pull")]
    AdbPull {
        remote_path: String,
        local_path: String,
    },
    #[serde(rename = "efex.flash")]
    EfexFlash {
        firmware_path: String,
        #[serde(default = "default_flash_mode")]
        mode: String,
        #[serde(default)]
        partitions: StringListOrVar,
        #[serde(default)]
        verify: BoolOrVar,
        #[serde(default = "default_post_action")]
        post_action: String,
    },
    #[serde(rename = "efex.raw")]
    EfexRaw {
        boot_firmware: String,
        raw_image: String,
        #[serde(default = "default_raw_mode")]
        mode: String,
        #[serde(default = "default_raw_storage")]
        storage: String,
        #[serde(default)]
        logic_offset: Option<U64OrVar>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginStep {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub when: Option<String>,
    #[serde(flatten)]
    pub action: StepAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginTab {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub inputs: Vec<PluginInput>,
    #[serde(default)]
    pub steps: Vec<PluginStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub inputs: Vec<PluginInput>,
    #[serde(default)]
    pub steps: Vec<PluginStep>,
    #[serde(default)]
    pub tabs: Vec<PluginTab>,
}

#[derive(Clone, Serialize)]
pub struct PluginLogPayload {
    pub plugin_id: String,
    pub line: String,
}

pub fn plugins_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(home.join(".openixsuit-ce").join("plugins"))
}

pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("插件 ID 不能为空".to_string());
    }
    if id.starts_with('.') || id.contains("..") {
        return Err(format!("非法的插件 ID: {}", id));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "插件 ID 只能包含字母、数字、'-'、'_' 或 '.': {}",
            id
        ));
    }
    Ok(())
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => v.to_string(),
    }
}

pub fn interpolate(template: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        if let Some(end) = after_open.find("}}") {
            let key = after_open[..end].trim();
            if let Some(val) = vars.get(key) {
                out.push_str(val);
            }
            rest = &after_open[end + 2..];
        } else {
            out.push_str(&rest[start..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn strip_matching_quotes(s: &str) -> &str {
    let trimmed = s.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

#[derive(Clone, Copy)]
enum WhenOp {
    Neq,
    Eq,
    Contains,
}

fn find_when_op(expr: &str) -> Option<(&str, WhenOp, &str)> {
    let bytes = expr.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if b == b'"' || b == b'\'' {
            quote = Some(b);
            i += 1;
            continue;
        }
        if expr[i..].starts_with("!=") {
            return Some((&expr[..i], WhenOp::Neq, &expr[i + 2..]));
        }
        if expr[i..].starts_with("==") {
            return Some((&expr[..i], WhenOp::Eq, &expr[i + 2..]));
        }
        if expr[i..].starts_with(" contains ") {
            return Some((&expr[..i], WhenOp::Contains, &expr[i + " contains ".len()..]));
        }
        i += 1;
    }
    None
}

fn eval_when(expr: &str, vars: &HashMap<String, String>) -> bool {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return true;
    }

    let eval_side = |raw: &str| -> String {
        let unquoted = strip_matching_quotes(raw);
        let interpolated = interpolate(unquoted, vars);
        strip_matching_quotes(&interpolated).to_string()
    };

    if let Some((lhs, op, rhs)) = find_when_op(trimmed) {
        let l = eval_side(lhs);
        let r = eval_side(rhs);
        return match op {
            WhenOp::Neq => l != r,
            WhenOp::Eq => l == r,
            WhenOp::Contains => l.contains(&r),
        };
    }

    let val = eval_side(trimmed);
    !val.is_empty() && !val.eq_ignore_ascii_case("false") && val != "0"
}

fn resolve_plugin_path(plugin_dir: &Path, raw: &str) -> Result<PathBuf, String> {
    if let Some(rel) = raw.strip_prefix("plugin://") {
        let trimmed = rel.trim_start_matches('/');
        if trimmed.is_empty() {
            return Err("plugin:// 路径不能为空".to_string());
        }
        let rel_path = Path::new(trimmed);
        let mut clean = PathBuf::new();
        for comp in rel_path.components() {
            match comp {
                Component::Normal(seg) => clean.push(seg),
                Component::CurDir => {}
                _ => {
                    return Err(format!("非法的插件相对路径: {}", raw));
                }
            }
        }
        if clean.as_os_str().is_empty() {
            return Err(format!("非法的插件相对路径: {}", raw));
        }
        Ok(plugin_dir.join(clean))
    } else {
        Ok(PathBuf::from(raw))
    }
}

fn resolve_bool_or_var(val: &BoolOrVar, vars: &HashMap<String, String>) -> Result<bool, String> {
    match val {
        BoolOrVar::Bool(b) => Ok(*b),
        BoolOrVar::Expr(expr) => {
            let s = interpolate(expr, vars).trim().to_ascii_lowercase();
            match s.as_str() {
                "true" | "1" | "yes" => Ok(true),
                "false" | "0" | "no" | "" => Ok(false),
                _ => Err(format!("无法将 '{}' 解析为布尔值", s)),
            }
        }
    }
}

fn resolve_string_list_or_var(
    val: &StringListOrVar,
    vars: &HashMap<String, String>,
) -> Result<Vec<String>, String> {
    match val {
        StringListOrVar::List(items) => Ok(items
            .iter()
            .map(|item| interpolate(item, vars).trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()),
        StringListOrVar::Expr(expr) => {
            let s = interpolate(expr, vars);
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Ok(Vec::new());
            }
            if trimmed.starts_with('[') {
                serde_json::from_str::<Vec<String>>(trimmed)
                    .map_err(|e| format!("解析分区列表 JSON 失败: {}", e))
            } else {
                Ok(trimmed
                    .split(',')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect())
            }
        }
    }
}

fn resolve_u64_or_var(
    val: &Option<U64OrVar>,
    vars: &HashMap<String, String>,
) -> Result<Option<u64>, String> {
    match val {
        None => Ok(None),
        Some(U64OrVar::Num(n)) => Ok(Some(*n)),
        Some(U64OrVar::Expr(expr)) => {
            let s = interpolate(expr, vars);
            let trimmed = s.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
                return Ok(None);
            }
            let parsed = if let Some(hex) = trimmed
                .strip_prefix("0x")
                .or_else(|| trimmed.strip_prefix("0X"))
            {
                u64::from_str_radix(hex, 16)
            } else {
                trimmed.parse::<u64>()
            }
            .map_err(|e| format!("解析数字 '{}' 失败: {}", trimmed, e))?;
            Ok(Some(parsed))
        }
    }
}

fn detect_archive_strip_prefix(archive: &mut ZipArchive<File>) -> Result<Option<PathBuf>, String> {
    let mut has_root_manifest = false;
    let mut top_dirs: Vec<String> = Vec::new();

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩包条目失败: {}", e))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("检测到非法压缩包路径 (Zip-Slip): {}", entry.name()))?;
        if enclosed == Path::new("manifest.json") {
            has_root_manifest = true;
            break;
        }
        if let Some(Component::Normal(first)) = enclosed.components().next() {
            let name = first.to_string_lossy().to_string();
            if !top_dirs.contains(&name) {
                top_dirs.push(name);
            }
        }
    }

    if has_root_manifest {
        return Ok(None);
    }
    if top_dirs.len() == 1 {
        let candidate = PathBuf::from(&top_dirs[0]).join("manifest.json");
        let candidate_str = candidate.to_string_lossy().replace('\\', "/");
        if archive.by_name(&candidate_str).is_ok() {
            return Ok(Some(PathBuf::from(&top_dirs[0])));
        }
    }

    Err("插件包缺少 manifest.json".to_string())
}

fn validate_manifest(manifest: &PluginManifest) -> Result<(), String> {
    validate_plugin_id(&manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err("插件 manifest.json 缺少 name 字段".to_string());
    }
    if manifest.version.trim().is_empty() {
        return Err("插件 manifest.json 缺少 version 字段".to_string());
    }
    Ok(())
}

const MAX_ICON_FILE_BYTES: u64 = 256 * 1024;

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn icon_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("svg") => Some("image/svg+xml"),
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

fn resolve_icon_for_frontend(plugin_dir: &Path, raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("data:image/") {
        return Some(trimmed.to_string());
    }

    let is_plugin_file = trimmed.starts_with("plugin://")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || icon_mime_type(Path::new(trimmed)).is_some();

    if !is_plugin_file {
        return Some(trimmed.to_string());
    }

    let candidate_expr = if trimmed.starts_with("plugin://") {
        trimmed.to_string()
    } else {
        format!("plugin://{}", trimmed.trim_start_matches("./"))
    };
    let resolved = resolve_plugin_path(plugin_dir, &candidate_expr).ok()?;
    let mime = icon_mime_type(&resolved)?;
    let meta = fs::metadata(&resolved).ok()?;
    if !meta.is_file() || meta.len() > MAX_ICON_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(&resolved).ok()?;
    Some(format!("data:{};base64,{}", mime, base64_encode(&bytes)))
}

fn resolve_manifest_icons(plugin_dir: &Path, manifest: &mut PluginManifest) {
    manifest.icon = resolve_icon_for_frontend(plugin_dir, manifest.icon.as_deref());
    for tab in &mut manifest.tabs {
        tab.icon = resolve_icon_for_frontend(plugin_dir, tab.icon.as_deref());
    }
}

fn load_manifest_from_dir(dir: &Path) -> Result<PluginManifest, String> {
    let manifest_path = dir.join("manifest.json");
    let raw = fs::read(&manifest_path)
        .map_err(|e| format!("读取插件清单 {} 失败: {}", manifest_path.display(), e))?;
    let mut manifest: PluginManifest = serde_json::from_slice(&raw)
        .map_err(|e| format!("解析插件清单 {} 失败: {}", manifest_path.display(), e))?;
    validate_manifest(&manifest)?;
    resolve_manifest_icons(dir, &mut manifest);
    Ok(manifest)
}

#[tauri::command]
pub fn list_plugins() -> Result<Vec<PluginManifest>, String> {
    let dir = plugins_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("读取插件目录 {} 失败: {}", dir.display(), e))?;
    let mut manifests = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }
        if !path.join("manifest.json").exists() {
            continue;
        }
        match load_manifest_from_dir(&path) {
            Ok(m) => manifests.push(m),
            Err(e) => eprintln!("[plugins] 跳过无效插件 {}: {}", path.display(), e),
        }
    }

    manifests.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(manifests)
}

fn copy_dir_safe(src: &Path, dst: &Path, total_written: &mut u64) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录 {} 失败: {}", dst.display(), e))?;
    let entries = fs::read_dir(src).map_err(|e| format!("读取目录 {} 失败: {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("遍历目录失败: {}", e))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型 {} 失败: {}", path.display(), e))?;
        if file_type.is_symlink() {
            return Err(format!("禁止包含符号链接: {}", path.display()));
        }
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_safe(&path, &target, total_written)?;
        } else if file_type.is_file() {
            let len = entry
                .metadata()
                .map_err(|e| format!("读取文件大小 {} 失败: {}", path.display(), e))?
                .len();
            *total_written = total_written.saturating_add(len);
            if *total_written > MAX_PLUGIN_EXTRACT_BYTES {
                return Err("插件目录体积超出安全上限 (512MB)".to_string());
            }
            fs::copy(&path, &target)
                .map_err(|e| format!("复制文件 {} 失败: {}", path.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn install_plugin(package_path: String) -> Result<PluginManifest, String> {
    let pkg = Path::new(&package_path);
    if !pkg.exists() {
        return Err(format!("插件路径不存在: {}", package_path));
    }

    let root = plugins_dir()?;
    fs::create_dir_all(&root)
        .map_err(|e| format!("创建插件目录 {} 失败: {}", root.display(), e))?;

    if pkg.is_dir() {
        let mut manifest = load_manifest_from_dir(pkg)?;
        let staging_dir = root.join(format!(".staging-{}-{}", manifest.id, std::process::id()));
        if staging_dir.exists() {
            let _ = fs::remove_dir_all(&staging_dir);
        }
        let mut total_written = 0u64;
        if let Err(err) = copy_dir_safe(pkg, &staging_dir, &mut total_written) {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(err);
        }
        let target_dir = root.join(&manifest.id);
        if target_dir.exists() {
            fs::remove_dir_all(&target_dir)
                .map_err(|e| format!("清理旧版本插件 {} 失败: {}", target_dir.display(), e))?;
        }
        if let Err(e) = fs::rename(&staging_dir, &target_dir) {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(format!("安装插件到 {} 失败: {}", target_dir.display(), e));
        }
        resolve_manifest_icons(&target_dir, &mut manifest);
        return Ok(manifest);
    }

    if !pkg.is_file() {
        return Err(format!("插件包文件或目录无效: {}", package_path));
    }

    if let Some(ext) = pkg.extension().and_then(|e| e.to_str()) {
        let lower = ext.to_ascii_lowercase();
        if lower != "oixplugin" && lower != "zip" {
            return Err(format!(
                "不支持的插件包格式 '.{}'，仅支持 .oixplugin、.zip 或插件源码目录",
                ext
            ));
        }
    }

    let file = File::open(pkg).map_err(|e| format!("打开插件包失败: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("解析插件压缩包失败: {}", e))?;

    let strip_prefix = detect_archive_strip_prefix(&mut archive)?;
    let manifest_entry_name = match &strip_prefix {
        Some(prefix) => format!("{}/manifest.json", prefix.to_string_lossy().replace('\\', "/")),
        None => "manifest.json".to_string(),
    };

    let mut manifest: PluginManifest = {
        let mut mf = archive
            .by_name(&manifest_entry_name)
            .map_err(|e| format!("读取 {} 失败: {}", manifest_entry_name, e))?;
        let mut buf = Vec::new();
        mf.read_to_end(&mut buf)
            .map_err(|e| format!("读取 manifest.json 内容失败: {}", e))?;
        serde_json::from_slice(&buf)
            .map_err(|e| format!("解析 manifest.json 失败: {}", e))?
    };
    validate_manifest(&manifest)?;

    let staging_dir = root.join(format!(".staging-{}-{}", manifest.id, std::process::id()));
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("创建临时解压目录失败: {}", e))?;

    let extract_res = (|| -> Result<(), String> {
        let mut total_written: u64 = 0;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("读取压缩包条目失败: {}", e))?;

            if entry
                .unix_mode()
                .map(|m| (m & 0o170000) == 0o120000)
                .unwrap_or(false)
            {
                return Err(format!("禁止包含符号链接: {}", entry.name()));
            }

            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| format!("检测到非法压缩包路径 (Zip-Slip): {}", entry.name()))?
                .to_path_buf();

            let rel_path = match &strip_prefix {
                Some(prefix) => match enclosed.strip_prefix(prefix) {
                    Ok(p) => p.to_path_buf(),
                    Err(_) => continue,
                },
                None => enclosed,
            };

            if rel_path.as_os_str().is_empty() {
                continue;
            }
            if !rel_path
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            {
                return Err(format!("检测到非法相对路径: {}", rel_path.display()));
            }

            let dest_path = staging_dir.join(&rel_path);
            if !dest_path.starts_with(&staging_dir) {
                return Err(format!("路径越界 (Zip-Slip): {}", rel_path.display()));
            }

            if entry.is_dir() {
                fs::create_dir_all(&dest_path)
                    .map_err(|e| format!("创建目录 {} 失败: {}", dest_path.display(), e))?;
            } else {
                if let Some(parent) = dest_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("创建父目录 {} 失败: {}", parent.display(), e))?;
                }
                total_written = total_written.saturating_add(entry.size());
                if total_written > MAX_PLUGIN_EXTRACT_BYTES {
                    return Err("插件解压体积超出安全上限 (512MB)".to_string());
                }
                let mut out_file = File::create(&dest_path)
                    .map_err(|e| format!("创建文件 {} 失败: {}", dest_path.display(), e))?;
                io::copy(&mut entry, &mut out_file)
                    .map_err(|e| format!("写入文件 {} 失败: {}", dest_path.display(), e))?;
            }
        }
        Ok(())
    })();

    if let Err(err) = extract_res {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    let target_dir = root.join(&manifest.id);
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir)
            .map_err(|e| format!("清理旧版本插件 {} 失败: {}", target_dir.display(), e))?;
    }
    if let Err(e) = fs::rename(&staging_dir, &target_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!("安装插件到 {} 失败: {}", target_dir.display(), e));
    }

    resolve_manifest_icons(&target_dir, &mut manifest);
    Ok(manifest)
}

#[tauri::command]
pub fn uninstall_plugin(plugin_id: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    let target = plugins_dir()?.join(&plugin_id);
    if !target.exists() {
        return Err(format!("插件不存在: {}", plugin_id));
    }
    fs::remove_dir_all(&target).map_err(|e| format!("卸载插件 {} 失败: {}", plugin_id, e))
}

fn emit_plugin_log(
    app: &AppHandle,
    plugin_id: &str,
    logs: &mut Vec<String>,
    line: impl Into<String>,
) {
    let line = line.into();
    logs.push(line.clone());
    let _ = app.emit(
        "plugin-log",
        PluginLogPayload {
            plugin_id: plugin_id.to_string(),
            line,
        },
    );
}

fn build_initial_vars_for(
    plugin_id: &str,
    input_specs: &[PluginInput],
    plugin_dir: &Path,
    serial: &str,
    inputs: &Map<String, Value>,
) -> Result<HashMap<String, String>, String> {
    let mut vars = HashMap::new();
    vars.insert("serial".to_string(), serial.to_string());
    vars.insert("plugin_id".to_string(), plugin_id.to_string());
    vars.insert(
        "plugin_dir".to_string(),
        plugin_dir.to_string_lossy().to_string(),
    );

    for (k, v) in inputs {
        if !v.is_null() {
            vars.insert(k.clone(), value_to_string(v));
        }
    }

    for spec in input_specs {
        let val = match inputs.get(&spec.id) {
            Some(v) if !v.is_null() => value_to_string(v),
            _ => match &spec.default {
                Some(def) if !def.is_null() => value_to_string(def),
                _ => String::new(),
            },
        };

        if spec.required && val.trim().is_empty() {
            let label = if spec.label.is_empty() {
                &spec.id
            } else {
                &spec.label
            };
            return Err(format!("缺少必填参数: {} ({})", label, spec.id));
        }

        if spec.input_type == PluginInputType::Select
            && !spec.options.is_empty()
            && !val.trim().is_empty()
            && !spec.options.iter().any(|opt| opt == &val)
        {
            return Err(format!(
                "参数 '{}' 的值 '{}' 不在可选项 {:?} 中",
                spec.id, val, spec.options
            ));
        }

        vars.insert(spec.id.clone(), val);
    }

    Ok(vars)
}

pub async fn execute_plugin_with_handle(
    app: &AppHandle,
    state: &AppState,
    source: &str,
    plugin_id: String,
    tab_id: Option<String>,
    serial: String,
    inputs: Map<String, Value>,
) -> Result<Vec<String>, String> {
    validate_plugin_id(&plugin_id)?;
    let plugin_dir = plugins_dir()?.join(&plugin_id);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装: {}", plugin_id));
    }
    let manifest = load_manifest_from_dir(&plugin_dir)?;
    let _busy = state.try_acquire_busy(&format!("plugin:{}", plugin_id))?;

    let (active_label, active_inputs, active_steps) = if let Some(tid) = tab_id.as_deref() {
        if let Some(tab) = manifest.tabs.iter().find(|t| t.id == tid) {
            (tab.label.clone(), &tab.inputs, &tab.steps)
        } else {
            return Err(format!("插件 {} 中不存在选项卡: {}", plugin_id, tid));
        }
    } else if !manifest.tabs.is_empty() && manifest.steps.is_empty() {
        let tab = &manifest.tabs[0];
        (tab.label.clone(), &tab.inputs, &tab.steps)
    } else {
        (manifest.name.clone(), &manifest.inputs, &manifest.steps)
    };

    let mut vars = build_initial_vars_for(&manifest.id, active_inputs, &plugin_dir, &serial, &inputs)?;
    let mut logs = Vec::new();

    emit_ai_sync(
        app,
        source,
        "plugin-run",
        "started",
        format!("Running plugin {} ({})", active_label, plugin_id),
    );
    emit_plugin_log(
        app,
        &plugin_id,
        &mut logs,
        format!(
            "[plugin] 启动 {} v{} (steps={})",
            active_label,
            manifest.version,
            active_steps.len()
        ),
    );

    let result: Result<(), String> = async {
        for (idx, step) in active_steps.iter().enumerate() {
            let step_tag = step
                .name
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("step-{}", idx + 1));

            if let Some(when_expr) = &step.when {
                if !eval_when(when_expr, &vars) {
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] 跳过 (when: {})", step_tag, when_expr),
                    );
                    continue;
                }
            }

            match &step.action {
                StepAction::Log { message } => {
                    let rendered = interpolate(message, &vars);
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] {}", step_tag, rendered),
                    );
                }
                StepAction::Assert {
                    left,
                    op,
                    right,
                    message,
                } => {
                    let l_val = interpolate(left, &vars);
                    let r_val = interpolate(right, &vars);
                    let passed = match op {
                        AssertOp::Eq => l_val == r_val,
                        AssertOp::Neq => l_val != r_val,
                        AssertOp::Contains => l_val.contains(&r_val),
                        AssertOp::NotEmpty => !l_val.trim().is_empty(),
                    };
                    if !passed {
                        let err_msg = interpolate(message, &vars);
                        let final_msg = if err_msg.trim().is_empty() {
                            format!(
                                "断言失败 [{}]: '{}' {:?} '{}'",
                                step_tag, l_val, op, r_val
                            )
                        } else {
                            err_msg
                        };
                        return Err(final_msg);
                    }
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] 断言通过", step_tag),
                    );
                }
                StepAction::AdbRoot => {
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] 执行 adb root", step_tag),
                    );
                    let s = serial.clone();
                    let out = tokio::task::spawn_blocking(move || adb::adb_root(s))
                        .await
                        .map_err(|e| format!("任务异常: {}", e))??;
                    if !out.trim().is_empty() {
                        emit_plugin_log(
                            app,
                            &plugin_id,
                            &mut logs,
                            format!("[{}] {}", step_tag, out.trim()),
                        );
                    }
                }
                StepAction::AdbReboot => {
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] 执行 adb reboot", step_tag),
                    );
                    let s = serial.clone();
                    tokio::task::spawn_blocking(move || adb::adb_reboot(s))
                        .await
                        .map_err(|e| format!("任务异常: {}", e))??;
                }
                StepAction::AdbRebootEfex => {
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] 执行 adb reboot efex", step_tag),
                    );
                    let s = serial.clone();
                    let msg = tokio::task::spawn_blocking(move || adb::adb_reboot_efex(s))
                        .await
                        .map_err(|e| format!("任务异常: {}", e))??;
                    if !msg.trim().is_empty() {
                        emit_plugin_log(
                            app,
                            &plugin_id,
                            &mut logs,
                            format!("[{}] {}", step_tag, msg.trim()),
                        );
                    }
                }
                StepAction::AdbShell { command, save_as } => {
                    let cmd = interpolate(command, &vars);
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] adb shell: {}", step_tag, cmd),
                    );
                    let s = serial.clone();
                    let out = tokio::task::spawn_blocking(move || adb::adb_exec_shell(s, cmd))
                        .await
                        .map_err(|e| format!("任务异常: {}", e))??;
                    let trimmed = out.trim().to_string();
                    if let Some(var_name) = save_as.as_deref().filter(|v| !v.trim().is_empty()) {
                        vars.insert(var_name.trim().to_string(), trimmed.clone());
                    }
                    if !trimmed.is_empty() {
                        emit_plugin_log(
                            app,
                            &plugin_id,
                            &mut logs,
                            format!("[{}] 输出: {}", step_tag, trimmed),
                        );
                    }
                }
                StepAction::AdbPush {
                    local_path,
                    remote_path,
                } => {
                    let raw_local = interpolate(local_path, &vars);
                    let resolved_local = resolve_plugin_path(&plugin_dir, &raw_local)?;
                    let local_str = resolved_local.to_string_lossy().to_string();
                    let remote_str = interpolate(remote_path, &vars);
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] adb push {} -> {}", step_tag, local_str, remote_str),
                    );
                    let s = serial.clone();
                    let l = local_str;
                    let r = remote_str;
                    tokio::task::spawn_blocking(move || adb::adb_push_file(s, l, r))
                        .await
                        .map_err(|e| format!("任务异常: {}", e))??;
                }
                StepAction::AdbPull {
                    remote_path,
                    local_path,
                } => {
                    let remote_str = interpolate(remote_path, &vars);
                    let local_str = interpolate(local_path, &vars);
                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!("[{}] adb pull {} -> {}", step_tag, remote_str, local_str),
                    );
                    let s = serial.clone();
                    let r = remote_str;
                    let l = local_str;
                    tokio::task::spawn_blocking(move || adb::adb_pull_file(s, r, l))
                        .await
                        .map_err(|e| format!("任务异常: {}", e))??;
                }
                StepAction::EfexFlash {
                    firmware_path,
                    mode,
                    partitions,
                    verify,
                    post_action,
                } => {
                    let raw_fw = interpolate(firmware_path, &vars);
                    let fw_path = resolve_plugin_path(&plugin_dir, &raw_fw)?
                        .to_string_lossy()
                        .to_string();
                    let mode_val = interpolate(mode, &vars);
                    let parts = resolve_string_list_or_var(partitions, &vars)?;
                    let verify_val = resolve_bool_or_var(verify, &vars)?;
                    let post_val = interpolate(post_action, &vars);

                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!(
                            "[{}] efex flash {} (mode={}, post={})",
                            step_tag, fw_path, mode_val, post_val
                        ),
                    );
                    efex::run_flash_firmware_full_unlocked(
                        app,
                        state,
                        source,
                        fw_path,
                        mode_val,
                        parts,
                        verify_val,
                        post_val,
                        None,
                        None,
                    )
                    .await?;
                }
                StepAction::EfexRaw {
                    boot_firmware,
                    raw_image,
                    mode,
                    storage,
                    logic_offset,
                } => {
                    let raw_boot = interpolate(boot_firmware, &vars);
                    let boot_path = resolve_plugin_path(&plugin_dir, &raw_boot)?
                        .to_string_lossy()
                        .to_string();
                    let raw_img = interpolate(raw_image, &vars);
                    let img_path = resolve_plugin_path(&plugin_dir, &raw_img)?
                        .to_string_lossy()
                        .to_string();
                    let mode_val = interpolate(mode, &vars);
                    let storage_val = interpolate(storage, &vars);
                    let offset_val = resolve_u64_or_var(logic_offset, &vars)?;

                    emit_plugin_log(
                        app,
                        &plugin_id,
                        &mut logs,
                        format!(
                            "[{}] efex raw {} (mode={}, storage={})",
                            step_tag, img_path, mode_val, storage_val
                        ),
                    );
                    efex::run_raw_flash_image_unlocked(
                        app,
                        state,
                        source,
                        boot_path,
                        img_path,
                        mode_val,
                        storage_val,
                        offset_val,
                        None,
                        None,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            emit_plugin_log(
                app,
                &plugin_id,
                &mut logs,
                format!("[plugin] {} 执行完成", manifest.name),
            );
            emit_ai_sync(
                app,
                source,
                "plugin-run",
                "completed",
                format!("Plugin {} completed", plugin_id),
            );
            Ok(logs)
        }
        Err(err) => {
            emit_plugin_log(
                app,
                &plugin_id,
                &mut logs,
                format!("[plugin] 执行失败: {}", err),
            );
            emit_ai_sync(app, source, "plugin-run", "error", err.clone());
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn run_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    tab_id: Option<String>,
    serial: String,
    inputs: Map<String, Value>,
) -> Result<Vec<String>, String> {
    execute_plugin_with_handle(&app, &state, "gui", plugin_id, tab_id, serial, inputs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interpolate() {
        let mut vars = HashMap::new();
        vars.insert("slot".to_string(), "_a".to_string());
        vars.insert("part".to_string(), "boot".to_string());
        assert_eq!(
            interpolate("/dev/block/{{ part }}{{slot}}", &vars),
            "/dev/block/boot_a"
        );
        assert_eq!(interpolate("{{missing}}ok", &vars), "ok");
    }

    #[test]
    fn test_eval_when() {
        let mut vars = HashMap::new();
        vars.insert("slot".to_string(), "_a".to_string());
        vars.insert("flag".to_string(), "true".to_string());
        vars.insert("msg".to_string(), "a == b".to_string());

        assert!(eval_when("{{slot}} == _a", &vars));
        assert!(eval_when("{{slot}} == \"_a\"", &vars));
        assert!(!eval_when("{{slot}} != '_a'", &vars));
        assert!(eval_when("{{msg}} contains ==", &vars));
        assert!(eval_when("{{flag}}", &vars));
        assert!(!eval_when("{{empty}}", &vars));
    }

    #[test]
    fn test_validate_plugin_id_and_path() {
        assert!(validate_plugin_id("v881-ab-ota").is_ok());
        assert!(validate_plugin_id("../evil").is_err());
        assert!(validate_plugin_id("a/b").is_err());
        assert!(validate_plugin_id(".hidden").is_err());

        let base = Path::new("/tmp/plugins/demo");
        assert_eq!(
            resolve_plugin_path(base, "plugin://scripts/test.sh").unwrap(),
            PathBuf::from("/tmp/plugins/demo/scripts/test.sh")
        );
        assert!(resolve_plugin_path(base, "plugin://../../etc/passwd").is_err());
    }

    #[test]
    fn test_manifest_deserialization() {
        let json_str = r#"{
            "id": "demo",
            "name": "Demo",
            "version": "1.0.0",
            "description": "Test",
            "inputs": [
                { "id": "fw", "type": "file", "filters": ["img"] },
                { "id": "mode", "type": "select", "options": ["a", "b"] },
                { "id": "flag", "type": "boolean" },
                { "id": "txt", "type": "text" }
            ],
            "steps": [
                { "action": "log", "message": "hi" },
                { "action": "assert", "left": "x", "op": "not_empty" },
                { "action": "adb.root" },
                { "action": "adb.shell", "command": "id", "save_as": "uid" },
                { "action": "adb.push", "local_path": "plugin://a", "remote_path": "/tmp/a" },
                { "action": "adb.pull", "remote_path": "/tmp/a", "local_path": "./a" },
                { "action": "adb.reboot" },
                { "action": "adb.reboot_efex" },
                { "action": "efex.flash", "firmware_path": "{{fw}}", "verify": "{{flag}}" },
                { "action": "efex.raw", "boot_firmware": "{{fw}}", "raw_image": "disk.img", "logic_offset": "0x1000" }
            ]
        }"#;
        let parsed: PluginManifest = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed.inputs.len(), 4);
        assert_eq!(parsed.steps.len(), 10);
    }

    #[test]
    fn test_example_plugin_sources() {
        let plugins_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("plugins");
        for name in ["v881-ab-ota", "v881-app-push"] {
            let plugin_dir = plugins_root.join(name);
            assert!(plugin_dir.join("SKILL.md").is_file(), "{} missing SKILL.md", name);
            assert!(plugin_dir.join("icon.svg").is_file(), "{} missing icon.svg", name);
            let manifest = load_manifest_from_dir(&plugin_dir).unwrap();
            assert!(!manifest.inputs.is_empty());
            assert!(!manifest.steps.is_empty());
            assert!(
                manifest
                    .icon
                    .as_deref()
                    .map(|s| s.starts_with("data:image/svg+xml;base64,"))
                    .unwrap_or(false),
                "{} icon should resolve to SVG data URL",
                name
            );
        }
    }
}
