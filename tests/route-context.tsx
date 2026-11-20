import { act } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { AppProvider, useStore, type PageInput } from "../src/store";
import { useOfflineStatus } from "../src/components/useOfflineStatus";
import "../src/index.css";
import "../src/ios.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const episodePicker = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="选集"]')]
  .find((button) => !button.disabled && !button.closest('[inert], [aria-hidden="true"]'))!;
let store!: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
type Bridge = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
const browser = window as unknown as { __TAURI_INTERNALS__?: Bridge };
const originalBridge = browser.__TAURI_INTERNALS__;
const storageBefore = localStorage.getItem("hghub_app_v1");
const calls: { command: string; line: number }[] = [];
let line = 0;
let cacheBytes = 0;
let playbackPosition = 0;
const nativeSeeks: number[] = [];
const nativeOpens: Record<string, unknown>[] = [];
const cacheRenders = { a: 0, b: 0 };
const cacheReaders: Partial<Record<"a" | "b", ReturnType<typeof useOfflineStatus>>> = {};
function CacheProbe({ name, active }: { name: "a" | "b"; active: boolean }) {
  cacheReaders[name] = useOfflineStatus(active);
  ++cacheRenders[name];
  return null;
}
const pagination = { page: 1, pages: 1, total: 0, size: 20 };
browser.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
  calls.push({ command, line });
  if (command === "app_boot") return { user: null, strict_security: true };
  if (command === "settings_symbols") return {};
  if (command === "ios_horizontal_safe_area") return [0, 0];
  if (["api_feed", "api_category", "api_search", "api_posts"].includes(command)) return { items: [], pagination };
  if (command === "api_rank") return { type: args.kind, items: [] };
  if (command === "api_author") return { id: args.id, nickname: "fixture作者", username: "fixture", counts: { video: 0, follower: 0 } };
  if (command === "api_author_videos") return { items: [], pagination };
  if (command === "api_video") return { id: args.id, title: "fixture", cover: "", description: "", tags: [], score: 8,
    episode_count: 2, total_episodes: 2, episodes: [1, 2].map((ep_num) => ({ ep_num, title: "fixture", duration: 60, status: 1 })),
    author: { id: 1, name: "fixture" }, counts: { like: 0, collect: 0, comment: 0, hot: 0 } };
  if (command === "api_post") return { id: args.id, title: "fixture", cover: "", content: "<p>fixture</p>", tags: [], hot: 0 };
  if (command === "api_play") return { id: args.id, ep_num: args.ep, title: "fixture", duration: 60, video_url: `https://fixture.invalid/${line}/media.m3u8` };
  if (command === "watch_begin") return 1;
  if (command === "ios_player_open") { nativeOpens.push(args.source as Record<string, unknown>); return { levels: [], warm_input: false, input_ms: 4 }; }
  if (command === "ios_player_control") {
    if (args.action === "seek") nativeSeeks.push(Number(args.value));
    return { time: playbackPosition, duration: 60, status: 2, ready: 1, width: 1080, height: 1920, app_state: 0 };
  }
  if (command === "line_state") return { base: "https://fixture.invalid", default: "https://fixture.invalid", fixed: [] };
  if (command === "line_mirrors") return { items: [] };
  if (command === "offline_download_settings") return { limit: 4, segments: 4, allow_background: false, background_supported: true };
  if (command === "offline_status") return { items: [], jobs: [], recent: [], shows: {}, bytes: cacheBytes };
  return null;
} };
const root = createRoot(document.querySelector("#fixture")!);
try {
  localStorage.setItem("hghub_app_v1", "{}");
  await act(async () => { root.render(<AppProvider><Probe /><App /></AppProvider>); });
  const routes: { input: PageInput; command: string }[] = [
    { input: { kind: "feed", videoIds: [41], index: 0, title: "fixture" }, command: "api_video" },
    { input: { kind: "channel", cate: "ai-duanju", name: "fixture" }, command: "api_category" },
    { input: { kind: "ranks" }, command: "api_rank" },
    { input: { kind: "author", id: 256977, name: "fixture作者" }, command: "api_author_videos" },
    { input: { kind: "posts" }, command: "api_posts" },
    { input: { kind: "post", id: 42 }, command: "api_post" },
  ];
  for (const { input, command } of routes) {
    const name = `${input.kind}: line changes invalidate remote content while fixed chrome and Settings stay mounted`;
    try {
      await act(async () => { store.setTab("home"); });
      await act(async () => { store.push(input); });
      const routeKey = store.stack[0].key;
      assert(calls.some((call) => call.command === command && call.line === line), "initial remote read missing");
      await act(async () => { store.push({ kind: "settings" }); });
      const settings = document.querySelector(".hg-ios-settings-page");
      const chrome = document.querySelector(".hg-ios-navigation");
      ++line;
      await act(async () => { store.onLineChanged(); });
      if (input.kind === "channel") {
        assert(!calls.some((call) => call.command === command && call.line === line), "hidden channel starts paging under Settings");
      } else assert(calls.some((call) => call.command === command && call.line === line), "remote page reused prior data context");
      assert(document.querySelector(".hg-ios-settings-page") === settings && document.querySelector(".hg-ios-navigation") === chrome, "line change remounted Settings or chrome");
      assert(store.stack[0].key === routeKey && store.stack.length === 2, "navigation identity or stack lost");
      await act(async () => { store.pop(); });
      if (input.kind === "channel") assert(calls.some((call) => call.command === command && call.line === line), "reactivated channel reused prior line data");
      if (input.kind === "feed") assert(calls.some((call) => call.command === "api_play" && call.line === line), "playback reused the previous line URL");
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
  }
  for (const offline of [false, true]) {
    const name = `${offline ? "cached" : "online"} playback preserves selected episode and progress across line changes`;
    try {
      playbackPosition = 0;
      await act(async () => { store.setTab("home"); });
      await act(async () => { store.push({ kind: "feed", videoIds: [51], index: 0, title: "fixture", ...(offline ? {
        offlineItems: [1, 2].map((ep) => ({ id: 51, ep, title: "fixture", bytes: 100, mp4: true })),
      } : {}) }); });
      await act(async () => { episodePicker().click(); });
      await act(async () => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>(".hg-ios-episode-button")];
        const target = buttons.find((button) => button.textContent?.trim() === "2");
        assert(target, `second episode unavailable: ${buttons.map((button) => button.textContent?.trim()).join(",")}`);
        target!.click();
      });
      playbackPosition = 23;
      await act(async () => { await new Promise((done) => window.setTimeout(done, 450)); });
      const feature = document.querySelector(".player-root");
      const opens = nativeOpens.length;
      await act(async () => { store.push({ kind: "settings" }); });
      assert(store.history.find((item) => item.id === 51)?.t === 23, "fixture did not record progress before line change");
      const seeks = nativeSeeks.length;
      ++line; await act(async () => { store.onLineChanged(); });
      assert(document.querySelector(".player-root") === feature, "data invalidation remounted playback feature");
      assert(nativeOpens.length === opens, "line change opened a player under Settings");
      await act(async () => { store.pop(); });
      await act(async () => { await new Promise((done) => window.setTimeout(done, 250)); });
      assert(nativeSeeks.slice(seeks).includes(23), "returning player did not restore progress");
      if (offline) assert(nativeOpens.length === opens + 1 && nativeOpens.at(-1)?.ep === 2,
        "cached return did not use its existing selected episode with one normal player reopen");
      await act(async () => { episodePicker().click(); });
      assert(document.querySelector('.hg-ios-episode-button[aria-current="true"]')?.textContent?.trim() === "2", "line change reset episode to route seed");
      results.push({ name, passed: true });
    } catch (error) { results.push({ name, passed: false, error: String(error) }); }
  }
  try {
    await act(async () => { store.setTab("home"); });
    await act(async () => { store.push({ kind: "offline" }); store.push({ kind: "settings" }); });
    const cachedPage = document.querySelector(".hg-ios-cache-page");
    ++line; await act(async () => { store.onLineChanged(); });
    assert(cachedPage && document.querySelector(".hg-ios-cache-page") === cachedPage, "local cache page unnecessarily remounted");
    results.push({ name: "local cache route is independent of remote line revision", passed: true });
  } catch (error) { results.push({ name: "local cache route is independent of remote line revision", passed: false, error: String(error) }); }
  try {
    await act(async () => { root.render(<><CacheProbe name="a" active /><CacheProbe name="b" active={false} /></>); });
    const renders = cacheRenders.b;
    cacheBytes = 123;
    await act(async () => { await cacheReaders.a!.refresh(); });
    assert(cacheReaders.a?.state?.bytes === 123 && cacheRenders.b === renders, "cache snapshot broadcast to inactive page");
    await act(async () => { root.render(<><CacheProbe name="a" active /><CacheProbe name="b" active /></>); });
    assert(cacheReaders.b?.state?.bytes === 123, "reactivated cache page missed newest snapshot");
    results.push({ name: "inactive cache readers skip updates and catch up on activation", passed: true });
  } catch (error) { results.push({ name: "inactive cache readers skip updates and catch up on activation", passed: false, error: String(error) }); }
} finally {
  await act(async () => root.unmount()); browser.__TAURI_INTERNALS__ = originalBridge;
  if (storageBefore === null) localStorage.removeItem("hghub_app_v1"); else localStorage.setItem("hghub_app_v1", storageBefore);
}
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length, results });
