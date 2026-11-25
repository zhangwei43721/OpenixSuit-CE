export async function connect({ inputs, context }, host) {
  let lines;
  if (inputs.source_session_id) {
    const rows = await host.call("logs.recent", { session_id: inputs.source_session_id, lines: 20 });
    lines = Array.isArray(rows) ? rows.map(String) : [];
  } else if (inputs.sample_text) {
    // 每轮重连都会再次输出样例，适合无设备时验证日志触发规则。
    lines = String(inputs.sample_text).split(/\r?\n/);
  } else {
    throw new Error("请填写日志会话 ID，或提供无设备样例日志文本");
  }

  for (const line of lines) host.log(line);
  host.log(`provider ${context?.provider?.session_id || "session"} 已输出 ${lines.length} 行`);
  // 正常返回后，宿主会在 reconnect_ms 后再次调用 connect，直到用户停止 provider。
  return { emitted: lines.length };
}

export async function status({ context }, host) {
  const sessions = await host.call("logs.sessions", {});
  return {
    status: {
      provider_session_id: context?.provider?.session_id || null,
      available_sessions: Array.isArray(sessions) ? sessions.length : 0
    }
  };
}
