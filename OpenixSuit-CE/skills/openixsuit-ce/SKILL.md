---
name: openixsuit-ce
description: 当需要通过 AI 控制 OpenixSuit-CE 桌面端操作全志（Allwinner / Sunxi）设备时使用此技能，涵盖设备状态查询、ADB 切换烧录模式、ADB 文件传输与 Shell、IMAGEWTY 固件检查/解包/转换、固件与裸盘刷写以及 EFEL 内存调试。所有操作均通过 openixsuit-ai CLI 或本地 HTTP 接口（127.0.0.1:28765）执行，并与桌面界面实时同步。
---

# OpenixSuit-CE 控制指南

当需要代用户在全志开发板或固件镜像上执行扫描、文件传输、镜像处理、刷机、扩展插件或底层调试时，优先通过 `openixsuit-ce ai`（单文件主程序内建模式）或 `openixsuit-ai` 命令，或本地 HTTP 接口调用 `OpenixSuit-CE`，确保操作结果、进度条、设备锁与目录视图和桌面界面保持同步。

## 使用规则与安全约束

1. **先查状态再操作**：任何硬件或文件操作前，必须先执行 `openixsuit-ai status`（或 `GET /api/status`），确认设备在线状态和 `busy` 字段。
2. **严禁抢占互斥锁**：若 `busy` 非空或接口返回 HTTP `409`，说明人工或另一任务正在占用设备，必须等待其完成后再重试，不要绕过本地接口直接操作 USB。
3. **高危操作先确认**：执行 `full_erase`（全盘擦除）、`raw`（裸盘直刷）、`efel-write` / `efel-exec` 前，必须确认目标固件、存储介质与板型匹配，并在未获明确指令时向用户确认。
4. **结构化判断结果**：`openixsuit-ai` 所有输出均为标准 JSON，以返回中的 `"ok": true/false` 判断成败，不要猜测或忽略 `"error"` 字段。

## 一、前置状态检查

```bash
openixsuit-ai status
# 或直接请求本地 HTTP 接口
curl -s http://127.0.0.1:28765/api/status
```

返回字段说明：
- `fel_devices`：当前处于 FEL/FES 烧录模式的全志设备（`0x1f3a:0xefe8`）
- `adb_devices`：当前在线的 ADB 设备（含 `serial` 与 `state`）
- `busy`：`null` 表示空闲；非空字符串表示正在进行的独占操作

若连接被拒绝，提示用户先启动 `OpenixSuit-CE` 桌面程序（启动后会自动监听 `127.0.0.1:28765`）。

## 二、ADB 在线设备切换为烧录模式

当 `adb_devices` 有设备在线而 `fel_devices` 为空时，可通过 ADB 重启进入 EFEX/FEL 模式：

```bash
# 多台设备时通过 --serial 指定序列号
openixsuit-ai reboot-efex --serial <serial>

# 等待约 2~3 秒后再次查询，确认 fel_devices 出现设备
openixsuit-ai status
```

## 三、ADB 调试与文件传输

通过此组命令推送的文件会自动触发 `adb-sync` 事件，使界面中的 ADB 文件管理器实时刷新目录：

```bash
# 获取 root 权限（读取 debugfs GPIO 或写系统目录前执行）
openixsuit-ai adb-root --serial <serial>

# 执行 Shell 命令
openixsuit-ai adb-shell --serial <serial> "uname -a"

# 推送本地文件到设备
openixsuit-ai adb-push --serial <serial> /local/path/app /tmp/app

# 从设备拉取文件到本地
openixsuit-ai adb-pull --serial <serial> /etc/config/system ./system.bak
```

## 四、固件解析、全量解包与格式转换

```bash
# 解析 IMAGEWTY 头部、sys_config（串口/TWI/存储类型）、Boot0 与分区列表
openixsuit-ai inspect /path/to/firmware.img

# 一键解包全部内嵌文件与分区镜像到指定目录
openixsuit-ai unpack /path/to/firmware.img /path/to/out_dir

# 转换为烧录器原始镜像（target 可选: spinor | sdcard | emmc | sdnand | ufs）
openixsuit-ai convert /path/to/firmware.img \
  --target spinor \
  --nor-size 16 \
  --storage-size auto \
  --output /path/to/programmer.bin
```

## 五、固件与裸盘烧录

执行前需确认 `fel_devices` 非空：

```bash
# 标准 IMAGEWTY 固件刷写
# --mode: full_erase | keep_data | partition_erase | partition
# --post-action: reboot | poweroff | keep
openixsuit-ai flash /path/to/firmware.img \
  --mode keep_data \
  --partition boot --partition rootfs \
  --verify true \
  --post-action reboot

# 裸磁盘镜像直刷（需配合引导固件提供 Boot0/FES/U-Boot）
# --mode: logic-offset | command
# --storage: sdmmc | ufs | nor
openixsuit-ai raw /path/to/boot_fw.img /path/to/disk.img \
  --mode logic-offset \
  --storage sdmmc
```

## 六、EFEL 底层内存调试

```bash
# 读取指定地址内存（支持 0x 十六进制或十进制）
openixsuit-ai efel-read 0x001003c8 64

# 写入字节序列到内存
openixsuit-ai efel-write 0x00020000 1 2 3 4

# 跳转到指定地址执行
openixsuit-ai efel-exec 0x00020000
```

## 七、零依赖扩展插件管理与执行

支持直接导入项目根目录 `plugins/` 下的插件源码目录，或安装 `.oixplugin` / `.zip` 独立包，全部基于内置 Rust 能力执行，无需外部 Python/Shell 环境：

- 在 `manifest.json`（或单个 `tabs[i]`）中可设置 `"icon"` 自定义左侧栏图标：支持包内图片如 `"plugin://icon.svg"` / `"plugin://icon.png"`、内置图标名（`cpu`、`package`、`smartphone`、`wrench`、`terminal`、`upload`、`download`、`layers`、`shield`、`rocket`、`zap`、`usb`、`flame` 等）或 Emoji。

```bash
# 查看已安装插件
openixsuit-ce ai plugins

# 直接从源码目录安装插件（或安装打包后的 .oixplugin）
openixsuit-ce ai plugin-install ./plugins/v881-ab-ota

# 运行插件（传入 JSON 参数）
openixsuit-ce ai plugin-run v881-ab-ota --serial <serial> --inputs '{"slot_image":"/path/to/boot.img","target_partition":"boot","auto_reboot":true}'

# 卸载插件
openixsuit-ce ai plugin-uninstall v881-ab-ota
```

## 八、HTTP JSON 接口清单

当运行环境未将 `openixsuit-ce` / `openixsuit-ai` 加入 `PATH` 时，可直接调用 `http://127.0.0.1:28765`（请求头 `Content-Type: application/json`）：

- `GET /api/status`
- `GET /api/plugins`
- `POST /api/plugins/install`：`{"package_path": "..."}`
- `POST /api/plugins/uninstall`：`{"plugin_id": "..."}`
- `POST /api/plugins/run`：`{"plugin_id": "...", "serial": "", "inputs": {}}`
- `POST /api/adb/shell`：`{"serial": "", "command": "..."}`
- `POST /api/adb/push`：`{"serial": "", "local_path": "...", "remote_path": "..."}`
- `POST /api/adb/pull`：`{"serial": "", "remote_path": "...", "local_path": "..."}`
- `POST /api/adb/reboot-efex`：`{"serial": ""}`
- `POST /api/adb/root`：`{"serial": ""}`
- `POST /api/inspect`：`{"firmware_path": "..."}`
- `POST /api/unpack`：`{"firmware_path": "...", "out_dir": "..."}`
- `POST /api/convert`：`{"firmware_path": "...", "target": "emmc", "output_path": "...", "logic_offset": null, "uboot_start": null, "nor_size": 16, "storage_size": "auto"}`
- `POST /api/flash`：`{"firmware_path": "...", "mode": "full_erase", "partitions": [], "verify": true, "post_action": "reboot"}`
- `POST /api/raw`：`{"boot_firmware": "...", "raw_image": "...", "mode": "logic-offset", "storage": "sdmmc", "logic_offset": null}`
- `POST /api/efel/read`：`{"address": 1049544, "length": 64}`
- `POST /api/efel/write`：`{"address": 131072, "data": [1, 2, 3]}`
- `POST /api/efel/exec`：`{"address": 131072}`
