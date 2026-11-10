import { createContext, useContext, useEffect, useId, useLayoutEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

const TopBarHost = createContext<HTMLElement | null>(null);
const NavigationScope = createContext<{ active: boolean; account?: ReactNode }>({ active: true });
type PlaybackRail = { owner: string; content: ReactNode; attached: boolean };
const PlaybackRailHost = createContext<Dispatch<SetStateAction<PlaybackRail | null>> | null>(null);

export function IOSNavigation({ children, bottom, immersive, playbackRoute }: {
  children: ReactNode; bottom: ReactNode; immersive: boolean; playbackRoute: boolean;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [rail, setRail] = useState<PlaybackRail | null>(null);
  useEffect(() => {
    if (playbackRoute || !rail) return;
    // Keep the outgoing rail painted long enough to finish its opacity transition.
    const timer = window.setTimeout(() => setRail((current) => current === rail ? null : current), 180);
    return () => window.clearTimeout(timer);
  }, [playbackRoute, rail]);
  return (
    <TopBarHost.Provider value={host}>
      <PlaybackRailHost.Provider value={setRail}>
        <div className="hg-ios-page-layer absolute inset-0 isolate">{children}</div>
      </PlaybackRailHost.Provider>
      <div className="hg-ios-playback-rail-host hg-player-ui absolute inset-0 z-[34] pointer-events-none"
        data-visible={playbackRoute && !!rail}
        inert={!playbackRoute || !rail?.attached}>
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
