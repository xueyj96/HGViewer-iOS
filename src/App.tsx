import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { isMobile, isIos, selfTest } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "./back";
import { IOS_LAYOUT_CHANGE } from "./iosGeometry";
import OfflinePage from "./pages/Offline";
import RecentCache from "./pages/RecentCache";
import Home from "./pages/Home";
import Search, { RankPage } from "./pages/Search";
import Category, { ChannelPage } from "./pages/Category";
import Profile from "./pages/Profile";
import SettingsPage from "./pages/Settings";
import Feed from "./components/Feed";
import IOSChannelBackFrame from "./components/IOSChannelBackFrame";
import { IOSAccountButton } from "./components/IOSPageBar";
import { IOSNavigation, IOSNavigationScope } from "./components/IOSNavigation";
import { PostsPage, PostDetail } from "./pages/Posts";
import LoginModal from "./components/LoginModal";
import { ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar } from "./components/DesktopChrome";
import ResizeHandles from "./components/ResizeHandles";
import { WORKSPACE_TABS } from "./workspaceTabs";

const MOBILE_TAB_HEIGHT = isIos ? 50 : 40;

function navigateToTab(setTab: (tab: Tab) => void, tab: Tab) {
  if (isIos) runBack();
  setTab(tab);
}

/* ============ 移动端底部标签栏 ============ */
function TabBar({ overPlayback = false }: { overPlayback?: boolean }) {
  const { tab, setTab, theme } = useStore();
  /* 细瘦纯文字分栏：只有选中项高亮，没有指示点。
     首页是沉浸视频 → 底栏压深色；搜索/分类/资料库 是浅色内容页 →
     浅色主题下底栏跟着换成浅色，深色主题保持深色。 */
  const overVideo = isIos ? overPlayback : tab === "home";
  const lightBar = !overVideo && theme === "light";
  return (
    <nav aria-label="主导航" data-over-video={overVideo} className="hg-tabbar absolute bottom-0 inset-x-0 z-30"
      style={isIos ? undefined : {
        paddingBottom: "var(--sab, 0px)",
        background: lightBar ? "rgba(250, 250, 250, .97)" : overVideo ? "#000000" : "#141414",
        borderTop: lightBar ? "1px solid rgba(0,0,0,.08)" : overVideo ? "none" : "1px solid rgba(255,255,255,.07)",
        boxShadow: lightBar ? "0 -2px 14px rgba(0,0,0,.05)" : "none",
      }}>
      <div className="flex items-center px-1" style={isIos ? undefined : { height: MOBILE_TAB_HEIGHT }}>
        {WORKSPACE_TABS.filter(({ k }) => !isIos || k !== "search").map(({ k, label, Icon, SelectedIcon }) => {
          const on = tab === k || (isIos && k === "home" && tab === "search");
          const Glyph = on ? SelectedIcon : Icon;
          return (
            <button key={k} aria-label={label} aria-current={on ? "page" : undefined} onClick={() => navigateToTab(setTab, k)} className="flex-1 h-full flex items-center justify-center pressable">
              {isIos && <Glyph size={21} />}
              <span className="text-[12.5px] leading-none transition-colors duration-200"
                style={isIos ? undefined : {
                  fontWeight: on ? 700 : 400,
                  color: lightBar
                    ? (on ? "var(--p-primary)" : "rgba(0,0,0,.45)")
                    : (on ? "#ffffff" : "rgba(255,255,255,.6)"),
                }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ============ 堆栈页面 ============ */
function StackPage({ page, onBack, wide, top, bottomInset, onArticleFullscreen }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number; onArticleFullscreen?: (key: string, full: boolean) => void;
}) {
  const reportArticleFullscreen = useCallback((full: boolean) => {
    onArticleFullscreen?.(page.key, full);
  }, [onArticleFullscreen, page.key]);
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime} offlineItems={page.offlineItems} offlineCoverIds={page.offlineCoverIds}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} active={top} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} active={top} />;
  if (page.kind === "offline") return <OfflinePage wide={wide} active={top} onBack={onBack} id={page.id} title={page.title} episodes={page.episodes} />;
  if (page.kind === "recent-cache") return <RecentCache onBack={onBack} active={top} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} active={top} />;
  if (page.kind === "post") return <PostDetail id={page.id} postIds={page.postIds} nextPostPage={page.nextPostPage} onBack={onBack} active={top} onFullscreenChange={reportArticleFullscreen} />;
  return null;
}

function useWorkspaceWidth(initialWide: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(initialWide);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth > 640);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  return { ref, wide };
}

function WorkspaceTabs({ wide, bottomInset, account }: { wide: boolean; bottomInset: number; account?: React.ReactNode }) {
  const { tab, setTab, stack, loginOpen, lineRevision } = useStore();
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  useEffect(() => {
    setVisited((previous) => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab]);

  const pageActive = stack.length === 0 && !loginOpen;
  const render = (key: Tab, content: React.ReactNode) => {
    const visible = tab === key;
    const behindSearch = isIos && key === "home" && tab === "search";
    if (!visible && !behindSearch && !visited.has(key)) return null;
    const frame = <div data-workspace-tab={key} inert={!visible || !pageActive}
      className={visible || behindSearch ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none"}>
      {isIos && key === "search" ? <IOSChannelBackFrame active={visible && pageActive} onBack={() => setTab("home")}>{content}</IOSChannelBackFrame> : content}
    </div>;
    return isIos ? <IOSNavigationScope active={visible && stack.length === 0} account={key === "home" ? undefined : account}>{frame}</IOSNavigationScope> : frame;
  };
  return (
    <>
      {render("home", <Home key={lineRevision} active={pageActive && tab === "home"} bottomInset={bottomInset} />)}
      {render("search", <Search key={lineRevision} active={pageActive && tab === "search"} wide={wide} />)}
      {render("category", <Category key={lineRevision} wide={wide} />)}
      {render("profile", <Profile wide={wide} active={pageActive && tab === "profile"} />)}
    </>
  );
}

/* ============ 应用主体 ============ */
function AppBody() {
  const { tab, stack, pop, push, fs, loginOpen } = useStore();
  const topPage = stack.at(-1);
  const currentPage = topPage?.kind;
  const [fullscreenArticleKey, setFullscreenArticleKey] = useState<string>();
  const reportArticleFullscreen = useCallback((key: string, full: boolean) => {
    setFullscreenArticleKey((current) => full ? key : current === key ? undefined : current);
  }, []);
  const showingPlayback = !loginOpen && (topPage
    ? currentPage === "feed" || topPage.key === fullscreenArticleKey
    : tab === "home");
  useEffect(() => {
    if (!isIos) return;
    const landscape = window.matchMedia("(orientation: landscape)");
    const compactLandscape = window.matchMedia("(orientation: landscape) and (max-height: 500px)");
    const update = () => {
      void invoke("set_ios_status_bar_hidden", {
        hidden: landscape.matches && (compactLandscape.matches || showingPlayback),
      }).catch(() => {});
    };
    update();
    landscape.addEventListener("change", update);
    compactLandscape.addEventListener("change", update);
    return () => {
      landscape.removeEventListener("change", update);
      compactLandscape.removeEventListener("change", update);
    };
  }, [showingPlayback]);

  const { ref: mainRef, wide } = useWorkspaceWidth(false);
  const bottomInset = fs ? 0 : MOBILE_TAB_HEIGHT;
  const account = isIos && !fs ? <IOSAccountButton onClick={() => push({ kind: "settings" })} /> : undefined;
  const pages = <>
    <WorkspaceTabs wide={wide} bottomInset={bottomInset} account={account} />
    {stack.map((p, i) => {
      const top = i === stack.length - 1;
      const playback = isIos && p.kind === "feed";
      const page = <StackPage page={p} onBack={pop} wide={wide} top={top}
        bottomInset={playback ? bottomInset : 0} onArticleFullscreen={reportArticleFullscreen} />;
      if (isIos) {
        const hasAccount = ["channel", "ranks", "posts", "offline", "recent-cache"].includes(p.kind);
        return <IOSNavigationScope key={p.key} active={top} account={hasAccount ? account : undefined}>
          <IOSChannelBackFrame active={top} onBack={pop} gestureEnabled={!playback && p.kind !== "post"} transparent={p.kind === "post"}>
            {page}
          </IOSChannelBackFrame>
        </IOSNavigationScope>;
      }
      return <div key={p.key} inert={!top} className="absolute inset-0 z-30 a-page-in bg-bg" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>{page}</div>;
    })}
  </>;

  return (
    <div className="absolute inset-0 flex bg-canvas">
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        {isIos ? <IOSNavigation immersive={fs} bottom={<TabBar overPlayback={showingPlayback} />}>{pages}</IOSNavigation>
          : <>{pages}{!fs && !currentPage && <TabBar />}</>}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS）============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* 边缘缩放热区只对无边框窗口（Windows）有效，macOS 走原生窗口边框 */}
      {platform === "windows" && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, platform } = useStore();
  const { ref: mainRef, wide } = useWorkspaceWidth(true);

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <WorkspaceTabs wide={wide} bottomInset={14} />
        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg win-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 移动端（无壳） ============ */
function MobileShell({ children }: { children: React.ReactNode }) {
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = shell.current;
    if (!isIos || !element) return;
    let revision = 0;
    let timer = 0;
    const readInsets = () => {
      const current = ++revision;
      void invoke<[number, number]>("ios_horizontal_safe_area").then((insets) => {
        if (current !== revision || !Array.isArray(insets)) return;
        const [left, right] = insets;
        if (!Number.isFinite(left) || !Number.isFinite(right)) return;
        const leftInset = `${Math.max(0, left)}px`;
        const rightInset = `${Math.max(0, right)}px`;
        if (element.style.getPropertyValue("--ios-native-safe-left") === leftInset &&
          element.style.getPropertyValue("--ios-native-safe-right") === rightInset) return;
        element.style.setProperty("--ios-native-safe-left", leftInset);
        element.style.setProperty("--ios-native-safe-right", rightInset);
        window.dispatchEvent(new Event(IOS_LAYOUT_CHANGE));
      }).catch(() => {});
    };
    const update = () => {
      readInsets();
      window.clearTimeout(timer);
      // UIKit can publish its final safe area after the WebView's rotation event.
      timer = window.setTimeout(readInsets, 350);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      ++revision;
      window.clearTimeout(timer);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <div ref={shell} className={`absolute inset-0 flex flex-col bg-canvas plat-${isIos ? "ios" : "android"}`}
      style={{ "--sat": isIos ? "var(--ios-top-inset)" : "max(env(safe-area-inset-top), 8px)", "--sab": "max(env(safe-area-inset-bottom), 6px)" } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
        {children}
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs } = useStore();

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (loginOpen) {
        if (event.key === "Escape") setLoginOpen(false);
        return;
      }
      if (document.querySelector('[aria-modal="true"]:not([inert], [inert] *)')) return;
      if (event.key === "Escape") {
        if (runBack()) event.preventDefault();
        else if (stack.length) pop();
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        navigateToTab(setTab, "search");
        return;
      }
      const shortcut = /^[1-9]$/.test(event.key) ? WORKSPACE_TABS[Number(event.key) - 1] : undefined;
      if (shortcut && !event.repeat) navigateToTab(setTab, shortcut.k);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen]);

  /* —— 安卓硬件返回键 ——
     层级：全屏 → 面板/弹层 → 登录框 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (runBack()) return;                                  // 播放器的选集/评论/图文面板
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV || isIos) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  if (isMobile) {
    return <MobileShell><LoginModal /><ToastHost /></MobileShell>;
  }
  return <><DesktopShell /><LoginModal /><ToastHost /></>;
}
