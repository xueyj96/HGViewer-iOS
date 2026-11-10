import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { api, isIos } from "../api";
import { useStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, type RefObject } from "react";

type CoverAction = { id: number; history: boolean; action: "cache" | "restart" | "remove" };
type EpisodeAction = { id: number; history: boolean; action: "delete-episode"; ep: number };
export type DownloadAction = "pause-download" | "resume-download" | "download-remaining" | "stop-saving" | "view-episodes" | "all-cached";
type DownloadMenuAction = { id: number; history: boolean; action: DownloadAction | "cancel-download" };
type BrowseAction = { id: number; history: boolean; action: "browse-open" | "browse-cache" };
type MenuAction = CoverAction | EpisodeAction | DownloadMenuAction | BrowseAction;
type BrowseKind = "video" | "post";

export function browseCoverAttributes(id: number, kind: BrowseKind = "video") {
  return isIos ? { "data-hg-menu-card": id, "data-hg-browse-kind": kind } : {};
}
let revision = Date.now() * 1024;

export function useIOSCoverMenu(
  scroll: RefObject<HTMLDivElement | null> | undefined,
  enabled: boolean,
  history: boolean,
  onAction: (action: MenuAction) => void,
  mode: "covers" | "episodes" | "downloads" | "browse" = "covers",
) {
  const action = useRef(onAction);
  action.current = onAction;
  useLayoutEffect(() => {
    const container = scroll?.current;
    if (!enabled || !container) return;
    let frame = 0;
    let last = "";
    const send = (covers: object[]) =>
      void invoke("ios_cover_menu_update", { revision: ++revision, history, covers }).catch(() => {});
    const update = () => {
      frame = 0;
      if (container.closest("[inert]")) {
        if (last !== "[]") { last = "[]"; send([]); }
        return;
      }
      const viewport = container.getBoundingClientRect();
      const tabBarTop = mode === "episodes" ? undefined : document.querySelector(".hg-tabbar:not([inert])")?.getBoundingClientRect().top;
      const bottom = Math.min(viewport.bottom, tabBarTop ?? viewport.bottom);
      const previous = container.previousElementSibling;
      const bar = previous?.matches(".hg-ios-floating-bar-anchor, .hg-ios-floating-bar") ? previous : undefined;
      const top = Math.max(viewport.top, bar?.getBoundingClientRect().bottom ?? viewport.top);
      const visibleRect = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(rect.left, viewport.left);
        const y = Math.max(rect.top, top);
        const width = Math.min(rect.right, viewport.right) - x;
        const height = Math.min(rect.bottom, bottom) - y;
        return width > 0 && height > 0 ? { x, y, width, height } : undefined;
      };
      const covers = [...container.querySelectorAll<HTMLElement>("[data-hg-menu-card]")].flatMap((card) => {
        const rect = visibleRect(card);
        if (!rect) return [];
        const preview = card.querySelector<HTMLElement>("[data-hg-menu-preview]") ?? card;
        const previewRect = visibleRect(preview);
        const radius = parseFloat(getComputedStyle(preview).borderTopLeftRadius) || 0;
        return [{
          id: Number(card.dataset.hgMenuCard), ...rect,
          preview: previewRect && { ...previewRect, radius },
          browse_kind: card.dataset.hgBrowseKind,
          can_cache: card.dataset.hgCanCache === "true",
          ep: card.dataset.hgMenuEpisode ? Number(card.dataset.hgMenuEpisode) : undefined,
          download_action: card.dataset.hgDownloadAction,
          download_blocked: card.dataset.hgDownloadBlocked === "true",
        }];
      });
      const signature = JSON.stringify(covers);
      if (signature === last) return;
      last = signature;
      send(covers);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    const card = container.querySelector("[data-hg-menu-card]");
    const grid = mode === "episodes" ? card?.parentElement : card?.parentElement?.parentElement;
    if (grid) observer.observe(grid);
    const mutations = new MutationObserver(schedule);
    mutations.observe(container, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["inert", "data-hg-menu-card", "data-hg-browse-kind", "data-hg-menu-episode", "data-hg-can-cache", "data-hg-download-action", "data-hg-download-blocked"] });
    const workspace = container.closest(".win-main");
    for (let ancestor = container.parentElement; ancestor && ancestor !== workspace; ancestor = ancestor.parentElement) {
      mutations.observe(ancestor, { attributes: true, attributeFilter: ["inert"] });
    }
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<MenuAction>).detail;
      if (!detail || detail.history !== history || container.closest("[inert]")) return;
      const actionMode = detail.action === "delete-episode" ? "episodes"
        : detail.action === "cache" || detail.action === "restart" || detail.action === "remove" ? "covers"
        : detail.action === "browse-open" || detail.action === "browse-cache" ? "browse"
        : "downloads";
      if (actionMode === mode) action.current(detail);
    };
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener(IOS_LAYOUT_CHANGE, schedule);
    if (mode === "browse") window.addEventListener("animationend", schedule);
    window.addEventListener("hg-cover-action", receive);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener(IOS_LAYOUT_CHANGE, schedule);
      if (mode === "browse") window.removeEventListener("animationend", schedule);
      window.removeEventListener("hg-cover-action", receive);
      send([]);
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
