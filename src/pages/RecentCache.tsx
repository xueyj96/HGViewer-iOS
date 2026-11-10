import { useState } from "react";
import { api, type RecentPlayback } from "../api";
import { CacheDeleteDialog, CachePageFrame, cacheSize } from "../components/CachePageFrame";
import { CompactAction, PageStatus } from "../components/ui";
import { useOfflineStatus } from "../components/useOfflineStatus";
import { IDownload, ITrash } from "../icons";

export default function RecentCache({ onBack, active }: { onBack: () => void; active: boolean }) {
  const { state, readError, refresh, busy, actionError: error, runAction: run } = useOfflineStatus(active);
  const [pending, setPending] = useState<RecentPlayback>();
  const groups = new Map<number, RecentPlayback[]>();
  const recent = state?.recent ?? [];
  const jobs = new Map(state?.jobs.map((job) => [job.id, job]));
  const last = state?.last;

  for (const item of recent) {
    const group = groups.get(item.id);
    if (group) group.push(item);
    else groups.set(item.id, [item]);
  }

  const overlay = pending && <CacheDeleteDialog message={`删除第 ${pending.ep} 集的临时播放缓存？`}
    disabled={busy || jobs.get(pending.id)?.watch_key === pending.key} onCancel={() => setPending(undefined)}
    onDelete={() => {
      const key = pending.key;
      setPending(undefined);
      void run(() => api.watchDiscard(key));
    }} />;

  return <CachePageFrame title="最近播放缓存" onBack={onBack} overlay={overlay}>
    <div className="space-y-3">
      {recent.length > 0 && <section aria-label="缓存信息" className="hg-ios-grouped-list rounded-(--r-md) bg-s2 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
          <span className="font-semibold text-on">临时缓存 {recent.length} 集</span>
          <span className="text-mut">{cacheSize(recent.reduce((sum, item) => sum + item.bytes, 0))}</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-mut">保留后可离线播放。</p>
      </section>}
      {readError && <PageStatus title="缓存读取失败" onRetry={() => void refresh().catch(() => {})} />}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {last?.watch_key != null && last.message && last.message !== "缓存完成" &&
        recent.some((item) => item.key === last.watch_key) &&
        <p role="status" className="text-xs text-mut">{last.message}</p>}
      {!state && !readError && <p role="status" className="text-sm text-mut">正在读取缓存…</p>}
      {state && !groups.size && !readError && <PageStatus title="暂无最近播放缓存。" />}
      {[...groups].map(([id, items]) => (
        <section key={id} className="hg-ios-grouped-list rounded-(--r-md) bg-s2 px-3">
          <h2 className="border-b border-s3 py-3 text-sm font-semibold text-on [overflow-wrap:anywhere]">{items[0].title || "未命名剧集"}</h2>
          <div className="divide-y divide-s3">
            {items.map((item) => {
              const job = jobs.get(id);
              const preserving = job?.watch_key === item.key;
              const fill = !!item.needs_fill || (last?.watch_key === item.key && !!last.needs_fill);
              return <div key={item.key} className="flex min-h-14 flex-wrap items-center gap-x-[var(--ios-control-gap,8px)]">
                <div className="min-w-16 flex-1 py-2">
                  <div className="text-xs font-semibold text-on">第 {item.ep} 集</div>
                  <div className="mt-0.5 text-[11px] tabular-nums text-mut">
                    {cacheSize(item.bytes)}{preserving && (job.stopping ? " · 正在停止" : job.running ? " · 保留中" : " · 排队中")}
                  </div>
                </div>
                {preserving
                  ? <CompactAction tone="neutral" disabled={busy || job.stopping} onClick={() => void run(() => api.offlineStop(id))}>
                      停止保留
                    </CompactAction>
                  : <CompactAction disabled={busy || !!job} onClick={() => void run(() => api.watchSave(item.key, fill))}>
                      <IDownload size={13} aria-hidden="true" />
                      {fill ? "补齐并保留" : "保留本集"}
                    </CompactAction>}
                <button type="button" className="grid size-11 shrink-0 place-items-center pressable disabled:opacity-50"
                  aria-label={`删除第 ${item.ep} 集临时缓存`} disabled={busy || preserving}
                  onClick={() => setPending(item)}>
                  <span className="hg-ios-cache-action-face grid size-7 place-items-center rounded-full bg-danger/10 text-danger">
                    <ITrash size={14} aria-hidden="true" />
                  </span>
                </button>
              </div>;
            })}
          </div>
        </section>
      ))}
    </div>
  </CachePageFrame>;
}
