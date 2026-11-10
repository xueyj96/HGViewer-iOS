import { useEffect, useRef, useState } from "react";
import { appendUniqueById } from "../collections";
import { api, isIos, isMobile, fmt } from "../api";
import type { RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { IOSPageBar } from "../components/IOSPageBar";
import { useIOSBrowseCoverMenu } from "../components/IOSCoverMenu";
import { Masonry, RankRow } from "../components/cards";
import { CompactAction, PageStatus } from "../components/ui";
import { IBack, IClose, IFireF, IRefresh, ISearch, ITrophy } from "../icons";

const HOT_TAGS = ["都市", "逆袭", "古风", "系统", "后宫", "校园", "仙侠", "职场", "大男主", "御姐", "脑洞", "奇幻"];

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, toast, setTab } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const searchRevision = useRef(0);

  const open = (id: number) => {
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) push({ kind: "feed", videoIds: items.map((item) => item.id), index, title: `搜索 · ${submitted}` });
  };
  const scroll = useIOSBrowseCoverMenu(active, open);

  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const run = async (keyword: string, p: number) => {
    if (p > 1 && (busy.current || p > pages)) return;
    const revision = ++searchRevision.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.search(keyword, p, 20);
      if (revision !== searchRevision.current) return;
      setItems((previous) => appendUniqueById(p === 1 ? [] : previous, res?.items || []));
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      setErr(null);
    } catch (e) {
      if (revision === searchRevision.current) setErr((e as Error).message || "搜索失败");
    } finally {
      if (revision === searchRevision.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setSubmitted(k);
    addSearch(k);
    setItems([]);
    setErr(null);
    setPages(1);
    void run(k, 1);
  };

  const clearQuery = () => {
    ++searchRevision.current;
    busy.current = false;
    setLoading(false);
    setErr(null);
    setQ("");
    setSubmitted("");
    setItems([]);
  };

  const querying = submitted.length > 0;

  const searchField = (
    <form className="hg-ios-search-field min-w-0 flex-1 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors"
      onSubmit={(e) => { e.preventDefault(); submit(q); if (isIos && q.trim()) inputRef.current?.blur(); }}>
      <ISearch size={17} className="text-mut shrink-0" />
      <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索短剧、作者、题材…" type="search" enterKeyHint="search"
        className="flex-1 min-w-0 bg-transparent text-[13.5px] text-on placeholder-dim outline-none" />
      {q && <button type="button" aria-label="清除关键词" onClick={clearQuery}
        onPointerDown={(event) => {
          if (inputRef.current === document.activeElement) event.preventDefault();
        }}
        className="hg-ios-search-cancel grid size-5 shrink-0 place-items-center text-mut pressable">
        <span className="grid size-5 place-items-center rounded-full bg-s4"><IClose size={11} /></span>
      </button>}
    </form>
  );
  const rankButton = (
    <button type="button" onClick={() => push({ kind: "ranks" })} aria-label="排行榜"
      className="w-11 h-11 rounded-(--r-sm) flex items-center justify-center bg-primary text-on-primary pressable elev-2">
      <ITrophy size={17} />
    </button>
  );

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IOSPageBar label="搜索" onBack={() => setTab("home")}>{searchField}</IOSPageBar> : (
        <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
          {searchField}
          {rankButton}
        </div>
      )}

      <div ref={scroll} className="hg-ios-browse-content hg-ios-search-content flex-1 scroll-y px-4 pb-24">
        {!querying ? (
          <>
            {searchHist.length > 0 && (
              <div className={`hg-ios-content-card a-rise ${isIos ? "" : "mt-1"}`}>
                <div className="hg-ios-search-card-heading flex items-center justify-between">
                  <span className="hg-ios-section-label text-[13px] font-bold text-on">{isIos ? "最近搜索" : "搜索历史"}</span>
                  <CompactAction tone="neutral" className="hg-ios-search-clear" onClick={clearSearchHist}>清空</CompactAction>
                </div>
                <div className="hg-ios-search-tag-list flex flex-wrap gap-2 mt-2.5">
                  {searchHist.map((h) => (
                    <button key={h} onClick={() => { setQ(h); submit(h); }} className="hg-ios-search-tag px-3.5 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-on/80 pressable">{h}</button>
                  ))}
                </div>
              </div>
            )}
            {!isIos && searchHist.length > 0 && <hr className="mt-4 border-0 border-t border-s3" />}

            <div className="hg-ios-search-topics hg-ios-content-card mt-5 rounded-(--r-md) bg-s2 p-3.5 a-rise">
              <div className="hg-ios-search-card-heading flex items-center justify-between">
                <span className="hg-ios-section-label flex items-center gap-1.5 text-[13px] font-semibold text-on/90">{!isIos && <IFireF size={15} className="text-primary" />}热门题材</span>
                {!isIos && <button onClick={() => push({ kind: "ranks" })} className="text-[11px] text-primary font-semibold pressable">完整榜单 ›</button>}
              </div>
              <div className="hg-ios-search-tag-list flex flex-wrap gap-2 mt-3">
                {HOT_TAGS.map((t) => (
                  <button key={t} onClick={() => { setQ(t); submit(t); }}
                    className="hg-ios-search-tag px-3 h-7 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">{t}</button>
                ))}
              </div>
            </div>

            {!isIos && <>
            <div className="flex items-center justify-between mt-6 mb-2.5">
              <span className="text-[13px] font-bold text-on">为你推荐</span>
              <button onClick={() => submit(HOT_TAGS[Math.floor(Math.random() * HOT_TAGS.length)])}
                className="flex items-center gap-1 text-[11.5px] text-mut pressable"><IRefresh size={13} />换一批</button>
            </div>
            <p className="text-[11.5px] text-dim leading-relaxed">
              输入关键词后按回车搜索，也可以点上面的题材直接看片单。
            </p>
            </>}
          </>
        ) : (
          <>
            {!isIos && <div className="text-[11.5px] text-mut mt-1 mb-2.5">「{submitted}」共 <span className="text-primary font-bold">{items.length}</span> 条结果</div>}
            {items.length ? (
              <>
                <Masonry videos={items} wide={wide} onOpen={(v) => open(v.id)} />
                {err && !loading ? <div className="mt-2"><PageStatus title="搜索结果加载失败" onRetry={() => void run(submitted, page + 1)} /></div>
                  : (!isIos || loading || page < pages) && <div className="flex justify-center py-4">
                  {loading ? <div className="w-6 h-6 spinner" />
                    : page < pages ? (
                      <button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">加载更多</button>
                    ) : !isIos && <span className="text-[10.5px] text-dim">— 已经到底啦 —</span>}
                </div>}
              </>
            ) : loading ? (
              <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
            ) : err ? <PageStatus title="搜索失败" onRetry={() => void run(submitted, 1)} />
              : <PageStatus title="没有找到相关内容" detail="换个关键词试试。" />}
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 排行榜 ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜", desc: "按热力指数排序" },
  { k: "recommend", label: "推荐榜", desc: "按推荐值排序" },
  { k: "potential", label: "潜力榜", desc: "按潜力值排序" },
] as const;

export function RankPage({ onBack, wide, active }: { onBack: () => void; wide: boolean; active: boolean }) {
  const { push } = useStore();
  const [tab, setTab] = useState<"hot" | "recommend" | "potential">("hot");
  const [items, setItems] = useState<RankItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  const meta = RANK_TABS.find((t) => t.k === tab)!;
  const open = (id: number) => {
    const index = items.findIndex((item) => item.video_id === id);
    if (index >= 0) push({ kind: "feed", videoIds: items.map((item) => item.video_id), index, title: meta.label });
  };
  const scroll = useIOSBrowseCoverMenu(active, open);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    api.rank(tab)
      .then((res) => { if (alive) setItems(res?.items || []); })
      .catch(() => { if (alive) { setItems([]); setFailed(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, retry]);

  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));

  const segments = (
    <div role="group" aria-label="榜单类型" className="hg-ios-segments flex min-w-0 flex-1 bg-s3 rounded-(--r-ctl) p-1">
      {RANK_TABS.map((t) => (
        <button key={t.k} aria-pressed={tab === t.k} onClick={() => {
            if (tab === t.k) return;
            setItems([]);
            setLoading(true);
            setTab(t.k);
          }}
          className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold transition-all ${tab === t.k ? "tonal elev-1" : "text-mut"}`}>{t.label}</button>
      ))}
    </div>
  );

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      {isIos ? <IOSPageBar label="排行榜" onBack={onBack}>{segments}</IOSPageBar> : (
        <div className="hg-ios-page-heading shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
          <div className="relative px-3 pt-2 pb-4">
            <button onClick={onBack} aria-label="返回" className="hg-ios-back w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
            <div className="px-2 mt-1 flex items-end justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ITrophy size={20} /></span>
                  <span className="hg-ios-large-title text-[24px] font-bold tracking-wide text-on">HG 热榜</span>
                </div>
                <div className="text-[11px] text-mut mt-1">{meta.desc} · 每 10 分钟更新</div>
              </div>
            </div>
            <div className="mt-3">{segments}</div>
          </div>
        </div>
      )}

      <div ref={scroll} className="hg-ios-browse-content flex-1 scroll-y px-3.5 pt-3 pb-8">
        {loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : items.length ? (
          items.map((it) => (
            <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
              onOpen={() => open(it.video_id)} />
          ))
        ) : failed ? <PageStatus title="榜单加载失败" onRetry={() => setRetry((n) => n + 1)} />
          : <PageStatus title="榜单暂时为空" />}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}
