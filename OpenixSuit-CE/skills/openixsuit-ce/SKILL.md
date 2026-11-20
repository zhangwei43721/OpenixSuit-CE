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

插件有多个标签页时，先从 `plugins` 返回的清单查找标签 ID，再为 `plugin-run` 加 `--tab <tab-id>`。

## 八、HTTP JSON 接口清单

当运行环境未将 `openixsuit-ce` / `openixsuit-ai` 加入 `PATH` 时，可直接调用 `http://127.0.0.1:28765`（请求头 `Content-Type: application/json`）：

- `GET /api/status`
- `GET /api/serial/ports`、`GET /api/serial/logs?session_id=...&tail_lines=200`。向 `POST /api/serial/write` 发送 `session_id`、`data`，十六进制内容加 `hex: true`
- `POST /api/serial/open` 接收 `port_name`、可选 `baud_rate` 和 `session_id`，`POST /api/serial/close` 接收 `session_id`
- `POST /api/power/action`：`{"profile_id": "...", "action": "on|off|cycle"}`
- `GET /api/monitor/metrics?serial=...&sample_ms=1000`
- `GET /api/triggers/rules`、`POST /api/triggers/rules` 读规则和保存单条规则草稿
- `GET /api/power/profiles`、`POST /api/power/profiles` 读配置和保存单个电源草稿
- `GET /api/log-profiles`、`POST /api/log-profiles` 读取日志配置和按 ID 保存单组日志来源
- `GET /api/log-sessions` 查询正在运行的采集。用 `POST /api/log-sessions/start` 传 `profile_id` 和来源标签 `source`，用 `POST /api/log-sessions/stop` 传 `session_id`
- `POST /api/log-ui` 传 `action` 和可选的 `params`，读取或修改当前桌面的分屏、布局及互转设置
- `GET /api/log-storage`、`POST /api/log-storage` 读取或部分更新日志保存策略
- `GET /api/serial/bridge` 查询串口互转。用 `POST /api/serial/bridge/start` 传 `profile_id`，用 `POST /api/serial/bridge/stop` 停止
- `GET /api/triggers/incidents`
- `GET /api/plugins`
- `POST /api/plugins/install`：`{"package_path": "..."}`
- `POST /api/plugins/uninstall`：`{"plugin_id": "..."}`
- `POST /api/plugins/run`：`{"plugin_id": "...", "tab_id": "...", "serial": "", "inputs": {}}`，`tab_id` 可省略

### 串口、电源、监控与事件触发 CLI 示例

```bash
openixsuit-ce ai serial-ports
openixsuit-ce ai serial-open /dev/ttyUSB0 --baud-rate 115200
openixsuit-ce ai serial-logs --tail 200
openixsuit-ce ai serial-send <session_id> "dmesg | tail -n 30"
openixsuit-ce ai serial-send <session_id> "00 FF 7E" --hex
openixsuit-ce ai serial-close <session_id>
openixsuit-ai log-profiles
openixsuit-ai log-profile-save /path/to/log-profile.json
openixsuit-ai log-start <profile_id> <source_label>
openixsuit-ai log-sessions
openixsuit-ai log-stop <session_id>
openixsuit-ai bridge-start <profile_id>
openixsuit-ai bridge-status
openixsuit-ai bridge-stop
openixsuit-ai log-ui get
openixsuit-ai log-ui pane-set /path/to/pane-update.json
openixsuit-ai log-ui layout-set /path/to/layout-update.json
openixsuit-ai log-ui bridge-set /path/to/bridge-update.json
openixsuit-ai log-storage
openixsuit-ai log-storage-save /path/to/storage-update.json
openixsuit-ce ai rules
openixsuit-ce ai rule-save /path/to/rule.json
openixsuit-ce ai power-profiles
openixsuit-ce ai power-profile-save /path/to/power-profile.json
openixsuit-ce ai power <profile_id> cycle
openixsuit-ce ai metrics --serial <serial> --sample-ms 1000
openixsuit-ce ai incidents
```

`serial-open` 返回的 `session.id` 用于后续读写或关闭。`metrics --sample-ms 1000` 间隔约一秒采两次，计算这段时间内的 CPU 使用率、网络和磁盘速率。省略 `--sample-ms` 沿用单次采样。

`serial-send --hex` 接受连续或以空白隔开的十六进制字节，默认按输入原样发送。文本发送默认追加 LF。可用 `--append-newline none|lf|cr|crlf` 明确指定追加方式。

`log-profile-save` 接收包含 `id`、`name` 和 `sources` 的 JSON 对象，路径 `-` 可从标准输入读取。同 ID 更新已有配置。每路来源都填写唯一的 `label`。USB CDC 或串口来源用 `type: "serial"`，填写 `port_name` 和 `baud_rate`。ADB 来源用 `type: "adb"`，填写设备序列号 `serial` 和设备端命令 `command`。

串口互转配置放在可选的 `bridge` 字段。两个端点 `first` 和 `second` 各填写 `label`、`port_name` 和 `baud_rate`。单独保存互转配置时，`sources` 可填空数组。

串口日志来源和互转端点可用 `line_coding` 指定 `data_bits`、`parity`、`stop_bits` 和 `flow_control`。串口日志来源还可保存 `serial_options`，包含 `receive_format`、`send_format`、`charset`、`line_ending`、`auto_scroll`。

`log-start` 使用配置 ID 和来源标签启动采集。正在运行的会话会显示在 `log-sessions` 和「多路日志」的实时分屏，任一端都可以停止。串口互转可从命令行或「串口互转」页启停，转发日志标明两个端口的方向。保存配置后，可在「多路日志」查看和载入参数。

重新打开桌面端会恢复上次退出前正在运行的串口、USB CDC 和 ADB 日志采集。设备不在或采集中拔出时等待原设备重新连接，串口互转在两端串口连上后恢复。主动停止的会话保持停止。恢复后请用 `log-sessions` 获取当前会话 ID。

`log-ui get` 查询当前分屏 ID、采集与显示设置、列数和互转设置。可用 `log-ui pane-set -` 从标准输入提交含 `pane_id` 的 JSON，例如 `{"pane_id":"<分屏 ID>","label":"调试串口","receive_format":"hex"}`。采集中的分屏可改名称和显示，修改设备或线路参数前先停止该路。用 `log-ui layout-set` 修改 `columns` 或 `pane_order`。用 `log-ui bridge-set` 修改 `profile_id`、`first_port`、`second_port` 或显示设置 `format`、`direction`、`show_timestamps`、`auto_scroll`。调整运行中的互转端点前先停止互转。

等待设备的分屏没有当前会话 ID，可用 `log-ui pane-set` 提交 `pane_id` 和 `"restore_on_startup":false` 取消该路恢复。用 `bridge-stop` 取消尚在等待两端连接的互转。

`log-storage-save` 接受需要更新的字段，支持 `save_continuous`、`keywords`、`before_lines`、`after_lines` 和 `directory`。将 `directory` 设为 `null` 可恢复默认目录。CLI 修改的设置会出现在桌面端界面。

`rule-save` 和 `power-profile-save` 接收一个 JSON 对象，路径 `-` 表示从标准输入读取。规则至少填写 `id`、`name` 和 `condition.kind`，电源配置至少填写 `id`、`name` 和 `kind`。返回值里的 `draft: true` 表示草稿已保存，可在「事件与电源」核对。相同 ID 可更新未确认的草稿，已确认配置请使用新的草稿 ID。规则草稿保持停用，用户核对后勾选「启用」并保存。电源草稿需点击「确认电源配置」后才能执行。

例如，保存一条收集 `Kernel panic` 现场的草稿：

```bash
openixsuit-ce ai rule-save - <<'JSON'
{
  "id": "kernel-panic-log",
  "name": "内核异常日志",
  "condition": {"kind": "contains", "pattern": "Kernel panic"},
  "actions": [{"kind": "send_ai", "include_serial_lines": 100}],
  "cooldown_secs": 60
}
JSON
```

要自动分析异常，在这一规则里保留「生成 AI 排障上下文」动作，再到「AI 协同台」启用自动分析。桌面端会把真实串口事件的日志快照交给本机 Codex CLI，并在该事件旁显示分析进度、结果或失败原因。Codex 不在桌面应用的 `PATH` 时，在同一页面填写可执行文件的绝对路径。

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
