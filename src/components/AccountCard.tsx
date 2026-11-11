import { APP_NAME, fmt, isIos } from "../api";
import { useStore } from "../store";
import { IChevR, ILogout, IUser } from "../icons";
import { Avatar } from "./ui";

export default function AccountCard() {
  const { user, setLoginOpen, logout, history, favs } = useStore();
  return user ? (
    <div className="hg-ios-account-row rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
      <Avatar size={isIos ? 32 : 56} name={user.nickname} hue={280} ring={!isIos} />
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
        <div className="text-[11px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
        <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
          <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
          <span>收藏 <b className="text-on">{fmt(user.counts?.collect)}</b></span>
          <span>关注 <b className="text-on">{fmt(user.counts?.following)}</b></span>
        </div>
      </div>
      <button onClick={async () => { await logout(); }}
        className="hg-ios-account-logout grid size-11 shrink-0 place-items-center text-mut pressable" aria-label="退出登录">
        <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-s3">
          <ILogout size={17} />
        </span>
      </button>
    </div>
  ) : (
    <button onClick={() => setLoginOpen(true)}
      className="hg-ios-account-row w-full text-left rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 pressable a-rise">
      <Avatar size={isIos ? 32 : 56} icon={<IUser size={isIos ? 16 : 26} />} hue={220} ring={!isIos} />
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-bold text-on">{isIos ? `登录 ${APP_NAME}` : "未登录"}</div>
        <div className="text-[11px] text-mut mt-0.5">登录后可同步点赞、收藏与评论</div>
        {!isIos && <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
          <span>收藏 <b className="text-on">{favs.length}</b></span>
          <span>观看 <b className="text-on">{history.length}</b></span>
        </div>}
      </div>
      {isIos ? <IChevR size={16} className="text-dim" /> : (
        <span className="flex items-center gap-0.5 h-8 pl-3 pr-2 rounded-full bg-primary text-on-primary text-[11.5px] font-semibold">
          登录<IChevR size={13} />
        </span>
      )}
    </button>
  );
}
