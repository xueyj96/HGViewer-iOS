import { act } from "react";
import { createRoot } from "react-dom/client";
import Category, { ChannelPage } from "../src/pages/Category";
import { AppProvider, useStore } from "../src/store";
import "../src/index.css";
import "../src/ios.css";

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
document.documentElement.classList.add("plat-ios");
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const calls: Record<string, unknown>[] = [];
const firstIds = [30, 10, 40, 20, 8, 7, 6, 5, 4, 3];
let more: IntersectionObserverCallback | undefined;
const originalObserver = window.IntersectionObserver;
window.IntersectionObserver = class {
  private callback?: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    if (options?.rootMargin === "600px") { this.callback = callback; more = callback; }
  }
  observe() {} unobserve() {} takeRecords() { return []; }
  disconnect() { if (more === this.callback) more = undefined; }
} as unknown as typeof IntersectionObserver;
const bridge = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
const originalBridge = bridge.__TAURI_INTERNALS__;
bridge.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
  if (command === "app_boot") return { user: null, strict_security: true };
  if (command !== "api_category") return null;
  calls.push(args);
  const ids = args.sort === "popular" ? [90, 80, 70, 60, 50, 45, 35, 25, 15, 1] : args.page === 1 ? firstIds : [999, 7, 2];
  return { items: ids.map(id => ({ id, title: `作品${id}`, cover: "", tags: [], hot: id, score: id, episode_count: 1 })),
    pagination: { page: args.page, pages: 2, size: 20, total: 12 } };
} };
let store!: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
const root = createRoot(document.querySelector("#fixture")!);
const render = async (cate: string, active = true) => {
  await act(async () => root.render(<AppProvider><Probe /><ChannelPage key={cate} cate={cate} name={cate} active={active} wide={false} onBack={() => {}} /></AppProvider>));
};
const pane = () => document.querySelector<HTMLElement>('[data-hg-tab-pane]:not([inert]) .scroll-y')!;
const cards = () => [...pane().querySelectorAll<HTMLElement>('[data-hg-menu-card]')];
const ids = () => cards().map(card => Number(card.dataset.hgMenuCard));
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); }); };
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
};
try {
  await act(async () => root.render(<AppProvider><Category wide={false} active /></AppProvider>));
  for (const direction of [-1, 1]) {
    await test(`overview: actual ${direction < 0 ? "left" : "right"} edge drag has no uncovered frame`, async () => {
      const viewport = document.querySelector<HTMLElement>('[data-hg-tab-viewport]')!;
      const bounds = viewport.getBoundingClientRect();
      const header = document.querySelector('[aria-label="分类内容"]')!.getBoundingClientRect();
      const touch = (window as unknown as { __channelTouch: (type: string, x: number, y: number) => Promise<void> }).__channelTouch;
      const gaps: number[] = [];
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        const intervals = [...viewport.querySelectorAll<HTMLElement>(':scope > [data-hg-tab-pane]')]
          .map(pane => pane.getBoundingClientRect())
          .map(box => [Math.max(0, box.left - bounds.left), Math.min(bounds.width, box.right - bounds.left)])
          .filter(([left, right]) => right > left).sort((a, b) => a[0] - b[0]);
        let end = 0, gap = 0;
        for (const [left, right] of intervals) { gap += Math.max(0, left - end); end = Math.max(end, right); }
        gaps.push(gap + Math.max(0, bounds.width - end));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      // Do not use act here: it flushes continuous events and hides the first-move race.
      testEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        const x = direction < 0 ? bounds.right - 2 : bounds.left + 2;
        const y = bounds.top + 80;
        await touch("touchStart", x, y);
        for (const distance of [50, 114, 180]) {
          await touch("touchMove", x + direction * distance, y);
          await new Promise(resolve => setTimeout(resolve, 32));
        }
        await touch("touchEnd", x + direction * 180, y);
        await new Promise(resolve => setTimeout(resolve, 320));
      } finally { sampling = false; testEnvironment.IS_REACT_ACT_ENVIRONMENT = true; }
      check(gaps.length > 8 && Math.max(...gaps) < 1, `uncovered frame: ${Math.max(...gaps)}px`);
      check(viewport.children.length === 1 && viewport.firstElementChild?.getAttribute("data-hg-tab-pane") === (direction < 0 ? "1" : "0"), "swipe did not commit the intended pane");
      check(document.querySelector('[aria-label="分类内容"]')!.getBoundingClientRect().top === header.top, "overview header moved");
    });
  }
  for (const cate of ["ai-duanju", "ai-manju"]) {
    await render(cate); await tick();
    await test(`${cate}: first page uses exact server order with latest/hottest only`, async () => {
      check(ids().join() === firstIds.join(), "initial order was sorted by client ID");
      const options = document.querySelector('[aria-label="频道排序"]')!;
      check([...options.querySelectorAll("button")].map(button => button.textContent).join() === "最新,最热", "unsupported local rating sort remains");
    });
    await test(`${cate}: next page retains prefix nodes, card positions and scroll`, async () => {
      const container = pane(); container.scrollTop = 250;
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      const before = cards();
      const boxes = before.map(card => card.getBoundingClientRect());
      await act(async () => more?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      check(ids().join() === [...firstIds, 999, 2].join(), "next page reordered existing cards or kept duplicate");
      check(before.every((card, index) => card === cards()[index]), "prefix DOM remounted");
      check(before.every((card, index) => Math.abs(card.getBoundingClientRect().top - boxes[index].top) < .5), "prefix card positions jumped");
      check(container.scrollTop === 250, "append reset scroll");
      check(calls.filter(call => call.cate === cate && call.sort === "new").map(call => call.page).join() === "1,2", "sort missing from pagination request");
    });
    await test(`${cate}: sort return and playback return retain list and scroll`, async () => {
      const clickSort = async (label: string) => {
        await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="频道排序"] button')].find(button => button.textContent === label)!.click());
        await tick();
      };
      await clickSort("最热");
      check(ids()[0] === 90, "hottest reuses latest items");
      await clickSort("最新");
      check(ids().join() === [...firstIds, 999, 2].join() && pane().scrollTop === 250, "sort return lost loaded order or scroll");
      // Inspect the incoming pane before release, not just the final selected DOM.
      await clickSort("最热");
      const touch = (window as unknown as { __channelTouch: (type: string, x: number, y: number) => Promise<void> }).__channelTouch;
      const y = pane().getBoundingClientRect().top + 100;
      await act(async () => { await touch("touchStart", 2, y); await touch("touchMove", 140, y); });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const incoming = document.querySelector<HTMLElement>('[data-hg-tab-pane="0"] .scroll-y')!;
      const previewScroll = incoming?.scrollTop;
      const during: number[] = [];
      let sampling = true;
      const sample = () => { if (sampling) { during.push(incoming.scrollTop); requestAnimationFrame(sample); } };
      requestAnimationFrame(sample);
      const header = document.querySelector('[aria-label="频道排序"]')!.getBoundingClientRect();
      await act(async () => { await touch("touchEnd", 140, y); });
      await tick();
      sampling = false;
      check(during.length > 2 && during.every(value => value === 250), "scroll changed during handoff frames");
      check(document.querySelector('[aria-label="频道排序"]')!.getBoundingClientRect().top === header.top, "header moved with the pane");
      check(previewScroll === 250, `incoming preview jumped from ${previewScroll} to saved 250`);
      check(pane() === incoming && pane().scrollTop === 250, "incoming pane remounted or lost scroll on commit");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 520)); }); // synthetic-click suppression after a swipe
      const count = calls.length;
      await act(async () => cards()[1].click());
      const route = store.stack.at(-1);
      check(route?.kind === "feed" && route.index === 1 && route.videoIds.join() === ids().join(), "playback sequence differs from visible order");
      await render(cate, false); await render(cate, true);
      check(calls.length === count && pane().scrollTop === 250, "playback return reloads or resets channel");
    });
  }
} finally {
  await act(async () => root.unmount()); window.IntersectionObserver = originalObserver; bridge.__TAURI_INTERNALS__ = originalBridge;
}
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results }, null, 2);
