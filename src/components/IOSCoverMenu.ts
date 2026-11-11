import { api, isIos } from "../api";
import { useStore } from "../store";
import { useLayoutEffect, useRef, type RefObject } from "react";

type CoverAction = { id: number; history: boolean; action: "cache" | "restart" | "remove" };
type EpisodeAction = { id: number; history: boolean; action: "delete-episode"; ep: number };
export type DownloadAction = "pause-download" | "resume-download" | "download-remaining" | "stop-saving" | "view-episodes" | "all-cached";
type DownloadMenuAction = { id: number; history: boolean; action: DownloadAction | "cancel-download" };
type BrowseAction = { id: number; history: boolean; action: "browse-open" | "browse-cache" };
export type MenuAction = CoverAction | EpisodeAction | DownloadMenuAction | BrowseAction;
type BrowseKind = "video" | "post";

export function browseCoverAttributes(id: number, kind: BrowseKind = "video") {
  return isIos ? { "data-hg-menu-card": id, "data-hg-browse-kind": kind } : {};
}
type MenuMode = "covers" | "episodes" | "downloads" | "browse";
type MenuOwner = { container: HTMLElement; history: boolean; mode: MenuMode };
export type CoverMenuItem = {
  action: MenuAction["action"]; label: string; disabled?: boolean; destructive?: boolean; hint?: string;
};
export type CoverMenuTarget = MenuOwner & { card: HTMLElement; id: number; ep?: number; items: CoverMenuItem[] };
const owners = new Set<MenuOwner>();
const eventOwners = new WeakMap<Event, MenuOwner>();
export const COVER_MENU_CHANGE = "hg-cover-menu-change";

/** Resolve only cards belonging to an enabled, visible consumer. No native installer is registered. */
export function getCoverMenu(card: HTMLElement): CoverMenuTarget | undefined {
  if (!card.isConnected || card.closest("[inert], [hidden]") || card.matches(":disabled") ||
    !card.getClientRects().length || getComputedStyle(card).visibility !== "visible") return;
  const owner = [...owners].find((item) => item.container.contains(card) && !item.container.closest("[inert]"));
  if (!owner) return;
  const id = Number(card.dataset.hgMenuCard);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const { history, mode } = owner;
  const items: CoverMenuItem[] = [];
  let ep: number | undefined;
  if (mode === "browse" && card.dataset.hgBrowseKind) {
    const post = card.dataset.hgBrowseKind === "post";
    items.push({ action: "browse-open", label: post ? "查看图文" : "播放剧集" });
    if (!post) items.push({ action: "browse-cache", label: "缓存剧集" });
  } else if (mode === "episodes" && card.dataset.hgMenuEpisode) {
    ep = Number(card.dataset.hgMenuEpisode);
    if (!Number.isSafeInteger(ep) || ep < 0) return;
    items.push({ action: "delete-episode", label: "删除本集缓存", destructive: true });
  } else if (mode === "downloads" && card.dataset.hgDownloadAction) {
    const action = card.dataset.hgDownloadAction as DownloadAction;
    const labels: Partial<Record<DownloadAction, string>> = {
      "pause-download": "暂停下载", "resume-download": "继续下载", "download-remaining": "缓存剩余",
      "stop-saving": "停止保留", "all-cached": "全部已缓存",
    };
    const blocked = card.dataset.hgDownloadBlocked === "true";
    if (labels[action]) items.push({ action, label: labels[action]!, disabled: blocked || action === "all-cached",
      hint: blocked ? "等当前缓存任务结束后可用" : undefined });
    items.push({ action: "view-episodes", label: "查看剧集" });
    if (action === "pause-download" || action === "resume-download") {
      items.push({ action: "cancel-download", label: "取消下载", destructive: true, disabled: blocked });
    }
  } else if (mode === "covers" && !card.dataset.hgBrowseKind && !card.dataset.hgMenuEpisode && !card.dataset.hgDownloadAction) {
    const available = card.dataset.hgUnavailable !== "true";
    if (available && card.dataset.hgCanCache === "true") items.push({ action: "cache", label: "缓存剧集" });
    if (history && available) items.push({ action: "restart", label: "从头播放" });
    items.push({ action: "remove", label: history ? "移除这条记录" : "取消收藏", destructive: true });
  }
  return items.length ? { ...owner, card, id, ep, items } : undefined;
}

export function runCoverMenuAction(target: CoverMenuTarget, action: MenuAction["action"]) {
  const current = getCoverMenu(target.card);
  if (!current || current.container !== target.container || current.id !== target.id || current.ep !== target.ep ||
    current.history !== target.history || current.mode !== target.mode ||
    !current.items.some((item) => item.action === action && !item.disabled)) return;
  const owner = [...owners].find((item) => item.container === current.container && item.mode === current.mode && item.history === current.history);
  if (!owner) return;
  const detail = { id: current.id, history: current.history, action, ...(current.ep !== undefined ? { ep: current.ep } : {}) };
  const event = new CustomEvent("hg-cover-action", { detail });
  eventOwners.set(event, owner);
  window.dispatchEvent(event);
}

export function useIOSCoverMenu(
  scroll: RefObject<HTMLDivElement | null> | undefined,
  enabled: boolean,
  history: boolean,
  onAction: (action: MenuAction) => void,
  mode: MenuMode = "covers",
) {
  const action = useRef(onAction);
  action.current = onAction;
  useLayoutEffect(() => {
    const container = scroll?.current;
    if (!enabled || !container) return;
    const owner = { container, history, mode };
    owners.add(owner);
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<MenuAction>).detail;
      const source = eventOwners.get(event);
      if (source && source !== owner) return;
      if (!detail || detail.history !== history || container.closest("[inert]")) return;
      const actionMode = detail.action === "delete-episode" ? "episodes"
        : detail.action === "cache" || detail.action === "restart" || detail.action === "remove" ? "covers"
        : detail.action === "browse-open" || detail.action === "browse-cache" ? "browse"
        : "downloads";
      if (actionMode === mode) action.current(detail);
    };
    window.addEventListener("hg-cover-action", receive);
    window.dispatchEvent(new Event(COVER_MENU_CHANGE));
    return () => {
      owners.delete(owner);
      window.removeEventListener("hg-cover-action", receive);
      window.dispatchEvent(new Event(COVER_MENU_CHANGE));
    };
  }, [scroll, enabled, history, mode]);
}


export function useIOSBrowseCoverMenu(active: boolean, onOpen: (id: number) => void) {
  const scroll = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const { push, toast } = useStore();
  useLayoutEffect(() => () => { request.current++; }, [active]);
  useIOSCoverMenu(scroll, isIos && active, false, ({ id, action }) => {
    const card = scroll.current?.querySelector(`[data-hg-menu-card="${id}"][data-hg-browse-kind]`);
    if (!card) return;
    if (action === "browse-open") {
      onOpen(id);
    } else if (action === "browse-cache" && card.getAttribute("data-hg-browse-kind") === "video") {
      const revision = ++request.current;
      const current = () => revision === request.current && card.isConnected;
      void api.video(id).then((show) => {
        if (!current()) return;
        const episodes = show?.episodes?.map((episode) => episode.ep_num);
        if (!episodes?.length) {
          toast("暂无可缓存的剧集", "info");
          return;
        }
        push({ kind: "offline", id, title: show.title, episodes });
      }).catch(() => {
        if (current()) toast("暂时无法读取选集，请稍后重试", "info");
      });
    }
  }, "browse");
  return scroll;
}
