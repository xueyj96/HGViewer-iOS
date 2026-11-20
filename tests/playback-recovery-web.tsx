import { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { AppProvider, useStore } from '../src/store';
import '../src/index.css';
import '../src/ios.css';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
let store!: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
const proto = HTMLMediaElement.prototype;
const names = ['src', 'paused', 'readyState', 'currentTime', 'duration', 'play', 'pause', 'load'] as const;
const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(proto, name)]));
const states = new WeakMap<HTMLMediaElement, { src: string; paused: boolean; time: number }>();
const playCalls: HTMLMediaElement[] = [];
const state = (v: HTMLMediaElement) => { let s = states.get(v); if (!s) { s = { src: '', paused: true, time: 0 }; states.set(v, s); } return s; };
Object.defineProperties(proto, {
  src: { configurable: true, get() { return state(this).src; }, set(value) { state(this).src = value; } },
  paused: { configurable: true, get() { return state(this).paused; } },
  readyState: { configurable: true, get() { return 4; } },
  duration: { configurable: true, get() { return 60; } },
  currentTime: { configurable: true, get() { return state(this).time; }, set(value) { state(this).time = value; } },
  play: { configurable: true, value() { state(this).paused = false; playCalls.push(this); this.dispatchEvent(new Event('playing')); return Promise.resolve(); } },
  pause: { configurable: true, value() { state(this).paused = true; this.dispatchEvent(new Event('pause')); } },
  load: { configurable: true, value() {} },
});
const video = { id: 41, title: 'HTML恢复测试', cover: '', tags: [], score: 8, episode_count: 1, total_episodes: 1,
 episodes: [{ ep_num: 1, title: '第一集', duration: 60, status: 1 }], counts: { like: 0, collect: 0, comment: 0, hot: 0 } };
const page = { items: [video], pagination: { page: 1, pages: 1, size: 20, total: 1 } };
let resolves = 0;
const browser = window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
const prior = browser.__TAURI_INTERNALS__;
browser.__TAURI_INTERNALS__ = { invoke: async command => {
 if (command === 'app_boot') return { user: null, strict_security: true };
 if (command === 'settings_symbols') return {};
 if (command === 'api_feed') return page;
 if (command === 'api_video') return video;
 if (command === 'api_play') return { id: 41, ep_num: 1, video_url: `https://fixture.invalid/stream-${++resolves}.mp4` };
 if (command === 'offline_status') return { items: [], jobs: [], shows: {}, recent: [], bytes: 0 };
 if (command === 'line_state') return { base: 'https://fixture.invalid', default: 'https://fixture.invalid', fixed: [] };
 if (command === 'api_rank') return { items: [] };
 if (['api_search', 'api_posts', 'api_category'].includes(command)) return { ...page, items: [] };
 return null;
} };
localStorage.clear();
const root = createRoot(document.querySelector('#fixture')!);
const wait = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); };
const until = async (predicate: () => boolean, label: string) => { for (let n = 0; n < 70 && !predicate(); n++) await wait(); check(predicate(), label); };
const currentVideo = () => [...document.querySelectorAll<HTMLVideoElement>('.hg-feed-video video')].at(-1)!;
try {
 await act(async () => root.render(<AppProvider><Probe /><App /></AppProvider>));
 await until(() => !!currentVideo(), 'home video did not mount');
 await act(async () => store.setTab('profile'));
 await act(async () => store.push({ kind: 'feed', videoIds: [41], index: 0, title: '在线播放' }));
 await until(() => !!currentVideo() && playCalls.includes(currentVideo()), 'context autoplay missing');
 const previous = currentVideo();
 await act(async () => {
   previous.dispatchEvent(new Event('loadedmetadata'));
   previous.currentTime = 24;
   previous.dispatchEvent(new Event('timeupdate'));
   previous.pause();
 });
 const before = resolves, plays = playCalls.length;
 await act(async () => previous.dispatchEvent(new Event('error')));
 await until(() => resolves === before + 1 && currentVideo() !== previous, 'direct media error did not refresh source');
 const refreshed = currentVideo();
 await act(async () => refreshed.dispatchEvent(new Event('loadedmetadata')));
 check(refreshed.paused && playCalls.length === plays, 'paused HTML recovery restarted playback');
 check(refreshed.currentTime === 24, 'HTML recovery lost position');
 results.push({ name: 'paused HTML direct-media failure refreshes once without autoplay and restores progress', passed: true });
 await act(async () => refreshed.dispatchEvent(new Event('error')));
 await wait();
 check(resolves === before + 1 && document.querySelector('[aria-label="视频暂时无法加载"]'), 'HTML recovery looped or lost retry action');
 results.push({ name: 'HTML recovery has a finite budget', passed: true });
} catch (error) { results.push({ name: 'HTML recovery integration', passed: false, error: String(error) }); }
finally {
 await act(async () => root.unmount()); browser.__TAURI_INTERNALS__ = prior;
 for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(proto, name, descriptor); else delete (proto as unknown as Record<string, unknown>)[name]; }
 document.querySelector('#results')!.textContent = JSON.stringify({ passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length, results });
}
