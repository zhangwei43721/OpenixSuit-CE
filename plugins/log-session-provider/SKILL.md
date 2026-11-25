---
name: log-session-provider
description: 连续日志 provider 示例，读取现有日志会话并展示自动重连生命周期。
---

# 日志会话连续采集

Provider `tail` 的 `connect` action 有两种来源：填写 `source_session_id` 时读取该日志会话末尾 20 行；不填会话 ID 时，每轮输出 `sample_text`。后者可在无设备环境下用 `PANIC` 样例触发现有日志规则。action 返回后，桌面端会按 `reconnect_ms` 再次调用，provider 保持活动时持续重连；停止 provider 会结束重连。来源于日志会话时，每轮重新读取尾部，因此可能重复显示部分行。

```bash
openixsuit-ai plugin validate ./plugins/log-session-provider
openixsuit-ai plugin install ./plugins/log-session-provider
openixsuit-ai plugin provider-start log-session-provider tail --inputs '{"sample_text":"PANIC no-hardware provider sample"}'
openixsuit-ai plugin provider-list
openixsuit-ai plugin provider-call PROVIDER_SESSION_ID status
openixsuit-ai plugin provider-stop PROVIDER_SESSION_ID
```

插件清单申请 `logs.read` 和 `providers.log`。无设备样例不调用日志读取 RPC；`host.log` 每次重连都会再次输出样例文本，便于检验 `PANIC` 触发。
