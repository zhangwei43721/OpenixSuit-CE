mod adb;
mod adb_log;
pub mod ai_cli;
mod disasm;
mod efex;
mod gpio;
mod hotplug;
mod ipc_server;
mod log_capture;
mod log_profiles;
mod log_sessions;
mod log_ui;
mod monitor;
mod packer;
mod plugins;
mod power;
mod serial;
mod state;
mod system;
mod triggers;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = win.set_icon(icon);
                }
            }
            hotplug::watcher::start_hotplug_watcher(app.handle().clone());
            ipc_server::start_ipc_server(app.handle().clone());
            triggers::start_trigger_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // efex
            efex::scan_devices,
            efex::set_usb_backend,
            efex::fel_read_mem,
            efex::fel_write_mem,
            efex::fel_write_file,
            efex::fel_exec,
            efex::fel_init_dram,
            efex::fes_query_storage,
            efex::fes_tool_mode,
            efex::fes_download_partition,
            efex::flash_firmware_full,
            efex::flash_custom_mbr_layout,
            efex::raw_flash_image,
            efex::cancel_flash,
            // packer
            packer::inspect_image,
            packer::extract_partition,
            packer::export_mbr_binary,
            packer::read_partition_table,
            packer::convert_firmware,
            packer::unpack_firmware,
            packer::dtb_to_dts,
            // disasm
            disasm::disassemble_bytes,
            // gpio
            gpio::read_pio_port,
            gpio::write_pio_pin,
            gpio::adb_detect_gpio,
            gpio::adb_detect_gpio_port,
            gpio::adb_set_gpio,
            // adb
            adb::adb_list_devices,
            adb::adb_list_dir,
            adb::adb_list_dir_detailed,
            adb::adb_push_file,
            adb::adb_pull_file,
            adb::adb_exec_shell,
            adb::adb_root,
            adb::adb_reboot,
            adb::adb_reboot_efex,
            adb::adb_mkdir,
            adb::adb_delete,
            adb::adb_rename,
            adb::adb_copy,
            adb::adb_read_text,
            adb::adb_write_text,
            adb::adb_term_open,
            adb::adb_term_write,
            adb::adb_term_resize,
            adb::adb_term_close,
            adb::adb_screen_info,
            adb::adb_screencap_png,
            adb::adb_input_tap,
            adb::adb_input_swipe,
            adb::adb_input_keyevent,
            adb_log::adb_log_open,
            adb_log::adb_log_close,
            // serial
            serial::serial_list_ports,
            serial::serial_open,
            serial::serial_close,
            serial::serial_list_sessions,
            serial::serial_write,
            serial::serial_write_bytes,
            serial::serial_set_signals,
            serial::serial_get_buffer,
            serial::serial_list_log_files,
            serial::serial_read_log_file,
            serial::bridge::serial_bridge_start,
            serial::bridge::serial_bridge_status,
            serial::bridge::serial_bridge_stop,
            log_capture::log_capture_get,
            log_capture::log_capture_save,
            log_ui::log_ui_reply,
            log_profiles::log_profiles_list,
            log_profiles::log_profile_save,
            log_sessions::log_sessions_list,
            log_sessions::log_session_start,
            log_sessions::log_session_stop,
            log_sessions::log_profile_bridge_start,
            // power
            power::power_list_profiles,
            power::power_save_profiles,
            power::power_execute,
            // triggers
            triggers::trigger_list_rules,
            triggers::trigger_save_rules,
            triggers::trigger_test_rule,
            triggers::trigger_list_incidents,
            triggers::trigger_clear_incidents,
            // monitor & workspaces & flash history
            monitor::adb_get_metrics,
            monitor::adb_storage_mount,
            monitor::workspace_list,
            monitor::workspace_save,
            monitor::flash_history_list,
            monitor::flash_history_add,
            monitor::flash_history_delete,
            monitor::flash_history_clear,
            // system
            system::env_check::check_system_env,
            system::settings::load_settings,
            system::settings::save_settings,
            // plugins
            plugins::list_plugins,
            plugins::install_plugin,
            plugins::uninstall_plugin,
            plugins::run_plugin,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                tauri::async_runtime::block_on(adb_log::stop_all(&app.state::<AppState>()));
            }
        });
}
