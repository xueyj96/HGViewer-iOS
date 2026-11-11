import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { edgeSwipeSide } from "./edgeSwipe";

type Drag = { id: number; x: number; y: number; lastX: number; time: number; velocity: number; width: number; target: number; offset: number | null };
type Options = { index: number; count: number; onChange: (index: number) => void; enabled: boolean };
const easing = "cubic-bezier(.2,0,.2,1)";

/** One committed selection, one optional neighbour. Preview never commits application state. */
export function useIOSTabSwipe({ index, count, onChange, enabled }: Options) {
  const viewport = useRef<HTMLDivElement>(null);
  const segments = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const offset = useRef(0);
  const animations = useRef<Animation[]>([]);
  const generation = useRef(0);
  const blockedClickUntil = useRef(0);
  const commit = useRef(onChange);
  commit.current = onChange;

  const thumb = (distance: number, destination = pending.current) => {
    const root = segments.current;
    if (!root) return null;
    const buttons = root.querySelectorAll<HTMLButtonElement>(":scope > button");
    const from = buttons[index], to = buttons[destination ?? index];
    if (!from || !to) return null;
    const origin = root.getBoundingClientRect(), a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const width = viewport.current?.clientWidth || 1;
    const progress = Math.min(1, Math.abs(distance) / width);
    return { x: a.left - origin.left + (b.left - a.left) * progress, width: a.width + (b.width - a.width) * progress };
  };
  const draw = (distance: number) => {
    offset.current = distance;
    viewport.current?.style.setProperty("--hg-tab-offset", `${distance}px`);
    const rect = thumb(distance);
    if (rect && indicator.current) {
      indicator.current.style.transform = `translateX(${rect.x}px)`;
      indicator.current.style.width = `${rect.width}px`;
    }
  };
  const cancel = () => {
    generation.current++;
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    drag.current = null;
    pending.current = null;
    setTarget(null);
    setBusy(false);
    draw(0);
  };
  useLayoutEffect(() => {
    cancel();
    window.addEventListener(IOS_LAYOUT_CHANGE, cancel);
    return () => {
      generation.current++;
      animations.current.forEach((animation) => animation.cancel());
      animations.current = [];
      drag.current = null;
      window.removeEventListener(IOS_LAYOUT_CHANGE, cancel);
    };
  }, [index, count, enabled]);
  const observe = () => {
    draw(offset.current);
    let width = viewport.current?.clientWidth;
    const resize = new ResizeObserver(() => {
      const nextWidth = viewport.current?.clientWidth;
      if (pending.current !== null && nextWidth !== width) cancel();
      else if (pending.current === null) draw(0);
      width = nextWidth;
    });
    if (viewport.current) resize.observe(viewport.current);
    if (segments.current) resize.observe(segments.current);
    return () => resize.disconnect();
  };
  useLayoutEffect(() => {
    // Release a rollback's held frame only after React has removed its neighbour.
    // A successful transition is released by the committed-index effect above.
    if (pending.current === null) {
      animations.current.forEach((animation) => animation.cancel());
      animations.current = [];
    }
    draw(offset.current);
  });

  const settle = (destination: number, accepted: boolean) => {
    const root = viewport.current;
    if (!root) { cancel(); return; }
    const revision = ++generation.current;
    const width = root.clientWidth;
    const direction = destination > index ? 1 : -1;
    const start = offset.current;
    const end = accepted ? -direction * width : 0;
    const fromThumb = thumb(start), toThumb = thumb(end);
    const finish = () => {
      if (generation.current !== revision) return;
      if (accepted) {
        // Keep the incoming pane and final frame until the owner commits index.
        // Resetting CSS or unmounting it here exposes the old pane between commits.
        commit.current(destination);
        return;
      }
      pending.current = null;
      setTarget(null);
      setBusy(false);
      offset.current = 0;
    };
    draw(end);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || start === end) { finish(); return; }
    const options = { duration: accepted ? 200 : 170, easing, fill: "forwards" as const };
    const running = [...root.querySelectorAll<HTMLElement>(":scope > [data-hg-tab-pane]")].map((pane) => {
      const step = Number(pane.dataset.hgTabPane) === index ? 0 : direction;
      return pane.animate([{ transform: `translate3d(${step * width + start}px,0,0)` },
        { transform: `translate3d(${step * width + end}px,0,0)` }], options);
    });
    if (indicator.current && fromThumb && toThumb) running.push(indicator.current.animate([
      { transform: `translateX(${fromThumb.x}px)`, width: `${fromThumb.width}px` },
      { transform: `translateX(${toThumb.x}px)`, width: `${toThumb.width}px` },
    ], options));
    animations.current = running;
    void Promise.allSettled(running.map((animation) => animation.finished)).then(finish);
  };
  const available = () => enabled && !viewport.current?.closest("[inert], [hidden]") &&
    !!viewport.current?.getClientRects().length && !document.querySelector(".hg-cover-menu-layer");
  const select = (next: number) => {
    if (!available() || busy || pending.current !== null || next === index || next < 0 || next >= count) return;
    pending.current = next;
    setTarget(next);
    setBusy(true);
    const revision = generation.current;
    requestAnimationFrame(() => { if (generation.current === revision && pending.current === next) settle(next, true); });
  };
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    // Suppress only the synthetic click from a completed swipe, never a new gesture.
    if (event.isPrimary) blockedClickUntil.current = 0;
    if (!available() || pending.current !== null || !event.isPrimary || event.pointerType !== "touch") return;
    const element = event.target;
    if (!(element instanceof Element) || element.closest("input,textarea,select,[contenteditable],[data-dialog-backdrop]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = edgeSwipeSide(event.clientX - bounds.left, bounds.width, event.currentTarget, 20);
    const next = index + side;
    if (!side || next < 0 || next >= count) return; // Boundary keeps the existing back gesture.
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX,
      time: event.timeStamp, velocity: 0, width: bounds.width, target: next, offset: null };
    event.stopPropagation(); // Parent back gestures must not also claim this pointerdown.
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    if (!available()) { if (pending.current !== null) cancel(); else drag.current = null; return; }
    const dx = event.clientX - start.x, dy = Math.abs(event.clientY - start.y);
    const direction = start.target > index ? 1 : -1;
    if (start.offset === null) {
      if (Math.max(Math.abs(dx), dy) < 8) return;
      if (-direction * dx <= dy * 1.2) { drag.current = null; return; }
      pending.current = start.target;
      setTarget(start.target);
      setBusy(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const elapsed = event.timeStamp - start.time;
    if (elapsed > 0) start.velocity = elapsed < 120 ? (event.clientX - start.lastX) / elapsed : 0;
    start.lastX = event.clientX;
    start.time = event.timeStamp;
    start.offset = -direction * Math.min(start.width, Math.max(0, -direction * dx));
    draw(start.offset);
    event.preventDefault();
    event.stopPropagation();
  };
  const onEnd = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    if (start.offset === null) return;
    const direction = start.target > index ? 1 : -1;
    const speed = event.timeStamp - start.time > 100 ? 0 : -direction * start.velocity;
    const distance = Math.abs(start.offset);
    const accepted = event.type === "pointerup" && ((distance >= Math.min(96, start.width / 4) && speed >= -.2) || (distance >= 24 && speed > .45));
    blockedClickUntil.current = performance.now() + 800;
    event.preventDefault();
    event.stopPropagation();
    settle(start.target, accepted);
  };
  return { index, count, target, busy, enabled, viewport, segments, indicator, select, observe, refresh: () => draw(offset.current),
    gesture: { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onEnd, onPointerCancel: onEnd,
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onEnd(event); },
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (busy || performance.now() <= blockedClickUntil.current) { event.preventDefault(); event.stopPropagation(); }
      } } };
}

type Controller = ReturnType<typeof useIOSTabSwipe>;
export function IOSSwipeSegments({ controller, label, children, className = "" }: {
  controller: Controller; label: string; children: ReactNode; className?: string;
}) {
  useLayoutEffect(() => { controller.refresh(); });
  return <div ref={controller.segments} role="group" aria-label={label} className={`hg-ios-segments hg-ios-swipe-segments ${className}`}>
    <span ref={controller.indicator} aria-hidden="true" className="hg-ios-swipe-indicator" />
    {children}
  </div>;
}

export function IOSTabPages({ controller, children }: { controller: Controller; children: (index: number, committed: boolean) => ReactNode }) {
  const { index, target, busy } = controller;
  const pages = target === null || target === index ? [index] : [index, target];
  useLayoutEffect(() => controller.observe(), [controller.index, controller.count, controller.enabled]);
  return <div ref={controller.viewport} data-hg-tab-viewport aria-busy={busy} className="hg-ios-tab-viewport" {...controller.gesture}>
    {pages.map((page) => <div key={page} data-hg-tab-pane={page} className="hg-ios-tab-pane" inert={page !== index}
      style={{ "--hg-tab-step": page === index ? 0 : page > index ? 1 : -1 } as CSSProperties}>
      {children(page, page === index)}
    </div>)}
  </div>;
}
