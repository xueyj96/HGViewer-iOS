import { useEffect, useState, type RefObject } from "react";
import { finishMotion } from "./finishMotion";

/** Visual retention only: closing waits for this root, reopening retires its old cleanup. */
export function useMotionPresence(open: boolean, element: RefObject<HTMLElement | null>) {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    return finishMotion(element.current, () => setPresent(false));
  }, [open, element]);
  return present;
}
