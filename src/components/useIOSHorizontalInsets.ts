import { invoke } from "@tauri-apps/api/core";
import { useEffect, type RefObject } from "react";
import { isIos } from "../api";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";

export function useIOSHorizontalInsets(shell: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = shell.current;
    if (!isIos || !element) return;
    let revision = 0;
    let timer = 0;
    const readInsets = () => {
      const current = ++revision;
      void invoke<[number, number]>("ios_horizontal_safe_area").then((insets) => {
        if (current !== revision || !Array.isArray(insets)) return;
        const [left, right] = insets;
        if (!Number.isFinite(left) || !Number.isFinite(right)) return;
        const leftInset = `${Math.max(0, left)}px`;
        const rightInset = `${Math.max(0, right)}px`;
        if (element.style.getPropertyValue("--ios-native-safe-left") === leftInset &&
          element.style.getPropertyValue("--ios-native-safe-right") === rightInset) return;
        element.style.setProperty("--ios-native-safe-left", leftInset);
        element.style.setProperty("--ios-native-safe-right", rightInset);
        window.dispatchEvent(new Event(IOS_LAYOUT_CHANGE));
      }).catch(() => {});
    };
    const update = () => {
      readInsets();
      window.clearTimeout(timer);
      // UIKit can publish its final safe area after the WebView's rotation event.
      timer = window.setTimeout(readInsets, 350);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      ++revision;
      window.clearTimeout(timer);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [shell]);
}
