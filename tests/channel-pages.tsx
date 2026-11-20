import { act } from "react";
import { createRoot } from "react-dom/client";
import { useChannelPages, type ChannelOrder } from "../src/components/useChannelPages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const calls: Record<string, unknown>[] = [];
type PageResult = { items: { id: number; hot: number; score: number }[]; pagination: { page: number; pages: number } };
const page = (ids: number[], number = 1): PageResult => ({ items: ids.map(id => ({ id, hot: id, score: id })), pagination: { page: number, pages: 2 } });
let pending: ((value: PageResult) => void) | undefined;
let deferred = false;
let failNext = false;
const bridge = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } };
const original = bridge.__TAURI_INTERNALS__;
bridge.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  if (command !== "api_category") return null;
  calls.push(args);
  if (deferred) { deferred = false; return new Promise<PageResult>(resolve => { pending = resolve; }); }
  if (failNext) { failNext = false; throw "本页失败"; }
  if (args.cate === "ai-manju") return page([200, 199], Number(args.page));
  if (args.sort === "popular") return page([50, 40], Number(args.page));
  return args.page === 1 ? page([10, 9]) : page([100, 9, 8], 2);
} };
let state!: ReturnType<typeof useChannelPages>;
function Probe({ order, active, cate }: { order: ChannelOrder; active: boolean; cate: string }) {
  state = useChannelPages(cate, order, active); return null;
}
const root = createRoot(document.querySelector("#fixture")!);
const render = async (order: ChannelOrder = "new", active = true, cate = "ai-duanju") => {
  await act(async () => root.render(<Probe order={order} active={active} cate={cate} />));
};
const run = async (name: string, test: () => Promise<void>) => {
  try { await test(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
};
try {
  await render();
  await run("server sort is explicit and a later page cannot reorder the visible prefix", async () => {
    await act(async () => state.load("new"));
    check(state.snapshots.new.items.map(item => item.id).join() === "10,9,100,8", "next page moved prior cards or kept duplicates");
    check(calls.filter(call => call.sort === "new").map(call => call.page).join() === "1,2", "server order changed between pages");
  });
  await run("each sort owns its results and returning does not refetch or discard its cursor", async () => {
    const before = state.snapshots.new.items;
    await render("popular");
    check(state.snapshots.popular.items.map(item => item.id).join() === "50,40", "sorts share the same page data");
    const count = calls.length;
    await render("new");
    check(state.snapshots.new.items === before && calls.length === count && state.snapshots.new.page === 2, "returning replaced a loaded order");
  });
  await run("an inactive page cannot start paging from a queued observer callback", async () => {
    await render("popular", false);
    const count = calls.length;
    await act(async () => state.load("popular"));
    check(calls.length === count, "hidden channel continued loading");
  });
  await run("failed pagination retries the same page and preserves prior items", async () => {
    await render("popular");
    failNext = true;
    await act(async () => state.load("popular"));
    check(state.snapshots.popular.page === 1 && state.snapshots.popular.items.length === 2, "failure advanced cursor or cleared prefix");
    await act(async () => state.load("popular"));
    check(calls.slice(-2).every(call => call.page === 2), "retry skipped failed page");
  });
  await run("switching channels ignores a prior channel's late response", async () => {
    deferred = true;
    await render("new", true, "ai-manju");
    await render("new", true, "ai-duanju");
    await act(async () => pending?.(page([999])));
    check(state.snapshots.new.items.map(item => item.id).join() === "10,9", "old channel response replaced current items");
  });
  await run("retired channel and sort callbacks cannot fetch into the current page", async () => {
    const previous = state.load;
    await render("new", true, "ai-manju");
    const before = calls.length;
    await act(async () => { await previous("new"); await state.load("popular"); });
    check(calls.length === before, "retired observer started another request");
    await render("new", true, "ai-duanju");
  });
  await run("duplicate page triggers share the existing in-flight operation", async () => {
    deferred = true;
    const before = calls.length;
    let first!: Promise<void>;
    await act(async () => { first = state.load("new"); void state.load("new"); });
    check(calls.length === before + 1, "same page requested twice");
    await act(async () => { pending?.(page([8], 2)); await first; });
    check(state.snapshots.new.items.map(item => item.id).join() === "10,9,8", "page completion changed the prefix");
  });
} finally {
  await act(async () => root.unmount()); bridge.__TAURI_INTERNALS__ = original;
}
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results }, null, 2);
