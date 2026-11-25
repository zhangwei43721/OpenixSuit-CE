use super::{absolute_path, read_json_object, send_http};
use crate::plugins::packages;
use clap::Subcommand;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Subcommand)]
pub(super) enum PluginCommand {
    /// Validate a source directory or archive without connecting to the desktop app
    Validate {
        #[arg(value_parser=absolute_path)]
        path: PathBuf,
    },
    /// Validate and pack a source directory into a .oixplugin archive
    Pack {
        #[arg(value_parser=absolute_path)]
        path: PathBuf,
        #[arg(value_parser=absolute_path)]
        output: PathBuf,
    },
    /// List installed plugins and their capabilities
    List,
    /// Show a plugin's actions, input/output fields, providers and settings
    Describe { id: String },
    /// Install a local directory, archive or a release from GitHub
    Install {
        #[arg(required_unless_present="github", conflicts_with="github", value_parser=absolute_path)]
        path: Option<PathBuf>,
        #[arg(long, value_name = "OWNER/REPO")]
        github: Option<String>,
    },
    /// Update a plugin installed from GitHub
    Update { id: String },
    /// Save settings, permissions or program bindings. Use - to read JSON from stdin.
    Configure { id: String, json_file: PathBuf },
    /// Uninstall a plugin
    Uninstall { id: String },
    /// Start an action and return its run ID
    Run {
        id: String,
        action: String,
        #[arg(long)]
        device: Option<String>,
        #[arg(long, conflicts_with = "inputs_file")]
        inputs: Option<String>,
        #[arg(long, value_name = "PATH")]
        inputs_file: Option<PathBuf>,
    },
    /// List running and completed actions
    Runs {
        #[arg(long)]
        id: Option<String>,
    },
    /// Read an action's status, logs, result or pending confirmation
    Show { run_id: String },
    /// Confirm a pending host operation from a run's displayed plan
    Confirm { run_id: String, token: String },
    /// Stop a running action or decline its pending operation
    Cancel { run_id: String },
    /// List active and recently stopped provider sessions
    ProviderList {
        #[arg(long)]
        id: Option<String>,
    },
    /// Start a plugin's persistent log, device or power connection
    ProviderStart {
        id: String,
        provider: String,
        #[arg(long)]
        device: Option<String>,
        #[arg(long, conflicts_with = "inputs_file")]
        inputs: Option<String>,
        #[arg(long, value_name = "PATH")]
        inputs_file: Option<PathBuf>,
    },
    /// Run a supported operation on an active provider session
    ProviderCall {
        session_id: String,
        operation: String,
        #[arg(long, conflicts_with = "inputs_file")]
        inputs: Option<String>,
        #[arg(long, value_name = "PATH")]
        inputs_file: Option<PathBuf>,
    },
    /// Stop a provider session and its reconnection loop
    ProviderStop { session_id: String },
}

pub(super) fn run(addr: &str, command: PluginCommand) -> ExitCode {
    let result = execute(addr, command);
    let (success, envelope) = match result {
        Ok(envelope) => (envelope["ok"] == true, envelope),
        Err(error) => (false, json!({"ok":false,"error":error})),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).unwrap_or_else(|_| envelope.to_string())
    );
    if success {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn execute(addr: &str, command: PluginCommand) -> Result<Value, String> {
    let (action, args) = match command {
        PluginCommand::Validate { path } => {
            return Ok(json!({"ok":true,"data":packages::validate(&path)?}));
        }
        PluginCommand::Pack { path, output } => {
            return Ok(json!({"ok":true,"data":packages::pack(&path,&output)?}));
        }
        PluginCommand::List => ("list", json!({})),
        PluginCommand::Describe { id } => ("describe", json!({"id":id})),
        PluginCommand::Install { path, github: None } => ("install", json!({"path":path})),
        PluginCommand::Install {
            github: Some(repo), ..
        } => ("install_github", json!({"repo":repo})),
        PluginCommand::Update { id } => ("update", json!({"id":id})),
        PluginCommand::Configure { id, json_file } => (
            "configure",
            json!({"id":id,"config":read_json_object(&json_file)?}),
        ),
        PluginCommand::Uninstall { id } => ("uninstall", json!({"id":id})),
        PluginCommand::Run {
            id,
            action,
            device,
            inputs,
            inputs_file,
        } => (
            "run",
            json!({"id":id,"action":action,"device":device,"inputs":input_object(inputs,inputs_file)?}),
        ),
        PluginCommand::Runs { id } => ("runs", json!({"id":id})),
        PluginCommand::Show { run_id } => ("run_get", json!({"run_id":run_id})),
        PluginCommand::Confirm { run_id, token } => {
            ("confirm", json!({"run_id":run_id,"token":token}))
        }
        PluginCommand::Cancel { run_id } => ("cancel", json!({"run_id":run_id})),
        PluginCommand::ProviderList { id } => ("providers", json!({"id":id})),
        PluginCommand::ProviderStart {
            id,
            provider,
            device,
            inputs,
            inputs_file,
        } => (
            "provider_start",
            json!({"id":id,"provider":provider,"device":device,"inputs":input_object(inputs,inputs_file)?}),
        ),
        PluginCommand::ProviderCall {
            session_id,
            operation,
            inputs,
            inputs_file,
        } => (
            "provider_call",
            json!({"session_id":session_id,"operation":operation,"inputs":input_object(inputs,inputs_file)?}),
        ),
        PluginCommand::ProviderStop { session_id } => {
            ("provider_stop", json!({"session_id":session_id}))
        }
    };
    let (_, result) = send_http(
        addr,
        "POST",
        "/api/plugin",
        Some(json!({"action":action,"args":args})),
    )?;
    Ok(result)
}

fn input_object(
    inline: Option<String>,
    file: Option<PathBuf>,
) -> Result<Map<String, Value>, String> {
    if let Some(file) = file {
        return read_json_object(&file);
    }
    inline
        .map(|value| {
            serde_json::from_str(&value).map_err(|e| format!("Invalid --inputs JSON object: {e}"))
        })
        .unwrap_or_else(|| Ok(Map::new()))
}
