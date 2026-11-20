import { act } from "react";
import { createRoot } from "react-dom/client";
import AuthorPage from "../src/pages/Author";
import { AppProvider, useStore } from "../src/store";
import "../src/index.css";
import "../src/ios.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
let store!: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
const calls: { command: string; args: Record<string, unknown> }[] = [];
const bridge = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
const previous = bridge.__TAURI_INTERNALS__;
const oldObserver = window.IntersectionObserver;
// Automatic paging is triggered deliberately below, independent of fixture viewport height.
let intersect: ((entries: IntersectionObserverEntry[]) => void) | undefined;
window.IntersectionObserver = class {
  constructor(callback: (entries: IntersectionObserverEntry[]) => void) { intersect = callback; }
  observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
} as unknown as typeof IntersectionObserver;
let failPageTwo = false;
let lateResolve: ((value: unknown) => void) | undefined;
const video = (id: number) => ({ id, title: `作品${id}`, cover: "", tags: [], author: { id: 7, name: "作者七" } });
bridge.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
  calls.push({ command, args });
  if (command === "app_boot") return { user: null, strict_security: true };
  if (command === "api_author") {
    if (args.id === 99) return new Promise(resolve => { lateResolve = resolve; });
    return { id: args.id, nickname: `作者${args.id}`, username: "author", counts: { video: 3, follower: 12 } };
  }
  if (command === "api_author_videos") {
    if (args.page === 2 && failPageTwo) throw "下一页失败";
    return { items: args.page === 2 ? [video(2), video(3)] : [video(1), video(2)], pagination: { page: args.page, pages: 2, size: 20, total: 3 } };
  }
  return null;
} };
const root = createRoot(document.querySelector("#fixture")!);
const render = async (id = 7, active = true) => {
  await act(async () => root.render(<AppProvider><Probe /><AuthorPage id={id} active={active} wide={false} onBack={() => store.pop()} /></AppProvider>));
};
const run = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
};
try {
  await render();
  await run("author loads profile and works by ID without keyword search", () => {
    check(calls.some(c => c.command === "api_author" && c.args.id === 7), "profile ID missing");
    check(calls.some(c => c.command === "api_author_videos" && c.args.id === 7 && c.args.page === 1), "first works page missing");
    check(!calls.some(c => c.command === "api_search"), "author works depend on keyword search");
    check(document.body.textContent?.includes("作品1"), "works not rendered");
  });
  await run("page failure retains existing works and remains retryable", async () => {
    failPageTwo = true;
    await act(async () => intersect?.([{ isIntersecting: true } as IntersectionObserverEntry]));
    check(document.body.textContent?.includes("作品1"), "failure clears first page");
    check([...document.querySelectorAll('button')].some(b => b.textContent === "重试"), "no retry");
    failPageTwo = false;
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === "重试")!.click());
    check(document.body.textContent?.includes("作品3"), "retry does not fetch next page");
    check(document.querySelectorAll('[data-hg-menu-card="2"]').length === 1, "duplicate work after pagination");
  });
  await run("opening a work retains the full author list as playback context", async () => {
    const card = document.querySelector<HTMLElement>('[data-hg-menu-card="3"]')!;
    check(card, "work card missing");
    await act(async () => card.click());
    const route = store.stack.at(-1);
    check(route?.kind === "feed" && route.index === 2 && route.videoIds.join() === "1,2,3", "incorrect author playback context");
    await act(async () => store.pop());
    check(document.body.textContent?.includes("作品3"), "return loses loaded work list");
  });
  await run("a late prior author's response cannot replace the next author", async () => {
    await render(99);
    await render(8);
    await act(async () => lateResolve?.({ id: 99, nickname: "过期作者", counts: { video: 0, follower: 0 } }));
    check(document.body.textContent?.includes("作者8") && !document.body.textContent.includes("过期作者"), "stale profile overwrote current author");
  });
  await run("inactive pages do not automatically fetch the next page", async () => {
    await render(8, false);
    const count = calls.length;
    await act(async () => intersect?.([{ isIntersecting: true } as IntersectionObserverEntry]));
    check(calls.length === count, "hidden author keeps paging");
  });
} finally {
  await act(async () => root.unmount());
  bridge.__TAURI_INTERNALS__ = previous;
  window.IntersectionObserver = oldObserver;
}
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results }, null, 2);
