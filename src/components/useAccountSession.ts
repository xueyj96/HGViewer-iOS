import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { User } from "../types";
import type { Toast, ToastAction } from "../toasts";

type Boot = Awaited<ReturnType<typeof api.boot>>;
export type Authentication = { mode: "login" | "register"; username: string; password: string; email?: string };
export type AuthenticationResult = { status: "authenticated"; user: User } | { status: "superseded" };
type Notify = (message: string, icon?: Toast["icon"], action?: ToastAction) => void;
function validUser(value: User | null | undefined): value is User {
  return !!value && Number.isSafeInteger(value.id) && value.id > 0;
}

/** Account operations outlive an individual form, but never a newer account intent or line. */
export function useAccountSession(onBoot: (boot: Boot) => void, toast: Notify) {
  const [user, setUser] = useState<User | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const pendingLogout = useRef<{ revision: number; promise: Promise<void> } | undefined>(undefined);
  // A logout can change native state even after its Promise has been superseded and released.
  const readbackRequired = useRef(false);
  const current = useCallback((operation: number) => mounted.current && operation === revision.current, []);
  const adoptSnapshot = useCallback((snapshot: Boot | undefined): "guest" | "authenticated" | "unknown" => {
    if (snapshot?.logged_in === false) {
      setUser(null);
      readbackRequired.current = false;
      return "guest";
    }
    if (snapshot?.logged_in === true && validUser(snapshot.user)) {
      setUser(snapshot.user);
      readbackRequired.current = false;
      return "authenticated";
    }
    return "unknown";
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++revision.current; };
  }, []);

  useEffect(() => {
    let active = true;
    const operation = revision.current;
    void api.boot().then((boot) => {
      if (!active) return;
      // Global configuration is independent of the account result becoming stale.
      onBoot(boot);
      if (current(operation)) adoptSnapshot(boot);
    }).catch(() => { /* Offline startup keeps local features available. */ });
    return () => { active = false; };
  }, [onBoot, current, adoptSnapshot]);

  const resetAccount = useCallback(() => {
    ++revision.current;
    readbackRequired.current = false;
    setUser(null);
  }, []);

  const authenticate = useCallback(async (request: Authentication): Promise<AuthenticationResult> => {
    if (!mounted.current) return { status: "superseded" };
    const operation = ++revision.current;
    try {
      const result = request.mode === "login"
        ? await api.login(request.username, request.password)
        : await api.register(request.username, request.password, request.email ?? "");
      if (!current(operation)) return { status: "superseded" };
      if (!validUser(result.user)) throw new Error("未能读取登录账号，请重试");
      setUser(result.user);
      readbackRequired.current = false;
      return { status: "authenticated", user: result.user };
    } catch (error) {
      if (!current(operation)) return { status: "superseded" };
      if (readbackRequired.current) {
        // Native may already have revoked the former account before the logout response arrives.
        const readback = await api.boot().catch(() => undefined);
        if (!current(operation)) return { status: "superseded" };
        if (adoptSnapshot(readback) === "unknown") toast("账号状态未确认，请重试", "info");
      }
      throw error;
    }
  }, [current, toast, adoptSnapshot]);

  const logout = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (pendingLogout.current?.revision === revision.current) return pendingLogout.current.promise;
    const operation = ++revision.current;
    readbackRequired.current = true;
    const promise = (async () => {
      let confirmed = false;
      try { confirmed = (await api.logout()).ok; }
      catch { /* Read back below; IPC failure does not prove native failed to revoke. */ }
      if (!current(operation)) return;
      if (confirmed) {
        setUser(null);
        readbackRequired.current = false;
        toast("已退出登录", "info");
      } else {
        const readback = await api.boot().catch(() => undefined);
        if (!current(operation)) return;
        const outcome = adoptSnapshot(readback);
        toast(outcome === "guest" ? "已退出登录" : "退出状态未确认，请重试", "info");
      }
    })().finally(() => {
      if (pendingLogout.current?.promise === promise) pendingLogout.current = undefined;
    });
    pendingLogout.current = { revision: operation, promise };
    return promise;
  }, [toast, current, adoptSnapshot]);

  return { user, authenticate, logout, resetAccount };
}
