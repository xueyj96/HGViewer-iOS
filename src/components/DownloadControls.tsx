import type { OfflineJob } from "../api";
import { ICheck, IDownload, IPauseF, IPlayF } from "../icons";
import { CompactAction } from "./ui";

export function CompactDownloadButton({ children, disabled, onClick }: {
  children: string; disabled?: boolean; onClick: () => void;
}) {
  return <CompactAction disabled={disabled} onClick={onClick}>
    <IDownload size={13} aria-hidden="true" />
    {children}
  </CompactAction>;
}

export function CachedEpisodeMark() {
  return <ICheck size={12} className="shrink-0 text-primary" aria-hidden="true" />;
}

export function episodeDownloadPercent(job: OfflineJob | undefined, ep: number) {
  if (!job?.running || job.stopping || job.message || job.ep !== ep || !job.transfer_total) return undefined;
  return Math.min(99, Math.max(0, Math.floor((job.transfer_done ?? 0) * 100 / job.transfer_total)));
}

export function EpisodeDownloadLabel({ ep, cached, percent }: {
  ep: number; cached: boolean; percent?: number;
}) {
  return <>
    {percent !== undefined && percent > 0 && <span aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 rounded-l-[inherit] bg-primary/25 motion-safe:transition-[width] motion-safe:duration-200"
      style={{ width: `${percent}%` }} />}
    <span className="relative">第 {ep} 集</span>
    {cached && <CachedEpisodeMark />}
  </>;
}

export function downloadSpeed(job?: OfflineJob) {
  if (!job?.running || job.stopping) return undefined;
  const bytesPerSecond = job.bytes_per_second ?? 0;
  return bytesPerSecond >= 1048576
    ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`
    : `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

export function downloadStatus(job: OfflineJob) {
  if (job.stopping) return job.watch_key != null ? "正在停止" : "正在暂停";
  if (job.paused) return "已暂停";
  if (job.queued) return "排队中";
  return "下载中";
}

export function downloadFraction(job: OfflineJob) {
  const episode = episodeDownloadPercent(job, job.ep);
  if (job.total > 0 && (job.done > 0 || episode !== undefined)) {
    return Math.min(1, (job.done + (episode ?? 0) / 100) / job.total);
  }
  return job.running && !job.stopping ? undefined : 0;
}

function DownloadTrack({ fraction, muted }: { fraction?: number; muted: boolean }) {
  return <span aria-hidden="true" className="block h-1.5 w-full overflow-hidden rounded-full bg-s3">
    <span className={`block h-full rounded-full ${muted ? "bg-mut" : "bg-primary"} ${fraction === undefined && !muted ? "motion-safe:animate-pulse" : ""}`}
      style={{ width: fraction === undefined ? "25%" : `${fraction * 100}%` }} />
  </span>;
}

export function DownloadProgressCard({ job, disabled, onToggle }: {
  job: OfflineJob; disabled: boolean; onToggle: () => void;
}) {
  const isCapture = job.watch_key != null;
  const action = job.paused ? "继续下载" : isCapture ? "停止保留" : "暂停下载";
  const counts = job.total > 0 ? `${job.done} / ${job.total}` : undefined;
  const idle = !job.running || job.stopping;
  const note = [idle && downloadStatus(job), counts].filter(Boolean).join(" · ");
  return <button type="button" aria-label={action}
    aria-description={[downloadStatus(job), counts && `已完成 ${counts} 集`].filter(Boolean).join(" · ")}
    disabled={disabled || job.stopping}
    onClick={onToggle}
    className="flex min-h-14 w-full items-center gap-3 rounded-(--r-md) bg-s2 px-3 py-2 text-left pressable disabled:opacity-60">
    <span className="min-w-0 flex-1">
      {counts || !idle
        ? <DownloadTrack fraction={downloadFraction(job)} muted={idle} />
        : <span className="text-xs text-mut">{downloadStatus(job)}</span>}
    </span>
    {note && (counts || !idle) && <span aria-hidden="true" className="text-[11px] tabular-nums text-mut">{note}</span>}
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
      {job.paused ? <IPlayF size={14} aria-hidden="true" /> : isCapture
        ? <span aria-hidden="true" className="size-2.5 rounded-xs bg-current" />
        : <IPauseF size={14} aria-hidden="true" />}
    </span>
  </button>;
}
