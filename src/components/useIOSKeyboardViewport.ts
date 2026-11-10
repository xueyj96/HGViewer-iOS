import { useEffect, type RefObject } from "react";
import { isIos } from "../api";

export function useIOSKeyboardViewport(ref: RefObject<HTMLElement | null>, open = true, compactHeight = 150) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const surface = ref.current;
    if (!isIos || !open || !viewport || !surface) return;
    let keyboardVisible = false;
    const update = () => {
      const focused = document.activeElement;
      const editing = focused?.matches("input, textarea") && surface.contains(focused);
      const heightDifference = Math.max(0, document.documentElement.clientHeight - viewport.height);
      // The keyboard can remain visible after focus moves to the submit button.
      keyboardVisible = heightDifference > 0 && (keyboardVisible || !!editing);
      surface.style.setProperty("--hg-keyboard-inset", `${keyboardVisible ? heightDifference : 0}px`);
      surface.style.setProperty("--hg-keyboard-top", `${keyboardVisible ? viewport.offsetTop : 0}px`);
      surface.toggleAttribute("data-compact-keyboard", keyboardVisible && viewport.height < compactHeight);
      surface.toggleAttribute("data-constrained-keyboard", keyboardVisible && viewport.height < 150);
      let scroller = editing && keyboardVisible ? focused?.closest<HTMLElement>("[data-keyboard-scroll]") : null;
      while (scroller && (scroller.scrollHeight <= scroller.clientHeight || getComputedStyle(scroller).overflowY === "visible")) {
        scroller = scroller.parentElement?.closest<HTMLElement>("[data-keyboard-scroll]") ?? null;
      }
      if (scroller && focused instanceof HTMLElement) {
        const field = focused.getBoundingClientRect();
        const bounds = scroller.getBoundingClientRect();
        if (field.bottom > bounds.bottom) scroller.scrollTop += field.bottom - bounds.bottom;
        else if (field.top < bounds.top) scroller.scrollTop -= bounds.top - field.top;
      }
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    surface.addEventListener("focusin", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      surface.removeEventListener("focusin", update);
      surface.style.removeProperty("--hg-keyboard-inset");
      surface.style.removeProperty("--hg-keyboard-top");
      surface.removeAttribute("data-compact-keyboard");
      surface.removeAttribute("data-constrained-keyboard");
    };
  }, [ref, open, compactHeight]);
}
