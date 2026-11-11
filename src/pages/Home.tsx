import { useCallback, useEffect, useRef, useState } from "react";
import { appendUniqueById } from "../collections";
import LinePicker from "../components/LinePicker";
import Feed from "../components/Feed";
import { IOSAccountButton, IOSPageBar, IOSRanksButton } from "../components/IOSPageBar";
import { api, isIos, isMobile } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { CompactAction, LoadingStatus } from "../components/ui";
import { ISearch, IVol, IVolMute } from "../icons";

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { muted, setMuted, setTab, toast, fs } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [initialError, setInitialError] = useState("");
  const [done, setDone] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async (p: number) => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    if (p === 1) setInitialError("");
    try {
      const res = await api.feed(p, 10);
      const list = res?.items || [];
      setItems((previous) => appendUniqueById(previous, list));
      setPage(p);
      if (!list.length || (res?.pagination && p >= res.pagination.pages)) setDone(true);
    } catch (e) {
      const message = (e as Error).message || "加载失败，请稍后重试";
      if (p === 1) setInitialError(message);
      else toast(message, "info");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [done, toast]);

  useEffect(() => { if (!items.length) load(1); /* eslint-disable-next-line */ }, []);

  const ids = items.map((v) => v.id);

  return (
    <div className="hg-home-video absolute inset-0 bg-black">
      {items.length ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={() => { if (!loading && !done) load(page + 1); }} />
      ) : initialError || done ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white">
          <p role="status" className="text-sm text-white/80">{initialError || "暂时没有可播放的内容"}</p>
          {initialError && <div className={`flex flex-wrap justify-center ${isIos ? "gap-1" : "gap-2"}`}>
            {isIos ? <>
              <CompactAction tone="neutral" onClick={() => void load(1)}>重试</CompactAction>
              <CompactAction tone="neutral" onClick={() => setLineOpen(true)}>查看线路</CompactAction>
            </> : <>
            <button onClick={() => void load(1)} className="hg-chip rounded-full px-5 py-2 text-sm pressable">重试</button>
            <button onClick={() => setLineOpen(true)} className="hg-chip rounded-full px-5 py-2 text-sm pressable">查看线路</button>
            </>}
          </div>}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><LoadingStatus variant="initial" label="正在加载首页" /></div>
      )}

      {lineOpen && <LinePicker open={lineOpen} onClose={() => setLineOpen(false)} />}

      {isIos && !fs && (
        <IOSPageBar label="首页工具" overMedia endAction={<IOSAccountButton overMedia />} startAction={<IOSRanksButton overMedia />}>
          <button type="button" aria-label="搜索" onClick={() => setTab("search")}
            className="flex min-w-0 flex-1 h-11 items-center justify-center gap-2 px-2 text-[13px]">
            <ISearch size={16} />
            <span className="truncate">搜索短剧、作者、题材…</span>
          </button>
        </IOSPageBar>
      )}

      {/* Android：静音 + 搜索（压在视频上，固定白字 + 半透明黑底） */}
      {isMobile && !isIos && !fs && (
        <div className="absolute inset-x-0 z-20 flex items-center px-3 pointer-events-none hg-player-ui" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setMuted((m) => !m)} aria-label={muted ? "取消静音" : "静音"}
              className="hg-chip pointer-events-auto w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
              {muted ? <IVolMute size={17} /> : <IVol size={17} />}
            </button>
            <button onClick={() => setTab("search")} aria-label="搜索"
              className="hg-chip pointer-events-auto w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
              <ISearch size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
