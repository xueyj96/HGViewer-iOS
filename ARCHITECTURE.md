# HGViewer iOS 架构

HGViewer 用 React 渲染界面，Tauri 负责 WebView 与 Rust 的通信。iOS 通过 AVPlayer 播放，其他平台使用 Web 播放器。修改时先定位行为的所有者，再从对应入口验证。

| 要改什么 | 从哪里开始 |
| --- | --- |
| 标签、页面栈、主题 | [App.tsx](src/App.tsx)、[store.tsx](src/store.tsx)、[workspaceTabs.ts](src/workspaceTabs.ts) |
| iOS 固定顶栏、底栏、侧栏和安全区 | [IOSNavigation.tsx](src/components/IOSNavigation.tsx)、[IOSPageBar.tsx](src/components/IOSPageBar.tsx)、[ios.css](src/ios.css)、[useIOSHorizontalInsets.ts](src/components/useIOSHorizontalInsets.ts) |
| 播放、选集和评论 | 剧集从 [Feed.tsx](src/components/Feed.tsx) 进入，来源解析与邻集预取由 [usePlaybackSource.ts](src/components/usePlaybackSource.ts) 独立持有；图文视频从 [Posts.tsx](src/pages/Posts.tsx) 和 [Player.tsx](src/components/Player.tsx) 进入 |
| iOS 播放和转屏 | [IOSVideoSurface.tsx](src/components/IOSVideoSurface.tsx) → [ios_player.rs](src-tauri/src/ios_player.rs) → [ios_player.m](src-tauri/src/ios_player.m)；转屏由 [iosPlaybackOrientation.ts](src/components/iosPlaybackOrientation.ts) 和 [ios_orientation.rs](src-tauri/src/ios_orientation.rs) 负责 |
| 数据请求、线路和离线下载 | [api.ts](src/api.ts) → [lib.rs](src-tauri/src/lib.rs) → [api.rs](src-tauri/src/api.rs)、[net.rs](src-tauri/src/net.rs)、[network_policy.rs](src-tauri/src/network_policy.rs)；离线任务见 [offline.rs](src-tauri/src/offline.rs)、[offline_queue.rs](src-tauri/src/offline_queue.rs)、[offline_transfer.rs](src-tauri/src/offline_transfer.rs) |

## 页面和播放控件

`App` 管理当前路由和页面栈。页面内容在独立层内滑动，`IOSNavigation` 持有固定控件层。`IOSPageBar` 把当前页面的顶栏内容挂到固定容器。顶部动作与标题一起出现。需要异步数据的动作先保持原位并禁用，例如「选集」等到分集资料到齐才可点击。

`Feed` 提供侧栏按钮及其动作，固定容器负责显隐。进入和离开播放页时淡入淡出，播放页之间直接切换时更新按钮并保持侧栏位置。评论、详情和清晰度退场期间隐藏侧栏，退场完成后把键盘焦点交还原按钮。`finishMotion` 按实际动画完成时机清理；检查普通动画和「减少动态效果」两种设置。

## 播放会话的组合

`Feed` 保留当前作品/集数、播放意图、基准倍速与锁速、选集提交和业务面板请求。`usePlaybackProgress` 持有显示进度、一次性续播与历史写回；内容、active 会话与来源 attempt 分开，退休回调不能覆盖当前记录。同内容重试不重复首播记录，退出按 dirty 快照写回，时长回调内同步 seek，以保留原生同批旧 time 的抑制顺序。历史仍由 Store 的单一持久化入口保存，`watchHistory.ts` 集中作品去重、80 部上限和旧记录迁移策略。

`usePlaybackGestures` 统一移动端画面、侧栏和进度条的临时指针所有权。它只发播放、seek、切集和锁速请求，不选择具体集、不写历史、不打开播放源。持续锁速和145ms切集提交留在 Feed；取消与提交分开，失活/换源清理不能重新播放退休内容。桌面 `PlayerControls` 保留自己的鼠标控制。

`PlaybackPanels.tsx` 是模块作用域的纯展示组合，包含在线/离线详情、选集、评论与桌面 Dock。Feed 持有 requested panel、退出期间的 lastDetailPanel、分栏 controller、Sheet presence 和焦点返回；组件不复制这些状态，不申请第二个播放器或顶底栏宿主。缓存管理共用一个先 close、再 push 的动作，在线传集数列表，离线沿用已有缓存元数据。

回归入口：[进度会话](tests/playback-progress.html)、[移动手势](tests/playback-gestures.html)、[来源解析](tests/playback-source.html)、[顶栏命中接管](tests/topbar-hit-target.html) 可在 `pnpm dev` 下以 iPhone UA 打开，结果显示在测试页。历史纯策略使用 `node tests/watch-history.test.mjs`；`pnpm build` 同时检查产品与测试 TypeScript。浏览器模拟桥结果不能代替 AVPlayer 真机解码和触摸验收。

## 播放来源的所有者

`usePlaybackSource` 统一持有本地检查结果、在线URL记录和短期预热记录。Feed提供当前选择、重试身份、相邻候选和允许预取的时机，读取有效来源；重试通过`invalidateCurrentSource`清除当前项，调用方不能改整个URL表。来源模块不控制播放意图、不写历史、不发方向请求。当前仍保留原有450ms串行预取、30秒预热有效期和失效结果不发布的规则；已发出的请求尚不支持主动abort。

来源契约回归见[playback-source测试](tests/playback-source.html)，使用`pnpm dev`打开该测试页并启用iPhone UA；结果页报告本地优先、重试、迟到请求、预热复用／过期、取消与串行顺序。三App的分层、所有者和迁移边界见[结构契约v1](docs/cross-app-architecture.md)。

## 播放、转屏和数据

`Feed` 和 `Player` 管理剧集或图文播放上下文、控件和手势。播放器实现负责静音、音量和倍速的实际同步。iOS 原生桥按会话标识处理播放器命令，旧会话的关闭不能撤掉新播放器。AVPlayer 放在 WKWebView 后方，切集间隙保持黑底，页面外观由 Web 层绘制。

手动转屏和恢复竖屏共用一条请求队列。App 只恢复自己主动请求的横屏。播放页直接切换时保留方向；离开播放范围或从图文视频滑到下一篇时恢复。先前请求被拒绝时不更新状态。浏览器测试能核对请求顺序，系统竖屏锁和旋转动画要在 iPhone 上验证。

前端通过 Tauri 命令请求站点数据。媒体和封面使用本地协议，协议地址由平台决定。修改协议地址或路径时同时检查 Rust 端的注册和播放列表改写。离线任务队列与传输实现分开；iOS 背景下载见 [ios_download_background.rs](src-tauri/src/ios_download_background.rs)。覆盖安装须沿用设备上现有的 Bundle Identifier 和签名身份，安装前后读回构建号与数据清单。清理工作区产物与清理手机缓存是两项独立操作。

## 下载与续传

`useOfflineStatus` 共用一份状态快照和轮询，封面与详情使用相同的速度读数。缓存速度包含新写入和已验证复用的数据，网络速度只统计收到的数据，两者使用最近 30 秒的窗口。

`offline_transfer` 保存完整分片和摘要，恢复时先检查本地数据。内置线路可通过上游内容摘要复核变更地址后的分片。全局分片缓冲并发上限为 8，单片上限为 16 MiB，AES 解密复用原缓冲区。整集提交后删除对应暂存，启动时清理已完成集的残留。

`ios_download_background.m` 管理持续后台任务和设备空闲时的恢复调度。恢复注册在 iOS 入口完成，队列选择由 Rust 持久化。手动暂停和关闭后台下载会阻止恢复。系统调度时间和锁屏行为需要真机验证。

## 构建与验证

本地环境和构建命令见 [README](README.md)。应用版本以 `package.json` 为唯一来源；`pnpm build` 会校验各平台清单，`pnpm version:sync` 可同步版本字段。

- 改导航或动画时，检查首页、在线或缓存播放、资料库之间的进出，评论与详情返回、浅色与深色、紧凑横屏、左右安全区和减少动态效果。
- 改播放或转屏时，检查切集、暂停恢复、离开播放、播放页之间切换，以及请求未完成或被拒绝时的行为。模拟原生桥测试后，再在开启竖屏锁的真机上核对。
- 发版从对应源码构建，核对包内资源、平台和构建号。公开 Release 上传未签名 IPA 与 SHA-256 校验文件，发布后从公开链接重新下载核对。个人开发证书、描述文件、设备标识和诊断日志留在本地。

可以重建的产物包括 `dist`、Cargo `target`、Xcode `DerivedData` 和临时解包目录。清理前检查活跃构建，保留需要交付的包、校验文件和仍有用途的回归记录。

## 历史与确认操作

历史以实际开始播放为记录起点；准备播放源、暂停返回和未播放退出不创建记录。退出补写只属于当前播放会话。历史先去重、按最近观看排序，再保留最多 80 部；资料库每次显示 12 部，触底继续加载。详情请求失败作为已结算状态，不阻止后续历史；失败卡片支持显式重试和移除，不加入播放队列。

确认操作共用 `ConfirmAction`：首选宽 320、高 180，宽度不超过视口减去左右各 16；标题居中，正文最多三行，取消居左、确认居右。按钮可见尺寸 88 × 36，点击区域 88 × 44；标题、正文和按钮文案分别限制 16、60、4 字，完整内容保留给辅助功能。清空观看历史集中在设置中。

## 尺寸与操作菜单

尺寸角色集中在 `src/ios.css`；页面选择输入、内容行、卡片、状态等角色，避免重新定义局部高宽。`reserve/clearance` 提供导航与播放器同一份底部预算，侧栏按可用高度推导列数并保留系统安全区延迟兜底。规范与可复查清单见 `docs/ui-dimensions.md` 和 `docs/ui-dimensions-inventory.json`。

`IOSCoverMenu.ts` 只持有当前可用容器、动作模型和作用域事件路由；`CoverActionMenu.tsx` 负责长按、键盘、Popover/回退层、焦点和安全区定位；`coverMenuPreview.ts` 负责只读封面克隆和卡片锚定布局。背景、预览和菜单位于同一manual顶层，关闭后释放克隆；动画退出由幂等completion收敛，旋转或卸载可提前完成。原 UIKit 菜单桥已删除，所有封面操作仍由各页面原消费者执行。`ChoiceList/ChoiceRow` 只负责选项外框、行、文字与选中反馈；封面菜单与清晰度各自保留定位、焦点、选值和关闭流程。数量设置保留 HTML select 的原生选值行为，通过可定制 select 的 CSS 支持统一菜单样式，旧引擎保留功能回退。


## 分栏手势与固定导航

`IOSTabSwipe.tsx` 统一六组顶栏分栏：分类、资料库、榜单、频道排序、账号、剧集详情。页面只提供选中索引、提交回调和各栏内容；拖动与回弹期间保留原选中状态，只临时渲染相邻栏，提交后才切换请求与分页。邻栏不可交互、不启动缓存轮询。多栏页面左右边缘向内循环切换，首栏向前到末栏、末栏向后到首栏；单栏页面不占用返回手势。正文移动方向独立于目标索引，循环时仍从手势方向进入；返回使用固定顶栏返回按钮。滚动容器声明 `pan-y`，分栏忙碌期间不打开长按菜单。

`IOSSegments.tsx` 持有共享可视框和指示器几何；`IOSTabSwipe` 持有页面手势状态，设置的 `IOSSegmentedControl` 只持有本地指示器动画，不渲染页面预览。正文 pane 和分段指示器共用一次手势进度及完成时机，顶底栏通过现有导航 host 固定。`useIOSTopBarMotion.ts` 在持久顶栏内选择唯一 owner（全局登录优先于内容 overlay），分开处理真实背景几何与只读旧内容交接；不移动导航 host、不缩放文字，减少动态效果时直接完成。完整形态、来源路径、打断与验证边界见[导航动效状态图](docs/navigation-motion.md)。宽度或安全区变化取消拖动，单纯键盘高度变化不撤销选中操作。

分栏动画结束后保持终帧和目标pane，直到页面提交新的选中索引，再在layout阶段归零并释放动画；回弹也在邻栏移除后清理。不要在animation finished回调里先重置正文位移，否则React提交前可能绘制旧页。
