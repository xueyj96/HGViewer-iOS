import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { COVER_MENU_CHANGE, getCoverMenu, runCoverMenuAction, type CoverMenuTarget } from "./IOSCoverMenu";

type OpenMenu = { target: CoverMenuTarget; x: number; y: number };
type Hold = { card: HTMLElement; pointer: number; x: number; y: number; timer: number };
const CARD = "[data-hg-menu-card]";
const cardFor = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>(CARD) : null;

/** Mount once inside MobileShell's .plat-ios so the top layer retains the app's theme and safe-area variables. */
export default function CoverActionMenu() {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const current = useRef<OpenMenu | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const safeArea = useRef<HTMLDivElement>(null);
  const hold = useRef<Hold | null>(null);
  const suppressed = useRef<{ card: HTMLElement; pointer: number; until: number } | null>(null);
  const dismissedPointer = useRef<{ pointer: number; until: number } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = (restore = true) => {
    const active = current.current;
    if (!active) return;
    current.current = null;
    const surface = menu.current;
    // Avoid stealing focus from a destination selected by an outside pointer.
    const focusWasInMenu = !!surface?.contains(document.activeElement) || document.activeElement === document.body;
    if (surface && typeof surface.hidePopover === "function" && surface.matches(":popover-open")) surface.hidePopover();
    setOpen(null);
    if (restore && focusWasInMenu) {
      const origin = active.target.card.isConnected ? active.target.card : previousFocus.current;
      if (origin?.isConnected && !origin.closest("[inert], [hidden]")) origin.focus({ preventScroll: true });
    }
  };
  const show = (card: HTMLElement, x: number, y: number) => {
    const target = getCoverMenu(card);
    if (!target) return false;
    if (current.current) close(false);
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = { target, x, y };
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
        if (show(card, pending.x, pending.y)) {
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
    const contextMenu = (event: MouseEvent) => {
      const card = cardFor(event.target);
      if (!card || !getCoverMenu(card)) return;
      event.preventDefault();
      event.stopPropagation();
      const pointer = hold.current?.pointer ?? -1;
      cancelHold();
      suppressed.current = { card, pointer, until: pointer >= 0 ? Infinity : performance.now() + 800 };
      if (current.current?.target.card === card) return;
      const rect = card.getBoundingClientRect();
      show(card, event.clientX || rect.left, event.clientY || rect.bottom);
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
        const rect = card.getBoundingClientRect();
        show(card, rect.left, rect.bottom);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation(); // The app's global Escape shortcut must not pop the page as well.
        close();
        return;
      }
      if (event.key === "Tab") { close(); return; }
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
    document.addEventListener("contextmenu", contextMenu, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    return () => {
      cancelHold();
      close(false);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointermove", pointerMove, true);
      document.removeEventListener("pointerup", pointerEnd, true);
      document.removeEventListener("pointercancel", pointerEnd, true);
      document.removeEventListener("click", click, true);
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
    if (!open || !surface || !probe) return;
    const card = open.target.card;
    const oldExpanded = card.getAttribute("aria-expanded");
    const oldHasPopup = card.getAttribute("aria-haspopup");
    card.setAttribute("aria-haspopup", "menu");
    card.setAttribute("aria-expanded", "true");
    const popover = typeof surface.showPopover === "function";
    if (popover) surface.showPopover();
    const position = () => {
      if (!current.current) return;
      // Computed padding resolves env()/var()/max()/calc() to pixels; custom properties need not be numeric.
      const safe = getComputedStyle(probe);
      const viewport = window.visualViewport;
      const left = Math.max(0, viewport?.offsetLeft ?? 0) + parseFloat(safe.paddingLeft) + 4;
      const top = Math.max(0, viewport?.offsetTop ?? 0) + parseFloat(safe.paddingTop) + 4;
      const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? document.documentElement.clientWidth) - parseFloat(safe.paddingRight) - 4;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? document.documentElement.clientHeight) - parseFloat(safe.paddingBottom) - 4;
      surface.style.maxWidth = `${Math.max(0, right - left)}px`;
      surface.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      const bounds = surface.getBoundingClientRect();
      const x = Math.max(left, Math.min(open.x, right - bounds.width));
      const below = open.y + 4;
      const y = below + bounds.height <= bottom ? Math.max(top, below) : Math.max(top, Math.min(open.y - bounds.height - 4, bottom - bounds.height));
      surface.style.left = `${x}px`;
      surface.style.top = `${y}px`;
    };
    const toggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") close();
    };
    const update = () => {
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
    surface.addEventListener("toggle", toggle);
    window.addEventListener(COVER_MENU_CHANGE, update);
    window.addEventListener("resize", position);
    window.addEventListener(IOS_LAYOUT_CHANGE, position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      mutations.disconnect();
      resize.disconnect();
      surface.removeEventListener("toggle", toggle);
      window.removeEventListener(COVER_MENU_CHANGE, update);
      window.removeEventListener("resize", position);
      window.removeEventListener(IOS_LAYOUT_CHANGE, position);
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
    {open && <div ref={menu} popover={typeof HTMLElement.prototype.showPopover === "function" ? "auto" : undefined} role="menu" aria-label="剧集操作" className="hg-cover-action-menu"
      style={{ position: "fixed", margin: 0, inset: "auto", zIndex: 200, boxSizing: "border-box", overflowY: "auto" } as CSSProperties}>
      {open.target.items.map((item) => <button key={item.action} type="button" role="menuitem" tabIndex={-1}
        disabled={item.disabled} aria-disabled={item.disabled || undefined} data-destructive={item.destructive || undefined}
        className="hg-cover-action-item" onClick={() => {
          const target = current.current?.target;
          close();
          if (target) runCoverMenuAction(target, item.action);
        }}>
        <span className="hg-cover-action-label">{item.label}</span>
        {item.hint && <span className="hg-cover-action-hint">{item.hint}</span>}
      </button>)}
    </div>}
  </>;
}
