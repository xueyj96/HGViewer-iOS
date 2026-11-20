import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { createOfflineStatusStore } from "../offlineStatusStore";
import { useToastActions } from "../toasts";
import { useToastFeedback } from "./useToastFeedback";
import { useIOSNavigation } from "./IOSNavigation";

const { subscribe, getSnapshot, refresh, retain } = createOfflineStatusStore(api.offlineStatus);
const subscribeInactive = () => () => {};

export function useOfflineStatus(active: boolean) {
  const { state, readError } = useSyncExternalStore(active ? subscribe : subscribeInactive, getSnapshot);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const reporting = useRef(active);
  const presentationEpoch = useRef(0);
  const { active: navigationActive } = useIOSNavigation();
  const toast = useToastActions()?.toast;
  useLayoutEffect(() => {
    ++presentationEpoch.current;
    reporting.current = active && navigationActive;
    return () => { reporting.current = false; ++presentationEpoch.current; };
  }, [active, navigationActive]);
  useToastFeedback(readError, active, "offline-read");

  const runAction = async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    const startedInPresentation = presentationEpoch.current;
    actionPending.current = true;
    setBusy(true);
    try {
      await action();
      await refresh().catch(() => {});
    } catch (error) {
      const message = (error as Error).message || "操作失败，请重试";
      if (reporting.current && startedInPresentation === presentationEpoch.current) toast?.(message, "info");
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (active) return retain();
  }, [active]);

  return { state, readError, refresh, busy, runAction };
}
