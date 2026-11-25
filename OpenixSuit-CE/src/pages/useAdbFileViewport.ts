import { useCallback, useLayoutEffect, useState } from "react";

const GRID_GAP = 12;
const GRID_MIN_CARD_WIDTH = 112;
const GRID_ROW_HEIGHT = 104;
const LIST_ROW_HEIGHT = 36;
const OVERSCAN_ROWS = 4;
const CONTENT_PADDING = 32;

export function useAdbFileViewport(element: HTMLDivElement | null, view: "grid" | "list", count: number) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollRow, setScrollRow] = useState(0);
  const grid = view === "grid";
  const rowHeight = grid ? GRID_ROW_HEIGHT : LIST_ROW_HEIGHT;
  const availableGridWidth = size.width - CONTENT_PADDING + GRID_GAP;
  const columns = grid
    ? Math.min(6, Math.max(1, Math.floor(availableGridWidth / (GRID_MIN_CARD_WIDTH + GRID_GAP))))
    : 1;
  const rowCount = Math.ceil(count / columns);
  const startRow = Math.max(0, Math.min(rowCount - 1, scrollRow - OVERSCAN_ROWS));
  const endRow = Math.min(rowCount, scrollRow + Math.ceil(size.height / rowHeight) + OVERSCAN_ROWS + 1);
  const syncScroll = useCallback(() => {
    if (element) setScrollRow(Math.max(0, Math.floor(element.scrollTop / rowHeight)));
  }, [element, rowHeight]);

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element;
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
      syncScroll();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, syncScroll]);

  const revealIndex = useCallback((index: number) => {
    if (!element) return;
    const top = Math.floor(index / columns) * rowHeight;
    const inset = grid ? CONTENT_PADDING : CONTENT_PADDING + LIST_ROW_HEIGHT;
    if (top < element.scrollTop || top + rowHeight > element.scrollTop + element.clientHeight - inset) {
      element.scrollTop = top;
    }
    syncScroll();
  }, [columns, element, grid, rowHeight, syncScroll]);

  return {
    first: startRow * columns,
    end: Math.min(count, endRow * columns),
    rowHeight,
    gridHeight: Math.max(0, rowCount * GRID_ROW_HEIGHT - GRID_GAP),
    gridCardStyle: (index: number) => {
      const column = index % columns;
      return {
        top: Math.floor(index / columns) * GRID_ROW_HEIGHT,
        left: `calc(${column * 100 / columns}% + ${column * GRID_GAP / columns}px)`,
        width: `calc(${100 / columns}% - ${GRID_GAP * (columns - 1) / columns}px)`,
        height: GRID_ROW_HEIGHT - GRID_GAP,
      };
    },
    syncScroll,
    revealIndex,
  };
}
