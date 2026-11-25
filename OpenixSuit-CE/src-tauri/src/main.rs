#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsString;
use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("ai") {
        let args =
            std::iter::once(OsString::from("openixsuit-ce ai")).chain(std::env::args_os().skip(2));
        return openixsuit_ce_lib::ai_cli::run_from_args(args);
    }
    if std::env::args().nth(1).as_deref() == Some("--plugin-worker") {
        let mut args = std::env::args_os().skip(2);
        let (Some(file), Some(name)) = (args.next(), args.next()) else {
            return ExitCode::FAILURE;
        };
        let Some(name) = name.to_str() else {
            return ExitCode::FAILURE;
        };
        return openixsuit_ce_lib::plugin_worker_process(std::path::Path::new(&file), name);
    }
    openixsuit_ce_lib::run();
    ExitCode::SUCCESS
}
