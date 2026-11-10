import type { ReactNode, RefObject } from "react";
import { isIos } from "../api";
import { IOSPageBar } from "./IOSPageBar";
import { IBack } from "../icons";
import { ConfirmAction } from "./ui";

export function CachePageFrame({ title, onBack, scroll, overlay, children }: {
  title: string; onBack: () => void; scroll?: RefObject<HTMLDivElement | null>;
  overlay?: ReactNode; children: ReactNode;
}) {
  return <div className="hg-ios-cache-page absolute inset-0 flex flex-col bg-bg">
    {isIos ? (
      <IOSPageBar label={title} onBack={onBack}>
        <h1 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">{title}</h1>
      </IOSPageBar>
    ) : (
      <div className="hg-ios-compact-header flex shrink-0 items-center gap-2 bg-s1 px-2 pb-2"
        style={{ paddingTop: "calc(var(--sat, 0px) + 5px)" }}>
        <button type="button" onClick={onBack} aria-label="返回" className="hg-ios-back grid h-9 w-9 place-items-center">
          <IBack size={19} />
        </button>
        <h1 className="min-w-0 truncate font-semibold text-on">{title}</h1>
      </div>
    )}

    <div ref={scroll} className="hg-ios-browse-content flex-1 scroll-y px-4 py-3 pb-16">
      {children}
    </div>
    {overlay}
  </div>;
}

export function CacheDeleteDialog({ message, disabled, onCancel, onDelete }: {
  message: string; disabled?: boolean; onCancel: () => void; onDelete: () => void;
}) {
  return <ConfirmAction open title="删除缓存" message={message} confirm="删除缓存" cancel="取消删除"
    disabled={disabled} onCancel={onCancel} onConfirm={onDelete} />;
}

export const cacheSize = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
