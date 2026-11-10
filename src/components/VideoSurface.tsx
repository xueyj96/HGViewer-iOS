import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import type Hls from "hls.js";
import { commonHlsOptions } from "./hlsOptions";
import { trackPlaybackQuality, type PlaybackQuality } from "./PlaybackQuality";
import { isIos, isLocalMedia, playlist } from "../api";

const loadWebHls = import.meta.env.TAURI_ENV_PLATFORM === "ios" ? undefined : () => import("hls.js");

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  isPlaying: () => boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, resume?: boolean) => void;
  setQuality: (level: number) => void;
  slideOut?: (direction: number) => void;
  pullEdge?: (offset: number, axis?: "horizontal" | "vertical") => void;
};

export type VideoSurfaceProps = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  presentation?: "feed" | "article";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlay?: () => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onSeeked?: () => void;
  onQuality?: (quality: PlaybackQuality) => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: React.MouseEventHandler<HTMLElement>;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, VideoSurfaceProps>(function VideoSurface(
  { src, poster, autoPlay = true, muted = false, loop = false, fit = "contain", presentation = "feed", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlay, onPlaying, onPause, onWaiting, onSeeked, onQuality, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shouldAutoplay = useRef(autoPlay);
  shouldAutoplay.current = autoPlay;
  const callbacks = useRef({ onPause, onError, onQuality });
  callbacks.current = { onPause, onError, onQuality };
  const settings = useRef({ volume, muted, rate });
  settings.current = { volume, muted, rate };
  const resumeAfterSeek = useRef(false);
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    isPlaying: () => videoRef.current?.paused === false,
    play: () => { videoRef.current?.play().catch(() => {}); },
    pause: () => videoRef.current?.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => {}); else v.pause();
    },
    seek: (t: number, resume = false) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(t) || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
      resumeAfterSeek.current = resume;
      video.currentTime = t;
      if (resume && video.paused && !video.seeking) {
        resumeAfterSeek.current = false;
        void video.play().catch(() => {});
      }
    },
    setQuality: (level: number) => { if (hlsRef.current) hlsRef.current.loadLevel = level; },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let disposed = false;
    setReady(false);
    resumeAfterSeek.current = false;

    const proxied = isLocalMedia(src);
    const url = proxied ? src : playlist(src);
    const local = url.includes("/offline/");
    const useHls = !url.includes("/seg?u=") && !/\.mp4(?:[?#]|$)/i.test(url);

    const applySettings = () => {
      const current = settings.current;
      video.volume = current.volume;
      video.muted = current.muted;
      video.playbackRate = current.rate;
    };
    const playIfRequested = () => {
      if (!disposed && shouldAutoplay.current) {
        void video.play().catch(() => {
          if (!disposed) callbacks.current.onPause?.();
        });
      }
    };
    const attachDirect = () => {
      applySettings();
      video.src = url;
      playIfRequested();
    };

    const attachHls = async () => {
      if (!loadWebHls) return;
      const { default: Engine } = await loadWebHls();
      if (disposed) return;
      if (!Engine.isSupported()) {
        attachDirect();
        return;
      }
      applySettings();
      const hls = new Engine({
        ...commonHlsOptions,
        maxBufferLength: presentation === "article" ? 24 : 30,
        ...(presentation === "article" ? { lowLatencyMode: false } : {}),
        // On weak connections use the initial bandwidth estimate, then adapt as segments arrive.
        ...(!local && isIos ? { startLevel: -1, testBandwidth: false } : {}),
      });
      hlsRef.current = hls;
      if (isIos && !local && callbacks.current.onQuality) {
        trackPlaybackQuality(hls, Engine.Events, (quality) => callbacks.current.onQuality?.(quality));
      }
      hls.on(Engine.Events.MANIFEST_PARSED, playIfRequested);
      hls.on(Engine.Events.ERROR, (_e, data) => {
        if (disposed || !data.fatal) return;
        callbacks.current.onError?.("播放服务暂时不可用，请稍后重试");
        // hls.js has already spent its own retries. The caller can reload a fresh URL.
        hls.stopLoad();
      });
      hls.attachMedia(video);
      hls.loadSource(url);
    };
    if (useHls && loadWebHls) {
      void attachHls().catch(() => {
        if (!disposed) callbacks.current.onError?.("播放器暂时无法加载，请稍后重试");
      });
    } else {
      attachDirect();
    }

    return () => {
      disposed = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      } else if (video.hasAttribute("src")) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [src, presentation]);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={presentation === "article" ? undefined : { opacity: ready ? 1 : 0, transition: "opacity .35s" }}
      onLoadedData={(e) => { setReady(true); reapply(e.target as HTMLVideoElement); }}
      onTimeUpdate={(e) => onTime?.((e.target as HTMLVideoElement).currentTime)}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        onSize?.(v.videoWidth || 0, v.videoHeight || 0);
      }}
      onPlay={onPlay}
      onPause={onPause}
      onWaiting={() => onWaiting?.()}
      onSeeked={(e) => {
        const video = e.currentTarget;
        const resume = resumeAfterSeek.current;
        resumeAfterSeek.current = false;
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) onSeeked?.();
        if (resume && shouldAutoplay.current && video.paused) {
          void video.play().catch(() => onPause?.());
        }
      }}
      onPlaying={() => onPlaying?.()}
      onEnded={() => onEnded?.()}
      onError={() => {
        if ((isIos || presentation === "article") && !hlsRef.current) onError?.("视频暂时无法播放，请稍后重试");
      }}
    />
  );
});

export default VideoSurface;
