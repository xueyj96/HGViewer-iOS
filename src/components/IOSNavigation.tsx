import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { finishMotion } from "./finishMotion";
import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { useIOSTopBarMotion } from "./useIOSTopBarMotion";

const TopBarHost = createContext<HTMLElement | null>(null);
const NavigationScope = createContext<{ active: boolean; account?: ReactNode }>({ active: true });
type PlaybackRail = { owner: string; content: ReactNode; attached: boolean };
const PlaybackRailHost = createContext<Dispatch<SetStateAction<PlaybackRail | null>> | null>(null);

export function IOSNavigation({ children, bottom, immersive, playbackRoute }: {
  children: ReactNode; bottom: ReactNode; immersive: boolean; playbackRoute: boolean;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useIOSTopBarMotion(host);
  const [rail, setRail] = useState<PlaybackRail | null>(null);
  const railHost = useRef<HTMLDivElement>(null);
  const railVisible = playbackRoute && rail?.attached === true;
  useLayoutEffect(() => {
    const host = railHost.current;
    if (!host) return;
    const update = () => {
      for (const list of host.querySelectorAll<HTMLElement>(".hg-ios-feed-rail, .hg-ios-full-rail")) {
        if (!window.matchMedia("(orientation: landscape)").matches) { list.style.removeProperty("--hg-rail-columns"); continue; }
        const style = getComputedStyle(list);
        const target = Number.parseFloat(style.getPropertyValue("--ios-control-target")) || 44;
        const gap = Number.parseFloat(style.getPropertyValue("--ios-control-gap")) || 4;
        const available = Math.max(target, host.clientHeight - (Number.parseFloat(style.top) || 0) - (Number.parseFloat(style.bottom) || 0));
        const rows = Math.max(1, Math.floor((available + gap) / (target + gap)));
        const count = list.querySelectorAll(":scope > button").length;
        list.style.setProperty("--hg-rail-columns", String(Math.max(1, Math.min(3, Math.ceil(count / rows)))));
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener(IOS_LAYOUT_CHANGE, update);
    update();
    return () => { observer.disconnect(); window.removeEventListener(IOS_LAYOUT_CHANGE, update); };
  }, [rail]);
  useEffect(() => {
    if (railVisible || !rail) return;
    return finishMotion(railHost.current, () => setRail((current) => current === rail ? null : current));
  }, [railVisible, rail]);
  return (
    <TopBarHost.Provider value={host}>
      <PlaybackRailHost.Provider value={setRail}>
        <div className="hg-ios-page-layer absolute inset-0 isolate">{children}</div>
      </PlaybackRailHost.Provider>
      <div ref={railHost} className="hg-ios-playback-rail-host hg-player-ui absolute inset-0 z-[34] pointer-events-none"
        data-visible={railVisible} inert={!railVisible}>
        {rail?.content}
      </div>
      <div data-immersive={immersive} className="hg-ios-navigation absolute inset-0 z-[35] pointer-events-none">
        <div ref={setHost} className="hg-ios-top-bar absolute inset-0" />
        {bottom}
      </div>
    </TopBarHost.Provider>
  );
}

export function useIOSPlaybackRail(content: ReactNode) {
  const setRail = useContext(PlaybackRailHost);
  const { active } = useContext(NavigationScope);
  const owner = useId();
  const attached = active && content != null;

  useLayoutEffect(() => {
    if (!attached || !setRail) return;
    return () => setRail((current) => current?.owner === owner ? { ...current, attached: false } : current);
  }, [attached, owner, setRail]);

  useLayoutEffect(() => {
    if (attached) setRail?.({ owner, content, attached: true });
  });
}

export function IOSNavigationScope({ active, account, children }: {
  active: boolean;
  account?: ReactNode;
  children: ReactNode;
}) {
  return <NavigationScope.Provider value={{ active, account }}>{children}</NavigationScope.Provider>;
}

export function useIOSNavigation() {
  const host = useContext(TopBarHost);
  const scope = useContext(NavigationScope);
  return { host, ...scope };
}
