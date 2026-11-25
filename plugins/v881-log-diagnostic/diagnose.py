"""Offline V881 log keyword diagnostic using the plugin NDJSON protocol."""
import json
import re
import sys

PATTERNS = [
    ("panic", re.compile(r"kernel panic|panic:", re.IGNORECASE)),
    ("watchdog", re.compile(r"watchdog|watchdog bite", re.IGNORECASE)),
    ("存储错误", re.compile(r"I/O error|EXT4-fs error|mmc.*(error|timeout)", re.IGNORECASE)),
    ("内存不足", re.compile(r"out of memory|oom-killer|killed process", re.IGNORECASE)),
    ("服务启动失败", re.compile(r"failed to start|service.*failed|can't start", re.IGNORECASE)),
]


def emit(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    request = json.loads(sys.stdin.readline())
    if request.get("type") != "start":
        raise ValueError("expected a start message")
    inputs = request.get("inputs") or {}
    context = request.get("context") or {}
    incident = context.get("incident") or {}
    text = str(inputs.get("log_text") or "")
    if not text.strip():
        incident_tail = incident.get("log_tail") or ""
        text = "\n".join(map(str, incident_tail)) if isinstance(incident_tail, list) else str(incident_tail)
    if not text.strip():
        raise ValueError("请粘贴日志文本，或从带有日志快照的事件上下文运行诊断")

    lines = text.splitlines()
    try:
        limit = max(1, min(100, int(inputs.get("max_matches") or 20)))
    except (TypeError, ValueError):
        limit = 20
    findings = []
    for category, pattern in PATTERNS:
        matches = [
            {"line": index, "text": line}
            for index, line in enumerate(lines, start=1)
            if pattern.search(line)
        ][:limit]
        if matches:
            findings.append({"category": category, "count": len(matches), "matches": matches})

    emit({"type": "progress", "value": 100})
    emit({
        "type": "log",
        "message": f"离线分析完成：检查 {len(lines)} 行，发现 {len(findings)} 类匹配项",
    })
    result = {"line_count": len(lines), "findings": findings}
    if incident.get("matched_text"):
        result["matched_text"] = str(incident["matched_text"])
    emit({"type": "result", "value": result})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Protocol failures are surfaced through stderr and nonzero exit.
        print(str(error), file=sys.stderr)
        sys.exit(1)
