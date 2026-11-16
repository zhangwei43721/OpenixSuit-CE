---
name: v881-ab-ota
description: V881 A/B 分区安全升级插件，自动识别当前活动槽位并刷写非活动槽位。
---

# V881 A/B 分区安全升级插件

## 输入参数
- `slot_image` (`file`, 必填): 本地分区镜像路径（`.img` / `.bin`）
- `target_partition` (`select`, 必填): 目标分区名称（`boot` / `rootfs` / `system`）
- `auto_reboot` (`boolean`, 可选, 默认 `true`): 写入完成后是否自动重启

## 安装与运行示例

```bash
openixsuit-ce ai plugin-install ./plugins/v881-ab-ota
openixsuit-ce ai plugin-run v881-ab-ota --serial <serial> --inputs '{"slot_image":"/path/to/boot.img","target_partition":"boot","auto_reboot":true}'
```
