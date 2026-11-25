use super::jobs::{self, Job, Run, RunRequest};
use super::packages::{self, Provider};
use crate::triggers;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Notify};

const LOG_LIMIT: usize = 200;
static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Session {
    pub(super) id: String,
    pub(super) plugin_id: String,
    pub(super) provider: String,
    pub(super) status: String,
    pub(super) logs: Vec<String>,
    #[serde(default)]
    pub(super) error: Option<String>,
    #[serde(default)]
    pub(super) kind: String,
    #[serde(default)]
    pub(super) device: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct StartRequest {
    pub(super) id: String,
    pub(super) provider: String,
    #[serde(default)]
    pub(super) inputs: Map<String, serde_json::Value>,
    #[serde(default)]
    pub(super) device: Option<String>,
}

struct Record {
    session: Session,
    stop: watch::Sender<bool>,
    current_job: Option<Arc<Job>>,
    done: Option<Arc<Notify>>,
}

#[derive(Default)]
pub(crate) struct Providers(Mutex<BTreeMap<String, Record>>);

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, BTreeMap<String, Record>> {
    app.state::<Providers>()
        .inner()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn provider_for(
    plugin_id: &str,
    provider_id: &str,
) -> Result<(super::packages::Installed, Provider), String> {
    let installed = packages::get(plugin_id)?;
    if !installed.enabled {
        return Err(format!("插件已停用: {plugin_id}"));
    }
    let provider = installed
        .manifest
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .cloned()
        .ok_or_else(|| format!("插件未声明 provider: {provider_id}"))?;
    Ok((installed, provider))
}

fn ensure_provider_permission(
    installed: &super::packages::Installed,
    provider: &Provider,
) -> Result<(), String> {
    let permission = format!("providers.{}", provider.kind);
    if !installed
        .manifest
        .permissions
        .iter()
        .any(|item| item == &permission)
        || !installed.grants.iter().any(|item| item == &permission)
    {
        return Err(format!("Provider 权限未声明或未授权: {permission}"));
    }
    Ok(())
}

fn emit_session(app: &AppHandle, session: &Session) {
    use tauri::Emitter;
    let _ = app.emit("plugin-provider-changed", session.clone());
}

fn connect_job(
    app: &AppHandle,
    request: &StartRequest,
    session_id: &str,
    provider: &Provider,
) -> Result<Option<Arc<Job>>, String> {
    let Some(action) = provider.actions.get("connect") else {
        return Ok(None);
    };
    jobs::start(
        app,
        RunRequest { id: request.id.clone(), action: action.clone(), inputs: request.inputs.clone(), device: request.device.clone() },
        "provider-connect",
        json!({ "provider": { "id": request.provider, "session_id": session_id, "kind": provider.kind, "operation": "connect" } }),
        Some(session_id.to_string()),
    ).map(Some)
}

fn set_status(app: &AppHandle, session_id: &str, status: &str, error: Option<String>) {
    let changed = {
        let mut records = lock(app);
        records.get_mut(session_id).map(|record| {
            record.session.status = status.to_string();
            record.session.error = error;
            record.session.clone()
        })
    };
    if let Some(session) = changed {
        emit_session(app, &session);
    }
}

pub(super) fn list(app: &AppHandle, id: Option<&str>) -> Vec<Session> {
    lock(app)
        .values()
        .filter(|r| id.is_none_or(|id| r.session.plugin_id == id))
        .map(|r| r.session.clone())
        .collect()
}

pub(super) fn active(app: &AppHandle, id: &str) -> bool {
    lock(app)
        .values()
        .any(|r| (r.session.plugin_id == id || r.session.id == id) && r.session.status != "stopped")
}

pub(super) fn recent(app: &AppHandle, session: &str, lines: usize) -> Option<Vec<String>> {
    let records = lock(app);
    let logs = &records.get(session)?.session.logs;
    let start = logs.len().saturating_sub(lines);
    Some(logs[start..].to_vec())
}

pub(super) fn on_job_log(app: &AppHandle, session: &str, line: String) {
    let trigger_data = {
        let mut records = lock(app);
        let Some(record) = records.get_mut(session) else {
            return;
        };
        if record.session.logs.len() == LOG_LIMIT {
            record.session.logs.remove(0);
        }
        record.session.logs.push(line.clone());
        if record.session.status == "connecting" {
            record.session.status = "connected".into();
        }
        (
            record.session.id.clone(),
            format!(
                "plugin://{}/{}",
                record.session.plugin_id, record.session.provider
            ),
            record.session.clone(),
            record.session.kind == "log",
        )
    };
    emit_session(app, &trigger_data.2);
    if trigger_data.3 {
        triggers::on_serial_line(app, &trigger_data.0, &trigger_data.1, &line);
    }
}

pub(super) fn start(app: &AppHandle, request: StartRequest) -> Result<Session, String> {
    let (installed, provider) = provider_for(&request.id, &request.provider)?;
    ensure_provider_permission(&installed, &provider)?;
    let session_id = format!(
        "provider-{}-{:08x}",
        crate::state::epoch_ms(),
        SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let device = request.device.clone().filter(|d| !d.trim().is_empty());
    let session = Session {
        id: session_id.clone(),
        plugin_id: request.id.clone(),
        provider: request.provider.clone(),
        status: if provider.actions.contains_key("connect") {
            "connecting"
        } else {
            "connected"
        }
        .into(),
        logs: Vec::new(),
        error: None,
        kind: provider.kind.clone(),
        device,
    };
    let (stop, receiver) = watch::channel(false);
    let done = provider
        .actions
        .contains_key("connect")
        .then(|| Arc::new(Notify::new()));
    {
        let mut records = lock(app);
        while records.len() >= 100 {
            let stopped = records
                .iter()
                .find(|(_, record)| record.session.status == "stopped")
                .map(|(id, _)| id.clone());
            if let Some(id) = stopped {
                records.remove(&id);
            } else {
                return Err("Too many provider sessions are active".into());
            }
        }
        records.insert(
            session_id.clone(),
            Record {
                session: session.clone(),
                stop,
                current_job: None,
                done: done.clone(),
            },
        );
    }
    emit_session(app, &session);
    let initial_job = match connect_job(app, &request, &session_id, &provider) {
        Ok(job) => job,
        Err(error) => {
            lock(app).remove(&session_id);
            emit_session(
                app,
                &Session {
                    status: "failed".into(),
                    error: Some(error.clone()),
                    ..session.clone()
                },
            );
            return Err(error);
        }
    };
    if let Some(job) = &initial_job {
        if let Some(record) = lock(app).get_mut(&session_id) {
            record.current_job = Some(job.clone());
        }
    }
    if initial_job.is_some() {
        let app = app.clone();
        let request = request.clone();
        let provider = provider.clone();
        let first = initial_job;
        let done = done.expect("connect provider has completion notifier");
        tauri::async_runtime::spawn(async move {
            reconnect_loop(app, request, session_id, provider, first, receiver, done).await;
        });
    }
    Ok(session)
}

async fn reconnect_loop(
    app: AppHandle,
    request: StartRequest,
    session_id: String,
    provider: Provider,
    mut job: Option<Arc<Job>>,
    mut stop: watch::Receiver<bool>,
    done: Arc<Notify>,
) {
    loop {
        if let Some(current) = job.take() {
            let completed = tokio::select! {
                _ = async { let _ = stop.wait_for(|requested| *requested).await; } => {
                    let _ = current.cancel();
                    current.wait().await
                }
                run = current.wait() => run,
            };
            let (session, stopping) = {
                let mut records = lock(&app);
                if let Some(record) = records.get_mut(&session_id) {
                    record.current_job = None;
                    if *stop.borrow() {
                        record.session.status = "stopped".into();
                        record.session.error = None;
                        (record.session.clone(), true)
                    } else {
                        record.session.status = "reconnecting".into();
                        record.session.error = completed.error.clone();
                        (record.session.clone(), false)
                    }
                } else {
                    break;
                }
            };
            emit_session(&app, &session);
            if stopping {
                break;
            }
        }
        let delay = Duration::from_millis(provider.reconnect_ms.unwrap_or(5_000).max(250));
        tokio::select! {
            _ = async { let _ = stop.wait_for(|requested| *requested).await; } => break,
            _ = tokio::time::sleep(delay) => {}
        }
        if *stop.borrow() {
            break;
        }
        set_status(&app, &session_id, "connecting", None);
        match connect_job(&app, &request, &session_id, &provider) {
            Ok(Some(next)) => {
                if *stop.borrow() {
                    let _ = next.cancel();
                    let _ = next.wait().await;
                    set_status(&app, &session_id, "stopped", None);
                    break;
                }
                if let Some(record) = lock(&app).get_mut(&session_id) {
                    record.current_job = Some(next.clone());
                }
                job = Some(next);
            }
            Ok(None) => break,
            Err(error) => {
                set_status(&app, &session_id, "reconnecting", Some(error));
                continue;
            }
        }
    }
    done.notify_one();
}

pub(super) async fn stop(app: &AppHandle, session_id: &str) -> Result<Session, String> {
    let (job, stopped, done) = {
        let mut records = lock(app);
        let record = records
            .get_mut(session_id)
            .ok_or_else(|| format!("Provider 会话不存在: {session_id}"))?;
        record.stop.send_replace(true);
        record.session.status = "stopped".into();
        record.session.error = None;
        (
            record.current_job.clone(),
            record.session.clone(),
            record.done.clone(),
        )
    };
    emit_session(app, &stopped);
    if let Some(job) = job {
        let _ = job.cancel();
        let _ = job.wait().await;
    }
    if let Some(done) = done {
        done.notified().await;
    }
    lock(app)
        .get(session_id)
        .map(|r| r.session.clone())
        .ok_or_else(|| format!("Provider 会话不存在: {session_id}"))
}

pub(super) async fn call(
    app: &AppHandle,
    session_id: &str,
    operation: &str,
    inputs: Map<String, serde_json::Value>,
) -> Result<Run, String> {
    let session = lock(app)
        .get(session_id)
        .map(|r| r.session.clone())
        .ok_or_else(|| format!("Provider 会话不存在: {session_id}"))?;
    if session.status != "connected" {
        return Err(format!("Provider 会话当前状态为 {}", session.status));
    }
    let (installed, provider) = provider_for(&session.plugin_id, &session.provider)?;
    ensure_provider_permission(&installed, &provider)?;
    if operation == "connect" {
        return Err("connect 是会话生命周期操作，不能作为 provider_call 调用".into());
    }
    let action = provider
        .actions
        .get(operation)
        .ok_or_else(|| format!("Provider 未声明操作: {operation}"))?;
    let job = jobs::start(
        app,
        RunRequest {
            id: installed.manifest.id,
            action: action.clone(),
            inputs,
            device: session.device.clone(),
        },
        "provider-call",
        json!({ "provider": { "id": session.provider, "session_id": session.id, "kind": provider.kind, "operation": operation } }),
        None,
    )?;
    Ok(job.snapshot())
}
