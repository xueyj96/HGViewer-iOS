import { useEffect, useRef } from "react";

const DOUBLE_TAP_MS = 260;

export function usePlaybackTap(onTap: () => void, onDoubleTap: () => void, playbackKey: string) {
  const timer = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onTap, onDoubleTap });
  callbacks.current = { onTap, onDoubleTap };
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  useEffect(() => cancel, [playbackKey]);

  return {
    cancel,
    tap(center: boolean) {
      if (!center) {
        cancel();
        callbacks.current.onTap();
      } else if (timer.current !== undefined) {
        cancel();
        callbacks.current.onDoubleTap();
      } else {
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          callbacks.current.onTap();
        }, DOUBLE_TAP_MS);
      }
    },
  };
}
