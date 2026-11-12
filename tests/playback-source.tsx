import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, isIos, type OfflineEpisode } from "../src/api";
import { usePlaybackSource } from "../src/components/usePlaybackSource";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Options = Parameters<typeof usePlaybackSource>[0];
type Result = ReturnType<typeof usePlaybackSource>;
type Bridge = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
const browser = window as unknown as { __TAURI_INTERNALS__?: Bridge };
const originalBridge = browser.__TAURI_INTERNALS__;
const original = { play: api.play, offlineEpisode: api.offlineEpisode, watchBegin: api.watchBegin, watchDetails: api.watchDetails };
const originalNow = Date.now;
const results: { name: string; passed: boolean; error?: string }[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
let latest: Result;
function Probe({ options }: { options: Options }) { latest = usePlaybackSource(options); return null; }

async function test(name: string, run: (fixture: {
  update: (changes?: Partial<Options>) => Promise<void>;
  source: () => Result;
  plays: number[];
  localChecks: number[];
  preloads: unknown[];
  errors: string[];
}) => Promise<void>) {
  const element = document.createElement("div");
  document.querySelector("#fixture")!.append(element);
  const root = createRoot(element);
  const plays: number[] = [], localChecks: number[] = [], preloads: unknown[] = [], errors: string[] = [];
  let options: Options = { kind: "video", active: true, curId: 1, curEp: 1, retry: 0,
    offlineByShow: new Map(), posts: {}, candidates: [], readyToPreload: false,
    onError: (message) => errors.push(message) };
  api.play = async (id, ep) => { plays.push(id); return { id, ep_num: ep, duration: 60, title: "fixture", video_url: `https://fixture.invalid/${id}/${ep}.m3u8` }; };
  api.offlineEpisode = async (id) => { localChecks.push(id); return null; };
  api.watchBegin = async (id, ep) => id * 100 + ep;
  api.watchDetails = async () => {};
  browser.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "ios_player_preload") preloads.push(args?.source);
  } };
  const update = async (changes: Partial<Options> = {}) => {
    options = { ...options, ...changes };
    await act(async () => { root.render(<Probe options={options} />); });
  };
  try { await run({ update, source: () => latest, plays, localChecks, preloads, errors }); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  finally { await act(async () => root.unmount()); element.remove(); Date.now = originalNow; delete (document as unknown as { hidden?: boolean }).hidden; }
}

try {
  assert(isIos, "Run this fixture with an iPhone user agent (or iOS platform env)");
  await test("local lookup completes before any online request", async ({ update, source, plays }) => {
    const local = deferred<OfflineEpisode | null>(); api.offlineEpisode = () => local.promise;
    await update(); assert(!source().playUrl && plays.length === 0, "online request raced local check");
    await act(async () => local.resolve(null));
    assert(source().nativeSource.kind === "online" && plays.length === 1, "online fallback missing");
  });
  await test("cached hit never requests an online stream", async ({ update, source, plays }) => {
    api.offlineEpisode = async () => ({ id: 1, ep: 1, title: "cached", bytes: 10, mp4: true });
    await update(); assert(source().nativeSource.kind === "offline" && plays.length === 0, "cached hit fell through online");
  });
  await test("explicit offline route uses its supplied episode", async ({ update, source, plays, localChecks }) => {
    const episode = { id: 1, ep: 7, title: "cached", bytes: 10, mp4: false };
    await update({ curEp: 7, offlineItems: [episode], offlineByShow: new Map([[1, [episode]]]) });
    assert(source().offlineEpisode === episode && plays.length === 0 && localChecks.length === 0, "offline route consulted remote state");
  });
  await test("video and text posts keep their original source behavior", async ({ update, source, plays }) => {
    const post = { id: 1, title: "post", cover: "", tags: [], hot: 0, video_url: "https://fixture.invalid/post.mp4" };
    await update({ kind: "post", posts: { 1: post } }); assert(source().playUrl.includes("post.mp4") && plays.length === 0, "video post used episode API");
    await update({ posts: { 1: { ...post, video_url: undefined } } }); assert(source().playUrl === "", "text post retained video source");
  });
  await test("local lookup failure preserves online fallback", async ({ update, source, errors }) => {
    api.offlineEpisode = async () => { throw new Error("fixture local error"); };
    await update(); assert(source().nativeSource.kind === "online" && !!source().playUrl && errors.length === 0, "local failure blocked fallback");
  });
  await test("inactive page makes no source request", async ({ update, plays, localChecks }) => {
    await update({ active: false }); assert(!plays.length && !localChecks.length, "inactive page requested source");
    await update({ active: true }); assert(plays.length === 1, "reactivation failed to resolve");
  });
  await test("late previous source cannot replace current selection", async ({ update, source }) => {
    const previous = deferred<Awaited<ReturnType<typeof api.play>>>(); const play = api.play;
    api.play = (id, ep) => id === 1 ? previous.promise : play(id, ep);
    await update(); await update({ curId: 2 }); const current = source().playUrl;
    await act(async () => previous.resolve({ id: 1, ep_num: 1, duration: 60, title: "old", video_url: "https://fixture.invalid/old.m3u8" }));
    assert(source().playUrl === current && !current.includes("old"), "late previous request overwrote current source");
  });
  await test("retry invalidates only current online URL and resolves again", async ({ update, source, plays }) => {
    await update(); assert(plays.length === 1, "initial source missing");
    await act(async () => source().invalidateCurrentSource()); await update({ retry: 1 });
    assert(plays.length === 2 && !!source().playUrl, "retry reused invalidated source");
  });
  await test("invalidating current source preserves other resolved entries", async ({ update, source, plays }) => {
    await update(); await update({ curId: 2 }); await update({ curId: 1 });
    await act(async () => source().invalidateCurrentSource()); await update({ retry: 1 });
    await update({ curId: 2 });
    assert(plays.filter((id) => id === 1).length === 2 && plays.filter((id) => id === 2).length === 1, "invalidation cleared an unrelated source");
  });
  await test("source failure can be retried", async ({ update, source, errors }) => {
    const play = api.play; api.play = async () => { throw new Error("fixture unavailable"); };
    await update(); assert(errors.length === 1 && !source().playUrl, "failure not reported");
    api.play = play; await update({ retry: 1 }); assert(!!source().playUrl, "failed source was not retried");
  });
  for (const expired of [false, true]) await test(`adjacent source ${expired ? "expires" : "is reused on selection"}`, async ({ update, source, plays, preloads }) => {
    await update(); await update({ readyToPreload: true, candidates: [{ id: 2, ep: 1 }] });
    await act(async () => wait(510)); assert(plays.filter((id) => id === 2).length === 1 && preloads.length === 1, "adjacent source not preloaded");
    if (expired) Date.now = () => originalNow() + 31_000;
    await update({ curId: 2, readyToPreload: false, candidates: [] });
    assert(source().playUrl.includes("2%2F1") || source().playUrl.includes("/2/1"), "selected source wrong");
    assert(plays.filter((id) => id === 2).length === (expired ? 2 : 1), "preload reuse/expiry contract changed");
  });
  await test("adjacent requests remain serial and preserve candidate order", async ({ update, plays, preloads }) => {
    const pending = deferred<Awaited<ReturnType<typeof api.play>>>(); const play = api.play;
    api.play = (id, ep) => { if (id === 2) { plays.push(id); return pending.promise; } return play(id, ep); };
    await update(); await update({ readyToPreload: true, candidates: [{ id: 2, ep: 1 }, { id: 1, ep: 2 }, { id: 3, ep: 1 }] });
    await act(async () => wait(510)); assert(plays.join() === "1,2" && !preloads.length, "prefetch became concurrent");
    await act(async () => pending.resolve({ id: 2, ep_num: 1, duration: 60, title: "fixture", video_url: "https://fixture.invalid/2/1.m3u8" }));
    assert(plays.join() === "1,2,1,3" && preloads.length === 3, "prefetch candidate order changed");
  });
  await test("cancelled prefetch timer makes no adjacent request", async ({ update, plays, preloads }) => {
    await update(); await update({ readyToPreload: true, candidates: [{ id: 2, ep: 1 }] });
    await update({ readyToPreload: false }); await act(async () => wait(510));
    assert(plays.length === 1 && !preloads.length, "cancelled prefetch still ran");
  });
  await test("background page does not preload", async ({ update, plays, preloads }) => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await update(); await update({ readyToPreload: true, candidates: [{ id: 2, ep: 1 }] }); await act(async () => wait(510));
    assert(plays.length === 1 && !preloads.length, "background prefetch ran");
  });
} catch (error) { results.push({ name: "fixture setup", passed: false, error: String(error) }); }
finally {
  Object.assign(api, original); browser.__TAURI_INTERNALS__ = originalBridge;
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results });
}
