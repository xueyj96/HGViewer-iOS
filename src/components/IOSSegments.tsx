import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

export type SegmentRect = { x: number; width: number };
export function segmentRect(root: HTMLDivElement | null, from: number, to = from, progress = 0): SegmentRect | null {
  if (!root) return null;
  const buttons = root.querySelectorAll<HTMLButtonElement>(":scope > button");
  if (!buttons[from] || !buttons[to]) return null;
  const origin = root.getBoundingClientRect();
  const layout = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect(), transform = getComputedStyle(button).transform;
    // Header content may be visually travelling while this controller measures its layout.
    const translateX = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0;
    return { x: rect.left - origin.left - translateX, width: rect.width };
  };
  const a = layout(buttons[from]), b = layout(buttons[to]);
  return { x: a.x + (b.x - a.x) * progress, width: a.width + (b.width - a.width) * progress };
}
export function paintSegment(element: HTMLSpanElement | null, rect: SegmentRect | null) {
  if (!element || !rect) return;
  element.style.transform = `translateX(${rect.x}px)`;
  element.style.width = `${rect.width}px`;
}

/** Shared visual shell for settings choices and page tabs; page gestures stay with their owner. */
export function IOSSegmentFrame({ rootRef, indicatorRef, label, children, className = "", refresh }: {
  rootRef: RefObject<HTMLDivElement | null>; indicatorRef: RefObject<HTMLSpanElement | null>;
  label: string; children: ReactNode; className?: string; refresh?: () => void;
}) {
  useLayoutEffect(() => { refresh?.(); });
  return <div ref={rootRef} role="group" aria-label={label} className={`hg-ios-segments hg-ios-swipe-segments ${className}`}>
    <span ref={indicatorRef} aria-hidden="true" className="hg-ios-swipe-indicator" />
    {children}
  </div>;
}

/** A local setting changes its value directly; only its shared indicator animates. */
export function IOSSegmentedControl<T extends string>({ value, options, onChange, label, disabled = false }: {
  value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void; label: string; disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const motion = useRef<Animation | null>(null);
  const previous = useRef<T | null>(null);
  const index = options.findIndex((option) => option.value === value);
  const currentIndex = useRef(index);
  currentIndex.current = index;
  useLayoutEffect(() => {
    const node = indicator.current;
    const next = segmentRect(root.current, index);
    if (!node || !next) return;
    const old = previous.current === null ? null : { transform: getComputedStyle(node).transform, width: getComputedStyle(node).width };
    motion.current?.cancel();
    paintSegment(node, next);
    if (old && previous.current !== value && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motion.current = node.animate([old, { transform: node.style.transform, width: node.style.width }],
        { duration: 200, easing: "cubic-bezier(.2,0,.2,1)" });
    }
    previous.current = value;
  }, [value, index]);
  useLayoutEffect(() => {
    let width = root.current?.clientWidth;
    const resize = new ResizeObserver(() => {
      if (root.current?.clientWidth === width) return;
      width = root.current?.clientWidth;
      motion.current?.cancel();
      paintSegment(indicator.current, segmentRect(root.current, currentIndex.current));
    });
    if (root.current) resize.observe(root.current);
    return () => { resize.disconnect(); motion.current?.cancel(); };
  }, []);
  return <IOSSegmentFrame rootRef={root} indicatorRef={indicator} label={label} className="hg-ios-segments-compact">
    {options.map((option, optionIndex) => <button type="button" key={option.value} disabled={disabled} aria-pressed={value === option.value}
      onClick={() => { if (!disabled && value !== option.value) onChange(option.value); }} onKeyDown={(event) => {
        let next: number;
        if (event.key === "ArrowRight") next = Math.min(options.length - 1, optionIndex + 1);
        else if (event.key === "ArrowLeft") next = Math.max(0, optionIndex - 1);
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = options.length - 1;
        else return;
        event.preventDefault();
        if (disabled) return;
        onChange(options[next].value);
        root.current?.querySelectorAll<HTMLButtonElement>(":scope > button")[next]?.focus();
      }}>{option.label}</button>)}
  </IOSSegmentFrame>;
}
