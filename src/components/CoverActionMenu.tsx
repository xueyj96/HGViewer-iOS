import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { coverMenuLayout, coverMenuPreview } from "./coverMenuPreview";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { COVER_MENU_CHANGE, getCoverMenu, runCoverMenuAction, type CoverMenuTarget } from "./IOSCoverMenu";

type OpenMenu = { target: CoverMenuTarget };
type Hold = { card: HTMLElement; pointer: number; x: number; y: number; timer: number };
const CARD = "[data-hg-menu-card]";
const cardFor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>(CARD) : null;

/** Mount once inside MobileShell's .plat-ios so the top layer retains the app's theme and safe-area variables. */
export default function CoverActionMenu() {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const current = useRef<OpenMenu | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const pendingClose = useRef<(() => void) | null>(null);
  const safeArea = useRef<HTMLDivElement>(null);
  const hold = useRef<Hold | null>(null);
  const suppressed = useRef<{ card: HTMLElement; pointer: number; until: number } | null>(null);
  const dismissedPointer = useRef<{ pointer: number; until: number } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = (restore = true, immediate = false) => {
    const active = current.current;
    if (!active) { if (immediate) pendingClose.current?.(); return; }
    current.current = null;
    const revision = generation.current;
    const focusWasInMenu = !!menu.current?.contains(document.activeElement) || document.activeElement === document.body;
    let completed = false;
    const complete = () => {
      if (completed || generation.current !== revision) return;
      completed = true;
      pendingClose.current = null;
      const topLayer = layer.current;
      if (topLayer && typeof topLayer.hidePopover === "function" && topLayer.matches(":popover-open")) topLayer.hidePopover();
      setOpen(null);
      const focusStillInMenu = !!menu.current?.contains(document.activeElement) || document.activeElement === document.body;
      if (restore && focusWasInMenu && focusStillInMenu) {
        const origin = active.target.card.isConnected ? active.target.card : previousFocus.current;
        if (origin?.isConnected && !origin.closest("[inert], [hidden]")) origin.focus({ preventScroll: true });
      }
    };
    pendingClose.current = complete;
    if (immediate || matchMedia("(prefers-reduced-motion: reduce)").matches) { complete(); return; }
    const animations = [
      [backdrop.current, { opacity: "0" }],
      [menu.current, { opacity: "0" }],
      [preview.current, { transform: "translate(0px, 0px) scale(1)" }],
    ] as const;
    void Promise.allSettled(animations.map(([element, end]) => {
      if (!element) return Promise.resolve();
      const computed = getComputedStyle(element);
      const start = { opacity: computed.opacity, transform: computed.transform };
      element.getAnimations().forEach((animation) => animation.cancel());
      return element.animate([start, end], { duration: 200, easing: "cubic-bezier(.2,0,.2,1)", fill: "forwards" }).finished;
    })).then(complete);
  };
  const show = (card: HTMLElement) => {
    const target = getCoverMenu(card);
    if (!target) return false;
    pendingClose.current?.();
    if (current.current) close(false, true);
    generation.current++;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = { target };
    current.current = next;
    setOpen(next);
    return true;
  };

  useEffect(() => {
    const cancelHold = () => {
      if (hold.current) window.clearTimeout(hold.current.timer);
      hold.current = null;
    };
    const pointerDown = (event: PointerEvent) => {
      cancelHold();
      // A new gesture must not inherit the previous long press's click suppression.
      suppressed.current = null;
      dismissedPointer.current = null;
      if (!event.isPrimary || event.button !== 0) return;
      const card = cardFor(event.target);
      if (current.current) {
        if (!menu.current?.contains(event.target as Node)) {
          // The first outside gesture dismisses only; do not activate the card beneath the popover.
          dismissedPointer.current = { pointer: event.pointerId, until: Infinity };
          event.preventDefault();
          event.stopImmediatePropagation();
          close(false);
        }
        return;
      }
      if (!card || !getCoverMenu(card)) return;
      const pending: Hold = { card, pointer: event.pointerId, x: event.clientX, y: event.clientY, timer: 0 };
      pending.timer = window.setTimeout(() => {
        if (hold.current !== pending) return;
        hold.current = null;
        if (show(card)) {
          suppressed.current = { card, pointer: pending.pointer, until: Infinity };
        }
      }, 500);
      hold.current = pending;
    };
    const pointerMove = (event: PointerEvent) => {
      const pending = hold.current;
      if (pending && (event.pointerId !== pending.pointer || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10)) cancelHold();
    };
    const pointerEnd = (event: PointerEvent) => {
      if (hold.current?.pointer === event.pointerId) cancelHold();
      if (suppressed.current?.pointer === event.pointerId) suppressed.current.until = performance.now() + 800;
      if (dismissedPointer.current?.pointer === event.pointerId) dismissedPointer.current.until = performance.now() + 800;
    };
    const click = (event: MouseEvent) => {
      if (dismissedPointer.current && performance.now() <= dismissedPointer.current.until) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismissedPointer.current = null;
        return;
      }
      const blocked = suppressed.current;
      if (blocked && performance.now() <= blocked.until && event.target instanceof Node && blocked.card.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressed.current = null;
      }
    };
    const mouseDown = (event: MouseEvent) => {
      const blocked = suppressed.current;
      // Touch release synthesizes mousedown before click. Its default action would
      // focus the held card and our focus-out handler would dismiss the menu.
      if (current.current && blocked && performance.now() <= blocked.until &&
        event.target instanceof Node && blocked.card.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const contextMenu = (event: MouseEvent) => {
      const card = cardFor(event.target);
      if (!card || !getCoverMenu(card)) return;
      event.preventDefault();
      event.stopPropagation();
      // A platform contextmenu may arrive after our hold timer opened the menu.
      // Keep that gesture's pointer id until release, even during a very long hold.
      if (current.current?.target.card === card) return;
      const pointer = hold.current?.pointer ?? -1;
      cancelHold();
      suppressed.current = { card, pointer, until: pointer >= 0 ? Infinity : performance.now() + 800 };
      show(card);
    };
    const keyDown = (event: KeyboardEvent) => {
      const active = current.current;
      if (!active) {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        const card = cardFor(event.target);
        if (!card || !getCoverMenu(card)) return;
        event.preventDefault();
        event.stopPropagation();
        cancelHold();
        show(card);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation(); // The app's global Escape shortcut must not pop the page as well.
        close();
        return;
      }
      if (event.key === "Tab") { close(true, true); return; }
      const surface = menu.current;
      if (!surface?.contains(event.target as Node)) return;
      const buttons = [...surface.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
      else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      buttons[next].focus({ preventScroll: true });
      buttons[next].scrollIntoView({ block: "nearest" });
    };
    const scroll = (event: Event) => {
      // Menu overflow is intentional in a short viewport; scrolling the underlying page dismisses it.
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      cancelHold();
      close();
    };
    const focusIn = (event: FocusEvent) => {
      if (current.current && !menu.current?.contains(event.target as Node)) close(false);
    };
    const visibility = () => { if (document.hidden) { cancelHold(); close(false); } };
    const blur = () => { cancelHold(); close(); };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("pointermove", pointerMove, { capture: true, passive: true });
    document.addEventListener("pointerup", pointerEnd, true);
    document.addEventListener("pointercancel", pointerEnd, true);
    document.addEventListener("click", click, true);
    document.addEventListener("mousedown", mouseDown, true);
    document.addEventListener("contextmenu", contextMenu, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    return () => {
      cancelHold();
      close(false, true);
      generation.current++;
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointermove", pointerMove, true);
      document.removeEventListener("pointerup", pointerEnd, true);
      document.removeEventListener("pointercancel", pointerEnd, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("mousedown", mouseDown, true);
      document.removeEventListener("contextmenu", contextMenu, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useLayoutEffect(() => {
    const surface = menu.current;
    const probe = safeArea.current;
    const topLayer = layer.current;
    const lifted = preview.current;
    if (!open || !surface || !probe || !topLayer || !lifted) return;
    const card = open.target.card;
    const oldExpanded = card.getAttribute("aria-expanded");
    const oldHasPopup = card.getAttribute("aria-haspopup");
    card.setAttribute("aria-haspopup", "menu");
    card.setAttribute("aria-expanded", "true");
    const source = card.querySelector<HTMLElement>("[data-hg-menu-preview]") ?? card;
    lifted.replaceChildren(coverMenuPreview(source));
    const popover = typeof topLayer.showPopover === "function";
    if (popover && !topLayer.matches(":popover-open")) topLayer.showPopover();
    let firstPosition = true;
    const position = () => {
      if (!current.current) return;
      // Computed padding resolves env()/var()/max()/calc() to pixels; custom properties need not be numeric.
      const safe = getComputedStyle(probe);
      const viewport = window.visualViewport;
      const left = Math.max(0, viewport?.offsetLeft ?? 0) + parseFloat(safe.paddingLeft) + 16;
      const top = Math.max(0, viewport?.offsetTop ?? 0) + parseFloat(safe.paddingTop) + 16;
      const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? document.documentElement.clientWidth) - parseFloat(safe.paddingRight) - 16;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? document.documentElement.clientHeight) - parseFloat(safe.paddingBottom) - 16;
      surface.style.maxWidth = `${Math.max(0, right - left)}px`;
      surface.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      const origin = source.getBoundingClientRect();
      if (!origin.width || !origin.height) { close(false, true); return; }
      surface.style.width = `${Math.max(0, Math.min(right - left, 320, Math.max(128, origin.width * 1.03)))}px`;
      const bounds = surface.getBoundingClientRect();
      const placement = coverMenuLayout(origin, { width: bounds.width, height: surface.scrollHeight + 1 }, { left, top, right, bottom });
      surface.style.maxHeight = `${placement.menuHeight}px`;
      surface.style.left = `${placement.menuX}px`;
      surface.style.top = `${placement.menuY}px`;
      Object.assign(lifted.style, { left: `${origin.left}px`, top: `${origin.top}px`, width: `${origin.width}px`, height: `${origin.height}px`,
        visibility: placement.scale ? "visible" : "hidden",
        transform: `translate(${placement.previewX - origin.left}px, ${placement.previewY - origin.top}px) scale(${placement.scale})` });
      if (firstPosition) {
        firstPosition = false;
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
          const options = { duration: 200, easing: "cubic-bezier(.2,0,.2,1)" };
          backdrop.current?.animate([{ opacity: 0 }, { opacity: 1 }], options);
          surface.animate([{ opacity: 0 }, { opacity: 1 }], options);
          lifted.animate([{ transform: "translate(0px,0px) scale(1)" }, { transform: lifted.style.transform }], options);
        }
      }
    };
    const toggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") close();
    };
    const update = () => {
      if (!current.current) return;
      const target = getCoverMenu(card);
      if (!target || target.container !== open.target.container || target.mode !== open.target.mode ||
        target.history !== open.target.history || target.id !== open.target.id || target.ep !== open.target.ep) { close(); return; }
      if (JSON.stringify(target.items) !== JSON.stringify(current.current?.target.items)) {
        const next = { ...open, target };
        current.current = next;
        setOpen(next);
      }
    };
    const mutations = new MutationObserver(update);
    mutations.observe(open.target.container, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-hg-menu-card", "data-hg-browse-kind", "data-hg-menu-episode", "data-hg-can-cache", "data-hg-unavailable", "data-hg-download-action", "data-hg-download-blocked", "disabled", "inert", "hidden"] });
    for (let ancestor: HTMLElement | null = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor !== open.target.container) mutations.observe(ancestor, { childList: true, attributes: true, attributeFilter: ["inert", "hidden"] });
    }
    const resize = new ResizeObserver(position);
    resize.observe(surface);
    position();
    surface.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    topLayer.addEventListener("toggle", toggle);
    const layoutChanged = () => close(false, true);
    window.addEventListener(COVER_MENU_CHANGE, update);
    window.addEventListener("resize", layoutChanged);
    window.addEventListener(IOS_LAYOUT_CHANGE, layoutChanged);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      mutations.disconnect();
      resize.disconnect();
      topLayer.removeEventListener("toggle", toggle);
      for (const element of [surface, lifted, backdrop.current]) element?.getAnimations().forEach((animation) => animation.cancel());
      window.removeEventListener(COVER_MENU_CHANGE, update);
      window.removeEventListener("resize", layoutChanged);
      window.removeEventListener(IOS_LAYOUT_CHANGE, layoutChanged);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      if (oldExpanded === null) card.removeAttribute("aria-expanded"); else card.setAttribute("aria-expanded", oldExpanded);
      if (oldHasPopup === null) card.removeAttribute("aria-haspopup"); else card.setAttribute("aria-haspopup", oldHasPopup);
    };
  }, [open]);

  return <>
    <div ref={safeArea} aria-hidden="true" style={{ position: "fixed", visibility: "hidden", pointerEvents: "none", width: 0, height: 0,
      paddingTop: "var(--sat, env(safe-area-inset-top, 0px))", paddingBottom: "var(--sab, env(safe-area-inset-bottom, 0px))",
      paddingLeft: "var(--ios-safe-left, env(safe-area-inset-left, 0px))", paddingRight: "var(--ios-safe-right, env(safe-area-inset-right, 0px))" }} />
    {/* Own dismissal: opening occurs while the long-press pointer is still down. */}
    {open && <div ref={layer} popover={typeof HTMLElement.prototype.showPopover === "function" ? "manual" : undefined} className="hg-cover-menu-layer">
      <div ref={backdrop} className="hg-cover-menu-backdrop" aria-hidden="true" />
      <div ref={preview} className="hg-cover-menu-preview" aria-hidden="true" inert />
      <div ref={menu} role="menu" aria-label="剧集操作" className="hg-cover-action-menu"
      style={{ position: "fixed", margin: 0, inset: "auto", boxSizing: "border-box", overflowY: "auto" } as CSSProperties}>
      {open.target.items.map((item) => <button key={item.action} type="button" role="menuitem" tabIndex={-1}
        disabled={item.disabled} aria-disabled={item.disabled || undefined} data-destructive={item.destructive || undefined}
        data-has-hint={item.hint ? true : undefined} aria-label={item.label} title={item.hint} aria-description={item.hint}
        className="hg-cover-action-item" onClick={() => {
          const target = current.current?.target;
          close();
          if (target) runCoverMenuAction(target, item.action);
        }}>
        <span className="hg-cover-action-label">{item.label}</span>
        {item.hint && <span className="hg-cover-action-hint">{item.hint}</span>}
      </button>)}
      </div>
    </div>}
  </>;
}
