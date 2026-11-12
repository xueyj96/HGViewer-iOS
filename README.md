# HGViewer iOS

基于 [Minireel/HGhub 1.1.0](https://github.com/Minireel/HGhub/tree/18555dd25bc8cae5c339daeb0325c869207906d9) 的非官方 iOS 衍生版。使用 Tauri 2、React 和 Rust，iOS 播放使用 AVPlayer。已打包的版本见 [GitHub Releases](https://github.com/xueyj96/HGViewer-iOS/releases)。

iOS 支持横竖屏播放、选集、离线缓存和播放记录。当前源码收敛了导航和播放器控制，修复切集时的原生白底闪烁。右侧操作栏在进入或离开播放页时淡入淡出，在播放页之间切换时保持在原位。

1.2.5 收敛播放来源、进度续播、移动手势与面板展示的职责，历史规则保持单一持久化入口。修复顶栏转场中快速点击分栏丢失的问题，底栏三个触控区域连续铺满且按压时不缩小。源站已下线的两个频道不再保留失效入口；本地缓存不受影响。

固定顶底栏保持原位，六组顶栏分栏支持边缘跟手与首尾循环。完整交互规则见[导航动效状态图](docs/navigation-motion.md)，维护边界见[重构记录](docs/hg-refactor-plan.md)。

维护入口和发布校验见 [架构说明](ARCHITECTURE.md)。

## 本地构建

准备 Xcode、Node.js 22、pnpm 10、Rust 及 Apple iOS 工具链。

```bash
pnpm install --frozen-lockfile
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm version:sync
pnpm build
pnpm ios:sim
```

实体 iPhone 开发可用 `pnpm ios:build --debug --open` 打开 Xcode 工程，选择自己的 Signing Team 和 Bundle Identifier 后构建安装。

Release 中的 `unsigned.ipa` 不含开发者签名或设备描述文件，需要使用下载者自己的证书重新签名安装；它不是 App Store 安装包。

## 许可证

本项目适用 [PolyForm Noncommercial License 1.0.0](LICENSE)，保留 HGhub 贡献者的版权声明，仅限非商业用途。第三方内容和服务适用各自的授权条款。
