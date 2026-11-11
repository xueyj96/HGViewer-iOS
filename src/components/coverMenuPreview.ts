/** Clone a cover's rendered appearance without making a second interactive card. */
export function coverMenuPreview(source: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  originals.forEach((original, index) => {
    const copy = copies[index];
    const style = getComputedStyle(original);
    for (const name of style) copy.style.setProperty(name, style.getPropertyValue(name));
    copy.removeAttribute("id");
    copy.removeAttribute("autofocus");
    for (const attribute of [...copy.attributes]) {
      if (attribute.name.startsWith("data-")) copy.removeAttribute(attribute.name);
    }
    copy.style.animation = "none";
    copy.style.transition = "none";
    copy.style.pointerEvents = "none";
    if (original instanceof HTMLImageElement && copy instanceof HTMLImageElement && original.currentSrc) {
      copy.removeAttribute("srcset");
      copy.src = original.currentSrc;
      copy.loading = "eager";
    }
  });
  const rect = source.getBoundingClientRect();
  Object.assign(clone.style, { position: "relative", inset: "auto", margin: "0", width: `${rect.width}px`,
    height: `${rect.height}px`, minWidth: "0", maxWidth: "none", transform: "none", opacity: "1", outline: "none" });
  clone.inert = true;
  clone.setAttribute("aria-hidden", "true");
  return clone;
}

type Rect = { left: number; top: number; width: number; height: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** Prefer below/above the card. In a short viewport, fit preview and scrollable menu together. */
export function coverMenuLayout(card: Rect, menu: { width: number; height: number }, safe: Bounds) {
  const width = Math.max(0, safe.right - safe.left), height = Math.max(0, safe.bottom - safe.top);
  const gap = 4;
  let scale = Math.min(1.03, width / card.width, height / card.height);
  let previewHeight = card.height * scale;
  let previewX = clamp(card.left - (card.width * scale - card.width) / 2, safe.left, safe.right - card.width * scale);
  let previewY = clamp(card.top - (previewHeight - card.height) / 2, safe.top, safe.bottom - previewHeight);
  let menuHeight = Math.min(menu.height, height);
  let menuY: number;
  if (previewY + previewHeight + gap + menuHeight <= safe.bottom) menuY = previewY + previewHeight + gap;
  else if (previewY - gap - menuHeight >= safe.top) menuY = previewY - gap - menuHeight;
  else {
    // Keep at least one full 44pt action reachable; tiny keyboard viewports may omit the preview.
    const previewSpace = height - gap - menuHeight;
    if (previewSpace < 44 && height >= 44 + gap + 44) menuHeight = Math.max(44, height - gap - 44);
    scale = Math.min(scale, Math.max(0, height - gap - menuHeight) / card.height);
    if (card.height * scale < 44) scale = 0;
    previewHeight = card.height * scale;
    previewX = clamp(card.left, safe.left, safe.right - card.width * scale);
    previewY = clamp(card.top, safe.top, safe.bottom - previewHeight - gap - menuHeight);
    menuY = scale ? previewY + previewHeight + gap : safe.top;
  }
  // Right-edge cards align their right edge instead of using the long-press finger location.
  const menuX = previewX + menu.width <= safe.right ? previewX
    : clamp(previewX + card.width * scale - menu.width, safe.left, safe.right - menu.width);
  return { previewX, previewY, scale, menuX, menuY, menuHeight };
}
