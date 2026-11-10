import { useEffect, useRef, useState, type PointerEvent } from "react";
import { IChevR, IList, IReorder } from "../icons";
import { DEFAULT_PLAYBACK_SIDEBAR, PLAYBACK_SIDEBAR_ACTIONS, type PlaybackSidebarAction } from "../playbackSidebar";
import { useStore } from "../store";
import { CompactAction, Toggle } from "./ui";

type Drag = {
  action: PlaybackSidebarAction;
  pointer: number;
  startY: number;
  y: number;
  index: number;
  rowStep: number;
  scrollTop: number;
  scroll: HTMLElement | null;
};

export default function PlaybackSidebarSettings() {
  const { playbackSidebar, setPlaybackSidebar } = useStore();
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [preview, setPreview] = useState<{ index: number; target: number; offset: number; rowStep: number }>();

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const move = (action: PlaybackSidebarAction, target: number) => {
    setPlaybackSidebar((items) => {
      const index = items.findIndex((item) => item.action === action);
      if (index < 0 || target < 0 || target >= items.length || index === target) return items;
      const next = [...items];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const position = (state: Drag) => {
    const distance = state.y - state.startY + (state.scroll?.scrollTop ?? 0) - state.scrollTop;
    const min = -state.index;
    const max = playbackSidebar.length - 1 - state.index;
    const offset = Math.max(min * state.rowStep, Math.min(max * state.rowStep, distance));
    return { index: state.index, target: state.index + Math.round(offset / state.rowStep), offset, rowStep: state.rowStep };
  };

  const tick = () => {
    const state = drag.current;
    if (!state) return;
    const bounds = state.scroll?.getBoundingClientRect();
    const rows = list.current?.getBoundingClientRect();
    if (state.scroll && bounds && rows) {
      const top = Math.max(0, bounds.top), bottom = Math.min(window.innerHeight, bounds.bottom);
      if (state.y < top + 36 && rows.top < top) state.scroll.scrollTop -= 6;
      if (state.y > bottom - 36 && rows.bottom > bottom) state.scroll.scrollTop += 6;
    }
    const next = position(state);
    setPreview((current) => current?.offset === next.offset ? current : next);
    frame.current = requestAnimationFrame(tick);
  };

  const startDrag = (event: PointerEvent<HTMLButtonElement>, action: PlaybackSidebarAction, index: number) => {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    const row = event.currentTarget.closest("li");
    if (!row || !list.current) return;
    const rowStep = row.offsetHeight + (parseFloat(getComputedStyle(list.current).rowGap) || 0);
    if (!rowStep) return;
    const scroll = row.closest<HTMLElement>(".scroll-y");
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { action, pointer: event.pointerId, startY: event.clientY, y: event.clientY,
      index, rowStep, scrollTop: scroll?.scrollTop ?? 0, scroll };
    frame.current = requestAnimationFrame(tick);
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    setPreview(undefined);
    if (event.type === "pointerup") {
      state.y = event.clientY;
      move(state.action, position(state).target);
    }
  };

  return (
    <details className="hg-ios-sidebar-settings group relative">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-semibold text-on [&::-webkit-details-marker]:hidden">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-s3 text-primary" aria-hidden="true"><IList size={16} /></span>
        <span className="min-w-0 flex-1">播放侧栏</span>
        <IChevR size={15} className="text-mut group-open:rotate-90" aria-hidden="true" />
      </summary>
      <CompactAction className="hg-ios-sidebar-reset" tone="neutral" onClick={() => setPlaybackSidebar(() => DEFAULT_PLAYBACK_SIDEBAR)}>恢复默认</CompactAction>
      <ol ref={list} className="mx-3 grid gap-1.5">
        {playbackSidebar.map(({ action, visible }, index) => {
          const label = PLAYBACK_SIDEBAR_ACTIONS[action];
          const lifted = preview?.index === index && preview.offset !== 0;
          const shift = !preview ? 0 : index === preview.index ? preview.offset :
            index > preview.index && index <= preview.target ? -preview.rowStep :
            index < preview.index && index >= preview.target ? preview.rowStep : 0;
          return (
            <li key={action} style={{ transform: shift ? `translateY(${shift}px)` : undefined }}
              className={`relative flex h-11 items-center gap-1 rounded-(--r-sm) bg-s3 pl-3 pr-1 motion-safe:transition-transform motion-safe:duration-150 ${lifted ? "z-10 shadow-md !transition-none" : ""}`}>
              <span className="min-w-0 flex-1 truncate text-[14px] text-on">{label}</span>
              <Toggle on={visible} label={`显示${label}`} onChange={(on) => {
                setPlaybackSidebar((items) => items.map((item) => item.action === action ? { ...item, visible: on } : item));
              }} />
              <button type="button" className="grid size-11 shrink-0 touch-none select-none place-items-center text-mut cursor-grab active:cursor-grabbing"
                aria-label={`拖动排序：${label}`} aria-keyshortcuts="ArrowUp ArrowDown"
                onPointerDown={(event) => startDrag(event, action, index)}
                onPointerMove={(event) => {
                  if (drag.current?.pointer === event.pointerId) drag.current.y = event.clientY;
                }}
                onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  move(action, index + (event.key === "ArrowUp" ? -1 : 1));
                }}>
                <IReorder size={17} strokeWidth={1.6} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
