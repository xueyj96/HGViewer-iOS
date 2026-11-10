import { useEffect, useState } from "react";
import { api, hostOf, isIos, isMobile, type LineItem, type LineProbe, type LineState } from "../api";
import { useStore } from "../store";
import { CompactAction, Modal, PageStatus, Sheet } from "./ui";
import { IOSCloseButton } from "./IOSPageBar";
import { ICheck, IClose, IRefresh, ISettings } from "../icons";

type ProbeMap = Record<string, LineProbe>;

/* 单条线路：左侧点一下即切换，右侧单独检测 */
function Row({ item, current, probe, busy, disabled, onPick, onProbe }: {
  item: LineItem; current: boolean; probe?: LineProbe; busy: boolean; disabled: boolean;
  onPick: (url: string) => void; onProbe: (url: string) => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3.5 py-2.5 ${current ? "bg-s3/70" : ""}`}>
      <button onClick={() => onPick(item.url)} disabled={disabled} className="min-h-11 flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[12.5px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[10.5px] text-mut truncate mt-0.5">{item.url}</div>
      </button>
      <span
        title={probe ? (probe.status ? `HTTP ${probe.status}` : (probe.error || "")) : ""}
        className={`text-[10.5px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint" : "text-danger") : "text-dim"}`}>
        {busy ? "…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : "失败") : "—"}
      </span>
      <CompactAction tone="neutral" onClick={() => onProbe(item.url)} disabled={busy || disabled}>检测</CompactAction>
    </div>
  );
}

/* 线路选择：桌面居中弹窗，移动端底部抽屉 */
export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, onLineChanged } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [stateLoading, setStateLoading] = useState(true);
  const [stateFailed, setStateFailed] = useState(false);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [suggested, setSuggested] = useState<LineProbe | null>(null);
  const [switching, setSwitching] = useState("");

  const readState = async () => {
    setStateLoading(true);
    setStateFailed(false);
    try {
      setState(await api.lineState());
    } catch {
      setStateFailed(true);
    } finally {
      setStateLoading(false);
    }
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    setSuggested(null);
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
    } catch (e) {
      setMirrors([]);
      setMirrorErr((e as Error).message || "镜像线路获取失败");
    } finally {
      setLoadingMirrors(false);
    }
  };

  /* 镜像线路只在用户点开「线路」后才去拉，拉过一次就留在内存里，可手动刷新 */
  useEffect(() => {
    if (!open) return;
    void readState();
    if (mirrors === null) void readMirrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const probe = async (list: LineItem[], key: string) => {
    if (!list.length) return;
    setProbing(key);
    try {
      const res = await api.lineProbe(list.map((x) => x.url));
      if (key === "quick") {
        const options = res.filter((r) => r.ok && r.url !== state?.base);
        const best = options.sort((a, b) => a.ms - b.ms)[0];
        setSuggested(best ?? null);
        if (!best) toast("这次检测没找到可用的备用线路，可尝试单独检测其他镜像", "info");
      }
      setProbes((p) => {
        const next = { ...p };
        for (const r of res) next[r.url] = r;
        return next;
      });
    } catch (e) {
      toast((e as Error).message || "检测失败", "info");
    } finally {
      setProbing("");
    }
  };

  const pick = async (url: string) => {
    if (switching || state?.base === url) return;
    setSwitching(url);
    try {
      const next = await api.lineSet(url);
      if (next !== state?.base) onLineChanged();
      setState((s) => (s ? { ...s, base: next } : s));
      toast(`线路已切换到 ${hostOf(next)}，跨站点需重新登录`, "ok");
    } catch (e) {
      toast((e as Error).message || "切换失败", "info");
    } finally {
      setSwitching("");
    }
  };

  const fixed = state?.fixed || [];
  const busyAll = !!probing || !!switching;

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74vh" : "min(72vh, 620px)" }}>
      <div className="hg-ios-browse-content shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-on leading-tight">线路</div>
          <div className="text-[10.5px] text-mut mt-0.5 truncate">当前：{state ? hostOf(state.base) : stateLoading ? "读取中…" : "暂不可用"}</div>
        </div>
        {isIos ? <IOSCloseButton onClose={onClose} /> : <button onClick={onClose} aria-label="关闭" className="w-8 h-8 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></button>}
      </div>

      <div className="hg-ios-browse-content flex-1 scroll-y px-3 pb-4">
        <div className="mb-2 rounded-(--r-md) bg-s2 px-3 py-2.5">
          <CompactAction onClick={() => {
            setSuggested(null);
            const candidates = [...fixed, ...(mirrors || []).slice(0, 3)];
            void probe(candidates, "quick");
          }} disabled={busyAll || loadingMirrors || !fixed.length}>
            {probing === "quick" ? "正在检测…" : "找可用线路"}
          </CompactAction>
          {suggested && suggested.url !== state?.base && (
            <div className="mt-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-[11px] text-on">首页可加载：{hostOf(suggested.url)}</span>
              <CompactAction onClick={() => void pick(suggested.url)} disabled={busyAll}>切换到此线路</CompactAction>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-1 mt-1 mb-1.5">
          <span className="text-[10.5px] font-semibold text-dim tracking-wide">固定线路</span>
          <span className="text-[10px] text-dim">需代理 / 非大陆网络</span>
          <CompactAction onClick={() => probe(fixed, "fixed")} disabled={busyAll || !fixed.length} className="ml-auto">
            {probing === "fixed" ? "检测中…" : "全部检测"}
          </CompactAction>
        </div>
        {stateFailed && <div className="mb-2"><PageStatus title="固定线路读取失败" onRetry={() => void readState()} /></div>}
        <div className="hg-ios-grouped-list rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {fixed.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
          {!fixed.length && !stateFailed && <div className="px-3.5 py-3 text-[11px] text-mut">{stateLoading ? "读取中…" : "没有可用的固定线路"}</div>}
        </div>

        <div className="flex items-center gap-2 px-1 mt-4 mb-1.5">
          <span className="text-[10.5px] font-semibold text-dim tracking-wide">镜像线路</span>
          <span className="text-[10px] text-dim">一般可直连 · 仅游客浏览</span>
          <CompactAction onClick={() => { void readMirrors(); }} disabled={loadingMirrors} className="ml-auto">
            <IRefresh size={12} aria-hidden="true" />{loadingMirrors ? "获取中…" : "刷新"}
          </CompactAction>
        </div>
        <div className="hg-ios-grouped-list rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><div className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && mirrorErr && (
            <div className="px-3.5 py-3">
              <div className="text-[11.5px] text-danger">镜像线路获取失败</div>
              <div className="text-[10.5px] text-mut mt-1 break-all">{mirrorErr}</div>
            </div>
          )}
          {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
            <div className="px-3.5 py-3 text-[11px] text-mut">地址发布页里没有可用的镜像地址</div>
          )}
          {!loadingMirrors && (mirrors || []).map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </div>
        {!loadingMirrors && !!mirrors?.length && (
          <div className="flex justify-end px-1 mt-2">
            <CompactAction onClick={() => probe(mirrors, "mirrors")} disabled={busyAll}>
              {probing === "mirrors" ? "检测中…" : `全部检测（${mirrors.length}）`}
            </CompactAction>
          </div>
        )}

        <div className="text-[10px] text-dim leading-relaxed px-1 mt-4">
          点「检测」会验证这条线路能否加载首页列表。需要换线路时，点线路名称手动切换。
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose} label="切换线路">{body}</Sheet>
    : <Modal open={open} onClose={onClose} width={460}>{body}</Modal>;
}
