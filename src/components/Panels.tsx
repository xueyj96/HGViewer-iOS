import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { appendUniqueById } from "../collections";
import { api, fmt, isIos, cover as imageCover } from "../api";
import { handleArticleClick, sanitizeHtml } from "../html";
import type { Comment, CommentPage, Episode } from "../types";
import { useStore } from "../store";
import { Avatar, CompactAction, Empty, LoadingStatus, PageStatus } from "./ui";
import { CompactDownloadButton } from "./DownloadControls";
import { useIOSKeyboardViewport } from "./useIOSKeyboardViewport";
import { IOSPageBar } from "./IOSPageBar";
import { useIOSNavigation } from "./IOSNavigation";
import { IClose, IHeart, IRefresh, ISendF, ISortDown } from "../icons";

/* ================= 选集 ================= */
export function EpisodeSortButton({ descending, onToggle }: { descending: boolean; onToggle: () => void }) {
  return <button type="button" aria-label={descending ? "正序排列" : "倒序排列"} onClick={onToggle}
    className="hg-ios-floating-button hg-ios-header-square grid place-items-center">
    <ISortDown size={16} className={descending ? "-scale-y-100" : ""} aria-hidden="true" />
  </button>;
}

export function EpisodesPanel({ videoId, episodes, current, onPick, onClose, onCache, descending, onSort, bare = false, cachedOnly = false, sortInHeader = false }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onCache?: () => void; onClose: () => void;
  descending: boolean;
  onSort: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏与底注 */
  bare?: boolean;
  cachedOnly?: boolean;
  sortInHeader?: boolean;
}) {
  const list = descending ? [...episodes].reverse() : episodes;
  const columns = isIos && list.length > 0 && list.length < 4
    ? ["grid-cols-1", "grid-cols-2", "grid-cols-3"][list.length - 1]
    : "grid-cols-4";
  return (
    <div className="hg-ios-episode-panel flex h-full min-h-0 flex-col">
      <div className="hg-ios-episode-card mx-4 mb-4 flex min-h-0 flex-1 flex-col rounded-(--r-md) bg-bg">
        {!cachedOnly && !sortInHeader && <div className="flex min-h-11 shrink-0 items-center gap-[var(--ios-control-gap,8px)] px-[var(--ios-control-gap,12px)]">
          {!bare && <span className="text-[13.5px] font-bold text-on">选集</span>}
          {(!isIos || !bare) && <span className="text-[11px] tabular-nums text-mut">共 {episodes.length} 集</span>}
          <div className="ml-auto flex items-center gap-[var(--ios-control-gap,8px)]">
            {onCache && <CompactDownloadButton onClick={onCache}>缓存剧集</CompactDownloadButton>}
            <CompactAction tone="neutral" onClick={onSort}>
              <ISortDown size={16} className={descending ? "-scale-y-100" : ""} aria-hidden="true" />
              {descending ? "正序排列" : "倒序排列"}
            </CompactAction>
            {!bare && <button type="button" onClick={onClose} aria-label="关闭" className="grid size-7 place-items-center rounded-full bg-s3 text-mut pressable">
              <IClose size={13} />
            </button>}
          </div>
        </div>}
        <div className={`min-h-0 flex-1 scroll-y px-[var(--ios-control-gap,12px)] pb-[var(--ios-control-gap,12px)] ${cachedOnly || sortInHeader ? "pt-1" : ""}`}>
          <div className={`grid ${columns} gap-[var(--ios-control-gap,8px)]`}>
            {list.map((e) => (
              <button type="button" key={e.ep_num} onClick={() => onPick(e.ep_num)}
                aria-current={e.ep_num === current ? "true" : undefined}
                aria-description={cachedOnly ? "已缓存" : undefined}
                className={`hg-ios-episode-button flex h-10 items-center justify-center gap-1 rounded-(--r-sm) text-[12px] font-semibold pressable ${e.ep_num === current ? "bg-primary text-on-primary" : cachedOnly ? "bg-primary/10 text-primary" : "bg-s3 text-on/80"}`}>
                {e.ep_num}
              </button>
            ))}
          </div>
          {!episodes.length && <div className="text-center text-[11.5px] text-dim py-8">暂无剧集</div>}
        </div>
      </div>
      {!bare && <div className="shrink-0 px-4 py-2.5 text-[10.5px] text-dim bg-s2/60">剧集 ID {videoId} · 点选即切换播放</div>}
    </div>
  );
}

/* ================= 评论 ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", showNavigation = false, onClose }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; showNavigation?: boolean; onClose: () => void;
}) {
  const { user, setLoginOpen, toast } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadRevision = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const { active } = useIOSNavigation();
  const canReportRefresh = useRef(false);
  useLayoutEffect(() => {
    canReportRefresh.current = showNavigation && active;
    return () => { canReportRefresh.current = false; };
  }, [showNavigation, active]);
  useIOSKeyboardViewport(panelRef);

  const load = async (p: number, refreshing = false) => {
    const revision = ++loadRevision.current;
    setLoading(true);
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      if (revision !== loadRevision.current) return;
      setFailed(false);
      setItems((previous) => appendUniqueById(p === 1 ? [] : previous, res?.items || []));
      setPage(p);
      setPages(res?.pagination?.pages || 1);
    } catch {
      if (revision !== loadRevision.current) return;
      if (refreshing && items.length) {
        if (canReportRefresh.current) toast("评论刷新失败，请重试", "info");
      } else {
        setFailed(true);
        if (p === 1) setItems([]);
      }
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(1);
    return () => { ++loadRevision.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, ep, kind]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    if (!user) { setLoginOpen(true); return; }
    setSending(true);
    try {
      await api.commentSend(videoId, ep, t);
      setText((draft) => draft === text ? "" : draft);
      toast("评论已提交，审核通过后展示", "ok");
      load(1);
    } catch (e) {
      toast((e as Error).message || "评论失败", "info");
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={panelRef} className="hg-ios-comments-panel flex h-full min-h-0 flex-col">
      {isIos && showNavigation && (
        <IOSPageBar overlay label="评论工具" onBack={onClose} endAction={
          <button type="button" aria-label="刷新评论" aria-disabled={loading} aria-busy={loading}
            onClick={() => { if (!loading) void load(1, true); }}
            className="hg-ios-floating-button hg-ios-header-square grid place-items-center aria-disabled:opacity-50">
            <IRefresh size={16} aria-hidden="true" />
          </button>
        }>
          <h2 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">
            {kind === "video" ? `第 ${ep} 集 · 评论` : "评论"}
          </h2>
        </IOSPageBar>
      )}
      {isIos ? <div aria-hidden="true" className="hg-ios-comments-header" /> : <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">评论</span>
        <span className="text-[10.5px] text-mut">{fmt(total)} · 第 {ep} 集</span>
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>}

      <div className="hg-ios-comments-list hg-ios-browse-content min-h-0 flex-1 scroll-y px-4">
        {items.length ? items.map((c) => (
          <article key={c.id} className={`flex gap-2.5 ${isIos ? "hg-ios-content-card" : "py-3 border-b border-s3 last:border-0"}`}>
            <Avatar size={32} name={c.nickname} hue={(c.user_id * 37) % 360} />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="max-w-full text-[11.5px] font-semibold text-on/90 [overflow-wrap:anywhere]">{c.nickname}</span>
                <span className="text-[10px] text-dim">{c.time}</span>
              </div>
              <p className="text-[13px] text-on/80 mt-1 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-dim">
                <span className="flex items-center gap-1"><IHeart size={11} />{c.like_count || 0}</span>
                {c.reply_count > 0 && <span>{c.reply_count} 条回复</span>}
              </div>
            </div>
          </article>
        )) : loading ? (
          <div className="flex justify-center"><LoadingStatus variant="initial" label="正在加载评论" /></div>
        ) : failed ? (
          <PageStatus title="评论加载失败" onRetry={() => void load(1)} />
        ) : isIos ? (
          <PageStatus title="还没有评论" />
        ) : (
          <Empty icon={<IHeart size={22} />} title="还没有评论" sub="来抢第一个沙发" />
        )}
        {items.length > 0 && (loading || page < pages) && (
          <div className="flex justify-center py-4">
            {loading ? <LoadingStatus variant="tail" label="正在加载更多评论" />
              : page < pages ? (
                <CompactAction tone="neutral" onClick={() => void load(page + 1)}>{failed ? "重试" : "查看更多"}</CompactAction>
              ) : null}
          </div>
        )}
      </div>

      <div className="hg-ios-browse-content shrink-0 px-3 pt-2">
        {isIos && !user ? (
          <button type="button" onClick={() => setLoginOpen(true)}
            className="hg-ios-content-card grid min-h-11 w-full place-items-center text-[13px] font-semibold text-primary pressable">
            登录后参与评论
          </button>
        ) : (
          <form className={`flex items-center gap-2 ${isIos ? "hg-ios-content-card" : "py-2.5 bg-s2/70"}`}
            onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <Avatar size={32} name={user?.nickname || "我"} hue={322} />
            <input value={text} onChange={(e) => setText(e.target.value)}
              onFocus={() => { if (!user) setLoginOpen(true); }}
              placeholder={user ? "说点什么…" : "登录后参与评论"}
              aria-label="评论内容" enterKeyHint="send"
              className={`flex-1 min-w-0 rounded-(--r-ctl) bg-s4 px-3.5 text-on placeholder-dim outline-none focus:bg-s3 ${isIos ? "h-11 text-base" : "h-9 text-[12.5px]"}`} />
            <button type="submit" aria-label="发送评论" disabled={!text.trim() || sending}
              className={`shrink-0 flex items-center justify-center pressable ${isIos ? "size-11 rounded-(--r-ctl) bg-primary text-on-primary disabled:bg-s3 disabled:text-dim" : "size-9 rounded-full bg-s3 text-on"}`}>
              {sending ? <LoadingStatus variant="button" label="正在发送评论" /> : <ISendF size={16} />}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
/* ================= 图文正文（吃瓜） ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="hg-ios-browse-content shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[10.5px] text-mut">{fmt(hot)} 热度</span> : null}
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>
      <div className="hg-ios-browse-content flex-1 scroll-y px-4 pb-6">
        {cover && <img src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug [overflow-wrap:anywhere]">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[12px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}
