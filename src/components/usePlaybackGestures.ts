import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { edgeSwipeSide } from "./edgeSwipe";

type Commands = {
  isPlaying: () => boolean; pause: () => void; play: () => void; toggle: () => void;
  seek: (target: number, resume?: boolean) => void;
  pullEdge: (offset: number, axis: "horizontal" | "vertical") => void;
  stepEpisode: (direction: -1 | 1) => void;
  tap: (center: boolean) => void; cancelTap: () => void;
  lockSpeed: () => void; showTime: (target: number) => void;
};
type Options = {
  active: boolean; resetKey: string; isDesktop: boolean; isIos: boolean; kind: "video" | "post";
  boxRef: RefObject<HTMLDivElement | null>; surfaceReady: boolean; rotated: boolean; time: number; duration: number;
  episodesAvailable: boolean; hasPrevious: boolean; hasNext: boolean; episodeBusy: () => boolean;
  commands: Commands;
};
type Gesture = {
  pointerId: number; element: HTMLElement;
  x: number; y: number; startY: number; center: boolean; rail: boolean; t: number; timer: number | null;
  mode: "idle" | "hold" | "scrub" | "episode"; base: number; width: number; side: number; edgePull: number; wasPlaying: boolean;
};

/** Owns one transient pointer across picture, rail and progress bar. Persistent rate/lock stays in Feed. */
export function usePlaybackGestures({ active, resetKey, isDesktop, isIos, kind, boxRef, surfaceReady, rotated, time, duration,
  episodesAvailable, hasPrevious, hasNext, episodeBusy, commands }: Options) {
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  const [barPct, setBarPct] = useState<number | null>(null);
  const railSwipe = useRef(false);
  const gesture = useRef<Gesture | { mode: "bar"; pointerId: number; element: HTMLElement; wasPlaying: boolean } | null>(null);
  const latest = useRef(commands); latest.current = commands;

  const cancel = (restorePlayback = false) => {
    const owner = gesture.current;
    const g = owner?.mode !== "bar" ? owner : null;
    gesture.current = null;
    if (g?.timer) window.clearTimeout(g.timer);
    if (g?.edgePull) latest.current.pullEdge(0, "horizontal");
    if (restorePlayback && g?.mode === "scrub" && g.wasPlaying) latest.current.play();
    for (const capture of [owner]) {
      if (capture?.element.hasPointerCapture?.(capture.pointerId)) {
        try { capture.element.releasePointerCapture(capture.pointerId); } catch { /* already released */ }
      }
    }
    holdRef.current = false; lockArmedRef.current = false; scrubTarget.current = null;
    setHoldSpeed(false); setLockArmed(false); setScrub(null); setBarPct(null);
  };
  useLayoutEffect(() => {
    return () => { cancel(); latest.current.cancelTap(); railSwipe.current = false; };
    // Instance cleanup intentionally reads current command ports, not a retired player handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey, rotated]);
  useEffect(() => {
    let width = window.innerWidth;
    const resize = () => { if (window.innerWidth !== width) { width = window.innerWidth; cancel(true); latest.current.cancelTap(); } };
    const layout = () => { cancel(true); latest.current.cancelTap(); };
    window.addEventListener("resize", resize);
    window.addEventListener(IOS_LAYOUT_CHANGE, layout);
    return () => { window.removeEventListener("resize", resize); window.removeEventListener(IOS_LAYOUT_CHANGE, layout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* 长按倍速、画面拖动进度和边缘滑动切集。 */
  const onDown = (e: React.PointerEvent<HTMLDivElement>, rail = false) => {
    if (!active || isDesktop || !e.isPrimary || e.button !== 0 || episodeBusy()) return;
    if (gesture.current) return;
    railSwipe.current = false;
    const el = e.currentTarget;
    const bounds = (isIos && boxRef.current ? boxRef.current : el).getBoundingClientRect();
    const width = isIos ? bounds.width || 1 : el.clientWidth || 1;
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const side = isIos && kind === "video" && episodesAvailable
      ? rail ? 1 : edgeSwipeSide(x, width, boxRef.current ?? undefined)
      : 0;
    if (rail && !side) return;
    if (!rail) {
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    const center = x >= width * 0.3 && x <= width * 0.7 && y >= bounds.height * 0.25 && y <= bounds.height * 0.75;
    const g: Gesture = {
      pointerId: e.pointerId, element: el, x: e.clientX, y: e.clientY, startY: e.clientY, t: Date.now(), base: time, width, side, center, rail, edgePull: 0,
      wasPlaying: commands.isPlaying(),
      mode: "idle",
      timer: rail ? null : window.setTimeout(() => {
        const cur = gesture.current;
        if (cur !== g || cur.mode !== "idle") return;
        commands.cancelTap();
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380),
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.mode === "bar" || g.pointerId !== e.pointerId || isDesktop) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    /* 长按中：上滑 64px 进入「松开即锁定」 */
    if (g.mode === "hold") {
      const armed = g.startY - e.clientY > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        if (g.timer) window.clearTimeout(g.timer);
        commands.cancelTap();
        if (g.side && dx * g.side < 0) {
          g.mode = "episode";
          if (g.rail) {
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          }
        } else if (!g.rail) {
          g.mode = "scrub";
          commands.pause();
        }
      } else if (Math.abs(dy) > 14) {
        if (g.timer) window.clearTimeout(g.timer);
        commands.cancelTap();
      }
    }

    if (g.mode === "episode") {
      const distance = Math.max(0, -dx * g.side);
      const target = g.side < 0 ? hasPrevious : hasNext;
      const travel = target
        ? Math.min(distance, g.width * 0.85)
        : 36 * distance / (distance + 85);
      const offset = -g.side * travel;
      if (offset !== g.edgePull) {
        g.edgePull = offset;
        commands.pullEdge(offset, "horizontal");
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.mode === "bar" || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (lockArmedRef.current && e.type === "pointerup") commands.lockSpeed();
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.mode === "episode") {
      const direction = g.side < 0 ? -1 : 1;
      const target = direction < 0 ? hasPrevious : hasNext;
      const threshold = Math.max(52, Math.min(96, g.width * 0.16));
      railSwipe.current = g.rail;
      if (target && e.type === "pointerup" && -dx * direction >= threshold && Math.abs(dx) > Math.abs(dy)) {
        commands.stepEpisode(direction);
      } else if (g.edgePull) {
        commands.pullEdge(0, "horizontal");
      }
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      if (target != null && e.type === "pointerup") commands.seek(target, g.wasPlaying);
      else if (g.wasPlaying) commands.play();
      setScrub(null);
      scrubTarget.current = null;
      return;
    }
    if (g.rail || e.type !== "pointerup" || Date.now() - g.t >= 260 || Math.hypot(dx, dy) > 14) return;
    if (isIos) commands.tap(g.center);
    else commands.toggle();
  };

  const onLostCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && gesture.current?.pointerId === event.pointerId) {
      cancel(true);
    }
  };

  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、锁不住倍速 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current) e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, boxRef, surfaceReady]);

  /* —— 进度条拖动（旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (e.clientY - r.top) / span : (e.clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!active || isDesktop || !e.isPrimary || e.button !== 0 || gesture.current) return;
    gesture.current = { mode: "bar", pointerId: e.pointerId, element: e.currentTarget, wasPlaying: commands.isPlaying() };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setBarPct(barPctAt(e));
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.mode !== "bar" || gesture.current.pointerId !== e.pointerId) return;
    e.stopPropagation();
    setBarPct(barPctAt(e));
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    if (drag?.mode !== "bar" || drag.pointerId !== e.pointerId) return;
    gesture.current = null;
    e.stopPropagation();
    const pct = e.type === "pointercancel" ? null : barPctAt(e);
    if (pct != null && duration) {
      const target = pct * duration;
      commands.seek(target, drag.wasPlaying);
      commands.showTime(target);
    }
    setBarPct(null);
  };

  return { holdSpeed, lockArmed, scrub, barPct, onDown, onMove, onUp, onLostCapture,
    onBarDown, onBarMove, onBarUp, onBarLostCapture: onLostCapture,
    consumeRailSwipe: () => { const value = railSwipe.current; railSwipe.current = false; return value; } };
}
