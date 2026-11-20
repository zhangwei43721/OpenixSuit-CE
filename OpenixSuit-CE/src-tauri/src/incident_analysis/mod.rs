mod codex;

use crate::state::{app_data_dir, epoch_ms, load_json_or_default, save_json_pretty};
use crate::triggers::IncidentReport;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

const UPDATE_EVENT: &str = "incident-analysis-updated";
const QUEUE_SIZE: usize = 16;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AnalysisSettings {
    enabled: bool,
    codex_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum AnalysisStatus {
    Queued,
    Running,
    Completed { output: String },
    Failed { error: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnalysisRecord {
    incident_id: String,
    #[serde(flatten)]
    status: AnalysisStatus,
}

#[derive(Deserialize, Serialize)]
struct StoredAnalysis {
    run_id: u64,
    #[serde(flatten)]
    record: AnalysisRecord,
}

pub struct IncidentAnalysis {
    run_id: u64,
    queue: mpsc::Sender<String>,
    store: Mutex<()>,
}

fn settings_file() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("incident_analysis_settings.json"))
}

fn results_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("incident_analysis"))
}

fn report_file(incident_id: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir()?
        .join("incidents")
        .join(format!("{incident_id}.json")))
}

fn validate_id(incident_id: &str) -> Result<(), String> {
    if !incident_id.starts_with("inc-")
        || incident_id.len() > 128
        || !incident_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("无效的异常事件编号".into());
    }
    Ok(())
}

fn record_file(incident_id: &str) -> Result<PathBuf, String> {
    validate_id(incident_id)?;
    Ok(results_dir()?.join(format!("{incident_id}.json")))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    save_json_pretty(&temporary, value)?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn read_record(incident_id: &str) -> Result<Option<StoredAnalysis>, String> {
    load_json_or_default(&record_file(incident_id)?)
}

fn update_record(
    app: &AppHandle,
    run_id: u64,
    incident_id: &str,
    status: AnalysisStatus,
) -> Result<(), String> {
    let stored = StoredAnalysis {
        run_id,
        record: AnalysisRecord {
            incident_id: incident_id.into(),
            status,
        },
    };
    write_json(&record_file(incident_id)?, &stored)?;
    let _ = app.emit(UPDATE_EVENT, &stored.record);
    Ok(())
}

fn failed(error: impl Into<String>) -> AnalysisStatus {
    AnalysisStatus::Failed {
        error: error.into(),
    }
}

pub fn start(app: &AppHandle) {
    let (queue, mut jobs) = mpsc::channel::<String>(QUEUE_SIZE);
    app.manage(IncidentAnalysis {
        run_id: epoch_ms(),
        queue,
        store: Mutex::new(()),
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(incident_id) = jobs.recv().await {
            if let Err(error) = process(&app, &incident_id).await {
                log_error(&app, &incident_id, error);
            }
        }
    });
}

fn log_error(app: &AppHandle, incident_id: &str, error: String) {
    let _ = app.emit(
        UPDATE_EVENT,
        AnalysisRecord {
            incident_id: incident_id.into(),
            status: failed(&error),
        },
    );
    crate::state::emit_ai_sync(
        app,
        "incident_analysis",
        "analyze_incident",
        "error",
        format!("{incident_id}: {error}"),
    );
}

pub fn enqueue(app: &AppHandle, report: IncidentReport) {
    // 串口规则中的 AI 排障动作决定哪些事件交给分析。
    if report.prompt.is_empty() {
        return;
    }
    if let Err(error) = schedule(app, &report.id) {
        log_error(app, &report.id, error);
    }
}

fn schedule(app: &AppHandle, incident_id: &str) -> Result<(), String> {
    let analysis = app.state::<IncidentAnalysis>();
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    let settings: AnalysisSettings = load_json_or_default(&settings_file()?)?;
    if !settings.enabled || read_record(incident_id)?.is_some() {
        return Ok(());
    }
    update_record(app, analysis.run_id, incident_id, AnalysisStatus::Queued)?;
    if analysis.queue.try_send(incident_id.to_owned()).is_err() {
        update_record(
            app,
            analysis.run_id,
            incident_id,
            failed("分析队列已满或服务已停止"),
        )?;
    }
    Ok(())
}

fn begin(
    app: &AppHandle,
    analysis: &IncidentAnalysis,
    incident_id: &str,
) -> Result<Option<(AnalysisSettings, IncidentReport)>, String> {
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    if !matches!(
        read_record(incident_id)?,
        Some(stored) if stored.run_id == analysis.run_id
            && matches!(stored.record.status, AnalysisStatus::Queued)
    ) {
        return Ok(None);
    }
    let load_input = || -> Result<_, String> {
        let settings: AnalysisSettings = load_json_or_default(&settings_file()?)?;
        if !settings.enabled {
            return Err("自动分析已关闭".into());
        }
        let source = fs::read_to_string(report_file(incident_id)?)
            .map_err(|error| format!("读取异常事件失败: {error}"))?;
        let report = serde_json::from_str::<IncidentReport>(&source)
            .map_err(|error| format!("读取异常事件失败: {error}"))?;
        Ok((settings, report))
    };
    match load_input() {
        Ok(input) => {
            update_record(app, analysis.run_id, incident_id, AnalysisStatus::Running)?;
            Ok(Some(input))
        }
        Err(error) => {
            update_record(app, analysis.run_id, incident_id, failed(error))?;
            Ok(None)
        }
    }
}

async fn process(app: &AppHandle, incident_id: &str) -> Result<(), String> {
    let analysis = app.state::<IncidentAnalysis>();
    let Some((settings, report)) = begin(app, &analysis, incident_id)? else {
        return Ok(());
    };
    let status = match codex::analyze(&settings.codex_path, &report).await {
        Ok(output) => AnalysisStatus::Completed { output },
        Err(error) => failed(error),
    };
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    if matches!(
        read_record(incident_id)?,
        Some(stored) if stored.run_id == analysis.run_id
            && matches!(stored.record.status, AnalysisStatus::Running)
    ) {
        update_record(app, analysis.run_id, incident_id, status)?;
    }
    Ok(())
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    let analysis = app.state::<IncidentAnalysis>();
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    match fs::remove_dir_all(results_dir()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn incident_analysis_settings(
    analysis: State<'_, IncidentAnalysis>,
) -> Result<AnalysisSettings, String> {
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    load_json_or_default(&settings_file()?)
}

#[tauri::command]
pub fn incident_analysis_save_settings(
    analysis: State<'_, IncidentAnalysis>,
    mut settings: AnalysisSettings,
) -> Result<AnalysisSettings, String> {
    settings.codex_path = settings.codex_path.trim().to_owned();
    let path = Path::new(&settings.codex_path);
    if !settings.codex_path.is_empty() && (!path.is_absolute() || !path.is_file()) {
        return Err("请输入 Codex CLI 可执行文件的绝对路径，或留空从 PATH 查找".into());
    }
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    write_json(&settings_file()?, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn incident_analysis_results(
    analysis: State<'_, IncidentAnalysis>,
    incident_ids: Vec<String>,
) -> Result<BTreeMap<String, AnalysisRecord>, String> {
    let _store = analysis.store.lock().map_err(|error| error.to_string())?;
    let mut results = BTreeMap::new();
    for incident_id in incident_ids {
        if let Some(mut stored) = read_record(&incident_id)? {
            if stored.run_id != analysis.run_id
                && matches!(
                    stored.record.status,
                    AnalysisStatus::Running | AnalysisStatus::Queued
                )
            {
                stored.record.status = failed("上次退出时分析尚未完成");
            }
            results.insert(incident_id, stored.record);
        }
    }
    Ok(results)
}
