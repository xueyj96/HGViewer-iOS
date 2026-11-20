import { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { preloadIOSPlayback } from '../src/components/IOSVideoSurface';
import { AppProvider, useStore } from '../src/store';
import '../src/index.css';
import '../src/ios.css';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
let store!: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
const video = { id: 41, title: '恢复测试', cover: '', tags: [], score: 8, episode_count: 1, total_episodes: 1,
  episodes: [{ ep_num: 1, title: '第一集', duration: 60, status: 1 }], counts: { like: 0, collect: 0, comment: 0, hot: 0 } };
const page = { items: [video], pagination: { page: 1, pages: 1, size: 20, total: 1 } };
type Native = { time: number; playing: boolean; failed: boolean; frameMissing?: boolean; seekCannotRestore?: boolean };
let resolves = 0, failNextOpens = 0, firstPosition = 24, mountKey = 0;
let holdResolution = false, finishResolution: (() => void) | undefined;
let holdFirstFrame = false;
let holdDetail = false, finishDetail: (() => void) | undefined;
const listCover = "https://fixture.invalid/list-cover.jpg";
let finishPreload: (() => void) | undefined;
let countPreloads = 0, joinNativePreload = false, includeAdjacent = false;
let pendingNativePreload: Promise<void> | undefined;
const startupSamples: string[] = [];
const requested: [number, number][] = [];
const segmentPreloads: [number, number][] = [];
const standbyCandidates: [number, number][] = [];
const sessions = new Map<number, Native>();
const opens: { token: number; source: { kind: string; url?: string } }[] = [];
const controls: { token: number; action: string; value?: number }[] = [];
const browser = window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
const prior = browser.__TAURI_INTERNALS__;
browser.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
  if (command === 'app_boot') return { user: null, strict_security: true };
  if (command === 'settings_symbols') return {};
  if (command === 'api_feed') {
    const card = holdDetail ? { ...video, cover: listCover } : video;
    return { ...page, items: includeAdjacent ? [card, { ...card, id: 42 }] : [card] };
  }
  if (command === 'api_video') {
    if (holdDetail) await new Promise<void>(resolve => { finishDetail = resolve; });
    return includeAdjacent
      ? { ...video, episodes: [...video.episodes, { ...video.episodes[0], ep_num: 2 }] } : video;
  }
  if (command === 'api_play') {
    const generation = ++resolves;
    requested.push([Number(args.id), Number(args.ep)]);
    if (holdResolution) await new Promise<void>(resolve => { finishResolution = resolve; });
    return { id: 41, ep_num: 1, video_url: `https://fixture.invalid/stream-${generation}.m3u8` };
  }
  if (command === 'watch_begin') return resolves;
  if (command === 'offline_status') return { items: [], jobs: [], shows: {}, recent: [], bytes: 0 };
  if (command === 'offline_download_settings') return { limit: 4, segments: 4, allow_background: false };
  if (command === 'line_state') return { base: 'https://fixture.invalid', default: 'https://fixture.invalid', fixed: [] };
  if (command === 'debug_log' && String(args.msg).startsWith('[playback-startup] ')) {
    startupSamples.push(String(args.msg));
  }
  if (command === 'ios_player_preload') {
    if (args.prefetchSegment) {
      const { url } = args.source as { url: string };
      const generation = Number(url.match(/stream-(\d+)\.m3u8$/)?.[1]);
      if (generation > 0) {
        segmentPreloads.push(requested[generation - 1]);
        if (args.prepareStandby) standbyCandidates.push(requested[generation - 1]);
      }
    }
    if (holdResolution) {
      countPreloads++;
      pendingNativePreload = new Promise<void>(resolve => { finishPreload = resolve; });
      await pendingNativePreload;
    }
    return;
  }
  if (command === 'ios_player_open') {
    const token = Number(args.token);
    const failed = failNextOpens-- > 0;
    failNextOpens = Math.max(0, failNextOpens);
    sessions.set(token, { time: opens.length ? 0 : firstPosition, playing: false, failed, frameMissing: holdFirstFrame });
    opens.push({ token, source: args.source as { kind: string; url?: string } });
    const joined = joinNativePreload && pendingNativePreload;
    if (joined) await joined;
    return { levels: [], warm_input: !!joined, input_ms: 4,
      preload_join_ms: joined ? 3 : null, manifest_ms: 2 };
  }
  if (command === 'ios_player_control') {
    const token = Number(args.token), action = String(args.action), state = sessions.get(token);
    controls.push({ token, action, value: Number(args.value) });
    if (state) {
      if (action === 'play') state.playing = true;
      if (action === 'pause') state.playing = false;
      if (action === 'seek') {
        state.time = Number(args.value);
        if (!state.seekCannotRestore) state.frameMissing = false;
      }
    }
    return { time: state?.time ?? 0, duration: 60, width: 1080, height: 1920,
      status: state?.failed ? -1 : state?.playing ? (holdFirstFrame && state.frameMissing ? 3 : 2) : 1, ready: state?.failed || state?.frameMissing ? 0 : 1, app_state: 0,
      first_hls_media_response: joinNativePreload ? { requestMs: 7, bytes: 8000,
        watch: { queueMs: 0, cacheLookupMs: 1, upstreamReadMs: 4, recordMs: 2, cacheHit: false, prefetchHit: false,
          network: { queueMs: 1, attempts: 1, responseHeadersMs: 1, firstBodyByteMs: 1, remainingBodyMs: 1 } } } : undefined,
      native_elapsed_ms: 25, item_ready_ms: 10, layer_ready_ms: 20, warm_asset: joinNativePreload ? 2 : 0, standby_hit: joinNativePreload ? 1 : 0 };
  }
  if (['api_search', 'api_posts', 'api_category'].includes(command)) return { ...page, items: [] };
  if (command === 'api_rank') return { type: args.kind, items: [] };
  return null;
} };
const root = createRoot(document.querySelector('#fixture')!);
const wait = async (ms: number) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
const until = async (predicate: () => boolean, label: string) => {
  for (let count = 0; count < 70 && !predicate(); count++) await wait(50);
  check(predicate(), label);
};
const latestOpen = () => opens.at(-1)!;
const failCurrent = () => { sessions.get(latestOpen().token)!.failed = true; failNextOpens = 1; };
const fresh = async (context: boolean, pending = false) => {
  holdResolution = false; finishResolution = undefined; resolves = 0; failNextOpens = 0; opens.length = 0; controls.length = 0; sessions.clear();
  holdResolution = pending;
  finishPreload = undefined; countPreloads = 0; pendingNativePreload = undefined; joinNativePreload = false; requested.length = 0; segmentPreloads.length = 0; standbyCandidates.length = 0; startupSamples.length = 0;
  localStorage.clear();
  await act(async () => root.render(<AppProvider key={++mountKey}><Probe /><App /></AppProvider>));
  if (pending) return;
  await until(() => opens.length > 0, 'initial source did not open');
  if (context) {
    await act(async () => store.setTab('profile'));
    await act(async () => store.push({ kind: 'feed', videoIds: includeAdjacent ? [41, 42] : [41], index: 0, title: '在线播放' }));
    await until(() => opens.length > 1, 'context source did not open');
    sessions.get(latestOpen().token)!.time = firstPosition;
  }
  await wait(300);
};
const visibility = async (hidden: boolean) => {
  await act(async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const tapPicture = async (target: Element, pointerId: number, downOnly = false) => {
  await act(async () => {
    const args = { bubbles: true, pointerId, isPrimary: true, pointerType: 'touch', button: 0, clientX: 170, clientY: 400 };
    target.dispatchEvent(new PointerEvent('pointerdown', args));
    if (!downOnly) target.dispatchEvent(new PointerEvent('pointerup', args));
  });
};
const run = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
};
try {
  for (const playing of [false, true]) await run(`fresh online address restores progress and ${playing ? 'playing' : 'paused'} intent with fixed chrome`, async () => {
    await fresh(playing);
    const before = resolves, originalURL = latestOpen().source.url;
    const top = document.querySelector('.hg-ios-top-bar'), bottom = document.querySelector('.hg-tabbar');
    failCurrent();
    await until(() => resolves === before + 1 && opens.at(-1)?.source.url !== originalURL, 'failed source was not re-resolved exactly once');
    await until(() => controls.some(x => x.token === latestOpen().token && x.action === 'seek' && x.value === firstPosition), 'recovery lost position');
    check(sessions.get(latestOpen().token)?.playing === playing, 'recovery changed playback intent');
    check(top === document.querySelector('.hg-ios-top-bar') && bottom === document.querySelector('.hg-tabbar'), 'recovery replaced fixed chrome');
    const resolved = resolves;
    failCurrent();
    await until(() => !!document.querySelector('[aria-label="视频暂时无法加载"]'), 'exhausted recovery has no retry action');
    await wait(350);
    check(resolves === resolved, 'automatic recovery entered a source-request loop');
  });
  await run('paused online and cached playback restore the foreground frame at the saved position', async () => {
    for (const cached of [false, true]) {
      await fresh(false);
      if (cached) {
        await act(async () => store.setTab('profile'));
        await act(async () => store.push({ kind: 'feed', videoIds: [41], index: 0, title: '缓存',
          offlineItems: [{ id: 41, ep: 1, title: '缓存剧集', bytes: 10, mp4: true }] }));
        await until(() => latestOpen().source.kind === 'offline', 'cache surface did not open');
        const offline = sessions.get(latestOpen().token)!;
        await until(() => offline.playing, 'cache surface never started');
        offline.time = firstPosition;
        await tapPicture(document.querySelector('.hg-feed-video')!, 20);
        await until(() => !offline.playing, 'cache surface did not pause');
        await wait(250);
      }
      const { token } = latestOpen();
      const state = sessions.get(token)!;
      await visibility(true);
      state.frameMissing = true;
      state.time = 0;
      const count = opens.length, before = controls.length;
      await visibility(false);
      await until(() => controls.slice(before).some(x => x.token === token && x.action === 'seek'), 'foreground frame did not recover');
      const foreground = controls.slice(before).filter(x => x.token === token);
      check(foreground.filter(x => x.action === 'seek').length === 1, 'foreground recovery sought more than once');
      check(foreground.some(x => x.action === 'seek' && x.value === firstPosition), 'foreground used reset time instead of saved position');
      check(opens.length === count && !foreground.some(x => x.action === 'play'), 'paused recovery reopened or started playback');
    }
  });
  await run('backgrounding with an unfinished touch releases the gesture for the next tap', async () => {
    await fresh(false);
    const player = sessions.get(latestOpen().token)!;
    const target = document.querySelector('.hg-feed-video')!;
    await tapPicture(target, 21, true);
    await visibility(true);
    await visibility(false);
    await tapPicture(target, 22);
    await until(() => player.playing, 'next tap was swallowed by the old pointer');
  });
  await run('list poster stays visible from timeline entry through native first frame', async () => {
    holdDetail = true;
    holdFirstFrame = true;
    const poster = () => document.querySelector<HTMLElement>('.hg-feed-poster');
    try {
      await fresh(false, true);
      await until(() => !!finishDetail && !!finishResolution && !!poster()?.querySelector('img'), 'list poster waited for detail or source');
      const image = poster()!.querySelector('img')!;
      check(decodeURIComponent(image.src).includes(listCover), 'feed did not use the list cover');
      check(getComputedStyle(poster()!).visibility === 'visible', 'poster hidden before address resolution');
      holdResolution = false;
      await act(async () => finishResolution!());
      await until(() => !!document.querySelector('.hg-native-video'), 'native video did not mount');
      check(poster()?.querySelector('img') === image && getComputedStyle(poster()!).visibility === 'visible', 'poster was replaced before first frame');
      sessions.get(latestOpen().token)!.frameMissing = false;
      await until(() => getComputedStyle(poster()!).visibility === 'hidden', 'poster covered the ready native layer');
    } finally {
      holdDetail = false;
      holdFirstFrame = false;
      finishDetail?.();
      finishDetail = undefined;
      finishResolution?.();
    }
  });
  for (const longWait of [false, true]) await run(`poster delays spinner while first frame waits (${longWait})`, async () => {
    holdDetail = true;
    holdFirstFrame = true;
    const loader = () => document.querySelector<HTMLElement>('.hg-feed-loading');
    try {
      await fresh(false, true);
      await until(() => !!finishDetail && !!finishResolution, 'feed did not start resolving');
      await tapPicture(document.querySelector('.hg-feed-poster')!, 32);
      await until(() => !!loader(), 'tap did not start loading');
      check(getComputedStyle(loader()!).visibility === 'hidden', 'spinner showed immediately over the poster');
      check(getComputedStyle(loader()!).animationDelay === '0.95s', 'poster delay did not apply');
      if (longWait) await until(() => getComputedStyle(loader()!).visibility === 'visible', 'sustained wait lost loading feedback');

      holdResolution = false;
      await act(async () => finishResolution!());
      await until(() => opens.length === 1, 'native playback never opened');
      sessions.get(latestOpen().token)!.frameMissing = false;
      await until(() => !loader(), 'loading indicator stayed after playback recovered');
    } finally {
      holdDetail = false;
      holdFirstFrame = false;
      finishDetail?.();
      finishDetail = undefined;
      finishResolution?.();
    }
  });
  await run('native first frame wakes playback status only for the current token', async () => {
    holdFirstFrame = true;
    try {
      await fresh(false);
      const token = latestOpen().token;
      const polls = () => controls.filter((call) => call.action === 'status' && call.token === token).length;
      check(!document.querySelector('.hg-native-video.is-ready'), 'mock first frame was already visible');
      const before = polls();
      await act(async () => window.dispatchEvent(new CustomEvent('hg-ios-first-frame', { detail: token - 1 })));
      check(polls() === before, 'retired native token woke a status request');
      sessions.get(token)!.frameMissing = false;
      await act(async () => window.dispatchEvent(new CustomEvent('hg-ios-first-frame', { detail: token })));
      check(polls() === before + 1, 'ready event did not immediately wake the native status read');
      check(!!document.querySelector('.hg-native-video.is-ready'), 'ready frame did not replace the poster');
      const line = startupSamples[0];
      check(!!line && JSON.parse(line.slice('[playback-startup] '.length)).nativeFirstFrameWake, 'first frame wake was missing from startup log');
    } finally {
      holdFirstFrame = false;
    }
  });
  await run('a tap on the cover before source resolution reaches the new player', async () => {
    await fresh(false, true);
    await until(() => !!finishResolution, 'initial resolution was not held');
    const cover = document.querySelector('.hg-native-feed-scroll section > div')!;
    await tapPicture(cover, 23);
    await wait(320);
    holdResolution = false;
    await act(async () => finishResolution!());
    await until(() => opens.length > 0 && sessions.get(latestOpen().token)?.playing === true, 'cover tap was lost when the URL arrived');
  });
  await run('persistent foreground frame loss reopens once without unpausing', async () => {
    await fresh(false);
    const oldToken = latestOpen().token, count = opens.length;
    const state = sessions.get(oldToken)!;
    await visibility(true);
    state.frameMissing = true;
    state.seekCannotRestore = true;
    await visibility(false);
    await wait(4800);
    await until(() => opens.length === count + 1, 'failed frame recovery did not reopen');
    const newToken = latestOpen().token;
    await until(() => controls.some(x => x.token === newToken && x.action === 'seek' && x.value === firstPosition), 'reopen did not restore the saved position');
    check(!controls.some(x => x.token === newToken && x.action === 'play'), 'reopen forced paused video to play');
  });
  for (const joins of [true, false]) await run(`foreground lets native code decide whether to join preload (${joins})`, async () => {
    await fresh(false, true);
    joinNativePreload = joins;
    await until(() => !!finishResolution, 'source not pending');
    const source = { kind: 'online' as const, url: 'https://fixture.invalid/stream-1.m3u8', watch_key: 1 };
    const pending = preloadIOSPlayback(source);
    try {
      await until(() => !!finishPreload && countPreloads === 1, 'native preload not pending');
      holdResolution = false;
      await act(async () => finishResolution!());
      await until(() => opens.length === 1, 'foreground open was held in JavaScript');
      if (joins) {
        check(startupSamples.length === 0, 'player reported readiness before native open completed');
        await act(async () => finishPreload!());
      }
      await until(() => startupSamples.length === 1, 'player did not report its first frame');
      const line = startupSamples[0];
      const timing = JSON.parse(line.slice('[playback-startup] '.length));
      check(timing.nativeWarmInput === joins && timing.nativeInputMs === 4, 'warm or cold path not recorded');
      check(timing.nativePreloadJoinMs === (joins ? 3 : undefined) && timing.hlsManifestMs === 2, 'native preparation breakdown missing');
      check(timing.nativeWarmAsset === (joins ? 'loaded' : 'none'), 'AVAsset warm state missing');
      check(timing.nativeStandbyHit === joins, 'standby adoption missing from timing');
      check(timing.nativeItemReadyMs === 10 && timing.nativeLayerReadyMs === 20 && timing.nativeReadyToStatusMs === 5, 'first frame phases missing');
      check(timing.firstHlsMediaResponseMs === (joins ? 7 : undefined), 'first HLS media response missing');
      if (joins) check(timing.firstHlsMediaResponseBytes === 8000 && timing.firstHlsMediaUpstreamReadMs === 4 &&
        timing.firstHlsMediaRecordMs === 2 && timing.firstHlsMediaQueueMs === 0 && timing.firstHlsMediaCacheHit === false && timing.firstHlsMediaPrefetchHit === false,
        'first HLS media phases missing');
      if (joins) check(timing.firstHlsMediaNetworkQueueMs === 1 && timing.firstHlsMediaNetworkAttempts === 1 &&
        timing.firstHlsMediaResponseHeadersMs === 1 && timing.firstHlsMediaFirstBodyByteMs === 1 &&
        timing.firstHlsMediaRemainingBodyMs === 1, 'upstream phase timings missing');
      check(timing.selectionToFrameMs >= timing.openMs && timing.source === 'fresh', 'selection timing missing');
      check(!line.includes('fixture.invalid') && !line.includes('watch_key'), 'sample includes media address or watch key');
    } finally {
      finishPreload?.();
      await pending;
    }
  });
  for (const context of [false, true]) await run(`both forward candidates request a segment in entry-point order (${context})`, async () => {
    includeAdjacent = true;
    try {
      await fresh(context);
      if (!context) await tapPicture(document.querySelector('.hg-feed-video')!, 24);
      await until(() => segmentPreloads.length >= 2, 'forward segment candidates did not reach native code');
      const ordered = segmentPreloads.slice(0, 2).map((candidate) => candidate.join(':')).join(',');
      check(ordered === (context ? '41:2,42:1' : '42:1,41:2'), `wrong segment candidates: ${ordered}`);
      check(standbyCandidates.map((candidate) => candidate.join(':')).join(',') === ordered,
        'both forward candidates must request a standby player in entry-point order');
    } finally { includeAdjacent = false; }
  });
  await run('a recovery response completing after navigation cannot reopen the old player', async () => {
    await fresh(true);
    const before = resolves; holdResolution = true; failCurrent();
    await until(() => !!finishResolution && resolves === before + 1, 'refresh request was not held');
    await act(async () => store.setTab('profile'));
    await wait(100); const count = opens.length;
    holdResolution = false;
    await act(async () => finishResolution!());
    await wait(350);
    check(opens.length === count, 'retired refresh reopened player after navigation');
  });
} finally {
  delete (document as { hidden?: boolean }).hidden;
  await act(async () => root.unmount()); browser.__TAURI_INTERNALS__ = prior;
  document.querySelector('#results')!.textContent = JSON.stringify({ passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length, results });
}
