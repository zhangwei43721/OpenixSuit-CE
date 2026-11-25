use rquickjs::{Context, Module, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Manifest {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) icon: Option<String>,
    #[serde(default)]
    pub(crate) permissions: Vec<String>,
    #[serde(default)]
    pub(crate) settings: Vec<Field>,
    #[serde(default)]
    pub(crate) actions: Vec<Action>,
    #[serde(default)]
    pub(crate) pages: Vec<Page>,
    #[serde(default)]
    pub(crate) providers: Vec<Provider>,
    #[serde(default)]
    pub(crate) min_app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Field {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(rename = "type")]
    pub(crate) field_type: FieldType,
    #[serde(default)]
    pub(crate) required: bool,
    #[serde(default)]
    pub(crate) default: Option<Value>,
    #[serde(default)]
    pub(crate) options: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FieldType {
    Text,
    File,
    Select,
    Boolean,
    Number,
    Json,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProcessProtocol {
    #[default]
    Ndjson,
    Stdio,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Action {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) inputs: Vec<Field>,
    #[serde(default)]
    pub(crate) output: Option<Vec<Field>>,
    pub(crate) entry: Entry,
    #[serde(default)]
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Entry {
    Javascript {
        file: String,
        #[serde(rename = "export")]
        export_name: String,
    },
    Process {
        #[serde(default)]
        protocol: ProcessProtocol,
        #[serde(default)]
        program: Option<String>,
        #[serde(default)]
        binding: Option<String>,
        #[serde(default)]
        interpreter: Option<String>,
        #[serde(default)]
        interpreter_args: Vec<String>,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        platforms: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Page {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) icon: Option<String>,
    #[serde(default)]
    pub(crate) actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Provider {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) kind: String,
    pub(crate) actions: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) reconnect_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Binding {
    #[serde(default)]
    pub(crate) program: Option<PathBuf>,
    #[serde(default)]
    pub(crate) interpreter: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Installed {
    pub(crate) manifest: Manifest,
    pub(crate) enabled: bool,
    pub(crate) grants: Vec<String>,
    pub(crate) settings: Map<String, Value>,
    pub(crate) bindings: BTreeMap<String, Binding>,
    #[serde(default)]
    pub(crate) source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) struct Config {
    pub(crate) enabled: Option<bool>,
    pub(crate) grants: Option<Vec<String>>,
    pub(crate) settings: Option<Map<String, Value>>,
    pub(crate) bindings: Option<BTreeMap<String, Binding>>,
}

fn root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    let app_dir = home.join(".openixsuit-ce");
    let package_root = app_dir.join("plugins-v2");
    for path in [&app_dir, &package_root] {
        if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!("插件存储路径不能是符号链接: {}", path.display()));
        }
    }
    Ok(package_root)
}
fn state_path() -> Result<PathBuf, String> {
    Ok(root()?.join("installed.json"))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}
fn valid_key(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}
fn read_state() -> Result<BTreeMap<String, Installed>, String> {
    let p = state_path()?;
    match fs::read(&p) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("解析插件状态失败: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("读取插件状态失败: {e}")),
    }
}
fn write_state(state: &BTreeMap<String, Installed>) -> Result<(), String> {
    let p = state_path()?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| format!("创建插件目录失败: {e}"))?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| format!("序列化插件状态失败: {e}"))?;
    atomic_write(&p, &bytes)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("缺少目标父目录")?;
    let tmp = parent.join(format!(".tmp-{}-{}", std::process::id(), rand_suffix()));
    let backup = parent.join(format!(".backup-state-{}", rand_suffix()));
    let result = (|| {
        let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        if path.exists() {
            fs::rename(path, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&tmp, path) {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(error.to_string());
        }
        if backup.exists() {
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("原子写入失败: {e}"))
}
fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn safe_relative(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') {
        return Err(format!("非法包内路径: {raw}"));
    }
    let p = Path::new(raw);
    if p.is_absolute() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("包内路径必须是普通相对路径: {raw}"));
    }
    Ok(p.to_path_buf())
}
pub(crate) fn package_file(dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = safe_relative(relative)?;
    let base = fs::canonicalize(dir).map_err(|e| format!("解析插件目录失败: {e}"))?;
    let candidate = base.join(rel);
    let mut cursor = base.clone();
    for component in candidate
        .strip_prefix(&base)
        .map_err(|_| "插件文件路径越界")?
        .components()
    {
        cursor.push(component);
        if fs::symlink_metadata(&cursor)
            .map_err(|e| format!("检查插件文件路径失败: {e}"))?
            .file_type()
            .is_symlink()
        {
            return Err("插件文件路径包含符号链接".into());
        }
    }
    let resolved =
        fs::canonicalize(&candidate).map_err(|e| format!("插件文件不存在或无法解析: {e}"))?;
    if !resolved.starts_with(&base) || !resolved.is_file() {
        return Err("插件文件路径越界或不是普通文件".into());
    }
    Ok(resolved)
}

fn validate_fields(fields: &[Field], where_: &str) -> Result<(), String> {
    let mut ids = HashSet::new();
    for f in fields {
        if !valid_key(&f.id) || !ids.insert(&f.id) {
            return Err(format!("{where_} 中字段 ID 无效或重复: {}", f.id));
        }
        if f.label.trim().is_empty() {
            return Err(format!("字段 {} 缺少 label", f.id));
        }
        if f.field_type == FieldType::Select && f.options.as_ref().map_or(true, |o| o.is_empty()) {
            return Err(format!("select 字段 {} 必须声明 options", f.id));
        }
        if let Some(d) = &f.default {
            check_value(f, d).map_err(|e| format!("字段 {} 默认值无效: {e}", f.id))?;
        }
    }
    Ok(())
}
fn validate_manifest(m: &Manifest) -> Result<(), String> {
    if !valid_id(&m.id) {
        return Err(format!("插件 ID 无效: {}", m.id));
    }
    if m.name.trim().is_empty() || semver::Version::parse(&m.version).is_err() {
        return Err("插件 name 必须非空且 version 必须符合 SemVer".into());
    }
    if m.min_app_version
        .as_ref()
        .is_some_and(|v| semver::VersionReq::parse(v).is_err())
    {
        return Err("min_app_version 必须符合 SemVer VersionReq".into());
    }
    let allowed: HashSet<&str> = super::PERMISSIONS.iter().copied().collect();
    let mut perms = HashSet::new();
    for p in &m.permissions {
        if !allowed.contains(p.as_str()) || !perms.insert(p) {
            return Err(format!("未知或重复权限: {p}"));
        }
    }
    validate_fields(&m.settings, "settings")?;
    let mut action_ids = HashSet::new();
    for a in &m.actions {
        if !valid_key(&a.id) || !action_ids.insert(&a.id) {
            return Err(format!("action ID 无效或重复: {}", a.id));
        }
        if a.label.trim().is_empty() || a.timeout_ms == Some(0) {
            return Err(format!("action {} 标签为空或 timeout_ms 为 0", a.id));
        }
        validate_fields(&a.inputs, &format!("action {} inputs", a.id))?;
        if let Some(out) = &a.output {
            validate_fields(out, &format!("action {} output", a.id))?;
        }
        match &a.entry {
            Entry::Javascript { file, export_name } => {
                safe_relative(file)?;
                if export_name.trim().is_empty() {
                    return Err(format!("action {} 缺少 export", a.id));
                }
            }
            Entry::Process {
                program,
                binding,
                interpreter,
                platforms,
                ..
            } => {
                if !m.permissions.iter().any(|p| p == "process.execute") {
                    return Err(format!(
                        "process action {} 必须声明 process.execute 权限",
                        a.id
                    ));
                }
                if program.is_none() && binding.is_none() && platforms.is_empty() {
                    return Err(format!("process action {} 未声明程序入口", a.id));
                }
                if let Some(p) = program {
                    safe_relative(p)?;
                }
                if let Some(i) = interpreter {
                    safe_relative(i)?;
                }
                for p in platforms.values() {
                    safe_relative(p)?;
                }
                if binding.as_ref().is_some_and(|b| !valid_key(b)) {
                    return Err(format!("process action {} 的 binding ID 无效", a.id));
                }
            }
        }
    }
    let mut ids = HashSet::new();
    for p in &m.pages {
        if !valid_key(&p.id) || !ids.insert(&p.id) {
            return Err(format!("page ID 无效或重复: {}", p.id));
        }
        for a in &p.actions {
            if !action_ids.contains(a) {
                return Err(format!("page {} 引用未知 action {a}", p.id));
            }
        }
    }
    let mut provider_ids = HashSet::new();
    for p in &m.providers {
        if !valid_key(&p.id)
            || !provider_ids.insert(&p.id)
            || !matches!(p.kind.as_str(), "log" | "device" | "power")
            || p.actions.is_empty()
        {
            return Err(format!("provider {} 定义无效", p.id));
        }
        for a in p.actions.values() {
            if !action_ids.contains(a) {
                return Err(format!("provider {} 引用未知 action {a}", p.id));
            }
        }
        if p.kind == "log" && !p.actions.contains_key("connect") {
            return Err(format!("log provider {} 必须定义 connect", p.id));
        }
    }
    Ok(())
}
fn validate_javascript(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    let runtime = Runtime::new().map_err(|e| format!("创建 JavaScript 检查器失败: {e}"))?;
    let context =
        Context::full(&runtime).map_err(|e| format!("创建 JavaScript 检查上下文失败: {e}"))?;
    context.with(|ctx| {
        for action in &manifest.actions {
            let Entry::Javascript { file, .. } = &action.entry else {
                continue;
            };
            let path = package_file(dir, file)?;
            let source = fs::read_to_string(&path)
                .map_err(|e| format!("读取 JavaScript {} 失败: {e}", path.display()))?;
            Module::declare(ctx.clone(), file.as_str(), source.as_str())
                .map(|_| ())
                .map_err(|e| format!("JavaScript action {} 语法错误: {e}", action.id))?;
        }
        Ok::<(), String>(())
    })
}
pub(crate) fn validate(source: &Path) -> Result<Manifest, String> {
    if fs::symlink_metadata(source)
        .map_err(|e| format!("检查插件来源失败: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("插件来源不能是符号链接".into());
    }
    let temporary = !source.is_dir();
    let dir = if temporary {
        extract_to_temp(source)?
    } else {
        source.to_path_buf()
    };
    let result = (|| {
        let p = package_file(&dir, "manifest.json")?;
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.len() > MAX_MANIFEST_BYTES {
            return Err("manifest.json 超出大小限制".into());
        }
        let m: Manifest = serde_json::from_slice(&fs::read(p).map_err(|e| e.to_string())?)
            .map_err(|e| format!("解析 manifest.json 失败: {e}"))?;
        validate_manifest(&m)?;
        validate_javascript(&dir, &m)?;
        Ok(m)
    })();
    if temporary {
        let _ = fs::remove_dir_all(dir);
    }
    result
}

fn copy_tree(src: &Path, dst: &Path, total: &mut u64) -> Result<(), String> {
    for e in fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        let ft = e.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            return Err(format!("插件包禁止符号链接: {}", p.display()));
        }
        let to = dst.join(e.file_name());
        if ft.is_dir() {
            fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            copy_tree(&p, &to, total)?;
        } else if ft.is_file() {
            *total = total.saturating_add(ft_size(&p)?);
            if *total > MAX_PACKAGE_BYTES {
                return Err("插件包超过 512 MiB".into());
            }
            fs::copy(&p, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn tree_fingerprint(root: &Path) -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};
    fn add(root: &Path, dir: &Path, hash: &mut Sha256) -> Result<(), String> {
        let mut entries = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .map(|entry| entry.map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err(format!("插件包禁止符号链接: {}", path.display()));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy();
            hash.update(relative.as_bytes());
            hash.update([0]);
            if kind.is_dir() {
                hash.update([b'd']);
                add(root, &path, hash)?;
            } else if kind.is_file() {
                hash.update([b'f']);
                let mut file = File::open(&path).map_err(|e| e.to_string())?;
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    let count =
                        std::io::Read::read(&mut file, &mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    hash.update(&buffer[..count]);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    hash.update(
                        (fs::metadata(path)
                            .map_err(|e| e.to_string())?
                            .permissions()
                            .mode()
                            & 0o777)
                            .to_le_bytes(),
                    );
                }
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    add(root, root, &mut hash)?;
    Ok(hash.finalize().into())
}
fn ft_size(p: &Path) -> Result<u64, String> {
    Ok(fs::metadata(p).map_err(|e| e.to_string())?.len())
}
fn options_for_file(path: &Path, options: SimpleFileOptions) -> Result<SimpleFileOptions, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o777;
        Ok(options.unix_permissions(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(options)
    }
}
fn create_stage() -> Result<PathBuf, String> {
    let r = root()?;
    fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    let p = r.join(format!(".stage-{}-{}", std::process::id(), rand_suffix()));
    fs::create_dir(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn extract_to_temp(source: &Path) -> Result<PathBuf, String> {
    if fs::metadata(source)
        .map_err(|e| format!("读取插件包大小失败: {e}"))?
        .len()
        > MAX_PACKAGE_BYTES
    {
        return Err("插件压缩文件超过 512 MiB".into());
    }
    let mut z = ZipArchive::new(File::open(source).map_err(|e| format!("打开插件包失败: {e}"))?)
        .map_err(|e| format!("解析插件压缩包失败: {e}"))?;
    if z.len() > MAX_PACKAGE_ENTRIES {
        return Err("插件包文件数量超过 20000 项".into());
    }
    let stage = create_stage()?;
    let res = (|| {
        let mut total = 0u64;
        let mut root_manifest = false;
        let mut top_level = HashSet::new();
        for i in 0..z.len() {
            let entry = z.by_index(i).map_err(|e| e.to_string())?;
            let rel = entry.enclosed_name().ok_or("插件包含非法路径")?;
            if rel == Path::new("manifest.json") {
                root_manifest = true;
                break;
            }
            if let Some(Component::Normal(first)) = rel.components().next() {
                top_level.insert(first.to_string_lossy().into_owned());
            }
        }
        let strip_prefix = if !root_manifest && top_level.len() == 1 {
            let prefix = top_level.iter().next().unwrap();
            let manifest_name = format!("{prefix}/manifest.json");
            if z.by_name(&manifest_name).is_ok() {
                Some(PathBuf::from(prefix))
            } else {
                None
            }
        } else {
            None
        };
        if !root_manifest && strip_prefix.is_none() {
            return Err("插件包缺少根目录 manifest.json".into());
        }
        for i in 0..z.len() {
            let mut ent = z.by_index(i).map_err(|e| e.to_string())?;
            if ent.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
                return Err("插件包禁止符号链接".to_string());
            }
            let enclosed = ent.enclosed_name().ok_or("插件包含非法路径")?.to_path_buf();
            if !enclosed
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            {
                return Err("插件包含非法路径".into());
            }
            let rel = if let Some(prefix) = &strip_prefix {
                match enclosed.strip_prefix(prefix) {
                    Ok(p) => p.to_path_buf(),
                    Err(_) => continue,
                }
            } else {
                enclosed
            };
            let out = stage.join(rel);
            if ent.is_dir() {
                fs::create_dir_all(out).map_err(|e| e.to_string())?;
                continue;
            }
            total = total.saturating_add(ent.size());
            if total > MAX_PACKAGE_BYTES {
                return Err("插件包超过 512 MiB".into());
            }
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = File::create(out).map_err(|e| e.to_string())?;
            std::io::copy(&mut ent, &mut f).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = ent.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                f.set_permissions(fs::Permissions::from_mode(mode & 0o777))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    if let Err(e) = res {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    }
    Ok(stage)
}
pub(crate) fn pack(source: &Path, destination: &Path) -> Result<Manifest, String> {
    let m = validate(source)?;
    let base = fs::canonicalize(source).map_err(|e| format!("解析插件目录失败: {e}"))?;
    let dest_parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let dest_resolved = fs::canonicalize(dest_parent)
        .map_err(|e| format!("解析插件包输出目录失败: {e}"))?
        .join(destination.file_name().ok_or("插件包输出路径缺少文件名")?);
    if dest_resolved.starts_with(&base) {
        return Err("插件包输出文件不能位于源目录内部".into());
    }
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("创建插件包目录失败: {e}"))?;
    let temp = parent.join(format!(".oixplugin-{}.tmp", rand_suffix()));
    let mut out = File::create(&temp).map_err(|e| format!("创建插件包失败: {e}"))?;
    let mut zip = ZipWriter::new(&mut out);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    fn add(
        dir: &Path,
        base: &Path,
        zip: &mut ZipWriter<&mut File>,
        options: SimpleFileOptions,
        sum: &mut u64,
    ) -> Result<(), String> {
        for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let p = e.path();
            let ty = e.file_type().map_err(|e| e.to_string())?;
            if ty.is_symlink() {
                return Err(format!("禁止打包符号链接: {}", p.display()));
            }
            let rel = p
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if ty.is_dir() {
                zip.add_directory(format!("{rel}/"), options)
                    .map_err(|e| e.to_string())?;
                add(&p, base, zip, options, sum)?;
            } else if ty.is_file() {
                *sum = sum.saturating_add(ft_size(&p)?);
                if *sum > MAX_PACKAGE_BYTES {
                    return Err("插件包超过 512 MiB".into());
                }
                zip.start_file(rel, options_for_file(&p, options)?)
                    .map_err(|e| e.to_string())?;
                let mut f = File::open(p).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    let mut sum = 0;
    if let Err(e) = add(source, source, &mut zip, options, &mut sum) {
        drop(zip);
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    zip.finish().map_err(|e| format!("完成插件打包失败: {e}"))?;
    out.sync_all().map_err(|e| format!("同步插件包失败: {e}"))?;
    drop(out);
    if let Err(e) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(&temp);
        return Err(format!("发布插件包失败: {e}"));
    }
    Ok(m)
}

pub(crate) fn list() -> Result<Vec<Installed>, String> {
    Ok(read_state()?.into_values().collect())
}
pub(crate) fn get(id: &str) -> Result<Installed, String> {
    if !valid_id(id) {
        return Err("插件 ID 无效".into());
    }
    read_state()?
        .remove(id)
        .ok_or_else(|| format!("插件不存在: {id}"))
}
pub(crate) fn package_dir(id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("插件 ID 无效".into());
    }
    let p = root()?.join(id);
    if !p.is_dir() {
        return Err(format!("插件包不存在: {id}"));
    }
    Ok(p)
}

pub(crate) fn install(source: &Path, origin: Option<String>) -> Result<Installed, String> {
    if fs::symlink_metadata(source)
        .map_err(|e| format!("检查插件来源失败: {e}"))?
        .file_type()
        .is_symlink()
    {
        return Err("插件来源不能是符号链接".into());
    }
    let stage = if source.is_dir() {
        create_stage()?
    } else {
        extract_to_temp(source)?
    };
    let result = (|| {
        let mut total = 0;
        if source.is_dir() {
            copy_tree(source, &stage, &mut total)?;
        }
        let m = validate(&stage)?;
        let state = read_state()?;
        let previous = state.get(&m.id).cloned();
        let target = root()?.join(&m.id);
        let mut entry = if let Some(mut old) = previous.clone() {
            let oldv = semver::Version::parse(&old.manifest.version).map_err(|e| e.to_string())?;
            let newv = semver::Version::parse(&m.version).map_err(|e| e.to_string())?;
            if newv < oldv {
                return Err("不允许安装较旧版本插件".into());
            }
            let expanded = m
                .permissions
                .iter()
                .any(|p| !old.manifest.permissions.contains(p));
            let version_changed = old.manifest.version != m.version;
            let package_changed = if target.is_dir() {
                tree_fingerprint(&target)? != tree_fingerprint(&stage)?
            } else {
                true
            };
            let process_declared = m
                .actions
                .iter()
                .any(|a| matches!(&a.entry, Entry::Process { .. }));
            old.manifest = m.clone();
            old.grants.retain(|g| m.permissions.contains(g));
            if version_changed || package_changed || expanded {
                old.grants.retain(|g| g != "process.execute");
            }
            if process_declared && (version_changed || package_changed || expanded) {
                old.enabled = false;
            }
            old.source = origin.clone();
            old
        } else {
            Installed {
                manifest: m.clone(),
                enabled: false,
                grants: vec![],
                settings: Map::new(),
                bindings: BTreeMap::new(),
                source: origin.clone(),
            }
        };
        entry.settings = normalize_saved_values(&entry.manifest.settings, entry.settings)?;
        let mut staged = state.clone();
        staged.insert(m.id.clone(), entry.clone());
        let backup = root()?.join(format!(".backup-{}-{}", m.id, rand_suffix()));
        if target.exists() {
            fs::rename(&target, &backup).map_err(|e| format!("备份现有插件失败: {e}"))?;
        }
        if let Err(e) = fs::rename(&stage, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(format!("安装插件目录失败: {e}"));
        }
        if let Err(e) = write_state(&staged) {
            let _ = fs::remove_dir_all(&target);
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(e);
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(entry)
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

pub(crate) fn configure(id: &str, config: Config) -> Result<Installed, String> {
    let mut state = read_state()?;
    let mut item = state
        .remove(id)
        .ok_or_else(|| format!("插件不存在: {id}"))?;
    if let Some(en) = config.enabled {
        item.enabled = en;
    }
    if let Some(grants) = config.grants {
        let declared: HashSet<_> = item
            .manifest
            .permissions
            .iter()
            .map(String::as_str)
            .collect();
        if grants.iter().any(|g| !declared.contains(g.as_str())) {
            return Err("授权包含插件未声明的权限".into());
        }
        item.grants = grants;
    }
    if let Some(settings) = config.settings {
        item.settings = validate_values(&item.manifest.settings, settings)?;
    }
    if let Some(bindings) = config.bindings {
        for (k, v) in &bindings {
            if !valid_key(k) {
                return Err(format!("binding ID 无效: {k}"));
            }
            for p in [&v.program, &v.interpreter].into_iter().flatten() {
                if !p.is_absolute() {
                    return Err("本机程序和解释器路径必须是绝对路径".into());
                }
            }
        }
        item.bindings = bindings;
    }
    state.insert(id.to_string(), item.clone());
    write_state(&state)?;
    Ok(item)
}
pub(crate) fn uninstall(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("插件 ID 无效".into());
    }
    let mut s = read_state()?;
    if s.remove(id).is_none() {
        return Err(format!("插件不存在: {id}"));
    }
    let p = root()?.join(id);
    let backup = root()?.join(format!(".remove-{}-{}", id, rand_suffix()));
    if p.exists() {
        fs::rename(&p, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(e) = write_state(&s) {
        if backup.exists() {
            let _ = fs::rename(backup, p);
        }
        return Err(e);
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn check_value(field: &Field, v: &Value) -> Result<(), String> {
    let ok = match field.field_type {
        FieldType::Text | FieldType::File => v.is_string(),
        FieldType::Select => v.as_str().is_some_and(|s| {
            field
                .options
                .as_ref()
                .is_some_and(|o| o.iter().any(|x| x == s))
        }),
        FieldType::Boolean => v.is_boolean(),
        FieldType::Number => v.is_number(),
        FieldType::Json => true,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("值类型与 {:?} 不匹配", field.field_type))
    }
}
fn normalize_saved_values(
    fields: &[Field],
    mut values: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let known: HashSet<_> = fields.iter().map(|field| field.id.as_str()).collect();
    values.retain(|key, _| known.contains(key.as_str()));
    for field in fields {
        if !values.contains_key(&field.id) {
            if let Some(default) = &field.default {
                values.insert(field.id.clone(), default.clone());
            }
        }
        if let Some(value) = values.get(&field.id) {
            check_value(field, value).map_err(|e| format!("字段 {}: {e}", field.id))?;
        }
    }
    Ok(values)
}
pub(crate) fn validate_values(
    fields: &[Field],
    mut input: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let known: HashSet<_> = fields.iter().map(|f| f.id.as_str()).collect();
    if let Some(k) = input.keys().find(|k| !known.contains(k.as_str())) {
        return Err(format!("未知设置字段: {k}"));
    }
    for f in fields {
        if !input.contains_key(&f.id) {
            if let Some(d) = &f.default {
                input.insert(f.id.clone(), d.clone());
            } else if f.required {
                return Err(format!("缺少必填字段: {}", f.id));
            }
        }
        if let Some(v) = input.get(&f.id) {
            check_value(f, v).map_err(|e| format!("字段 {}: {e}", f.id))?;
        }
    }
    Ok(input)
}

pub(crate) struct GithubPackage {
    pub(crate) id: String,
    path: PathBuf,
    origin: String,
}

impl GithubPackage {
    pub(crate) fn install(self) -> Result<Installed, String> {
        install(&self.path, Some(self.origin.clone()))
    }
}

impl Drop for GithubPackage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) async fn stage_github(
    repo: &str,
    expected_id: Option<&str>,
) -> Result<GithubPackage, String> {
    let repo = repo.strip_prefix("github:").unwrap_or(repo);
    let repo = repo.split_once('@').map_or(repo, |(name, _)| name);
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if parts.next().is_some() || !valid_key(owner) || !valid_key(name) {
        return Err("GitHub 仓库格式应为 owner/repo".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("OpenixSuit-CE plugin manager")
        .build()
        .map_err(|e| e.to_string())?;
    let api = format!("https://api.github.com/repos/{owner}/{name}/releases/latest");
    let release: Value = client
        .get(api)
        .send()
        .await
        .map_err(|e| format!("读取 GitHub 发布信息失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub 发布信息请求失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 发布信息失败: {e}"))?;
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("GitHub release 缺少 tag_name")?;
    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("GitHub release 没有 assets")?;
    let asset = assets
        .iter()
        .find(|a| {
            a.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.ends_with(".oixplugin"))
        })
        .ok_or("GitHub latest release 没有 .oixplugin 文件")?;
    let url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .ok_or("release asset 缺少下载地址")?;
    let download_url =
        reqwest::Url::parse(url).map_err(|e| format!("release asset 地址无效: {e}"))?;
    if download_url.scheme() != "https" || download_url.host_str() != Some("github.com") {
        return Err("release asset 必须使用 GitHub HTTPS 下载地址".into());
    }
    let asset_id = asset
        .get("id")
        .and_then(Value::as_u64)
        .ok_or("release asset 缺少固定 ID")?;
    let mut response = client
        .get(format!(
            "https://api.github.com/repos/{owner}/{name}/releases/assets/{asset_id}"
        ))
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("下载插件失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("插件下载请求失败: {e}"))?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PACKAGE_BYTES)
    {
        return Err("GitHub 插件超过 512 MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取插件下载内容失败: {e}"))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_PACKAGE_BYTES {
            return Err("GitHub 插件超过 512 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let tmp = root()?.join(format!(".github-{}.oixplugin", rand_suffix()));
    fs::create_dir_all(root()?).map_err(|e| e.to_string())?;
    if let Err(error) = fs::write(&tmp, &bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    let manifest = match validate(&tmp) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }
    };
    if expected_id.is_some_and(|id| id != manifest.id) {
        let _ = fs::remove_file(&tmp);
        return Err("下载插件 ID 与预期 ID 不符".into());
    }
    Ok(GithubPackage {
        id: manifest.id,
        path: tmp,
        origin: format!("github:{owner}/{name}@{tag}#asset={asset_id}"),
    })
}
