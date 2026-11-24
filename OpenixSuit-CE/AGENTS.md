# AGENTS.md

本文件为 AI 编码助手在 `OpenixSuit-CE` 项目中提供工程规范与架构参考。

## 1. 项目概述

`OpenixSuit-CE` 是面向全志（Allwinner / Sunxi）芯片设备的跨平台桌面端工具套件（支持 Windows、Linux、macOS），位于 `OpenixCLI` 仓库的 `OpenixSuit-CE/` 目录下。

- **前端**：React 19 + TypeScript 5.6 + Vite 6 + Tailwind CSS 3.4 + Lucide Icons + `i18next` / `react-i18next` + `@monaco-editor/react`
- **后端**：Rust (Edition 2021) + Tauri 2 + Tokio (`full`) + `openixcli`（本地 crate，路径 `../..`）
- **可执行产物（`src-tauri/Cargo.toml`）**：
  - `openixsuit-ce`（`src/main.rs`）：Tauri 桌面端主程序（默认运行目标）
  - `openixsuit-ai`（`src/bin/openixsuit-ai.rs`）：独立 CLI 桥接工具，通过本地 TCP IPC（`127.0.0.1:28765`）与运行中的桌面端通信

## 2. Tauri 配置（`src-tauri/tauri.conf.json`）

- `productName`：`OpenixSuit-CE`
- `identifier`：`com.openixsuit.ce`
- **窗口**：初始尺寸 `1280×800`，最小尺寸 `1024×680`，启动时 `visible: false`，由前端初始化完成后调用 `getCurrentWindow().show()` 显示。
- **开发服务器**：`http://localhost:1420`（`beforeDevCommand`：`npm run dev`）
- **打包**：`targets: "all"`，图标位于 `src-tauri/icons/`（`32x32.png`、`128x128.png`、`icon.png`、`icon.ico`）。
- **插件**：`tauri-plugin-dialog`、`tauri-plugin-fs`。

## 3. 前端架构（`src/`）

### 布局与导航
- **主框架（`src/App.tsx`）**：
  - `TopBar`（`src/components/TopBar.tsx`）：展示已连接的 FEL/ADB 设备、工作区选择器（`WorkspaceModal`）及状态信息。
  - `Sidebar`（`src/components/Sidebar.tsx`）：支持折叠、分组与拖拽排序的侧边栏（布局持久化至 `localStorage` 的 `openix_sidebar_layout_v1`），默认包含 3 个分组：
    - `firmware`：`firmware`（`FlashHub`，含标准刷机 `FirmwareFlash`、裸盘直刷 `GenericFlash`、格式转换 `FirmwareConverter`、解包与 DTB `FirmwareInspector`。标准刷机内的「高级分区布局」由 `SectorFlash` 提供）、`debugger`（`EfelDebugger`）、`gpio`（`GpioViewer`）
    - `debug`：`monitor`（`DeviceMonitorPage`）、`serial`（多路日志 `SerialPage`，每个分屏可选 USB CDC／串口或指定设备的 ADB 命令）、`adb-term`（`AdbTerminalPage`）、`adb`（`AdbExplorer`）、`screen`（`AdbScreenPage`）
    - `automation`：`automation`（`AutomationPage`）、`ai`（`AiWorkbenchPage`）
    - 另有 `settings`（`SettingsPage`）以及动态插件标签页（`ext:<plugin_id>`，通过 `PluginRunner` 渲染）。
  - **懒挂载与保活**：多路日志随应用启动挂载，恢复串口、ADB 日志采集和串口互转，并在任何标签页接收 CLI 配置。其他页面首次访问时挂载（`visitedTabs`），切换标签页时保留已挂载页面和会话。
  - `LogDrawer`（`src/components/LogDrawer.tsx`）：底部可折叠日志抽屉，汇总前后端日志与 AI 同步事件。

### 样式与主题系统
- 设计和修改界面时，遵守四项基本原则。
  - **亲密性**：把相关信息和操作放在一起，避免为同一操作设置重复入口。
  - **对齐**：让标签、输入框、列表和操作沿清晰的基线排列。
  - **重复**：同类组件和操作统一使用相同的样式、间距和交互方式。
  - **对比**：用清楚的层次区分主要操作、次要操作、状态和警告，并保证浅色和深色主题下都易读。
- 使用 Tailwind CSS 的 `darkMode: "class"`（`html.dark`），在 `src/index.css` 中定义了统一组件类（`.ui-toolbar`、`.ui-card`、`.ui-subcard`、`.ui-card-header`、`.ui-title`、`.ui-input`、`.ui-select`、`.ui-btn-primary/secondary/success/danger`、`.ui-segmented`、`.ui-terminal`、`.ui-alert-warn/err/ok`）。
- 主题模式支持 `"system" | "dark" | "light"`（`src/store/settings.ts`），通过 `document.documentElement.classList.toggle("dark", ...)` 动态切换并同步至 `localStorage`（`theme_mode`）。

### 国际化（`src/i18n/`）
- 使用 `i18next` + `react-i18next`，支持 `zh-CN`（`src/i18n/zh-CN.json`）与 `en-US`（`src/i18n/en-US.json`）。
- 新增用户可见文案时，必须同步更新 `zh-CN.json` 与 `en-US.json`。

### 设置持久化（`src/store/settings.ts` 与 `src-tauri/src/system/settings.rs`）
- `AppSettings`（`language`、`theme`、`usb_backend`）由 Rust 后端持久化至 `~/.openixsuit-ce/settings.json`（对应 `load_settings` / `save_settings` 命令）。

## 4. 后端架构（`src-tauri/src/`）

所有 Tauri 命令在 `src-tauri/src/lib.rs` 中通过 `tauri::generate_handler![]` 统一注册，并共享 `AppState`（`src-tauri/src/state.rs`）。

### 核心模块
1. **`efex/`（`mod.rs`、`ffi.rs`、`flasher.rs`）**：
   - 封装 `libefex`（Git 依赖）实现全志 FEL/FES USB 通信（`VID: 0x1f3a`，`PID: 0xefe8`）。
   - 支持 USB 后端切换：`auto`、`winusb`、`libusb`（`set_usb_backend`）。
   - FEL 命令：`fel_read_mem`、`fel_write_mem`、`fel_write_file`、`fel_exec`、`fel_init_dram`。
   - FES 命令：`fes_query_storage`、`fes_exit`、`fes_download_partition`。退出指令按设备 ID 确定目标，返回设备对请求的确认。
   - 完整/自定义/原始刷写：`flash_firmware_full`、`flash_custom_mbr_layout`、`raw_flash_image`、`cancel_flash`。
2. **`hotplug/watcher.rs`**：
   - 优先使用 `rusb` 原生热插拔回调，不支持的平台自动降级为 200ms 轮询对比。
   - 过滤全志 `0x1f3a:0xefe8` 设备，向前端推送 `usb-hotplug` 事件（`{ connected, count, devices }`）。
3. **`adb/mod.rs`**：
   - 基于 `adb_client` crate 实现。
   - 涵盖设备列表（`adb_list_devices`）、文件管理（`adb_list_dir`、`adb_list_dir_detailed`、`adb_push_file`、`adb_pull_file`、`adb_mkdir`、`adb_delete`、`adb_rename`、`adb_copy`、`adb_read_text`、`adb_write_text`）、Shell 与电源（`adb_exec_shell`、`adb_root`、`adb_reboot`、`adb_reboot_efex`）、交互式 PTY 终端（`adb_term_open`、`adb_term_write`、`adb_term_resize`、`adb_term_close`）以及投屏与输入（`adb_screen_info`、`adb_screencap_png`、`adb_input_tap`、`adb_input_swipe`、`adb_input_keyevent`）。
4. **`packer/`（`mod.rs`、`imagewty.rs`、`convert.rs`）**：
   - 解析 IMAGEWTY 固件、提取分区、解析 MBR/GPT（`gptman`、`mbrman`）、导出 MBR 二进制、转换/解包固件以及 DTB 反编译为 DTS（`fdt`）：`inspect_image`、`extract_partition`、`export_mbr_binary`、`read_partition_table`、`convert_firmware`、`unpack_firmware`、`dtb_to_dts`。
5. **`disasm/mod.rs`**：
   - 基于 `capstone`（`0.12`）实现多架构反汇编（`disassemble_bytes`），在 `EfelDebugger.tsx` 中配合 Monaco Editor 展示。
6. **`gpio/mod.rs`**：
   - 支持 FEL 下直接读写 PIO 寄存器（`read_pio_port`、`write_pio_pin`）以及 ADB 下 GPIO 探测与控制（`adb_detect_gpio`、`adb_detect_gpio_port`、`adb_set_gpio`）。
7. **`serial/mod.rs`**：
   - 基于 `serialport` crate，支持多串口会话、缓冲区轮询、DTR/RTS 信号控制与日志文件读写（`serial_list_ports`、`serial_open`、`serial_close`、`serial_list_sessions`、`serial_write`、`serial_set_signals`、`serial_get_buffer`、`serial_list_log_files`、`serial_read_log_file`）。
   - `adb_log/` 负责启动和停止指定设备的 ADB 日志采集，向页面发送数据和结束状态，两种来源共用历史日志目录。
8. **`monitor/mod.rs`**：
   - 采集 ADB 设备实时指标（CPU、内存、温度、网络、存储、电池、`top`），管理存储挂载/卸载（`/mnt/`、`/media/`、`/storage/`）、设备工作区与刷写历史（`adb_get_metrics`、`adb_storage_mount`、`workspace_list`、`workspace_save`、`flash_history_*`）。
9. **`power/mod.rs` 与 `triggers/mod.rs`**：
   - 电源配置管理（`power_list_profiles`、`power_save_profiles`、`power_execute`）与自动化触发规则（`trigger_list_rules`、`trigger_save_rules`、`trigger_test_rule`、`trigger_list_incidents`、`trigger_clear_incidents`），在 `setup()` 中通过 `triggers::start_trigger_watcher` 启动后台监听。
10. **`plugins/mod.rs` 与 `ipc_server/mod.rs`**：
    - 可扩展插件系统（`list_plugins`、`install_plugin`、`uninstall_plugin`、`run_plugin`）。
    - 在 `127.0.0.1:28765` 启动本地 TCP IPC 服务，供 `openixsuit-ai` 与外部工具调用 ADB/EFEX/Packer/Serial/Monitor/Power/Triggers 能力并向前端发送 `ai-sync` 事件。
11. **`system/`（`env_check.rs`、`settings.rs`）**：
    - 系统环境检查（`check_system_env`）与设置持久化（`load_settings`、`save_settings`）。

## 5. 构建与开发命令

以下命令均在 `OpenixSuit-CE/` 目录下执行：

```bash
# 安装前端依赖
npm install

# TypeScript 类型检查与前端打包
npm run build

# 仅启动 Vite 前端开发服务器
npm run dev

# 启动 Tauri 桌面端开发模式
cargo tauri dev

# 构建 Tauri 生产安装包
cargo tauri build
```

## 6. 开发约定与安全红线

- **严格类型检查**：`npm run build` 会执行 `tsc && vite build`。修改数据结构时，需确保 `src/types/workbench.ts`、`src/types/plugin.ts` 与 Rust `Serialize`/`Deserialize` 结构体一致，且所有类型导入完整。
- **IPC 对齐**：新增或修改 `#[tauri::command]` 函数时，须同步更新 `src-tauri/src/lib.rs` 中的 `tauri::generate_handler![]` 以及前端对应的 `invoke(...)` 调用。
- **Git 操作红线**：严禁执行任何修改 Git 状态的命令（如 `git add`、`git commit`、`git reset`、`git checkout`、`git push` 等），所有版本控制操作均由用户手动完成。
