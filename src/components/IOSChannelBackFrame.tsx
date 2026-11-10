import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { edgeSwipeSide } from "./edgeSwipe";

type EdgeDrag = {
  id: number;
  x: number;
  y: number;
  extent: number;
  offset: number | null;
};

export function useIOSPageDrag(frame: RefObject<HTMLDivElement | null>, active: boolean, onCommit: () => void) {
  const translation = (offset: number) => `${offset}px`;
  const drag = useRef<EdgeDrag | null>(null);
  const settling = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = frame.current;
    return () => {
      drag.current = null;
      settling.current?.cancel();
      settling.current = null;
      element?.style.removeProperty("translate");
      frame.current?.style.removeProperty("translate");
    };
  }, [active, frame]);

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!active || settling.current || !event.isPrimary || event.pointerType !== "touch") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
    const dialog = target.closest(".hg-ios-sheet, .hg-ios-alert");
    if (dialog && dialog !== event.currentTarget) return;
    if (target.closest("[data-dialog-backdrop], input, textarea, select, [contenteditable]")) return;
    if (edgeSwipeSide(event.clientX - bounds.left, bounds.width, event.currentTarget, 20) !== -1) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, extent: bounds.width, offset: null };
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const distance = event.clientX - start.x;
    const cross = Math.abs(event.clientY - start.y);
    if (start.offset === null) {
      if (Math.max(Math.abs(distance), cross) < 8) return;
      if (distance <= cross) {
        drag.current = null;
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    start.offset = Math.max(0, Math.min(distance, start.extent));
    event.currentTarget.style.translate = translation(start.offset);
  };

  const onFinish = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    if (start.offset === null) return;

    const element = event.currentTarget;
    const threshold = Math.min(96, start.extent / 4);
    const commit = event.type === "pointerup" && start.offset >= threshold;
    const target = commit ? start.extent : 0;
    if (start.offset === target || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.style.removeProperty("translate");
      if (commit) onCommit();
      return;
    }

    const animation = element.animate(
      [{ translate: translation(start.offset) }, { translate: translation(target) }],
      { duration: commit ? 200 : 170, easing: "cubic-bezier(.2, 0, .2, 1)" },
    );
    settling.current = animation;
    element.style.translate = translation(target);
    void animation.finished.then(() => {
      if (settling.current !== animation) return;
      settling.current = null;
      if (commit) onCommit();
      else element.style.removeProperty("translate");
    }, () => {});
  };

  return {
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onFinish,
    onPointerCancel: onFinish,
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onFinish(event);
    },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (!settling.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

export default function IOSChannelBackFrame({ active, onBack, gestureEnabled = true, transparent = false, children }: {
  active: boolean;
  onBack: () => void;
  gestureEnabled?: boolean;
  transparent?: boolean;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const gesture = useIOSPageDrag(frame, active && gestureEnabled, onBack);
  return (
    <div ref={frame} inert={!active} className={`hg-ios-back-frame absolute inset-0 z-30 a-page-in ${transparent ? "" : "bg-bg"}`}
      {...gesture}>
      {children}
    </div>
  );
}
