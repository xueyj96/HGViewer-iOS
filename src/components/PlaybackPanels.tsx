import type { Episode } from "../types";
import { isIos, isMobile, fmt, offlineCover } from "../api";
import { Avatar, CompactAction, Img, Sheet } from "./ui";
import { IOSPageBar } from "./IOSPageBar";
import { IOSTabPages, IOSSwipeSegments, type useIOSTabSwipe } from "./IOSTabSwipe";
import { ArticlePanel, CommentsPanel, EpisodeSortButton, EpisodesPanel } from "./Panels";
import { cacheSize } from "./CachePageFrame";
import { IClose, IDownload } from "../icons";

export type PlaybackPanel = "episodes" | "comments" | "article" | "detail" | "quality" | null;
const DETAIL_TABS = [["detail", "详情"], ["episodes", "选集"]] as const;
type Meta = { title: string; cover: string; desc: string; author: string; authorId: number;
  score: number; like: number; collect: number; comment: number };
type Props = {
  panel: PlaybackPanel; activeDetailPanel: "detail" | "episodes" | null;
  detailPanel: "detail" | "episodes"; detailTabs: ReturnType<typeof useIOSTabSwipe>;
  cachedEpisodesPage: boolean; offlineItems: boolean; curId: number; curEp: number; playKey: string;
  kind: "video" | "post"; meta: Meta; episodes: Episode[]; descending: boolean;
  articleHtml: string; hot?: number; hasOfflineCover: boolean; cachedBytes: number; followed: boolean;
  openCache?: () => void; onCacheManagement: () => void;
  onPick: (ep: number) => void; onFollow: () => void; onSort: () => void; onClose: () => void;
  onSelectDetail: (panel: "detail" | "episodes") => void;
  onCommentsPresence: (present: boolean) => void; onDetailsPresence: (present: boolean) => void;
};

/** Requested panel and exit snapshots remain owned by Feed; these views own no playback or requests. */
export default function PlaybackPanels(props: Props) {
  const { panel, activeDetailPanel, detailPanel, detailTabs, cachedEpisodesPage, offlineItems, curId, curEp, playKey,
    kind, meta, episodes, descending, articleHtml, hot, openCache, onCacheManagement, onPick: pickEp,
    onSort: toggleEpisodeOrder, onClose, onSelectDetail, onCommentsPresence, onDetailsPresence } = props;
  const isDesktop = !isMobile;
  const fullDetails = isIos;
  const renderDetailContent = (showEpisodes: boolean) => <ShowDetailContent {...props} showEpisodes={showEpisodes} />;
  return <>
      {isIos && activeDetailPanel && (
        <IOSPageBar overlay label={cachedEpisodesPage ? "已缓存分集工具" : "剧集详情与选集工具"}
          onBack={onClose} fillTrailing={offlineItems}
          endAction={detailPanel === "episodes" ? (
            <EpisodeSortButton descending={descending} onToggle={toggleEpisodeOrder} />
          ) : (offlineItems || openCache) && (
            <button type="button" aria-label={offlineItems ? "缓存管理" : "缓存剧集"} onClick={offlineItems ? onCacheManagement : openCache} className="hg-ios-floating-button hg-ios-header-square grid place-items-center">
              <IDownload size={16} aria-hidden="true" />
            </button>
          )}>
          {offlineItems ? (
            <h2 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">
              {cachedEpisodesPage ? "已缓存分集" : "离线剧集详情"}
            </h2>
          ) : (
            <IOSSwipeSegments controller={detailTabs} label="详情与选集">
              {DETAIL_TABS.map(([key, label], index) => (
                <button type="button" key={key} aria-pressed={detailPanel === key} onClick={() => detailTabs.select(index)}>{label}</button>
              ))}
            </IOSSwipeSegments>
          )}
        </IOSPageBar>
      )}

      {/* 选集 / 评论：桌面停靠在右侧，iOS 使用整页 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onCache={openCache}
                descending={descending} onSort={toggleEpisodeOrder} onClose={onClose} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={onClose} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <Sheet open={panel === "comments"} onClose={onClose} sharedChrome={isIos}
            fullPage={isIos ? "评论" : undefined} onPresenceChange={isIos ? onCommentsPresence : undefined}>
            <div className="flex h-full min-h-0 flex-col" style={isIos ? undefined : { height: "72vh" }}>
              <CommentsPanel key={playKey} videoId={curId} ep={curEp} total={meta.comment} kind={kind}
                showNavigation={panel === "comments"} onClose={onClose} />
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={panel === "article"} onClose={onClose}>
            <div className="flex flex-col" style={{ height: "78vh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={hot} onClose={onClose} />
            </div>
          </Sheet>

          <Sheet open={activeDetailPanel !== null} onClose={onClose} sharedChrome={isIos}
            onPresenceChange={isIos ? onDetailsPresence : undefined}
            fullPage={fullDetails ? cachedEpisodesPage ? "已缓存分集" : offlineItems ? "离线剧集详情" : "剧集详情与选集" : undefined}>
            <div className={`hg-ios-show-sheet-content flex min-h-0 flex-col ${isIos ? "hg-ios-detail-page" : ""}`} style={isIos ? undefined : { height: "72vh" }}>
              {!isIos && <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
                <div role="group" aria-label="详情与选集" className="relative isolate flex h-11 min-w-0 flex-1 px-[3px]">
                  <span aria-hidden="true" className="absolute inset-x-0 inset-y-1 -z-10 rounded-(--r-ctl) bg-s3" />
                  {DETAIL_TABS.map(([key, label]) => (
                    <button type="button" key={key} onClick={() => onSelectDetail(key)} aria-pressed={detailPanel === key}
                      className="grid flex-1 place-items-center text-[13px] font-semibold leading-none text-mut pressable">
                      <span className={`grid h-[30px] w-full place-items-center rounded-(--r-ctl) ${detailPanel === key ? "bg-sec text-primary" : ""}`}>{label}</span>
                    </button>
                  ))}
                </div>
                <button type="button" onClick={onClose} aria-label="关闭" className="grid size-11 shrink-0 place-items-center rounded-full text-mut pressable">
                  <span className="grid size-9 place-items-center rounded-full bg-s3"><IClose size={16} aria-hidden="true" /></span>
                </button>
              </div>}

              {isIos && !offlineItems ? <IOSTabPages controller={detailTabs}>
                {(index) => renderDetailContent(index === 1)}
              </IOSTabPages> : renderDetailContent(detailPanel === "episodes")}

            </div>
          </Sheet>
        </>
      )}
  </>;
}

function ShowDetailContent({ showEpisodes, cachedEpisodesPage, curId, curEp, episodes, openCache, descending,
  offlineItems, hasOfflineCover, cachedBytes, meta, followed, onPick, onSort, onClose, onFollow }: Props & { showEpisodes: boolean }) {
  const fullDetails = isIos;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showEpisodes ? (
        <EpisodesPanel bare cachedOnly={cachedEpisodesPage} sortInHeader={fullDetails}
          videoId={curId} episodes={episodes} current={curEp} onPick={onPick} onCache={fullDetails ? undefined : openCache}
          descending={descending} onSort={onSort} onClose={onClose} />
      ) : isIos && offlineItems ? (
        <div className="hg-ios-browse-content min-h-0 scroll-y pb-5">
          <section aria-label="缓存信息" className="hg-ios-content-card flex items-center gap-2">
            {hasOfflineCover && (
              <div className="hg-ios-detail-cover relative aspect-[3/4] shrink-0 overflow-hidden rounded-(--r-sm) bg-s3">
                <Img key={curId} src={offlineCover(curId)} raw eager />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold leading-snug text-on [overflow-wrap:anywhere]">{meta.title}</h3>
              <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs tabular-nums text-mut">
                <span>已缓存 {episodes.length} 集</span>
                <span>{cacheSize(cachedBytes)}</span>
              </p>
            </div>
          </section>
        </div>
      ) : (
        <div className="hg-ios-browse-content min-h-0 scroll-y px-4 pb-5">
          {/* 封面 / 标题 / 评分 / 数据 */}
          <div className="hg-ios-content-card hg-ios-detail-overview flex gap-3">
            <div className="hg-ios-detail-cover relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
              <Img src={meta.cover} />
            </div>
            <div className="hg-ios-detail-info-column flex-1 min-w-0">
              <div className="hg-ios-detail-info min-w-0">
                <div className="hg-detail-title text-[13.5px] leading-snug font-bold text-on clamp-2">{meta.title}</div>
                <div className="flex items-baseline gap-2 mt-1.5 tabular-nums">
                  {!!meta.score && <span className="text-[12px] font-bold text-amber">{meta.score.toFixed(1)} 分</span>}
                  {episodes.length > 0 && <span className="text-[10.5px] text-mut">共 {episodes.length} 集</span>}
                </div>
              </div>
              <div className="hg-ios-detail-metrics flex gap-3 mt-2 text-[10.5px] text-mut tabular-nums">
                {([["点赞", meta.like], ["收藏", meta.collect], ["评论", meta.comment]] as const).map(([label, value]) => (
                  <span key={label}>{label} <b className="font-semibold text-on">{fmt(value)}</b></span>
                ))}
              </div>
            </div>
          </div>

          {/* 作者 + 关注 */}
          <div className="hg-ios-content-card hg-ios-content-card-next mt-4 flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5">
            <Avatar size={isIos ? 32 : 34} name={meta.author} hue={220} />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-on truncate">{meta.author}</div>
              <div className="text-[10px] text-mut">作者</div>
            </div>
            {meta.authorId > 0 && (isIos ? (
              <CompactAction className="hg-ios-detail-follow" tone={followed ? "neutral" : "accent"} onClick={onFollow}>
                {followed ? "已关注" : "关注"}
              </CompactAction>
            ) : (
              <button onClick={onFollow}
                className={`h-7 px-3 rounded-full text-[11px] font-semibold pressable ${followed ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
                {followed ? "已关注" : "+ 关注"}
              </button>
            ))}
          </div>

          {/* 简介 */}
          <div className="hg-ios-content-card hg-ios-content-card-next mt-4">
            <div className="text-[11px] font-semibold text-dim mb-1.5">简介</div>
            <p className="hg-reading-body text-[11.5px] leading-relaxed text-mut whitespace-pre-wrap">{meta.desc || "暂无简介"}</p>
          </div>
        </div>
      )}
    </div>
  );

}
