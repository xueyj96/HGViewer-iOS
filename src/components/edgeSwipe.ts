/** Only gestures that begin close to the screen boundary navigate media. */
export function edgeSwipeSide(x: number, width: number, surface?: HTMLElement, edgeLimit = 32): -1 | 0 | 1 {
  const style = surface && getComputedStyle(surface);
  const left = style ? parseFloat(style.scrollPaddingLeft) || 0 : 0;
  const right = style ? parseFloat(style.scrollPaddingRight) || 0 : 0;
  const edge = Math.min(edgeLimit, (width - left - right) * 0.085);
  if (x >= 0 && x < left + edge) return -1;
  if (x <= width && x > width - right - edge) return 1;
  return 0;
}
