use super::packages::{self, Action, Entry, Installed, ProcessProtocol};
use super::worker::{self, Frame, Process};
use crate::state::{app_data_dir, emit_ai_sync, epoch_ms, save_json_pretty};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch, Notify};
use tokio::time::{sleep_until, Instant};

const HISTORY_LIMIT: usize = 100;
const LOG_LIMIT: usize = 200;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Confirmation {
    pub(super) token: String,
    capability: String,
    device: Option<String>,
    summary: String,
    details: Value,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Run {
    pub(super) id: String,
    pub(super) plugin_id: String,
    pub(super) action: String,
    pub(super) origin: String,
    pub(super) device: Option<String>,
    pub(super) status: String,
    pub(super) logs: Vec<String>,
    pub(super) result: Option<Value>,
    pub(super) error: Option<String>,
    pub(super) confirmation: Option<Confirmation>,
    progress: Option<f64>,
    started_at: u64,
    ended_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
pub(super) struct RunRequest {
    pub(super) id: String,
    pub(super) action: String,
    #[serde(default)]
    pub(super) inputs: Map<String, Value>,
    pub(super) device: Option<String>,
}

struct Inner {
    run: Run,
    approval: Option<oneshot::Sender<()>>,
    native_active: bool,
    cancelled: bool,
    sequence: u64,
}

pub(super) struct Job {
    inner: Mutex<Inner>,
    stop: watch::Sender<bool>,
    done: Notify,
    pub(super) installed: Installed,
    pub(super) app: AppHandle,
    pub(super) context: Value,
    pub(super) provider_session: Option<String>,
}

#[derive(Default)]
struct Records {
    active: BTreeMap<String, Arc<Job>>,
    finished: BTreeMap<String, Run>,
}

pub(crate) struct Jobs(Mutex<Records>);

impl Default for Jobs {
    fn default() -> Self {
        let mut finished = BTreeMap::new();
        if let Ok(path) = history_path() {
            if let Ok(bytes) = std::fs::read(path) {
                finished = serde_json::from_slice(&bytes).unwrap_or_default();
            }
        }
        Self(Mutex::new(Records {
            active: BTreeMap::new(),
            finished,
        }))
    }
}

fn history_path() -> Result<std::path::PathBuf, String> {
    Ok(app_data_dir()?.join("plugin-run-history.json"))
}

fn save_history(records: &Records) -> Result<(), String> {
    let path = history_path()?;
    let mut history = records.finished.clone();
    for job in records
        .active
        .values()
        .filter(|job| job.provider_session.is_none())
    {
        let mut run = job.snapshot();
        run.status = "failed".into();
        run.error = Some("The desktop app closed before this action completed".into());
        run.confirmation = None;
        history.insert(run.id.clone(), run);
    }
    while history.len() > HISTORY_LIMIT {
        history.pop_first();
    }
    save_json_pretty(&path, &history)
}

impl Job {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn snapshot(&self) -> Run {
        self.inner().run.clone()
    }

    pub(super) fn log(&self, message: String) {
        let line = message.chars().take(4096).collect::<String>();
        let snapshot = {
            let mut state = self.inner();
            if state.run.logs.len() == LOG_LIMIT {
                state.run.logs.remove(0);
            }
            state.run.logs.push(line.clone());
            state.run.clone()
        };
        if let Some(session) = self.provider_session.as_deref() {
            super::providers::on_job_log(&self.app, session, line);
        } else {
            self.emit(snapshot);
        }
    }

    fn emit(&self, run: Run) {
        let _ = self.app.emit("plugin-run-changed", run);
    }

    fn progress(&self, value: f64) {
        self.inner().run.progress = Some(value.clamp(0.0, 100.0));
        if self.provider_session.is_none() {
            self.emit(self.snapshot());
        }
    }

    pub(super) fn confirm(&self, token: &str) -> Result<Run, String> {
        let mut inner = self.inner();
        if inner.cancelled
            || inner
                .run
                .confirmation
                .as_ref()
                .map(|value| value.token.as_str())
                != Some(token)
        {
            return Err("This confirmation has expired or the token does not match".into());
        }
        let response = inner
            .approval
            .take()
            .ok_or("The operation has already been confirmed")?;
        response
            .send(())
            .map_err(|_| "Confirmation is no longer pending")?;
        inner.run.status = "running".into();
        inner.run.confirmation = None;
        let run = inner.run.clone();
        drop(inner);
        self.emit(run.clone());
        Ok(run)
    }

    pub(super) fn cancel(&self) -> Result<Run, String> {
        let mut inner = self.inner();
        if inner.native_active {
            return Err("A confirmed device operation is already running".into());
        }
        if inner.run.ended_at.is_none() {
            inner.cancelled = true;
            inner.approval.take();
            self.stop.send_replace(true);
        }
        Ok(inner.run.clone())
    }

    pub(super) fn allow(&self, permission: &str) -> Result<(), String> {
        if !self
            .installed
            .manifest
            .permissions
            .iter()
            .any(|item| item == permission)
            || !self.installed.grants.iter().any(|item| item == permission)
        {
            return Err(format!("Plugin permission not granted: {permission}"));
        }
        Ok(())
    }

    pub(super) async fn authorize(
        &self,
        permission: &str,
        summary: &str,
        details: Value,
    ) -> Result<(), String> {
        self.allow(permission)?;
        if self.provider_session.is_some() {
            return Err("Connection workers may only perform read operations. Use a provider action for device writes.".into());
        }
        let (response, reply) = oneshot::channel();
        let snapshot = {
            let mut inner = self.inner();
            if inner.cancelled {
                return Err("Action cancelled".into());
            }
            inner.sequence += 1;
            inner.run.status = "awaiting_confirmation".into();
            inner.run.confirmation = Some(Confirmation {
                token: format!("{}-{}", inner.run.id, inner.sequence),
                capability: permission.into(),
                device: inner.run.device.clone(),
                summary: summary.into(),
                details,
            });
            inner.approval = Some(response);
            inner.run.clone()
        };
        self.emit(snapshot);
        let result = tokio::time::timeout(Duration::from_secs(600), reply).await;
        let mut inner = self.inner();
        inner.approval.take();
        inner.run.confirmation = None;
        if inner.cancelled {
            return Err("Action cancelled".into());
        }
        inner.run.status = "running".into();
        if !matches!(result, Ok(Ok(()))) {
            inner.cancelled = true;
            self.stop.send_replace(true);
            return Err("Device operation confirmation expired".into());
        }
        Ok(())
    }

    pub(super) fn begin_native(&self) -> Result<NativeOperation<'_>, String> {
        let mut inner = self.inner();
        if inner.cancelled {
            return Err("Action cancelled".into());
        }
        inner.native_active = true;
        Ok(NativeOperation(self))
    }

    pub(super) async fn wait(&self) -> Run {
        loop {
            let notification = self.done.notified();
            let run = self.snapshot();
            if run.ended_at.is_some() {
                return run;
            }
            notification.await;
        }
    }
}

pub(super) struct NativeOperation<'a>(&'a Job);
impl Drop for NativeOperation<'_> {
    fn drop(&mut self) {
        self.0.inner().native_active = false;
    }
}

pub(super) fn list(app: &AppHandle, id: Option<&str>) -> Vec<Run> {
    let store = app.state::<Jobs>();
    let records = store.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut runs = records
        .active
        .values()
        .map(|job| job.snapshot())
        .filter(|run| id.is_none_or(|id| run.plugin_id == id))
        .chain(
            records
                .finished
                .values()
                .filter(|run| id.is_none_or(|id| run.plugin_id == id))
                .cloned(),
        )
        .collect::<Vec<_>>();
    runs.sort_unstable_by(|left, right| right.id.cmp(&left.id));
    runs
}

pub(super) async fn shutdown(app: &AppHandle) {
    let jobs = app
        .state::<Jobs>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .active
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for job in &jobs {
        let _ = job.cancel();
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        for job in jobs {
            job.wait().await;
        }
    })
    .await;
}

pub(super) fn active(app: &AppHandle, id: &str) -> bool {
    app.state::<Jobs>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .active
        .values()
        .any(|job| job.installed.manifest.id == id)
}

pub(super) fn get(app: &AppHandle, id: &str) -> Result<Run, String> {
    let store = app.state::<Jobs>();
    let records = store.0.lock().unwrap_or_else(|e| e.into_inner());
    records
        .active
        .get(id)
        .map(|job| job.snapshot())
        .or_else(|| records.finished.get(id).cloned())
        .ok_or_else(|| format!("Unknown plugin run: {id}"))
}

pub(super) fn active_job(app: &AppHandle, id: &str) -> Result<Arc<Job>, String> {
    app.state::<Jobs>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .active
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Plugin run is no longer active: {id}"))
}

pub(super) fn start(
    app: &AppHandle,
    request: RunRequest,
    origin: &str,
    mut context: Value,
    provider_session: Option<String>,
) -> Result<Arc<Job>, String> {
    let installed = packages::get(&request.id)?;
    if !installed.enabled {
        return Err(format!("Plugin is disabled: {}", request.id));
    }
    let action = installed
        .manifest
        .actions
        .iter()
        .find(|action| action.id == request.action)
        .cloned()
        .ok_or_else(|| format!("Unknown plugin action: {}", request.action))?;
    let inputs = packages::validate_values(&action.inputs, request.inputs)?;
    let settings =
        packages::validate_values(&installed.manifest.settings, installed.settings.clone())?;
    let device = request.device.filter(|device| !device.trim().is_empty());
    context["device"] = json!(device);
    context["origin"] = json!(origin);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let id = format!("plugin-{}-{sequence:08}", epoch_ms());
    let run = Run {
        id: id.clone(),
        plugin_id: request.id,
        action: action.id.clone(),
        origin: origin.into(),
        device,
        status: "running".into(),
        logs: vec![],
        progress: None,
        result: None,
        error: None,
        confirmation: None,
        started_at: epoch_ms(),
        ended_at: None,
    };
    let (stop, cancelled) = watch::channel(false);
    let job = Arc::new(Job {
        app: app.clone(),
        installed,
        context,
        provider_session,
        stop,
        done: Notify::new(),
        inner: Mutex::new(Inner {
            run,
            approval: None,
            native_active: false,
            cancelled: false,
            sequence: 0,
        }),
    });
    if matches!(&action.entry, Entry::Process { .. }) {
        job.allow("process.execute")?;
    }
    {
        let store = app.state::<Jobs>();
        let mut records = store.0.lock().unwrap_or_else(|e| e.into_inner());
        if records.active.len() >= 32 {
            return Err("Too many plugin actions are running".into());
        }
        records.active.insert(id.clone(), job.clone());
        if job.provider_session.is_none() {
            if let Err(error) = save_history(&records) {
                records.active.remove(&id);
                return Err(format!("Cannot save plugin run history: {error}"));
            }
        }
    }
    if job.provider_session.is_none() {
        job.emit(job.snapshot());
        emit_ai_sync(
            app,
            origin,
            "plugin-run",
            "started",
            format!("{} / {} · {id}", job.installed.manifest.id, action.id),
        );
    }
    let child_job = job.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = execute(&child_job, &action, inputs, settings, cancelled).await;
        finish(&child_job, outcome);
    });
    Ok(job)
}

enum Outcome {
    Success(Value),
    Failed(String),
    Cancelled,
    TimedOut,
}

async fn execute(
    job: &Arc<Job>,
    action: &Action,
    inputs: Map<String, Value>,
    settings: Map<String, Value>,
    mut cancellation: watch::Receiver<bool>,
) -> Outcome {
    let mut process = match Process::launch(&job.installed, action, &inputs) {
        Ok(process) => process,
        Err(error) => return Outcome::Failed(error),
    };
    let stderr = process.take_stderr().map(|mut stderr| {
        let job = job.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(line)) = worker::read_line(&mut stderr).await {
                if !line.is_empty() {
                    job.log(line);
                }
            }
        })
    });
    let duration = Duration::from_millis(action.timeout_ms.unwrap_or(120_000));
    let deadline = Instant::now() + duration;
    let outcome = if process.protocol == ProcessProtocol::Stdio {
        execute_stdio(job, action, &mut process, deadline, &mut cancellation).await
    } else {
        execute_ndjson(
            job,
            action,
            &mut process,
            inputs,
            settings,
            deadline,
            &mut cancellation,
        )
        .await
    };
    drop(process);
    if let Some(stderr) = stderr {
        let _ = tokio::time::timeout(Duration::from_millis(300), stderr).await;
    }
    outcome
}

async fn execute_ndjson(
    job: &Job,
    action: &Action,
    process: &mut Process,
    inputs: Map<String, Value>,
    settings: Map<String, Value>,
    mut deadline: Instant,
    cancellation: &mut watch::Receiver<bool>,
) -> Outcome {
    let start =
        json!({"type":"start", "inputs":inputs, "settings":settings, "context":job.context});
    let send = tokio::select! {
        _ = cancellation.wait_for(|requested| *requested) => Err(Outcome::Cancelled),
        _ = sleep_until(deadline) => Err(Outcome::TimedOut),
        result = process.send(start) => result.map_err(Outcome::Failed),
    };
    match send {
        Err(outcome) => outcome,
        Ok(()) => loop {
            let frame = tokio::select! {
                _ = cancellation.wait_for(|requested| *requested) => break Outcome::Cancelled,
                _ = sleep_until(deadline) => break Outcome::TimedOut,
                frame = process.frame() => frame,
            };
            match frame {
                Ok(Some(Frame::Log { message })) => job.log(message),
                Ok(Some(Frame::Progress { value })) => job.progress(value),
                Ok(Some(Frame::Call { id, method, args })) => {
                    // 宿主审批及已确认的写入有自己的生命周期。
                    let entered = Instant::now();
                    let approval_sequence = job.inner().sequence;
                    let result = super::capabilities::call(job, &method, args).await;
                    if job.inner().sequence > approval_sequence {
                        deadline += entered.elapsed();
                    }
                    if *cancellation.borrow() {
                        break Outcome::Failed(
                            result.err().unwrap_or_else(|| "Action cancelled".into()),
                        );
                    }
                    let reply = tokio::select! {
                        _ = cancellation.wait_for(|requested| *requested) => break Outcome::Cancelled,
                        _ = sleep_until(deadline) => break Outcome::TimedOut,
                        result = process.reply(id, result) => result,
                    };
                    if let Err(error) = reply {
                        break Outcome::Failed(error);
                    }
                }
                Ok(Some(Frame::Result { value })) => {
                    let exit = tokio::select! {
                        _ = cancellation.wait_for(|requested| *requested) => break Outcome::Cancelled,
                        _ = sleep_until(deadline) => break Outcome::TimedOut,
                        exit = process.wait() => exit,
                    };
                    if let Err(error) = exit {
                        break Outcome::Failed(error);
                    }
                    break check_output(action, value);
                }
                Ok(Some(Frame::Error { message })) => break Outcome::Failed(message),
                Ok(None) => {
                    let exit = tokio::select! {
                        _ = cancellation.wait_for(|requested| *requested) => break Outcome::Cancelled,
                        _ = sleep_until(deadline) => break Outcome::TimedOut,
                        exit = process.wait() => exit,
                    };
                    break Outcome::Failed(
                        exit.err()
                            .unwrap_or_else(|| "Plugin exited without a result".into()),
                    );
                }
                Err(error) => break Outcome::Failed(error),
            }
        },
    }
}

async fn execute_stdio(
    job: &Job,
    action: &Action,
    process: &mut Process,
    deadline: Instant,
    cancellation: &mut watch::Receiver<bool>,
) -> Outcome {
    let mut stdout = VecDeque::new();
    loop {
        let line = tokio::select! {
            _ = cancellation.wait_for(|requested| *requested) => return Outcome::Cancelled,
            _ = sleep_until(deadline) => return Outcome::TimedOut,
            line = process.text() => line,
        };
        match line {
            Ok(Some(line)) => {
                let line = line.chars().take(4096).collect::<String>();
                job.log(line.clone());
                if stdout.len() == LOG_LIMIT {
                    stdout.pop_front();
                }
                stdout.push_back(line);
            }
            Ok(None) => break,
            Err(error) => return Outcome::Failed(error),
        }
    }
    tokio::select! {
        _ = cancellation.wait_for(|requested| *requested) => Outcome::Cancelled,
        _ = sleep_until(deadline) => Outcome::TimedOut,
        result = process.wait() => match result {
            Ok(()) => check_output(action, json!({
                "stdout": stdout.into_iter().collect::<Vec<_>>().join("\n"),
                "exit_code": 0
            })),
            Err(error) => Outcome::Failed(error),
        }
    }
}

fn check_output(action: &Action, value: Value) -> Outcome {
    let Some(output) = action.output.as_ref().filter(|output| !output.is_empty()) else {
        return Outcome::Success(value);
    };
    let Value::Object(object) = value else {
        return Outcome::Failed("Action output must be a JSON object".into());
    };
    match packages::validate_values(output, object) {
        Ok(checked) => Outcome::Success(Value::Object(checked)),
        Err(error) => Outcome::Failed(format!("Action output: {error}")),
    }
}

fn finish(job: &Job, outcome: Outcome) {
    let run = {
        let mut inner = job.inner();
        inner.approval.take();
        inner.run.confirmation = None;
        inner.run.ended_at = Some(epoch_ms());
        let (status, result, error) = match outcome {
            Outcome::Success(value) => ("succeeded", Some(value), None),
            Outcome::Failed(error) => (
                if inner.cancelled && error == "Action cancelled" {
                    "cancelled"
                } else {
                    "failed"
                },
                None,
                Some(error),
            ),
            Outcome::Cancelled => ("cancelled", None, None),
            Outcome::TimedOut => ("timed_out", None, Some("Plugin action timed out".into())),
        };
        inner.run.status = status.into();
        inner.run.result = result;
        inner.run.error = error;
        inner.run.clone()
    };
    let store = job.app.state::<Jobs>();
    {
        let mut records = store.0.lock().unwrap_or_else(|e| e.into_inner());
        records.active.remove(&run.id);
        if job.provider_session.is_none() {
            records.finished.insert(run.id.clone(), run.clone());
            while records.finished.len() > HISTORY_LIMIT {
                records.finished.pop_first();
            }
            if let Err(error) = save_history(&records) {
                let _ = job.app.emit("plugin-history-error", error);
            }
        }
    }
    job.done.notify_waiters();
    if job.provider_session.is_none() {
        job.emit(run.clone());
        emit_ai_sync(
            &job.app,
            &run.origin,
            "plugin-run",
            if run.status == "succeeded" {
                "completed"
            } else {
                "error"
            },
            format!(
                "{} / {} · {} · {}",
                run.plugin_id, run.action, run.id, run.status
            ),
        );
    }
}
