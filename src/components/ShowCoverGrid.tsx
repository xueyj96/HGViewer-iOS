import type { ReactNode } from "react";
import { IPlayF } from "../icons";
import { Img } from "./ui";
import type { DownloadAction } from "./IOSCoverMenu";
import { DownloadTrack } from "./DownloadControls";

export function ShowCoverGrid({ compact, children }: { compact: boolean; children: ReactNode }) {
  return <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-3"}`}>{children}</div>;
}

export function ShowCoverCard({ title, cover, local = false, badge, menu, progress, onClick }: {
  title: string; cover?: string; local?: boolean; badge?: string;
  menu?: { id: number; canCache?: boolean; download?: DownloadAction; downloadBlocked?: boolean };
  progress?: { fraction?: number; label: string; paused: boolean };
  onClick: () => void;
}) {
  const placeholder = <span className="absolute inset-0 grid place-items-center bg-s2 text-dim" aria-hidden="true"><IPlayF size={23} /></span>;
  return (
    <div className="relative min-w-0">
      <button type="button" onClick={onClick} data-hg-menu-card={menu?.id} data-hg-can-cache={menu?.canCache}
        data-hg-download-action={menu?.download} data-hg-download-blocked={menu?.downloadBlocked}
        aria-description={[progress?.label, menu && "长按打开剧集操作"].filter(Boolean).join(" ") || undefined}
        className={`relative block w-full aspect-[3/4] overflow-hidden rounded-(--r-sm) bg-s1 text-left elev-1 pressable ${menu ? "select-none [-webkit-touch-callout:none] [&_img]:pointer-events-none" : ""}`}>
        {cover ? <Img key={cover} src={cover} raw={local} fallback={placeholder} /> : placeholder}
        {badge && <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[9.5px] leading-none text-white/90">
          {badge}
        </span>}
        <span className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2 ${progress ? "pb-3" : ""}`}>
          <span className="clamp-2 text-[10.5px] leading-tight text-white">{title}</span>
        </span>
        {progress && <DownloadTrack fraction={progress.fraction} muted={progress.paused} onCover />}
      </button>
    </div>
  );
}
