import { DEFAULT_PLAYBACK_SIDEBAR, normalizePlaybackSidebar, type PlaybackSidebarItem } from "./playbackSidebar";
import { normalizeHistory, type WatchProgress } from "./watchHistory";

export const PREFERENCES_KEY = "hghub_app_v1";

export type PersistedPreferences = {
  likes: number[];
  favs: number[];
  history: WatchProgress[];
  follows: number[];
  muted: boolean;
  volume: number;
  searchHist: string[];
  playbackSidebar: PlaybackSidebarItem[];
};

function ids(value: unknown): number[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0))] : [];
}

/** Preserve the v1 storage contract; malformed fields must not poison unrelated preferences. */
export function normalizePreferences(value: unknown, now: number): PersistedPreferences {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    likes: ids(raw.likes),
    favs: ids(raw.favs),
    history: normalizeHistory(raw.history, now),
    follows: ids(raw.follows),
    muted: typeof raw.muted === "boolean" ? raw.muted : true,
    volume: typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.max(0, Math.min(1, raw.volume)) : 0.7,
    searchHist: Array.isArray(raw.searchHist) ? [...new Set(raw.searchHist.filter(
      (term): term is string => typeof term === "string" && term.trim().length > 0,
    ))].slice(0, 12) : [],
    playbackSidebar: normalizePlaybackSidebar(raw.playbackSidebar ?? DEFAULT_PLAYBACK_SIDEBAR),
  };
}

export function loadPreferences(): PersistedPreferences {
  try {
    return normalizePreferences(JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "null"), Date.now());
  } catch {
    return normalizePreferences(undefined, Date.now());
  }
}
