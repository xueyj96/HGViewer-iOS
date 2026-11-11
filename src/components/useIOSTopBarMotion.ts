import { useLayoutEffect } from "react";

type Slot = { signature: string; left: number; width: number; extension: string };
/** Animate changed content slots on the persistent host, never the bar or bottom navigation. */
export function useIOSTopBarMotion(host: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!host) return;
    let previous = new Map<string, Slot>();
    const running = new Map<string, Animation>();
    const update = (animate = true) => {
      const bars = [...host.querySelectorAll<HTMLElement>(":scope > .hg-ios-floating-bar")];
      const bar = bars.reverse().find((element) => element.getBoundingClientRect().height > 0);
      const next = new Map<string, Slot>();
      if (bar) for (const element of [...bar.children] as HTMLElement[]) {
        const key = element.classList.contains("hg-ios-floating-panel") ? "panel"
          : element.classList.contains("hg-ios-floating-actions-end") ? "end" : "start";
        const rect = element.getBoundingClientRect();
        const extension = getComputedStyle(element).getPropertyValue("--ios-panel-extension").trim() || "0px";
        const signature = `${element.textContent}|${[...element.querySelectorAll("svg")].map((svg) => svg.innerHTML).join("|")}|${[...element.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")).join("|")}`;
        next.set(key, { signature, left: rect.left, width: rect.width, extension });
        const old = previous.get(key);
        const layoutChanged = !!old && (Math.abs(old.left - rect.left) > .5 || Math.abs(old.width - rect.width) > .5 || old.extension !== extension);
        if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches ||
          (old?.signature === signature && !layoutChanged)) continue;
        running.get(key)?.cancel();
        const delta = old ? old.left - rect.left : 0;
        running.set(key, element.animate([
          { opacity: .65, transform: `translateX(${delta}px)` },
          { opacity: 1, transform: "translateX(0px)" },
        ], { duration: 200, easing: "cubic-bezier(.2,0,.2,1)" }));
        if (key === "panel" && old && old.extension !== extension) {
          running.get("panel-surface")?.cancel();
          running.set("panel-surface", element.animate([
            { "--ios-panel-extension": old.extension }, { "--ios-panel-extension": extension },
          ], { duration: 200, easing: "cubic-bezier(.2,0,.2,1)" }));
        }
      }
      for (const [key, animation] of running) if (!next.has(key === "panel-surface" ? "panel" : key)) { animation.cancel(); running.delete(key); }
      previous = next;
    };
    const observer = new MutationObserver(() => update());
    observer.observe(host, { subtree: true, childList: true, characterData: true });
    const resize = new ResizeObserver(() => {
      running.forEach((animation) => animation.cancel());
      update(false);
    });
    resize.observe(host);
    update();
    return () => { observer.disconnect(); resize.disconnect(); running.forEach((animation) => animation.cancel()); };
  }, [host]);
}
