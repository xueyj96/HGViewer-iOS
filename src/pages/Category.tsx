import { useEffect, useRef, useState } from "react";
import { appendUniqueById } from "../collections";
import { api, fmt, isIos } from "../api";
import type { Post, VideoCard } from "../types";
import { useStore, type PageInput } from "../store";
import { IOSPageBar, IOSRanksButton } from "../components/IOSPageBar";
import { useIOSBrowseCoverMenu } from "../components/IOSCoverMenu";
import { IOSSwipeSegments, IOSTabPages, useIOSTabSwipe } from "../components/IOSTabSwipe";
import { Masonry, RowCard } from "../components/cards";
import { Img, PageStatus } from "../components/ui";
import { IBack, IBoltF, IChevR, IFileText, IGrid, IPlayF, ITrophy, IUser } from "../icons";

export const CHANNELS = [
  { cate: "ai-duanju", name: "AI 成人短剧", desc: "高能反转 · 一口气看完" },
  { cate: "ai-manju", name: "AI 成人漫剧", desc: "国创漫剧 · 每周更新" },
  { cate: "ai-huanlian", name: "AI 换脸", desc: "换脸演绎 · 全新剧情" },
  { cate: "ai-mogai", name: "AI 魔改", desc: "魔改名场面 · 脑洞大开" },
] as const;

export default function Category({ wide, active = true }: { wide: boolean; active?: boolean }) {
  return isIos ? <IosCategory active={active} /> : <CategoryOverview wide={wide} />;
}

function IosCategory({ active }: { active: boolean }) {
  const { push } = useStore();
  const [section, setSection] = useState<"频道" | "发现">("频道");
  const sectionIndex = section === "频道" ? 0 : 1;
  const tabs = useIOSTabSwipe({ index: sectionIndex, count: 2, onChange: (index) => setSection(index === 0 ? "频道" : "发现"), enabled: isIos && active });
  const icons = [IPlayF, IGrid, IUser, IBoltF];

  return (
    <div className="hg-ios-category absolute inset-0 flex flex-col bg-bg">
      <IOSPageBar label="分类工具" startAction={<IOSRanksButton />}>
        <IOSSwipeSegments controller={tabs} label="分类内容">
          {(["频道", "发现"] as const).map((option, index) => (
            <button key={option} type="button" aria-pressed={sectionIndex === index} onClick={() => tabs.select(index)}>{option}</button>
          ))}
        </IOSSwipeSegments>
      </IOSPageBar>
      <IOSTabPages controller={tabs}>{(index: number) => {
        const pageEntries: { label: string; page: PageInput; icon: typeof IGrid }[] = index === 0
          ? CHANNELS.map(({ cate, name }, i) => ({ label: name, page: { kind: "channel", cate, name }, icon: icons[i] }))
          : [
            { label: "排行榜", page: { kind: "ranks" }, icon: ITrophy },
            { label: "黄果吃瓜", page: { kind: "posts" }, icon: IFileText },
          ];
        return <section aria-label={index === 0 ? "频道" : "发现"} className="hg-ios-browse-content flex-1 scroll-y pb-24">
          <div className="hg-ios-grouped-list">
            {pageEntries.map(({ label, page, icon: Icon }) => (
              <button key={label} type="button" onClick={() => push(page)} className="hg-ios-list-row">
                <span className="hg-ios-list-icon"><Icon size={17} /></span>
                <span className="min-w-0 flex-1">{label}</span>
                <IChevR size={15} className="text-dim" />
              </button>
            ))}
          </div>
        </section>;
      }}</IOSTabPages>
    </div>
  );
}

/* ================= 分类总览 ================= */
function CategoryOverview({ wide }: { wide: boolean }) {
  const { push } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        CHANNELS.map(async (c) => {
          try {
            const res = await api.category(c.cate, 1, 8);
            return [c.cate, res?.items || []] as const;
          } catch {
            return [c.cate, [] as VideoCard[]] as const;
          }
        }),
      );
      let p: Post[] = [];
      try { p = (await api.posts(1, 8))?.items || []; } catch { p = []; }
      if (!alive) return;
      setRows(Object.fromEntries(entries));
      setPosts(p);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-1" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="flex items-end gap-2.5">
          <span className="text-[24px] font-bold text-on leading-none">分类</span>
          <span className="text-[11px] text-mut pb-0.5">{CHANNELS.length + 1} 个频道 · 每周持续上新</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2">
        {/* 排行榜入口 */}
        <button onClick={() => push({ kind: "ranks" })}
          className="mx-4 mb-5 w-[calc(100%-2rem)] flex items-center gap-3 rounded-(--r-md) bg-s2 p-3.5 text-left pressable elev-1">
          <span className="w-10 h-10 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center shrink-0"><ITrophy size={20} /></span>
          <span className="flex-1">
            <span className="block text-[14.5px] font-semibold text-on">排行榜</span>
            <span className="block text-[10.5px] text-mut mt-0.5">热播榜 · 推荐榜 · 潜力榜</span>
          </span>
          <IChevR size={16} className="text-mut" />
        </button>

        {CHANNELS.map((c, ci) => {
          const list = rows[c.cate] || [];
          return (
            <section key={c.cate} className="mb-5 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <button onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
                <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
                  <IGrid size={19} strokeWidth={1.9} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold text-on leading-tight">{c.name}</span>
                  <span className="block text-[10.5px] text-mut mt-0.5 truncate">{c.desc}</span>
                </span>
                <span className="flex items-center gap-0.5 text-[11.5px] text-mut group-hover:text-primary transition-colors">
                  全部<IChevR size={14} />
                </span>
              </button>
              <div className="scroll-x flex gap-2.5 px-4 snap-x">
                {list.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: c.name })} />
                ))}
                {!list.length && <div className="h-[150px] flex items-center text-[11.5px] text-dim px-1">{loading ? "加载中…" : "暂无内容"}</div>}
              </div>
            </section>
          );
        })}

        {/* 吃瓜 */}
        <section className="mb-5 a-rise">
          <button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
            <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
              <IGrid size={19} strokeWidth={1.9} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15.5px] font-semibold text-on leading-tight">黄果吃瓜</span>
              <span className="block text-[10.5px] text-mut mt-0.5 truncate">圈内爆料 · 每日更新</span>
            </span>
            <span className="flex items-center gap-0.5 text-[11.5px] text-mut group-hover:text-primary transition-colors">
              全部<IChevR size={14} />
            </span>
          </button>
          <div className="scroll-x flex gap-2.5 px-4 snap-x">
            {posts.map((post) => (
              <button key={post.id} onClick={() => push({ kind: "post", id: post.id })}
                className="w-[104px] shrink-0 text-left snap-start pressable">
                <div className="relative w-full rounded-(--r-sm) overflow-hidden bg-s1 elev-1" style={{ paddingTop: "133%" }}>
                  <Img src={post.cover} />
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" />
                  <span className="absolute bottom-1.5 right-1.5 text-[9px] font-semibold text-white/90 tsh">{fmt(post.hot)}</span>
                </div>
                <div className="mt-1.5 text-[11.5px] font-medium text-on clamp-1 leading-tight">{post.title}</div>
              </button>
            ))}
            {!posts.length && <div className="h-[150px] flex items-center text-[11.5px] text-dim px-1">{loading ? "加载中…" : "暂无内容"}</div>}
          </div>
        </section>

        <div className="px-4 text-center text-[10.5px] text-dim pt-1">— 已展示全部频道 —</div>
      </div>
      {wide && <div />}
    </div>
  );
}

/* ================= 频道详情页 ================= */
export function ChannelPage({ cate, name, onBack, wide, active }: { cate: string; name: string; onBack: () => void; wide: boolean; active: boolean }) {
  const { push } = useStore();
  const [sort, setSort] = useState<"最新" | "最热" | "高分">("最新");
  const sortOptions = ["最新", "最热", "高分"] as const;
  const sortIndex = sortOptions.indexOf(sort);
  const tabs = useIOSTabSwipe({ index: sortIndex, count: sortOptions.length, onChange: (index) => setSort(sortOptions[index]), enabled: isIos && active });
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.category(cate, next, 20);
      setItems((previous) => appendUniqueById(previous, res?.items || []));
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message || "加载失败");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || err) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, err, sort]);

  const sorted = [...items].sort((a, b) => {
    if (sort === "最热") return (b.hot || 0) - (a.hot || 0);
    if (sort === "高分") return (b.score || 0) - (a.score || 0);
    return b.id - a.id;
  });

  const open = (id: number, list = sorted) => {
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) push({ kind: "feed", videoIds: list.map((item) => item.id), index, title: name });
  };
  const scroll = useIOSBrowseCoverMenu(active, open, sort);

  const segmentButtons = sortOptions.map((s, index) => (
        <button key={s} aria-pressed={sortIndex === index} onClick={() => isIos ? tabs.select(index) : setSort(s)}
          className={`px-4 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${sort === s ? "tonal text-on-sec" : "bg-s3 text-mut"}`}
          style={sort === s ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{s}</button>
  ));
  const segments = isIos
    ? <IOSSwipeSegments controller={tabs} label="频道排序">{segmentButtons}</IOSSwipeSegments>
    : <div role="group" aria-label="频道排序" className="hg-ios-segments flex min-w-0 flex-1 gap-2">{segmentButtons}</div>;

  const renderPane = (index: number, committed: boolean) => {
    const paneSort = sortOptions[index];
    const paneItems = [...items].sort((a, b) => {
      if (paneSort === "最热") return (b.hot || 0) - (a.hot || 0);
      if (paneSort === "高分") return (b.score || 0) - (a.score || 0);
      return b.id - a.id;
    });

    return <div ref={committed ? scroll : undefined} className="hg-ios-browse-content flex-1 scroll-y px-4 pt-3 pb-8">
      {paneItems.length ? (
        <Masonry videos={paneItems} wide={wide} onOpen={(v) => { if (committed) open(v.id, paneItems); }} />
      ) : loading || (page === 0 && !err) ? (
        <div className="flex justify-center py-10" role="status" aria-label="正在加载频道">
          <div className="w-8 h-8 spinner" />
        </div>
      ) : err ? <PageStatus title="频道加载失败" onRetry={loadMore} />
        : <PageStatus title="暂无内容" />}
      {err && paneItems.length > 0 && !loading && <div className="mt-2"><PageStatus title="更多作品加载失败" onRetry={loadMore} /></div>}
      {committed && !err && page < pages && <div ref={sentinel} className="h-10" />}
      {loading && paneItems.length > 0 && (
        <div className="flex justify-center py-3" role="status" aria-label="正在加载更多">
          <div className="w-6 h-6 spinner" />
        </div>
      )}
      {!loading && page >= pages && paneItems.length > 0 && (
        <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>
      )}
    </div>;
  };

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IOSPageBar label={name} onBack={onBack}>{segments}</IOSPageBar> : (
        <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
            <button onClick={onBack} aria-label="返回" className="hg-ios-back w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
            <span className="w-[40px] h-[40px] rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IGrid size={21} strokeWidth={1.9} /></span>
            <div className="flex-1 min-w-0">
              <div className="text-[17px] font-bold text-on leading-tight">{name}</div>
              <div className="text-[10.5px] text-mut">共 {items.length} 部 · 已加载 {page}/{Math.max(pages, 1)} 页</div>
            </div>
          </div>
          <div className="px-4 pb-3">{segments}</div>
        </div>
      )}

      {isIos ? <IOSTabPages controller={tabs}>{renderPane}</IOSTabPages> : renderPane(sortIndex, true)}
    </div>
  );
}
