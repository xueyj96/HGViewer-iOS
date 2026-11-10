import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactNode } from "react";
import { isIos } from "../api";

type Symbols = Record<string, string>;
let cachedSymbols: Promise<Symbols> | undefined;

export function useIOSSymbols() {
  const [symbols, setSymbols] = useState<Symbols>({});
  useEffect(() => {
    if (!isIos) return;
    let active = true;
    cachedSymbols ??= invoke<Symbols>("settings_symbols").catch((error) => {
      cachedSymbols = undefined;
      throw error;
    });
    void cachedSymbols.then((icons) => { if (active) setSymbols(icons); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return (name: string, fallback: ReactNode, size = 16, className = "") => {
    const png = symbols[name];
    const mask = png ? `url("data:image/png;base64,${png}") center / contain no-repeat` : undefined;
    return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size, ...(mask ? { backgroundColor: "currentColor", mask, WebkitMask: mask } : {}) }}>
      {!png && fallback}
    </span>;
  };
}
