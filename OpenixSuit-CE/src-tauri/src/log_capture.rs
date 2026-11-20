use crate::state::{app_data_dir, epoch_ms, format_compact_utc, load_json_or_default, AppState};
use regex::{RegexSet, RegexSetBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, State};

const MAX_CONTEXT_LINES: usize = 1000;
const MAX_KEYWORDS: usize = 64;
const MAX_KEYWORD_BYTES: usize = 256;
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct LogCaptureSettings {
    pub(crate) save_continuous: bool,
    pub(crate) keywords: Vec<String>,
    pub(crate) before_lines: usize,
    pub(crate) after_lines: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) directory: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) previous_directories: Vec<String>,
}

impl Default for LogCaptureSettings {
    fn default() -> Self {
        Self {
            save_continuous: true,
            keywords: Vec::new(),
            before_lines: 20,
            after_lines: 20,
            directory: None,
            previous_directories: Vec::new(),
        }
    }
}

struct Rules {
    settings: LogCaptureSettings,
    keywords: Option<RegexSet>,
}

impl Rules {
    fn new(mut settings: LogCaptureSettings) -> Result<Self, String> {
        if settings
            .directory
            .as_deref()
            .is_some_and(|path| !Path::new(path).is_absolute())
        {
            return Err("Log directory must be an absolute path".to_string());
        }
        if settings.before_lines > MAX_CONTEXT_LINES || settings.after_lines > MAX_CONTEXT_LINES {
            return Err(format!(
                "Context must be between 0 and {MAX_CONTEXT_LINES} lines"
            ));
        }
        settings.keywords = settings
            .keywords
            .into_iter()
            .map(|keyword| keyword.trim().to_owned())
            .filter(|keyword| !keyword.is_empty())
            .collect();
        if settings.keywords.len() > MAX_KEYWORDS {
            return Err(format!("At most {MAX_KEYWORDS} keywords are allowed"));
        }
        if settings
            .keywords
            .iter()
            .any(|keyword| keyword.len() > MAX_KEYWORD_BYTES || keyword.contains(['\r', '\n']))
        {
            return Err(format!(
                "Each keyword must fit on one line and use at most {MAX_KEYWORD_BYTES} bytes"
            ));
        }
        let keywords = if settings.keywords.is_empty() {
            None
        } else {
            Some(
                RegexSetBuilder::new(
                    settings
                        .keywords
                        .iter()
                        .map(|keyword| regex::escape(keyword)),
                )
                .case_insensitive(true)
                .build()
                .map_err(|error| format!("Failed to prepare log keywords: {error}"))?,
            )
        };
        Ok(Self { settings, keywords })
    }
}

struct PolicyState {
    rules: RwLock<Arc<Rules>>,
    save_lock: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct LogCapturePolicy(Arc<PolicyState>);

fn settings_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("log-capture-settings.json"))
}

fn default_directory() -> Result<PathBuf, String> {
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or_else(|| "Cannot locate the Documents directory".to_string())?;
    Ok(documents.join("OpenixSuit-CE").join("logs").join("serial"))
}

fn resolve_directory(settings: &LogCaptureSettings, default: &Path) -> PathBuf {
    settings
        .directory
        .as_deref()
        .map_or_else(|| default.to_path_buf(), PathBuf::from)
}

impl LogCapturePolicy {
    pub(crate) fn load() -> Self {
        let rules = settings_path()
            .and_then(|path| load_json_or_default(&path))
            .and_then(Rules::new);
        let rules = rules.unwrap_or_else(|error| {
            eprintln!("Failed to load log capture settings: {error}");
            Rules {
                settings: LogCaptureSettings::default(),
                keywords: None,
            }
        });
        Self::from_rules(rules)
    }

    fn from_rules(rules: Rules) -> Self {
        Self(Arc::new(PolicyState {
            rules: RwLock::new(Arc::new(rules)),
            save_lock: Mutex::new(()),
        }))
    }

    #[cfg(test)]
    pub(crate) fn with_settings(settings: LogCaptureSettings) -> Self {
        Self::from_rules(Rules::new(settings).unwrap())
    }

    fn snapshot(&self) -> Arc<Rules> {
        self.0
            .rules
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(crate) fn logs_directory(&self) -> Result<PathBuf, String> {
        let dir = resolve_directory(&self.snapshot().settings, &default_directory()?);
        create_log_directory(&dir).map_err(|error| {
            format!("Failed to create log directory {}: {error}", dir.display())
        })?;
        Ok(dir)
    }

    pub(crate) fn history_directories(&self) -> Result<Vec<PathBuf>, String> {
        let current = self.snapshot();
        let default = default_directory()?;
        let mut roots = Vec::new();
        let mut identities = std::collections::HashSet::new();
        for root in std::iter::once(resolve_directory(&current.settings, &default))
            .chain(
                current
                    .settings
                    .previous_directories
                    .iter()
                    .map(PathBuf::from),
            )
            .chain(std::iter::once(default))
            .chain(
                app_data_dir()
                    .ok()
                    .map(|dir| dir.join("logs").join("serial")),
            )
        {
            if root.is_absolute()
                && identities.insert(fs::canonicalize(&root).unwrap_or_else(|_| root.clone()))
            {
                roots.push(root);
            }
        }
        Ok(roots)
    }

    fn save(
        &self,
        path: &Path,
        settings: LogCaptureSettings,
        default: &Path,
    ) -> Result<LogCaptureSettings, String> {
        self.save_with(path, default, |_| Ok(settings))
    }

    fn save_with(
        &self,
        path: &Path,
        default: &Path,
        edit: impl FnOnce(&LogCaptureSettings) -> Result<LogCaptureSettings, String>,
    ) -> Result<LogCaptureSettings, String> {
        let _saving = self
            .0
            .save_lock
            .lock()
            .map_err(|_| "Log capture settings lock poisoned".to_string())?;
        let current = self.snapshot();
        let mut settings = edit(&current.settings)?;
        settings.previous_directories = current.settings.previous_directories.clone();
        if settings.directory != current.settings.directory {
            if let Some(previous) = current.settings.directory.as_ref() {
                if !settings.previous_directories.contains(previous) {
                    settings.previous_directories.push(previous.clone());
                }
            }
        }
        let rules = Rules::new(settings)?;
        if rules.settings.directory != current.settings.directory {
            let directory = resolve_directory(&rules.settings, default);
            validate_writable_directory(&directory)?;
        }
        write_settings(path, &rules.settings)?;
        let saved = rules.settings.clone();
        // 文件落盘后再让正在采集的会话看到新规则。
        *self
            .0
            .rules
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Arc::new(rules);
        Ok(saved)
    }
}

fn create_log_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn validate_writable_directory(path: &Path) -> Result<(), String> {
    let verify = || -> io::Result<()> {
        create_log_directory(path)?;
        let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let probe = path.join(format!(".openixsuit-{}-{sequence}.tmp", std::process::id()));
        drop(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&probe)?,
        );
        fs::remove_file(probe)
    };
    verify().map_err(|error| format!("Cannot write to log directory {}: {error}", path.display()))
}

fn write_settings(path: &Path, settings: &LogCaptureSettings) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Missing log capture settings directory".to_string())?;
    let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("{}-{sequence}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| {
            format!(
                "Failed to create log capture settings in {}: {error}",
                parent.display()
            )
        })?;
    let written = file.write_all(&content).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = written.and_then(|_| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(temporary);
        return Err(format!("Failed to save log capture settings: {error}"));
    }
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct LogCaptureReply {
    pub(crate) directory: String,
    pub(crate) default_directory: String,
    pub(crate) settings: LogCaptureSettings,
}

fn capture_reply(settings: LogCaptureSettings, default: &Path) -> LogCaptureReply {
    LogCaptureReply {
        directory: resolve_directory(&settings, default)
            .to_string_lossy()
            .into_owned(),
        default_directory: default.to_string_lossy().into_owned(),
        settings,
    }
}

#[tauri::command]
pub fn log_capture_get(state: State<'_, AppState>) -> Result<LogCaptureReply, String> {
    capture_settings(&state.log_capture)
}

pub(crate) fn capture_settings(policy: &LogCapturePolicy) -> Result<LogCaptureReply, String> {
    Ok(capture_reply(
        policy.snapshot().settings.clone(),
        &default_directory()?,
    ))
}

#[tauri::command]
pub async fn log_capture_save(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: LogCaptureSettings,
) -> Result<LogCaptureReply, String> {
    let policy = state.log_capture.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let default = default_directory()?;
        let settings = policy.save(&settings_path()?, settings, &default)?;
        Ok::<_, String>(capture_reply(settings, &default))
    })
    .await
    .map_err(|error| format!("Failed to save log capture settings: {error}"))??;
    publish_settings(&app, &reply);
    Ok(reply)
}

pub(crate) fn patch_capture_settings(
    app: &AppHandle,
    policy: &LogCapturePolicy,
    patch: Map<String, Value>,
) -> Result<LogCaptureReply, String> {
    let default = default_directory()?;
    let saved = policy.save_with(&settings_path()?, &default, |settings| apply_patch(settings, patch))?;
    let reply = capture_reply(saved, &default);
    publish_settings(app, &reply);
    Ok(reply)
}

fn apply_patch(settings: &LogCaptureSettings, patch: Map<String, Value>) -> Result<LogCaptureSettings, String> {
    let mut current = serde_json::to_value(settings)
        .map_err(|error| error.to_string())?;
    let object = current.as_object_mut().expect("LogCaptureSettings serializes as an object");
    for (key, value) in patch {
        if !matches!(key.as_str(), "save_continuous" | "keywords" | "before_lines" | "after_lines" | "directory") {
            return Err(format!("Unknown log storage setting: {key}"));
        }
        object.insert(key, value);
    }
    serde_json::from_value(current).map_err(|error| format!("Invalid log storage settings: {error}"))
}

fn publish_settings(app: &AppHandle, reply: &LogCaptureReply) {
    let _ = app.emit_to("main", "log-capture-settings-changed", reply);
}

#[cfg(test)]
#[test]
fn log_storage_patch_keeps_other_settings_and_accepts_null_directory() {
    let initial = LogCaptureSettings {
        directory: Some("/existing/logs".into()),
        keywords: vec!["Fault".into()],
        ..LogCaptureSettings::default()
    };
    let patch = serde_json::from_value(serde_json::json!({
        "save_continuous": false, "directory": null,
    })).unwrap();
    let changed = apply_patch(&initial, patch).unwrap();
    assert!(!changed.save_continuous);
    assert!(changed.directory.is_none());
    assert_eq!(changed.keywords, initial.keywords);
    assert_eq!(changed.before_lines, initial.before_lines);
    let invalid = serde_json::from_value(serde_json::json!({ "previous_directories": [] })).unwrap();
    assert!(apply_patch(&initial, invalid).is_err());
}

struct TriggerFile {
    writer: BufWriter<File>,
    end_line: u64,
}

pub(crate) struct CaptureWriter {
    path: PathBuf,
    header: Option<String>,
    policy: LogCapturePolicy,
    rules: Arc<Rules>,
    continuous: Option<BufWriter<File>>,
    trigger: Option<TriggerFile>,
    history: VecDeque<(u64, String)>,
    next_line: u64,
}

impl CaptureWriter {
    pub(crate) fn new(policy: LogCapturePolicy, path: PathBuf) -> Result<Self, String> {
        if path.file_name().is_none() {
            return Err("Missing log file name".to_string());
        }
        Ok(Self {
            rules: policy.snapshot(),
            policy,
            path,
            header: None,
            continuous: None,
            trigger: None,
            history: VecDeque::new(),
            next_line: 0,
        })
    }

    pub(crate) fn with_header(mut self, header: String) -> Self {
        self.header = Some(header);
        self
    }

    pub(crate) fn record_line(&mut self, timestamp: &str, line: &str) -> Result<(), String> {
        let updated = self.refresh_rules();
        if !self.rules.settings.save_continuous
            && self.rules.keywords.is_none()
            && self.rules.settings.before_lines == 0
        {
            return updated;
        }
        let index = self.next_line;
        self.next_line += 1;
        let hit = self
            .rules
            .keywords
            .as_ref()
            .is_some_and(|keywords| keywords.is_match(line));
        let formatted = format!("[{timestamp}] {line}\n");
        let clipped = self.write_trigger_line(index, &formatted, hit);
        let saved = self.write_continuous_line(&formatted);
        let keep = self.rules.settings.before_lines;
        if keep > 0 {
            self.history.push_back((index, formatted));
            self.trim_history();
        }
        updated.and(clipped).and(saved)
    }

    pub(crate) fn flush(&mut self) -> Result<(), String> {
        let continuous = flush_writer(self.continuous.as_mut());
        let triggered = flush_writer(self.trigger.as_mut().map(|file| &mut file.writer));
        continuous.and(triggered)
    }

    fn refresh_rules(&mut self) -> Result<(), String> {
        let next = self.policy.snapshot();
        if Arc::ptr_eq(&next, &self.rules) {
            return Ok(());
        }
        let previous = &self.rules.settings;
        let new = &next.settings;
        let continuous = if !new.save_continuous {
            flush_writer(self.continuous.take().as_mut())
        } else {
            Ok(())
        };
        let triggered = if previous.keywords != new.keywords
            || previous.before_lines != new.before_lines
            || previous.after_lines != new.after_lines
        {
            flush_writer(self.trigger.take().as_mut().map(|file| &mut file.writer))
        } else {
            Ok(())
        };
        self.rules = next;
        self.trim_history();
        continuous.and(triggered)
    }

    fn trim_history(&mut self) {
        while self.history.len() > self.rules.settings.before_lines {
            self.history.pop_front();
        }
    }

    fn write_continuous_line(&mut self, formatted: &str) -> Result<(), String> {
        if !self.rules.settings.save_continuous {
            return Ok(());
        }
        if self.continuous.is_none() {
            let file = OpenOptions::new()
                .append(true)
                .create(true)
                .open(&self.path)
                .map_err(|error| format!("Failed to open log {}: {error}", self.path.display()))?;
            let mut writer = BufWriter::new(file);
            if let Some(header) = self.header.as_ref() {
                if writer.get_ref().metadata().map_err(log_write_error)?.len() == 0 {
                    writeln!(writer, "{header}").map_err(log_write_error)?;
                }
            }
            self.continuous = Some(writer);
        }
        if let Some(writer) = self.continuous.as_mut() {
            writer
                .write_all(formatted.as_bytes())
                .map_err(log_write_error)?;
        }
        Ok(())
    }

    fn write_trigger_line(&mut self, index: u64, formatted: &str, hit: bool) -> Result<(), String> {
        let start = index.saturating_sub(self.rules.settings.before_lines as u64);
        if self
            .trigger
            .as_ref()
            .is_some_and(|trigger| start > trigger.end_line)
        {
            flush_writer(
                self.trigger
                    .take()
                    .as_mut()
                    .map(|trigger| &mut trigger.writer),
            )?;
        }
        if hit {
            let new_end = index + self.rules.settings.after_lines as u64;
            let first_pending_line = match self.trigger.as_mut() {
                Some(trigger) => {
                    // 之前窗口结束后的行在回看队列里，命中重叠窗口时补入文件。
                    let first = trigger.end_line + 1;
                    trigger.end_line = new_end;
                    first
                }
                None => {
                    self.trigger = Some(TriggerFile {
                        writer: Self::open_trigger(&self.path)?,
                        end_line: new_end,
                    });
                    start
                }
            };
            if let Some(trigger) = self.trigger.as_mut() {
                for (_, line) in self
                    .history
                    .iter()
                    .filter(|(line, _)| *line >= first_pending_line)
                {
                    trigger
                        .writer
                        .write_all(line.as_bytes())
                        .map_err(log_write_error)?;
                }
            }
        }
        if let Some(trigger) = self
            .trigger
            .as_mut()
            .filter(|trigger| index <= trigger.end_line)
        {
            trigger
                .writer
                .write_all(formatted.as_bytes())
                .map_err(log_write_error)?;
        }
        Ok(())
    }

    fn open_trigger(path: &Path) -> Result<BufWriter<File>, String> {
        let now = epoch_ms();
        let time = format_compact_utc(now / 1000);
        let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let source: String = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("log")
            .chars()
            .take(40)
            .collect();
        let path = path.with_file_name(format!(
            "trigger_{time}_{:03}_{}_{sequence}_{source}.log",
            now % 1000,
            std::process::id()
        ));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(BufWriter::new)
            .map_err(|error| format!("Failed to create keyword log {}: {error}", path.display()))
    }
}

fn flush_writer(writer: Option<&mut BufWriter<File>>) -> Result<(), String> {
    writer.map_or(Ok(()), |writer| writer.flush().map_err(log_write_error))
}

fn log_write_error(error: io::Error) -> String {
    format!("Failed to write log: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let now = epoch_ms();
            let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "openix-log-capture-{}-{now}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn read_triggers(&self) -> Vec<String> {
            let mut output: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("trigger_")
                })
                .map(|path| fs::read_to_string(path).unwrap())
                .collect();
            output.sort();
            output
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn with_keyword(
        directory: &TestDirectory,
        keyword: &str,
        before: usize,
        after: usize,
    ) -> CaptureWriter {
        CaptureWriter::new(
            LogCapturePolicy::with_settings(LogCaptureSettings {
                save_continuous: false,
                keywords: vec![keyword.to_owned()],
                before_lines: before,
                after_lines: after,
                ..LogCaptureSettings::default()
            }),
            directory.0.join("source.log"),
        )
        .unwrap()
    }

    fn stamped(lines: &[&str]) -> String {
        lines
            .iter()
            .map(|line| format!("[clock] {line}\n"))
            .collect()
    }

    #[test]
    fn saves_a_literal_case_insensitive_context_without_a_continuous_file() {
        let directory = TestDirectory::new();
        let mut writer = with_keyword(&directory, "Ä [failure]", 2, 1);
        let lines = [
            "unrelated",
            "before one",
            "before two",
            "ä [FAILURE]",
            "after",
            "unrelated again",
        ];
        for line in lines {
            writer.record_line("clock", line).unwrap();
        }
        writer.flush().unwrap();
        assert!(!writer.path.exists());
        assert_eq!(directory.read_triggers(), [stamped(&lines[1..5])]);
    }

    #[test]
    fn merges_overlaps_after_the_first_post_window_and_flushes_an_incomplete_window() {
        let directory = TestDirectory::new();
        let mut writer = with_keyword(&directory, "hit", 2, 1);
        let lines = [
            "0",
            "1",
            "hit at 2",
            "3",
            "4",
            "hit at 5",
            "6",
            "7",
            "8",
            "9",
            "hit at 10",
        ];
        for line in lines {
            writer.record_line("clock", line).unwrap();
        }
        writer.flush().unwrap();
        assert_eq!(
            directory.read_triggers(),
            [stamped(&lines[..7]), stamped(&lines[8..]),]
        );
    }

    #[test]
    fn toggles_continuous_storage_on_the_running_writer_and_keeps_the_keyword_window() {
        let directory = TestDirectory::new();
        let path = directory.0.join("bridge.log");
        let settings_file = directory.0.join("settings.json");
        let mut settings = LogCaptureSettings {
            before_lines: 1,
            after_lines: 2,
            keywords: vec!["hit".into()],
            ..LogCaptureSettings::default()
        };
        let policy = LogCapturePolicy::with_settings(settings.clone());
        let mut writer = CaptureWriter::new(policy.clone(), path.clone())
            .unwrap()
            .with_header("A <-> B".into());
        assert!(!path.exists());
        writer.record_line("clock", "normal context").unwrap();
        settings.save_continuous = false;
        policy
            .save(&settings_file, settings.clone(), &directory.0)
            .unwrap();
        writer.record_line("clock", "hit with normal off").unwrap();
        settings.save_continuous = true;
        policy
            .save(&settings_file, settings.clone(), &directory.0)
            .unwrap();
        writer.record_line("clock", "normal resumed").unwrap();
        writer.record_line("clock", "last context line").unwrap();
        writer.flush().unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            format!(
                "A <-> B\n{}",
                stamped(&["normal context", "normal resumed", "last context line"])
            )
        );
        assert_eq!(
            directory.read_triggers(),
            [stamped(&[
                "normal context",
                "hit with normal off",
                "normal resumed",
                "last context line",
            ])]
        );
        assert_eq!(
            load_json_or_default::<LogCaptureSettings>(&settings_file).unwrap(),
            settings
        );
    }

    #[test]
    fn defaults_to_continuous_storage_and_rejects_invalid_settings_without_publishing() {
        let directory = TestDirectory::new();
        let path = directory.0.join("settings.json");
        let defaults: LogCaptureSettings = load_json_or_default(&path).unwrap();
        assert!(defaults.save_continuous);
        assert!(defaults.keywords.is_empty());
        let policy = LogCapturePolicy::with_settings(defaults.clone());
        assert!(policy
            .save(
                &path,
                LogCaptureSettings {
                    before_lines: MAX_CONTEXT_LINES + 1,
                    ..defaults.clone()
                },
                &directory.0,
            )
            .is_err());
        assert!(policy
            .save(
                &directory.0.join("missing/settings.json"),
                LogCaptureSettings {
                    save_continuous: false,
                    ..defaults.clone()
                },
                &directory.0,
            )
            .is_err());
        assert!(!path.exists());
        assert_eq!(policy.snapshot().settings, defaults);
    }

    #[test]
    fn validates_directory_switch_and_keeps_previously_chosen_paths() {
        let directory = TestDirectory::new();
        let settings_file = directory.0.join("settings.json");
        let default = directory.0.join("Documents/OpenixSuit-CE/logs/serial");
        let custom = directory.0.join("自定义 logs");
        let file = directory.0.join("not-a-directory");
        fs::write(&file, b"existing file").unwrap();
        let policy = LogCapturePolicy::with_settings(LogCaptureSettings::default());

        for invalid in [
            "relative/path".to_string(),
            file.to_string_lossy().into_owned(),
        ] {
            let settings = LogCaptureSettings {
                directory: Some(invalid),
                ..Default::default()
            };
            assert!(policy.save(&settings_file, settings, &default).is_err());
        }
        assert!(!settings_file.exists());
        let settings = LogCaptureSettings {
            directory: Some(custom.to_string_lossy().into_owned()),
            ..Default::default()
        };
        policy.save(&settings_file, settings, &default).unwrap();
        assert!(custom.is_dir());
        fs::write(custom.join("same.log"), b"historical log").unwrap();
        let reset = policy
            .save(&settings_file, LogCaptureSettings::default(), &default)
            .unwrap();
        assert_eq!(resolve_directory(&reset, &default), default);
        assert_eq!(reset.previous_directories, [custom.to_string_lossy()]);
        assert_eq!(
            fs::read(custom.join("same.log")).unwrap(),
            b"historical log"
        );
        assert_eq!(
            load_json_or_default::<LogCaptureSettings>(&settings_file).unwrap(),
            reset
        );
    }
}
