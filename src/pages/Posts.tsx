import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { appendUniqueById } from "../collections";
import { api, cover, fmt, isIos, isMobile, LOCAL } from "../api";
import type { Post } from "../types";
import { useStore } from "../store";
import { Img, LoadingStatus, PageStatus, PlaybackError } from "../components/ui";
import { IOSBackButton, IOSPageBar } from "../components/IOSPageBar";
import { browseCoverAttributes, useIOSBrowseCoverMenu } from "../components/IOSCoverMenu";
import Player from "../components/Player";
import { preloadIOSPlayback } from "../components/IOSVideoSurface";
import { restoreIOSPlaybackOrientation } from "../components/iosPlaybackOrientation";
import { useIOSPageDrag } from "../components/IOSChannelBackFrame";
import { edgeSwipeSide } from "../components/edgeSwipe";
import type { VideoHandle } from "../components/VideoSurface";
import { IBack, IFireF, IPlayF } from "../icons";
import { handleArticleClick, sanitizeHtml } from "../html";

/* ================= 吃瓜列表 ================= */
export function PostsPage({ onBack, wide, active }: { onBack: () => void; wide: boolean; active: boolean }) {
  const { push } = useStore();
  const [items, setItems] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const open = (id: number) => {
    if (items.some((item) => item.id === id)) {
      push({ kind: "post", id, postIds: items.map((item) => item.id), nextPostPage: page < pages ? page + 1 : undefined });
    }
  };
  const scroll = useIOSBrowseCoverMenu(active, open);

  const loadMore = async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.posts(next, 20);
      setItems((previous) => appendUniqueById(previous, res?.items || []));
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || failed) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, failed]);

  return (
    <div className="hg-ios-posts-list absolute inset-0 bg-bg flex flex-col">
      {isIos ? (
        <IOSPageBar label="黄果吃瓜" onBack={onBack}>
          <h1 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">黄果吃瓜</h1>
        </IOSPageBar>
      ) : (
        <div className="hg-ios-compact-header shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
          <button onClick={onBack} aria-label="返回" className="hg-ios-back w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></button>
          <span className="text-[14px] font-bold text-on">黄果吃瓜</span>
          <span className="hg-meta text-[10.5px] text-mut ml-1">圈内爆料</span>
        </div>
      )}

      <div ref={scroll} className="hg-ios-browse-content flex-1 scroll-y px-3 pt-3 pb-8">
        {items.length ? (
          <div className={isIos ? `grid gap-2 ${wide ? "grid-cols-3" : "grid-cols-2"}`
            : `${wide ? "columns-3 xl:columns-4" : "columns-2"} gap-2`}>
            {items.map((p) => (
              <button key={p.id} {...browseCoverAttributes(p.id, "post")} onClick={() => open(p.id)}
                className={`w-full relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable block ${isIos ? "text-left" : "break-inside-avoid mb-2"}`}
                style={{ paddingTop: "128%" }}>
                <Img src={p.cover} />
                <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-2">
                  <div className="text-[11.5px] font-medium text-white clamp-2 leading-snug tsh">{p.title}</div>
                  <div className="flex items-center gap-1 mt-1 hg-meta text-[9.5px] text-white/70">
                    <IFireF size={10} className="text-white/70" />{fmt(p.hot)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : loading || (page === 0 && !failed) ? (
          <div className="flex justify-center"><LoadingStatus variant="initial" label="正在加载图文" /></div>
        ) : failed ? <PageStatus title="图文列表加载失败" onRetry={loadMore} />
          : <PageStatus title="暂无吃瓜内容" />}
        {failed && items.length > 0 && !loading && <div className="mt-2"><PageStatus title="更多图文加载失败" onRetry={loadMore} /></div>}
        {!failed && page < pages && <div ref={sentinel} className="h-10" />}
        {loading && items.length > 0 && <div className="flex justify-center"><LoadingStatus variant="tail" label="正在加载更多图文" /></div>}
      </div>
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);

/* ================= 吃瓜详情（网页式浏览） ================= */
type ArticleMotion = { scope: "article" | "media"; phase: "in" | "out"; direction: number };
type ArticleMedia = { kind: "video" | "image"; src: string; alt?: string };

function FullscreenArticleImage({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const url = new URL(src);
  if (attempt) url.searchParams.set("retry", String(attempt));
  return <>
    <img key={attempt} src={url.href} alt={alt || ""} draggable={false}
      className={`h-full w-full object-contain ${status === "ready" ? "" : "opacity-0"}`}
      onLoad={() => setStatus("ready")} onError={() => setStatus("failed")} onDoubleClick={onClose} />
    {status === "loading" && <div role="status" aria-label="正在加载图片" className="pointer-events-none absolute inset-0 grid place-items-center">
      <LoadingStatus variant="media" label="正在加载图片" />
    </div>}
    {status === "failed" && <PlaybackError title="图片暂时无法加载"
      onRetry={() => { setStatus("loading"); setAttempt((value) => value + 1); }} />}
  </>;
}

type ArticlePost = Post & { content?: string; video_url?: string };

export function PostDetail({ id: initialId, postIds, nextPostPage, onBack, active = true, onFullscreenChange }: {
  id: number; postIds?: number[]; nextPostPage?: number; onBack: () => void; active?: boolean; onFullscreenChange?: (full: boolean) => void;
}) {
  const [id, setId] = useState(initialId);
  const [sequence, setSequence] = useState(postIds ?? [initialId]);
  const [nextPage, setNextPage] = useState(nextPostPage);
  const paging = useRef(false);
  const activeArticle = useRef<number | undefined>(undefined);
  const nearbyPosts = useRef(new Map<number, Promise<ArticlePost | null>>());
  activeArticle.current = active ? id : undefined;
  const { toast, strictSecurity, muted, setMuted } = useStore();
  const [post, setPost] = useState<ArticlePost | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [videoRevision, setVideoRevision] = useState(0);
  const [mediaIndex, setMediaIndex] = useState<number | null>(null);
  const [motion, setMotion] = useState<ArticleMotion>();
  const [videoEntry, setVideoEntry] = useState<number>();
  const motionTimer = useRef<number | undefined>(undefined);
  const articleEntry = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const native = useRef<VideoHandle>(null);
  const videoTime = useRef(0);
  const touch = useRef<{ id: number; x: number; y: number; side: number } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    activeArticle.current = active ? id : undefined;
    return () => { activeArticle.current = undefined; };
  }, [active, id]);
  useEffect(() => () => window.clearTimeout(motionTimer.current), []);
  const retry = () => {
    setErr(null);
    setRetrying(true);
    setAttempt((n) => n + 1);
  };
  const content = post?.content || "";
  const safeHtml = useMemo(() => sanitizeHtml(content), [content, strictSecurity]);
  const media = useMemo(() => {
    const entries: ArticleMedia[] = [];
    const seen = new Set<string>();
    const add = (item: ArticleMedia) => {
      if (item.src && !seen.has(item.src)) {
        entries.push(item);
        seen.add(item.src);
      }
    };
    if (post?.video_url) add({ kind: "video", src: post.video_url });
    else if (post?.cover) add({ kind: "image", src: cover(post.cover), alt: post.title });
    const html = new DOMParser().parseFromString(safeHtml, "text/html");
    for (const image of html.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      if (src.startsWith(`${LOCAL}/img?u=`)) add({ kind: "image", src, alt: image.alt });
    }
    return entries;
  }, [post, safeHtml]);
  const currentMedia = mediaIndex === null ? undefined : media[mediaIndex];
  const full = !!currentMedia;
  useEffect(() => {
    if (!isIos || !active || !full || !onFullscreenChange) return;
    onFullscreenChange(true);
    return () => onFullscreenChange(false);
  }, [active, full, onFullscreenChange]);
  const articleFrame = useRef<HTMLDivElement>(null);
  const atFirstArticle = sequence.indexOf(id) <= 0;
  const dragBack = useIOSPageDrag(articleFrame, isIos && active && !full && atFirstArticle, onBack);

  const move = (scope: ArticleMotion["scope"], direction: number, change: (animate: boolean) => void) => {
    if (motionTimer.current !== undefined) return;
    const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate) { change(false); return; }
    setMotion({ scope, direction, phase: "out" });
    if ((scope === "media" && currentMedia?.kind === "video") || (scope === "article" && play)) {
      native.current?.slideOut?.(direction);
    }
    motionTimer.current = window.setTimeout(() => {
      motionTimer.current = undefined;
      setMotion(undefined);
      change(true);
    }, 145);
  };
  const closeMedia = (direction = 0) => move("media", direction, () => setMediaIndex(null));
  const showMedia = (index: number) => {
    setVideoEntry(undefined);
    setMediaIndex(index);
    if (media[index]?.kind === "image") setMotion({ scope: "media", direction: 0, phase: "in" });
  };
  const stepMedia = (direction: number) => {
    if (mediaIndex === null) return;
    const next = mediaIndex + direction;
    if (!media[next]) return;
    move("media", direction * 2, (animate) => {
      if (media[next].kind === "video") setPlay(true);
      setVideoEntry(animate && media[next].kind === "video" ? direction * 2 : undefined);
      setMediaIndex(next);
      if (animate) setMotion({ scope: "media", direction: direction * 2, phase: "in" });
    });
  };
  const changeArticle = (next: number, direction: number) => {
    move("article", direction, (animate) => {
      if (isIos && activeArticle.current === id) void restoreIOSPlaybackOrientation().catch(() => {});
      articleEntry.current = animate ? direction : 0;
      videoTime.current = 0;
      setVideoEntry(undefined);
      setPlay(false);
      setMediaIndex(null);
      setPost(null);
      setErr(null);
      setId(next);
      scrollRef.current?.scrollTo(0, 0);
    });
  };
  const stepArticle = async (direction: number) => {
    const next = sequence[sequence.indexOf(id) + direction];
    if (next !== undefined) { changeArticle(next, direction); return; }
    if (direction < 0) { move("article", -1, onBack); return; }
    if (nextPage === undefined || paging.current) return;
    paging.current = true;
    try {
      const result = await api.posts(nextPage, 20);
      if (activeArticle.current !== id || !result) return;
      const added = [...new Set(result.items.map((item) => item.id))].filter((item) => !sequence.includes(item));
      setSequence((previous) => [...previous, ...added]);
      setNextPage(nextPage < result.pagination.pages ? nextPage + 1 : undefined);
      if (added.length) changeArticle(added[0], 1);
    } catch {
      if (activeArticle.current === id) toast("下一篇暂时加载失败", "info");
    } finally { paging.current = false; }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isIos || !active || !event.isPrimary || event.button !== 0 ||
      !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    suppressClick.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const side = edgeSwipeSide(x, rect.width, event.currentTarget);
    if (!full && side === -1 && atFirstArticle) return;
    if (side || full) touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY, side };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = touch.current;
    if (!start || start.id !== event.pointerId) return;
    touch.current = null;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (dx * start.side < -42 && Math.abs(dx) > Math.abs(dy)) {
      suppressClick.current = true;
      if (full) closeMedia(start.side);
      else void stepArticle(start.side);
    } else if (full && Math.abs(dy) > 46 && Math.abs(dy) > Math.abs(dx)) {
      suppressClick.current = true;
      stepMedia(dy < 0 ? 1 : -1);
    }
  };

  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };

  useEffect(() => {
    let alive = true;
    const warm = nearbyPosts.current.get(id);
    nearbyPosts.current.delete(id);
    const request = warm ? warm.then((item) => item ?? api.post(id), () => api.post(id)) : api.post(id);
    request.then((p) => {
        if (!p) throw new Error("未能取得图文内容");
        if (alive) {
          setPost(p);
          setVideoRevision((n) => n + 1);
          if (articleEntry.current) {
            setMotion({ scope: "article", direction: articleEntry.current, phase: "in" });
            articleEntry.current = 0;
          }
        }
      })
      .catch((e) => { if (alive) setErr((e as Error).message || "加载失败"); })
      .finally(() => { if (alive) setRetrying(false); });
    return () => { alive = false; };
  }, [id, attempt]);

  useEffect(() => {
    if (!isIos || !active || !post) return;
    const index = sequence.indexOf(id);
    const neighbors = [sequence[index + 1], sequence[index - 1]].filter((next) => next !== undefined);
    for (const key of nearbyPosts.current.keys()) if (!neighbors.includes(key)) nearbyPosts.current.delete(key);
    let alive = true;
    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      void (async () => {
        for (const next of neighbors) {
          if (!alive) break;
          const request = nearbyPosts.current.get(next) ?? api.post(next);
          nearbyPosts.current.set(next, request);
          try {
            const article = await request;
            if (alive && article?.video_url) await preloadIOSPlayback({ kind: "online", url: article.video_url });
          } catch {
            if (nearbyPosts.current.get(next) === request) nearbyPosts.current.delete(next);
          }
        }
      })();
    }, 450);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [active, id, post, sequence]);

  useEffect(() => {
    if (!isIos || !active || mediaIndex === null) return;
    for (const item of [media[mediaIndex + 1], media[mediaIndex - 1]]) {
      if (item?.kind === "video") void preloadIOSPlayback({ kind: "online", url: item.src });
      if (item?.kind === "image") {
        const image = new Image();
        image.src = item.src;
      }
    }
  }, [active, media, mediaIndex]);

  const motionStyle = (scope: ArticleMotion["scope"]): CSSProperties | undefined => {
    if (motion?.scope !== scope) return;
    const offset = Math.sign(motion.direction) * (motion.phase === "in" ? 1 : -1) * 24;
    return {
      "--hg-slide-x": `${Math.abs(motion.direction) === 1 ? offset : 0}%`,
      "--hg-slide-y": `${Math.abs(motion.direction) === 2 ? offset : 0}%`,
    } as CSSProperties;
  };
  const onContentClick = (event: MouseEvent<HTMLDivElement>) => {
    const image = event.target instanceof Element ? event.target.closest("img") : null;
    const src = image?.getAttribute("src");
    const index = src ? media.findIndex((item) => item.kind === "image" && item.src === src) : -1;
    if (isIos && index >= 0) {
      event.preventDefault();
      event.stopPropagation();
      showMedia(index);
    } else handleArticleClick(event, openSafeLink);
  };
  const renderVideo = play && !!post?.video_url && active && (!full || currentMedia?.kind === "video");

  return (
    <div ref={articleFrame} {...dragBack} className="absolute inset-0 bg-bg flex flex-col hg-native-article-page"
      data-hg-motion={motion?.scope === "article" ? motion.phase : undefined} style={motionStyle("article")}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && motion?.scope === "article" && motion.phase === "in") setMotion(undefined);
      }}
      onPointerDownCapture={onPointerDown} onPointerUpCapture={onPointerUp}
      onPointerCancelCapture={() => { touch.current = null; }}
      onClickCapture={(event) => {
        dragBack.onClickCapture(event);
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}>
      {isIos ? (
        <IOSPageBar label="吃瓜详情" onBack={onBack} fillTrailing hidden={full}>
          <h2 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">吃瓜详情</h2>
        </IOSPageBar>
      ) : (
        <div className="hg-ios-compact-header shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0, height: isMobile ? "calc(44px + var(--sat, 0px))" : 44 }}>
          <button onClick={onBack} aria-label="返回" className="hg-ios-back w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></button>
          <span className="text-[13.5px] font-semibold text-on">吃瓜详情</span>
        </div>
      )}


      <div ref={scrollRef} className="flex-1 scroll-y pb-8 hg-native-article-scroll">
        {err && (
          <div className="hg-ios-browse-content mb-2 px-4">
            <PageStatus title="图文加载失败" detail={err} onRetry={retry} />
          </div>
        )}
        {!post ? (!err && (
          <div className="flex justify-center"><LoadingStatus variant="initial" label="正在加载图文" /></div>
        )) : (
          <>
            {(post.video_url || post.cover) && <div className="hg-article-video relative w-full bg-black">
              {renderVideo ? (
                <Player key={videoRevision} src={post.video_url!} onRetry={retry} retrying={retrying} poster={cover(post.cover)}
                  autoPlay muted={muted} onToggleMute={() => setMuted((value) => !value)} controls className="w-full h-full"
                  nativeRef={native} nativeFullscreen={isIos ? full : undefined}
                  onToggleNativeFullscreen={() => full ? closeMedia() : showMedia(0)}
                  enterDirection={videoEntry} startTime={videoTime.current} onTime={(time) => { videoTime.current = time; }} />
              ) : (
                <button aria-label={post.video_url ? "播放图文视频" : "查看封面图片"} onClick={() => {
                  if (post.video_url) setPlay(true);
                  else if (isIos) showMedia(0);
                }} className="absolute inset-0">
                  <Img src={post.cover} eager />
                  {post.video_url && <span className="absolute inset-0 flex items-center justify-center">
                    <span className="hg-play-glyph w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                      <IPlayF size={24} className="text-white ml-0.5" />
                    </span>
                  </span>}
                </button>
              )}
            </div>}
            <div className="hg-ios-browse-content px-4 pt-3.5 bg-bg">
              <div className="hg-ios-content-card">
                <h1 className="hg-post-title text-[17px] font-bold text-on leading-snug [overflow-wrap:anywhere]">{post.title}</h1>
                <div className="flex items-center gap-2 mt-2 hg-meta text-[10.5px] text-mut">
                  <span>{post.publish_time || post.created_at}</span>
                  <span className="flex items-center gap-1"><IFireF size={10} />{fmt(post.hot)}</span>
                </div>
                {!!post.tags?.length && <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {post.tags.slice(0, 8).map((t) => (
                    <span key={t} className="hg-content-badge rounded-(--r-ctl) bg-s3 hg-meta text-[10.5px] text-on/75">#{t}</span>
                  ))}
                </div>}
              </div>
              {post.content && (
                (isHtml(post.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(post.content)))
                  ? <div className="hg-ios-content-card hg-ios-content-card-next article-body mt-3.5" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: safeHtml }} />
                  : <div className="hg-ios-content-card hg-ios-content-card-next article-body mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[12.5px] leading-relaxed text-on/80 whitespace-pre-wrap">{post.content}</div>
              )}
            </div>
          </>
        )}
      </div>
      {currentMedia?.kind === "image" && (
        <div className="hg-article-media-overlay absolute inset-0 z-50 bg-black" role="dialog" aria-label="全屏图片"
          data-hg-motion={motion?.scope === "media" ? motion.phase : undefined} style={motionStyle("media")}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && motion?.scope === "media" && motion.phase === "in") setMotion(undefined);
          }}>
          <FullscreenArticleImage key={currentMedia.src} src={currentMedia.src} alt={currentMedia.alt} onClose={() => closeMedia()} />
          <IOSPageBar label="全屏图片工具" overMedia overlay startAction={
            <IOSBackButton onBack={() => closeMedia()} label="退出图片全屏" overMedia />
          } />
        </div>
      )}
    </div>
  );
}
