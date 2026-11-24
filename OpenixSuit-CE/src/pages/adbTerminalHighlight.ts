import type { Terminal } from "@xterm/xterm";
import { configuredHighlightRules, createLogHighlighter, type LogHighlightRule } from "../utils/logHighlight";

const COLOR_STYLES: Record<LogHighlightRule["color"], string> = {
  red: "rgba(248, 113, 113, 0.34)",
  amber: "rgba(251, 191, 36, 0.34)",
  green: "rgba(52, 211, 153, 0.30)",
  blue: "rgba(56, 189, 248, 0.30)",
  purple: "rgba(192, 132, 252, 0.32)",
};

interface CellRange {
  start: number;
  end: number;
  column: number;
  width: number;
}

export interface AdbTerminalHighlightOverlay {
  updateRules(rules: readonly LogHighlightRule[]): void;
  dispose(): void;
}

// 标记当前视口，普通屏幕和全屏程序的备用屏幕使用同一套规则。
export function createAdbTerminalHighlightOverlay(
  terminal: Terminal,
  host: HTMLDivElement,
  initialRules: readonly LogHighlightRule[],
): AdbTerminalHighlightOverlay {
  const overlay = document.createElement("div");
  overlay.className = "adb-terminal-keyword-overlay";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "2",
  });
  const originalPosition = host.style.position;
  if (!originalPosition) host.style.position = "relative";
  host.appendChild(overlay);

  let rules = configuredHighlightRules(initialRules);
  let highlight = createLogHighlighter(rules, "", false);
  let frame = 0;
  let disposed = false;
  const schedule = () => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(render);
  };

  const render = () => {
    frame = 0;
    if (disposed || !terminal.element) return;
    if (rules.length === 0) {
      if (overlay.firstChild) overlay.replaceChildren();
      return;
    }
    const screen = terminal.element.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !terminal.cols || !terminal.rows) return;

    const hostRect = host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    if (cellWidth <= 0 || cellHeight <= 0) {
      overlay.replaceChildren();
      return;
    }
    Object.assign(overlay.style, {
      left: `${screenRect.left - hostRect.left}px`,
      top: `${screenRect.top - hostRect.top}px`,
      width: `${screenRect.width}px`,
      height: `${screenRect.height}px`,
    });

    const marks = document.createDocumentFragment();
    const buffer = terminal.buffer.active;
    const reusableCell = buffer.getNullCell();
    for (let row = 0; row < terminal.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;
      let text = "";
      const cells: CellRange[] = [];
      for (let column = 0; column < terminal.cols; column++) {
        const cell = line.getCell(column, reusableCell);
        if (!cell) break;
        const width = cell.getWidth();
        if (width === 0) continue;
        const chars = cell.getChars() || (width === 2 ? "  " : " ");
        const start = text.length;
        text += chars;
        cells.push({ start, end: text.length, column, width });
      }

      for (const range of highlight(text)) {
        if (range.kind === "search") continue;
        const first = cells.find((cell) => cell.end > range.start);
        let last: CellRange | undefined;
        for (const cell of cells) {
          if (cell.start >= range.end) break;
          if (cell.end > range.start) last = cell;
        }
        if (!first || !last) continue;
        const mark = document.createElement("span");
        Object.assign(mark.style, {
          position: "absolute",
          left: `${first.column * cellWidth}px`,
          top: `${row * cellHeight}px`,
          width: `${(last.column + last.width - first.column) * cellWidth}px`,
          height: `${cellHeight}px`,
          backgroundColor: COLOR_STYLES[range.kind],
        });
        marks.appendChild(mark);
      }
    }
    overlay.replaceChildren(marks);
  };

  const subscriptions = [
    terminal.onRender(schedule),
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
    terminal.buffer.onBufferChange(schedule),
  ];
  const observer = new ResizeObserver(schedule);
  observer.observe(host);
  schedule();

  return {
    updateRules(nextRules) {
      rules = configuredHighlightRules(nextRules);
      highlight = createLogHighlighter(rules, "", false);
      schedule();
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.dispose();
      observer.disconnect();
      overlay.remove();
      if (!originalPosition) host.style.position = "";
    },
  };
}
