import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type OfflineState } from "../api";

type OfflineSnapshot = { state?: OfflineState; readError: string };

let snapshot: OfflineSnapshot = { readError: "" };
let revision = 0;
let activeReaders = 0;
let pollTimer: number | undefined;
let polling = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return snapshot;
}

function publish(next: OfflineSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

async function refresh() {
  const request = ++revision;
  try {
    const state = await api.offlineStatus();
    if (request === revision) publish({ state, readError: "" });
  } catch (error) {
    if (request === revision) {
      publish({ ...snapshot, readError: (error as Error).message || "无法读取本地缓存" });
    }
    throw error;
  }
}

async function poll() {
  pollTimer = undefined;
  polling = true;
  await refresh().catch(() => {});
  polling = false;
  if (activeReaders === 0) return;
  const hasActiveJob = !snapshot.readError && snapshot.state?.jobs.some((job) => job.running || job.queued);
  pollTimer = window.setTimeout(poll, hasActiveJob ? 700 : 1800);
}

function startReading() {
  activeReaders++;
  if (!polling && pollTimer === undefined) void poll();
  return () => {
    activeReaders--;
    if (activeReaders === 0) {
      window.clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };
}

export function useOfflineStatus(active: boolean) {
  const { state, readError } = useSyncExternalStore(subscribe, getSnapshot);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const actionPending = useRef(false);

  const runAction = async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setActionError("");
    try {
      await action();
      await refresh().catch(() => {});
    } catch (error) {
      setActionError((error as Error).message || "操作失败，请重试");
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (active) return startReading();
  }, [active]);

  return { state, readError, refresh, busy, actionError, runAction };
}
