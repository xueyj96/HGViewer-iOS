import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { api, type OfflineState } from "../src/api";
import { IOSNavigationScope } from "../src/components/IOSNavigation";
import { ToastHost } from "../src/components/ui";
import { useOfflineAuthor } from "../src/components/useOfflineAuthor";
import { useToasts, type Toast } from "../src/toasts";
import { OfflineLibrary } from "../src/pages/Offline";
import { AppProvider } from "../src/store";
import "../src/index.css";
import "../src/ios.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
declare global { interface Window { __captureOfflineDesign?: (name: string) => Promise<void> } }

const results: { name: string; passed: boolean; error?: string }[] = [];
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const container = document.querySelector<HTMLElement>("#fixture")!;
const root = createRoot(container);
document.documentElement.classList.add("plat-ios");
let fixtureKey = 0;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let toastSnapshot: Toast[] = [];
function ToastProbe() {
  const snapshot = useToasts();
  useLayoutEffect(() => { toastSnapshot = snapshot.toasts; }, [snapshot.toasts]);
  return null;
}

let authorActive = true;
function AuthorProbe() {
  const author = useOfflineAuthor(41, authorActive);
  return <output data-testid="offline-author">{author?.name ?? "作者资料尚未读取"}</output>;
}

const offlineState: OfflineState = {
  items: [{ id: 41, ep: 1, title: "缓存作品", bytes: 10, mp4: true }],
  bytes: 10,
  shows: { 41: { episodes: [1], cover: false, author: { id: 7, name: "本地作者" } } },
  recent: [],
  jobs: [],
};

let statusReads = 0;
let manualRefreshCalls = 0;
let offlineShowAuthor: { id: number; name: string } | undefined;
let deferredShowRefresh: ReturnType<typeof deferred<void>> | undefined;
const browser = window as unknown as {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};
const originalBridge = browser.__TAURI_INTERNALS__;
const originalOfflineShow = api.offlineShow;
const originalOfflineRefreshShow = api.offlineRefreshShow;
const originalOfflineStatus = api.offlineStatus;

browser.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command === "app_boot") return { user: null, strict_security: true };
    if (command === "offline_status") { statusReads++; return offlineState; }
    if (command === "offline_show") return { episodes: [1], cover: false, ...(offlineShowAuthor ? { author: offlineShowAuthor } : {}) };
    if (command === "offline_refresh_show") {
      manualRefreshCalls++;
      if (deferredShowRefresh) return deferredShowRefresh.promise;
      return null;
    }
    return null;
  },
};

async function render(content: React.ReactNode, fresh = false) {
  if (fresh) { authorActive = true; fixtureKey++; }
  await act(async () => root.render(
    <AppProvider key={fixtureKey}>
      <ToastProbe />
      {content}
      <ToastHost />
    </AppProvider>,
  ));
  await flush();
}

async function flush() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

async function run(name: string, fn: () => Promise<void>) {
  try { await render(null, true); toastSnapshot = []; await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  finally { api.offlineShow = originalOfflineShow; api.offlineRefreshShow = originalOfflineRefreshShow; }
}

await run("rejected author enrichment retries after same-route deactivate and reactivate", async () => {
  let requests = 0;
  let refresh = deferred<void>();
  offlineShowAuthor = undefined;
  api.offlineShow = async () => ({ episodes: [1], cover: false, ...(offlineShowAuthor ? { author: offlineShowAuthor } : {}) });
  api.offlineRefreshShow = async () => { requests++; return refresh.promise; };
  await render(<AuthorProbe />);
  check(requests === 1, "initial author enrichment did not start");
  refresh.reject(new Error("首次补齐失败"));
  await flush();
  authorActive = false;
  await render(<AuthorProbe />);
  refresh = deferred<void>();
  authorActive = true;
  await render(<AuthorProbe />);
  check(requests === 2, `reactivation did not start a fresh metadata request (calls=${requests})`);
  offlineShowAuthor = { id: 7, name: "本地作者" };
  refresh.resolve();
  await flush();
  check(container.querySelector("[data-testid='offline-author']")?.textContent === "本地作者", "successful retry did not render the saved author");
});

await run("reactivation joins in-flight author enrichment and a completed request stays deduplicated", async () => {
  let requests = 0;
  const refresh = deferred<void>();
  offlineShowAuthor = undefined;
  api.offlineShow = async () => ({ episodes: [1], cover: false, ...(offlineShowAuthor ? { author: offlineShowAuthor } : {}) });
  api.offlineRefreshShow = async () => { requests++; return refresh.promise; };
  await render(<AuthorProbe />);
  check(requests === 1, "initial author enrichment did not start");
  authorActive = false;
  await render(<AuthorProbe />);
  authorActive = true;
  await render(<AuthorProbe />);
  check(requests === 1, "reactivation did not join the existing request");
  refresh.resolve();
  offlineShowAuthor = { id: 7, name: "本地作者" };
  await flush();
  check(container.querySelector("[data-testid='offline-author']")?.textContent === "本地作者", "joined request did not render author metadata");
  offlineShowAuthor = undefined;
  authorActive = false;
  await render(<AuthorProbe />);
  authorActive = true;
  await render(<AuthorProbe />);
  check(requests === 1, "successful enrichment was requested again for the same ID and line");
});

await run("manual episode refresh suppresses a stale failure but reports a current failure once and restores the button", async () => {
  const pending = deferred<void>();
  deferredShowRefresh = pending;
  manualRefreshCalls = 0;
  offlineShowAuthor = undefined;
  const library = (active: boolean) => <IOSNavigationScope active={active}>
    <OfflineLibrary id={41} title="缓存作品" active={active} />
  </IOSNavigationScope>;
  await render(library(true));
  for (let i = 0; i < 8 && !container.querySelector<HTMLButtonElement>('button[aria-busy]'); i++) await flush();
  const button = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("刷新剧集"))!;
  check(button(), "actual OfflineLibrary refresh button was not rendered");
  await act(async () => button().click());
  check(manualRefreshCalls === 1, "manual refresh did not reach offline_refresh_show");
  await render(library(false));
  await render(library(true));
  pending.reject("旧刷新失败");
  await flush();
  check(toastSnapshot.length === 0, "failure from the previous presentation produced a toast after returning");
  check(!button().disabled && button().getAttribute("aria-busy") !== "true", "stale request left the refresh button loading");
});

await run("current manual episode refresh failure reports once and restores the button", async () => {
  const pending = deferred<void>();
  deferredShowRefresh = pending;
  const library = <IOSNavigationScope active>
    <OfflineLibrary id={41} title="缓存作品" active />
  </IOSNavigationScope>;
  await render(library);
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("刷新剧集"))!;
  check(button, "actual OfflineLibrary refresh button was not rendered");
  await act(async () => button.click());
  pending.reject("当前刷新失败");
  await flush();
  check(toastSnapshot.length === 1 && toastSnapshot[0].msg === "当前刷新失败", "current refresh failure was not reported exactly once");
  check(!button.disabled && button.getAttribute("aria-busy") !== "true", "current failure did not restore the refresh button");
});

await run("successful shared metadata refresh can update cache status while its page is hidden", async () => {
  const pending = deferred<void>();
  deferredShowRefresh = pending;
  const library = (active: boolean) => <IOSNavigationScope active={active}>
    <OfflineLibrary id={41} title="缓存作品" active={active} />
  </IOSNavigationScope>;
  await render(library(true));
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("刷新剧集"))!;
  const before = statusReads;
  await act(async () => button.click());
  await render(library(false));
  pending.resolve();
  await flush();
  check(statusReads > before, "successful shared metadata update did not refresh offline status while hidden");
  check(toastSnapshot.length === 0, "successful background metadata update produced an error toast");
});

api.offlineShow = originalOfflineShow;
api.offlineRefreshShow = originalOfflineRefreshShow;
api.offlineStatus = originalOfflineStatus;
browser.__TAURI_INTERNALS__ = originalBridge;
await act(async () => root.unmount());
document.querySelector("#results")!.textContent = JSON.stringify({
  passed: results.filter(result => result.passed).length,
  failed: results.filter(result => !result.passed).length,
  results,
}, null, 2);
