# OpenixCLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/Rust-2021-orange.svg)](https://www.rust-lang.org/)

基于 Rust 编写的全志（Allwinner）芯片命令行与 TUI 固件烧录工具，并提供跨平台桌面端 GUI 套件 `OpenixSuit-CE`。

<img width="1090" height="583" alt="4610154f-10af-4016-afdd-cf5bdebb59e2" src="https://github.com/user-attachments/assets/39ae92c1-2ff7-45bf-95f8-361327f44ae6" />

## 概述

OpenixCLI 是一款专为全志 SoC 设备设计的固件烧录工具，同时支持 FEL（USB Boot）模式与 FES（U-Boot）模式，提供完整的固件部署与转换能力。

## 核心特性

- **设备扫描**：自动检测已连接的全志设备
- **固件烧录**：支持多种烧录模式
- **FEL/FES 支持**：同时处理 FEL（USB Boot）和 FES（U-Boot）设备模式
- **写入校验**：可选写后校验以保证数据完整性
- **进度追踪**：烧录过程中提供实时可视化进度条
- **分区选择**：支持仅烧录指定分区或完整固件
- **原始镜像烧录**：通过虚拟 Sunxi MBR 直接烧录独立磁盘镜像
- **固件转换**：将 IMAGEWTY 固件包转换为 SPI NOR、SD 卡、eMMC、SD NAND 或 UFS 烧录器镜像
- **详细日志**：支持输出详细调试日志以便排查问题

## 安装

### 环境要求

- Rust 工具链（1.70 及以上）
- libusb 开发库

### 从源码构建

```bash
git clone https://github.com/zhangwei43721/OpenixCLI.git
cd OpenixCLI
cargo build --release
```

编译产物位于 `target/release/openixcli`。

## 使用方法

启动交互式 TUI：

```bash
openixcli
```

也可以显式指定子命令启动：

```bash
openixcli tui
```

### 扫描设备

列出所有已连接的全志设备：

```bash
openixcli scan
```

### 烧录固件

向设备烧录固件：

```bash
openixcli flash <firmware_file> [options]
```

#### 烧录选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--bus` | `-b` | USB 总线号 |
| `--port` | `-P` | USB 端口号 |
| `--verify` | `-V` | 写入后是否校验（默认：`true`） |
| `--mode` | `-m` | 烧录模式：`partition`、`keep_data`、`partition_erase`、`full_erase`（默认：`full_erase`） |
| `--partitions` | `-p` | 逗号分隔的待烧录分区列表 |
| `--post-action` | `-a` | 烧录完成后动作：`reboot`、`poweroff`、`shutdown`（默认：`reboot`） |
| `--verbose` | `-v` | 启用详细日志输出 |

#### 烧录示例

向指定 USB 位置的设备烧录固件：

```bash
openixcli flash firmware.img --bus 1 --port 5
```

仅烧录指定分区：

```bash
openixcli flash firmware.img --partitions "boot,system"
```

禁用写入校验：

```bash
openixcli flash firmware.img --verify false
```

烧录完成后自动关机：

```bash
openixcli flash firmware.img --post-action poweroff
```

### 烧录原始镜像

`raw` 命令使用私有 IMAGEWTY 固件包作为引导加载器，将标准磁盘镜像按块直接写入存储介质（类似 `dd` 操作）。引导固件仅提供 FES、U-Boot、Boot0/Boot1 及相关板级配置，其自身普通分区镜像不会被写入；OpenixCLI 会创建仅包含单个 `raw` 分区的临时 Sunxi MBR，并将整个镜像流式写入目标存储。

> **警告**：`raw` 命令始终执行全盘擦除、禁用下载校验并在烧录后重启开发板，目标存储上的所有现有数据将被清除。

```bash
openixcli raw <boot_firmware> <raw_image> [options]
```

SD/eMMC 默认使用 `logic-offset` 模式（偏移 40960 扇区）：

```bash
openixcli raw boot.img disk.img
openixcli raw boot.img disk.img --mode logic-offset --storage ufs
```

使用 `command` 模式可将虚拟 raw 分区置于第 0 扇区：

```bash
openixcli raw boot.img disk.img --mode command
```

自定义逻辑偏移或选择 SPI NOR 默认偏移（2106 扇区）：

```bash
openixcli raw boot.img disk.img --logic-offset 8192
openixcli raw boot.img disk.img --storage nor
```

#### Raw 选项

| 选项 | 简写 | 说明 |
|------|------|------|
| `--mode` | | `command` 或 `logic-offset`（默认：`logic-offset`） |
| `--storage` | | `sdmmc`、`ufs` 或 `nor`（默认：`sdmmc`） |
| `--logic-offset` | | 覆盖逻辑偏移（单位：512 字节扇区，有效范围 `0` 到 `0x100000000`） |
| `--bus` | `-b` | USB 总线号 |
| `--port` | `-P` | USB 端口号 |
| `--verbose` | `-v` | 启用详细日志输出 |

在 `logic-offset` 模式下，虚拟分区起始于 `0x100000000 - logic_offset`。当引导固件的 MBR 有效时继承其 MBR 副本数，否则默认为 1。`sdmmc` 与 `ufs` 默认逻辑偏移为 40960 扇区，`nor` 为 2106 扇区。

### 转换固件

将 IMAGEWTY 固件包转换为原始烧录器镜像。该命令会读取内嵌分区配置、展开 Android sparse 分区、检测安全固件，并在存在 DTB 时使用其中的 flash 映射信息。

```bash
openixcli convert firmware.img
```

默认目标为 eMMC，默认输出为 `firmware_programmer.bin`。可通过 `--target` 和 `--output` 指定其他存储布局或输出路径：

```bash
openixcli convert firmware.img --target ufs --output firmware-ufs.img
openixcli convert firmware.img --target spinor --nor-size 32
```

#### 转换选项

| 选项 | 说明 |
|------|------|
| `--output`, `-o` | 输出路径（默认 `*_programmer.bin`，SPI NOR 为 `*_full_img.bin`） |
| `--target`, `-t` | `spinor`、`sdcard`、`emmc`、`sdnand` 或 `ufs`（默认：`emmc`） |
| `--logic-offset` | 覆盖 DTB/默认逻辑偏移（单位：512 字节扇区） |
| `--uboot-start` | 覆盖 SPI NOR 的 U-Boot 偏移（单位：512 字节扇区） |
| `--nor-size` | SPI NOR 容量，单位 MiB（默认：16） |
| `--storage-size` | GPT 目标容量，如 `8GB` 或 `512MB`（默认：`auto`） |
| `--secure` | `auto`、`enabled` 或 `disabled`（默认：`auto`） |

## 烧录模式

| 模式 | 说明 |
|------|------|
| `partition` | 仅烧录指定分区 |
| `keep_data` | 保留用户数据烧录 |
| `partition_erase` | 擦除并烧录指定分区 |
| `full_erase` | 烧录前全盘擦除（默认） |

## 设备模式

OpenixCLI 支持以下设备模式：

- **FEL (USB Boot)**：用于固件烧录的初始引导模式
- **FES (U-Boot)**：加载 U-Boot 后的第二阶段模式
- **UPDATE_COOL/UPDATE_HOT**：升级模式

## OpenixSuit-CE（桌面端 GUI）

`OpenixSuit-CE/` 是基于 Tauri 2、React 19、TypeScript 与 Tailwind CSS 构建的跨平台桌面端工具套件，集成了固件刷写/转换/检查、ADB 文件管理/终端/投屏、多路日志、串口调试、GPIO 查看、EFEL 调试、设备监控、自动化触发器、插件运行与 AI 工作台等功能。

「多路日志」的每个分屏可以独立采集 USB CDC／串口或 ADB 命令输出。点击「分屏设置」选择来源。CDC 在 Linux 上常显示为 `/dev/ttyACM*`，在 Windows 上显示为 `COM*`。采集 ADB 日志时选择设备并填写命令，例如 Android 的 `adb logcat -v threadtime` 或 Linux 设备上的 `adb shell tail -f /tmp/log/实际日志文件`。ADB 采集需要桌面应用能从 `PATH` 找到 `adb`。两种来源都可在页面搜索、导出和查看历史日志。

串口分屏可设置波特率、数据位、校验位、停止位和流控。接收内容可切换文本与十六进制，发送栏也可独立选择格式。文本发送可追加行尾，十六进制按输入发送原始字节。开启自动滚动后，向上翻看会暂停跟随，回到底部后继续跟随。保存日志配置会记住分屏的串口线路参数、接收和发送格式及滚动设置。

AI 可用 `openixsuit-ai` 保存 USB CDC、串口、ADB 命令和串口互转配置，也可以查询、启动和停止采集或互转。CLI 与「多路日志」共用同一批会话。在「多路日志 → 设置」里保存或载入采集与互转配置、调整分屏和线路参数。已保存的配置也能用 CLI 查询和启动。参数见[多路日志 CLI 用法](OpenixSuit-CE/skills/openixsuit-ce/references/logs.md)。

客户端的 [Skill](OpenixSuit-CE/skills/openixsuit-ce/SKILL.md) 由 Git 子模块管理。本地开发时，子模块仓库 `openixsuit-ce-skill.git` 和主仓库放在同级目录。需要补拉 Skill 时，在从本地主仓库克隆出的副本中运行：

```bash
git -c protocol.file.allow=always submodule update --init -- OpenixSuit-CE/skills/openixsuit-ce
```

### GitHub 版本与更新

- **Skill** 从独立仓库按标签安装和升级，桌面仓记录经过核对的子模块提交。先推送 Skill 的提交及标签，再在桌面仓提交对应的子模块指针。从 GitHub 拉取源码时，使用 `git submodule update --init -- OpenixSuit-CE/skills/openixsuit-ce` 取得配套版本。详见 [Skill 安装与版本更新](OpenixSuit-CE/skills/openixsuit-ce/references/skill-installation.md)。
- **桌面端** 在「系统设置 → 应用版本」检查更新。带签名配置的 AppImage、Windows 和 macOS 安装版可以直接下载并安装，安装后重启。DEB／RPM 从发布页下载安装。仓库私有期间，用户先登录 GitHub，再从「打开发布页」下载有权访问的安装包。

桌面端发布由 `openixsuit-ce-v<版本>` 标签触发。例如发布 `0.1.1` 时，先统一 `OpenixSuit-CE/package.json`、`OpenixSuit-CE/src-tauri/Cargo.toml` 和 `tauri.conf.json` 的版本，并随需要更新 npm 锁文件。安装包全部构建后，工作流上传各平台安装包、签名和 `openixsuit-ce-update.json` 到同一个 Release。应用从这个清单获取经过签名的更新包。手动运行构建工作流可下载测试安装包。

第一次发布前，用 Tauri CLI 的 `signer generate` 在仓库之外生成并保管更新密钥。GitHub Actions 的仓库变量 `OPENIXSUIT_UPDATER_PUBLIC_KEY` 填公钥内容，仓库 Secret `TAURI_SIGNING_PRIVATE_KEY` 填私钥内容。如果私钥有密码，同时设置 Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。后续发布继续沿用同一签名密钥，旧安装版使用嵌入的公钥验证更新。 [Tauri 更新签名说明](https://v2.tauri.app/plugin/updater/#signing-updates)

日志默认保存在系统「文档」文件夹下的 `OpenixSuit-CE/logs/serial/`。「设置 → 日志保存」可选择其他文件夹，保存后新开始的采集或互转会使用所选目录。历史日志同时保留对原日志目录的读取，在文件名上悬停可查看完整路径。这里也可关闭连续写文件，或设置关键词，自动保存命中行及指定行数的前后文。关键词匹配忽略大小写，触发片段单独保存，同一来源的重叠片段合并。

在「设置 → 采集与分屏」可设置两列、三列或四列，两行分别能同屏查看四路、六路或八路日志，其余分屏可向下滚动查看。双击分屏标题可放大该路，再双击恢复布局。分屏齿轮在当前分屏上打开设置。分屏顺序、来源、收发和显示设置会在下次打开时恢复。退出前仍在运行的串口、USB CDC 和 ADB 采集会按原配置恢复。设备离线或采集中拔出时，分屏等原设备重新连接，串口互转等两端都连上再恢复。手动停止或取消恢复后保持停止。标题栏的隐藏按钮让该路继续在后台采集，可在底部恢复显示。点击右上角的「×」会停止该路采集并关闭分屏，已保存的日志仍可查看。

要让两个串口互相收发，先在「设置 → 互转设置」载入互转配置，或选择两个已连接的串口，再到「串口互转」点击「开始互转」。任一端收到的原始字节会由另一端发出。互转日志标明发送端和接收端，实时显示可按方向筛选、切换文本或十六进制，也可设置时间戳和自动滚动。一次可连接一对串口，停止互转后仍可继续采集两路日志。断开任一端会结束互转。

```bash
cd OpenixSuit-CE
npm install
cargo tauri dev    # 开发模式
cargo tauri build  # 打包发布
```

## 项目结构

```
OpenixCLI/
├── OpenixSuit-CE/     # Tauri 2 + React 桌面端 GUI 套件
├── src/
│   ├── commands/      # CLI 命令实现
│   ├── config/        # 配置解析（MBR、sys_config）
│   ├── firmware/      # 固件镜像处理
│   ├── flash/         # 烧录逻辑（FEL/FES 处理器）
│   ├── process/       # 阶段与进度追踪
│   ├── raw/           # 虚拟 MBR 与原始镜像烧录
│   ├── tui/           # 交互式终端界面
│   ├── utils/         # 工具类（日志、错误处理）
│   ├── cli.rs         # CLI 参数定义
│   ├── lib.rs         # 库导出
│   └── main.rs        # 程序入口
├── Cargo.toml
└── LICENSE
```

## 许可证

本项目基于 MIT 许可证开源，详情请参阅 [LICENSE](LICENSE)。

## 致谢

- 基于 [libefex](https://github.com/YuzukiTsuru/libefex) 实现全志 USB 通信
- 致力于为全志设备提供现代、可靠的固件烧录工具
