use super::packages::{package_dir, package_file, Action, Entry, Installed, ProcessProtocol};
use rquickjs::{CatchResultExt, Context, Function, Module, Promise, Runtime, Value as JsValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

const MAX_FRAME: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Frame {
    Log {
        message: String,
    },
    Progress {
        value: f64,
    },
    Result {
        value: Value,
    },
    Error {
        message: String,
    },
    Call {
        id: u64,
        method: String,
        #[serde(default)]
        args: Value,
    },
}

#[derive(Serialize)]
struct Response {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u64,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
}

pub(super) struct Process {
    child: Child,
    stdin: Option<tokio::process::ChildStdin>,
    pub(super) protocol: ProcessProtocol,
    stdout: BufReader<tokio::process::ChildStdout>,
    stderr: Option<BufReader<tokio::process::ChildStderr>>,
    pid: Option<u32>,
}

impl Process {
    pub(super) fn launch(
        installed: &Installed,
        action: &Action,
        inputs: &Map<String, Value>,
    ) -> Result<Self, String> {
        let directory = package_dir(&installed.manifest.id)?;
        let (mut command, protocol) = match &action.entry {
            Entry::Javascript { file, export_name } => {
                let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
                child
                    .arg("--plugin-worker")
                    .arg(package_file(&directory, file)?)
                    .arg(export_name);
                (child, ProcessProtocol::Ndjson)
            }
            Entry::Process {
                program,
                binding,
                interpreter,
                interpreter_args,
                args,
                platforms,
                protocol,
            } => {
                let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
                let configured = binding
                    .as_ref()
                    .or(interpreter.as_ref())
                    .and_then(|key| installed.bindings.get(key));
                let local_program = binding
                    .as_ref()
                    .and_then(|key| installed.bindings.get(key))
                    .and_then(|entry| entry.program.as_deref());
                let program = if let Some(relative) = platforms.get(&platform).or(program.as_ref())
                {
                    package_file(&directory, relative)?
                } else {
                    executable(
                        local_program,
                        "program",
                        binding.as_deref().unwrap_or(&platform),
                    )?
                };
                let mut child = if let Some(interpreter) = interpreter {
                    let path = configured
                        .and_then(|entry| entry.interpreter.as_deref())
                        .or_else(|| {
                            installed
                                .bindings
                                .get(interpreter)
                                .and_then(|entry| entry.interpreter.as_deref())
                        });
                    let mut child = Command::new(executable(path, "interpreter", interpreter)?);
                    child.args(interpreter_args).arg(program);
                    child
                } else if let Some(path) = configured.and_then(|entry| entry.interpreter.as_deref())
                {
                    let mut child = Command::new(executable(Some(path), "interpreter", "binding")?);
                    child.args(interpreter_args).arg(program);
                    child
                } else {
                    Command::new(program)
                };
                child.args(expand_args(args, inputs)?);
                (child, *protocol)
            }
        };
        let stdin = if protocol == ProcessProtocol::Stdio {
            std::process::Stdio::null()
        } else {
            std::process::Stdio::piped()
        };
        command.current_dir(directory);
        command
            .stdin(stdin)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start plugin action {}: {e}", action.id))?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().ok_or("Plugin stdout unavailable")?);
        let stderr = Some(BufReader::new(
            child.stderr.take().ok_or("Plugin stderr unavailable")?,
        ));
        Ok(Self {
            child,
            stdin,
            protocol,
            stdout,
            stderr,
            pid,
        })
    }

    pub(super) fn take_stderr(&mut self) -> Option<BufReader<tokio::process::ChildStderr>> {
        self.stderr.take()
    }

    pub(super) async fn send(&mut self, value: impl Serialize) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_FRAME {
            return Err("Plugin request exceeds 1 MiB".into());
        }
        bytes.push(b'\n');
        self.stdin
            .as_mut()
            .ok_or("Plugin stdin unavailable")?
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())
    }

    pub(super) async fn reply(
        &mut self,
        id: u64,
        result: Result<Value, String>,
    ) -> Result<(), String> {
        let (value, error) = match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        self.send(Response {
            kind: "response",
            id,
            ok: error.is_none(),
            value,
            error,
        })
        .await
    }

    pub(super) async fn text(&mut self) -> Result<Option<String>, String> {
        read_line(&mut self.stdout).await
    }

    pub(super) async fn frame(&mut self) -> Result<Option<Frame>, String> {
        match read_line(&mut self.stdout).await? {
            Some(line) => serde_json::from_str(&line)
                .map(Some)
                .map_err(|e| format!("Invalid plugin message: {e}")),
            None => Ok(None),
        }
    }

    pub(super) async fn wait(&mut self) -> Result<(), String> {
        let status = self.child.wait().await.map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Plugin process exited with {status}"))
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.take() {
            // 子进程使用自己的进程组，停止时同时清理它启动的程序。
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = self.child.id() {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
        let _ = self.child.start_kill();
    }
}

pub(super) async fn read_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take((MAX_FRAME + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_FRAME {
        return Err("Plugin message exceeds 1 MiB".into());
    }
    Ok(Some(
        String::from_utf8_lossy(&bytes)
            .trim_end_matches(['\r', '\n'])
            .to_string(),
    ))
}

fn expand_args(args: &[String], inputs: &Map<String, Value>) -> Result<Vec<String>, String> {
    args.iter()
        .map(|arg| {
            let Some(field) = arg
                .strip_prefix("{{input.")
                .and_then(|key| key.strip_suffix("}}"))
            else {
                return Ok(arg.clone());
            };
            match inputs.get(field) {
                Some(Value::String(value)) => Ok(value.clone()),
                Some(value @ (Value::Bool(_) | Value::Number(_))) => Ok(value.to_string()),
                _ => Err(format!(
                    "Plugin argument '{field}' requires a text, number or boolean input"
                )),
            }
        })
        .collect()
}

fn executable(path: Option<&Path>, kind: &str, key: &str) -> Result<PathBuf, String> {
    let path = path
        .filter(|path| path.is_absolute() && path.is_file())
        .ok_or_else(|| format!("Configure an absolute path for plugin {kind} '{key}'"))?;
    Ok(path.to_path_buf())
}

pub(crate) fn run_worker(file: &Path, name: &str) -> Result<(), String> {
    let source = std::fs::read(file).map_err(|e| format!("Cannot load plugin module: {e}"))?;
    let mut input = io::BufReader::new(io::stdin());
    let request = read_request(&mut input)?;
    let request = request.to_string();
    let port = Rc::new(RefCell::new(input));
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(96 * 1024 * 1024);
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    context.with(|cx| {
        let execute = || -> rquickjs::Result<JsValue<'_>> {
            let globals = cx.globals();
            let mut seq = 0u64;
            globals.set("__openix_call", Function::new(cx.clone(), rquickjs::function::MutFn::new(
                move |method: String, args: String| -> String {
                    seq += 1;
                    let result: Result<Value, String> = (|| {
                        let args = serde_json::from_str::<Value>(&args).map_err(|e| e.to_string())?;
                        emit(&json!({"type":"call","id":seq,"method":method,"args":args}))?;
                        let response = read_request(&mut *port.borrow_mut())?;
                        if response["type"] != "response" || response["id"] != seq {
                            return Err("Invalid host response".into());
                        }
                        Ok(response)
                    })();
                    result.unwrap_or_else(|error| json!({"ok":false,"error":error})).to_string()
                },
            ))?)?;
            globals.set("__openix_log", Function::new(cx.clone(), |message: String| {
                let _ = emit(&json!({"type":"log","message":message}));
            })?)?;
            globals.set("__openix_progress", Function::new(cx.clone(), |value: f64| {
                let _ = emit(&json!({"type":"progress","value":value}));
            })?)?;
            globals.set("__openix_sleep", Function::new(cx.clone(), |ms: u32| {
                std::thread::sleep(Duration::from_millis(u64::from(ms.min(60_000))));
            })?)?;
            let host: JsValue<'_> = cx.eval(
                "Object.freeze({call:(method,args={})=>{const reply=JSON.parse(__openix_call(method,JSON.stringify(args)));if(!reply.ok)throw new Error(reply.error);return reply.value;}, log:(x)=>__openix_log(String(x)), progress:__openix_progress, sleep:__openix_sleep})"
            )?;
            let argument = cx.json_parse(request)?;
            let (module, evaluated) = Module::declare(cx.clone(), "openix-plugin.js", source)?.eval()?;
            evaluated.finish::<()>()?;
            let function: Function = module.get(name)?;
            let result: JsValue = function.call((argument, host))?;
            match result.as_promise() {
                Some(promise) => Promise::finish(promise),
                None => Ok(result),
            }
        };
        let value = execute().catch(&cx).map_err(|e| e.to_string())?;
        let encoded = cx.json_stringify(value).catch(&cx).map_err(|e| e.to_string())?
            .map(|s| s.to_string()).transpose().map_err(|e| e.to_string())?;
        let value = serde_json::from_str::<Value>(encoded.as_deref().unwrap_or("null"))
            .map_err(|e| e.to_string())?;
        emit(&json!({"type":"result","value":value}))
    })
}

fn read_request(input: &mut impl BufRead) -> Result<Value, String> {
    let mut line = String::new();
    let count = std::io::Read::take(input, (MAX_FRAME + 1) as u64)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if count == 0 || count > MAX_FRAME {
        return Err("Invalid plugin input frame length".into());
    }
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

pub(crate) fn emit(message: &Value) -> Result<(), String> {
    let mut out = io::stdout().lock();
    let bytes = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if bytes.len() >= MAX_FRAME {
        return Err("Plugin output exceeds 1 MiB".into());
    }
    out.write_all(&bytes)
        .and_then(|_| out.write_all(b"\n"))
        .and_then(|_| out.flush())
        .map_err(|e| e.to_string())
}
