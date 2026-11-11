import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useIOSPageDrag } from "./IOSChannelBackFrame";
import { finishMotion } from "./finishMotion";
import { cover, isIos } from "../api";
import { useStore } from "../store";
import { ICheck, IClose, IHeartF, ISparkF, IStarF } from "../icons";

export function CompactAction({ children, onClick, disabled, tone = "accent", className = "" }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "accent" | "neutral";
  className?: string;
}) {
  return <button type="button" onClick={onClick} disabled={disabled}
    className={`hg-ios-compact-action inline-flex min-h-11 shrink-0 items-center pressable disabled:opacity-50 ${className}`}>
    <span className={`hg-ios-cache-action-face inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold ${tone === "accent" ? "bg-primary/15 text-primary" : "bg-s3 text-on"}`}>
      {children}
    </span>
  </button>;
}

export function EmptyStatus({ children }: { children: React.ReactNode }) {
  return <p role="status" className="py-8 text-center text-sm text-mut">{children}</p>;
}

export function PageStatus({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return <div className="hg-ios-content-card flex items-center justify-between gap-2 rounded-(--r-md) bg-s2 px-3 py-2 text-sm text-on" role="status">
    <div className="min-w-0">
      <p className="font-medium [overflow-wrap:anywhere]">{title}</p>
      {detail && <p className="mt-1 text-xs text-mut">{detail}</p>}
    </div>
    {onRetry && <CompactAction tone="neutral" onClick={onRetry}>重试</CompactAction>}
  </div>;
}

export function PlaybackError({ message, title = "视频暂时无法加载", onRetry, retrying }: {
  message?: string; title?: string; onRetry?: () => void; retrying?: boolean;
}) {
  return <div className="hg-ios-feed-error pointer-events-none absolute inset-0 z-20 grid place-items-center px-4">
    <div className="pointer-events-auto flex max-w-full flex-col items-center gap-2 rounded-(--r-md) bg-black/70 px-4 py-3 text-center text-white" role="status">
      <p className="text-[13px] font-semibold">{title}</p>
      {message && <p className="max-w-[240px] text-xs text-white/75 [overflow-wrap:anywhere]">{message}</p>}
      {onRetry && <button type="button" disabled={retrying}
        className="min-h-11 min-w-11 rounded-(--r-ctl) bg-white/15 px-3 text-xs font-semibold text-white pressable disabled:opacity-60"
        onClick={onRetry}>{retrying ? "加载中…" : "重试"}</button>}
    </div>
  </div>;
}

// Fixed confirmation templates require concise authored copy. Keep the full
// text in accessible names/descriptions if unexpected input needs truncation.
export const CONFIRM_TEXT_LIMITS = { title: 16, message: 60, button: 4 } as const;
function confirmationText(text: string, limit: number) {
  const characters = Array.from(text.trim());
  return characters.length <= limit ? text.trim() : `${characters.slice(0, limit - 1).join("")}…`;
}

export function ConfirmAction({ open, title, message, confirm, cancel = "取消", danger = true, busy, disabled, error, onCancel, onConfirm }: {
  open: boolean; title: string; message: string; confirm: string; cancel?: string; danger?: boolean;
  busy?: boolean; disabled?: boolean; error?: string; onCancel: () => void; onConfirm: () => void;
}) {
  const messageId = useId();
  const dismiss = () => { if (!busy) onCancel(); };
  return <Modal open={open} onClose={dismiss} width={320} height={180} label={title} role="alertdialog" describedBy={messageId}>
    <div className="hg-confirm-content grid h-[180px] grid-rows-[20px_8px_60px_16px_44px] p-4">
      <h2 className="truncate text-center text-sm font-semibold leading-5 text-on">{confirmationText(title, CONFIRM_TEXT_LIMITS.title)}</h2>
      <p id={messageId} role={error ? "alert" : undefined} aria-label={error || message}
        className="row-start-3 line-clamp-3 text-left text-[13px] leading-5 text-on">{confirmationText(error || message, CONFIRM_TEXT_LIMITS.message)}</p>
      <div className="hg-confirm-actions row-start-5 flex flex-wrap items-center justify-between gap-4">
        <button type="button" disabled={busy} aria-label={cancel}
          className="hg-confirm-button inline-flex h-11 w-22 shrink-0 items-center py-1 text-[13px] font-semibold leading-5 pressable disabled:opacity-50"
          onClick={dismiss}><span className="hg-confirm-button-face flex h-9 whitespace-nowrap w-full items-center justify-center rounded-(--r-ctl) bg-s3 px-2 text-on">{confirmationText(cancel, CONFIRM_TEXT_LIMITS.button)}</span></button>
        <button type="button" disabled={disabled || busy} aria-label={confirm}
          className="hg-confirm-button ml-auto inline-flex h-11 w-22 shrink-0 items-center py-1 text-[13px] font-semibold leading-5 pressable disabled:opacity-50"
          onClick={onConfirm}><span className={`hg-confirm-button-face flex h-9 whitespace-nowrap w-full items-center justify-center rounded-(--r-ctl) px-2 ${danger ? "bg-danger/10 text-danger" : "bg-primary text-on-primary"}`}>{confirmationText(confirm, CONFIRM_TEXT_LIMITS.button)}</span></button>
      </div>
    </div>
  </Modal>;
}

/* ——— 头像 ——— */
export function Avatar({ hue = 250, icon, name, size = 40, ring = false, className = "" }: {
  hue?: number; icon?: React.ReactNode; name?: string; size?: number; ring?: boolean; className?: string;
}) {
  const initial = Array.from(name?.replace(/^@/, "").trim() || "H")[0].toUpperCase();
  const inner = (
    <div className="w-full h-full rounded-full flex items-center justify-center overflow-hidden font-semibold"
      style={{ background: `hsl(${hue} 22% 30%)`, color: `hsl(${hue} 70% 88%)` }}>
      {icon ?? <span style={{ fontSize: size * 0.42 }} className="leading-none">{initial}</span>}
    </div>
  );
  return (
    <div className={`shrink-0 ${className}`} style={{ width: size, height: size }}>
      {ring ? <div className="w-full h-full rounded-full p-[2px] bg-primary"><div className="w-full h-full rounded-full bg-bg p-[2px]">{inner}</div></div> : inner}
    </div>
  );
}

const dialogControls = (panel: HTMLElement) =>
  [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]")]
    .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest("[inert]"));

function useDialogFocus(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, sharedChrome = false) {
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!enabled || !panel) return;
    const previous = document.activeElement;
    const scope = panel.closest(sharedChrome ? ".player-root" : ".win-main") ?? document.body;
    const covered: HTMLElement[] = [];
    for (let layer = panel.parentElement; layer && layer !== scope; layer = layer.parentElement) {
      for (const sibling of layer.parentElement?.children ?? []) {
        if (sibling !== layer && sibling instanceof HTMLElement && !sibling.inert) {
          sibling.inert = true;
          covered.push(sibling);
        }
      }
    }
    (dialogControls(panel)[0] ?? panel).focus({ preventScroll: true });
    return () => {
      for (const element of covered) element.inert = false;
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest("[inert]")) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [enabled, ref, sharedChrome]);
}

function keepDialogTab(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const panel = event.currentTarget;
  const controls = dialogControls(panel);
  const edge = event.shiftKey ? controls.at(0) : controls.at(-1);
  if (document.activeElement !== edge && controls.includes(document.activeElement as HTMLElement)) return;
  event.preventDefault();
  (event.shiftKey ? controls.at(-1) ?? panel : controls.at(0) ?? panel).focus();
}

/* ——— 底部弹层 ——— */
export function Sheet({ open, onClose, children, z = "z-40", fullPage, label = fullPage, sharedChrome = false, onPresenceChange }: {
  open: boolean; onClose: () => void; children: React.ReactNode; z?: string; fullPage?: string; label?: string; sharedChrome?: boolean;
  onPresenceChange?: (present: boolean) => void;
}) {
  const [render, setRender] = useState(open);
  const [dragDismissed, setDragDismissed] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const gesture = useIOSPageDrag(pageRef, isIos && open && !!fullPage, () => {
    setDragDismissed(true);
    onClose();
  });
  useEffect(() => {
    if (open) {
      setRender(true);
      setDragDismissed(false);
      return;
    }
    if (isIos && onPresenceChange) {
      return finishMotion(pageRef.current, () => setRender(false));
    }
    const timer = window.setTimeout(() => setRender(false), 230);
    return () => window.clearTimeout(timer);
  }, [open, onPresenceChange]);
  useDialogFocus(pageRef, !!label && open && render, sharedChrome);
  const present = render && (open || !dragDismissed);
  useLayoutEffect(() => onPresenceChange?.(present), [onPresenceChange, present]);
  if (!present) return null;
  return (
    <div className={`absolute inset-0 ${z}`} inert={!open}>
      <div data-dialog-backdrop className={`absolute inset-0 ${open ? "a-fade" : "opacity-0 transition-opacity duration-200"}`}
        style={{ background: fullPage && isIos ? "transparent" : "rgba(0,0,0,.55)" }} onClick={onClose} />
      <div ref={pageRef} role={label ? "dialog" : undefined} aria-label={label}
        aria-modal={label && !sharedChrome ? true : undefined} inert={!!label && !open}
        tabIndex={label ? -1 : undefined} onKeyDown={label ? (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (!sharedChrome) keepDialogTab(event);
        } : undefined} {...gesture}
        className={`hg-ios-sheet absolute bg-s2 elev-3 overflow-hidden ${fullPage ? `hg-ios-sheet-page inset-0 ${open ? "a-page-in" : "a-page-out"}` : `bottom-0 inset-x-0 ${open ? "a-sheet" : "a-sheet-out"}`}`}
        style={fullPage ? undefined : { paddingBottom: "var(--sab, 0px)", borderTopLeftRadius: "var(--r-lg)", borderTopRightRadius: "var(--r-lg)" }}>
        {!fullPage && <div className="hg-ios-sheet-grabber pt-3 pb-1 flex justify-center"><div className="w-8 h-1 rounded-full bg-dim/70" /></div>}
        {children}
      </div>
    </div>
  );
}

/* ——— 居中弹窗 ——— */
export function Modal({ open, onClose, children, width = 340, height, label, role = "dialog", describedBy }: {
  open: boolean; onClose: () => void; children: React.ReactNode; width?: number; height?: number; label?: string;
  role?: "dialog" | "alertdialog"; describedBy?: string;
}) {
  const [render, setRender] = useState(open);
  useEffect(() => {
    if (open) setRender(true);
    else { const t = window.setTimeout(() => setRender(false), 200); return () => window.clearTimeout(t); }
  }, [open]);
  const modalRef = useRef<HTMLDivElement>(null);
  useDialogFocus(modalRef, open && render);
  if (!render) return null;
  return (
    <div className="absolute inset-0 z-[55] flex items-center justify-center p-6" inert={!open}>
      <div data-dialog-backdrop className={`absolute inset-0 bg-black/65 backdrop-blur-sm ${open ? "a-fade" : "opacity-0 transition-opacity"}`} onClick={onClose} />
      <div ref={modalRef} tabIndex={-1} inert={!open} role={role} aria-label={label} aria-describedby={describedBy} aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else keepDialogTab(event);
        }}
        className={`hg-ios-alert relative bg-s3 rounded-(--r-lg) elev-3 ${open ? "a-scale-in" : "opacity-0 scale-90 transition-all"}`} style={height === undefined ? { width, maxWidth: "100%" }
          : { width, minWidth: width, maxWidth: width, height, minHeight: height, maxHeight: height }}>
        {children}
      </div>
    </div>
  );
}

/* ——— 开关 ——— */
export function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: (b: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={() => onChange(!on)} aria-pressed={on} aria-label={label}
      className={`hg-ios-switch relative w-[46px] h-[26px] rounded-full transition-colors duration-200 disabled:opacity-50 disabled:cursor-wait ${on ? "bg-primary" : "bg-s4"}`}>
      <span className={`absolute top-[3px] w-5 h-5 rounded-full elev-1 transition-all duration-200 ${on ? "left-[23px] bg-on-primary" : "left-[3px] bg-mut"}`} />
    </button>
  );
}

/* ——— 空状态 ——— */
export function Empty({ icon, title, sub, action, onAction }: {
  icon: React.ReactNode; title: string; sub?: string; action?: string; onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center a-rise">
      <div className="w-16 h-16 rounded-(--r-md) tonal flex items-center justify-center mb-4">{icon}</div>
      <div className="text-[15px] font-semibold text-on/90">{title}</div>
      {sub && <div className="text-xs text-mut mt-1.5 leading-relaxed">{sub}</div>}
      {action && (
        <button onClick={onAction} className="mt-5 px-6 h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-bold pressable">{action}</button>
      )}
    </div>
  );
}

/* ——— 键帽 ——— */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-(--r-ctl) bg-s4 text-[11px] font-semibold text-on/85 elev-1">{children}</span>;
}

/* ——— Toast ——— */
export function ToastHost() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="absolute inset-x-0 z-[80] flex flex-col items-center gap-2 pointer-events-none px-6" style={{ bottom: "calc(var(--sab, 0px) + 96px)" }}>
      {toasts.map((t) => (
        <div key={t.id} className="a-toast hg-toast pointer-events-auto flex items-center gap-2.5 max-w-full bg-s4/95 backdrop-blur-md rounded-(--r-sm) pl-3.5 pr-4 py-2.5 elev-3">
          {t.icon === "ok" && <ICheck size={16} className="text-mint shrink-0" />}
          {t.icon === "heart" && <IHeartF size={16} className="text-neon shrink-0" />}
          {t.icon === "star" && <IStarF size={16} className="text-amber shrink-0" />}
          {t.icon === "info" && <ISparkF size={15} className="text-cyan shrink-0" />}
          <span className="text-[13px] text-on truncate">{t.msg}</span>
          {t.action && <button type="button" className="hg-toast-action min-h-8 shrink-0 text-xs font-semibold text-primary pressable"
            onClick={() => { dismissToast(t.id); t.action?.run(); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

/* ——— 关闭按钮 ——— */
export function CloseBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-8 h-8 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable hover:text-on">
      <IClose size={16} />
    </button>
  );
}

/* ——— 图片（骨架 + 渐显，自动走本地解密协议） ——— */
export function Img({ src, alt = "", className = "", eager = false, raw = false, fallback }: {
  src: string; alt?: string; className?: string; eager?: boolean; raw?: boolean; fallback?: React.ReactNode;
}) {
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(false);
  const url = raw ? src : cover(src);
  return (
    <div className={`absolute inset-0 overflow-hidden ${className}`}>
      {!ok && !err && <div className="absolute inset-0 shimmer" />}
      {err && (fallback ?? <div className="absolute inset-0 bg-s3" />)}
      <img src={url} alt={alt} loading={eager ? "eager" : "lazy"} onLoad={() => setOk(true)} onError={() => setErr(true)}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${ok ? "opacity-100" : "opacity-0"}`} draggable={false} />
    </div>
  );
}
/* ——— 右侧停靠面板（桌面评论/选集） ——— */
export function DockPanel({ open, onClose, children, width = 372 }: {
  open: boolean; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  const [render, setRender] = useState(open);
  useEffect(() => {
    if (open) setRender(true);
    else { const t = window.setTimeout(() => setRender(false), 230); return () => window.clearTimeout(t); }
  }, [open]);
  if (!render) return null;
  return (
    <div className="absolute inset-0 z-40 pointer-events-none">
      <div className={`absolute inset-0 bg-black/35 pointer-events-auto ${open ? "a-fade" : "opacity-0 transition-opacity duration-200"}`} onClick={onClose} />
      <div className={`desktop-dock absolute right-0 top-0 bottom-0 pointer-events-auto flex flex-col ${open ? "a-panel-in" : "a-panel-out"}`}
        role="dialog" aria-label="侧边面板" style={{ width, maxWidth: "88%" }}>
        {children}
      </div>
    </div>
  );
}
