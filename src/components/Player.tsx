import React, { useEffect, useRef, useState } from "react";
import { QualityRailButton, QualitySheet, type PlaybackQuality } from "./PlaybackQuality";
import IOSRotateButton from "./IOSRotateButton";
import { IOSBackButton, IOSPageBar } from "./IOSPageBar";
import { PlaybackError } from "./ui";
import IOSVideoSurface from "./IOSVideoSurface";
import { usePlaybackTap } from "./usePlaybackTap";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import { directMedia, fmtTime, isIos } from "../api";
import { ICompress, IExpand, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;              // 原始 m3u8 地址
  poster?: string;          // 已处理好的封面地址（本地协议）
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onToggleMute?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  controls?: boolean;
  className?: string;
  nativeRef?: React.RefObject<VideoHandle | null>;
  nativeFullscreen?: boolean;
  onToggleNativeFullscreen?: () => void;
  enterDirection?: number;
  startTime?: number;
  onTime?: (time: number) => void;
};

export default function Player({
  src, poster, autoPlay, muted = false, loop = false, onEnded, onPlaying,
  onToggleMute, onRetry, retrying, controls = true, className = "",
  nativeRef, nativeFullscreen, onToggleNativeFullscreen, enterDirection, startTime = 0, onTime,
}: Props) {
  const internalSurface = useRef<VideoHandle>(null);
  const surface = nativeRef ?? internalSurface;
  const resumeAt = useRef(startTime);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [localFull, setFull] = useState(false);
  const full = nativeFullscreen ?? localFull;
  const [rate, setRate] = useState(1);
  const [quality, setQuality] = useState<PlaybackQuality | null>(null);
  const [qualityLevel, setQualityLevel] = useState(-1);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggle = () => surface.current?.toggle();

  const playbackTap = usePlaybackTap(toggle, () => {
    setQualityOpen(false);
    if (onToggleNativeFullscreen) onToggleNativeFullscreen();
    else setFull((value) => !value);
  }, src);
  const tapPicture = (e: React.MouseEvent<HTMLElement>) => {
    if (!isIos) { toggle(); return; }
    const bounds = wrapRef.current?.getBoundingClientRect();
    if (!bounds || e.detail === 0) { toggle(); return; }
    const x = (e.clientX - bounds.left) / bounds.width;
    const y = (e.clientY - bounds.top) / bounds.height;
    playbackTap.tap(x >= 0.3 && x <= 0.7 && y >= 0.25 && y <= 0.75);
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!duration) return;
    const target = Number(e.target.value) / 1000 * duration;
    surface.current?.seek(target);
    setTime(target);
  };

  const cycleRate = () => {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
  };

  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    void el.requestFullscreen?.().catch(() => {});
  };

  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const playback = {
    autoPlay,
    muted,
    rate,
    loop,
    onClick: tapPicture,
    onPlaying: () => { setPlaying(true); setWaiting(false); setErrMsg(""); onPlaying?.(); },
    onPause: () => { setPlaying(false); setWaiting(false); },
    onWaiting: () => setWaiting(true),
    onTime: (position: number) => { setTime(position); onTime?.(position); },
    onDuration: (length: number) => {
      setDuration(length);
      const position = resumeAt.current;
      resumeAt.current = 0;
      if (position > 0 && position < length) surface.current?.seek(position);
    },
    onEnded,
    onError: (message: string) => { setErrMsg(message); setWaiting(false); setPlaying(false); },
  };
  const webSource = /\.(mp4|m4v|webm)(?:[?#]|$)/i.test(src) ? directMedia(src) : src;

  return (
    <div ref={wrapRef} className={`relative bg-black overflow-hidden group hg-native-article-frame ${className} ${isIos && full ? "hg-native-article-full" : ""}`}>
      {isIos
        ? <IOSVideoSurface {...playback} ref={surface} source={{ kind: "online", url: src }}
            inset viewport={full} enterDirection={enterDirection} onQuality={setQuality} />
        : <VideoSurface {...playback} autoPlay={autoPlay ?? false} ref={surface} src={webSource} poster={poster}
            presentation="article" onPlay={() => setPlaying(true)} />}

      {isIos && full && onToggleNativeFullscreen && (
        <IOSPageBar label="全屏视频工具" overMedia overlay startAction={
          <IOSBackButton onBack={onToggleNativeFullscreen} label="退出视频全屏" overMedia />
        } />
      )}

      {errMsg && (isIos ? <PlaybackError message={errMsg} onRetry={onRetry} retrying={retrying} /> : (
        <div className="hg-article-video-error absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[10px] leading-tight text-red-300 break-all">
          {errMsg}
          {onRetry && <button type="button" disabled={retrying} onClick={onRetry}
            className="ml-2 py-1 text-white underline pressable disabled:opacity-50">{retrying ? "加载中…" : "重试"}</button>}
        </div>
      ))}

      {waiting && !errMsg && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-9 spinner" />
        </div>
      )}

      {!playing && !waiting && !errMsg && (
        <button onClick={tapPicture} aria-label="播放"
          className="absolute inset-0 flex items-center justify-center">
          <span className="hg-play-glyph w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
            <IPlayF size={26} className="text-white ml-0.5" />
          </span>
        </button>
      )}

      {controls && isIos && !full && !errMsg && (
        <div className="hg-ios-video-actions hg-ios-article-rail absolute right-3 z-30 flex flex-col items-center">
          {quality && quality.levels.length > 0 && <QualityRailButton quality={quality} selected={qualityLevel} onClick={() => setQualityOpen(true)} />}
          <IOSRotateButton />
        </div>
      )}

      {controls && (!isIos || (!full && !errMsg)) && (
        <div className={`hg-ios-inline-controls hg-ios-browse-content absolute inset-x-0 bottom-0 px-3 pb-2 pt-8 bg-gradient-to-t from-black/80 to-transparent transition-opacity ${isIos ? "" : "opacity-0 group-hover:opacity-100"}`}>
          <input aria-label="播放进度" type="range" min={0} max={1000} value={Math.round(pct * 10)} onChange={onSeek}
            className="hg-range w-full" style={{ "--fill": `${pct}%` } as React.CSSProperties} />
          <div className="flex items-center gap-3 mt-1 text-white">
            <button onClick={toggle} aria-label={playing ? "暂停" : "播放"} className="pressable">
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </button>
            <button onClick={() => onToggleMute?.()} aria-label={muted ? "取消静音" : "静音"} aria-pressed={muted} className="pressable">
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </button>
            <span className="text-[11px] tabular-nums text-white/85">{fmtTime(time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <button onClick={cycleRate} className="text-[11px] font-bold text-white/85 pressable tabular-nums">{rate}x</button>
            {!isIos && <button onClick={toggleFull} aria-label="全屏" className="pressable">
              {full ? <ICompress size={16} /> : <IExpand size={16} />}
            </button>}
          </div>
        </div>
      )}
      <QualitySheet open={qualityOpen} quality={quality} selected={qualityLevel} onClose={() => setQualityOpen(false)}
        onSelect={(level) => {
          surface.current?.setQuality(level);
          setQualityLevel(level);
          setQualityOpen(false);
        }} />
    </div>
  );
}
