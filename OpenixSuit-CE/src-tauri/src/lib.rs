mod adb;
mod disasm;
mod efex;
mod gpio;
mod hotplug;
mod packer;
mod state;
mod system;

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
            efex::cancel_flash,
            // packer
            packer::inspect_image,
            packer::extract_partition,
            packer::export_mbr_binary,
            packer::read_partition_table,
            packer::convert_firmware,
            packer::dtb_to_dts,
            // disasm
            disasm::disassemble_bytes,
            // gpio
            gpio::read_pio_port,
            gpio::write_pio_pin,
            gpio::adb_detect_gpio,
            gpio::adb_set_gpio,
            // adb
            adb::adb_list_devices,
            adb::adb_list_dir,
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
            // system
            system::env_check::check_system_env,
            system::settings::load_settings,
            system::settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
