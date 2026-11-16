use serde::Serialize;

#[derive(Serialize)]
pub struct EnvCheckReport {
    pub os: String,
    pub ok: bool,
    pub summary: String,
    pub fix_hint: String,
}

#[tauri::command]
pub fn check_system_env() -> EnvCheckReport {
    #[cfg(target_os = "linux")]
    {
        let has_udev = std::path::Path::new("/etc/udev/rules.d/99-allwinner.rules").exists();
        return EnvCheckReport {
            os: "linux".into(),
            ok: has_udev,
            summary: if has_udev {
                "已检测到 Allwinner udev 规则".into()
            } else {
                "未检测到 /etc/udev/rules.d/99-allwinner.rules，普通用户可能无权访问 USB".into()
            },
            fix_hint: "echo 'ACTION==\"add\", SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"1f3a\", ATTRS{idProduct}==\"efe8\", MODE=\"0666\", GROUP=\"users\", TEST==\"power/autosuspend\", ATTR{power/autosuspend}=\"-1\"' | sudo tee /etc/udev/rules.d/99-allwinner.rules && sudo udevadm control --reload-rules".into(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("pnputil")
            .args(["/enum-devices", "/connected", "/instanceid", "*VID_1F3A*"])
            .output();
        let ok = output
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("1F3A"))
            .unwrap_or(false);
        return EnvCheckReport {
            os: "windows".into(),
            ok,
            summary: if ok {
                "检测到 1f3a:efe8 设备".into()
            } else {
                "未检测到已绑定 WinUSB 的 1f3a:efe8 设备".into()
            },
            fix_hint: "请使用 Zadig 将 USB Device (1F3A:EFE8) 驱动替换为 WinUSB，或在设置中切换 libusb 后端。".into(),
        };
    }

    #[cfg(target_os = "macos")]
    {
        let has_libusb = std::path::Path::new("/opt/homebrew/lib/libusb-1.0.dylib").exists()
            || std::path::Path::new("/usr/local/lib/libusb-1.0.dylib").exists();
        return EnvCheckReport {
            os: "macos".into(),
            ok: has_libusb,
            summary: if has_libusb {
                "已检测到 Homebrew libusb".into()
            } else {
                "未检测到 libusb 动态库".into()
            },
            fix_hint: "brew install libusb".into(),
        };
    }
}
