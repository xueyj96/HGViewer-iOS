import { useCallback, useEffect, useRef, useState } from "react";
import { api, type OfflineState } from "../api";

export function useOfflineStatus(active: boolean) {
  const [state, setState] = useState<OfflineState>();
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const actionPending = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const result = await api.offlineStatus();
      if (request === revision.current) {
        setState(result);
        setReadError("");
      }
      return result;
    } catch (error) {
      if (request === revision.current) setReadError((error as Error).message || "无法读取本地缓存");
      throw error;
    }
  }, []);

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
    if (!active) return;
    let alive = true;
    let timer = 0;
    const read = async () => {
      let interval = 1800;
      try {
        const result = await refresh();
        if (result.jobs.some((job) => job.running || job.queued)) interval = 700;
      } catch { /* refresh records the current request's error */ }
      if (alive) timer = window.setTimeout(read, interval);
    };
    void read();
    return () => {
      alive = false;
      ++revision.current;
      window.clearTimeout(timer);
    };
  }, [active, refresh]);

  return { state, readError, refresh, busy, actionError, runAction };
}
