import PlaybackPanels, { type PlaybackPanel } from "./PlaybackPanels";
import { usePlaybackProgress } from "./usePlaybackProgress";
import { usePlaybackSource } from "./usePlaybackSource";
import PlaybackFeedback from "./PlaybackFeedback";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, Fragment } from "react";
import { api, isIos, isMobile, cover, fmt, fmtTime, offlineCover, type OfflineEpisode } from "../api";
import type { Detail, Episode, Post } from "../types";
import { useStore } from "../store";
import type { PlaybackSidebarAction } from "../playbackSidebar";
import { Img, PlaybackError } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import IOSVideoSurface from "./IOSVideoSurface";
import { IOSPageBar } from "./IOSPageBar";
import { useIOSTabSwipe } from "./IOSTabSwipe";
import { useIOSPlaybackRail } from "./IOSNavigation";
import { usePlaybackTap } from "./usePlaybackTap";
import { usePlaybackGestures } from "./usePlaybackGestures";
import { QualityRailButton, QualitySheet, type PlaybackQuality } from "./PlaybackQuality";
import PlayerControls from "./PlayerControls";
import IOSRotateButton from "./IOSRotateButton";
import { setBackHandler } from "../back";
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, ICommentF, ICompress, IDownload, IExpand, IFileText, IHeart, IHeartF, IInfo,
  IList, ILockF, IPauseF, IPlayF, IStar, IStarF, IVol, IVolMute,
} from "../icons";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
  offlineItems?: OfflineEpisode[];
  offlineCoverIds?: number[];
};


export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, startEp, startTime, offlineItems, offlineCoverIds }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, setFavLocal, syncFavorite, toggleFollowLocal, muted, setMuted, volume, setVolume, toast, addHistory, user, setLoginOpen } = store;
  const isDesktop = !isMobile;

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(startIndex);
  const scrollIndex = useRef(startIndex);
  const pageHeight = useRef(0);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});

  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [buffered, setBuffered] = useState(0);
  // Opening the app is not playback intent. Once someone starts the home
  // feed, later items keep its usual continuous playback behavior.
  const playbackStarted = useRef(mode !== "home");
  const [paused, setPaused] = useState(mode === "home");
  const [clear, setClear] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<PlaybackPanel>(null);
  const [descending, setDescending] = useState(false);
  const toggleEpisodeOrder = () => setDescending((value) => !value);
  const activeDetailPanel = panel === "detail" || panel === "episodes" ? panel : null;
  const lastDetailPanel = useRef<"detail" | "episodes">("detail");
  useLayoutEffect(() => {
    if (activeDetailPanel) lastDetailPanel.current = activeDetailPanel;
  }, [activeDetailPanel]);
  const detailPanel = activeDetailPanel ?? lastDetailPanel.current;
  const detailTabs = useIOSTabSwipe({ index: detailPanel === "episodes" ? 1 : 0, count: 2,
    onChange: (index) => setPanel(index === 1 ? "episodes" : "detail"),
    enabled: isIos && active && !offlineItems && activeDetailPanel !== null });
  const cachedEpisodesPage = isIos && !!offlineItems && detailPanel === "episodes";
  const fullPanel = isIos && (panel === "comments" || activeDetailPanel !== null);
  const [commentsPresent, setCommentsPresent] = useState(false);
  const [detailsPresent, setDetailsPresent] = useState(false);
  const [qualityPresent, setQualityPresent] = useState(false);
  const railPanelOpener = useRef<HTMLButtonElement | null>(null);
  const [quality, setQuality] = useState<PlaybackQuality | null>(null);
  const [qualityLevel, setQualityLevel] = useState(-1);
  const [descOpen, setDescOpen] = useState(false);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const setFs = store.setFs;

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  const [speedLock, setSpeedLock] = useState(false);
  const episodeTimer = useRef<number | undefined>(undefined);
  const [episodeEntry, setEpisodeEntry] = useState<{ key: string; direction: number }>();

  const curId = videoIds[index];
  const detail = details[curId];
  const offlineByShow = useMemo(() => {
    const groups = new Map<number, OfflineEpisode[]>();
    for (const item of offlineItems ?? []) {
      const group = groups.get(item.id);
      if (group) group.push(item);
      else groups.set(item.id, [item]);
    }
    for (const group of groups.values()) group.sort((a, b) => a.ep - b.ep);
    return groups;
  }, [offlineItems]);
  const cachedShow = offlineByShow.get(curId);
  const curEp = epMap[curId] || cachedShow?.[0]?.ep || 1;
  const playKey = `${curId}:${curEp}`;
  useEffect(() => () => {
    window.clearTimeout(episodeTimer.current);
    episodeTimer.current = undefined;
  }, [active, playKey]);
  const post = posts[curId];
  const surfaceKey = `${playKey}:${retry}`;
  const progress = usePlaybackProgress({ id: curId, ep: curEp, active, attempt: surfaceKey,
    initialResume: startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
    resumeOnReturn: isIos, addHistory, seek: (target) => videoRef.current?.seek(target) });
  const { time, duration, setTime, onTime: onTimeTick, onDuration: onDurationTick } = progress;
  const playbackIntent = useRef<{ key: string; playing: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    if (playbackIntent.current?.key !== surfaceKey) playbackIntent.current = undefined;
  }, [surfaceKey]);
  const playbackTap = usePlaybackTap(
    () => videoRef.current?.toggle(),
    () => { setPanel(null); setClear((value) => !value); },
    `${active}:${surfaceKey}`,
  );
  const episodes = offlineItems
    ? (cachedShow ?? []).map((item) => ({ ep_num: item.ep, title: `第 ${item.ep} 集`, duration: 0, status: 1 }))
    : detail?.episodes || [];
  const nextConsecutiveEpisode = episodes.find(({ ep_num }) => ep_num === curEp + 1);
  const orderedEpisodes = [...episodes].sort((a, b) => a.ep_num - b.ep_num);
  const currentEpisodeIndex = orderedEpisodes.findIndex((item) => item.ep_num === curEp);
  const previousEpisode = currentEpisodeIndex > 0 ? orderedEpisodes[currentEpisodeIndex - 1] : undefined;
  const nextEpisode = currentEpisodeIndex >= 0 ? orderedEpisodes[currentEpisodeIndex + 1] : undefined;

  const candidates = useMemo(() => [
      { id: videoIds[index + 1], ep: epMap[videoIds[index + 1]] ?? offlineByShow.get(videoIds[index + 1])?.[0]?.ep ?? 1 },
      { id: curId, ep: nextEpisode?.ep_num },
      { id: videoIds[index - 1], ep: epMap[videoIds[index - 1]] ?? offlineByShow.get(videoIds[index - 1])?.[0]?.ep ?? 1 },
      { id: curId, ep: previousEpisode?.ep_num },
    ], [videoIds, index, epMap, offlineByShow, curId, nextEpisode?.ep_num, previousEpisode?.ep_num]);
  const { stream, playUrl, nativeSource, offlineEpisode, invalidateCurrentSource } = usePlaybackSource({
    kind, active, curId, curEp, retry, offlineItems, offlineByShow, posts, detail, candidates,
    readyToPreload: isIos && active && duration > 0 && !paused && !waiting && !err,
    onError: setErr,
  });
  const videoTouchAction = "pan-y";

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "黄果吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: offlineEpisode?.title || detail?.title || "",
        cover: detail?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "黄果短剧",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? 0,
        comment: detail?.counts?.comment ?? 0,
        collect: detail?.counts?.collect ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? (post?.content || "") : "";

  /* Android 保留应用内旋转。iOS 的 WebView 已跟随系统方向。 */
  const wideVideo = vsize.w > vsize.h && vsize.h > 0;
  const rotated = !isIos && !isDesktop && fs && wideVideo;

  /* Leave a short drag range past the first and last offline pages, without adding snap targets. */
  const boundaryTravel = isIos && offlineItems ? 36 : 0;
  const hasPages = videoIds.length > 0;

  /* 滚动定位 */
  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    if (isIos && pageHeight.current && h !== pageHeight.current) return;
    const offset = el.scrollTop - boundaryTravel;
    const i = Math.max(0, Math.min(videoIds.length - 1, Math.round(offset / h)));
    // Keep the playing page mounted through the drag until the next page snaps in.
    if (isIos && Math.abs(offset - i * h) > 2) return;
    scrollIndex.current = i;
    setIndex((prev) => (prev === i ? prev : i));
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
  }, [boundaryTravel, videoIds.length, onNearEnd]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(videoIds.length - 1, index + delta));
    el.scrollTo({ top: boundaryTravel + next * el.clientHeight, behavior: "smooth" });
  }, [boundaryTravel, index, videoIds.length]);

  /* 转屏时重新对齐当前条目，避免把旧的滚动距离解释成另一部作品。 */
  useLayoutEffect(() => {
    if (!isIos) return;
    const el = boxRef.current;
    if (!el) return;
    pageHeight.current = el.clientHeight;
    el.scrollTop = boundaryTravel + scrollIndex.current * pageHeight.current;
    const observer = new ResizeObserver(() => {
      const height = el.clientHeight;
      if (!height || height === pageHeight.current) return;
      pageHeight.current = height;
      el.scrollTop = boundaryTravel + scrollIndex.current * height;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [boundaryTravel, hasPages]);

  /* Initial position on other platforms. */
  useEffect(() => {
    if (isIos) return;
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 拉详情（当前 + 邻接预取） */
  useEffect(() => {
    if (kind !== "video" || offlineItems) return;
    let alive = true;
    const need = [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => { if (alive) setDetails((m) => ({ ...m, [id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds]);

  /* 吃瓜帖子：直接拿帖子详情（含 video_url） */
  useEffect(() => {
    if (kind !== "post") return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => {
        if (!p) throw new Error("未能取得图文内容");
        if (alive) setPosts((m) => ({ ...m, [id]: p }));
      }).catch((e) => { if (alive && id === curId) setErr((e as Error).message || "图文加载失败"); });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds, retry]);

  const onVideoEnded = () => {
    if (offlineItems) {
      if (cachedShow?.some((item) => item.ep > curEp)) stepEpisode(1);
      return;
    }
    if (active && !offlineEpisode && stream?.watchKey) {
      const key = stream.watchKey;
      toast(`第 ${curEp} 集已播完`, undefined, { label: "保留本集", run: () => {
        void api.watchSave(key).then(() => {
          toast("正在保留，可在本地缓存查看", "info");
        }).catch((e) => toast((e as Error).message || "暂时无法保留", "info"));
      } });
    }
    if (nextConsecutiveEpisode) pickEp(nextConsecutiveEpisode.ep_num);
  };

  const retryPlayback = () => {
    playbackStarted.current = true;
    setErr(""); setWaiting(true); setPaused(false);
    if (kind === "post") {
      setPosts(({ [curId]: _discard, ...remaining }) => remaining);
    } else {
      invalidateCurrentSource();
    }
    setRetry((n) => n + 1);
  };

  /* 切换条目/集数时重置播放状态 */
  useEffect(() => {
    setBuffered(0); setErr("");
    setWaiting(playbackStarted.current); setPaused(!playbackStarted.current); setDescOpen(false);
    setVsize({ w: 0, h: 0 });
    setQuality(null);
    setQualityLevel(-1);
    setPanel((current) => current === "quality" ? null : current);
  }, [playKey, retry]);

  /* 非激活时暂停 */
  useEffect(() => {
    if (active) return;
    videoRef.current?.pause();
  }, [active]);

  /* 键盘 */
  const onPlaybackKey = useEffectEvent((e: KeyboardEvent) => {
    const target = e.target;
    if (panel || store.loginOpen || (target instanceof Element && target.closest("input, textarea, select, [contenteditable]"))) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); go(1); break;
      case "ArrowUp": e.preventDefault(); go(-1); break;
      case " ":
        if (target instanceof Element && target.closest("button, a[href]")) break;
        e.preventDefault(); videoRef.current?.toggle(); break;
      case "ArrowLeft": e.preventDefault(); videoRef.current?.seek(Math.max(0, time - 5)); break;
      case "ArrowRight": e.preventDefault(); videoRef.current?.seek(time + 5); break;
      case "f": case "F": toggleFull(); break;
      case "t": case "T": setTheater((v) => !v); break;
      case "m": case "M": setMuted((v) => !v); break;
      case "l": case "L": onLike(); break;
      case "s": case "S": onFav(); break;
      case "c": case "C": setPanel("comments"); break;
      case "e": case "E": setPanel("episodes"); break;
      default: break;
    }
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => onPlaybackKey(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  /* 安卓返回键：面板打开时先关面板 */
  useEffect(() => {
    if (!active || !panel) return;
    setBackHandler(() => { setPanel(null); return true; });
    return () => setBackHandler(null);
  }, [active, panel]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  const stepEpisode = (direction: -1 | 1, animate = false) => {
    const target = direction < 0 ? previousEpisode : nextEpisode;
    if (!target) {
      if (episodes.length) toast(direction > 0 ? "已经是最后一集" : "已经是第一集", "info");
      return;
    }
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pickEp(target.ep_num);
      return;
    }
    if (episodeTimer.current !== undefined) return;
    videoRef.current?.slideOut?.(direction);
    episodeTimer.current = window.setTimeout(() => {
      episodeTimer.current = undefined;
      setEpisodeEntry({ key: `${curId}:${target.ep_num}`, direction });
      pickEp(target.ep_num);
    }, 145);
  };

  const openRailPanel = (next: "comments" | "detail" | "quality", opener: HTMLButtonElement) => {
    if (isIos) railPanelOpener.current = opener;
    setPanel(next);
  };
  const qualityButton = isIos && active && !offlineEpisode && quality && quality.levels.length > 0 && (
    <QualityRailButton selected={qualityLevel} quality={quality} onClick={(event) => openRailPanel("quality", event.currentTarget)} />
  );

  const gestures = usePlaybackGestures({ active, resetKey: surfaceKey, isDesktop, isIos, kind, boxRef, surfaceReady: hasPages,
    rotated, time, duration, episodesAvailable: currentEpisodeIndex >= 0,
    hasPrevious: !!previousEpisode, hasNext: !!nextEpisode,
    episodeBusy: () => episodeTimer.current !== undefined,
    commands: {
      isPlaying: () => videoRef.current?.isPlaying() === true,
      pause: () => videoRef.current?.pause(), play: () => videoRef.current?.play(), toggle: () => videoRef.current?.toggle(),
      seek: (target, resume) => videoRef.current?.seek(target, resume),
      pullEdge: (offset, axis) => videoRef.current?.pullEdge?.(offset, axis),
      stepEpisode: (direction) => stepEpisode(direction, true),
      tap: playbackTap.tap, cancelTap: playbackTap.cancel,
      lockSpeed: () => setSpeedLock(true), showTime: setTime,
    } });
  const { holdSpeed, lockArmed, scrub, barPct, onDown, onMove, onUp, onLostCapture, onBarDown, onBarMove, onBarUp } = gestures;
  const effRate = holdSpeed || speedLock ? 2 : rate;
  const barProgress = barPct ?? (duration ? time / duration : 0);

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const requireLogin = () => { if (!user) { setLoginOpen(true); return false; } return true; };

  const onLike = () => {
    if (!curId) return;
    const on = toggleLikeLocal(curId);
    setHeartBurst((n) => n + 1);
    toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    if (requireLogin()) { if (kind === "post") api.postLike(curId, on).catch(() => {}); else api.like(curId, curEp, on).catch(() => {}); }
  };

  const onFav = () => {
    if (!curId) return;
    const on = !isFav(curId);
    setFavLocal(curId, on);
    toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    void syncFavorite(curId, on, kind);
  };

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? `已关注 ${detail?.author?.name}` : "已取消关注", on ? "ok" : "info");
    if (requireLogin()) api.follow(uid, on).catch(() => {});
  };

  const openCacheManagement = () => {
    setPanel(null);
    store.push({ kind: "offline", id: curId, title: meta.title,
      ...(!offlineItems ? { episodes: episodes.map((item) => item.ep_num) } : {}) });
  };
  const openCache = isIos && !offlineItems && kind === "video" && episodes.length > 0 ? openCacheManagement : undefined;
  const cacheButton = active && openCache && (
    <button type="button" className="hg-ios-media-button pressable" onClick={openCache} aria-label="缓存剧集">
      <IDownload size={20} />
    </button>
  );

  const favoriteButton = (
    <button type="button" onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)} aria-label="收藏">
      {isFav(curId) ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
      {!isIos && <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">收藏</span>}
    </button>
  );
  const commentsButton = (
    <button type="button" onClick={(event) => openRailPanel("comments", event.currentTarget)} className="flex flex-col items-center gap-1 pressable" aria-label="评论">
      <ICommentF size={26} className="hg-ink hg-ov-shadow" />
      {!isIos && <span className="text-[10.5px] hg-ink-2 hg-ov-shadow">评论</span>}
    </button>
  );
  // Keep the comment opener mounted while its login dialog suspends playback.
  const sidebarButtons = isIos && (active || panel === "comments") ? {
    details: <button type="button" className="hg-ios-media-button items-center pressable"
      onClick={(event) => openRailPanel("detail", event.currentTarget)} aria-label={kind === "video" ? "剧集详情" : "详情"}>
      <IInfo size={20} aria-hidden="true" />
    </button>,
    favorite: favoriteButton,
    comments: commentsButton,
    download: cacheButton,
    mute: <button type="button" onClick={() => setMuted((value) => !value)} aria-pressed={muted}
      aria-label={muted ? "取消静音" : "静音"} className="flex flex-col items-center gap-1 pressable">
      {muted ? <IVolMute size={21} /> : <IVol size={21} />}
    </button>,
    quality: qualityButton,
    rotate: <IOSRotateButton />,
  } satisfies Record<PlaybackSidebarAction, React.ReactNode> : null;
  const sidebar = sidebarButtons ? store.playbackSidebar.flatMap(({ action, visible }) => {
    const button = sidebarButtons[action];
    return visible && button ? [<Fragment key={action}>{button}</Fragment>] : [];
  }) : [];

  const pickEp = (ep: number) => {
    playbackStarted.current = true;
    if (ep === curEp) videoRef.current?.play();
    else setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  const playback = {
    muted, volume, rate: effRate,
    onTime: onTimeTick,
    onDuration: onDurationTick,
    onSize: (w: number, h: number) => setVsize({ w, h }),
    onPlaying: () => {
      playbackStarted.current = true;
      progress.onPlaying();
      setPaused(false); setWaiting(false);
    },
    onPause: () => { setPaused(true); setWaiting(false); },
    onSeeked: () => setWaiting(false),
    onWaiting: () => setWaiting(true),
    onEnded: onVideoEnded,
    onQuality: setQuality,
    onError: setErr,
  };
  const playbackGestures = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => onDown(event),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    onLostPointerCapture: onLostCapture,
  };
  const railHidden = fullPanel || commentsPresent || detailsPresent || panel === "quality" || qualityPresent || clear;
  useEffect(() => {
    if (!active) {
      if (!store.loginOpen) railPanelOpener.current = null;
      return;
    }
    if (railHidden || !railPanelOpener.current) return;
    const frame = requestAnimationFrame(() => {
      const opener = railPanelOpener.current;
      railPanelOpener.current = null;
      if (opener?.isConnected && !opener.closest("[inert]") && document.activeElement === document.body) {
        opener.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, railHidden, store.loginOpen]);
  useIOSPlaybackRail(isIos && hasPages && (active || panel === "comments") ? (
    fs ? (
      <div className="hg-ios-video-actions hg-ios-full-rail absolute flex flex-col items-center gap-2 pointer-events-auto"
        hidden={railHidden} inert={railHidden}>
        {sidebar}
        <button onClick={() => setFs(false)} aria-label="退出全屏"
          className="hg-chip-strong hg-ios-full-exit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
          <ICompress size={18} />
        </button>
      </div>
    ) : sidebar.length > 0 ? (
      <div className="hg-ios-playback-column absolute inset-y-0 pointer-events-none" hidden={railHidden} inert={railHidden}
        style={{ "--hg-player-bottom-inset": isIos ? "var(--ios-navigation-clearance)" : `${bottomInset}px` } as React.CSSProperties}>
        <div className="hg-ios-video-actions hg-ios-feed-rail no-bar absolute flex flex-col items-center pointer-events-auto"
          {...playbackGestures}
          onPointerDown={(e) => onDown(e, true)}
          onClickCapture={(e) => {
            if (!gestures.consumeRailSwipe()) return;
            e.preventDefault();
            e.stopPropagation();
          }}>
          {sidebar}
        </div>
      </div>
    ) : <></>
  ) : null);

  if (!hasPages) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }


  return (
    <div
      className={`hg-player-ui absolute inset-0 overflow-hidden bg-black player-root ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${rotated ? "fs-landscape" : ""} ${isDesktop && idle ? "is-idle" : ""} ${isIos && active && clear && !fullPanel ? "is-clear" : ""}`}
      style={isIos ? { "--hg-player-bottom-inset": "var(--ios-navigation-clearance)" } as React.CSSProperties : undefined}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      {/* 氛围背景 */}
      <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
        {posterUrl && <img src={posterUrl} alt="" className="w-full h-full object-cover" />}
      </div>

      <div ref={boxRef} onScroll={onScroll} inert={fullPanel}
        className="hg-native-feed-scroll absolute inset-y-0 left-0 overflow-y-scroll no-bar snap-y snap-mandatory overscroll-y-contain"
        style={{ overscrollBehaviorY: offlineItems ? "none" : undefined, right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {boundaryTravel > 0 && <div aria-hidden style={{ height: boundaryTravel }} />}
        {videoIds.map((vid, i) => {
          const isActive = i === index;
          return (
            <section key={vid} className="relative w-full h-full snap-start snap-always overflow-hidden">
              {isActive && playUrl ? (
                <div className="hg-feed-video absolute inset-0" style={{ touchAction: videoTouchAction }}
                  {...playbackGestures}>
                  {isIos ? active && (
                    <IOSVideoSurface key={surfaceKey} ref={videoRef} source={nativeSource} viewport={false} {...playback}
                      autoPlay={playbackIntent.current?.key === surfaceKey ? playbackIntent.current.playing : playbackStarted.current}
                      onPlaybackIntentChange={(playing) => {
                        if (playing) playbackStarted.current = true;
                        playbackIntent.current = { key: surfaceKey, playing };
                      }}
                      enterDirection={episodeEntry?.key === playKey ? episodeEntry.direction : undefined}
                      onEnter={() => setEpisodeEntry(undefined)} />
                  ) : (
                    <VideoSurface key={surfaceKey} ref={videoRef} src={playUrl} poster={posterUrl}
                      autoPlay={active && playbackStarted.current}
                      fit={isDesktop || wideVideo ? "contain" : "cover"}
                      onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                      {...playback} />
                  )}
                </div>
              ) : (
                <div className="absolute inset-0" style={{ touchAction: videoTouchAction }}
                  {...(isActive ? playbackGestures : undefined)}>
                  <Img src={offlineByShow.has(vid) ? offlineCover(vid) : details[vid]?.cover || posts[vid]?.cover || ""} raw={offlineByShow.has(vid)} eager={Math.abs(i - index) <= 1} />
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[13.5px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />查看图文详情
                  </button>
                </div>
              )}

              {/* 渐变压暗，保证文字可读 */}
              <div className="hg-clear-chrome absolute inset-0 pointer-events-none"
                style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />

              {/* 顶部 */}
              {!isIos && !fs && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={onBack} aria-label="返回"><IBack size={17} /></button>
                    <span>{title}</span>
                    <small>{index + 1} / {videoIds.length}</small>
                  </div>
                ) : (
                  <div className="hg-clear-chrome absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)" }}>
                    <button onClick={onBack} aria-label="返回"
                      className="shrink-0 flex items-center justify-center pressable w-9 h-9 hg-chip rounded-full elev-1">
                      <IBack size={20} />
                    </button>
                    <span className="text-[14.5px] font-semibold hg-ink hg-ov-shadow truncate">{title}</span>
                    <span className="ml-auto px-2 py-0.5 rounded-full hg-chip text-[11px] font-semibold" style={{ color: "rgba(255,255,255,.9)" }}>{index + 1} / {videoIds.length}</span>
                    <button onClick={() => setMuted((m) => !m)} aria-label={muted ? "取消静音" : "静音"} className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
                      {muted ? <IVolMute size={17} /> : <IVol size={17} />}
                    </button>
                  </div>
                )
              ) : null}

              {!fs && !isDesktop && !isIos && (
                <div className="hg-ios-video-actions absolute right-3 z-20 flex flex-col items-center gap-[16px]"
                  style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 92}px)` }}>
                  {favoriteButton}
                  {commentsButton}
                  <button onClick={() => setFs(true)} className="flex flex-col items-center gap-1 pressable" aria-label="全屏">
                    <IExpand size={26} className="hg-ink hg-ov-shadow" />
                    <span className="text-[10.5px] text-white/90">全屏</span>
                  </button>
                </div>
              )}

              {/* 右侧操作栏（桌面） */}
              {!fs && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <button onClick={() => go(-1)} disabled={index === 0} aria-label="上一个" title="上一个 ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </button>
                  <button onClick={() => go(1)} disabled={index >= videoIds.length - 1} aria-label="下一个" title="下一个 ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </button>
                  <small>{String(index + 1).padStart(2, "0")} / {String(videoIds.length).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <button onClick={onLike} aria-label={isLiked(curId) ? "取消点赞" : "点赞"} className="flex flex-col items-center gap-1 pressable" aria-pressed={isLiked(curId)}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {isLiked(curId) ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} aria-label="评论" className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} aria-label={isFav(curId) ? "取消收藏" : "收藏"} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)}>
                      {isFav(curId) ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={() => setPanel("episodes")} className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90">选集</span>
                    </button>
                  </>
                )}

              </div>
              )}

              {/* 桌面：左下信息 */}
              {!fs && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold hg-gold hg-ov-shadow">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="mt-1 text-[13.5px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

                {/* 描述（单行，点开展开） */}
                <button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`text-[11.5px] leading-relaxed hg-ink-4 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || "暂无简介"}
                  </p>
                  <span className="text-[10.5px] hg-link font-semibold">{descOpen ? "收起" : "展开简介"}</span>
                </button>
              </div>
              )}

              {/* 移动端：剧名与集数、播放进度 */}
              {!fs && !isDesktop && (
                <div className={`hg-ios-video-caption absolute inset-x-0 z-20 ${offlineItems ? "pointer-events-none" : ""}`} style={{ bottom: isIos ? "var(--ios-navigation-reserve)" : `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
                  <div className="hg-ios-caption-scrim absolute inset-x-0 bottom-0 h-[190px] pointer-events-none"
                    style={{ background: "linear-gradient(0deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.42) 45%, transparent 100%)" }} />
                  {isIos ? (
                    <p className="hg-ios-caption-title relative flex items-baseline gap-2 text-[14px] font-semibold leading-snug hg-ink hg-ov-shadow">
                      <span className="min-w-0 truncate">{meta.title}</span>
                      {kind === "video" && meta.title && <span className="shrink-0 whitespace-nowrap hg-ink-2">第 {curEp} 集</span>}
                    </p>
                  ) : (
                    <p className="relative px-4 pb-2 text-[14px] font-semibold leading-snug hg-ink hg-ov-shadow clamp-2">{meta.title}</p>
                  )}
                  <div className={isIos ? "relative pb-2.5" : "relative pt-1.5 pb-2.5"}>
                    {!isIos && (
                      <div className="flex items-center justify-between px-4">
                        <button onClick={() => setPanel("detail")}
                          className="flex min-h-8 items-center gap-0.5 text-[10.5px] font-medium hg-ink hg-ov-shadow pressable">
                          详情 · 第 {curEp} 集<IChevR size={11} />
                        </button>
                      </div>
                    )}
                    <div className="hg-ios-caption-progress hg-ios-seek-target mx-4 mt-2 relative pointer-events-auto" style={{ height: isIos ? 44 : 14, touchAction: "none" }}
                      onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} onLostPointerCapture={gestures.onBarLostCapture}>
                      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2.5px] rounded-full" style={{ background: "rgba(255,255,255,.3)" }}>
                        <div className="h-full rounded-full bg-white"
                          style={{ width: `${barProgress * 100}%`, transition: barPct !== null ? "none" : "width .25s linear" }} />
                      </div>
                      {barPct !== null && (
                        <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong backdrop-blur-md text-[12px] font-bold tabular-nums whitespace-nowrap">
                          {fmtTime(barPct * (duration || 0))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}


              {/* 横拖定位浮层 */}
              {!isDesktop && scrub && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none" style={{ background: "rgba(0,0,0,.25)" }}>
                  <span className="text-[26px] font-bold hg-ink tabular-nums hg-ov-shadow">{fmtTime(scrub.target)}</span>
                  <span className="text-[11px] hg-ink-4 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                  <div className="mt-4 w-[62%] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
                    <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                  </div>
                </div>
              )}

              {/* 暂停 / 缓冲 */}
              {isIos && isActive && !err && <PlaybackFeedback key={playKey} paused={paused} visible={!waiting} />}
              {!isIos && isActive && paused && !err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <span className="hg-play-glyph w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md"
                    style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
                    <IPlayF size={28} className="hg-ink ml-0.5" />
                  </span>
                </div>
              )}
              {isActive && waiting && !err && !paused && (kind === "video" || !post || !!post.video_url) && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
              )}
              {isActive && err && <PlaybackError message={err} onRetry={retryPlayback} />}
            </section>
          );
        })}
        {boundaryTravel > 0 && <div aria-hidden style={{ height: boundaryTravel }} />}
      </div>

      {isIos && !fs && mode === "context" && (
        <IOSPageBar label={offlineItems ? "离线播放工具" : "播放工具"} onBack={onBack} overMedia endAction={kind === "video" && (
          <button type="button" aria-label="选集" disabled={episodes.length === 0} onClick={() => setPanel("episodes")}
            className="hg-ios-floating-button hg-ios-header-square hg-ios-media-top-button grid place-items-center disabled:opacity-50">
            <IList size={16} aria-hidden="true" />
          </button>
        )}>
          <h1 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">
            {offlineItems ? "离线播放" : title || "剧集播放"}
          </h1>
        </IOSPageBar>
      )}

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} time={time} duration={duration} buffered={buffered} rate={rate}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          nextDisabled={!nextConsecutiveEpisode && index >= videoIds.length - 1}
          nextTitle={nextConsecutiveEpisode ? "下一集 E" : "下一部 ↓"}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t) => { videoRef.current?.seek(t); setTime(t); }}
          onRate={setRate}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            if (nextConsecutiveEpisode) pickEp(nextConsecutiveEpisode.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 长按、待锁定和已锁定共用同一个屏幕中心位置。 */}
      {!isDesktop && (!clear || holdSpeed) && (holdSpeed || speedLock || rate !== 1) && (
        <button type="button"
          disabled={holdSpeed}
          onClick={() => { if (speedLock) setSpeedLock(false); else setRate(1); }}
          className={`hg-speed-indicator ${isIos ? "hg-ios-speed-dismiss" : ""} absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30
            flex items-center whitespace-nowrap font-semibold
            ${isIos ? "" : "gap-2 rounded-full px-4 h-10 text-[12px]"}
            ${holdSpeed ? "pointer-events-none" : "pressable"}
            ${isIos ? "" : lockArmed || speedLock ? "bg-primary text-on-primary" : "hg-chip-strong"}`}>
          <span className={isIos ? `hg-ios-speed-dismiss-face ${lockArmed || speedLock ? "bg-primary text-on-primary" : "hg-chip-strong"}` : "contents"}>
              {lockArmed || speedLock ? <ILockF size={16} /> : <IBoltF size={isIos ? 16 : 15} />}
              <span>{effRate}× {holdSpeed
                ? (lockArmed ? "松手锁定" : "上滑锁定")
                : (speedLock ? "已锁定 · 点按解除" : "倍速 · 点按恢复")}</span>
          </span>
        </button>
      )}

      {/* 移动端全屏模式下的进度条（普通模式的进度条在底部灰块里） */}
      {!isDesktop && fs && (
        <div className="hg-ios-browse-content hg-ios-seek-target hg-ios-full-seek absolute inset-x-0 z-30 px-4" style={{ bottom: isIos ? "calc(var(--sab, 0px) + 56px)" : "calc(var(--sab, 0px) + 52px)", height: isIos ? 44 : 22 }}>
          <div className="relative h-full" style={{ touchAction: "none" }}
            onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} onLostPointerCapture={gestures.onBarLostCapture}>
            <div className="absolute inset-x-0 bottom-[8px] h-[2.5px] rounded-full" style={{ background: "rgba(255,255,255,.3)" }}>
              <div className="h-full rounded-full bg-white" style={{ width: `${barProgress * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* 移动端：沉浸全屏（安卓 WebView 不支持 Fullscreen API，改用应用内沉浸层） */}
      {!isDesktop && fs && (
        <>
          {isIos && <div aria-hidden className="hg-ios-full-footer-surface" />}
          {!isIos && <div className="absolute right-3 z-40 flex items-center gap-2" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
            <button onClick={() => setFs(false)} aria-label="退出全屏"
              className="hg-chip-strong hg-ios-full-exit w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
              <ICompress size={18} />
            </button>
          </div>}
          <div className="hg-ios-browse-content hg-ios-full-actions absolute inset-x-0 z-40 flex items-center gap-2 px-4"
            style={{ bottom: "calc(var(--sab, 0px) + 10px)" }}>
            <button onClick={() => videoRef.current?.toggle()} aria-label={paused ? "播放" : "暂停"}
              className={`hg-play-glyph hg-chip shrink-0 w-9 h-9 rounded-full flex items-center justify-center pressable ${isIos ? "hg-ios-full-action" : ""}`}>
              <span className={isIos ? "hg-ios-full-action-face" : "contents"}>{paused ? <IPlayF size={18} /> : <IPauseF size={17} />}</span>
            </button>
            <span className="shrink-0 text-[11.5px] font-semibold hg-ink-2 tabular-nums">{fmtTime(time)}</span>
            <button
              onClick={() => {
                if (speedLock) { setSpeedLock(false); return; }
                const seq = [1, 1.25, 1.5, 2];
                const i = seq.indexOf(rate);
                setRate(seq[(i + 1) % seq.length]);
              }}
              data-active={effRate !== 1}
              className={`ml-auto shrink-0 flex items-center text-[12px] font-bold pressable ${isIos ? "hg-ios-full-action" : `gap-1 px-2.5 h-8 rounded-full ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}`}>
              <span className={isIos ? "hg-ios-full-action-face" : "contents"}><IBoltF size={12} />{effRate}x</span>
            </button>
            <span className="shrink-0 text-[11.5px] hg-ink-4 tabular-nums">{fmtTime(duration)}</span>
          </div>
        </>
      )}

      <QualitySheet open={panel === "quality"} quality={quality} selected={qualityLevel} onClose={() => setPanel(null)}
        onPresenceChange={isIos ? setQualityPresent : undefined}
        onSelect={(level) => {
          videoRef.current?.setQuality(level);
          setQualityLevel(level);
          setPanel(null);
        }} />

      <PlaybackPanels panel={panel} activeDetailPanel={activeDetailPanel} detailPanel={detailPanel} detailTabs={detailTabs}
        cachedEpisodesPage={cachedEpisodesPage} offlineItems={!!offlineItems} curId={curId} curEp={curEp} playKey={playKey}
        kind={kind} meta={meta} episodes={episodes} descending={descending} articleHtml={articleHtml} hot={post?.hot}
        hasOfflineCover={offlineCoverIds?.includes(curId) ?? false}
        cachedBytes={cachedShow?.reduce((sum, item) => sum + item.bytes, 0) ?? 0}
        followed={store.follows.includes(meta.authorId)} openCache={openCache} onCacheManagement={openCacheManagement}
        onPick={pickEp} onFollow={onFollow} onSort={toggleEpisodeOrder} onClose={() => setPanel(null)}
        onSelectDetail={setPanel} onCommentsPresence={setCommentsPresent} onDetailsPresence={setDetailsPresent} />

    </div>
  );
}
