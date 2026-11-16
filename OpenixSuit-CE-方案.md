# OpenixSuit-CE 跨平台桌面应用开发方案

本文档面向项目接手与新人开发，覆盖环境搭建、目录规范、前后端完整架构、核心代码模板、IPC 接口定义、CI/CD 流水线以及分阶段验收标准。

---

## 一、新人上手与环境准备

### 1. 基础环境要求
- Node.js >= 20，npm >= 10
- Rust >= 1.75（Edition 2021）
- Tauri CLI：`cargo install tauri-cli --version "^2.0"`

### 2. 三平台系统依赖

**Linux (Ubuntu / Debian)**
```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config clang libclang-dev \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libusb-1.0-0-dev
```

**macOS (Intel / Apple Silicon)**
```bash
xcode-select --install
brew install libusb llvm
```

**Windows**
1. 安装 Visual Studio Build Tools（勾选 "使用 C++ 的桌面开发"）与 LLVM（用于 `bindgen`）。
2. 安装 WebView2 Runtime（Win10/11 通常已自带）。
3. 调试全志设备时，如默认驱动无法打开设备，使用 Zadig 将 `VID_1F3A&PID_EFE8` 替换为 `WinUSB` 或 `libusb-win32`。

### 3. 拉取底层 C/C++ 依赖
在 `src-tauri/libs/` 下引入开源依赖：
```bash
mkdir -p src-tauri/libs
git submodule add https://github.com/YuzukiTsuru/libefex.git src-tauri/libs/libefex
git submodule add https://github.com/YuzukiTsuru/OpenixIMG.git src-tauri/libs/OpenixIMG
```

---

## 二、完整项目目录结构

```text
OpenixSuit-CE/
├── .github/workflows/release.yml       # 三平台自动编译发布
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── index.html
├── src/                                # React 19 + TypeScript 前端
│   ├── main.tsx
│   ├── App.tsx                         # 主框架：顶栏 + 侧边栏 + 路由内容 + 日志抽屉
│   ├── store/settings.ts               # 主题、语言、USB 后端配置读写
│   ├── i18n/
│   │   ├── index.ts                    # i18next 配置（默认 zh-CN，支持 en-US）
│   │   ├── zh-CN.json
│   │   └── en-US.json
│   ├── components/
│   │   ├── TopBar.tsx                  # 连接状态指示、USB 后端切换、自检入口
│   │   ├── Sidebar.tsx                 # 可折叠侧边栏（220px / 60px，刷写时锁定）
│   │   └── LogDrawer.tsx               # 底部实时日志面板（支持导出 .log）
│   └── pages/
│       ├── FirmwareFlash.tsx           # 1. 一键刷机（拖拽 .img、分区勾选、进度条）
│       ├── EfelDebugger.tsx            # 2. EFEL 调试（Hex 读写 + Monaco 反汇编）
│       ├── GpioViewer.tsx              # 3. GPIO 查看器（PA~PG 引脚 MUX/PULL/DRV）
│       ├── FirmwareInspector.tsx       # 4. 固件与设备树分析（解包、GPT/MBR、DTS）
│       ├── AdbExplorer.tsx             # 5. ADB 文件管理器（双栏文件传输 + Shell）
│       └── DriverGuide.tsx             # 6. 驱动与环境自检助手
└── src-tauri/                          # Rust 后端与 FFI
    ├── Cargo.toml
    ├── build.rs                        # libefex / OpenixIMG 条件编译与 bindgen
    ├── tauri.conf.json                 # Tauri 2.x 配置（targets: "all"）
    ├── libs/
    │   ├── libefex/
    │   └── OpenixIMG/
    └── src/
        ├── main.rs
        ├── lib.rs                      # 注册全部 Command 与启动热插拔监听
        ├── state.rs                    # 全局状态（USB 后端、取消标志 AtomicBool）
        ├── hotplug/
        │   ├── mod.rs
        │   └── watcher.rs              # 原生回调 + 200ms 轮询双模热插拔
        ├── system/
        │   ├── mod.rs
        │   └── env_check.rs            # Windows/Linux/macOS 环境与驱动检测
        ├── efex/
        │   ├── mod.rs                  # 扫描、FEL 读写执行、FES 64KB 分块烧录
        │   └── ffi.rs                  # bindgen 生成的绑定封装
        ├── packer/
        │   └── mod.rs                  # IMAGEWTY 解析、分区提取、GPT/MBR、DTB->DTS
        ├── disasm/
        │   └── mod.rs                  # capstone 多架构反汇编
        ├── gpio/
        │   └── mod.rs                  # PIO 寄存器读写与位域解析
        └── adb/
            └── mod.rs                  # adb_client 扫描、文件管理、Shell
```

---

## 三、后端配置与核心实现

### 1. `src-tauri/Cargo.toml`

```toml
[package]
name = "openixsuit-ce"
version = "0.1.0"
edition = "2021"
description = "Cross-platform Allwinner firmware flashing and debugging tool"

[build-dependencies]
cc = "1.1"
bindgen = "0.70"
pkg-config = "0.3"

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
thiserror = "2"
rusb = "0.9"
capstone = "0.12"
adb_client = "2"
fdt = "0.1"
gptman = "1"
mbrman = "0.5"
dirs = "5"
```

### 2. `src-tauri/build.rs`

```rust
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=libs/libefex");
    println!("cargo:rerun-if-changed=libs/OpenixIMG");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // 1. 编译 libefex
    let mut efex_build = cc::Build::new();
    efex_build
        .include("libs/libefex/include")
        .file("libs/libefex/src/efex.c");

    match target_os.as_str() {
        "windows" => {
            efex_build.define("USE_WINUSB", None);
            println!("cargo:rustc-link-lib=winusb");
            println!("cargo:rustc-link-lib=setupapi");
        }
        "linux" => {
            let libusb = pkg_config::Config::new()
                .probe("libusb-1.0")
                .expect("libusb-1.0 not found via pkg-config");
            for path in libusb.include_paths {
                efex_build.include(path);
            }
        }
        "macos" => {
            for prefix in ["/opt/homebrew", "/usr/local"] {
                let inc = PathBuf::from(prefix).join("include/libusb-1.0");
                let lib = PathBuf::from(prefix).join("lib");
                if inc.exists() {
                    efex_build.include(inc);
                }
                if lib.exists() {
                    println!("cargo:rustc-link-search=native={}", lib.display());
                }
            }
            println!("cargo:rustc-link-lib=usb-1.0");
            println!("cargo:rustc-link-lib=framework=IOKit");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
        }
        _ => {}
    }
    efex_build.compile("efex");

    // 2. 编译 OpenixIMG
    cc::Build::new()
        .cpp(true)
        .include("libs/OpenixIMG/include")
        .file("libs/OpenixIMG/src/openiximg.cpp")
        .compile("openiximg");

    // 3. 生成 bindgen 绑定
    let bindings = bindgen::Builder::default()
        .header("libs/libefex/include/efex.h")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("Unable to generate libefex bindings");
    bindings
        .write_to_file(out_dir.join("efex_bindings.rs"))
        .expect("Couldn't write bindings");

    tauri_build::build();
}
```

### 3. `src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "OpenixSuit-CE",
  "version": "0.1.0",
  "identifier": "com.openixsuit.ce",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "OpenixSuit-CE",
        "width": 1280,
        "height": 800,
        "minWidth": 1024,
        "minHeight": 680
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

### 4. `src-tauri/src/lib.rs`（Command 注册与状态管理）

```rust
mod adb;
mod disasm;
mod efex;
mod gpio;
mod hotplug;
mod packer;
mod state;
mod system;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            hotplug::watcher::start_hotplug_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // efex
            efex::scan_devices,
            efex::set_usb_backend,
            efex::fel_read_mem,
            efex::fel_write_mem,
            efex::fel_exec,
            efex::fes_query_storage,
            efex::fes_download_partition,
            efex::cancel_flash,
            // packer
            packer::inspect_image,
            packer::extract_partition,
            packer::read_partition_table,
            packer::dtb_to_dts,
            // disasm
            disasm::disassemble_bytes,
            // gpio
            gpio::read_pio_port,
            gpio::write_pio_pin,
            // adb
            adb::adb_list_devices,
            adb::adb_list_dir,
            adb::adb_push_file,
            adb::adb_pull_file,
            adb::adb_exec_shell,
            // system
            system::env_check::check_system_env,
            system::settings::load_settings,
            system::settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 5. `src-tauri/src/hotplug/watcher.rs`

```rust
use rusb::{Context, Device, Hotplug, HotplugBuilder, UsbContext};
use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const ALLWINNER_VID: u16 = 0x1f3a;
const ALLWINNER_PID: u16 = 0xefe8;

#[derive(Clone, Serialize)]
pub struct UsbHotplugPayload {
    pub connected: bool,
    pub count: usize,
    pub devices: Vec<String>,
}

struct SunxiHotplugHandler {
    app: AppHandle,
}

impl<T: UsbContext> Hotplug<T> for SunxiHotplugHandler {
    fn device_arrived(&mut self, _device: Device<T>) {
        emit_current_devices(&self.app);
    }

    fn device_left(&mut self, _device: Device<T>) {
        emit_current_devices(&self.app);
    }
}

fn scan_sunxi_devices() -> Vec<String> {
    let mut list = Vec::new();
    if let Ok(devices) = rusb::devices() {
        for dev in devices.iter() {
            if let Ok(desc) = dev.device_descriptor() {
                if desc.vendor_id() == ALLWINNER_VID && desc.product_id() == ALLWINNER_PID {
                    list.push(format!("bus:{}-addr:{}", dev.bus_number(), dev.address()));
                }
            }
        }
    }
    list
}

fn emit_current_devices(app: &AppHandle) {
    let devices = scan_sunxi_devices();
    let _ = app.emit(
        "usb-hotplug",
        UsbHotplugPayload {
            connected: !devices.is_empty(),
            count: devices.len(),
            devices,
        },
    );
}

pub fn start_hotplug_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        if rusb::has_hotplug() {
            if let Ok(ctx) = Context::new() {
                let _reg = HotplugBuilder::new()
                    .vendor_id(ALLWINNER_VID)
                    .product_id(ALLWINNER_PID)
                    .enumerate(true)
                    .register(&ctx, Box::new(SunxiHotplugHandler { app: app.clone() }));
                loop {
                    let _ = ctx.handle_events(Some(Duration::from_millis(200)));
                }
            }
        }

        // Fallback: 200ms 轮询对比
        let mut last_set: HashSet<String> = HashSet::new();
        loop {
            let current = scan_sunxi_devices();
            let current_set: HashSet<String> = current.iter().cloned().collect();
            if current_set != last_set {
                last_set = current_set;
                let _ = app.emit(
                    "usb-hotplug",
                    UsbHotplugPayload {
                        connected: !current.is_empty(),
                        count: current.len(),
                        devices: current,
                    },
                );
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}
```

### 6. `src-tauri/src/system/env_check.rs`

```rust
use serde::Serialize;
use std::path::Path;
use std::process::Command;

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
        let has_udev = Path::new("/etc/udev/rules.d/99-allwinner.rules").exists();
        return EnvCheckReport {
            os: "linux".into(),
            ok: has_udev,
            summary: if has_udev {
                "已检测到 Allwinner udev 规则".into()
            } else {
                "未检测到 /etc/udev/rules.d/99-allwinner.rules，普通用户可能无权访问 USB".into()
            },
            fix_hint: "echo 'SUBSYSTEM==\"usb\", ATTR{idVendor}==\"1f3a\", ATTR{idProduct}==\"efe8\", MODE=\"0666\"' | sudo tee /etc/udev/rules.d/99-allwinner.rules && sudo udevadm control --reload-rules".into(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("pnputil")
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
        let has_libusb = Path::new("/opt/homebrew/lib/libusb-1.0.dylib").exists()
            || Path::new("/usr/local/lib/libusb-1.0.dylib").exists();
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
```

### 7. 各业务模块实现规范（给新人的开发指引）

- **`efex/`**：
  - `fes_download_partition`：在 `tokio::spawn` 中按 `65536` 字节（64KB）分块读取分区文件并写入设备；每次写入前检查 `state.cancel_flag.load(Ordering::Relaxed)`，为 `true` 时立即中止并返回取消错误；每块写入后通过 `app.emit("flash-progress", { partition, written, total })` 推送进度。
- **`disasm/`**：
  - `disassemble_bytes(arch: "arm32" | "aarch64" | "riscv64", base_addr: u64, bytes: Vec<u8>)`：使用 `capstone::Capstone::new()` 对应架构构建反汇编器，返回 `Vec<{ address: String, mnemonic: String, op_str: String }>`。
- **`gpio/`**：
  - 全志 PIO 控制器每个 Port（PA=0, PB=1...）占 `0x24` 字节偏移：
    - `CFG0~CFG3`（偏移 `0x00~0x0C`）：每引脚占 4 bit（MUX 功能）。
    - `DAT`（偏移 `0x10`）：每引脚 1 bit。
    - `DRV0~DRV1`（偏移 `0x14~0x18`）：每引脚 2 bit（驱动能力）。
    - `PUL0~PUL1`（偏移 `0x1C~0x20`）：每引脚 2 bit（上下拉）。
  - 通过 `fel_read_mem` 读出 `base_addr + port * 0x24` 的 36 字节即可在前端渲染完整引脚状态。
- **`packer/`**：
  - 用 `OpenixIMG` FFI 读取 `.img` 头部与分区表，用 `fdt::Fdt::new(&dtb_bytes)` 递归遍历节点与属性拼接成 `.dts` 文本。
- **`adb/`**：
  - 使用 `adb_client::ADBServerDevice` 或 USB 直连接口实现 `list_dir` / `push` / `pull` / `shell_command`，无需捆绑外部 `adb` 二进制。

---

## 四、GitHub Actions 跨平台自动构建流水线

`.github/workflows/release.yml`：

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  publish-tauri:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: ubuntu-22.04
            args: ""
          - platform: windows-latest
            args: ""
          - platform: macos-latest
            args: "--target universal-apple-darwin"

    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - name: Install Linux deps
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libusb-1.0-0-dev

      - name: Install macOS deps
        if: matrix.platform == 'macos-latest'
        run: brew install libusb

      - name: Install frontend deps
        run: npm ci

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "OpenixSuit-CE ${{ github.ref_name }}"
          releaseDraft: true
          args: ${{ matrix.args }}
```

---

## 五、前端核心代码与页面规范

### 1. `package.json` 核心依赖

```json
{
  "dependencies": {
    "@monaco-editor/react": "^4.6.0",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "@tauri-apps/plugin-fs": "^2.0.0",
    "i18next": "^23.15.0",
    "lucide-react": "^0.450.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-i18next": "^15.0.0"
  },
  "devDependencies": {
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

### 2. `src/App.tsx`（含主题、语言、日志抽屉）

```tsx
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sidebar, TabKey } from "./components/Sidebar";
import { DriverGuide } from "./pages/DriverGuide";

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("flash");
  const [collapsed, setCollapsed] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [usbStatus, setUsbStatus] = useState<"disconnected" | "connected">("disconnected");
  const [logs, setLogs] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    const unlisten = listen<{ connected: boolean }>("usb-hotplug", (event) => {
      const status = event.payload.connected ? "connected" : "disconnected";
      setUsbStatus(status);
      setLogs((prev) => [...prev, `[USB] 状态变更: ${status}`]);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex h-12 items-center justify-between border-b border-slate-800 px-4">
        <div className="font-semibold">OpenixSuit-CE</div>
        <div className="flex items-center gap-3 text-sm">
          <span>{usbStatus === "connected" ? "设备已连接 (FEL/FES)" : "未连接设备"}</span>
          <button
            onClick={() => setActiveTab("driver")}
            className="rounded bg-slate-800 px-2.5 py-1 hover:bg-slate-700"
          >
            环境自检
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          collapsed={collapsed}
          locked={isFlashing}
          onSelect={setActiveTab}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
        <main className="flex-1 overflow-auto p-6">
          {activeTab === "driver" && <DriverGuide />}
          {activeTab !== "driver" && (
            <div className="text-slate-400">当前模块：{activeTab}（按第四节接口规范接入）</div>
          )}
        </main>
      </div>

      <footer className="border-t border-slate-800 bg-slate-900">
        <button
          onClick={() => setLogOpen((o) => !o)}
          className="w-full px-4 py-1.5 text-left text-xs text-slate-400 hover:text-white"
        >
          {logOpen ? "▼ 收起实时日志" : `▲ 展开实时日志 (${logs.length})`}
        </button>
        {logOpen && (
          <div className="h-40 overflow-y-auto bg-slate-950 p-3 font-mono text-xs text-slate-300">
            {logs.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
```

### 3. `src/components/Sidebar.tsx`

```tsx
export type TabKey = "flash" | "debugger" | "gpio" | "inspector" | "adb" | "driver";

interface SidebarProps {
  activeTab: TabKey;
  collapsed: boolean;
  locked: boolean;
  onSelect: (tab: TabKey) => void;
  onToggleCollapse: () => void;
}

const ITEMS: { key: TabKey; label: string; short: string }[] = [
  { key: "flash", label: "一键刷机", short: "刷机" },
  { key: "debugger", label: "EFEL 调试", short: "调试" },
  { key: "gpio", label: "GPIO 查看器", short: "GPIO" },
  { key: "inspector", label: "固件与设备树", short: "固件" },
  { key: "adb", label: "ADB 文件管理", short: "ADB" },
  { key: "driver", label: "驱动与环境助手", short: "环境" },
];

export function Sidebar({ activeTab, collapsed, locked, onSelect, onToggleCollapse }: SidebarProps) {
  return (
    <aside
      style={{ width: collapsed ? 60 : 220 }}
      className="flex flex-col border-r border-slate-800 bg-slate-900 transition-all"
    >
      <button
        disabled={locked}
        onClick={onToggleCollapse}
        className="border-b border-slate-800 p-3 text-left text-xs text-slate-400 hover:text-white disabled:opacity-50"
      >
        {collapsed ? ">>" : "<< 收起侧边栏"}
      </button>
      <nav className="flex-1 space-y-1 p-2">
        {ITEMS.map((item) => (
          <button
            key={item.key}
            disabled={locked}
            onClick={() => onSelect(item.key)}
            className={`w-full rounded px-3 py-2 text-left text-sm disabled:opacity-50 ${
              activeTab === item.key ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {collapsed ? item.short : item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
```

### 4. `src/pages/DriverGuide.tsx`

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface EnvCheckReport {
  os: string;
  ok: boolean;
  summary: string;
  fix_hint: string;
}

export function DriverGuide() {
  const [report, setReport] = useState<EnvCheckReport | null>(null);

  const runCheck = async () => {
    const res = await invoke<EnvCheckReport>("check_system_env");
    setReport(res);
  };

  useEffect(() => {
    runCheck();
  }, []);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">驱动与环境自检助手</h2>
        <button onClick={runCheck} className="rounded bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-500">
          重新检测
        </button>
      </div>
      {report && (
        <div className="space-y-3 rounded border border-slate-800 bg-slate-900 p-4 text-sm">
          <div>当前系统：{report.os}</div>
          <div>检测结果：{report.ok ? "正常" : "需要配置"} — {report.summary}</div>
          <pre className="overflow-x-auto rounded bg-slate-950 p-3 text-xs text-emerald-400">
            {report.fix_hint}
          </pre>
        </div>
      )}
    </div>
  );
}
```

---

## 六、开发里程碑与验收清单

- **阶段 P0（骨架与 FFI 跑通）**：三平台 `cargo tauri dev` 启动成功；`scan_devices` 能识别 `1f3a:efe8`；热插拔事件在前端实时刷新。
- **阶段 P1（核心刷机）**：`FirmwareFlash` 支持拖入 `.img`、勾选分区、64KB 分块烧录与进度条显示、支持中途取消。
- **阶段 P2（调试与分析）**：`EfelDebugger`（Hex + Capstone 反汇编）、`GpioViewer`（PIO 位域解析）、`FirmwareInspector`（解包 + DTB 转 DTS）。
- **阶段 P3（ADB 与发布）**：`AdbExplorer` 双栏文件传输；`i18next` 中英文切换与主题持久化；GitHub Actions 推送 tag 自动产出三平台安装包。
