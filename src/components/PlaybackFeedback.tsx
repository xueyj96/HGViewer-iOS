import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Two equal-length contours keep the glyph continuous in both directions.
const PAUSE = [6, 5, 10, 5, 10, 19, 6, 19, 14, 5, 18, 5, 18, 19, 14, 19];
const PLAY = [7, 4, 12, 7.125, 12, 16.875, 7, 20, 12, 7.125, 20, 12, 20, 12, 12, 16.875];
const MORPH_MS = 280;

function glyphPath(progress: number) {
  const points = PAUSE.map((value, index) => value + (PLAY[index] - value) * progress);
  return [0, 8].map((start) => `M${points[start]},${points[start + 1]}L${points[start + 2]},${points[start + 3]}L${points[start + 4]},${points[start + 5]}L${points[start + 6]},${points[start + 7]}Z`).join("");
}

/** Status feedback follows confirmed playback; it never delays or controls the player. */
export default function PlaybackFeedback({ paused, compact = false, visible = true }: { paused: boolean; compact?: boolean; visible?: boolean }) {
  const previousPaused = useRef(paused);
  const progress = useRef(paused ? 0 : 1);
  const path = useRef<SVGPathElement>(null);
  const [resumed, setResumed] = useState(false);

  useLayoutEffect(() => {
    const target = paused ? 0 : 1;
    const start = progress.current;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const paint = (value: number) => {
      progress.current = value;
      path.current?.setAttribute("d", glyphPath(value));
    };
    const finish = () => { cancelAnimationFrame(frame); paint(target); };
    if (media.matches || start === target) finish();
    else {
      const began = performance.now();
      const duration = MORPH_MS * Math.abs(target - start);
      const tick = (now: number) => {
        const elapsed = Math.min(1, (now - began) / duration);
        const eased = elapsed * elapsed * (3 - 2 * elapsed);
        paint(start + (target - start) * eased);
        if (elapsed < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    const reduce = () => { if (media.matches) finish(); };
    media.addEventListener("change", reduce);
    return () => { cancelAnimationFrame(frame); media.removeEventListener("change", reduce); };
  }, [paused]);

  useEffect(() => {
    const resumedNow = previousPaused.current && !paused;
    previousPaused.current = paused;
    if (paused) setResumed(false);
    if (!resumedNow) return;
    setResumed(true);
    const timer = window.setTimeout(() => setResumed(false), 600);
    return () => window.clearTimeout(timer);
  }, [paused]);

  return <div className="hg-playback-feedback absolute inset-0 z-10 grid place-items-center pointer-events-none"
    data-paused={paused} data-resumed={resumed} data-shown={paused || resumed || previousPaused.current} data-visible={visible} aria-hidden="true">
    <span className={`hg-play-glyph relative grid place-items-center ${compact ? "size-14" : "size-16"}`}>
      <svg width={compact ? 24 : 28} height={compact ? 24 : 28} viewBox="0 0 24 24" fill="currentColor"
        className="hg-playback-feedback-glyph hg-ink absolute" aria-hidden="true">
        <path ref={path} d={glyphPath(progress.current)} />
      </svg>
    </span>
  </div>;
}
