import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform, type OfflineEpisode } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import { DEFAULT_PLAYBACK_SIDEBAR, normalizePlaybackSidebar, type PlaybackSidebarItem } from "./playbackSidebar";
import type { User } from "./types";

export type Platform = typeof envPlatform;
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  videoIds: number[];
  index: number;
  title: string;
  source?: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
  offlineItems?: OfflineEpisode[];
  offlineCoverIds?: number[];
};

export type PageInput =
  | FeedContext
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings" }
  | { kind: "offline"; id?: number; title?: string; episodes?: number[] }
  | { kind: "recent-cache" }
  | { kind: "posts" }
  | { kind: "post"; id: number; postIds?: number[]; nextPostPage?: number };

export type Page = PageInput & { key: string };

export type ToastAction = { label: string; run: () => void; scope?: "history" };
export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info"; action?: ToastAction };

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  volume: number;
  searchHist: string[];
  playbackSidebar: PlaybackSidebarItem[];
};

const LS = "hghub_app_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, volume: 0.7, searchHist: [], playbackSidebar: DEFAULT_PLAYBACK_SIDEBAR,
};

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULTS;
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    return { ...p, history: normalizeHistory(p.history), playbackSidebar: normalizePlaybackSidebar(p.playbackSidebar) };
  } catch {
    return DEFAULTS;
  }
}

const LIGHT_APPEARANCE = "(prefers-color-scheme: light)";

function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem("hghub_theme");
    return saved === "light" || saved === "system" ? saved : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  platform: Platform;
  theme: Theme; themePreference: ThemePreference; setTheme: (t: ThemePreference) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  deleteOffline: (id: number, episode?: number) => Promise<void>;
  lineRevision: number; onLineChanged: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  setFavLocal: (id: number, on: boolean, index?: number) => void;
  syncFavorite: (id: number, on: boolean, kind?: "video" | "post") => Promise<void>;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  removeHistory: (id: number) => void;
  restoreHistory: (entry: WatchProgress) => void;
  clearHistory: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  playbackSidebar: PlaybackSidebarItem[];
  setPlaybackSidebar: (update: (items: PlaybackSidebarItem[]) => PlaybackSidebarItem[]) => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"], action?: ToastAction) => void;
  dismissToast: (id: number) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [systemLight, setSystemLight] = useState(() => window.matchMedia(LIGHT_APPEARANCE).matches);
  const theme: Theme = themePreference === "system" ? (systemLight ? "light" : "dark") : themePreference;
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [lineRevision, setLineRevision] = useState(0);
  const lineChanged = useRef(false);
  const [user, setUser] = useState<User | null>(null);
  const favoriteSync = useRef(new Map<string, Promise<void>>());
  const favoriteSession = useRef({ userId: user?.id, lineRevision });
  favoriteSession.current = { userId: user?.id, lineRevision };
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    const appearance = window.matchMedia(LIGHT_APPEARANCE);
    const update = () => setSystemLight(appearance.matches);
    appearance.addEventListener("change", update);
    update();
    return () => appearance.removeEventListener("change", update);
  }, []);

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    try { localStorage.setItem("hghub_theme", themePreference); } catch { /* ignore */ }
  }, [themePreference]);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  const onLineChanged = useCallback(() => {
    lineChanged.current = true;
    setUser(null);
    setLineRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    api.boot()
      .then((r) => {
        if (!lineChanged.current && r.user && (r.user as User).id) setUser(r.user as User);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      })
      .catch(() => { /* 离线也能用 */ });
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error("安全设置尚未读取，请重新启动应用");
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const dismissToast = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const toast = useCallback((msg: string, icon?: Toast["icon"], action?: ToastAction) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon, action }]);
    window.setTimeout(() => dismissToast(id), action ? 6500 : 2200);
  }, [dismissToast]);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); }, []);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => [...s, { ...pg, key: `p${++seq}` }]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const deleteOffline = useCallback(async (id: number, episode?: number) => {
    await api.offlineDelete(id, episode);
    // A suspended player may still hold file paths from before cache management.
    setStack((pages) => pages.filter((page) => page.kind !== "feed" || !page.offlineItems?.some(
      (item) => item.id === id && (episode === undefined || item.ep === episode),
    )));
  }, []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const syncFavorite = useCallback((id: number, on: boolean, kind: "video" | "post" = "video"): Promise<void> => {
    const userId = user?.id;
    if (userId === undefined) return Promise.resolve();
    const key = `${lineRevision}:${userId}:${kind}:${id}`;
    const isCurrentSession = () => favoriteSession.current.userId === userId && favoriteSession.current.lineRevision === lineRevision;
    const previous = favoriteSync.current.get(key) ?? Promise.resolve();
    const request = previous.then(async () => {
      if (!isCurrentSession()) return;
      try {
        await (kind === "post" ? api.postCollect(id, on) : api.collect(id, on));
      } catch {
        if (isCurrentSession()) toast("账号收藏同步失败", "info");
      }
    }).finally(() => {
      if (favoriteSync.current.get(key) === request) favoriteSync.current.delete(key);
    });
    favoriteSync.current.set(key, request);
    return request;
  }, [user?.id, lineRevision, toast]);

  const setFavLocal = useCallback((id: number, on: boolean, index = 0) => {
    setP((s) => {
      if (s.favs.includes(id) === on) return s;
      const favs = on ? [...s.favs.slice(0, index), id, ...s.favs.slice(index)] : s.favs.filter((item) => item !== id);
      return { ...s, favs };
    });
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    setP((s) => {
      const prev = s.history.find((x) => x.id === id);
      const epChanged = ep !== undefined && prev !== undefined && prev.ep !== ep;
      const entry: WatchProgress = {
        id,
        ep: ep ?? prev?.ep ?? 1,
        t: t ?? (epChanged ? 0 : prev?.t ?? 0),
        dur: dur ?? (epChanged ? 0 : prev?.dur ?? 0),
        at: Date.now(),
      };
      return { ...s, history: [entry, ...s.history.filter((x) => x.id !== id)].slice(0, 80) };
    });
  }, []);
  const clearHistory = useCallback(() => {
    setP((s) => ({ ...s, history: [] }));
    setToasts((items) => items.filter((item) => item.action?.scope !== "history"));
  }, []);
  const removeHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: s.history.filter((entry) => entry.id !== id) }));
  }, []);
  const restoreHistory = useCallback((entry: WatchProgress) => {
    setP((s) => {
      if (s.history.some((item) => item.id === entry.id)) return s;
      const history = [...s.history, entry].sort((a, b) => b.at - a.at).slice(0, 80);
      return { ...s, history };
    });
  }, []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setUser(null);
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const setPlaybackSidebar = useCallback((update: (items: PlaybackSidebarItem[]) => PlaybackSidebarItem[]) => {
    setP((s) => ({ ...s, playbackSidebar: update(s.playbackSidebar) }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, themePreference, setTheme: setThemePreference,
    tab, setTab, stack, push, pop, deleteOffline,
    lineRevision, onLineChanged, user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, setFavLocal, syncFavorite, toggleFollowLocal, addHistory, removeHistory, restoreHistory, clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    playbackSidebar: p.playbackSidebar, setPlaybackSidebar,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, dismissToast,
  }), [theme, themePreference, tab, setTab, stack, push, pop, deleteOffline, lineRevision, onLineChanged, user, loginOpen, logout,
    p, toggleLikeLocal, setFavLocal, syncFavorite, toggleFollowLocal, addHistory, removeHistory, restoreHistory, clearHistory,
    setMuted, setVolume, addSearch, clearSearchHist, setPlaybackSidebar, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toasts, toast, dismissToast, theater, setTheater, fs, setFs]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
