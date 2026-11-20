import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform, type OfflineEpisode } from "./api";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import type { PlaybackSidebarItem } from "./playbackSidebar";
import { addHistory as calculateAddedHistory, restoreHistory as calculateRestoredHistory, type WatchProgress } from "./watchHistory";
import type { User } from "./types";
import type { Tab } from "./workspaceTabs";
import { setMembership } from "./collections";
import { loadPreferences, PREFERENCES_KEY, type PersistedPreferences } from "./persistedPreferences";
import { ToastProvider, useToastActions, type Toast, type ToastAction } from "./toasts";
import { useAccountSession, type Authentication, type AuthenticationResult } from "./components/useAccountSession";
export type { Toast, ToastAction } from "./toasts";

export type { Tab } from "./workspaceTabs";
export { HISTORY_LIMIT, type WatchProgress } from "./watchHistory";

export type Platform = typeof envPlatform;
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

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
  | { kind: "author"; id: number; name?: string }
  | { kind: "settings" }
  | { kind: "offline"; id?: number; title?: string; episodes?: number[] }
  | { kind: "recent-cache" }
  | { kind: "posts" }
  | { kind: "post"; id: number; postIds?: number[]; nextPostPage?: number };

export type Page = PageInput & { key: string };

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
  deleteOffline: (id: number, episode?: number, player?: () => { key: string; id: number; ep: number }) => Promise<void>;
  lineRevision: number; onLineChanged: () => void;
  user: User | null; authenticate: (request: Authentication) => Promise<AuthenticationResult>;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: WatchProgress[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  setLikedLocal: (id: number, on: boolean) => void;
  setFavLocal: (id: number, on: boolean, index?: number) => void;
  syncFavorite: (id: number, on: boolean, kind?: "video" | "post") => Promise<void>;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  removeHistory: (id: number) => void;
  restoreHistory: (entry: WatchProgress) => void;
  clearHistory: () => void;
  setFollowedLocal: (uid: number, on: boolean) => void;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  playbackSidebar: PlaybackSidebarItem[];
  setPlaybackSidebar: (update: (items: PlaybackSidebarItem[]) => PlaybackSidebarItem[]) => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toast: (msg: string, icon?: Toast["icon"], action?: ToastAction) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  return <ToastProvider><AppStateProvider>{children}</AppStateProvider></ToastProvider>;
}

function AppStateProvider({ children }: { children: React.ReactNode }) {
  const { toast, clearHistoryToasts } = useToastActions();
  const [p, setP] = useState<PersistedPreferences>(loadPreferences);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [systemLight, setSystemLight] = useState(() => window.matchMedia(LIGHT_APPEARANCE).matches);
  const theme: Theme = themePreference === "system" ? (systemLight ? "light" : "dark") : themePreference;
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [lineRevision, setLineRevision] = useState(0);
  const favoriteSync = useRef(new Map<string, Promise<void>>());
  const [loginOpen, setLoginOpen] = useState(false);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const onBoot = useCallback((boot: Awaited<ReturnType<typeof api.boot>>) => {
    if (typeof boot.strict_security === "boolean") {
      setStrictSecurityState(boot.strict_security);
      setHtmlStrictSecurity(boot.strict_security);
      setStrictSecurityReady(true);
    }
    setCliRelaxed(!!boot.cli_relaxed);
  }, []);
  const { user, authenticate, logout, resetAccount } = useAccountSession(onBoot, toast);
  const favoriteSession = useRef({ userId: user?.id, lineRevision });
  favoriteSession.current = { userId: user?.id, lineRevision };

  useEffect(() => {
    const appearance = window.matchMedia(LIGHT_APPEARANCE);
    const update = () => setSystemLight(appearance.matches);
    appearance.addEventListener("change", update);
    update();
    return () => appearance.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    try { localStorage.setItem("hghub_theme", themePreference); } catch { /* ignore */ }
  }, [themePreference]);

  useEffect(() => {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  const onLineChanged = useCallback(() => {
    resetAccount();
    setLineRevision((value) => value + 1);
  }, [resetAccount]);

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

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); }, []);
  const push = useCallback((pg: PageInput) => {
    const page = { ...pg, key: `p${++seq}` };
    setStack((s) => [...s, page]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const deleteOffline = useCallback(async (id: number, episode?: number, player?: () => { key: string; id: number; ep: number }) => {
    await api.offlineDelete(id, episode);
    const currentPlayer = player?.();
    // The inline player observes live cache updates. Keep it when another episode
    // is deleted; close it when its actual playing file is removed, including files
    // downloaded after the route was created. Suspended players retain the old safety rule.
    setStack((pages) => pages.filter((page) => {
      if (page.kind !== "feed") return true;
      if (currentPlayer && page.key === currentPlayer.key) {
        // If the user left this show during deletion, retire the old multi-show
        // route too: its immutable videoIds may otherwise lead back to removed files.
        return currentPlayer.id === id && episode !== undefined && currentPlayer.ep !== episode;
      }
      return !page.offlineItems?.some(item => item.id === id && (episode === undefined || item.ep === episode));
    }));
  }, []);

  const setLikedLocal = useCallback((id: number, on: boolean) => {
    setP((s) => {
      const likes = setMembership(s.likes, id, on);
      return likes === s.likes ? s : { ...s, likes };
    });
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
      const favs = setMembership(s.favs, id, on, index);
      return favs === s.favs ? s : { ...s, favs };
    });
  }, []);
  const setFollowedLocal = useCallback((uid: number, on: boolean) => {
    setP((s) => {
      const follows = setMembership(s.follows, uid, on);
      return follows === s.follows ? s : { ...s, follows };
    });
  }, []);
  const addHistory = useCallback((id: number, ep?: number, t?: number, dur?: number) => {
    if (!id) return;
    const now = Date.now();
    setP((s) => {
      return { ...s, history: calculateAddedHistory(s.history, id, ep, t, dur, now) };
    });
  }, []);
  const clearHistory = useCallback(() => {
    setP((s) => ({ ...s, history: [] }));
    clearHistoryToasts();
  }, [clearHistoryToasts]);
  const removeHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: s.history.filter((entry) => entry.id !== id) }));
  }, []);
  const restoreHistory = useCallback((entry: WatchProgress) => {
    setP((s) => {
      const history = calculateRestoredHistory(s.history, entry);
      if (history === s.history) return s;
      return { ...s, history };
    });
  }, []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

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
    lineRevision, onLineChanged, user, authenticate, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    setLikedLocal, setFavLocal, syncFavorite, setFollowedLocal, addHistory, removeHistory, restoreHistory, clearHistory,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    playbackSidebar: p.playbackSidebar, setPlaybackSidebar,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toast,
  }), [theme, themePreference, tab, setTab, stack, push, pop, deleteOffline, lineRevision, onLineChanged, user, authenticate, loginOpen, logout,
    p, setLikedLocal, setFavLocal, syncFavorite, setFollowedLocal, addHistory, removeHistory, restoreHistory, clearHistory,
    setMuted, setVolume, addSearch, clearSearchHist, setPlaybackSidebar, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toast, theater, setTheater, fs, setFs]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
