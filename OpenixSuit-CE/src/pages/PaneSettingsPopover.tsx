import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface PaneSettingsPopoverProps {
  anchor: HTMLButtonElement;
  id: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}

export function PaneSettingsPopover({
  anchor, id, title, closeLabel, onClose, children, actions,
}: PaneSettingsPopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const page = anchor.closest("main");
    const padding = 8;
    const updatePosition = () => {
      if (!anchor.isConnected || !anchor.getClientRects().length) {
        onClose();
        return;
      }
      const bounds = page?.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const leftEdge = Math.max(0, bounds?.left ?? 0) + padding;
      const rightEdge = Math.min(viewportWidth, bounds?.right ?? viewportWidth) - padding;
      const topEdge = Math.max(0, bounds?.top ?? 0) + padding;
      const bottomEdge = Math.min(viewportHeight, bounds?.bottom ?? viewportHeight) - padding;
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom < topEdge || rect.top > bottomEdge) {
        onClose();
        return;
      }
      const width = Math.max(0, Math.min(464, rightEdge - leftEdge));
      const left = Math.min(Math.max(rect.right - width, leftEdge), rightEdge - width);
      const above = rect.top - topEdge - padding;
      const below = bottomEdge - rect.bottom - padding;
      const opensBelow = below >= 300 || below >= above;
      setPosition({
        left,
        width,
        ...(opensBelow ? { top: rect.bottom + padding } : { bottom: viewportHeight - rect.top + padding }),
        maxHeight: Math.max(0, Math.min(512, opensBelow ? below : above)),
      });
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !panel.current?.contains(target) && !anchor.contains(target)) {
        onClose();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        anchor.focus({ preventScroll: true });
        onClose();
      }
    };
    const handleScroll = (event: Event) => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) updatePosition();
    };
    const resize = new ResizeObserver(updatePosition);
    resize.observe(anchor);
    if (page) resize.observe(page);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", updatePosition);
    updatePosition();
    const focus = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(focus);
      resize.disconnect();
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      style={position}
      className="ui-card fixed z-40 flex min-w-0 flex-col overflow-hidden shadow-lg outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <h2 id={`${id}-title`} title={title} className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={() => {
            anchor.focus({ preventScroll: true });
            onClose();
          }}
          className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {children}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-200 p-2 dark:border-slate-700">
        {actions}
      </div>
    </div>,
    document.body,
  );
}
