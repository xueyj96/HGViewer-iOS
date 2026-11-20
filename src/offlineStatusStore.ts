import type { OfflineState } from "./api";

type OfflineSnapshot = { state?: OfflineState; readError: string };
type Scheduler = {
  set: (callback: () => void, delay: number) => number;
  clear: (timer: number) => void;
};

/** One read owner for every cache screen. It observes downloads; it never owns their lifetime. */
export function createOfflineStatusStore(read: () => Promise<OfflineState>, scheduler: Scheduler = {
  set: (callback, delay) => window.setTimeout(callback, delay),
  clear: (timer) => window.clearTimeout(timer),
}) {
  let snapshot: OfflineSnapshot = { readError: "" };
  const listeners = new Set<() => void>();
  let revision = 0;
  let inFlight: { revision: number; promise: Promise<void> } | undefined;
  let readers = 0;
  let timer: number | undefined;
  let polling = false;

  const publish = (next: OfflineSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  function readLatest(): Promise<void> {
    if (inFlight) {
      // A mutation invalidates a read already sent to native. Wait for it, then read anew.
      return inFlight.revision === revision ? inFlight.promise
        : inFlight.promise.catch(() => {}).then(readLatest);
    }
    const requestRevision = revision;
    const promise = Promise.resolve().then(read).then((state) => {
      if (requestRevision === revision) publish({ state, readError: "" });
    }, (error: unknown) => {
      if (requestRevision === revision) {
        publish({ ...snapshot, readError: error instanceof Error && error.message || "无法读取本地缓存" });
      }
      throw error;
    }).finally(() => {
      if (inFlight?.promise === promise) inFlight = undefined;
    });
    inFlight = { revision: requestRevision, promise };
    return promise;
  }

  async function poll() {
    timer = undefined;
    polling = true;
    await readLatest().catch(() => {});
    polling = false;
    if (!readers) return;
    const activeJob = !snapshot.readError && snapshot.state?.jobs.some((job) => job.running || job.queued);
    timer = scheduler.set(() => { void poll(); }, activeJob ? 700 : 1800);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** Call after a native mutation, or for an explicit retry; never reuse a pre-mutation read. */
    refresh() {
      ++revision;
      return readLatest();
    },
    retain() {
      ++readers;
      if (!polling && timer === undefined) void poll();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--readers === 0 && timer !== undefined) {
          scheduler.clear(timer);
          timer = undefined;
        }
      };
    },
  };
}
