---
name: v881-app-push
description: V881 App 快推安装插件，支持推送应用文件、设置权限并执行重启命令。
---

# V881 App 快推安装插件

## 输入参数
- `local_file` (`file`, 必填): 本地应用文件
- `remote_dir` (`text`, 必填, 默认 `/usr/bin`): 设备目标目录
- `remote_name` (`text`, 必填, 默认 `v881_app`): 设备端文件名
- `need_root` (`boolean`, 可选, 默认 `true`): 是否先切换 `adb root`
- `restart_cmd` (`text`, 可选): 推送完成后执行的命令

## 安装与运行示例

```bash
openixsuit-ce ai plugin-install ./plugins/v881-app-push
openixsuit-ce ai plugin-run v881-app-push --serial <serial> --inputs '{"local_file":"/path/to/app","remote_dir":"/usr/bin","remote_name":"v881_app","need_root":true}'
```
