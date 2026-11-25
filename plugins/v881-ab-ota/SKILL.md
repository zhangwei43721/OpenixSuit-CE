---
name: v881-ab-ota
description: V881 A/B 分区安全升级插件，检查活动槽并由宿主将镜像写入非活动槽。
---

# V881 A/B 分区升级

该插件通过 `adb.partition.inspect` 读取当前和目标槽位，再调用宿主的 `adb.partition.write`。宿主负责镜像上传、非活动槽写入、读回校验以及可选的校验后重启；整项操作由宿主进行一次确认。

需要 `devices.read`、`adb.partition` 和 `adb.reboot` 权限。清单和入口见本目录 `manifest.json` 与 `main.js`。

```bash
openixsuit-ai plugin validate ./plugins/v881-ab-ota
openixsuit-ai plugin install ./plugins/v881-ab-ota
openixsuit-ai plugin run v881-ab-ota upgrade --device "$adb_serial" --inputs '{"slot_image":"/path/to/boot.img","target_partition":"boot","auto_reboot":false}'
openixsuit-ai plugin runs
openixsuit-ai plugin show RUN_ID
```

先用 `show` 检查设备、分区、目标槽及待确认操作。确认执行时使用结果里的 token 调用 `plugin confirm RUN_ID TOKEN`；取消则调用 `plugin cancel RUN_ID`。`auto_reboot` 默认为 `true`，仅在写入读回校验成功后重启。
