import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";

const MOVE_THRESHOLD = 4;

export function useSidebarDrag(enabled: boolean) {
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), [enabled]);

  return (
    event: ReactPointerEvent<HTMLButtonElement>,
    selector: string,
    onDrop: (target: HTMLElement) => void
  ) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || cancel.current) return;

    const handle = event.currentTarget;
    const source = handle.closest<HTMLElement>(selector);
    const scrollContainer = handle.closest("nav");
    if (!source?.parentElement || !scrollContainer) return;

    const elements = Array.from(source.parentElement.children).filter(
      (item): item is HTMLElement => item instanceof HTMLElement && item.matches(selector)
    );
    if (elements.length < 2) return;

    for (const element of elements) {
      element.getAnimations().forEach((animation) => animation.cancel());
    }
    const bounds = elements.map((item) => item.getBoundingClientRect());
    const origin = elements.indexOf(source);
    const original = bounds[origin];
    const spaceAbove = original.bottom - (bounds[origin - 1]?.bottom ?? original.top);
    const spaceBelow = (bounds[origin + 1]?.top ?? original.bottom) - original.top;
    const startY = event.clientY;
    const startScroll = scrollContainer.scrollTop;
    const pointerId = event.pointerId;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pointerY = startY;
    let destination = origin;
    let lifted = false;

    event.preventDefault();
    handle.setPointerCapture(pointerId);

    const preview = () => {
      const distance = pointerY - startY + scrollContainer.scrollTop - startScroll;
      if (!lifted) {
        if (Math.abs(distance) < MOVE_THRESHOLD) return;
        lifted = true;
        source.classList.add("sidebar-sort-active");
        elements.forEach((element) => {
          if (element !== source) element.classList.add("sidebar-sort-sibling");
        });
      }

      source.style.transform = `translateY(${distance}px)`;
      const center = original.top + original.height / 2 + distance;
      const nextIndex = bounds.filter(
        (rect, index) => index !== origin && center > rect.top + rect.height / 2
      ).length;
      if (nextIndex === destination) return;
      destination = nextIndex;

      elements.forEach((element, index) => {
        if (index === origin) return;
        const shift = index > origin && index <= destination
          ? -spaceBelow
          : index < origin && index >= destination ? spaceAbove : 0;
        element.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };

    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      pointerY = pointer.clientY;
      preview();
    };

    const finish = (commit: boolean, animate: boolean) => {
      const before = lifted && animate && !reduceMotion
        ? elements.map((element) => element.getBoundingClientRect().top)
        : null;
      cancel.current = null;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", drop);
      handle.removeEventListener("pointercancel", abort);
      handle.removeEventListener("lostpointercapture", abort);
      scrollContainer.removeEventListener("scroll", preview);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", abort);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      elements.forEach((element) => {
        element.classList.remove("sidebar-sort-active", "sidebar-sort-sibling");
        element.style.transform = "";
      });

      if (lifted && commit && origin !== destination) {
        flushSync(() => onDrop(elements[destination]));
      }
      before?.forEach((top, index) => {
        const element = elements[index];
        const offset = top - element.getBoundingClientRect().top;
        if (Math.abs(offset) > 1) {
          element.animate(
            [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
            { duration: 160, easing: "ease-out" }
          );
        }
      });
    };

    const drop = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      move(pointer);
      finish(true, true);
    };
    const abort = () => finish(false, true);
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key === "Escape") abort();
    };

    cancel.current = () => finish(false, false);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", drop);
    handle.addEventListener("pointercancel", abort);
    handle.addEventListener("lostpointercapture", abort);
    scrollContainer.addEventListener("scroll", preview, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", abort);
  };
}
