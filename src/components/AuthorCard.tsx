import { isIos } from "../api";
import type { Author } from "../types";
import { IChevR } from "../icons";
import { Avatar, CompactAction } from "./ui";

export function AuthorCard({ author, onOpen, follow, className = "" }: {
  author: Pick<Author, "id" | "name">; onOpen: () => void;
  follow?: { active: boolean; onToggle: () => void }; className?: string;
}) {
  const available = Number.isSafeInteger(author.id) && author.id > 0;
  return <div className={`hg-ios-content-card flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5 ${className}`}>
    <button type="button" onClick={onOpen} disabled={!available}
      aria-label={`查看作者 ${author.name} 的全部作品`}
      className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left pressable disabled:pointer-events-none">
      <Avatar size={isIos ? 32 : 34} name={author.name} hue={220} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-on">{author.name}</div>
        <div className="text-[10px] text-mut">作者</div>
      </div>
      {available && <IChevR size={15} className="shrink-0 text-mut" />}
    </button>
    {follow && available && (isIos ? (
      <CompactAction className="hg-ios-detail-follow" tone={follow.active ? "neutral" : "accent"} onClick={follow.onToggle}>
        {follow.active ? "已关注" : "关注"}
      </CompactAction>
    ) : (
      <button type="button" onClick={follow.onToggle}
        className={`h-7 rounded-full px-3 text-[11px] font-semibold pressable ${follow.active ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
        {follow.active ? "已关注" : "+ 关注"}
      </button>
    ))}
  </div>;
}
