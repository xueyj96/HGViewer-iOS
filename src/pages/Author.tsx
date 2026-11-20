import { useEffect, useRef, useState } from "react";
import { api, fmt, isIos } from "../api";
import { appendUniqueById } from "../collections";
import type { AuthorProfile, VideoCard } from "../types";
import { useStore } from "../store";
import { IOSPageBar } from "../components/IOSPageBar";
import { useIOSBrowseCoverMenu } from "../components/IOSCoverMenu";
import { Masonry } from "../components/cards";
import { Avatar, CompactAction, ErrorStatus, LoadingStatus, PageStatus } from "../components/ui";
import { IBack } from "../icons";

/** Author ID owns the list. Returning from playback preserves this mounted page and its scroll position. */
export default function AuthorPage({ id, initialName, onBack, wide, active }: {
  id: number; initialName?: string; onBack: () => void; wide: boolean; active: boolean;
}) {
  const { push } = useStore();
  const [author, setAuthor] = useState<AuthorProfile | null>(null);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const sentinel = useRef<HTMLDivElement>(null);
  const name = author?.nickname || author?.username || initialName || "作者";
  const open = (videoId: number) => {
    const index = items.findIndex(item => item.id === videoId);
    if (index >= 0) push({ kind: "feed", videoIds: items.map(item => item.id), index, title: name });
  };
  const scroll = useIOSBrowseCoverMenu(active, open);

  useEffect(() => {
    const revision = ++generation.current;
    busy.current = true;
    setLoading(true); setError(""); setAuthor(null); setItems([]); setPage(0); setPages(1);
    Promise.all([api.author(id), api.authorVideos(id)])
      .then(([profile, result]) => {
        if (revision !== generation.current) return;
        setAuthor(profile); setItems(appendUniqueById([], result.items));
        setPage(1); setPages(result.pagination.pages);
      })
      .catch(e => { if (revision === generation.current) setError((e as Error).message || "作者作品加载失败"); })
      .finally(() => { if (revision === generation.current) { busy.current = false; setLoading(false); } });
    return () => { ++generation.current; };
  }, [id, retry]);

  const loadMore = async () => {
    if (!visible.current || busy.current || page < 1 || page >= pages) return;
    const revision = generation.current;
    busy.current = true; setLoading(true); setError("");
    try {
      const result = await api.authorVideos(id, page + 1);
      if (revision !== generation.current) return;
      setItems(previous => appendUniqueById(previous, result.items));
      setPage(page + 1); setPages(result.pagination.pages);
    } catch (e) {
      if (revision === generation.current) setError((e as Error).message || "作者作品加载失败");
    } finally {
      if (revision === generation.current) { busy.current = false; setLoading(false); }
    }
  };
  useEffect(() => {
    if (!active || loading || error || page >= pages || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: scroll.current, rootMargin: "400px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [active, loading, error, page, pages]);

  return <div role="region" aria-label="作者作品" className="absolute inset-0 flex flex-col bg-bg">
    {isIos ? <IOSPageBar label="作者作品工具" onBack={onBack}>
      <h2 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">{name}</h2>
    </IOSPageBar> : <div className="flex shrink-0 items-center gap-2 px-4 py-3">
      <button type="button" aria-label="返回" onClick={onBack} className="grid size-11 place-items-center rounded-(--r-ctl) bg-s3 pressable"><IBack size={18} /></button>
      <h2 className="min-w-0 truncate text-[15px] font-semibold">{name}</h2>
    </div>}
    <div ref={scroll} className="hg-ios-browse-content flex-1 scroll-y px-4 pb-24">
      {author && <div className="hg-ios-content-card mb-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar size={32} name={name} hue={220} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13px] font-semibold">{name}</h3>
            <p className="mt-1 text-[12px] text-mut">{author.counts.video} 部作品 · {fmt(author.counts.follower)} 位关注者</p>
          </div>
        </div>
        {(author.desc || author.sign) && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-mut">{author.desc || author.sign}</p>}
      </div>}
      {!!items.length && <Masonry videos={items} wide={wide} onOpen={video => open(video.id)} />}
      {error ? <ErrorStatus message={error} active={active} onRetry={() => page ? void loadMore() : setRetry(value => value + 1)} />
        : loading ? <div className="flex justify-center py-3"><LoadingStatus variant={page ? "tail" : "initial"} label="正在加载作者作品" /></div>
        : !items.length && <PageStatus title="暂无作品" />}
      {!loading && !error && page < pages && !isIos && <div className="flex justify-center py-3"><CompactAction tone="neutral" onClick={() => void loadMore()}>加载更多</CompactAction></div>}
      <div ref={sentinel} aria-hidden="true" className="h-px" />
    </div>
  </div>;
}
