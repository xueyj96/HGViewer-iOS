import { useEffect, useState, type ReactNode } from "react";
import { api, APP_NAME, APP_VERSION, hostOf, isIos, platformLabel, type DownloadSettings, type UpdateInfo } from "../api";
import { HISTORY_LIMIT, useStore } from "../store";
import { ActionDialog, CompactAction, ConfirmAction, Modal, Sheet, Toggle } from "../components/ui";
import { IOSPageBar } from "../components/IOSPageBar";
import { useIOSSymbols } from "../components/IOSSymbol";
import AccountCard from "../components/AccountCard";
import LinePicker from "../components/LinePicker";
import PlaybackSidebarSettings from "../components/PlaybackSidebarSettings";
import { IBack, IBoltF, IBroom, IChevR, IClock, IDownload, IHeart, IInfo, ILink, ILockF, IMoon, IRefresh, ISettings, ISun } from "../icons";

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <>
    <h2 className="hg-ios-section-label text-[10.5px] font-semibold text-dim tracking-wide px-1 mt-4 mb-1.5">{title}</h2>
    <div className="hg-ios-settings-group hg-ios-grouped-list rounded-(--r-md) bg-s2 divide-y divide-s3">{children}</div>
  </>
);

function DownloadSettingRow({ label, description, unit, icon, value, disabled, readFailed = false, onChange }: {
  label: string; description: string; unit: string; icon: ReactNode;
  value?: number; disabled: boolean; readFailed?: boolean; onChange: (value: number) => void;
}) {
  return <label className="hg-ios-settings-row flex items-center gap-3 px-3.5 py-3">
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-s3 text-primary">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="hg-setting-title block text-[12.5px] text-on">{label}</span>
      <span className="hg-setting-detail block text-[10.5px] text-mut">{description}</span>
    </span>
    <span className="hg-setting-select">
    <select aria-label={label} value={value ?? ""} disabled={disabled || value === undefined}
      className="min-h-11 rounded-(--r-ctl) bg-s3 px-3 text-sm font-medium text-primary"
      onChange={(event) => onChange(Number(event.target.value))}>
      {value === undefined && <option value="">{readFailed ? "读取失败" : "读取中"}</option>}
      {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}{unit && ` ${unit}`}</option>)}
    </select>
    </span>
  </label>;
}

/* 独立设置页：线路 / 外观 / 本地数据 / 清理缓存 / 网络诊断 / 关于
   入口：Windows 侧栏「设置」、Android「我的」右上角齿轮 */
export default function Settings({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { theme, themePreference, setTheme, favs, history, clearHistory, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity, toast } = useStore();
  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [historyClearOpen, setHistoryClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [lineOpen, setLineOpen] = useState(false);
  const [lineBase, setLineBase] = useState("");
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [downloads, setDownloads] = useState<DownloadSettings>();
  const [downloadReadStatus, setDownloadReadStatus] = useState<"loading" | "failed" | "ready">("loading");
  const [savingDownloads, setSavingDownloads] = useState(false);
  const [diagnosis, setDiagnosis] = useState<{ status: "loading" | "failed" } | { status: "ready"; text: string } | null>(null);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);

  const symbol = useIOSSymbols();

  const readLine = () => {
    api.lineState().then((s) => setLineBase(s.base)).catch(() => {});
  };
  useEffect(readLine, []);

  const readDownloadSettings = async () => {
    setDownloadReadStatus("loading");
    try {
      setDownloads(await api.offlineDownloadSettings());
      setDownloadReadStatus("ready");
    } catch {
      setDownloadReadStatus("failed");
    }
  };

  useEffect(() => {
    if (!isIos) return;
    void readDownloadSettings();
  }, []);

  const changeDownloadSettings = async (changes: Partial<Omit<DownloadSettings, "background_supported">>) => {
    setSavingDownloads(true);
    try {
      setDownloads(await api.offlineDownloadSettings(changes));
    } catch (error) {
      toast((error as Error).message || "无法保存下载设置", "info");
    } finally {
      setSavingDownloads(false);
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await api.checkUpdate();
      if (info.has_update) setUpdate(info);
      else toast(`已是最新版本 v${info.current}`, "ok");
    } catch (e) {
      toast((e as Error).message || "检查更新失败", "info");
    } finally {
      setChecking(false);
    }
  };

  const diagnose = async () => {
    setDiagnosisOpen(true);
    setDiagnosis({ status: "loading" });
    try {
      setDiagnosis({ status: "ready", text: JSON.stringify(await api.netDiag(), null, 2) });
    } catch {
      setDiagnosis({ status: "failed" });
    }
  };

  const copyDiagnosis = async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast("网络诊断结果已复制", "ok");
    } catch {
      toast("无法自动复制，可选择结果手动复制", "info");
    }
  };

  const copyVersionInfo = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(`HGViewer v${APP_VERSION}`);
      toast("版本信息已复制", "ok");
    } catch {
      toast("无法复制版本信息", "info");
    }
  };

  const aboutContent = (
    <div className={isIos ? "hg-ios-about-content" : "p-5"}>
      <div className="flex items-center gap-3">
        <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
        <div>
          <div className="text-[16px] font-bold text-on leading-tight">{APP_NAME}</div>
          <div className="text-[11px] text-mut mt-0.5">黄果短剧 · 第三方客户端 v{APP_VERSION}</div>
        </div>
      </div>

      <p className="text-[12px] text-on/70 leading-relaxed mt-4">
        {isIos
          ? "HGViewer 是 iPhone 上的短剧和图文浏览客户端，支持离线缓存和沉浸式播放。"
          : "基于 Rust + Tauri 2 构建的跨平台客户端，支持 Windows、macOS 与 Android。界面遵循 Fluent 设计语言，播放器采用沉浸式竖屏信息流。"}
      </p>

      <div className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[11px] text-mut leading-relaxed">
        本项目仅供学习与交流，所有内容均来自上游站点，客户端不存储、不分发任何视频内容。
        请于 24 小时内删除相关资源，并支持正版。
      </div>

      <div className="mt-4 divide-y divide-s3">
        <button onClick={() => { navigator.clipboard?.writeText("https://github.com/Minireel/HGhub").then(() => toast("仓库地址已复制", "ok")).catch(() => {}); }}
          className="w-full min-h-11 flex items-center gap-2 py-2.5 text-left pressable">
          {symbol("link", <ILink size={15} />, 15, "text-mut")}
          <span className="text-[12px] text-on/85">github.com/Minireel/HGhub</span>
          <span className="ml-auto text-[10.5px] text-primary">复制</span>
        </button>
        <button onClick={() => { navigator.clipboard?.writeText("https://huangguoai.com").then(() => toast("站点地址已复制", "ok")).catch(() => {}); }}
          className="w-full min-h-11 flex items-center gap-2 py-2.5 text-left pressable">
          {symbol("link", <ILink size={15} />, 15, "text-mut")}
          <span className="text-[12px] text-on/85">huangguoai.com</span>
          <span className="ml-auto text-[10.5px] text-primary">复制</span>
        </button>
        <div className="flex items-center gap-2 py-2.5">
          {symbol("info.circle", <IInfo size={15} />, 15, "text-mut")}
          <span className="text-[12px] text-on/85">PolyForm Noncommercial 1.0.0</span>
          <span className="ml-auto text-[10.5px] text-mut">仅限非商业</span>
        </div>
      </div>

      {!isIos && <button onClick={() => setAbout(false)} className="mt-4 w-full min-h-11 rounded-(--r-ctl) bg-s3 text-[13px] font-semibold text-on pressable">知道了</button>}
    </div>
  );

  return (
    <div className="hg-ios-settings-page absolute inset-0 bg-bg flex flex-col">
      {isIos ? (
        <IOSPageBar label="设置" onBack={onBack} endAction={
          <button type="button" aria-label={`关于 ${APP_NAME}`} onClick={() => setAbout(true)}
            className="hg-ios-floating-button hg-ios-header-square grid place-items-center">
            <IInfo size={16} aria-hidden="true" />
          </button>
        }>
          <h1 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">设置</h1>
        </IOSPageBar>
      ) : (
        <div className="hg-ios-page-heading shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
          <div className="relative px-3 pt-2 pb-4">
            <button onClick={onBack} aria-label="返回" className="hg-ios-back w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable">{symbol("chevron.left", <IBack size={20} />, 20)}</button>
            <div className="px-2 mt-1 flex items-end justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-9 h-9 shrink-0 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center">{symbol("gearshape", <ISettings size={20} strokeWidth={1.7} />, 20)}</span>
                  <span className="hg-ios-large-title text-[24px] font-bold tracking-wide text-on">设置</span>
                </div>
                <div className="text-[11px] text-mut mt-1">{isIos ? "账号 · 外观 · 本地数据" : "外观 · 本地数据 · 诊断"}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="hg-ios-browse-content flex-1 scroll-y px-4 pt-1 pb-10">
        <div className={wide && !isIos ? "max-w-[720px] mx-auto" : ""}>
          {isIos && <Section title="账号"><AccountCard /></Section>}
          <Section title="外观">
            <div className="hg-ios-settings-appearance px-3.5 py-3">
              <div className="hg-ios-settings-appearance-label mb-2.5 flex items-center gap-2.5">
                <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">
                  {theme === "dark" ? symbol("moon", <IMoon size={16} />) : symbol("sun.max", <ISun size={16} />)}
                </span>
                <span className="text-sm text-on">显示模式</span>
              </div>
              <div role="group" aria-label="显示模式" className="hg-ios-segments hg-ios-segments-compact flex bg-s3 rounded-(--r-ctl) p-1">
                {([["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const).map(([preference, label]) => (
                  <button type="button" key={preference} aria-pressed={themePreference === preference}
                    onClick={() => setTheme(preference)}
                    className={`flex-1 h-8 rounded-(--r-ctl) text-xs font-semibold pressable ${themePreference === preference ? "bg-s1 text-on" : "text-mut"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          {isIos && <Section title="播放"><PlaybackSidebarSettings /></Section>}

          {isIos && <Section title="下载">
              <div className="hg-ios-settings-row flex items-center gap-3 px-3.5 py-3">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-s3 text-primary">
                  {symbol("arrow.down.circle", <IDownload size={16} />)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-on">允许后台下载</div>
                  <div className="text-[10.5px] text-mut">
                    {downloads?.background_supported === false ? "需要 iOS 26 或更新版本" : "关闭后，回到 App 时继续下载"}
                  </div>
                </div>
                <Toggle label="允许后台下载"
                  on={!!downloads?.background_supported && downloads.allow_background}
                  disabled={!downloads?.background_supported || savingDownloads}
                  onChange={(allow_background) => void changeDownloadSettings({ allow_background })} />
              </div>
              <DownloadSettingRow label="同时下载数" description="其余作品按加入顺序排队" unit="部"
                icon={symbol("arrow.down.circle", <IDownload size={16} />)}
                value={downloads?.limit} disabled={savingDownloads} readFailed={downloadReadStatus === "failed"} onChange={(limit) => void changeDownloadSettings({ limit })} />
              <DownloadSettingRow label="单集分片并发" description="仅 HLS，下一个下载的集数生效" unit="路"
                icon={symbol("bolt", <IBoltF size={16} />)}
                value={downloads?.segments} disabled={savingDownloads} readFailed={downloadReadStatus === "failed"} onChange={(segments) => void changeDownloadSettings({ segments })} />
              {downloadReadStatus === "failed" && <div className="hg-ios-settings-row flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div role="alert" className="text-[12px] leading-5 text-danger">下载设置读取失败</div>
                  <div className="text-[11px] leading-4 text-mut">当前设置未更改</div>
                </div>
                <CompactAction tone="neutral" onClick={() => void readDownloadSettings()}>重试</CompactAction>
              </div>}
              {savingDownloads && <span role="status" className="sr-only">正在保存下载设置…</span>}
          </Section>}

          <Section title="本地数据">
            <div className="hg-ios-settings-row flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("heart", <IHeart size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{isIos ? "收藏与历史" : "本地喜欢"}</div>
                <div className="text-[10.5px] text-mut">{favs.length} 部收藏 · {history.length} 条观看记录</div>
              </div>
            </div>
            <button type="button" disabled={history.length === 0} onClick={() => setHistoryClearOpen(true)}
              className="hg-ios-settings-row w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-40">
              <span aria-hidden="true" className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-danger">{symbol("clock", <IClock size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-danger">清空观看历史</div>
                <div className="text-[10.5px] text-mut">保留最近 {HISTORY_LIMIT} 部剧的记录与续播进度</div>
              </div>
              {symbol("chevron.right", <IChevR size={15} />, 15, "text-mut")}
            </button>
            <button onClick={() => setClearOpen(true)} className="hg-ios-settings-row w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("trash", <IBroom size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">清理缓存</div>
                <div className="text-[10.5px] text-mut">{isIos ? "封面与播放列表缓存" : "封面 / 播放缓存与本地记录"}</div>
              </div>
              {symbol("chevron.right", <IChevR size={15} />, 15, "text-mut")}
            </button>
          </Section>

          <Section title="网络">
            <button onClick={() => setLineOpen(true)} className="hg-ios-settings-row w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("bolt", <IBoltF size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">线路</div>
                <div className="text-[10.5px] text-mut truncate">{lineBase ? hostOf(lineBase) : "固定线路 1（默认）"}</div>
              </div>
              {symbol("chevron.right", <IChevR size={15} />, 15, "text-mut")}
            </button>
            <div className="hg-ios-settings-row flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("lock", <ILockF size={15} />, 15)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">严格安全模式</div>
                <div className="text-[10.5px] text-mut">
                  {cliRelaxed
                    ? "当前为兼容模式，可手动开启"
                    : "默认开启，拦截危险内容与内网请求"}
                </div>
              </div>
              <Toggle
                on={strictSecurity}
                disabled={!strictSecurityReady || securityPending}
                onChange={(on) => {
                  void setStrictSecurity(on).then(() => {
                    toast(on ? "已开启严格安全模式" : "已切换为兼容模式", "info");
                  }).catch(() => toast("安全设置保存失败，已保持原模式", "info"));
                }}
                label="严格安全模式"
              />
            </div>
            <button onClick={() => void diagnose()} disabled={diagnosis?.status === "loading"}
              className="hg-ios-settings-row w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("link", <ILink size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">网络诊断</div>
                <div className="text-[10.5px] text-mut">检测当前线路的 DNS / 系统代理 / 网站连接</div>
              </div>
              {symbol("chevron.right", <IChevR size={15} />, 15, "text-mut")}
            </button>
          </Section>

          {!isIos && <Section title="其他">
            <button onClick={checkUpdate} disabled={checking} className="hg-ios-settings-row w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("arrow.clockwise", <IRefresh size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">检查更新</div>
                <div className="text-[10.5px] text-mut">{checking ? "检查中…" : `当前 v${APP_VERSION} · 对比 GitHub Release`}</div>
              </div>
              {symbol("chevron.right", <IChevR size={15} />, 15, "text-mut")}
            </button>
            <button onClick={() => setAbout(true)} className="hg-ios-settings-row w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 shrink-0 rounded-full bg-s3 flex items-center justify-center text-primary">{symbol("info.circle", <IInfo size={16} />)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">关于 {APP_NAME}</div>
                <div className="text-[10.5px] text-mut">版本 {APP_VERSION} · 仅限非商业使用</div>
              </div>
              {symbol("chevron.right", <IChevR size={15} />, 15, "text-mut")}
            </button>
          </Section>}

          <div className="text-center text-[10px] text-dim mt-5">{APP_NAME} {APP_VERSION} · {platformLabel} 客户端</div>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      <ActionDialog open={diagnosisOpen} onCancel={() => setDiagnosisOpen(false)} title="网络诊断"
        cancel="退出" confirm="复制诊断" disabled={diagnosis?.status !== "ready"}
        onConfirm={() => { if (diagnosis?.status === "ready") void copyDiagnosis(diagnosis.text); }}>
        {diagnosis?.status === "loading" && <p role="status">正在检测…</p>}
        {diagnosis?.status === "failed" && <p role="alert">诊断失败，请退出后重试。</p>}
        {diagnosis?.status === "ready" && <pre tabIndex={0} aria-label="诊断详情"
          className="select-text whitespace-pre-wrap break-all text-[11px] leading-5">{diagnosis.text}</pre>}
      </ActionDialog>

      {isIos ? (
        <Sheet open={about} onClose={() => setAbout(false)} fullPage="关于" sharedChrome z="z-[32]">
          <div className="hg-ios-about-page flex h-full min-h-0 flex-col">
            <IOSPageBar label="关于" overlay hidden={!about} onBack={() => setAbout(false)} endAction={
              <button type="button" aria-label="复制版本信息" onClick={() => void copyVersionInfo()}
                className="hg-ios-floating-button hg-ios-header-square grid place-items-center text-[13px] font-semibold text-primary">复制</button>
            }>
              <h1 className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">关于</h1>
            </IOSPageBar>
            <div className="hg-ios-browse-content flex-1 scroll-y">{aboutContent}</div>
          </div>
        </Sheet>
      ) : (
        <Modal open={about} onClose={() => setAbout(false)} width={392} label={`关于 ${APP_NAME}`}>
          {aboutContent}
        </Modal>
      )}

      <ConfirmAction open={historyClearOpen} title="清空观看历史"
        message="清空全部观看记录和续播进度？收藏与已下载分集会保留。" confirm="清空历史"
        onCancel={() => setHistoryClearOpen(false)}
        onConfirm={() => { clearHistory(); setHistoryClearOpen(false); }} />

      <ConfirmAction open={clearOpen} title="清理缓存"
        message="清理封面与播放列表的临时缓存？收藏、历史、登录状态和已下载分集都会保留。"
        confirm={clearing ? "清理中…" : "确定清理"} danger={false} busy={clearing} error={clearError}
        onCancel={() => { setClearError(""); setClearOpen(false); }}
        onConfirm={async () => {
          setClearing(true);
          setClearError("");
          try {
            await api.clearCache();
            setClearOpen(false);
            toast("缓存已清理", "ok");
          } catch {
            setClearError("缓存清理失败，请重试");
          } finally {
            setClearing(false);
          }
        }} />

      <Modal open={!!update?.has_update} onClose={() => setUpdate(null)} width={392} label="发现新版本">
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">发现新版本</div>
          <p className="text-[11.5px] text-mut mt-1.5">
            v{update?.current} → <b className="text-on">v{update?.latest}</b>
            {update?.published_at ? ` · ${update.published_at.slice(0, 10)}` : ""}
          </p>
          {!!update?.notes && (
            <div className="mt-3 max-h-[180px] scroll-y rounded-(--r-sm) bg-s2 p-3 text-[11px] text-mut whitespace-pre-wrap leading-relaxed">{update.notes}</div>
          )}
          <div className="flex gap-2 mt-4">
            <button onClick={() => setUpdate(null)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">稍后</button>
            <button onClick={() => {
              if (!update) return;
              api.openUrl(update.url).catch(() => {
                navigator.clipboard?.writeText(update.url).then(() => toast("下载地址已复制", "ok")).catch(() => {});
              });
            }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[12.5px] font-semibold text-on-primary pressable">前往下载</button>
          </div>
          <div className="text-[10px] text-dim mt-2.5 break-all">{update?.url}</div>
        </div>
      </Modal>
    </div>
  );
}
