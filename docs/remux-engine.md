# HGRemux：本地 HLS 合成单个 MP4

HGRemux 将完整本地 HLS 中的 H.264／HEVC 视频和可选 AAC 音频无重编码封装为一个 fragmented MP4。它不解码、不联网、不修改或删除源分片。剧集文件命名、迁移标记、播放读取租约、元数据提交和提交后的分片清理由 Rust 层负责。

## 构建与产物

需要 macOS、Xcode、Python 3.12+ 和系统 OpenSSL。在仓库根目录执行：

```sh
python3 scripts/build-remux-ios.py --jobs 4
```

产物为 `build/remux/HGRemux.xcframework`，包含 iOS 真机 arm64 和模拟器 arm64 两个切片，最低 iOS 17.0。所有构建输出均位于已忽略的 `build/remux`。`--jobs` 限 1–4；`--platform ios-arm64` 或 `--platform ios-simulator-arm64` 可只构建一个切片，再运行默认命令会恢复双切片产物。`--offline` 要求 `build/remux/downloads` 已有三个固定来源文件。

固定来源为 FFmpeg 9.0.2 官方发行包，SHA-256 为 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`。脚本同时验证 SHA-256 和 detached RSA/OpenPGP 签名，公钥指纹固定为 `FCF986EA15E6E293A5644F10B4322F04D67658D8`；缺失输入仅从 `https://ffmpeg.org` 下载。构建不依赖任何其他 App 的目录、品牌或个人构建路径。

只链接 avformat、avcodec、avutil，启用 HLS／MPEG-TS／MOV demuxer、MP4 muxer、file protocol、H.264／HEVC／AAC parser，以及 AAC ADTS-to-ASC、extradata extraction、null bitstream filter。禁用 network、encoder、decoder、GPL、nonfree、version3、命令行程序、硬件加速自动发现、外部依赖、swscale 和 swresample。脚本检查最终配置中没有意外启用的编解码器及禁止项。缓存复用还要求三个静态库的 SHA-256 和精确配置都匹配；需要重建时，先在该平台的专用 work 目录重新解压已验证的官方源码，避免编译可变旧源码后仍声明来源未修改。

静态 FFmpeg 与 LGPL C wrapper 一起链接为可独立替换的**动态** framework，install name 为 `@rpath/HGRemux.framework/HGRemux`。只导出 `hg_remux_*` C ABI。构建产物使用 ad-hoc 签名，App 打包时须嵌入相应切片并用 App 的签名身份重新签名。

## C ABI 与线程

接口见 `src-tauri/native/remux/HGRemux.h`。调用顺序为：

1. `hg_remux_job_create()` 分配 job。
2. 在 App 控制的有界后台 worker 中同步执行 `hg_remux_run(job, absolute_index_m3u8, absolute_final_mp4)`。
3. 其他线程可轮询 `hg_remux_job_progress(job)`，范围 0–10000；10000 表示输出已原子发布。
4. 任意线程可用 `hg_remux_job_cancel(job)` 请求取消。取消标记不会重置，重试应使用新 job。
5. 必须等 worker 结束后再执行 `hg_remux_job_destroy(job)`；同一 job 的运行、验证和销毁不得重叠。并发 run／validate 返回 BUSY。

`hg_remux_validate(job, absolute_existing_mp4)` 不修改文件，用于恢复「文件已发布、App 元数据尚未提交」的崩溃窗口。它检查完整顶层 MP4 box 边界、`ftyp/moov/moof/mdat`、末尾 `mfra`、受支持的 codec configuration，以及每个配置音视频轨至少一个可读 packet 和单调 DTS。调用者必须在验证期间保持文件不变，并用持久化转换标记把它绑定到正确剧集。这里是结构验证，不能替代完整视频解码或源内容身份校验。

返回码为 OK=0、CANCELLED=1、UNSUPPORTED=2、IO=3、INVALID=4、INTERNAL=5、EXISTS=6、BUSY=7。线程安全的 error accessor 只返回固定阶段和 FFmpeg 通用错误说明，不包含路径或 URL。framework 私有 FFmpeg 的默认 stderr 日志已关闭，避免本地文件名进入 App 日志。

## 媒体和文件契约

输入是带 `ENDLIST` 的 UTF-8 本地 `index.m3u8`，支持一个视频轨和至多一个 AAC 音频轨。playlist 根目录先 canonicalize，再检查同目录 `.ts`、`.mp4`、`.m4s` 普通文件。拒绝 URL、目录穿越、分片／init-file 软链、远端 key、byte range、master／多 rendition 清单、gap 和显式 discontinuity；自定义 I/O callback 也会检查 FFmpeg 的每次文件打开。转换期间源文件必须保持不变。

HG 下载层已移除 AES，此引擎处理明文封装，不处理加密或 DRM。TS 限普通 188-byte packet，其他 packet 大小保留 HLS。资源限制为 manifest 1 MiB、单分片／packet 16 MiB、初始交错缓存 4 MiB、最多 16 个输入流、200000 个分片、一千万个 packet 和 24 小时；FFmpeg probe 限 4 MiB／2048 packets／10 秒。这些是代码预算，不能当作实测总 RSS 上限。

编码 packet 流式经过 bitstream filter。AAC ADTS 在写 MP4 header 前转换为 AudioSpecificConfig；视频 parser 只读 SPS 等格式头，不启用 decoder。禁 decoder 时，ADTS 稀疏 PES 时间戳以最近真实 DTS 和精确采样数恢复，44.1 kHz 使用有理数累计，避免逐帧舍入漂移。使用共同 timeline origin 保留 A/V 起点差及 B-frame composition offset；时间戳加减先检查可表示范围，异常值直接拒绝。Annex-B start code／尾零只用于配置比较规范化，真正 codec configuration 变化或 DTS 回退返回 UNSUPPORTED。完成前检查实际媒体时间轴覆盖清单时长，容差 250 ms。

输出使用 `frag_keyframe+delay_moov+default_base_moof`、2 秒最大 fragment duration、4 MiB fragment size、显式 edit list 和 1 MHz movie timescale。延迟 moov 让首段真实时间戳参与轨道起点设置，避免 empty_moov 把首个 AAC sample 拉到零；时间和字节两种切片条件限制长 GOP／高码率的 mux 索引占用。每送入 4 MiB payload 还会显式 flush FFmpeg interleaving queue；两个字节预算均可能加上一个最多 16 MiB packet，不能误读为整个进程只占 4 MiB。

输出先在目标同目录以独占随机文件创建，通过引擎持有的 file descriptor 流式写入。成功后 flush、fsync，再用不替换已有目标的 hard link 原子发布；现有目标绝不会被覆盖。失败或取消只清理本次私有临时输出，保留全部源分片。崩溃可能留下 `*.hgremux-*`，只能由确认没有活跃 writer 的转换 owner 清理。App 在权威元数据提交且读取租约释放后才能删除旧分片。

不支持的 discontinuity、配置变化等继续保留 HLS，不得显示成「已合成 MP4」。

## 回归工具与证据边界

`src-tauri/native/remux/smoke.c` 使用与 App 完全相同的 C ABI。开发机装有 FFmpeg 和 pkg-config 时可执行：

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror \
  $(pkg-config --cflags libavformat libavcodec libavutil) \
  src-tauri/native/remux/HGRemux.c src-tauri/native/remux/smoke.c \
  $(pkg-config --libs libavformat libavcodec libavutil) \
  -o build/remux/smoke-host
python3 src-tauri/native/remux/test-smoke.py --engine build/remux/smoke-host
```

测试用开发机 FFmpeg CLI 生成 H.264／HEVC、48 kHz／44.1 kHz AAC、TS／fMP4、B-frame 和无音轨素材，比较逐帧解码 hash、音频 PCM hash、共同 origin 下各轨 PTS／DTS（容差 1 ms）。还覆盖现有输出不覆盖、验证复用、初始化与写出期取消、私有临时文件清理、TS／fMP4 截断、discontinuity、视频／AAC 配置变化、远端地址和目录穿越。CLI 不随 App 发布。

host 使用另一版本 FFmpeg 时，仅证明该版本上的 wrapper；发行前还须对固定源码构建的 simulator framework 运行同一套用例。报告写在指定测试输出目录的 `smoke-results.json`。原生 C ABI 回归不等于 App 迁移、真实 iPhone 后台、AVPlayer 播放或存储连续性均已验收，这些由 App 集成层另测。

## LGPL 源码与替换

This software uses libraries from the FFmpeg project under the LGPLv2.1 or later. FFmpeg copyright belongs to its contributors. HGRemux C wrapper is licensed LGPL-2.1-or-later.

完整许可证为 `src-tauri/native/remux/COPYING.LGPLv2.1`。FFmpeg 源码不作修改；构建生成可直接运行的 `build/remux/source-packet` 树，包含精确源码包、签名、公钥、未修改说明、配置、wrapper 源码、构建脚本和说明文档，`manifest.json` 记录产物 SHA-256。包含此 framework 的发行版须在同一下载服务提供相应 source packet，并在 App About／许可证页面、下载页保留 FFmpeg／LGPL acknowledgement 和该源码下载链接；仅链接 upstream 不能标识实际对应构建。

替换时，取得对应 source packet，按 LGPL 修改或替换库／wrapper，运行其 `scripts/build-remux-ios.py`，保留公开 ABI 和 install name，替换 App 内相应 `HGRemux.framework` 切片，再用接收者可用的身份重新签名 framework 与 App。App 动态链接此库，重建 FFmpeg 所在动态库不需要专有 App object files；不得额外禁止 LGPL 允许的、为调试此类修改而进行的逆向工程。iOS 签名及安装要求仍属于平台要求。

参考：[FFmpeg remuxing API 示例](https://ffmpeg.org/doxygen/trunk/remuxing_8c-example.html)、[AAC ADTS-to-ASC](https://ffmpeg.org/ffmpeg-bitstream-filters.html#aac_005fadtstoasc)、[FFmpeg license checklist](https://ffmpeg.org/legal.html)。
