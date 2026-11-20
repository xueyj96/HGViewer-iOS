import { act } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { AppProvider, useStore } from "../src/store";
import { getCoverMenu, runCoverMenuAction } from "../src/components/IOSCoverMenu";
import "../src/index.css";
import "../src/ios.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
declare global { interface Window {
  __tapAt?: (x: number, y: number) => Promise<void>;
  __authorViewport?: (width: number, height: number) => Promise<void>;
} }
const results: { name: string; passed: boolean; error?: string }[] = [];
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
let store!: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
const pagination = { page: 1, pages: 1, size: 20, total: 1 };
const video = { id: 41, title: "剧集测试", cover: "", tags: [], score: 8, episode_count: 1, total_episodes: 1,
  author: { id: 7, name: "本地作者" }, episodes: [{ ep_num: 1, title: "第一集", duration: 60, status: 1 }],
  counts: { like: 0, collect: 0, comment: 0, hot: 0 } };
const calls: string[] = [];
let savedAuthor = true;
let refreshFails = false;
let libraryHasSaved = false;
let libraryMissingShow = false;
let slowRefresh = false;
let finishRefresh: (() => void) | undefined;
let mergeScenario = false;
let completedThirdEpisode = false;
let omitStatusAuthor = false;
const deletedEpisodes = new Set<number>();
const deletions: Record<string, unknown>[] = [];
let deferDelete = false;
let finishDelete: (() => void) | undefined;
const cachedItems = () => (mergeScenario ? completedThirdEpisode ? [1, 2, 3] : [1, 2] : [1])
  .filter(ep => !deletedEpisodes.has(ep))
  .map(ep => ({ id: 41, ep, title: "缓存剧集", bytes: 10, mp4: true }));
const nativeOpens: Record<string, unknown>[] = [];
const downloads: Record<string, unknown>[] = [];
const browser = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
const previous = browser.__TAURI_INTERNALS__;
browser.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
  calls.push(command);
  if (command === "app_boot") return { user: null, strict_security: true };
  if (command === "settings_symbols") return {};
  if (command === "api_feed") return { items: [video], pagination };
  if (command === "api_video") return video;
  if (command === "api_play") return { id: 41, ep_num: 1, video_url: "https://fixture.invalid/media.m3u8" };
  if (command === "api_author") return { id: 7, nickname: "本地作者", counts: { video: 1, follower: 10 } };
  if (command === "api_author_videos") return { items: [video], pagination };
  if (command === "offline_show") return libraryMissingShow ? null : { episodes: mergeScenario ? [1, 2, 3] : [1], cover: false, ...(savedAuthor ? { author: video.author } : {}) };
  if (command === "offline_refresh_show") {
    if (refreshFails) throw "离线";
    if (slowRefresh) await new Promise<void>(resolve => { finishRefresh = resolve; });
    savedAuthor = true; libraryMissingShow = false; return null;
  }
  if (command === "offline_status") return {
    items: libraryHasSaved ? cachedItems() : [], jobs: [],
    shows: libraryHasSaved && !libraryMissingShow ? { 41: { episodes: mergeScenario ? [1, 2, 3] : [1], cover: false,
      ...(savedAuthor && !omitStatusAuthor ? { author: video.author } : {}) } } : {}, recent: [], bytes: libraryHasSaved ? cachedItems().length * 10 : 0,
  };
  if (command === "offline_download_settings") return { limit: 4, segments: 4, allow_background: false, background_supported: true };
  if (command === "watch_begin") return 1;
  if (command === "ios_player_open") { nativeOpens.push(args); return { levels: [], warm_input: false, input_ms: 4 }; }
  if (command === "offline_delete") {
    deletions.push(args);
    if (deferDelete) await new Promise<void>(resolve => { finishDelete = resolve; });
    if (args.ep == null) for (const ep of [1, 2, 3]) deletedEpisodes.add(ep);
    else deletedEpisodes.add(Number(args.ep));
    return null;
  }
  if (command === "offline_start") { downloads.push(args); if (mergeScenario && args.ep === 3) completedThirdEpisode = true; return null; }
  if (command === "ios_player_control") return { time: 0, duration: 60, width: 1080, height: 1920, status: 1, ready: 1, app_state: 0 };
  if (command === "line_state") return { base: "https://fixture.invalid", default: "https://fixture.invalid", fixed: [] };
  if (["api_search", "api_posts", "api_category"].includes(command)) return { items: [], pagination };
  if (command === "api_rank") return { type: args.kind, items: [] };
  return null;
} };
const root = createRoot(document.querySelector("#fixture")!);
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 360)); }); };
const liveButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
  .find(button => !button.disabled && !button.closest('[inert], [aria-hidden="true"]'))!;
const tap = async (button: HTMLElement) => {
  check(button, "button missing");
  const rect = button.getBoundingClientRect();
  check(window.__tapAt, "real touch runner not connected");
  await act(async () => { await window.__tapAt!(rect.x + rect.width / 2, rect.y + rect.height / 2); });
  await tick();
};
const confirmEpisodeDelete = async (ep: number) => {
  const card = liveButton(`播放第 ${ep} 集，已缓存`);
  check(card, "cached episode delete target missing");
  const menu = getCoverMenu(card);
  check(menu?.items.some(item => item.action === "delete-episode"), "episode menu ownership missing");
  await act(async () => runCoverMenuAction(menu!, "delete-episode"));
  await tick();
  await tap(liveButton("删除缓存"));
};
const run = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
};
const authorRegion = () => document.querySelector<HTMLElement>('[role="region"][aria-label="作者作品"]')!;
function verifyPaintOrder() {
  const author = authorRegion();
  const card = author.querySelector<HTMLElement>('[data-hg-menu-card="41"]')!;
  check(card, "author works grid absent");
  const rect = card.getBoundingClientRect();
  // inert disables hits, not painting. Temporarily include dormant layers in hit testing to inspect their paint order.
  const inert = [...document.querySelectorAll<HTMLElement>(".hg-ios-page-layer [inert]")];
  inert.forEach(element => { element.inert = false; });
  try {
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 70));
    check(hit && author.contains(hit), "old detail sheet paints over the author works");
  } finally { inert.forEach(element => { element.inert = true; }); }
}
try {
  await act(async () => root.render(<AppProvider><Probe /><App /></AppProvider>));
  await tick();
  const top = document.querySelector(".hg-ios-top-bar"), bottom = document.querySelector(".hg-tabbar");
  let detail!: HTMLElement;
  await run("home detail touch opens visibly painted author works above the retained sheet", async () => {
    await tap(liveButton("剧集详情"));
    detail = document.querySelector<HTMLElement>('[role="dialog"][aria-label="剧集详情与选集"]')!;
    await tap(liveButton("查看作者 本地作者 的全部作品"));
    check(store.stack.at(-1)?.kind === "author", "author route missing");
    verifyPaintOrder();
    check(detail.isConnected && detail.closest("[inert]"), "original detail not retained beneath the route");
    check(top === document.querySelector(".hg-ios-top-bar") && bottom === document.querySelector(".hg-tabbar"), "fixed bars replaced");
  });
  await run("author back restores the same detail and a second touch entry remains visible", async () => {
    await tap(liveButton("返回"));
    check(detail.isConnected && !detail.closest("[inert]"), "detail state lost on author back");
    await tap(liveButton("查看作者 本地作者 的全部作品"));
    verifyPaintOrder();
    await tap(liveButton("返回"));
  });
  await run("paint-order check detects the old inert-sheet occlusion instead of trusting DOM presence", async () => {
    await tap(liveButton("查看作者 本地作者 的全部作品"));
    const workspace = document.querySelector<HTMLElement>('[data-workspace-tab="home"]')!;
    const before = workspace.style.isolation;
    let detected = false;
    workspace.style.isolation = "auto";
    try { verifyPaintOrder(); } catch { detected = true; }
    finally { workspace.style.isolation = before; }
    check(detected, "paint-order check misses the original visible overlay");
    verifyPaintOrder();
    await tap(liveButton("返回"));
  });
  await run("author works stay above the retained sheet through landscape and portrait relayout", async () => {
    await tap(liveButton("查看作者 本地作者 的全部作品"));
    check(window.__authorViewport, "viewport runner missing");
    await window.__authorViewport!(844, 390); await tick(); verifyPaintOrder();
    await window.__authorViewport!(390, 844); await tick(); verifyPaintOrder();
    check(top === document.querySelector(".hg-ios-top-bar") && bottom === document.querySelector(".hg-tabbar"), "rotation replaces fixed bars");
    await tap(liveButton("返回"));
  });
  await run("returning before a metadata refresh completes joins it and displays the saved author", async () => {
    savedAuthor = false; slowRefresh = true; libraryHasSaved = true;
    await act(async () => store.setTab("profile"));
    const before = calls.length;
    await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: [{ id: 41, ep: 1, title: "缓存剧集", bytes: 10, mp4: true }] }));
    await tick();
    check(finishRefresh, "deferred metadata refresh not started");
    await act(async () => store.push({ kind: "settings" }));
    await act(async () => store.pop());
    await tick();
    await act(async () => finishRefresh!());
    slowRefresh = false; await tick();
    await tap(liveButton("剧集详情"));
    check(liveButton("查看作者 本地作者 的全部作品"), "reactivated page missed completed author metadata");
    check(calls.slice(before).filter(command => command === "offline_refresh_show").length === 1, "reactivation repeated the network refresh");
  });
  for (const legacy of [false, true]) {
    await run(`${legacy ? "legacy" : "saved"} cached playback details show the persisted author and open their page`, async () => {
      savedAuthor = !legacy; libraryHasSaved = true;
      await act(async () => store.setTab("profile"));
      const before = calls.length;
      await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: [{ id: 41, ep: 1, title: "缓存剧集", bytes: 10, mp4: true }] }));
      await tick();
      await tap(liveButton("剧集详情"));
      check(liveButton("查看作者 本地作者 的全部作品"), "cached author missing");
      check(calls.slice(before).filter(command => command === "offline_refresh_show").length === (legacy ? 1 : 0), "unnecessary or repeated metadata refresh");
      await tap(liveButton("查看作者 本地作者 的全部作品"));
      verifyPaintOrder();
    });
  }
  let merged!: HTMLElement;
  let feedRoute!: typeof store.stack[number];
  let feedDepth = 0;
  await run("cached detail directly exposes shared offline management without another navigation button", async () => {
    mergeScenario = true; completedThirdEpisode = false; libraryHasSaved = true; savedAuthor = true; libraryMissingShow = false;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: cachedItems(), startEp: 1 }));
    await tick();
    feedRoute = store.stack.at(-1)!; feedDepth = store.stack.length;
    await tap(liveButton("剧集详情"));
    merged = document.querySelector<HTMLElement>('[role="dialog"][aria-label="离线剧集"]')!;
    check(merged?.querySelector('[data-hg-offline-show="41"]'), "offline details did not reuse management content");
    check(merged.querySelector('[aria-label="缓存信息"]') && merged.querySelector('[aria-label="分集"]'), "summary or managed episode grid missing");
    for (const label of ["刷新剧集", "缓存剩余", "清空缓存"]) check([...merged.querySelectorAll("button")].some(button => button.textContent?.trim() === label), `${label} missing`);
    check(!liveButton("缓存管理"), "old duplicate management navigation still exposed");
    check(store.stack.at(-1) === feedRoute && store.stack.length === feedDepth, "opening detail pushed a separate management route");
    check(top === document.querySelector(".hg-ios-top-bar") && bottom === document.querySelector(".hg-tabbar"), "merged detail replaced fixed chrome");
  });
  await run("merged offline detail cancellation preserves cache, author return preserves page and bars", async () => {
    const clear = [...merged.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "清空缓存")!;
    await tap(clear);
    check(liveButton("取消删除"), "cache deletion confirmation missing");
    const before = calls.filter(command => command === "offline_delete").length;
    await tap(liveButton("取消删除"));
    check(calls.filter(command => command === "offline_delete").length === before && merged.querySelector('[aria-label="播放第 1 集，已缓存"]'), "cancel deleted a cached episode");
    await tap(liveButton("查看作者 本地作者 的全部作品"));
    verifyPaintOrder();
    await tap(liveButton("返回"));
    check(merged.isConnected && !merged.closest("[inert]"), "author return replaced or lost merged detail");
    check(top === document.querySelector(".hg-ios-top-bar") && bottom === document.querySelector(".hg-tabbar"), "author return replaced fixed chrome");
  });
  await run("merged detail does not poll or accept stale work while another route is active", async () => {
    await act(async () => store.push({ kind: "settings" })); await tick();
    const reads = calls.filter(command => command === "offline_status").length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1950)); });
    check(calls.filter(command => command === "offline_status").length === reads, "hidden merged detail retained a cache poller");
    await act(async () => store.pop()); await tick();
    check(merged.isConnected && !merged.closest("[inert]"), "rapid route return lost merged detail");
  });
  await run("newly completed cached episode updates the existing player without a duplicate feed route", async () => {
    const before = downloads.length;
    await tap(liveButton("缓存第 3 集，未缓存"));
    check(downloads.length === before + 1 && downloads.at(-1)?.id === 41 && downloads.at(-1)?.ep === 3, "missing episode was not enqueued exactly once");
    await tap(liveButton("播放第 3 集，已缓存"));
    check(store.stack.length === feedDepth && store.stack.at(-1) === feedRoute, "picking a freshly downloaded episode pushed another player");
    check(nativeOpens.some(args => { const source = args.source as { kind?: string; id?: number; ep?: number }; return source?.kind === "offline" && source.id === 41 && source.ep === 3; }), "current player did not load newly completed episode");
    check(!document.querySelector('[role="dialog"][aria-label="离线剧集"]'), "managed episode selection did not return to playback");
  });
  await run("quick cached episode picker remains lightweight and switches within the same player", async () => {
    await tap(liveButton("选集"));
    const picker = document.querySelector<HTMLElement>('[role="dialog"][aria-label="已缓存分集"]')!;
    check(picker, "quick episode picker missing");
    check(!picker.querySelector('[data-hg-offline-show]') && !picker.querySelector('[aria-label="缓存操作"]'), "quick picker contains download management");
    const second = [...picker.querySelectorAll<HTMLButtonElement>(".hg-ios-episode-button")].find(button => button.textContent?.trim() === "2")!;
    await tap(second);
    check(store.stack.length === feedDepth && store.stack.at(-1) === feedRoute, "quick picker pushed another player");
    check(nativeOpens.some(args => { const source = args.source as { kind?: string; id?: number; ep?: number }; return source?.kind === "offline" && source.id === 41 && source.ep === 2; }), "quick picker did not load requested cached episode");
    check(top === document.querySelector(".hg-ios-top-bar") && bottom === document.querySelector(".hg-tabbar"), "quick picker replaced fixed bars");
  });
  await run("confirmed deletion of another original episode keeps the current player and refreshes quick selection", async () => {
    await tap(liveButton("剧集详情"));
    const currentDetail = document.querySelector<HTMLElement>('[role="dialog"][aria-label="离线剧集"]')!;
    const before = deletions.length;
    await confirmEpisodeDelete(1);
    check(deletions.length === before + 1 && deletions.at(-1)?.id === 41 && deletions.at(-1)?.ep === 1, "episode deletion did not reach native once");
    check(store.stack.length === feedDepth && store.stack.at(-1) === feedRoute && currentDetail.isConnected, "deleting another episode closed the current player");
    check(liveButton("缓存第 1 集，未缓存"), "deleted episode still shown cached");
    await tap(liveButton("返回"));
    await tap(liveButton("选集"));
    const picker = document.querySelector<HTMLElement>('[role="dialog"][aria-label="已缓存分集"]')!;
    check([...picker.querySelectorAll(".hg-ios-episode-button")].map(button => button.textContent?.trim()).sort().join() === "2,3", "quick selection retained deleted episode");
    const third = [...picker.querySelectorAll<HTMLButtonElement>(".hg-ios-episode-button")].find(button => button.textContent?.trim() === "3")!;
    await tap(third);
  });
  await run("confirmed deletion of the current newly completed episode closes its player safely", async () => {
    check(feedRoute.kind === "feed" && !feedRoute.offlineItems?.some(item => item.ep === 3), "fixture route unexpectedly already contained the newly completed episode");
    await tap(liveButton("剧集详情"));
    await confirmEpisodeDelete(3);
    check(deletions.at(-1)?.ep === 3 && !store.stack.includes(feedRoute) && store.stack.length === feedDepth - 1, "current new episode deletion left a player pointing at a removed file");
    check(!document.querySelector('[role="dialog"][aria-label="离线剧集"]'), "removed player retained its merged detail");
  });
  await run("clearing all cached episodes from inline details closes the current player", async () => {
    deletedEpisodes.clear(); completedThirdEpisode = false;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: cachedItems(), startEp: 1 }));
    await tick();
    const route = store.stack.at(-1)!;
    await tap(liveButton("剧集详情"));
    const currentDetail = document.querySelector<HTMLElement>('[role="dialog"][aria-label="离线剧集"]')!;
    await tap([...currentDetail.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "清空缓存")!);
    await tap(liveButton("删除缓存"));
    check(deletions.at(-1)?.ep == null && !store.stack.includes(route), "clear-all left its cached player open");
  });
  await run("standalone management remains after confirmed cache clear", async () => {
    deletedEpisodes.clear(); completedThirdEpisode = false;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "offline", id: 41, title: "缓存剧集" }));
    await tick();
    const route = store.stack.at(-1)!;
    const body = document.querySelector<HTMLElement>('[data-hg-offline-show="41"]')!;
    await tap([...body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "清空缓存")!);
    await tap(liveButton("删除缓存"));
    check(store.stack.at(-1) === route && body.isConnected && !cachedItems().length, "standalone clear navigated away or retained cache");
  });
  await run("pending deletion checks the actual episode after a quick switch before native completion", async () => {
    deletedEpisodes.clear(); completedThirdEpisode = false;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: cachedItems(), startEp: 1 }));
    await tick();
    const route = store.stack.at(-1)!;
    await tap(liveButton("剧集详情"));
    deferDelete = true; finishDelete = undefined;
    try {
      await confirmEpisodeDelete(2);
      check(finishDelete, "native deletion did not enter deferred boundary");
      await tap(liveButton("返回"));
      await tap(liveButton("选集"));
      const picker = document.querySelector<HTMLElement>('[role="dialog"][aria-label="已缓存分集"]')!;
      const second = [...picker.querySelectorAll<HTMLButtonElement>(".hg-ios-episode-button")].find(button => button.textContent?.trim() === "2")!;
      await tap(second);
      check(store.stack.includes(route), "player closed before native delete completed");
      await act(async () => finishDelete!());
      await tick();
      check(!store.stack.includes(route) && deletedEpisodes.has(2), "pending delete used the old playing episode and retained a removed current file");
    } finally {
      deferDelete = false;
      if (finishDelete) { await act(async () => finishDelete!()); await tick(); }
    }
  });
  await run("pending whole-show deletion retires its multi-show route after the live player moves to another show", async () => {
    deletedEpisodes.clear(); completedThirdEpisode = false;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "feed", videoIds: [41, 42], index: 0, title: "缓存",
      offlineItems: [...cachedItems(), { id: 42, ep: 1, title: "另一部缓存", bytes: 10, mp4: true }], startEp: 1 }));
    await tick();
    const route = store.stack.at(-1)!;
    let currentPlayer = { key: route.key, id: 41, ep: 1 };
    deferDelete = true; finishDelete = undefined;
    let deletion: Promise<void> | undefined;
    try {
      await act(async () => { deletion = store.deleteOffline(41, undefined, () => currentPlayer); });
      await tick();
      check(finishDelete && store.stack.includes(route), "native deletion was not held while the multi-show route remained active");
      // Exercise the Store contract with a controlled live getter; no vertical gesture is simulated here.
      currentPlayer = { key: route.key, id: 42, ep: 1 };
      await act(async () => { finishDelete!(); await deletion; });
      await tick();
      check(!store.stack.includes(route), "multi-show route retained deleted show IDs after playback moved to a different show");
    } finally {
      deferDelete = false;
      if (finishDelete) { await act(async () => { finishDelete!(); await deletion; }); await tick(); }
    }
  });
  await run("resolved playback author survives a legacy status record without author metadata", async () => {
    deletedEpisodes.clear(); omitStatusAuthor = true; savedAuthor = true; libraryMissingShow = false;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: cachedItems(), startEp: 1 }));
    await tick(); await tap(liveButton("剧集详情"));
    check(liveButton("查看作者 本地作者 的全部作品"), "legacy status shadowed the resolved playback author");
    omitStatusAuthor = false;
  });
  deletedEpisodes.clear();
  mergeScenario = false;
  await run("cache management missing show metadata has one automatic refresh owner", async () => {
    libraryHasSaved = true; libraryMissingShow = true; savedAuthor = false;
    await act(async () => store.setTab("profile"));
    const before = calls.length;
    await act(async () => store.push({ kind: "offline", id: 41, title: "缓存剧集" }));
    await tick();
    check(calls.slice(before).filter(command => command === "offline_refresh_show").length === 1, "missing show refresh was duplicated");
    check(liveButton("查看作者 本地作者 的全部作品"), "refreshed author not rendered");
    check(calls.slice(before).filter(command => command === "offline_status").length >= 2, "updated show did not refresh the cache status");
    libraryHasSaved = false;
  });
  await run("cache management uses the same persisted author entry", async () => {
    libraryHasSaved = true; savedAuthor = true;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "offline", id: 41, title: "缓存剧集" }));
    await tick();
    await tap(liveButton("查看作者 本地作者 的全部作品"));
    verifyPaintOrder();
    libraryHasSaved = false;
  });
  await run("offline metadata miss does not invent an author or block cached playback", async () => {
    savedAuthor = false; refreshFails = true; libraryHasSaved = true; libraryMissingShow = true;
    await act(async () => store.setTab("profile"));
    await act(async () => store.push({ kind: "feed", videoIds: [41], index: 0, title: "缓存", offlineItems: [{ id: 41, ep: 1, title: "缓存剧集", bytes: 10, mp4: true }] }));
    await tick(); await tap(liveButton("剧集详情"));
    check(!liveButton("查看作者 本地作者 的全部作品"), "invented cached author");
    check(document.querySelector('[aria-label="缓存信息"]'), "cached details blocked by metadata failure");
  });
} finally {
  await act(async () => root.unmount()); browser.__TAURI_INTERNALS__ = previous;
}
document.querySelector("#results")!.textContent = JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results }, null, 2);
