const patterns = [
  ["panic", /kernel panic|panic:/i],
  ["watchdog", /watchdog|watchdog bite/i],
  ["存储错误", /I\/O error|EXT4-fs error|mmc.*(error|timeout)/i],
  ["内存不足", /out of memory|oom-killer|killed process/i],
  ["服务启动失败", /failed to start|service.*failed|can't start/i]
];

function getLogText(inputs, context) {
  const manualText = String(inputs.log_text || "");
  if (manualText.trim()) return manualText;
  const incidentTail = context?.incident?.log_tail;
  if (Array.isArray(incidentTail)) return incidentTail.map(String).join("\n");
  return String(incidentTail || "");
}

export async function analyze({ inputs, context }, host) {
  const text = getLogText(inputs, context);
  if (!text.trim()) {
    throw new Error("请粘贴日志文本，或从带有日志快照的事件上下文运行诊断");
  }
  const lines = text.split(/\r?\n/);
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(inputs.max_matches)) || 20));
  const findings = patterns.map(([category, pattern]) => {
    const matches = [];
    for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
      if (pattern.test(lines[i])) matches.push({ line: i + 1, text: lines[i] });
    }
    return { category, count: matches.length, matches };
  }).filter(item => item.count > 0);

  host.progress(100);
  host.log(`离线分析完成：检查 ${lines.length} 行，发现 ${findings.length} 类匹配项`);
  const result = { line_count: lines.length, findings };
  if (context?.incident?.matched_text) result.matched_text = String(context.incident.matched_text);
  return result;
}
