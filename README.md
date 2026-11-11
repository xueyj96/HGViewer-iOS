# HGViewer iOS

基于 [Minireel/HGhub 1.1.0](https://github.com/Minireel/HGhub/tree/18555dd25bc8cae5c339daeb0325c869207906d9) 的非官方 iOS 衍生版。使用 Tauri 2、React 和 Rust，iOS 播放使用 AVPlayer。已打包的版本见 [GitHub Releases](https://github.com/xueyj96/HGViewer-iOS/releases)。

iOS 支持横竖屏播放、选集、离线缓存和播放记录。当前源码收敛了导航和播放器控制，修复切集时的原生白底闪烁。右侧操作栏在进入或离开播放页时淡入淡出，在播放页之间切换时保持在原位。

1.1.98 在分片续传与后台恢复的基础上，修复手动暂停的失败提示、限制媒体缓冲和缓存清理的并发开销。首次进入首页保持暂停；实际播放后才记录历史。历史触底续载、最多保留 80 部，清空操作集中到设置；确认弹窗共用固定尺寸和按钮布局。断点以完整 HLS 分片为单位，iOS 决定后台恢复的执行时间。

维护入口和发布校验见 [架构说明](ARCHITECTURE.md)。

## 本地构建

准备 Xcode、Node.js 22、pnpm 10、Rust 及 Apple iOS 工具链。

```bash
pnpm install --frozen-lockfile
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm build
pnpm ios:sim
```

实体 iPhone 开发可用 `pnpm ios:build --debug --open` 打开 Xcode 工程，选择自己的 Signing Team 和 Bundle Identifier 后构建安装。

## 许可证

本项目适用 [PolyForm Noncommercial License 1.0.0](LICENSE)，保留 HGhub 贡献者的版权声明，仅限非商业用途。第三方内容和服务适用各自的授权条款。
