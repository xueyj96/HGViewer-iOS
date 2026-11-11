import { useLayoutEffect } from "react";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";

type Shape = "none" | "title" | "search-entry" | "search-input" | "segments";
type Box = { left: number; top: number; width: number; height: number };
type Slot = {
  element: HTMLElement; signature: string; shape: Shape; box: Box; snapshot: HTMLElement;
  selection?: Box; selectionMotion?: SurfaceMotion;
  targets: HTMLElement[]; centers: number[]; moves: number[]; travel?: Animation; incoming?: Animation; incomingFrom?: number;
};
type SurfaceMotion = { from: Box; to: Box; animation: Animation };
const easing = "cubic-bezier(.2,0,.2,1)";
const near = (a: Box, b: Box) => Math.abs(a.left - b.left) < .5 && Math.abs(a.width - b.width) < .5;
const progress = (animation?: Animation) => Number(animation?.effect?.getComputedTiming().progress ?? 1);
const mix = (a: number, b: number, p: number) => a + (b - a) * p;
const remainingMove = (slot: Slot, index: number) => (slot.moves[index] || 0) * (1 - progress(slot.travel));
const opacityOf = (slot: Slot) => slot.incoming ? mix(slot.incomingFrom || 0, 1, progress(slot.incoming)) : 1;
const mixBox = (a: Box, b: Box, p: number): Box => ({ left: mix(a.left, b.left, p), top: mix(a.top, b.top, p), width: mix(a.width, b.width, p), height: mix(a.height, b.height, p) });
const shapeOf = (element: HTMLElement): Shape => element.querySelector(".hg-ios-segments") ? "segments"
  : element.querySelector("input") ? "search-input" : element.querySelector('button[aria-label="搜索"]') ? "search-entry" : "title";
const targetsOf = (element: HTMLElement, shape: Shape) => shape === "segments"
  ? [...element.querySelectorAll<HTMLElement>(".hg-ios-segments > button")]
  : [...element.children] as HTMLElement[];
const signatureOf = (element: HTMLElement, shape: Shape) => shape === "search-input"
  ? `input:${element.querySelector("input")?.getAttribute("placeholder")}`
  : `${shape}:${element.textContent}|${[...element.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") || button.textContent).join("|")}|${shape !== "segments" ? [...element.querySelectorAll("svg")].map((svg) => svg.innerHTML).join("|") : ""}`;

/** A disposable visual copy, never another navigation owner or an interactive form. */
function snapshotOf(source: HTMLElement) {
  const copy = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  originals.forEach((original, index) => {
    const node = copies[index], style = getComputedStyle(original);
    for (const name of ["background-color", "border-color", "font-family", "font-size", "font-weight", "line-height"]) node.style.setProperty(name, style.getPropertyValue(name));
    for (const attribute of [...node.attributes]) if (attribute.name.startsWith("data-") || ["id", "autofocus", "form", "name", "aria-controls", "aria-labelledby", "aria-describedby"].includes(attribute.name)) node.removeAttribute(attribute.name);
    node.style.animation = "none";
    node.style.transition = "none";
    if (original instanceof HTMLInputElement && node instanceof HTMLInputElement) node.value = original.value;
  });
  copy.classList.add("hg-ios-nav-ghost");
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  return copy;
}

/** Morph only the background and content inside one fixed navigation host. */
export function useIOSTopBarMotion(host: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!host) return;
    let previous = new Map<string, Slot>();
    let ready = false;
    let surfaceBox: Box | null = null;
    let surfaceMotion: SurfaceMotion | undefined;
    let fadingSurface: { box: Box; animation: Animation } | undefined;
    const active = new Set<Animation>();
    const ghosts = new Map<HTMLElement, { key: string; animation: Animation }>();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const surface = document.createElement("div");
    surface.className = "hg-ios-nav-surface";
    surface.setAttribute("aria-hidden", "true");
    surface.inert = true;
    host.appendChild(surface);
    host.dataset.navSurface = "true";

    const run = (element: HTMLElement, frames: Keyframe[], duration: number, clock: number, delay = 0, curve = easing) => {
      const animation = element.animate(frames, { duration, delay, easing: curve, fill: "both" });
      animation.startTime = clock;
      active.add(animation);
      void animation.finished.catch(() => {}).then(() => { active.delete(animation); animation.cancel(); });
      return animation;
    };
    const clear = () => {
      active.forEach((animation) => animation.cancel());
      active.clear();
      ghosts.forEach((_, ghost) => ghost.remove());
      ghosts.clear();
      surfaceMotion = undefined;
      fadingSurface = undefined;
    };
    const currentSurface = () => surfaceMotion ? mixBox(surfaceMotion.from, surfaceMotion.to, progress(surfaceMotion.animation)) : surfaceBox ?? fadingSurface?.box ?? null;
    const ghost = (key: string, slot: Slot, clock: number, hideSelection = false) => {
      const opacity = opacityOf(slot);
      if (opacity < .001) return; // An invisible intermediate title does not need an outgoing layer.
      // Preserve the most visible layer when several routes change inside one entrance delay.
      const matching = [...ghosts].filter(([, value]) => value.key === key);
      if (matching.length >= 2) {
        const [old, value] = matching.reduce((lowest, candidate) => parseFloat(getComputedStyle(candidate[0]).opacity) < parseFloat(getComputedStyle(lowest[0]).opacity) ? candidate : lowest);
        value.animation.cancel(); old.remove(); ghosts.delete(old);
      }
      const node = slot.snapshot.cloneNode(true) as HTMLElement;
      Object.assign(node.style, { left: `${slot.box.left}px`, top: `${slot.box.top}px`, width: `${slot.box.width}px`, height: `${slot.box.height}px` });
      const inputs = [...slot.element.querySelectorAll<HTMLInputElement>("input")];
      node.querySelectorAll<HTMLInputElement>("input").forEach((input, index) => { if (inputs[index]) input.value = inputs[index].value; });
      targetsOf(node, slot.shape).forEach((target, index) => { target.style.transform = `translateX(${remainingMove(slot, index)}px)`; });
      if (hideSelection) node.querySelector<HTMLElement>(".hg-ios-swipe-indicator")?.style.setProperty("visibility", "hidden");
      host.appendChild(node);
      const animation = run(node, [{ opacity }, { opacity: 0 }], 120, clock, 0, "ease-in");
      ghosts.set(node, { key, animation });
      void animation.finished.catch(() => {}).then(() => { node.remove(); ghosts.delete(node); });
    };

    const update = (animate = true) => {
      if (!animate || reduced.matches) clear();
      const bars = [...host.querySelectorAll<HTMLElement>(":scope > .hg-ios-floating-bar")];
      const bar = bars.reduce<HTMLElement | undefined>((owner, candidate) => !owner || Number(candidate.dataset.navPriority ?? (candidate.dataset.overlay === "true" ? 1 : 0)) >= Number(owner.dataset.navPriority ?? (owner.dataset.overlay === "true" ? 1 : 0)) ? candidate : owner, undefined);
      const firstOwner = !!bar && !ready;
      if (firstOwner) { animate = false; clear(); }
      for (const candidate of bars) {
        const current = candidate === bar;
        if (candidate.dataset.navCurrent !== String(current)) candidate.dataset.navCurrent = String(current);
        candidate.inert = !current;
        if (current) candidate.removeAttribute("aria-hidden"); else candidate.setAttribute("aria-hidden", "true");
      }
      const next = new Map<string, Slot>();
      const origin = host.getBoundingClientRect();
      if (bar) for (const element of [...bar.children] as HTMLElement[]) {
        const key = element.classList.contains("hg-ios-floating-panel") ? "panel" : element.classList.contains("hg-ios-floating-actions-end") ? "end" : "start";
        const rect = element.getBoundingClientRect(), shape = key === "panel" ? shapeOf(element) : "none";
        const indicator = shape === "segments" ? element.querySelector<HTMLElement>(".hg-ios-swipe-indicator") : null;
        const selection = indicator?.getBoundingClientRect();
        const targets = targetsOf(element, shape), old = previous.get(key);
        const centers = targets.map((target) => {
          const rect = target.getBoundingClientRect(), oldIndex = old?.targets.indexOf(target) ?? -1;
          // A reused DOM node already includes the previous WAAPI translate in its rect.
          const ownedMove = old && oldIndex >= 0 ? remainingMove(old, oldIndex) : 0;
          return rect.left - origin.left + rect.width / 2 - ownedMove;
        });
        next.set(key, { element, shape, selection: selection ? { left: selection.left - origin.left, top: selection.top - origin.top, width: selection.width, height: selection.height } : undefined, signature: signatureOf(element, shape), box: { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }, snapshot: snapshotOf(element), targets, centers, moves: [] });
      }
      const panel = next.get("panel"), oldPanel = previous.get("panel");
      const beforeSurface = currentSurface();
      const surfaceOpacity = parseFloat(getComputedStyle(surface).opacity) || 0;
      const nextSurface = panel ? (() => {
        const style = getComputedStyle(panel.element, "::before");
        return { left: panel.box.left + (parseFloat(style.left) || 0), top: panel.box.top + (parseFloat(style.top) || 0), width: parseFloat(style.width) || panel.box.width, height: parseFloat(style.height) || 36 };
      })() : null;
      const changed = [...new Set([...next.keys(), ...previous.keys()])].some((key) => {
        const old = previous.get(key), current = next.get(key);
        return !old || !current || old.signature !== current.signature || !near(old.box, current.box);
      }) || !!surfaceBox !== !!nextSurface || !!(surfaceBox && nextSurface && !near(surfaceBox, nextSurface));
      if (animate && !reduced.matches && !changed) {
        for (const [key, slot] of next) {
          const old = previous.get(key);
          if (old?.element === slot.element) { slot.incoming = old.incoming; slot.incomingFrom = old.incomingFrom; slot.travel = old.travel; slot.selectionMotion = old.selectionMotion; slot.moves = old.moves; }
        }
        previous = next;
        return;
      }
      const play = animate && !reduced.matches && changed;
      const clock = Number(document.timeline.currentTime || performance.now());
      const structural = oldPanel?.shape !== panel?.shape || oldPanel?.targets.length !== panel?.targets.length;
      const duration = structural ? 240 : 200, delay = structural ? 60 : 40;
      const continuingKeys = new Set([...ghosts.values()].map((value) => value.key));
      if (play) for (const [key, old] of previous) {
        const current = next.get(key);
        if (!current || old.signature !== current.signature) ghost(key, old, clock, structural && old.shape === "segments" && panel?.shape === "segments");
      }
      for (const [key, slot] of next) {
        const old = previous.get(key);
        const contentChanged = !old || old.signature !== slot.signature;
        const continuing = !!old?.incoming && active.has(old.incoming) || continuingKeys.has(key);
        const fromOpacity = continuing && old ? opacityOf(old) : 0;
        const enterDelay = continuing ? 0 : delay;
        const enterDuration = continuing ? Math.max(80, duration * (1 - fromOpacity)) : duration - enterDelay;
        if (play && (contentChanged || !near(old.box, slot.box))) {
          // Move measured internal content, never scale the letters or the bar itself.
          slot.moves = slot.targets.map((_, index) => {
            const center = old && old.shape === slot.shape && old.centers[index] !== undefined
              ? old.centers[index] + remainingMove(old, index)
              : old ? old.box.left + old.box.width / 2 : slot.box.left + slot.box.width / 2;
            return center - slot.centers[index];
          });
          slot.targets.forEach((target, index) => {
            const move = slot.moves[index];
            const animation = run(target, contentChanged ? [
              { opacity: fromOpacity, transform: `translateX(${move}px)` },
              { opacity: 1, transform: "translateX(0px)" },
            ] : [{ transform: `translateX(${move}px)` }, { transform: "translateX(0px)" }], contentChanged ? enterDuration : duration, clock, contentChanged ? enterDelay : 0);
            slot.travel = animation;
            if (contentChanged) { slot.incoming = animation; slot.incomingFrom = fromOpacity; }
          });
          // A layout-only retarget replaces travel, while the earlier opacity still runs.
          if (!contentChanged) { slot.incoming = old?.incoming; slot.incomingFrom = old?.incomingFrom; }
          // The selection surface changes shape separately; page-tab dragging owns its later movement.
          const indicator = slot.shape === "segments" && structural ? slot.element.querySelector<HTMLElement>(".hg-ios-swipe-indicator") : null;
          if (indicator) {
            const oldSelection = old?.selectionMotion ? mixBox(old.selectionMotion.from, old.selectionMotion.to, progress(old.selectionMotion.animation)) : old?.selection;
            if (oldSelection && slot.selection) {
              const parent = indicator.parentElement!.getBoundingClientRect();
              const animation = run(indicator, [
                { transform: `translateX(${oldSelection.left - (parent.left - origin.left)}px)`, width: `${oldSelection.width}px` },
                { transform: getComputedStyle(indicator).transform, width: `${slot.selection.width}px` },
              ], duration, clock);
              slot.selectionMotion = { from: oldSelection, to: slot.selection, animation };
            } else run(indicator, [{ opacity: 0 }, { opacity: 1 }], duration, clock);
          }
        } else if (old && play) {
          slot.incoming = old.incoming; slot.incomingFrom = old.incomingFrom; slot.travel = old.travel; slot.selectionMotion = old.selectionMotion; slot.moves = old.moves;
        }
      }
      if (surfaceMotion && (!play || !nextSurface || !beforeSurface || !near(beforeSurface, nextSurface))) { surfaceMotion.animation.cancel(); surfaceMotion = undefined; }
      if (fadingSurface) { fadingSurface.animation.cancel(); fadingSurface = undefined; }
      if (nextSurface) {
        Object.assign(surface.style, { left: `${nextSurface.left}px`, top: `${nextSurface.top}px`, width: `${nextSurface.width}px`, height: `${nextSurface.height}px`, opacity: "1" });
        if (play && beforeSurface && !near(beforeSurface, nextSurface)) {
          const animation = run(surface, [{ left: `${beforeSurface.left}px`, width: `${beforeSurface.width}px` }, { left: `${nextSurface.left}px`, width: `${nextSurface.width}px` }], duration, clock);
          surfaceMotion = { from: beforeSurface, to: nextSurface, animation };
          void animation.finished.catch(() => {}).then(() => { if (surfaceMotion?.animation === animation) surfaceMotion = undefined; });
        }
        if (play && (!beforeSurface || surfaceOpacity < .999)) run(surface, [{ opacity: beforeSurface ? surfaceOpacity : 0 }, { opacity: 1 }], duration, clock);
        const focus = getComputedStyle(panel!.element).getPropertyValue("--ios-panel-focus-ring").trim();
        surface.style.boxShadow = focus;
      } else {
        surface.style.opacity = "0";
        if (play && beforeSurface) {
          Object.assign(surface.style, { left: `${beforeSurface.left}px`, top: `${beforeSurface.top}px`, width: `${beforeSurface.width}px`, height: `${beforeSurface.height}px` });
          const animation = run(surface, [{ opacity: surfaceOpacity }, { opacity: 0 }], 120, clock);
          fadingSurface = { box: beforeSurface, animation };
          void animation.finished.catch(() => {}).then(() => { if (fadingSurface?.animation === animation) fadingSurface = undefined; });
        }
      }
      surfaceBox = nextSurface;
      previous = next;
      if (firstOwner) {
        // The real host can mount empty; resolve its first owner's palette before enabling transitions.
        const palette = getComputedStyle(host);
        palette.getPropertyValue("--ios-top-surface");
        palette.getPropertyValue("--ios-top-border");
        palette.getPropertyValue("--ios-top-ink");
        ready = true;
        host.dataset.navReady = "true";
      }
    };
    const meaningful = (record: MutationRecord) => {
      if ((record.target as Element).closest?.(".hg-ios-nav-ghost, .hg-ios-nav-surface")) return false;
      if (record.type === "childList" && [...record.addedNodes, ...record.removedNodes].every((node) => node instanceof Element && node.matches(".hg-ios-nav-ghost, .hg-ios-nav-surface"))) return false;
      return true;
    };
    const observer = new MutationObserver((records) => { if (records.some(meaningful)) update(); });
    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "data-overlay", "data-nav-priority", "aria-pressed"] });
    let hostWidth = host.clientWidth;
    const resize = new ResizeObserver(() => {
      if (host.clientWidth === hostWidth) return;
      hostWidth = host.clientWidth;
      update(false);
    });
    resize.observe(host);
    const settleEnvironment = () => update(false);
    const takeGesture = (event: PointerEvent) => {
      if (!active.size && !ghosts.size) return;
      if (event.isPrimary && event.target instanceof Element && event.target.closest(".hg-ios-segments, [data-hg-tab-viewport]")) update(false);
    };
    const takeKeyboard = (event: KeyboardEvent) => {
      if (!active.size && !ghosts.size) return;
      if (["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key) && event.target instanceof Element && event.target.closest(".hg-ios-segments")) update(false);
    };
    document.addEventListener("pointerdown", takeGesture, true);
    document.addEventListener("keydown", takeKeyboard, true);
    const theme = new MutationObserver(settleEnvironment);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const focus = () => {
      const panel = previous.get("panel");
      if (panel) surface.style.boxShadow = getComputedStyle(panel.element).getPropertyValue("--ios-panel-focus-ring").trim();
    };
    host.addEventListener("focusin", focus); host.addEventListener("focusout", focus);
    window.addEventListener(IOS_LAYOUT_CHANGE, settleEnvironment);
    reduced.addEventListener("change", settleEnvironment);
    update(false);
    return () => {
      observer.disconnect(); resize.disconnect(); theme.disconnect(); clear(); surface.remove();
      host.removeEventListener("focusin", focus); host.removeEventListener("focusout", focus);
      document.removeEventListener("pointerdown", takeGesture, true);
      document.removeEventListener("keydown", takeKeyboard, true);
      window.removeEventListener(IOS_LAYOUT_CHANGE, settleEnvironment); reduced.removeEventListener("change", settleEnvironment);
      delete host.dataset.navSurface;
      delete host.dataset.navReady;
      for (const bar of host.querySelectorAll<HTMLElement>(":scope > .hg-ios-floating-bar")) { delete bar.dataset.navCurrent; bar.inert = false; bar.removeAttribute("aria-hidden"); }
    };
  }, [host]);
}
