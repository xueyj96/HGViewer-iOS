import { createContext, useContext, useState, type ReactNode } from "react";

const TopBarHost = createContext<HTMLElement | null>(null);
const NavigationScope = createContext<{ active: boolean; account?: ReactNode }>({ active: true });

export function IOSNavigation({ children, bottom, immersive }: { children: ReactNode; bottom: ReactNode; immersive: boolean }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <TopBarHost.Provider value={host}>
      <div className="hg-ios-page-layer absolute inset-0 isolate">{children}</div>
      <div data-immersive={immersive} className="hg-ios-navigation absolute inset-0 z-[35] pointer-events-none">
        <div ref={setHost} className="hg-ios-top-bar absolute inset-0" />
        {bottom}
      </div>
    </TopBarHost.Provider>
  );
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
