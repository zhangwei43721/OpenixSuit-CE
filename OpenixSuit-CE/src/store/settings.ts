import { invoke } from "@tauri-apps/api/core";

export type UsbBackend = "auto" | "winusb" | "libusb";
export type ThemeMode = "system" | "dark" | "light";

export interface AppSettings {
  language: "zh-CN" | "en-US";
  theme: ThemeMode;
  usb_backend: UsbBackend;
}

export async function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}
