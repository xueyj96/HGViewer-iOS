# HGViewer iOS

基于 [Minireel/HGhub 1.1.0](https://github.com/Minireel/HGhub/tree/18555dd25bc8cae5c339daeb0325c869207906d9) 的非官方 iOS 衍生版。使用 Tauri 2、React 和 Rust，iOS 播放使用 AVPlayer。已打包的版本见 [GitHub Releases](https://github.com/xueyj96/HGViewer-iOS/releases)。

iOS 支持横竖屏播放、选集、离线缓存和播放记录。当前源码收敛了导航和播放器控制，修复切集时的原生白底闪烁。右侧操作栏在进入或离开播放页时淡入淡出，在播放页之间切换时保持在原位。

1.2.0 统一固定导航的形态交接：单标题、搜索与双／三分栏在原位切换，背景真实伸缩，文字和图标不缩放；六组顶栏分栏支持边缘跟手与首尾循环。全局登录与内容覆盖页明确唯一顶栏归属；底栏保持固定，通过颜色和图形过渡选中状态。清晰度、数量选择器、显示模式及长按菜单共用尺寸规则，倍速锁定提示保持矩形与紧凑图文间距。完整规则见[导航动效状态图](docs/navigation-motion.md)、[尺寸标准](docs/ui-dimensions.md)与[控件清单](docs/ui-dimensions-inventory.json)。

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

## 许可证

本项目适用 [PolyForm Noncommercial License 1.0.0](LICENSE)，保留 HGhub 贡献者的版权声明，仅限非商业用途。第三方内容和服务适用各自的授权条款。
