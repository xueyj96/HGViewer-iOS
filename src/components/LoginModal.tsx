import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api, APP_NAME, isIos, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { IOSPageBar } from "./IOSPageBar";
import { IOSTabPages, IOSSwipeSegments, useIOSTabSwipe } from "./IOSTabSwipe";
import { useIOSKeyboardViewport } from "./useIOSKeyboardViewport";
import { IClose, ILogin } from "../icons";

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast, tab, stack } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const formId = useId();
  const tabs = useIOSTabSwipe({ index: mode === "login" ? 0 : 1, count: 2,
    onChange: (index) => { setMode(index === 0 ? "login" : "register"); setErr(""); },
    enabled: isIos && loginOpen && !busy });
  const host = useRef<HTMLDivElement>(null);
  const pageKey = stack.at(-1)?.key;
  useEffect(() => { setLoginOpen(false); }, [tab, pageKey, setLoginOpen]);
  useIOSKeyboardViewport(host, loginOpen, 200);
  useLayoutEffect(() => {
    if (!loginOpen) setPassword("");
  }, [loginOpen]);

  const submit = async () => {
    if (busy || tabs.busy) return;
    if (!username.trim() || !password) { setErr("请输入账号与密码"); return; }
    setBusy(true);
    setErr("");
    try {
      const res = mode === "login"
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password, email.trim());
      setUser(res.user as User);
      setPassword("");
      setLoginOpen(false);
      toast(mode === "login" ? `欢迎回来，${(res.user as User)?.nickname || username}` : "注册成功", "ok");
    } catch (e) {
      setErr((e as Error).message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  /* iOS uses the shared full-page navigation; desktop keeps its modal. */
  const renderBody = (panelMode: "login" | "register", committed: boolean) => {
    const panelFormId = committed ? formId : `${formId}-preview-${panelMode}`;
    return (
    <form id={panelFormId} className="hg-ios-auth-form hg-ios-browse-content flex min-h-0 flex-col gap-2 p-5"
      data-keyboard-scroll onSubmit={(event) => { event.preventDefault(); if (committed) void submit(); }}>
      <div className="min-h-0 overflow-y-auto overscroll-contain" data-keyboard-scroll>
        {!isIos && <div className="flex items-center gap-2 mb-3">
          <span className="w-8 h-8 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ILogin size={16} /></span>
          <span className="hg-ios-sheet-title text-[15px] font-bold text-on">{panelMode === "login" ? "登录" : "注册"} {APP_NAME}</span>
          {(
            <button type="button" onClick={() => setLoginOpen(false)} aria-label="关闭"
              className="ml-auto w-7 h-7 rounded-full bg-s4 flex items-center justify-center text-mut pressable">
              <IClose size={13} />
            </button>
          )}
        </div>}

        {!isIos && <div className="hg-ios-segments hg-ios-segments-compact flex bg-s4 rounded-(--r-ctl) p-1 mb-3" role="group" aria-label="账号操作">
          {([["login", "登录"], ["register", "注册"]] as const).map(([k, l]) => (
            <button type="button" key={k} disabled={busy} aria-pressed={panelMode === k} onClick={() => { setMode(k); setErr(""); }}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${mode === k ? "bg-primary text-on-primary" : "text-mut"}`}>{l}</button>
          ))}
        </div>}

        <div className="hg-ios-auth-fields flex flex-col gap-2" data-registration={panelMode === "register"}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="账号" autoComplete="username" autoCapitalize="none"
            className="hg-ios-input h-11 px-3 rounded-(--r-sm) bg-s4 text-[13px] text-on placeholder-mut outline-none focus:ring-2 focus:ring-[var(--p-primary)]" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="密码" autoComplete={panelMode === "login" ? "current-password" : "new-password"}
            className="hg-ios-input h-11 px-3 rounded-(--r-sm) bg-s4 text-[13px] text-on placeholder-mut outline-none focus:ring-2 focus:ring-[var(--p-primary)]" />
          {panelMode === "register" && (
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱（可选）" type="email" autoComplete="email"
              className="hg-ios-input h-11 px-3 rounded-(--r-sm) bg-s4 text-[13px] text-on placeholder-mut outline-none focus:ring-2 focus:ring-[var(--p-primary)]" />
          )}
          {err && <div role="alert" className="hg-ios-auth-error col-span-full text-[12px] leading-[18px] text-danger">{err}</div>}
        </div>
        {!isIos && <p className="text-[10.5px] text-dim mt-3 leading-relaxed">
          使用黄果短剧官网账号登录。登录、注册仅支持固定线路；镜像线路请以游客浏览。
        </p>}
      </div>
      {!isIos && <button type="submit" disabled={busy || !committed}
        className="hg-ios-primary h-10 shrink-0 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-bold pressable disabled:opacity-60">
        {busy ? "处理中…" : panelMode === "login" ? "登录" : "注册并登录"}
      </button>}
    </form>
    );
  };
  const body = renderBody(mode, true);

  if (isIos) return (
    <div ref={host} className="hg-ios-auth-host pointer-events-none absolute inset-0 z-40 [&>div]:pointer-events-auto">
      <Sheet open={loginOpen} onClose={() => setLoginOpen(false)} fullPage="账号" sharedChrome initialFocus="panel" z="z-[32]">
        <div className="hg-ios-auth-page flex h-full min-h-0 flex-col">
          <IOSPageBar label="账号" overlay priority={2} hidden={!loginOpen} onBack={() => setLoginOpen(false)} endAction={
            <button type="submit" form={formId} disabled={busy || tabs.busy} aria-label={mode === "login" ? "提交登录" : "提交注册"}
              className="hg-ios-floating-button hg-ios-header-square grid place-items-center text-[13px] font-semibold text-primary disabled:opacity-50">
              {busy ? "…" : mode === "login" ? "登录" : "注册"}
            </button>
          }>
            <IOSSwipeSegments controller={tabs} label="账号操作">
              {([["login", "登录"], ["register", "注册"]] as const).map(([key, title], index) => (
                <button type="button" key={key} aria-pressed={mode === key} disabled={busy}
                  onClick={() => tabs.select(index)} className="font-semibold pressable">{title}</button>
              ))}
            </IOSSwipeSegments>
          </IOSPageBar>
          <IOSTabPages controller={tabs}>{(index, committed) => renderBody(index === 0 ? "login" : "register", committed)}</IOSTabPages>
        </div>
      </Sheet>
    </div>
  );
  return isMobile
    ? <Sheet open={loginOpen} onClose={() => setLoginOpen(false)}>{body}</Sheet>
    : <Modal open={loginOpen} onClose={() => setLoginOpen(false)} width={360}>{body}</Modal>;
}
