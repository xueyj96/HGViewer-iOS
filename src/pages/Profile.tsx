import { ShowCoverCard, ShowCoverGrid } from "../components/ShowCoverGrid";
import AccountCard from "../components/AccountCard";
import { OfflineLibrary } from "./Offline";
import { IOSPageBar } from "../components/IOSPageBar";
import { IOSTabPages, IOSSwipeSegments, useIOSTabSwipe } from "../components/IOSTabSwipe";
import { useIOSSymbols } from "../components/IOSSymbol";
import { useEffect, useRef, useState } from "react";
import { api, APP_VERSION, fmtTime, isIos, isMobile, platformLabel } from "../api";
import { useIOSCoverMenu } from "../components/IOSCoverMenu";
import type { Detail } from "../types";
import { useStore } from "../store";
import { EmptyStatus, LoadingStatus, PageStatus } from "../components/ui";
import { IClock, IDownload, ISettings, IStar } from "../icons";

const libraryIcons = { fav: IStar, history: IClock, offline: IDownload };
const LIBRARY_PAGE_SIZE = 12;

export default function Profile({ wide, active }: { wide: boolean; active: boolean }) {
  const symbol = useIOSSymbols();
  const { history, favs, lineRevision, setFavLocal, syncFavorite, removeHistory, restoreHistory, push, toast } = useStore();
  const sections = isIos
    ? [["fav", "收藏"], ["history", "历史"], ["offline", "缓存"]] as const
    : [["fav", "我的收藏"], ["history", "观看历史"]] as const;
  const [tab, setTab] = useState<"fav" | "history" | "offline">("fav");
  const [detailCache, setDetailCache] = useState<{ line: number; items: Record<number, Detail>; unavailable: number[] }>({ line: lineRevision, items: {}, unavailable: [] });
  const [limit, setLimit] = useState(LIBRARY_PAGE_SIZE);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const tabs = useIOSTabSwipe({ index: Math.max(0, sections.findIndex(([key]) => key === tab)), count: sections.length,
    onChange: (index) => {
      const next = sections[index]?.[0];
      if (next && next !== tab) { setLimit(LIBRARY_PAGE_SIZE); setTab(next); }
    }, enabled: isIos && active });

  const ids = tab === "fav" ? favs : tab === "history" ? history.map((h) => h.id) : [];
  const visibleIds = ids.slice(0, detailCache.line === lineRevision ? limit : LIBRARY_PAGE_SIZE);
  const visibleKey = visibleIds.join(",");
  const details = detailCache.line === lineRevision ? detailCache.items : {};
  const unavailable = new Set(detailCache.line === lineRevision ? detailCache.unavailable : []);
  const failed = visibleIds.some((id) => unavailable.has(id));
  const cards = visibleIds.flatMap((id) => details[id] ? [details[id]] : []);
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const unavailableRef = useRef(unavailable);
  unavailableRef.current = unavailable;
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  const playShow = (show: Detail, fromBeginning = false, sourceTab = tab, sourceCards = cards) => {
    const index = sourceCards.findIndex((item) => item.id === show.id);
    if (index < 0) return;
    const progress = fromBeginning || sourceTab !== "history" ? undefined : history.find((entry) => entry.id === show.id);
    const firstEpisode = show.episodes?.reduce((first, ep) => Math.min(first, ep.ep_num), Infinity);
    push({
      kind: "feed", videoIds: sourceCards.map((item) => item.id), index,
      title: sourceTab === "fav" ? "我的收藏" : "观看历史",
      startEp: fromBeginning && Number.isFinite(firstEpisode) ? firstEpisode : progress?.ep,
      startTime: progress?.t,
    });
  };

  const removeShow = (id: number) => {
    if (tab === "history") {
      const entry = progressOf(id);
      if (!entry) return;
      removeHistory(id);
      toast("已移除观看记录", "info", { label: "撤销", scope: "history", run: () => restoreHistory(entry) });
      return;
    }
    const position = favs.indexOf(id);
    if (position < 0) return;
    setFavLocal(id, false);
    void syncFavorite(id, false);
    toast("已取消收藏", "info", {
      label: "撤销", run: () => {
        setFavLocal(id, true, position);
        void syncFavorite(id, true);
      },
    });
  };

  const retryDetails = (id?: number) => {
    setDetailCache((previous) => previous.line !== lineRevision ? previous : ({
      ...previous,
      unavailable: previous.unavailable.filter((failedId) => id === undefined ? !visibleIds.includes(failedId) : failedId !== id),
    }));
    setRetry((value) => value + 1);
  };
  useEffect(() => { setLimit(LIBRARY_PAGE_SIZE); }, [lineRevision]);

  useEffect(() => {
    if (!active || tab === "offline") return;
    let alive = true;
    // A failed detail is settled for this line, not an unrequested entry.
    // Only an explicit retry clears it; paging never repeats a permanent 404.
    const missing = visibleIds.filter((id) => !detailsRef.current[id] && !unavailableRef.current.has(id));
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    Promise.allSettled(missing.map((id) => api.video(id)))
      .then((results) => {
        if (!alive) return;
        const loaded = results.flatMap((result, i) => result.status === "fulfilled" && result.value?.id === missing[i]
          ? [[missing[i], result.value] as const] : []);
        const loadedIds = new Set(loaded.map(([id]) => id));
        setDetailCache((previous) => {
          const sameLine = previous.line === lineRevision;
          const failedIds = new Set(sameLine ? previous.unavailable : []);
          for (const id of missing) {
            if (loadedIds.has(id)) failedIds.delete(id);
            else failedIds.add(id);
          }
          return {
            line: lineRevision,
            items: { ...(sameLine ? previous.items : {}), ...Object.fromEntries(loaded) },
            unavailable: [...failedIds],
          };
        });
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab, lineRevision, visibleKey, retry]);

  const hasMore = visibleIds.length < ids.length;
  useEffect(() => {
    const target = sentinel.current;
    const root = scroll.current;
    // Wait for this batch to settle, including failures, before advancing.
    // One unavailable work must not make the older history unreachable.
    if (!active || !root || !target || !hasMore || loading ||
      visibleIds.some((id) => !details[id] && !unavailable.has(id))) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setLimit((value) => Math.min(value + LIBRARY_PAGE_SIZE, ids.length));
    }, { root, rootMargin: "0px 0px 200px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab, visibleKey, ids.length, hasMore, loading, detailCache]);

  useIOSCoverMenu(scroll, isIos && active && tab !== "offline" && (cards.length > 0 || failed), tab === "history", ({ id, action }) => {
    if (!ids.includes(id)) return;
    if (action === "remove") { removeShow(id); return; }
    const show = details[id];
    if (!show) return;
    if (action === "restart" && tab === "history") playShow(show, true);
    else if (action === "cache" && show.episodes?.length) {
      push({ kind: "offline", id, title: show.title, episodes: show.episodes.map((ep) => ep.ep_num) });
    }
  });

  const segmentButtons = sections.map(([k, label]) => {
      const Icon = libraryIcons[k];
      const index = sections.findIndex(([key]) => key === k);
      return (
        <button key={k} aria-pressed={tab === k} onClick={() => {
          if (isIos) tabs.select(index);
          else if (tab !== k) { setLimit(LIBRARY_PAGE_SIZE); setTab(k); }
        }}
          className={isIos ? undefined : `flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
          style={!isIos && tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>
          {isIos && <Icon size={14} strokeWidth={1.8} />}
          {label}
        </button>
      );
    });
  const segments = isIos ? (
    <IOSSwipeSegments controller={tabs} label="资料库内容">{segmentButtons}</IOSSwipeSegments>
  ) : (
    <div role="group" aria-label="资料库内容" className="hg-ios-segments mt-4 flex bg-s3 rounded-(--r-ctl) p-1">
      {segmentButtons}
    </div>
  );

  const renderPanel = (panelIndex: number, committed: boolean) => {
    const panelTab = sections[panelIndex]?.[0] ?? "fav";
    const panelIds = panelTab === "fav" ? favs : panelTab === "history" ? history.map((h) => h.id) : [];
    const panelVisibleIds = panelIds.slice(0, detailCache.line === lineRevision ? (committed ? limit : LIBRARY_PAGE_SIZE) : LIBRARY_PAGE_SIZE);
    const panelDetails = detailCache.line === lineRevision ? detailCache.items : {};
    const panelUnavailable = new Set(detailCache.line === lineRevision ? detailCache.unavailable : []);
    const panelCards = panelVisibleIds.flatMap((id) => panelDetails[id] ? [panelDetails[id]] : []);
    const panelLoading = committed ? loading : panelTab !== "offline" && panelVisibleIds.some((id) => !panelDetails[id] && !panelUnavailable.has(id));
    const panelFailed = panelVisibleIds.some((id) => panelUnavailable.has(id));
    const panelHasMore = panelVisibleIds.length < panelIds.length;
    const panelProgress = (id: number) => panelTab === "history" ? history.find((h) => h.id === id) : undefined;
    const panelRetry = (id?: number) => { if (committed) retryDetails(id); };
    return (
      <div className="hg-ios-browse-content h-full min-h-0 flex-1 scroll-y px-4 pt-2 pb-24" ref={committed ? scroll : undefined}>
        {!isIos && <AccountCard />}
        {!isIos && segments}
        {panelTab === "offline" ? committed
          ? <OfflineLibrary active={active && committed} wide={wide} scroll={scroll} />
          : <div className="flex justify-center py-4"><LoadingStatus variant="tail" label="正在加载缓存" /></div>
          : <div className={isIos ? "space-y-2" : "mt-3 space-y-2"}>
            {(panelCards.length > 0 || panelFailed) && (
              <ShowCoverGrid compact={isIos && !wide}>
                {panelVisibleIds.map((id) => {
                  const show = panelDetails[id];
                  const missing = panelUnavailable.has(id);
                  if (!show && !missing) return null;
                  const progress = panelProgress(id);
                  const badge = progress ? `第 ${progress.ep} 集${progress.t > 3 ? ` · ${fmtTime(progress.t)}` : ""}` : undefined;
                  return <ShowCoverCard key={id} title={show?.title || "作品暂不可用"} cover={show?.cover} badge={badge}
                    unavailable={missing} menu={isIos ? { id, canCache: !missing && !!show?.episodes?.length } : undefined}
                    onClick={() => { if (committed) { if (show) playShow(show, false, panelTab, panelCards); else panelRetry(id); } }} />;
                })}
              </ShowCoverGrid>
            )}
            {panelLoading && <div className="flex justify-center"><LoadingStatus variant="tail" label="正在加载资料库" /></div>}
            {!panelLoading && panelFailed && <PageStatus title={panelCards.length ? "部分作品加载失败" : "作品加载失败"} onRetry={() => panelRetry()} />}
            {!panelLoading && panelIds.length === 0 && <EmptyStatus>{panelTab === "fav" ? "还没有收藏" : "还没有观看记录"}</EmptyStatus>}
            {committed && panelHasMore && <div ref={sentinel} aria-hidden="true" className="h-px" />}
          </div>}
        {!isIos && <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {platformLabel} 客户端</div>}
      </div>
    );
  };

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? (
        <IOSPageBar label="资料库" startAction={
          <button type="button" aria-label="最近播放缓存" onClick={() => push({ kind: "recent-cache" })}
            className="hg-ios-floating-button hg-ios-header-square grid place-items-center">
            <IDownload size={16} />
          </button>
        }>{segments}</IOSPageBar>
      ) : (
        <div className="shrink-0 px-4 pb-2 flex items-center" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
          <div className="text-[24px] font-bold text-on leading-none">资料库</div>
          {isMobile && <button type="button" onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ml-auto grid size-9 shrink-0 place-items-center rounded-full bg-s3 text-mut pressable">
            {symbol("gearshape", <ISettings size={19} strokeWidth={1.65} />, 19)}
          </button>}
        </div>
      )}
      {isIos ? (
        <IOSTabPages controller={tabs}>{renderPanel}</IOSTabPages>
      ) : renderPanel(sections.findIndex(([key]) => key === tab), true)}
    </div>
  );
}
