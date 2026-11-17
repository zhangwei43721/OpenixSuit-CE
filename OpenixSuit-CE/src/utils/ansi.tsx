import React, { useMemo } from "react";

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

export interface AnsiLine {
  segments: AnsiSegment[];
  plain: string;
}

const FG_COLOR_CLASSES: Record<number, string> = {
  30: "text-slate-800 dark:text-slate-400",
  31: "text-red-600 dark:text-red-400",
  32: "text-emerald-600 dark:text-emerald-400",
  33: "text-amber-600 dark:text-amber-400",
  34: "text-blue-600 dark:text-blue-400",
  35: "text-purple-600 dark:text-purple-400",
  36: "text-cyan-600 dark:text-cyan-400",
  37: "text-slate-600 dark:text-slate-200",
  90: "text-slate-500 dark:text-slate-500",
  91: "text-rose-500 dark:text-rose-300",
  92: "text-green-500 dark:text-green-300",
  93: "text-yellow-500 dark:text-yellow-300",
  94: "text-sky-500 dark:text-sky-300",
  95: "text-fuchsia-500 dark:text-fuchsia-300",
  96: "text-teal-500 dark:text-teal-300",
  97: "text-slate-900 dark:text-white",
};

const BG_COLOR_CLASSES: Record<number, string> = {
  40: "bg-slate-900 text-slate-100",
  41: "bg-red-500/20",
  42: "bg-emerald-500/20",
  43: "bg-amber-500/20",
  44: "bg-blue-500/20",
  45: "bg-purple-500/20",
  46: "bg-cyan-500/20",
  47: "bg-slate-200/80 dark:bg-slate-700/80",
  100: "bg-slate-700/40",
  101: "bg-rose-500/30",
  102: "bg-green-500/30",
  103: "bg-yellow-500/30",
  104: "bg-sky-500/30",
  105: "bg-fuchsia-500/30",
  106: "bg-teal-500/30",
  107: "bg-white/90 text-slate-900",
};

// Matches OSC, CSI (SGR or other), and stray 2-byte ESC sequences
const ANSI_TOKEN_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-9;?]*)([A-Za-z])|\x1b[@-Z\\-_]/g;

/**
 * Strip all ANSI/VT control sequences from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_TOKEN_RE, "").replace(/\r/g, "");
}

function applySgrCodes(current: AnsiStyle, rawCodes: string): AnsiStyle {
  if (!rawCodes) {
    return {};
  }
  const codes = rawCodes.split(";").map((c) => (c === "" ? 0 : parseInt(c, 10)));
  let next: AnsiStyle = { ...current };

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (Number.isNaN(code)) continue;

    if (code === 0) {
      next = {};
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 27) {
      next.inverse = false;
    } else if (code === 39) {
      delete next.fg;
    } else if (code === 49) {
      delete next.bg;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      next.fg = FG_COLOR_CLASSES[code];
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      next.bg = BG_COLOR_CLASSES[code];
    } else if (code === 38 || code === 48) {
      // Skip extended 256-color (5;n) or truecolor (2;r;g;b) arguments cleanly
      const mode = codes[i + 1];
      if (mode === 5) {
        i += 2;
      } else if (mode === 2) {
        i += 4;
      }
    }
  }

  return next;
}

/**
 * Parse text containing ANSI escape codes into structured lines and styled segments.
 * Unknown CSI / OSC sequences are stripped so raw escapes never pollute the UI.
 */
export function parseAnsiLines(text: string): AnsiLine[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  let activeStyle: AnsiStyle = {};

  return rawLines.map((rawLine) => {
    const segments: AnsiSegment[] = [];
    let plain = "";
    let lastIndex = 0;

    ANSI_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ANSI_TOKEN_RE.exec(rawLine)) !== null) {
      if (match.index > lastIndex) {
        const chunk = rawLine.slice(lastIndex, match.index);
        segments.push({ text: chunk, style: { ...activeStyle } });
        plain += chunk;
      }
      const csiParams = match[1];
      const csiFinal = match[2];
      if (csiFinal === "m" && csiParams !== undefined && !csiParams.includes("?")) {
        activeStyle = applySgrCodes(activeStyle, csiParams);
      }
      lastIndex = ANSI_TOKEN_RE.lastIndex;
    }

    if (lastIndex < rawLine.length) {
      const tail = rawLine.slice(lastIndex);
      segments.push({ text: tail, style: { ...activeStyle } });
      plain += tail;
    }

    if (segments.length === 0) {
      segments.push({ text: "", style: {} });
    }

    return { segments, plain };
  });
}

function styleToClassName(style: AnsiStyle): string {
  const cls: string[] = [];
  if (style.fg) cls.push(style.fg);
  if (style.bg) cls.push(style.bg);
  if (style.bold) cls.push("font-semibold");
  if (style.dim) cls.push("opacity-65");
  if (style.italic) cls.push("italic");
  if (style.underline) cls.push("underline");
  if (style.inverse) cls.push("bg-slate-800 text-slate-100 dark:bg-slate-200 dark:text-slate-900 px-0.5 rounded-sm");
  return cls.join(" ");
}

function renderHighlightedText(
  text: string,
  searchQuery: string,
  caseSensitive: boolean,
  keyPrefix: string
): React.ReactNode {
  if (!searchQuery) return text;
  const needle = caseSensitive ? searchQuery : searchQuery.toLowerCase();
  if (!needle) return text;

  const haystack = caseSensitive ? text : text.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let start = 0;
  let idx = haystack.indexOf(needle, start);
  let partIdx = 0;

  while (idx !== -1) {
    if (idx > start) {
      nodes.push(text.slice(start, idx));
    }
    const matched = text.slice(idx, idx + needle.length);
    nodes.push(
      <mark
        key={`${keyPrefix}-m-${partIdx++}`}
        className="bg-amber-300/90 text-slate-950 dark:bg-amber-400/90 dark:text-slate-950 rounded-sm px-0.5"
      >
        {matched}
      </mark>
    );
    start = idx + needle.length;
    idx = haystack.indexOf(needle, start);
  }

  if (start < text.length) {
    nodes.push(text.slice(start));
  }

  return nodes.length > 0 ? nodes : text;
}

export interface AnsiTextProps {
  text: string;
  showTimestamps?: boolean;
  ansiEnabled?: boolean;
  searchQuery?: string;
  caseSensitive?: boolean;
  className?: string;
}

const TIMESTAMP_PREFIX_RE = /^(\[\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\]|\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\])\s*/;

export const AnsiText: React.FC<AnsiTextProps> = ({
  text,
  showTimestamps = false,
  ansiEnabled = true,
  searchQuery = "",
  caseSensitive = false,
  className = "",
}) => {
  const lines = useMemo(() => parseAnsiLines(text), [text]);

  return (
    <div className={`font-mono text-xs leading-5 whitespace-pre-wrap break-all ${className}`}>
      {lines.map((line, lineIdx) => {
        if (!ansiEnabled) {
          const plain = line.plain;
          const tsMatch = showTimestamps ? plain.match(TIMESTAMP_PREFIX_RE) : null;
          if (tsMatch) {
            const ts = tsMatch[1];
            const rest = plain.slice(tsMatch[0].length);
            return (
              <div key={lineIdx} className="min-h-[1.25rem]">
                <span className="text-slate-400 dark:text-slate-500 select-none mr-1.5">{ts}</span>
                <span>{renderHighlightedText(rest, searchQuery, caseSensitive, `${lineIdx}-p`)}</span>
              </div>
            );
          }
          return (
            <div key={lineIdx} className="min-h-[1.25rem]">
              {plain ? renderHighlightedText(plain, searchQuery, caseSensitive, `${lineIdx}-p`) : "\u00A0"}
            </div>
          );
        }

        // ANSI enabled
        const firstSeg = line.segments[0];
        const tsMatch =
          showTimestamps && firstSeg ? firstSeg.text.match(TIMESTAMP_PREFIX_RE) : null;

        return (
          <div key={lineIdx} className="min-h-[1.25rem]">
            {line.segments.length === 1 && line.segments[0].text === "" ? (
              "\u00A0"
            ) : (
              line.segments.map((seg, segIdx) => {
                if (segIdx === 0 && tsMatch) {
                  const ts = tsMatch[1];
                  const rest = seg.text.slice(tsMatch[0].length);
                  const cls = styleToClassName(seg.style);
                  return (
                    <React.Fragment key={segIdx}>
                      <span className="text-slate-400 dark:text-slate-500 select-none mr-1.5">
                        {ts}
                      </span>
                      {rest && (
                        <span className={cls}>
                          {renderHighlightedText(rest, searchQuery, caseSensitive, `${lineIdx}-${segIdx}`)}
                        </span>
                      )}
                    </React.Fragment>
                  );
                }

                const cls = styleToClassName(seg.style);
                const content = renderHighlightedText(
                  seg.text,
                  searchQuery,
                  caseSensitive,
                  `${lineIdx}-${segIdx}`
                );
                return cls ? (
                  <span key={segIdx} className={cls}>
                    {content}
                  </span>
                ) : (
                  <React.Fragment key={segIdx}>{content}</React.Fragment>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
};
