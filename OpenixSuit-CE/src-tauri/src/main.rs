#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsString;
use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("ai") {
        let args = std::iter::once(OsString::from("openixsuit-ce ai"))
            .chain(std::env::args_os().skip(2));
        return openixsuit_ce_lib::ai_cli::run_from_args(args);
    }
    openixsuit_ce_lib::run();
    ExitCode::SUCCESS
}
