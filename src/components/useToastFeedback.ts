import { useEffect, useRef } from "react";
import { useToastActions, type Toast } from "../toasts";
import { useIOSNavigation } from "./IOSNavigation";

// Shared read/task messages belong to the Toast owner, not to whichever cache page is mounted.
const delivered = new WeakMap<ReturnType<typeof useToastActions>["toast"], Map<string, string>>();

/** Move existing visible feedback to the common host. No message means no new notification. */
export function useToastFeedback(message: string | null | undefined, active = true, scope?: string, icon: Toast["icon"] = "info") {
  const toast = useToastActions()?.toast;
  const { active: navigationActive } = useIOSNavigation();
  const last = useRef("");
  const text = message || "";
  useEffect(() => {
    if (!toast) return; // Data-only/isolated consumers may intentionally have no presentation owner.
    if (scope) {
      if (!active || !navigationActive) return;
      let seen = delivered.get(toast);
      if (!seen) { seen = new Map(); delivered.set(toast, seen); }
      const previous = seen.get(scope) || "";
      seen.delete(scope);
      seen.set(scope, text);
      // Only deduplication metadata, bounded independently of progress/response volume.
      if (seen.size > 128) seen.delete(seen.keys().next().value!);
      if (text && text !== previous) toast(text, icon);
      return;
    }
    const changed = last.current !== text;
    last.current = text; // An inactive result is consumed, never replayed on return.
    if (active && navigationActive && changed && text) toast(text, icon);
  }, [text, active, navigationActive, scope, icon, toast]);
}
