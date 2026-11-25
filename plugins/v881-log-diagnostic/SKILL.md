---
name: v881-log-diagnostic
description: 在不连接设备的情况下，对粘贴的 V881 文本日志做关键词诊断。
---

# V881 离线日志诊断

两个 action 都支持手动输入，也会在 `log_text` 留空时读取 `context.incident.log_tail`；若事件提供 `context.incident.matched_text`，结果会一并带回。没有手动文本和事件日志快照时，action 会返回清楚的输入错误。它们不连接设备、不调用设备或日志 RPC。`analyze` 使用 JavaScript；`analyze-python` 运行包内 Python 脚本，需要 `process.execute` 和桌面端 `python` 解释器绑定。

```bash
openixsuit-ai plugin validate ./plugins/v881-log-diagnostic
openixsuit-ai plugin install ./plugins/v881-log-diagnostic
openixsuit-ai plugin run v881-log-diagnostic analyze --inputs '{"log_text":"kernel panic: example","max_matches":20}'
openixsuit-ai plugin run v881-log-diagnostic analyze-python --inputs '{"log_text":"watchdog bite","max_matches":20}'
openixsuit-ai plugin runs
openixsuit-ai plugin show RUN_ID
```

从带日志快照的事件调用时，输入可省略 `log_text`，两种实现都会分析事件日志。可用 `plugin configure` 为 Python 入口配置 `python` 解释器绑定。仓库 mock 验证命令 `node plugins/tests/offline-smoke.mjs` 会检查事件上下文日志分析、两个 V881 的宿主 RPC、provider 样例日志输出和 Python 进程 NDJSON 往返；不需要桌面端或硬件。入口见 `main.js` 与 `diagnose.py`。
