import { useRef } from "react";
import { OfflineLibrary } from "../pages/Offline";
import type { OfflineEpisode, OfflineShow } from "../api";
import { IOSHeaderButton } from "./IOSHeaderButton";
import type { Episode } from "../types";
import { isIos, isMobile, fmt, offlineCover } from "../api";
import { Img, Sheet } from "./ui";
import { AuthorCard } from "./AuthorCard";
import { IOSPageBar } from "./IOSPageBar";
import { IOSTabPages, IOSSwipeSegments, type useIOSTabSwipe } from "./IOSTabSwipe";
import { ArticlePanel, CommentsPanel, EpisodeSortButton, EpisodesPanel } from "./Panels";
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
  articleHtml: string; hot?: number; hasOfflineCover: boolean; followed: boolean;
  openCache?: () => void;
  offlineSnapshot?: OfflineEpisode[];
  active: boolean;
  onPlayOfflineEpisode: (ep: number, items: OfflineEpisode[]) => void;
  onOfflineItemsChange: (items: OfflineEpisode[]) => void;
  onDeleteOfflineEpisode: (id: number, ep?: number) => Promise<void>;
  onPick: (ep: number) => void; onFollow: () => void; onSort: () => void; onClose: () => void;
  onAuthor: () => void;
  onSelectDetail: (panel: "detail" | "episodes") => void;
  onCommentsPresence: (present: boolean) => void; onDetailsPresence: (present: boolean) => void;
};

/** Feed owns playback intent and panel presence; the shared offline body owns its download status/actions. */
export default function PlaybackPanels(props: Props) {
  const { panel, activeDetailPanel, detailPanel, detailTabs, cachedEpisodesPage, offlineItems, curId, curEp, playKey,
    kind, meta, episodes, descending, articleHtml, hot, openCache, onPick: pickEp,
    onSort: toggleEpisodeOrder, onClose, onSelectDetail, onCommentsPresence, onDetailsPresence } = props;
  const isDesktop = !isMobile;
  const fullDetails = isIos;
  const renderDetailContent = (showEpisodes: boolean) => <ShowDetailContent {...props} showEpisodes={showEpisodes} />;
  return <>
      {isIos && activeDetailPanel && (
        <IOSPageBar overlay label={cachedEpisodesPage ? "已缓存分集工具" : offlineItems ? "离线剧集工具" : "剧集详情与选集工具"}
          onBack={onClose} fillTrailing={offlineItems}
          endAction={detailPanel === "episodes" ? (
            <EpisodeSortButton descending={descending} onToggle={toggleEpisodeOrder} />
          ) : !offlineItems && openCache && (
            <IOSHeaderButton type="button" aria-label="缓存剧集" onClick={openCache} className="hg-ios-floating-button hg-ios-header-square grid place-items-center">
              <IDownload size={16} aria-hidden="true" />
            </IOSHeaderButton>
          )}>
          {offlineItems ? (
            <h2 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">
              {cachedEpisodesPage ? "已缓存分集" : "离线剧集"}
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
            fullPage={fullDetails ? cachedEpisodesPage ? "已缓存分集" : offlineItems ? "离线剧集" : "剧集详情与选集" : undefined}>
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
  offlineItems, meta, followed, onPick, onSort, onClose, onFollow, onAuthor, ...propsForOffline }: Props & { showEpisodes: boolean }) {
  const fullDetails = isIos;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showEpisodes ? (
        <EpisodesPanel bare cachedOnly={cachedEpisodesPage} sortInHeader={fullDetails}
          videoId={curId} episodes={episodes} current={curEp} onPick={onPick} onCache={fullDetails ? undefined : openCache}
          descending={descending} onSort={onSort} onClose={onClose} />
      ) : isIos && offlineItems ? (
        <OfflinePlaybackDetails {...{ curId, meta, episodes }} {...propsForOffline} />
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

          <ShowAuthorCard meta={meta} followed={followed} onAuthor={onAuthor} onFollow={onFollow} offlineItems={offlineItems} />

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

function ShowAuthorCard({ meta, followed, onAuthor, onFollow, offlineItems }: Pick<Props, "meta" | "followed" | "onAuthor" | "onFollow" | "offlineItems">) {
  if (offlineItems && meta.authorId <= 0) return null;
  return <AuthorCard author={{ id: meta.authorId, name: meta.author }} onOpen={onAuthor}
    follow={offlineItems ? undefined : { active: followed, onToggle: onFollow }}
    className="hg-ios-content-card-next mt-4" />;
}

/** Same single-show content as the library route, hosted inside the retained playback sheet. */
function OfflinePlaybackDetails({ curId, meta, episodes, offlineSnapshot, active, panel, onPlayOfflineEpisode,
  hasOfflineCover, onOfflineItemsChange, onDeleteOfflineEpisode }: Pick<Props, "curId" | "meta" | "episodes" | "offlineSnapshot" | "active" | "panel" | "onPlayOfflineEpisode" | "hasOfflineCover" | "onOfflineItemsChange" | "onDeleteOfflineEpisode">) {
  const scroll = useRef<HTMLDivElement>(null);
  const initialShow: OfflineShow = { episodes: episodes.map(episode => episode.ep_num), cover: hasOfflineCover,
    ...(meta.authorId > 0 ? { author: { id: meta.authorId, name: meta.author } } : {}) };
  return <div ref={scroll} className="hg-ios-browse-content min-h-0 flex-1 scroll-y px-4 py-3 pb-5">
    <OfflineLibrary id={curId} title={meta.title} scroll={scroll} active={active && panel === "detail"}
      initialItems={offlineSnapshot} initialShow={initialShow} onPlayEpisode={onPlayOfflineEpisode} onItemsChange={onOfflineItemsChange} onDeleteEpisode={onDeleteOfflineEpisode} />
  </div>;
}
