/** Visual cleanup after the root's current animations finish or cancel; never a business-success receipt. */
export function finishMotion(element: HTMLElement | null, complete: () => void) {
  let cancelled = false;
  const animations = element?.getAnimations() ?? [];
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (!cancelled) complete();
  });
  return () => { cancelled = true; };
}
