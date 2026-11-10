/** Run cleanup after this element's current motion, or immediately when none is running. */
export function finishMotion(element: HTMLElement | null, complete: () => void) {
  let cancelled = false;
  const animations = element?.getAnimations() ?? [];
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (!cancelled) complete();
  });
  return () => { cancelled = true; };
}
