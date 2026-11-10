import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IBack, IClose, ITrophy, IUser } from "../icons";
import { useStore } from "../store";
import { useIOSNavigation } from "./IOSNavigation";

export function IOSCloseButton({ onClose, label = "关闭" }: { onClose: () => void; label?: string }) {
  return <button type="button" onClick={onClose} aria-label={label}
    className="hg-ios-floating-button hg-ios-header-square grid size-11 shrink-0 place-items-center rounded-(--r-ctl) text-on pressable">
    <IClose size={16} aria-hidden="true" />
  </button>;
}

export function IOSBackButton({ onBack, overMedia = false, label = "返回" }: {
  onBack?: () => void;
  overMedia?: boolean;
  label?: string;
}) {
  return (
    <button type="button" onClick={onBack} aria-label={label}
      className={`hg-ios-floating-button hg-ios-header-back grid shrink-0 place-items-center ${overMedia ? "hg-ios-media-top-button pointer-events-auto" : ""}`}>
      <IBack size={16} />
    </button>
  );
}

export function IOSAccountButton({ onClick, overMedia = false }: {
  onClick: () => void;
  overMedia?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-label="我的"
      className={`hg-ios-account grid place-items-center ${overMedia ? "hg-home-account relative size-11" : "hg-ios-header-square hg-ios-floating-button"}`}>
      <IUser size={20} strokeWidth={1.7} />
    </button>
  );
}

export function IOSRanksButton({ overMedia = false }: { overMedia?: boolean }) {
  const { push } = useStore();
  return <button type="button" aria-label="排行榜" onClick={() => push({ kind: "ranks" })}
    className={`hg-ios-floating-button hg-ios-header-square hg-ios-ranks-button grid place-items-center ${overMedia ? "hg-ios-media-top-button" : ""}`}>
    <ITrophy size={20} aria-hidden="true" />
  </button>;
}

export function IOSPageBar({ label, onBack, children, startAction, endAction, overMedia = false, fillTrailing = false, overlay = false, hidden = false }: {
  label: string;
  onBack?: () => void;
  children?: ReactNode;
  startAction?: ReactNode;
  endAction?: ReactNode;
  overMedia?: boolean;
  fillTrailing?: boolean;
  overlay?: boolean;
  hidden?: boolean;
}) {
  const { host, active, account } = useIOSNavigation();
  const trailing = endAction ?? (overlay ? undefined : account);
  const bar = (
    <div role="group" aria-label={label}
      data-overlay={overlay}
      className={`hg-ios-compact-header hg-ios-floating-bar ${children ? "hg-ios-floating-bar-centered" : ""} ${fillTrailing && !trailing ? "hg-ios-floating-bar-fill-trailing" : ""} ${overMedia ? "hg-clear-chrome hg-ios-floating-bar-over-media" : ""}`}>
      {(onBack || startAction) && <div className="hg-ios-floating-actions">{onBack ? <IOSBackButton onBack={onBack} overMedia={overMedia} /> : startAction}</div>}
      {children && <div className="hg-ios-floating-panel">{children}</div>}
      {trailing && <div className="hg-ios-floating-actions hg-ios-floating-actions-end">{trailing}</div>}
    </div>
  );
  if (!host) return hidden ? null : bar;
  return <>
    {!overMedia && !overlay && <div aria-hidden="true" className="hg-ios-floating-bar-anchor" />}
    {active && !hidden && createPortal(bar, host, label)}
  </>;
}
