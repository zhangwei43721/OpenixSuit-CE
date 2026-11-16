export interface GpioPortValue {
  prefix: string;
  pin: string;
  mux: string;
  pull: string;
  drv: string;
  level: string;
}

export interface SysConfigEntry {
  id: string;
  section: string;
  key: string;
  value: string;
  originalValue: string;
  comment: string;
  lineIndex: number;
}

export interface SysConfigLine {
  kind: "raw" | "section" | "entry";
  raw: string;
  section?: string;
  entryId?: string;
}

export interface SysConfigDoc {
  sections: string[];
  entries: SysConfigEntry[];
  lines: SysConfigLine[];
}

const GPIO_PORT_RE = /^(port:)([A-Za-z]+\d+)<([^>]*)><([^>]*)><([^>]*)><([^>]*)>$/i;

export function parseGpioPortValue(value: string): GpioPortValue | null {
  const m = value.trim().match(GPIO_PORT_RE);
  if (!m) return null;
  return {
    prefix: m[1],
    pin: m[2],
    mux: m[3],
    pull: m[4],
    drv: m[5],
    level: m[6],
  };
}

export function formatGpioPortValue(gpio: GpioPortValue): string {
  return `${gpio.prefix}${gpio.pin}<${gpio.mux}><${gpio.pull}><${gpio.drv}><${gpio.level}>`;
}

export function parseSysConfig(rawText: string): SysConfigDoc {
  const rawLines = rawText.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  const entries: SysConfigEntry[] = [];
  const lines: SysConfigLine[] = [];

  let currentSection = "";
  let nextId = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) {
      lines.push({ kind: "raw", raw });
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const sec = trimmed.slice(1, -1).trim();
      currentSection = sec;
      if (sec && !sections.includes(sec)) {
        sections.push(sec);
      }
      lines.push({ kind: "section", raw, section: sec });
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const rhs = trimmed.slice(eqIdx + 1);
      // Split trailing comment outside quotes
      let inQuote = false;
      let commentIdx = -1;
      for (let c = 0; c < rhs.length; c++) {
        if (rhs[c] === '"') inQuote = !inQuote;
        else if (!inQuote && rhs[c] === ";") {
          commentIdx = c;
          break;
        }
      }
      const value = (commentIdx >= 0 ? rhs.slice(0, commentIdx) : rhs).trim();
      const comment = commentIdx >= 0 ? rhs.slice(commentIdx).trim() : "";
      const sec = currentSection || "global";
      if (!sections.includes(sec)) {
        sections.push(sec);
      }
      const id = `cfg-${nextId++}`;
      entries.push({
        id,
        section: sec,
        key,
        value,
        originalValue: value,
        comment,
        lineIndex: i,
      });
      lines.push({ kind: "entry", raw, section: sec, entryId: id });
      continue;
    }

    lines.push({ kind: "raw", raw });
  }

  return { sections, entries, lines };
}

export function serializeSysConfig(doc: SysConfigDoc): string {
  const byId = new Map(doc.entries.map((e) => [e.id, e]));
  const renderedIds = new Set<string>();
  const out: string[] = [];

  for (const line of doc.lines) {
    if (line.kind === "entry" && line.entryId) {
      const entry = byId.get(line.entryId);
      if (entry) {
        renderedIds.add(entry.id);
        const commentSuffix = entry.comment ? ` ${entry.comment}` : "";
        out.push(`${entry.key.padEnd(18)} = ${entry.value}${commentSuffix}`);
        continue;
      }
    }
    out.push(line.raw);
  }

  // Append newly added entries under their target section or at the end
  const extraEntries = doc.entries.filter((e) => !renderedIds.has(e.id));
  if (extraEntries.length > 0) {
    const grouped = new Map<string, SysConfigEntry[]>();
    for (const e of extraEntries) {
      const arr = grouped.get(e.section) || [];
      arr.push(e);
      grouped.set(e.section, arr);
    }
    for (const [sec, items] of grouped.entries()) {
      const existingSectionIdx = out.findIndex((l) => l.trim() === `[${sec}]`);
      if (existingSectionIdx >= 0) {
        let insertAt = existingSectionIdx + 1;
        while (insertAt < out.length && !out[insertAt].trim().startsWith("[")) {
          insertAt++;
        }
        const formatted = items.map(
          (e) => `${e.key.padEnd(18)} = ${e.value}${e.comment ? ` ${e.comment}` : ""}`
        );
        out.splice(insertAt, 0, ...formatted);
      } else {
        out.push("", `[${sec}]`);
        for (const e of items) {
          out.push(`${e.key.padEnd(18)} = ${e.value}${e.comment ? ` ${e.comment}` : ""}`);
        }
      }
    }
  }

  return out.join("\n");
}
