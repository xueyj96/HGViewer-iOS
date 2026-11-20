import { StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type OfflineState } from "../src/api";
import { AppProvider, useStore } from "../src/store";
import { ToastProvider, useToastActions, useToasts } from "../src/toasts";
import { createOfflineStatusStore } from "../src/offlineStatusStore";
import { normalizePreferences, PREFERENCES_KEY } from "../src/persistedPreferences";
import { setMembership } from "../src/collections";
import { useRevisionRecord } from "../src/components/useRevisionRecord";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const state = (bytes: number): OfflineState => ({ bytes, items: [], jobs: [], recent: [], shows: {} });
function offlineFixture() {
  const reads: ReturnType<typeof deferred<OfflineState>>[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0, running = 0, maximum = 0;
  const store = createOfflineStatusStore(() => {
    const request = deferred<OfflineState>();
    reads.push(request);
    maximum = Math.max(maximum, ++running);
    return request.promise.finally(() => { --running; });
  }, {
    set: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clear: (id) => { timers.delete(id); },
  });
  return { store, reads, timers, maximum: () => maximum };
}

await test("membership targets are immutable, idempotent, and preserve favorite undo position", () => {
  const before = [1, 2];
  assert(setMembership(before, 1, true) === before, "same target changed identity");
  assert(JSON.stringify(setMembership(before, 3, true, 1)) === "[1,3,2]", "undo insertion changed");
  assert(JSON.stringify(setMembership(before, 1, false)) === "[2]" && JSON.stringify(before) === "[1,2]", "input mutated");
});
await test("v1 valid preferences and legacy history survive normalization", () => {
  const valid = { likes: [3], favs: [2, 1], follows: [7], muted: false, volume: 0.4,
    searchHist: ["one", "two"], history: [{ id: 2, ep: 3, t: 9, dur: 30, at: 99 }],
    playbackSidebar: normalizePreferences(null, 100).playbackSidebar };
  assert(JSON.stringify(normalizePreferences(valid, 100)) === JSON.stringify({
    likes: valid.likes, favs: valid.favs, history: valid.history, follows: valid.follows, muted: false,
    volume: 0.4, searchHist: valid.searchHist, playbackSidebar: valid.playbackSidebar,
  }), "valid values/order changed");
  assert(normalizePreferences({ history: [4] }, 100).history[0].id === 4, "legacy history lost");
});
await test("malformed preference fields do not poison good fields or persist unknown data", () => {
  const normalized = normalizePreferences({ likes: "bad", favs: [2, 2, -1, "3", 1.5, null], follows: {},
    muted: "false", volume: Infinity, searchHist: [null, 2, "", "term", "term"], extra: "ignore" }, 100);
  assert(normalized.likes.length === 0 && JSON.stringify(normalized.favs) === "[2]", "IDs not validated");
  assert(normalized.muted && normalized.volume === 0.7 && JSON.stringify(normalized.searchHist) === '["term"]', "defaults not isolated");
  assert(!("extra" in normalized) && normalizePreferences([], 100).favs.length === 0, "unknown fields retained");
});
await test("data revisions invalidate records immediately and reject retired writers without remounting", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let record!: ReturnType<typeof useRevisionRecord<string>>, mounts = 0;
  function RecordProbe({ revision }: { revision: number }) {
    record = useRevisionRecord<string>(revision);
    const [identity] = useState(() => ++mounts);
    return <span>{identity}</span>;
  }
  try {
    await act(async () => { root.render(<RecordProbe revision={0} />); });
    const oldWriter = record[1];
    await act(async () => { oldWriter({ one: "old" }); });
    await act(async () => { root.render(<RecordProbe revision={1} />); });
    assert(!record[0].one && mounts === 1, "revision reused data or remounted feature");
    await act(async () => { record[1]({ two: "new" }); oldWriter({ one: "late" }); });
    assert(record[0].two === "new" && !record[0].one, "retired writer replaced new data");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
await test("cache screens share one read and one polling timer with idempotent release", async () => {
  const f = offlineFixture();
  const a = f.store.retain(), b = f.store.retain();
  await flush(); assert(f.reads.length === 1, "parallel initial reads");
  f.reads[0].resolve(state(1)); await flush();
  assert(f.timers.size === 1 && [...f.timers.values()][0].delay === 1800, "idle poll budget changed");
  a(); a(); assert(f.timers.size === 1, "duplicate release consumed another reader");
  b(); assert(f.timers.size === 0, "last reader leaked timer");
});
await test("post-mutation refresh never publishes or reuses an older in-flight snapshot", async () => {
  const f = offlineFixture();
  let publishes = 0;
  const unsubscribe = f.store.subscribe(() => { ++publishes; });
  const release = f.store.retain(); await flush();
  const a = f.store.refresh(), b = f.store.refresh();
  assert(f.reads.length === 1, "mutation started a parallel read");
  f.reads[0].resolve(state(1)); await flush();
  assert(publishes === 0 && f.reads.length === 2, "stale snapshot published or fresh read missing");
  f.reads[1].resolve(state(2)); await Promise.all([a, b]);
  assert(f.store.getSnapshot().state?.bytes === 2 && publishes === 1 && f.maximum() === 1, "fresh snapshot not shared or reads overlapped");
  unsubscribe(); release();
});
await test("failed superseded read cannot prevent a fresh post-mutation read", async () => {
  const f = offlineFixture(); const release = f.store.retain(); await flush();
  const refresh = f.store.refresh();
  f.reads[0].reject(new Error("old failure")); await flush();
  assert(!f.store.getSnapshot().readError && f.reads.length === 2, "stale error leaked");
  f.reads[1].resolve(state(3)); await refresh;
  assert(f.store.getSnapshot().state?.bytes === 3, "fresh read blocked by old failure");
  release();
});
await test("cache read failure retains prior data and retries at bounded cadence", async () => {
  const f = offlineFixture(); const release = f.store.retain(); await flush();
  f.reads[0].resolve(state(4)); await flush();
  const refresh = f.store.refresh().catch(() => {}); await flush();
  f.reads[1].reject(new Error("read failed")); await refresh;
  assert(f.store.getSnapshot().state?.bytes === 4 && f.store.getSnapshot().readError === "read failed", "failed read erased cache");
  const [id, scheduled] = [...f.timers.entries()][0]; f.timers.delete(id); scheduled.callback(); await flush();
  f.reads[2].resolve(state(5)); await flush();
  assert(!f.store.getSnapshot().readError && f.store.getSnapshot().state?.bytes === 5, "retry did not recover");
  release();
});
await test("leaving cache screens during a read does not schedule another poll", async () => {
  const f = offlineFixture(); const release = f.store.retain(); await flush(); release();
  f.reads[0].resolve(state(6)); await flush();
  assert(f.timers.size === 0, "inactive screen kept polling");
});

let store!: ReturnType<typeof useStore>, toastState!: ReturnType<typeof useToasts>, storeRenders = 0;
function StoreProbe() { store = useStore(); ++storeRenders; return null; }
function ToastProbe() { toastState = useToasts(); return null; }
const originalBoot = api.boot, previous = localStorage.getItem(PREFERENCES_KEY);
const root = createRoot(document.querySelector("#fixture")!);
try {
  api.boot = async () => ({ user: null, logged_in: false, base: "", strict_security: true });
  localStorage.setItem(PREFERENCES_KEY, "{}");
  await act(async () => { root.render(<StrictMode><AppProvider><StoreProbe /><ToastProbe /></AppProvider></StrictMode>); });
  await test("StrictMode local targets agree with persisted state and never toggle twice", async () => {
    await act(async () => { store.setLikedLocal(1, true); store.setLikedLocal(1, true); store.setFollowedLocal(7, true); store.setFavLocal(2, true); });
    assert(store.isLiked(1) && store.follows.includes(7) && store.isFav(2), "target not applied");
    await act(async () => { store.setLikedLocal(1, false); store.setFollowedLocal(7, false); });
    assert(!store.isLiked(1) && !store.follows.includes(7), "off target not applied");
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY)!);
    assert(saved.likes.length === 0 && saved.follows.length === 0 && saved.favs[0] === 2, "persisted targets disagree");
  });
  await test("showing and dismissing Toast does not rerender business Store consumers", async () => {
    const renders = storeRenders, reference = store;
    await act(async () => { store.toast("message", "info"); });
    assert(toastState.toasts.length === 1 && storeRenders === renders && store === reference, "toast broadcast to business context");
    await act(async () => { toastState.dismissToast(toastState.toasts[0].id); });
    assert(toastState.toasts.length === 0 && storeRenders === renders, "dismiss broadcast to business context");
  });
  await test("clearing history removes history undo only and preserves ordinary Toast actions", async () => {
    await act(async () => {
      store.addHistory(1, 1, 5, 60);
      store.toast("history", "info", { label: "undo", scope: "history", run: () => {} });
      store.toast("favorite", "info", { label: "undo", run: () => {} });
    });
    await act(async () => { store.clearHistory(); });
    assert(store.history.length === 0 && toastState.toasts.length === 1 && toastState.toasts[0].msg === "favorite", "history clear changed unrelated undo");
  });
  await test("Toast provider releases its pending timers on unmount", async () => {
    const element = document.createElement("div"); document.body.append(element);
    const isolated = createRoot(element), live = new Set<number>();
    const set = window.setTimeout, clear = window.clearTimeout;
    let actions!: ReturnType<typeof useToastActions>;
    function ActionsProbe() { actions = useToastActions(); return null; }
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      const timer = set(callback, delay, ...args);
      if (delay === 2200 || delay === 6500) live.add(timer);
      return timer;
    }) as typeof window.setTimeout;
    window.clearTimeout = (timer) => { if (typeof timer === "number") live.delete(timer); clear(timer); };
    try {
      await act(async () => { isolated.render(<ToastProvider><ActionsProbe /></ToastProvider>); });
      await act(async () => { actions.toast("one"); actions.toast("two", "info", { label: "undo", run: () => {} }); });
      assert(live.size === 2, "fixture did not observe both timer budgets");
      await act(async () => isolated.unmount());
      assert(live.size === 0, "provider left an owned timeout alive");
    } finally {
      window.setTimeout = set; window.clearTimeout = clear; element.remove();
    }
  });
} finally {
  await act(async () => root.unmount()); api.boot = originalBoot;
  if (previous === null) localStorage.removeItem(PREFERENCES_KEY); else localStorage.setItem(PREFERENCES_KEY, previous);
}
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length, results });
