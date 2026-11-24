export const HIGHLIGHT_COLORS = ["red", "amber", "green", "blue", "purple"] as const;
export const MAX_HIGHLIGHT_RULES = 32;
export const MAX_HIGHLIGHT_KEYWORD_LENGTH = 128;
export type LogHighlightColor = typeof HIGHLIGHT_COLORS[number];

export interface LogHighlightRule {
  keyword: string;
  color: LogHighlightColor;
}

export function configuredHighlightRules(rules: readonly LogHighlightRule[]): LogHighlightRule[] {
  return rules.flatMap((rule) => {
    const keyword = rule.keyword.trim();
    return keyword ? [{ keyword, color: rule.color }] : [];
  });
}

export type LogLevelFormat = "logcat" | "dmesg" | "serial";
type LogLevel = "debug" | "info" | "notice" | "warn" | "error" | "fatal";
export type HighlightKind = LogHighlightColor | "search";

interface Range {
  start: number;
  end: number;
}

export interface HighlightRange extends Range {
  kind: HighlightKind;
}

export const HIGHLIGHT_CLASSES: Record<HighlightKind, string> = {
  search: "bg-amber-300/90 text-slate-950 dark:bg-amber-400/90",
  red: "bg-red-300/65 text-inherit dark:bg-red-500/30",
  amber: "bg-amber-300/65 text-inherit dark:bg-amber-500/35",
  green: "bg-emerald-300/65 text-inherit dark:bg-emerald-500/30",
  blue: "bg-sky-300/65 text-inherit dark:bg-sky-500/30",
  purple: "bg-violet-300/65 text-inherit dark:bg-violet-500/30",
};

export const LEVEL_CLASSES: Record<LogLevel, string> = {
  debug: "text-slate-500 dark:text-slate-400",
  info: "text-sky-700 dark:text-sky-300",
  notice: "text-teal-700 dark:text-teal-300",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-300",
  fatal: "text-rose-700 dark:text-rose-300",
};

export function detectLogLevelFormat(command: string): LogLevelFormat | undefined {
  const executable = command.trim().match(/^(?:(?:\S+\/)?(?:busybox|toybox)\s+)?(?:[^\s/]+\/|\/)*(logcat|dmesg)(?=\s|$)/)?.[1];
  if (executable === "logcat" || executable === "dmesg") return executable;
}

const LOGCAT_LEVELS: Record<string, LogLevel> = {
  V: "debug", D: "debug", I: "info", W: "warn", E: "error", F: "fatal", A: "fatal",
};
const LOGCAT_DATE = "(?:(?:\\d{4}-)?\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}\\.\\d+";
const LOGCAT_LEVEL = "([VDIWEFA])";
const LOGCAT_THREADTIME = new RegExp(`^((?:${LOGCAT_DATE}|\\d{9,}\\.\\d+)\\s+\\d+\\s+\\d+\\s+)${LOGCAT_LEVEL}\\s+[^:]+:`);
const LOGCAT_BRIEF = new RegExp(`^((?:${LOGCAT_DATE}\\s+)?)${LOGCAT_LEVEL}(?=\\/[^:]+:|\\s*\\(\\s*\\d+\\)\\s*:)`);
const LOGCAT_LONG = new RegExp(`^(\\[\\s*${LOGCAT_DATE}\\s+\\d+\\s*:\\s*\\d+\\s+)${LOGCAT_LEVEL}\\/[^\\]]+\\]`);
const KERNEL_LEVELS: readonly LogLevel[] = ["fatal", "fatal", "fatal", "error", "warn", "notice", "info", "debug"];
const KERNEL_NAMES: Record<string, LogLevel> = {
  emerg: "fatal", alert: "fatal", crit: "fatal", err: "error",
  warn: "warn", notice: "notice", info: "info", debug: "debug",
};
const KERNEL_FACILITY_LEVEL =
  /^(?:kern|user|mail|daemon|auth|syslog|lpr|news|uucp|cron|authpriv|ftp|local[0-7])\s*:\s*(emerg|alert|crit|err|warn|notice|info|debug)\s*:/;
const SERIAL_LEVELS: Record<string, LogLevel> = {
  ...KERNEL_NAMES, trace: "debug", warning: "warn", error: "error", fatal: "fatal", panic: "fatal", critical: "fatal",
};
const SERIAL_LEVEL_WORD = "trace|debug|info|notice|warn(?:ing)?|err(?:or)?|fatal|panic|crit(?:ical)?|alert|emerg";
const SERIAL_PREFIX = "^\\s*(?:\\[\\s*\\d[\\d .:T+Z-]*\\]\\s*)?";
const SERIAL_BRACKETED = new RegExp(`${SERIAL_PREFIX}\\[(${SERIAL_LEVEL_WORD})\\]`, "i");
const SERIAL_LABEL = new RegExp(`${SERIAL_PREFIX}(${SERIAL_LEVEL_WORD})(?=\\s*:|\\s+-\\s)`, "i");
const SERIAL_SHORT = new RegExp(`${SERIAL_PREFIX}([VDIWEF])(?=\\s+\\(\\d+\\)\\s+[^:]+:)`);

export function findLogLevel(text: string, format: LogLevelFormat): (Range & { level: LogLevel }) | undefined {
  if (format === "serial") {
    const long = SERIAL_BRACKETED.exec(text) ?? SERIAL_LABEL.exec(text);
    if (long) {
      const end = long[0].endsWith("]") ? long[0].length - 1 : long[0].length;
      return { level: SERIAL_LEVELS[long[1].toLowerCase()], start: end - long[1].length, end };
    }
    const short = SERIAL_SHORT.exec(text);
    if (short) {
      const end = short[0].length;
      return { level: LOGCAT_LEVELS[short[1]], start: end - 1, end };
    }
    return findLogLevel(text, "dmesg") ?? findLogLevel(text, "logcat");
  }
  if (format === "logcat") {
    const match = LOGCAT_THREADTIME.exec(text) ?? LOGCAT_BRIEF.exec(text) ?? LOGCAT_LONG.exec(text);
    if (!match) return;
    const start = match[1].length;
    return { level: LOGCAT_LEVELS[match[2]], start, end: start + 1 };
  } else {
    const raw = /^<(\d{1,3})>/.exec(text);
    if (raw && Number(raw[1]) <= 191) {
      return { level: KERNEL_LEVELS[Number(raw[1]) & 7], start: 0, end: raw[0].length };
    }
    const decoded = KERNEL_FACILITY_LEVEL.exec(text);
    if (decoded) {
      const start = decoded[0].indexOf(decoded[1], decoded[0].indexOf(":") + 1);
      return { level: KERNEL_NAMES[decoded[1]], start, end: start + decoded[1].length };
    }
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createLogHighlighter(
  rules: readonly LogHighlightRule[],
  query: string,
  caseSensitive: boolean,
) {
  const active = configuredHighlightRules(rules);
  const keywords = active.length
    ? new RegExp(active.map(({ keyword }) => `(${escapeRegex(keyword)})`).join("|"), "giu")
    : null;
  const search = query ? new RegExp(escapeRegex(query), caseSensitive ? "gu" : "giu") : null;

  return (text: string): HighlightRange[] => {
    if (!keywords && !search) return [];
    const searchRanges: HighlightRange[] = search
      ? Array.from(text.matchAll(search), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
        kind: "search",
      }))
      : [];
    if (!keywords) return searchRanges;

    const ranges: HighlightRange[] = [...searchRanges];
    let searchIndex = 0;
    for (const match of text.matchAll(keywords)) {
      const end = match.index + match[0].length;
      while (searchIndex < searchRanges.length && searchRanges[searchIndex].end <= match.index) searchIndex++;
      const nextSearch = searchRanges[searchIndex];
      if (nextSearch && nextSearch.start < end) continue;
      const rule = active.find((_, index) => match[index + 1] !== undefined);
      if (rule) ranges.push({ start: match.index, end, kind: rule.color });
    }
    return ranges.sort((first, second) => first.start - second.start);
  };
}
