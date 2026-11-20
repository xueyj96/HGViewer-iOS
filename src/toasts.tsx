import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastAction = { label: string; run: () => void; scope?: "history" };
export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info"; action?: ToastAction };
type ToastActions = {
  toast: (msg: string, icon?: Toast["icon"], action?: ToastAction) => void;
  clearHistoryToasts: () => void;
};
const Actions = createContext<ToastActions>(null as unknown as ToastActions);
const Snapshot = createContext<{ toasts: Toast[]; dismissToast: (id: number) => void }>(null!);

/** Only ToastHost subscribes to presentation changes; business callers read stable actions. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sequence = useRef(0);
  const timers = useRef(new Map<number, number>());
  const dismissToast = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((items) => items.some((item) => item.id === id) ? items.filter((item) => item.id !== id) : items);
  }, []);
  const toast = useCallback((msg: string, icon?: Toast["icon"], action?: ToastAction) => {
    const id = ++sequence.current;
    setToasts((items) => [...items.slice(-2), { id, msg, icon, action }]);
    timers.current.set(id, window.setTimeout(() => dismissToast(id), action ? 6500 : 2200));
  }, [dismissToast]);
  const clearHistoryToasts = useCallback(() => {
    setToasts((items) => items.filter((item) => item.action?.scope !== "history"));
  }, []);
  useEffect(() => {
    const ownedTimers = timers.current;
    return () => {
      ownedTimers.forEach((timer) => window.clearTimeout(timer));
      ownedTimers.clear();
    };
  }, []);
  const actions = useMemo(() => ({ toast, clearHistoryToasts }), [toast, clearHistoryToasts]);
  const snapshot = useMemo(() => ({ toasts, dismissToast }), [toasts, dismissToast]);
  return <Actions.Provider value={actions}><Snapshot.Provider value={snapshot}>{children}</Snapshot.Provider></Actions.Provider>;
}

export const useToastActions = () => useContext(Actions);
export const useToasts = () => useContext(Snapshot);
