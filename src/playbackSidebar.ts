export const PLAYBACK_SIDEBAR_ACTIONS = {
  details: "剧集详情",
  favorite: "收藏",
  comments: "评论",
  download: "缓存剧集",
  mute: "静音",
  quality: "清晰度",
  rotate: "转屏",
} as const;

export type PlaybackSidebarAction = keyof typeof PLAYBACK_SIDEBAR_ACTIONS;
export type PlaybackSidebarItem = { action: PlaybackSidebarAction; visible: boolean };

export const DEFAULT_PLAYBACK_SIDEBAR: PlaybackSidebarItem[] = (
  Object.keys(PLAYBACK_SIDEBAR_ACTIONS) as PlaybackSidebarAction[]
).map((action) => ({ action, visible: true }));

export function normalizePlaybackSidebar(saved: unknown): PlaybackSidebarItem[] {
  const items: PlaybackSidebarItem[] = [];
  const seen = new Set<PlaybackSidebarAction>();
  if (Array.isArray(saved)) {
    for (const item of saved) {
      if (!item || typeof item.action !== "string" ||
        !Object.prototype.hasOwnProperty.call(PLAYBACK_SIDEBAR_ACTIONS, item.action) || typeof item.visible !== "boolean") continue;
      const action = item.action as PlaybackSidebarAction;
      if (seen.has(action)) continue;
      seen.add(action);
      items.push({ action, visible: item.visible });
    }
  }
  return [...items, ...DEFAULT_PLAYBACK_SIDEBAR.filter(({ action }) => !seen.has(action))];
}
