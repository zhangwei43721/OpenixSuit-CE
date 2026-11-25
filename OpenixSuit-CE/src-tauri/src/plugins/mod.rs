mod capabilities;
mod jobs;
pub(crate) mod packages;
mod providers;
mod worker;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

pub(crate) use jobs::Jobs;
pub(crate) use providers::Providers;

pub(crate) const PERMISSIONS: &[&str] = &[
    "process.execute",
    "logs.read",
    "devices.read",
    "adb.shell",
    "adb.transfer",
    "adb.root",
    "adb.reboot",
    "adb.partition",
    "firmware.inspect",
    "firmware.flash",
    "power.execute",
    "providers.log",
    "providers.device",
    "providers.power",
];

static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
struct PackagePath {
    path: PathBuf,
}

#[derive(Deserialize)]
struct PackageOutput {
    path: PathBuf,
    output: PathBuf,
}

#[derive(Deserialize)]
struct GithubSource {
    repo: String,
}

#[derive(Deserialize)]
struct PluginConfig {
    id: String,
    config: packages::Config,
}

#[derive(Deserialize)]
struct RunId {
    run_id: String,
}

#[derive(Deserialize)]
struct Approval {
    run_id: String,
    token: String,
}

#[derive(Deserialize)]
struct ProviderSessionId {
    session_id: String,
}

#[derive(Deserialize)]
struct ProviderAction {
    session_id: String,
    operation: String,
    #[serde(default)]
    inputs: Map<String, Value>,
}

#[tauri::command]
pub(crate) async fn plugin_request(
    app: AppHandle,
    action: String,
    args: Value,
) -> Result<Value, String> {
    dispatch(&app, "gui", &action, args).await
}

pub(crate) async fn dispatch(
    app: &AppHandle,
    source: &str,
    action: &str,
    args: Value,
) -> Result<Value, String> {
    match action {
        "validate" => {
            let PackagePath { path } = parse(args)?;
            blocking(move || output(packages::validate(&path)?)).await
        }
        "pack" => {
            let PackageOutput { path, output: file } = parse(args)?;
            blocking(move || output(packages::pack(&path, &file)?)).await
        }
        "list" => blocking(|| output(packages::list()?)).await,
        "describe" => {
            let id = required_id(&args)?.to_owned();
            blocking(move || output(packages::get(&id)?)).await
        }
        "runs" => output(jobs::list(app, optional_id(&args)?)),
        "run_get" => {
            let RunId { run_id } = parse(args)?;
            output(jobs::get(app, &run_id)?)
        }
        "confirm" => {
            let Approval { run_id, token } = parse(args)?;
            output(jobs::active_job(app, &run_id)?.confirm(&token)?)
        }
        "cancel" => {
            let RunId { run_id } = parse(args)?;
            output(jobs::active_job(app, &run_id)?.cancel()?)
        }
        "run" => {
            let request = parse(args)?;
            let _lock = LIFECYCLE.lock().await;
            output(jobs::start(app, request, source, json!({}), None)?.snapshot())
        }
        "providers" => output(providers::list(app, optional_id(&args)?)),
        "provider_start" => {
            let request = parse(args)?;
            let _lock = LIFECYCLE.lock().await;
            output(providers::start(app, request)?)
        }
        "provider_stop" => {
            let request: ProviderSessionId = parse(args)?;
            output(providers::stop(app, &request.session_id).await?)
        }
        "provider_call" => {
            let ProviderAction {
                session_id,
                operation,
                inputs,
            } = parse(args)?;
            let _lock = LIFECYCLE.lock().await;
            output(providers::call(app, &session_id, &operation, inputs).await?)
        }
        "install_github" | "update" => {
            let result = change_github_package(app, action, args).await?;
            let _ = app.emit("plugins-changed", ());
            Ok(result)
        }
        "install" | "configure" | "uninstall" => {
            let _lock = LIFECYCLE.lock().await;
            let result = change_package(app, action, args).await?;
            let _ = app.emit("plugins-changed", ());
            Ok(result)
        }
        _ => Err(format!("Unknown plugin request: {action}")),
    }
}

async fn change_package(app: &AppHandle, action: &str, args: Value) -> Result<Value, String> {
    match action {
        "install" => {
            let PackagePath { path } = parse(args)?;
            let id = blocking({
                let path = path.clone();
                move || Ok(packages::validate(&path)?.id)
            })
            .await?;
            require_idle(app, &id)?;
            blocking(move || output(packages::install(&path, None)?)).await
        }
        "configure" => {
            let PluginConfig { id, config } = parse(args)?;
            require_idle(app, &id)?;
            blocking(move || output(packages::configure(&id, config)?)).await
        }
        "uninstall" => {
            let id = required_id(&args)?.to_owned();
            require_idle(app, &id)?;
            blocking(move || {
                packages::uninstall(&id)?;
                Ok(Value::Null)
            })
            .await
        }
        _ => unreachable!(),
    }
}

async fn change_github_package(
    app: &AppHandle,
    action: &str,
    args: Value,
) -> Result<Value, String> {
    let (repo, expected_id) = if action == "update" {
        let id = required_id(&args)?.to_owned();
        let repo = packages::get(&id)?
            .source
            .ok_or("Install a newer local package to update this plugin")?;
        (repo, Some(id))
    } else {
        let GithubSource { repo } = parse(args)?;
        (repo, None)
    };
    // 下载和校验尚未触及安装目录，其他插件可以继续运行。
    let staged = packages::stage_github(&repo, expected_id.as_deref()).await?;
    let _lock = LIFECYCLE.lock().await;
    require_idle(app, &staged.id)?;
    if let Some(id) = expected_id {
        if packages::get(&id)?.source.as_deref() != Some(repo.as_str()) {
            return Err("The installed plugin source changed while downloading the update".into());
        }
    }
    blocking(move || output(staged.install()?)).await
}

pub(crate) async fn run_trigger(
    app: &AppHandle,
    id: String,
    action: String,
    device: Option<String>,
    inputs: Map<String, Value>,
    incident: Value,
) -> Result<String, String> {
    let _lock = LIFECYCLE.lock().await;
    let job = jobs::start(
        app,
        jobs::RunRequest {
            id,
            action,
            device,
            inputs,
        },
        "trigger",
        json!({"incident":incident}),
        None,
    )?;
    Ok(job.snapshot().id)
}

pub(crate) fn provider_logs(
    app: &AppHandle,
    session_id: &str,
    lines: usize,
) -> Option<Vec<String>> {
    providers::recent(app, session_id, lines)
}

pub(crate) async fn shutdown(app: &AppHandle) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        for session in providers::list(app, None) {
            let _ = providers::stop(app, &session.id).await;
        }
    })
    .await;
    jobs::shutdown(app).await;
}

pub fn worker_process(file: &Path, name: &str) -> std::process::ExitCode {
    match worker::run_worker(file, name) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            let _ = worker::emit(&json!({"type":"error","message":message}));
            std::process::ExitCode::FAILURE
        }
    }
}

fn require_idle(app: &AppHandle, id: &str) -> Result<(), String> {
    if jobs::active(app, id) || providers::active(app, id) {
        return Err(format!(
            "Stop actions and provider sessions for {id} before changing its installation"
        ));
    }
    Ok(())
}

fn optional_id(args: &Value) -> Result<Option<&str>, String> {
    match args.get("id") {
        Some(Value::String(id)) if !id.trim().is_empty() => Ok(Some(id)),
        Some(Value::Null) | None => Ok(None),
        _ => Err("Expected a plugin ID".into()),
    }
}

fn required_id(args: &Value) -> Result<&str, String> {
    optional_id(args)?.ok_or_else(|| "Expected a plugin ID".into())
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| e.to_string())
}

fn output<T: serde::Serialize>(result: T) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}
