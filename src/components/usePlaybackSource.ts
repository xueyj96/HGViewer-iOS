import { useEffect, useMemo, useState } from "react";
import { api, isIos, mediaUrl, offlineMedia, watchedPlaylist, type OfflineEpisode } from "../api";
import type { Detail, Post } from "../types";
import { preloadIOSPlayback, type PlaybackStartupTiming } from "./IOSVideoSurface";
import { useRevisionRecord } from "./useRevisionRecord";

type Candidate = { id: number | undefined; ep: number | undefined };
type Options = {
  kind: "video" | "post";
  active: boolean;
  curId: number;
  curEp: number;
  retry: number;
  lineRevision?: number;
  offlineItems?: OfflineEpisode[];
  offlineByShow: Map<number, OfflineEpisode[]>;
  posts: Record<number, Post>;
  detail?: Detail;
  candidates: Candidate[];
  readyToPreload: boolean;
  onError: (message: string) => void;
};

type Stream = { url: string; watchKey?: number };

async function resolveStream(id: number, ep: number): Promise<Stream> {
  const info = await api.play(id, ep);
  const raw = info?.video_url?.trim() || (isIos ? info?.video_url_hevc?.trim() : "");
  if (!raw) throw new Error("当前线路未返回这集的播放地址");
  const key = isIos ? await api.watchBegin(id, ep, raw).catch(() => null) : null;
  return { url: key ? watchedPlaylist(key, raw) : raw, watchKey: key ?? undefined };
}

function onlineSource(stream: Stream) {
  return {
    kind: "online" as const,
    url: stream.url.startsWith("hg://localhost/") ? new URL(stream.url).searchParams.get("u") || "" : stream.url,
    watch_key: stream.watchKey,
  };
}

/** Owns local-first source resolution and bounded adjacent preloads, not playback intent. */
export function usePlaybackSource({ kind, active, curId, curEp, retry, lineRevision = 0, offlineItems, offlineByShow,
  posts, detail, candidates, readyToPreload, onError: setErr }: Options) {
  const playKey = `${curId}:${curEp}`;
  const surfaceKey = `${lineRevision}:${playKey}:${retry}`;
  const startupTiming = useMemo<PlaybackStartupTiming>(() => ({ selectedAt: performance.now() }), [surfaceKey, active]);
  const [playUrls, setPlayUrls] = useRevisionRecord<Stream>(lineRevision);
  const warmStreams = useMemo(() => new Map<string, { promise: Promise<Stream>; expires: number }>(), [lineRevision]);
  const [cacheChoice, setCacheChoice] = useState<{ key: string; episode: OfflineEpisode | null }>();
  const checkCache = isIos && kind === "video" && !offlineItems;
  const cacheReady = !checkCache || cacheChoice?.key === surfaceKey;
  const offlineEpisode = offlineByShow.get(curId)?.find((item) => item.ep === curEp) ||
    (cacheReady && checkCache ? cacheChoice?.episode : undefined);
  const post = posts[curId];
  const stream = playUrls[playKey];
  const playUrl = !cacheReady ? "" : offlineEpisode ? offlineMedia(offlineEpisode) : kind === "post"
    ? (post?.video_url ? mediaUrl(post.video_url) : "") : (stream?.url || "");
  const nativeSource = offlineEpisode
    ? { kind: "offline" as const, id: curId, ep: curEp, mp4: offlineEpisode.mp4 }
    : onlineSource({ url: playUrl, watchKey: stream?.watchKey });

  useEffect(() => {
    if (stream?.watchKey && detail) {
      void api.watchDetails(stream.watchKey, detail.title, (detail.episodes || []).map((item) => item.ep_num), detail.cover, detail.author).catch(() => {});
    }
  }, [stream?.watchKey, detail]);

  /* Resolve the local copy before requesting a stream. */
  useEffect(() => {
    if (kind !== "video" || !curId || offlineItems) return;
    if (isIos && !active) {
      setCacheChoice(undefined);
      return;
    }
    let alive = true;
    const resolve = async () => {
      if (checkCache) {
        const started = performance.now();
        const episode = await api.offlineEpisode(curId, curEp).catch(() => null);
        if (!alive) return;
        startupTiming.cacheMs = performance.now() - started;
        if (episode) startupTiming.source = "local";
        setCacheChoice({ key: surfaceKey, episode });
        if (episode) {
          return;
        }
      }
      if (playUrls[playKey]) {
        startupTiming.source = "retained";
        return;
      }
      const started = performance.now();
      const warm = warmStreams.get(playKey);
      let source: PlaybackStartupTiming["source"] = "fresh";
      let resolved: Stream;
      if (warm && warm.expires > Date.now()) {
        source = "preloaded";
        resolved = await warm.promise.catch((error) => {
          if (!alive) throw error;
          source = "fresh_after_preload_failure";
          return resolveStream(curId, curEp);
        });
      } else {
        resolved = await resolveStream(curId, curEp);
      }
      if (!alive) return;
      if (warm && warmStreams.get(playKey) === warm) warmStreams.delete(playKey);
      startupTiming.source = source;
      startupTiming.resolveMs = performance.now() - started;
      setPlayUrls((m) => ({ ...m, [playKey]: resolved }));
    };
    void resolve().catch((e) => { if (alive) setErr((e as Error).message || "取播放地址失败"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, curId, curEp, retry, isIos && active, lineRevision]);

  useEffect(() => {
    if (!readyToPreload) return;
    let alive = true;
    const keep = new Set([playKey, ...candidates.map(({ id, ep }) => `${id}:${ep}`)]);
    for (const key of warmStreams.keys()) if (!keep.has(key)) warmStreams.delete(key);
    const preload = async ({ id, ep }: typeof candidates[number], priority: number) => {
      if (!alive || document.hidden || !id || !ep) return;
      if (kind === "post") {
        const url = posts[id]?.video_url;
        if (url && id !== curId) await preloadIOSPlayback({ kind: "online", url });
        return;
      }
      const local = offlineItems
        ? offlineByShow.get(id)?.find((item) => item.ep === ep)
        : await api.offlineEpisode(id, ep).catch(() => null);
      if (!alive) return;
      if (local) {
        await preloadIOSPlayback({ kind: "offline", id, ep, mp4: local.mp4 });
      } else if (!offlineItems) {
        const key = `${id}:${ep}`;
        const cached = warmStreams.get(key);
        const promise = playUrls[key] ? Promise.resolve(playUrls[key]) :
          cached && cached.expires > Date.now() ? cached.promise : resolveStream(id, ep);
        warmStreams.set(key, { promise, expires: Date.now() + 30_000 });
        try {
          const source = await promise;
          if (alive && !document.hidden) {
            await preloadIOSPlayback(onlineSource(source), {
              prefetchSegment: priority < 2,
              prepareStandby: priority < 2,
            });
          }
        } catch {
          if (warmStreams.get(key)?.promise === promise) warmStreams.delete(key);
        }
      }
    };
    const timer = window.setTimeout(() => {
      // Prioritize forward playback and keep background requests serial.
      void (async () => {
        for (const [index, candidate] of candidates.entries()) await preload(candidate, index);
      })();
    }, 450);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [readyToPreload, kind, curId, playKey, candidates, offlineByShow, offlineItems, posts, playUrls, warmStreams]);

  const invalidateCurrentSource = () => {
    warmStreams.delete(playKey);
    setPlayUrls(({ [playKey]: _discard, ...remaining }) => remaining);
  };
  return { stream, playUrl, nativeSource, offlineEpisode, invalidateCurrentSource, startupTiming };
}
