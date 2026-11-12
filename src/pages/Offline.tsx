import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api, isIos, offlineCover } from "../api";
import { IChevR, IClock, IDownload, IRefresh, ITrash } from "../icons";
import { CompactDownloadButton, DownloadProgressCard, EpisodeDownloadLabel, downloadFraction, downloadNetworkSpeed, downloadSpeed, downloadStatus, episodeDownloadPercent } from "../components/DownloadControls";
import { ShowCoverCard, ShowCoverGrid } from "../components/ShowCoverGrid";
import { useIOSCoverMenu, type DownloadAction } from "../components/IOSCoverMenu";
import { useOfflineStatus } from "../components/useOfflineStatus";
import { CacheDeleteDialog, CachePageFrame, cacheSize } from "../components/CachePageFrame";
import { CompactAction, EmptyStatus } from "../components/ui";
import { useStore } from "../store";

const episodeButton = (cached: boolean) =>
  `relative inline-flex items-center justify-center overflow-hidden rounded-(--r-sm) text-xs font-semibold pressable ${cached ? "bg-primary/20 text-primary" : "bg-s3 text-on disabled:opacity-50"}`;
const cacheAction = "inline-flex min-h-11 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-(--r-sm) px-2 text-xs font-semibold pressable disabled:opacity-50";
const cacheAccent = `${cacheAction} bg-primary/15 text-primary`;
const cacheCard = "hg-ios-cache-detail-card hg-ios-grouped-list rounded-(--r-md) bg-s2 p-3";

type OfflineSelection = { id?: number; title?: string; episodes?: number[] };

export default function Offline({ onBack, active, ...selection }: OfflineSelection & { onBack: () => void; wide?: boolean; active?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  return <CachePageFrame onBack={onBack} scroll={scroll}
    title={(isIos || selection.episodes === undefined ? selection.title : undefined) || "本地缓存"}>
    <OfflineLibrary {...selection} active={active} scroll={scroll} />
  </CachePageFrame>;
}

export function OfflineLibrary({ id, title, episodes, active = true, wide = false, scroll }: OfflineSelection & {
  active?: boolean; wide?: boolean; scroll?: RefObject<HTMLDivElement | null>;
}) {
  const { history, push, deleteOffline } = useStore();
  const { state, readError, refresh, busy, actionError: error, runAction: run } = useOfflineStatus(active);
  const attemptedRefresh = useRef<number | undefined>(undefined);
  const [loadingShow, setLoadingShow] = useState<number>();
  const [showErrors, setShowErrors] = useState<Record<number, string>>({});
  const [pendingDelete, setPendingDelete] = useState<{ id: number; ep?: number }>();

  const refreshShow = async (videoId: number) => {
    if (loadingShow !== undefined) return;
    setLoadingShow(videoId);
    setShowErrors((prev) => ({ ...prev, [videoId]: "" }));
    try {
      await api.offlineRefreshShow(videoId);
      await refresh().catch(() => {});
    } catch (e) {
      setShowErrors((prev) => ({ ...prev, [videoId]: (e as Error).message || "剧集信息加载失败" }));
    } finally {
      setLoadingShow(undefined);
    }
  };

  const items = state?.items || [];
  const jobs = new Map(state?.jobs.map((job) => [job.id, job]));
  const last = state?.last;
  const detailJob = id === undefined ? undefined : jobs.get(id);
  const detailActive = !!detailJob && !detailJob.paused;
  const detailEnqueueBlocked = busy || !!detailJob?.stopping || detailJob?.watch_key != null;
  const groups = new Map<number, typeof items>();
  for (const item of items) {
    const group = groups.get(item.id) || [];
    group.push(item);
    groups.set(item.id, group);
  }
  for (const job of jobs.values()) {
    if (!groups.has(job.id)) groups.set(job.id, []);
  }
  const needsShowInfo = id !== undefined && !!groups.get(id)?.length && !state?.shows?.[id];
  useEffect(() => {
    if (!active || id === undefined || !needsShowInfo || attemptedRefresh.current === id) return;
    attemptedRefresh.current = id;
    void refreshShow(id);
  }, [active, id, needsShowInfo]);

  const saved = id === undefined ? [] : groups.get(id) || [];
  const show = id === undefined ? undefined : state?.shows?.[id];
  const options = [...new Set(episodes || [])].sort((a, b) => a - b);
  const savedEpisodes = new Set(saved.map((item) => item.ep));
  const allEpisodes = [...new Set([...(show?.episodes ?? []), ...savedEpisodes])].sort((a, b) => a - b);
  const missingCount = allEpisodes.length - savedEpisodes.size;
  const cachedCount = options.filter((ep) => savedEpisodes.has(ep)).length;
  const canDeleteEpisode = id !== undefined && episodes === undefined && !busy && !detailActive && saved.length > 0;
  useIOSCoverMenu(scroll, isIos && active && canDeleteEpisode && !pendingDelete, false, (action) => {
    if (canDeleteEpisode && action.action === "delete-episode" && action.id === id && savedEpisodes.has(action.ep)) {
      setPendingDelete({ id, ep: action.ep });
    }
  }, "episodes");

  const cacheEpisode = (videoId: number, ep?: number) =>
    void run(() => api.offlineStart(videoId, ep, title || saved[0]?.title));
  const coverMenu = (videoId: number): { action: DownloadAction; blocked?: boolean } => {
    const job = jobs.get(videoId);
    if (job?.paused) return { action: "resume-download", blocked: busy };
    if (job) return {
      action: job.watch_key != null ? "stop-saving" : "pause-download",
      blocked: busy || job.stopping,
    };
    const group = groups.get(videoId);
    const knownEpisodes = state?.shows?.[videoId]?.episodes;
    if (!group?.length) return { action: "view-episodes" };
    if (knownEpisodes?.length && knownEpisodes.every((ep) => group.some((item) => item.ep === ep))) {
      return { action: "all-cached" };
    }
    return { action: "download-remaining", blocked: busy };
  };
  const coverTitle = (videoId: number) =>
    groups.get(videoId)?.[0]?.title || jobs.get(videoId)?.title || "正在缓存的剧集";
  const manageCachedShow = (videoId: number) =>
    push({ kind: "offline", id: videoId, title: coverTitle(videoId) });
  const playCachedShow = (videoId: number, episode?: number) => {
    const videoIds = [...groups].filter(([, group]) => group.length > 0).map(([showId]) => showId);
    const index = videoIds.indexOf(videoId);
    if (index < 0) return;
    const progress = episode === undefined
      ? history.find((entry) => entry.id === videoId && groups.get(videoId)?.some((item) => item.ep === entry.ep))
      : undefined;
    push({ kind: "feed", videoIds, index, title: coverTitle(videoId),
      startEp: episode ?? progress?.ep, startTime: progress?.t, offlineItems: items,
      offlineCoverIds: videoIds.filter((showId) => state?.shows?.[showId]?.cover) });
  };

  useIOSCoverMenu(scroll, isIos && active && id === undefined && groups.size > 0, false, ({ id: videoId, action }) => {
    if (action === "view-episodes" && groups.has(videoId)) {
      manageCachedShow(videoId);
      return;
    }
    const menu = coverMenu(videoId);
    if (action === "cancel-download" && !menu.blocked &&
      (menu.action === "pause-download" || menu.action === "resume-download")) {
      void run(() => api.offlineCancel(videoId));
      return;
    }
    if (menu.blocked || menu.action !== action) return;
    if (action === "pause-download") void run(() => api.offlinePause(videoId));
    if (action === "resume-download") void run(() => api.offlineResume(videoId));
    if (action === "stop-saving") void run(() => api.offlineStop(videoId));
    if (action === "download-remaining") void run(() => api.offlineStart(videoId, undefined, groups.get(videoId)?.[0]?.title));
  }, "downloads");

  const detailProgress = detailJob && (
    <DownloadProgressCard job={detailJob} disabled={busy} onToggle={() => {
      if (detailJob.paused) void run(() => api.offlineResume(detailJob.id));
      else if (detailJob.watch_key != null) void run(() => api.offlineStop(detailJob.id));
      else void run(() => api.offlinePause(detailJob.id));
    }} />
  );
  const background = state?.background;
  const activeDownloads = id === undefined
    ? [...jobs.values()].some((job) => job.running || job.queued)
    : !!detailJob && (detailJob.running || detailJob.queued);
  const showBackgroundAction = activeDownloads &&
    (background === "idle" || background === "unavailable" || background === "expired");
  const backgroundAction = showBackgroundAction && (
    <div className="flex justify-end">
      <CompactAction disabled={busy} onClick={() => void run(api.offlineBackgroundStart)}>后台下载</CompactAction>
    </div>
  );
  const cacheSummary = state && (id === undefined ? (groups.size ? "缓存占用" : undefined)
    : episodes !== undefined ? `已缓存 ${cachedCount} / ${options.length} 集`
    : `已缓存 ${saved.length}${show ? ` / ${allEpisodes.length}` : ""} 集`);
  const speed = downloadSpeed(detailJob);
  const networkSpeed = downloadNetworkSpeed(detailJob);
  const cacheBytes = state && (id === undefined ? state.bytes
    : episodes === undefined ? saved.reduce((sum, item) => sum + item.bytes, 0) : undefined);
  const rawJobMessage = detailJob?.message || (!detailJob && last &&
    (id === last.id || id === undefined && !jobs.has(last.id)) && last.message !== "缓存完成" ? last.message : "");
  const jobMessage = rawJobMessage === "后台下载已停止，点继续可接着下载"
    ? detailProgress ? "" : "下载已暂停"
    : rawJobMessage;
  const cacheError = error || readError || (id !== undefined ? showErrors[id] : "");
  const selectingEpisodes = id !== undefined && episodes !== undefined;
  const cacheWholeShow = id !== undefined && episodes !== undefined && (
    <CompactDownloadButton
      disabled={!state || detailEnqueueBlocked || cachedCount === options.length}
      onClick={() => cacheEpisode(id)}>
      缓存整部
    </CompactDownloadButton>
  );
  const overlayHost = scroll?.current?.parentElement;
  const cancelDelete = () => setPendingDelete(undefined);

  return (
    <div className="space-y-2">
      {(cacheSummary || selectingEpisodes || detailProgress || cacheError || jobMessage) && (
        <section aria-label="缓存信息" className={`flex flex-col gap-1 ${cacheCard}`}>
          {(cacheSummary || selectingEpisodes) && <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 px-2 text-xs tabular-nums">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 whitespace-nowrap">
              <span className="font-semibold text-on">{cacheSummary}</span>
              {speed && <span className="inline-flex gap-2 text-mut">
                <span>{speed}</span>
                {networkSpeed && <span>{networkSpeed}</span>}
              </span>}
            </span>
            {cacheBytes !== undefined && <span className="shrink-0 text-mut">{cacheSize(cacheBytes)}</span>}
            {selectingEpisodes && <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
              {cacheWholeShow}
              {backgroundAction}
            </div>}
          </div>}
          {detailProgress}
          {cacheError && <p role="alert" className="px-2 py-1 text-xs text-danger">{cacheError}</p>}
          {jobMessage && <p role="status" className="px-2 py-1 text-xs text-mut">{jobMessage}</p>}
        </section>
      )}
      {backgroundAction && (id === undefined || episodes === undefined && allEpisodes.length === 0) &&
        <section aria-label="缓存操作" className={cacheCard}>{backgroundAction}</section>}
      {id !== undefined && episodes !== undefined && <section className="space-y-2">
        {!isIos && <h2 className="text-base font-semibold text-on">{title || "选择要缓存的剧集"}</h2>}
        <section aria-label="分集" className={`hg-ios-cache-episodes grid grid-cols-3 gap-[var(--ios-control-gap,8px)] ${cacheCard}`}>
          {options.map((ep) => {
            const cached = savedEpisodes.has(ep);
            const percent = cached ? undefined : episodeDownloadPercent(detailJob, ep);
            return <button type="button" key={ep} className={`${episodeButton(cached)} px-3 ${isIos ? "min-h-11" : "min-h-9"}`} disabled={!state || detailEnqueueBlocked || cached}
              onClick={() => cacheEpisode(id, ep)}
              aria-label={cached ? `第 ${ep} 集已缓存` : `缓存第 ${ep} 集`}
              aria-description={percent !== undefined ? `已下载 ${percent}%` : undefined}>
              <EpisodeDownloadLabel ep={ep} percent={percent} />
            </button>;
          })}
        </section>
      </section>}
      {pendingDelete && overlayHost && createPortal(
        <CacheDeleteDialog
          message={pendingDelete.ep === undefined ? "删除这部剧的全部本地缓存？" : `删除第 ${pendingDelete.ep} 集的本地缓存？`}
          disabled={busy || detailActive} onCancel={cancelDelete} onDelete={() => {
            const target = pendingDelete;
            cancelDelete();
            void run(() => deleteOffline(target.id, target.ep));
          }} />,
        overlayHost,
      )}
      {!isIos && id === undefined && state && (
        <button type="button" onClick={() => push({ kind: "recent-cache" })}
          className="flex min-h-11 w-full items-center gap-2 rounded-(--r-md) bg-s2 px-3 text-left text-sm font-semibold text-on pressable">
          <IClock size={16} className="shrink-0 text-mut" />
          <span className="min-w-0 flex-1">最近播放缓存</span>
          <span className="shrink-0 text-xs font-normal text-mut">{state.recent.length ? `${state.recent.length} 集` : "暂无"}</span>
          <IChevR size={14} className="shrink-0 text-mut" />
        </button>
      )}
      {groups.size === 0 && state && id === undefined && !readError && (
        <EmptyStatus>暂无离线缓存</EmptyStatus>
      )}
      {id === undefined && groups.size > 0 && (
        <ShowCoverGrid compact={!wide}>
          {[...groups.keys()].map((videoId) => {
            const cardJob = jobs.get(videoId);
            const localCover = !!state?.shows?.[videoId]?.cover;
            const menu = coverMenu(videoId);
            const isPaused = !!cardJob && (cardJob.paused || cardJob.stopping);
            return (
              <ShowCoverCard key={videoId} title={coverTitle(videoId)}
                cover={localCover ? offlineCover(videoId) : cardJob?.cover || undefined}
                local={localCover}
                badge={cardJob?.queued ? downloadStatus(cardJob) : undefined}
                menu={isIos ? { id: videoId, download: menu.action, downloadBlocked: menu.blocked } : undefined}
                progress={cardJob && !cardJob.queued ? {
                  fraction: downloadFraction(cardJob),
                  label: downloadStatus(cardJob),
                  paused: isPaused,
                  speed: downloadSpeed(cardJob),
                  networkSpeed: downloadNetworkSpeed(cardJob),
                } : undefined}
                onClick={() => {
                  if (isIos && groups.get(videoId)?.length) playCachedShow(videoId);
                  else manageCachedShow(videoId);
                }} />
            );
          })}
        </ShowCoverGrid>
      )}
      {id !== undefined && state && allEpisodes.length === 0 && episodes === undefined && !detailJob && (
        <EmptyStatus>暂无已缓存分集</EmptyStatus>
      )}
      {id !== undefined && episodes === undefined && allEpisodes.length > 0 && (
        <>
          <section aria-label="缓存操作" className={cacheCard}>
            <div className={`hg-ios-cache-actions grid gap-[var(--ios-control-gap,8px)] ${isIos ? "grid-cols-3" : "grid-cols-[repeat(auto-fit,minmax(5rem,1fr))]"}`}>
              <button type="button" className={`${cacheAction} bg-s3 text-on`}
                aria-busy={loadingShow === id} disabled={loadingShow !== undefined}
                onClick={() => void refreshShow(id)}>
                {loadingShow === id ? <span aria-hidden="true" className="size-3.5 spinner" /> : <IRefresh size={14} aria-hidden="true" />}
                刷新剧集
              </button>
              <button type="button" className={cacheAccent} disabled={detailEnqueueBlocked || (!!show && missingCount === 0)}
                onClick={() => cacheEpisode(id)}>
                <IDownload size={14} aria-hidden="true" />
                缓存剩余
              </button>
              <button type="button" className={`${cacheAction} bg-danger/10 text-danger`} disabled={busy || detailActive || saved.length === 0}
                onClick={() => setPendingDelete({ id })}>
                <ITrash size={14} aria-hidden="true" />
                清空缓存
              </button>
            </div>
            {backgroundAction}
          </section>
          <section aria-label="分集" className={`hg-ios-cache-episodes grid grid-cols-3 gap-[var(--ios-control-gap,8px)] ${cacheCard}`}>
            {allEpisodes.map((ep) => {
              const cached = savedEpisodes.has(ep);
              const percent = cached ? undefined : episodeDownloadPercent(detailJob, ep);
              return <button type="button" key={ep} data-hg-menu-card={cached ? id : undefined} data-hg-menu-episode={cached ? ep : undefined}
                className={`${episodeButton(cached)} min-h-11`}
                aria-label={cached ? `播放第 ${ep} 集，已缓存` : `缓存第 ${ep} 集，未缓存`}
                aria-description={cached && isIos ? "长按可删除缓存" : percent !== undefined ? `已下载 ${percent}%` : undefined}
                disabled={!cached && detailEnqueueBlocked}
                onContextMenu={(event) => {
                  if (!cached || !canDeleteEpisode) return;
                  event.preventDefault();
                  if (!isIos) setPendingDelete({ id, ep });
                }}
                onClick={() => {
                  if (!cached) cacheEpisode(id, ep);
                  else playCachedShow(id, ep);
                }}>
                <EpisodeDownloadLabel ep={ep} percent={percent} />
              </button>;
            })}
          </section>
        </>
      )}
    </div>
  );
}
