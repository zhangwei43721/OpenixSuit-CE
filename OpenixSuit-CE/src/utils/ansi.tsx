import { createAnsiSequenceParser, createColorPalette, type Color, type ColorName, type ParseToken } from "ansi-sequence-parser";
import React, { memo, useMemo, type CSSProperties } from "react";
import { useLogColorRules, useLogColorSettings } from "../store/logColors";
import {
  createLogHighlighter,
  findLogLevel,
  HIGHLIGHT_CLASSES,
  LEVEL_CLASSES,
  type LogHighlightRule,
  type LogLevelFormat,
} from "./logHighlight";

interface AnsiLine {
  segments: ParseToken[];
  plain: string;
}

const FG_COLOR_CLASSES: Record<ColorName, string> = {
  black: "text-slate-800 dark:text-slate-400",
  red: "text-red-600 dark:text-red-400",
  green: "text-emerald-600 dark:text-emerald-400",
  yellow: "text-amber-600 dark:text-amber-400",
  blue: "text-blue-600 dark:text-blue-400",
  magenta: "text-purple-600 dark:text-purple-400",
  cyan: "text-cyan-600 dark:text-cyan-400",
  white: "text-slate-600 dark:text-slate-200",
  brightBlack: "text-slate-500",
  brightRed: "text-rose-500 dark:text-rose-300",
  brightGreen: "text-green-500 dark:text-green-300",
  brightYellow: "text-yellow-500 dark:text-yellow-300",
  brightBlue: "text-sky-500 dark:text-sky-300",
  brightMagenta: "text-fuchsia-500 dark:text-fuchsia-300",
  brightCyan: "text-teal-500 dark:text-teal-300",
  brightWhite: "text-slate-900 dark:text-white",
};

const BG_COLOR_CLASSES: Record<ColorName, string> = {
  black: "bg-slate-900 text-slate-100",
  red: "bg-red-500/20",
  green: "bg-emerald-500/20",
  yellow: "bg-amber-500/20",
  blue: "bg-blue-500/20",
  magenta: "bg-purple-500/20",
  cyan: "bg-cyan-500/20",
  white: "bg-slate-200/80 dark:bg-slate-700/80",
  brightBlack: "bg-slate-700/40",
  brightRed: "bg-rose-500/30",
  brightGreen: "bg-green-500/30",
  brightYellow: "bg-yellow-500/30",
  brightBlue: "bg-sky-500/30",
  brightMagenta: "bg-fuchsia-500/30",
  brightCyan: "bg-teal-500/30",
  brightWhite: "bg-white/90 text-slate-900",
};

const DECORATION_CLASSES = {
  bold: "font-semibold",
  dim: "opacity-65",
  italic: "italic",
  underline: "underline",
  strikethrough: "line-through",
  overline: "overline",
  hidden: "",
  reverse: "",
};

// 只把 SGR 颜色与文字样式交给解析器，其余控制序列从日志显示中移除。
const ANSI_TOKEN_RE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|$)|\x1b[P^_X][^\x1b\n]*(?:\x1b\\|$)|\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\[[0-?]*[ -/]*$|\x1b[ -/]+[0-~]|\x1b[0-~]|\x1b/gm;
const TIMESTAMP_PREFIX_RE = /^(\[\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\]|\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?\])\s*/;
const palette = createColorPalette();
const EMPTY_RULES: readonly LogHighlightRule[] = [];
const NO_DECORATIONS: ParseToken["decorations"] = new Set();

export function stripAnsi(text: string): string {
  return text.replace(ANSI_TOKEN_RE, "").replace(/\r/g, "");
}

function normalizeSgr(parameters: string): string {
  if (!/^[\d;]*$/.test(parameters)) return "";
  if (!parameters.includes(";")) return `\x1b[${parameters || "0"}m`;

  // 解析库会先处理重置指令。拆开参数以保留终端的执行顺序，颜色参数作为一组。
  const codes = parameters.split(";");
  const sequences: string[] = [];
  for (let index = 0; index < codes.length;) {
    const code = codes[index] || "0";
    if (code === "38" || code === "48") {
      const mode = codes[index + 1];
      const length = mode === "5" ? 3 : mode === "2" ? 5 : 1;
      if (length > 1 && index + length <= codes.length) {
        sequences.push(`\x1b[${codes.slice(index, index + length).join(";")}m`);
      }
      index += length;
    } else {
      sequences.push(`\x1b[${code}m`);
      index++;
    }
  }
  return sequences.join("");
}

function plainSegment(value: string): ParseToken {
  return { value, foreground: null, background: null, decorations: NO_DECORATIONS };
}

export function parseAnsiLines(text: string, ansiEnabled = true): AnsiLine[] {
  const parser = ansiEnabled && text.includes("\x1b") ? createAnsiSequenceParser() : null;
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (!parser) {
      const plain = ansiEnabled ? line : stripAnsi(line);
      return { plain, segments: [plainSegment(plain)] };
    }
    const cleaned = line.replace(ANSI_TOKEN_RE, (_match, params, intermediate, final) =>
      final === "m" && !intermediate ? normalizeSgr(params) : "");
    const segments = parser.parse(cleaned);
    return { segments, plain: segments.map((token) => token.value).join("") };
  });
}

function colorValue(color: Color | null): string | undefined {
  return color && color.type !== "named" ? palette.value(color) : undefined;
}

function segmentStyle(segment: ParseToken) {
  const reverse = segment.decorations.has("reverse");
  const foreground = reverse ? segment.background : segment.foreground;
  const background = reverse ? segment.foreground : segment.background;
  const classes = Array.from(segment.decorations, (key) => DECORATION_CLASSES[key]);
  if (foreground?.type === "named") classes.push(FG_COLOR_CLASSES[foreground.name]);
  if (background?.type === "named") classes.push(BG_COLOR_CLASSES[background.name]);
  const style: CSSProperties = {
    color: colorValue(foreground) ?? (reverse && !foreground ? "var(--ansi-viewer-bg)" : undefined),
    backgroundColor: colorValue(background) ?? (reverse && !background ? "var(--ansi-viewer-fg)" : undefined),
  };
  return { className: classes.filter(Boolean).join(" "), style };
}

type HighlightLine = ReturnType<typeof createLogHighlighter>;

function renderLine(
  line: AnsiLine,
  showTimestamp: boolean,
  highlightLine: HighlightLine,
  levelFormat: LogLevelFormat | undefined,
) {
  if (!line.plain) return "\u00a0";
  const timestamp = showTimestamp ? TIMESTAMP_PREFIX_RE.exec(line.plain) : null;
  const bodyStart = timestamp?.[0].length ?? 0;
  const body = line.plain.slice(bodyStart);
  const ranges = highlightLine(body);
  const level = levelFormat && findLogLevel(body, levelFormat);
  if (!timestamp && ranges.length === 0 && !level && line.segments.length === 1) {
    const segment = line.segments[0];
    if (!segment.foreground && !segment.background && !segment.decorations.size) return body;
  }
  let offset = -bodyStart;
  let rangeIndex = 0;
  const nodes: React.ReactNode[] = [];
  if (timestamp) {
    nodes.push(<span key="timestamp" className="mr-1.5 select-none text-slate-400 dark:text-slate-500">{timestamp[1]}</span>);
  }

  for (const segment of line.segments) {
    const end = offset + segment.value.length;
    let cursor = Math.max(0, offset);
    if (cursor < end) {
      const parts: React.ReactNode[] = [];
      while (cursor < end) {
        while (ranges[rangeIndex]?.end <= cursor) rangeIndex++;
        const range = ranges[rangeIndex];
        const highlighted = range && range.start <= cursor;
        const atLevel = level && level.start <= cursor && cursor < level.end;
        const rangeBoundary = range ? (highlighted ? range.end : range.start) : end;
        const levelBoundary = level && cursor < level.end ? (atLevel ? level.end : level.start) : end;
        const stop = Math.min(end, rangeBoundary, levelBoundary);
        let content: React.ReactNode = segment.value.slice(cursor - offset, stop - offset);
        if (highlighted) {
          content = <mark className={HIGHLIGHT_CLASSES[range.kind]} data-highlight={range.kind}>{content}</mark>;
        }
        if (atLevel) {
          content = <span className={`font-semibold ${LEVEL_CLASSES[level.level]}`} data-log-level={level.level}>{content}</span>;
        }
        parts.push(<React.Fragment key={cursor}>{content}</React.Fragment>);
        cursor = stop;
      }
      const { className, style } = segmentStyle(segment);
      nodes.push(<span key={offset} className={className || undefined} style={style}>{parts}</span>);
    }
    offset = end;
  }
  return nodes;
}

// 保留日志原有排版，只给命中文本加底色。
export const LogMarkedText = memo(function LogMarkedText({ text }: { text: string }) {
  const { highlight } = useLogColorSettings();
  const ranges = highlight(text);
  if (ranges.length === 0) return <>{text}</>;

  let offset = 0;
  return (
    <>
      {ranges.map(({ start, end, kind }) => {
        const before = text.slice(offset, start);
        offset = end;
        return (
          <React.Fragment key={start}>
            {before}
            <mark className={HIGHLIGHT_CLASSES[kind]} data-highlight={kind}>{text.slice(start, end)}</mark>
          </React.Fragment>
        );
      })}
      {text.slice(offset)}
    </>
  );
});

export interface AnsiTextProps {
  text: string;
  showTimestamps?: boolean;
  ansiEnabled?: boolean;
  searchQuery?: string;
  filterOnly?: boolean;
  caseSensitive?: boolean;
  highlightRules?: readonly LogHighlightRule[];
  levelFormat?: LogLevelFormat;
  className?: string;
}

export const AnsiText = memo(function AnsiText({
  text,
  showTimestamps = false,
  ansiEnabled = true,
  searchQuery = "",
  filterOnly = false,
  caseSensitive = false,
  highlightRules = EMPTY_RULES,
  levelFormat,
  className = "",
}: AnsiTextProps) {
  const lines = useMemo(() => parseAnsiLines(text, ansiEnabled), [text, ansiEnabled]);
  const sharedRules = useLogColorRules();
  const highlightLine = useMemo(
    () => createLogHighlighter([...highlightRules, ...sharedRules], searchQuery, caseSensitive),
    [highlightRules, sharedRules, searchQuery, caseSensitive],
  );
  const needle = caseSensitive ? searchQuery : searchQuery.toLowerCase();

  return (
    <div className={`break-all whitespace-pre-wrap font-mono text-xs leading-5 [--ansi-viewer-bg:#fff] [--ansi-viewer-fg:#0f172a] dark:[--ansi-viewer-bg:#0f172a] dark:[--ansi-viewer-fg:#e2e8f0] ${className}`}>
      {lines.map((line, index) => {
        if (filterOnly && needle) {
          const body = showTimestamps ? line.plain.replace(TIMESTAMP_PREFIX_RE, "") : line.plain;
          if (!(caseSensitive ? body : body.toLowerCase()).includes(needle)) return null;
        }
        return (
          <div key={index} data-log-line={index} className="min-h-[1.25rem]">
            {renderLine(line, showTimestamps, highlightLine, levelFormat)}
          </div>
        );
      })}
    </div>
  );
});
