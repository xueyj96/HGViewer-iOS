# HGViewer iOS 架构

HGViewer 用 React 渲染界面，Tauri 负责 WebView 与 Rust 的通信。iOS 通过 AVPlayer 播放，其他平台使用 Web 播放器。修改时先定位行为的所有者，再从对应入口验证。

| 要改什么 | 从哪里开始 |
| --- | --- |
| 标签、页面栈、主题 | [App.tsx](src/App.tsx)、[store.tsx](src/store.tsx)、[workspaceTabs.ts](src/workspaceTabs.ts) |
| iOS 固定顶栏、底栏、侧栏和安全区 | [IOSNavigation.tsx](src/components/IOSNavigation.tsx)、[IOSPageBar.tsx](src/components/IOSPageBar.tsx)、[ios.css](src/ios.css)、[useIOSHorizontalInsets.ts](src/components/useIOSHorizontalInsets.ts) |
| 播放、选集和评论 | 剧集从 [Feed.tsx](src/components/Feed.tsx) 进入，图文视频从 [Posts.tsx](src/pages/Posts.tsx) 和 [Player.tsx](src/components/Player.tsx) 进入 |
| iOS 播放和转屏 | [IOSVideoSurface.tsx](src/components/IOSVideoSurface.tsx) → [ios_player.rs](src-tauri/src/ios_player.rs) → [ios_player.m](src-tauri/src/ios_player.m)；转屏由 [iosPlaybackOrientation.ts](src/components/iosPlaybackOrientation.ts) 和 [ios_orientation.rs](src-tauri/src/ios_orientation.rs) 负责 |
| 数据请求、线路和离线下载 | [api.ts](src/api.ts) → [lib.rs](src-tauri/src/lib.rs) → [api.rs](src-tauri/src/api.rs)、[net.rs](src-tauri/src/net.rs)、[network_policy.rs](src-tauri/src/network_policy.rs)；离线任务见 [offline.rs](src-tauri/src/offline.rs)、[offline_queue.rs](src-tauri/src/offline_queue.rs)、[offline_transfer.rs](src-tauri/src/offline_transfer.rs) |

## 页面和播放控件

`App` 管理当前路由和页面栈。页面内容在独立层内滑动，`IOSNavigation` 持有固定控件层。`IOSPageBar` 把当前页面的顶栏内容挂到固定容器。顶部动作与标题一起出现。需要异步数据的动作先保持原位并禁用，例如「选集」等到分集资料到齐才可点击。

`Feed` 提供侧栏按钮及其动作，固定容器负责显隐。进入和离开播放页时淡入淡出，播放页之间直接切换时更新按钮并保持侧栏位置。评论、详情和清晰度退场期间隐藏侧栏，退场完成后把键盘焦点交还原按钮。`finishMotion` 按实际动画完成时机清理；检查普通动画和「减少动态效果」两种设置。

## 播放、转屏和数据

`Feed` 和 `Player` 管理剧集或图文播放上下文、控件和手势。播放器实现负责静音、音量和倍速的实际同步。iOS 原生桥按会话标识处理播放器命令，旧会话的关闭不能撤掉新播放器。AVPlayer 放在 WKWebView 后方，切集间隙保持黑底，页面外观由 Web 层绘制。

手动转屏和恢复竖屏共用一条请求队列。App 只恢复自己主动请求的横屏。播放页直接切换时保留方向；离开播放范围或从图文视频滑到下一篇时恢复。先前请求被拒绝时不更新状态。浏览器测试能核对请求顺序，系统竖屏锁和旋转动画要在 iPhone 上验证。

前端通过 Tauri 命令请求站点数据。媒体和封面使用本地协议，协议地址由平台决定。修改协议地址或路径时同时检查 Rust 端的注册和播放列表改写。离线任务队列与传输实现分开；iOS 背景下载见 [ios_download_background.rs](src-tauri/src/ios_download_background.rs)。覆盖安装须沿用设备上现有的 Bundle Identifier 和签名身份，安装前后读回构建号与数据清单。清理工作区产物与清理手机缓存是两项独立操作。

## 下载与续传

`useOfflineStatus` 共用一份状态快照和轮询，封面与详情使用相同的速度读数。缓存速度包含新写入和已验证复用的数据，网络速度只统计收到的数据，两者使用最近 30 秒的窗口。

`offline_transfer` 保存完整分片和摘要，恢复时先检查本地数据。内置线路可通过上游内容摘要复核变更地址后的分片。全局分片缓冲并发上限为 8，单片上限为 16 MiB，AES 解密复用原缓冲区。整集提交后删除对应暂存，启动时清理已完成集的残留。

`ios_download_background.m` 管理持续后台任务和设备空闲时的恢复调度。恢复注册在 iOS 入口完成，队列选择由 Rust 持久化。手动暂停和关闭后台下载会阻止恢复。系统调度时间和锁屏行为需要真机验证。

## 构建与验证

本地环境和构建命令见 [README](README.md)。iOS 应用显示版本与构建号是两个字段，发版以 Xcode 工程的 `CFBundleVersion` 和 Release 标签为准。

- 改导航或动画时，检查首页、在线或缓存播放、资料库之间的进出，评论与详情返回、浅色与深色、紧凑横屏、左右安全区和减少动态效果。
- 改播放或转屏时，检查切集、暂停恢复、离开播放、播放页之间切换，以及请求未完成或被拒绝时的行为。模拟原生桥测试后，再在开启竖屏锁的真机上核对。
- 发版从对应源码构建，核对包内资源、平台和构建号。公开 Release 上传未签名 IPA 与 SHA-256 校验文件，发布后从公开链接重新下载核对。个人开发证书、描述文件、设备标识和诊断日志留在本地。

可以重建的产物包括 `dist`、Cargo `target`、Xcode `DerivedData` 和临时解包目录。清理前检查活跃构建，保留需要交付的包、校验文件和仍有用途的回归记录。

## 历史与确认操作

历史以实际开始播放为记录起点；准备播放源、暂停返回和未播放退出不创建记录。退出补写只属于当前播放会话。历史先去重、按最近观看排序，再保留最多 80 部；资料库每次显示 12 部，触底继续加载。详情请求失败作为已结算状态，不阻止后续历史；失败卡片支持显式重试和移除，不加入播放队列。

确认操作共用 `ConfirmAction`：固定 320 × 180，标题居中，正文最多三行，取消居左、确认居右。按钮可见尺寸 88 × 36，点击区域 88 × 44；标题、正文和按钮文案分别限制 16、60、4 字，完整内容保留给辅助功能。清空观看历史集中在设置中。
