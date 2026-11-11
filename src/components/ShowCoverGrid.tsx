import type { ReactNode } from "react";
import { IPlayF } from "../icons";
import { Img } from "./ui";
import type { DownloadAction } from "./IOSCoverMenu";

export function ShowCoverGrid({ compact, children }: { compact: boolean; children: ReactNode }) {
  return <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-3"}`}>{children}</div>;
}

export function ShowCoverCard({ title, cover, local = false, badge, menu, progress, onClick }: {
  title: string; cover?: string; local?: boolean; badge?: string;
  menu?: { id: number; canCache?: boolean; download?: DownloadAction; downloadBlocked?: boolean };
  progress?: { fraction?: number; label: string; paused: boolean; speed?: string; networkSpeed?: string };
  onClick: () => void;
}) {
  const placeholder = <span className="absolute inset-0 grid place-items-center bg-s2 text-dim" aria-hidden="true"><IPlayF size={23} /></span>;
  const percent = progress?.fraction === undefined ? undefined : Math.floor(progress.fraction * 100 + 1e-8);
  const progressLabel = progress && [progress.label, percent !== undefined && `${percent}%`].filter(Boolean).join(" · ");
  return (
    <div className="relative min-w-0">
      <button type="button" onClick={onClick} data-hg-menu-card={menu?.id} data-hg-can-cache={menu?.canCache}
        data-hg-download-action={menu?.download} data-hg-download-blocked={menu?.downloadBlocked}
        aria-description={[progressLabel, progress?.speed, progress?.networkSpeed, menu && "长按打开剧集操作"].filter(Boolean).join(" ") || undefined}
        className={`relative block w-full aspect-[3/4] overflow-hidden rounded-(--r-sm) bg-s1 text-left elev-1 pressable ${menu ? "select-none [-webkit-touch-callout:none] [&_img]:pointer-events-none" : ""}`}>
        {cover ? <Img key={cover} src={cover} raw={local} fallback={placeholder} /> : placeholder}
        {percent !== undefined && percent > 0 && <span aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 motion-safe:transition-[height] motion-safe:duration-300 ${progress?.paused ? "bg-white/20" : "bg-primary/35"}`}
          style={{ height: `${percent}%` }} />}
        {(progressLabel || badge) && <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[9.5px] leading-none text-white/90">
          {progressLabel || badge}
        </span>}
        {progress?.speed && <span aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center px-1">
          <span className="flex flex-wrap justify-center gap-x-2 whitespace-nowrap rounded-(--r-sm) bg-black/70 px-2 py-1 text-xs font-semibold tabular-nums text-white">
            <span>{progress.speed}</span>
            {progress.networkSpeed && <span>{progress.networkSpeed}</span>}
          </span>
        </span>}
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2">
          <span className="clamp-2 text-[10.5px] leading-tight text-white">{title}</span>
        </span>
      </button>
    </div>
  );
}
