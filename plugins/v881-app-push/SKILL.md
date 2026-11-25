---
name: v881-app-push
description: V881 应用推送插件，调用宿主组合部署操作传输文件并按需重启服务。
---

# V881 App 快推安装

插件 action `deploy` 调用宿主 `adb.deploy`，由宿主完成设备检查、可选 root、目录准备、文件传输和可选重启命令。需要 `devices.read`、`adb.transfer`、`adb.root`、`adb.shell` 权限；设备操作执行前由宿主确认。

```bash
openixsuit-ai plugin validate ./plugins/v881-app-push
openixsuit-ai plugin install ./plugins/v881-app-push
openixsuit-ai plugin run v881-app-push deploy --device "$adb_serial" --inputs '{"local_file":"/path/to/app","remote_dir":"/usr/bin","remote_name":"v881_app","need_root":true,"restart_cmd":""}'
openixsuit-ai plugin runs
openixsuit-ai plugin show RUN_ID
```

确认执行前检查目标设备和部署路径。清单及 JS 入口分别见本目录 `manifest.json`、`main.js`。完整字段和 CLI 说明见 OpenixSuit-CE Skill 的 `references/plugins.md`。
