import { ShowCoverCard, ShowCoverGrid } from "../components/ShowCoverGrid";
import AccountCard from "../components/AccountCard";
import { OfflineLibrary } from "./Offline";
import { IOSPageBar } from "../components/IOSPageBar";
import { useIOSSymbols } from "../components/IOSSymbol";
import { useEffect, useRef, useState } from "react";
import { api, APP_VERSION, fmtTime, isIos, isMobile, platformLabel } from "../api";
import { useIOSCoverMenu } from "../components/IOSCoverMenu";
import type { Detail } from "../types";
import { useStore } from "../store";
import { CompactAction, ConfirmAction, Empty, PageStatus } from "../components/ui";
import { IClock, IDownload, ISettings, IStar } from "../icons";

const libraryIcons = { fav: IStar, history: IClock, offline: IDownload };
const LIBRARY_PAGE_SIZE = 12;

export default function Profile({ wide, active }: { wide: boolean; active: boolean }) {
  const symbol = useIOSSymbols();
  const { history, favs, lineRevision, setFavLocal, syncFavorite, removeHistory, restoreHistory, clearHistory, push, toast } = useStore();
  const [tab, setTab] = useState<"fav" | "history" | "offline">("fav");
  const [detailCache, setDetailCache] = useState<{ line: number; items: Record<number, Detail> }>({ line: lineRevision, items: {} });
  const [limit, setLimit] = useState(LIBRARY_PAGE_SIZE);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);

  const ids = tab === "fav" ? favs : tab === "history" ? history.map((h) => h.id) : [];
  const visibleIds = ids.slice(0, limit);
  const visibleKey = visibleIds.join(",");
  const details = detailCache.line === lineRevision ? detailCache.items : {};
  const cards = visibleIds.flatMap((id) => details[id] ? [details[id]] : []);
  const detailsRef = useRef(details);
  detailsRef.current = details;
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  const playShow = (show: Detail, fromBeginning = false) => {
    const index = cards.findIndex((item) => item.id === show.id);
    if (index < 0) return;
    const progress = fromBeginning ? undefined : progressOf(show.id);
    const firstEpisode = show.episodes?.reduce((first, ep) => Math.min(first, ep.ep_num), Infinity);
    push({
      kind: "feed", videoIds: cards.map((item) => item.id), index,
      title: tab === "fav" ? "我的收藏" : "观看历史",
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

  useEffect(() => {
    let alive = true;
    const missing = visibleIds.filter((id) => !detailsRef.current[id]);
    setFailed(false);
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    Promise.allSettled(missing.map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        const loaded = rs.flatMap((result, i) => result.status === "fulfilled" && result.value?.id === missing[i]
          ? [[missing[i], result.value] as const] : []);
        setDetailCache((previous) => ({
          line: lineRevision,
          items: { ...(previous.line === lineRevision ? previous.items : {}), ...Object.fromEntries(loaded) },
        }));
        setFailed(loaded.length < missing.length);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineRevision, visibleKey, retry]);

  useIOSCoverMenu(scroll, isIos && active && tab !== "offline" && !loading && cards.length > 0, tab === "history", ({ id, action }) => {
    const show = cards.find((item) => item.id === id);
    if (!show || !ids.includes(id)) return;
    if (action === "remove") removeShow(id);
    else if (action === "restart" && tab === "history") playShow(show, true);
    else if (action === "cache" && show.episodes?.length) {
      push({ kind: "offline", id, title: show.title, episodes: show.episodes.map((ep) => ep.ep_num) });
    }
  });

  const sections = isIos
    ? [["fav", "收藏"], ["history", "历史"], ["offline", "缓存"]] as const
    : [["fav", "我的收藏"], ["history", "观看历史"]] as const;

  const segments = (
    <div role="group" aria-label="资料库内容" className={isIos ? "hg-ios-segments" : "hg-ios-segments mt-4 flex bg-s3 rounded-(--r-ctl) p-1"}>
      {sections.map(([k, label]) => {
        const Icon = libraryIcons[k];
        return (
          <button key={k} aria-pressed={tab === k} onClick={() => { if (tab !== k) { setLimit(LIBRARY_PAGE_SIZE); setTab(k); } }}
            className={isIos ? undefined : `flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
            style={!isIos && tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>
            {isIos && <Icon size={14} strokeWidth={1.8} />}
            {label}
          </button>
        );
      })}
    </div>
  );

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

      <div ref={scroll} className="hg-ios-browse-content flex-1 scroll-y px-4 pt-2 pb-24">
        {!isIos && <AccountCard />}

        {!isIos && segments}

        {tab === "offline" ? <OfflineLibrary active={active} wide={wide} scroll={scroll} /> : <div className={isIos ? "space-y-2" : "mt-3 space-y-2"}>
          {cards.length > 0 && (
            <ShowCoverGrid compact={isIos && !wide}>
              {cards.map((c) => {
                const p = progressOf(c.id);
                const badge = p ? `第 ${p.ep} 集${p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}` : undefined;
                return <ShowCoverCard key={c.id} title={c.title} cover={c.cover} badge={badge}
                  menu={isIos ? { id: c.id, canCache: !!c.episodes?.length } : undefined} onClick={() => playShow(c)} />;
              })}
            </ShowCoverGrid>
          )}
          {loading && <div className="flex justify-center py-4" role="status" aria-label="正在加载资料库"><div className="w-7 h-7 spinner" /></div>}
          {!loading && failed && <PageStatus title={cards.length ? "部分作品加载失败" : "作品加载失败"} onRetry={() => setRetry((n) => n + 1)} />}
          {!loading && ids.length === 0 && (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!loading && visibleIds.length < ids.length && (
              <CompactAction tone="neutral" onClick={() => setLimit((n) => n + LIBRARY_PAGE_SIZE)}>加载更多</CompactAction>
            )}
            {ids.length > 0 && tab === "history" && (
              <button type="button" onClick={() => setConfirmClear(true)}
                className="ml-auto min-h-11 rounded-(--r-ctl) bg-danger/10 px-3 text-xs font-semibold text-danger pressable">清空观看历史</button>
            )}
          </div>
        </div>}

        {!isIos && <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {platformLabel} 客户端</div>}
      </div>
      <ConfirmAction open={confirmClear} title="清空观看历史"
        message="清空全部观看记录和续播进度？" confirm="清空历史" onCancel={() => setConfirmClear(false)}
        onConfirm={() => { clearHistory(); setConfirmClear(false); }} />
    </div>
  );
}
