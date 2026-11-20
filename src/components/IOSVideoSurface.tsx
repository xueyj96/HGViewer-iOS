import { IOS_LAYOUT_CHANGE } from "../iosGeometry";
import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { logLine } from "../api";
import { reportPlaybackStartup, type NativeOpen, type PlaybackStartupTiming, type Snapshot, type StartupSample } from "./iosPlaybackDiagnostics";
export type { PlaybackStartupTiming } from "./iosPlaybackDiagnostics";
import { formatQualityLevels, type PlaybackQuality } from "./PlaybackQuality";
import type { VideoHandle, VideoSurfaceProps } from "./VideoSurface";

type Action = "status" | "play" | "pause" | "seek" | "rate" | "volume" | "mute" | "close" | "quality" | "slide_out" | "slide_in" | "edge_pull" | "episode_pull";
type Failure = "open" | "start" | "status_or_seek" | "native_error" | "timeout" | "frame" | "loop_seek";
const FOREGROUND_FRAME_GRACE_MS = 1000;
const FOREGROUND_REOPEN_MS = 5000;
const STARTUP_TIMEOUT_MS = 20000;
const ERROR_DOMAINS = ["none", "AVFoundation", "URL", "CoreMedia", "POSIX", "other"];
const APP_STATES = ["active", "inactive", "background"];
export type NativeSource =
  | { kind: "offline"; id: number; ep: number; mp4: boolean }
  | { kind: "online"; url: string; watch_key?: number };
export function preloadIOSPlayback(source: NativeSource, options?: { prefetchSegment: boolean; prepareStandby: boolean }) {
  return invoke<void>("ios_player_preload", { source, ...options }).catch(() => {});
}

type Props = Pick<VideoSurfaceProps, "autoPlay" | "loop" | "muted" | "volume" | "rate" | "onTime" | "onDuration" | "onSize" | "onPlaying" | "onPause" | "onWaiting" | "onSeeked" | "onEnded" | "onQuality" | "onError" | "onClick"> & {
  source: NativeSource;
  startupTiming?: PlaybackStartupTiming;
  inset?: boolean;
  viewport?: boolean;
  enterDirection?: number;
  onEnter?: () => void;
  onPlaybackIntentChange?: (playing: boolean) => void;
};

// Leave room for a burst of opens and keep tokens increasing across WebView reloads.
let nextToken = Date.now() * 1024;

const control = (token: number, action: Action, value = 0, resume = false) =>
  invoke<Snapshot>("ios_player_control", { token, action, value, resume });

export default forwardRef<VideoHandle, Props>(function IOSVideoSurface(props, ref) {
  const { source, rate = 1, volume = 1, muted = false } = props;
  const sourceKey = JSON.stringify(source);
  const surface = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const session = useRef(0);
  const seekRevision = useRef(0);
  const wantsPlay = useRef(true);
  const motion = useRef<{ sending: boolean; pending?: { token: number; action: Action; value: number } }>({ sending: false });
  const [ready, setReady] = useState(false);

  const send = (action: Action, value = 0, resume = false) => {
    if (session.current) void control(session.current, action, value, resume).catch(() => {});
  };
  const setPlaybackIntent = (playing: boolean) => {
    wantsPlay.current = playing;
    latest.current.onPlaybackIntentChange?.(playing);
  };
  const play = () => { setPlaybackIntent(true); send("play"); };
  const pause = () => { setPlaybackIntent(false); send("pause"); };

  const sendMotion = async (action: "edge_pull" | "episode_pull" | "slide_out", value: number) => {
    if (!session.current) return;
    const state = motion.current;
    state.pending = { token: session.current, action, value };
    if (state.sending) return;
    state.sending = true;
    // Keep only the latest touch sample while the native command is in flight.
    while (state.pending) {
      const sample = state.pending;
      state.pending = undefined;
      await control(sample.token, sample.action, sample.value).catch(() => {});
    }
    state.sending = false;
  };

  useImperativeHandle(ref, () => ({
    el: () => null,
    isPlaying: () => wantsPlay.current,
    play,
    pause,
    toggle: () => { if (wantsPlay.current) pause(); else play(); },
    seek: (time, resume = false) => {
      if (!Number.isFinite(time)) return;
      ++seekRevision.current;
      if (resume) setPlaybackIntent(true);
      send("seek", time, wantsPlay.current);
    },
    setQuality: (level) => send("quality", level),
    slideOut: (direction) => void sendMotion("slide_out", direction),
    pullEdge: (offset, axis) => void sendMotion(axis === "horizontal" ? "episode_pull" : "edge_pull", offset),
  }));

  useEffect(() => {
    let token = 0;
    let alive = true;
    let timer = 0;
    let previous: Snapshot | undefined;
    let enterDirection = latest.current.enterDirection;
    let startup = 0;
    let lastReadAt = 0;
    let stalledFor = 0;
    let recoveredStall = false;
    const offline = source.kind === "offline" ? source : undefined;
    let reopenAvailable = true;
    let reopenPending = false;
    let reopenReadyLogged = false;
    let foregroundAt: number | undefined;
    let displayedFrame = false;
    let visibilityRevision = 0;
    let foregroundRecovery: { started: number; position: number; sought: boolean } | undefined;
    let lastPosition = 0;
    let restorePosition = 0;
    let levels: PlaybackQuality["levels"] = [];
    let startupSample: StartupSample | undefined;
    wantsPlay.current = latest.current.autoPlay ?? true;
    setReady(false);

    const log = (event: string, attempt: number, snapshot = previous, reason?: Failure) => {
      const category = offline ? "offline" : "online";
      void logLine(`[${category}-player] ${JSON.stringify({
        event, at: Date.now(), attempt, ep: offline?.ep, format: offline ? (offline.mp4 ? "mp4" : "hls") : undefined,
        hidden: document.hidden, wantsPlay: wantsPlay.current, positionMs: Math.round(lastPosition * 1000),
        sinceForegroundMs: foregroundAt === undefined ? undefined : Math.round(performance.now() - foregroundAt),
        reason, status: snapshot?.status, ready: snapshot?.ready,
        appState: snapshot ? APP_STATES[snapshot.app_state] : undefined,
        errorDomain: snapshot?.error_domain ? ERROR_DOMAINS[snapshot.error_domain] : undefined,
        errorCode: snapshot?.error_domain ? snapshot.error_code : undefined,
        underlyingDomain: snapshot?.underlying_domain ? ERROR_DOMAINS[snapshot.underlying_domain] : undefined,
        underlyingCode: snapshot?.underlying_domain ? snapshot.underlying_code : undefined,
      })}`);
    };
    const scheduleReopen = () => {
      if (!reopenPending || document.hidden) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!alive || document.hidden) return;
        reopenPending = false;
        open();
      }, 250);
    };
    const visibilityChanged = () => {
      visibilityRevision += 1;
      if (token) log(document.hidden ? "background" : "foreground", token);
      if (document.hidden) {
        startupSample = undefined;
        foregroundRecovery = undefined;
        lastReadAt = 0;
        stalledFor = 0;
        return;
      }
      foregroundAt = performance.now();
      startup = foregroundAt;
      scheduleReopen();
      const attempt = session.current;
      if (!attempt) return;
      if (displayedFrame) foregroundRecovery = { started: foregroundAt, position: lastPosition, sought: false };
      // Reattach the existing frame geometry even if the viewport did not resize.
      lastRect = "";
      schedule();
      if (wantsPlay.current) void control(attempt, "play").catch(() => fail(attempt, "start"));
    };

    const isCurrent = (attempt: number) => alive && token === attempt;
    const fail = (attempt: number, reason: Failure, snapshot?: Snapshot) => {
      if (!isCurrent(attempt)) return;
      log(reopenAvailable ? "retry_scheduled" : "playback_error", attempt, snapshot, reason);
      token = 0;
      session.current = 0;
      window.clearTimeout(timer);
      void control(attempt, "close").catch(() => {});
      setReady(false);
      if (reopenAvailable) {
        reopenAvailable = false;
        restorePosition = !wantsPlay.current && foregroundRecovery ? foregroundRecovery.position : lastPosition;
        reopenPending = true;
        latest.current.onWaiting?.();
        scheduleReopen();
      } else {
        latest.current.onError?.("视频暂时无法播放，请稍后重试");
      }
    };
    let statusEnabled = 0;
    let readingAttempt = 0;
    let pendingWake = 0;
    let firstFrameWake = false;
    const read = async (attempt: number) => {
      if (!isCurrent(attempt) || readingAttempt === attempt) return;
      readingAttempt = attempt;
      const revision = visibilityRevision;
      try {
        const current = await control(attempt, "status");
        if (!isCurrent(attempt)) return;
        if (revision !== visibilityRevision) {
          timer = window.setTimeout(() => void read(attempt), 200);
          return;
        }
        const now = performance.now();
        const advancing = previous && Math.abs(current.time - previous.time) > 0.05;
        const canStall = offline || (displayedFrame && current.ready && current.status === 3 && current.duration > 0);
        if (!canStall || !wantsPlay.current || current.status === 4 || advancing || document.hidden) {
          stalledFor = 0;
          recoveredStall = false;
        } else if (lastReadAt) {
          stalledFor += Math.min(now - lastReadAt, 400);
        }
        lastReadAt = now;
        const recovery = foregroundRecovery;
        if (!document.hidden && current.ready) foregroundRecovery = undefined;
        const frameMissing = !document.hidden && !current.ready && current.status !== 4;
        const timedOut = stalledFor >= STARTUP_TIMEOUT_MS
          || (frameMissing && (recovery ? now - recovery.started >= FOREGROUND_REOPEN_MS
            : now - startup >= STARTUP_TIMEOUT_MS));
        if (current.status < 0 || timedOut) {
          fail(attempt, current.status < 0 ? "native_error" : "timeout", current);
          return;
        }
        if (restorePosition > 0 && (current.ready || current.duration > 0)) {
          const position = restorePosition;
          restorePosition = 0;
          await control(attempt, "seek", position);
          if (isCurrent(attempt)) timer = window.setTimeout(() => void read(attempt), 200);
          return;
        }
        if (frameMissing && recovery && !recovery.sought
          && (current.status === 1 || current.status === 2) && current.duration > 0
          && now - recovery.started >= FOREGROUND_FRAME_GRACE_MS) {
          recovery.sought = true;
          log("foreground_frame_seek", attempt, current);
          await control(attempt, "seek", wantsPlay.current ? current.time : recovery.position, wantsPlay.current);
          if (isCurrent(attempt)) timer = window.setTimeout(() => void read(attempt), 200);
          return;
        }
        if (offline && !recoveredStall && stalledFor >= 3000 && (current.ready || current.duration > 0)) {
          // Restart decoding at the current position once, like a scrub that resumes playback.
          recoveredStall = true;
          await control(attempt, "seek", current.time);
          if (!isCurrent(attempt)) return;
        }
        const callbacks = latest.current;
        if (current.ready && !previous?.ready) {
          displayedFrame = true;
          if (enterDirection !== undefined) {
            const direction = enterDirection;
            enterDirection = undefined;
            await control(attempt, "slide_in", direction).catch(() => {});
            if (!isCurrent(attempt)) return;
            callbacks.onEnter?.();
          }
          setReady(true);
          if (startupSample && !document.hidden) {
            reportPlaybackStartup(attempt, source.kind, current, startupSample, latest.current.startupTiming,
              !reopenAvailable, firstFrameWake);
          }
          startupSample = undefined;
          if (!reopenAvailable && !reopenReadyLogged) {
            reopenReadyLogged = true;
            log("retry_ready", attempt, current);
          }
        }
        const snapshotSeekRevision = seekRevision.current;
        if (current.duration > 0 && current.duration !== previous?.duration) callbacks.onDuration?.(current.duration);
        if (current.width !== previous?.width || current.height !== previous?.height) {
          callbacks.onSize?.(current.width, current.height);
          if (levels.length) {
            const matching = levels.filter((level) => level.height === current.height);
            callbacks.onQuality?.({ levels, current: matching.length === 1 ? matching[0].index : -1 });
          }
        }
        // Duration can trigger a resume seek; this snapshot still holds the pre-seek time.
        if (!restorePosition && !(frameMissing && recovery && !wantsPlay.current)
          && seekRevision.current === snapshotSeekRevision && current.time !== previous?.time) {
          lastPosition = current.time;
          callbacks.onTime?.(current.time);
        }
        if (current.status !== previous?.status) {
          if (previous?.status === 3 && current.ready) callbacks.onSeeked?.();
          switch (current.status) {
            case 1: callbacks.onPause?.(); break;
            case 2: callbacks.onPlaying?.(); break;
            case 3: callbacks.onWaiting?.(); break;
            case 4:
              if (callbacks.loop) {
                void control(attempt, "seek", 0, true).catch(() => fail(attempt, "loop_seek"));
              } else {
                setPlaybackIntent(false);
                callbacks.onPause?.();
                callbacks.onEnded?.();
              }
              break;
          }
        }
        previous = current;
        timer = window.setTimeout(() => void read(attempt), 200);
      } catch { fail(attempt, "status_or_seek"); }
      finally {
        if (readingAttempt === attempt) readingAttempt = 0;
        if (pendingWake === attempt) {
          pendingWake = 0;
          if (isCurrent(attempt) && !displayedFrame) {
            window.clearTimeout(timer);
            void read(attempt);
          }
        }
      }
    };

    const nativeFirstFrame = (event: Event) => {
      const attempt = (event as CustomEvent<unknown>).detail;
      if (typeof attempt !== "number" || attempt !== statusEnabled || !isCurrent(attempt) ||
          displayedFrame || document.hidden) return;
      firstFrameWake = true;
      if (readingAttempt === attempt) {
        pendingWake = attempt;
      } else {
        window.clearTimeout(timer);
        void read(attempt);
      }
    };

    function open() {
      if (!alive) return;
      const attempt = ++nextToken;
      token = attempt;
      previous = undefined;
      displayedFrame = false;
      firstFrameWake = false;
      foregroundRecovery = undefined;
      lastReadAt = 0;
      stalledFor = 0;
      recoveredStall = false;
      lastRect = "";
      previousViewport = undefined;
      startupSample = undefined;
      const openingRevision = visibilityRevision;
      let stage: Failure = "open";
      void (async () => {
        const requestedAt = performance.now();
        const native = await invoke<NativeOpen>("ios_player_open", { source, token: attempt });
        if (!isCurrent(attempt)) return;
        stage = "start";
        session.current = attempt;
        startup = performance.now();
        if (!document.hidden && openingRevision === visibilityRevision) {
          startupSample = { requestedAt, nativeOpenedAt: startup, native };
        }
        levels = formatQualityLevels(native.levels);
        if (levels.length) latest.current.onQuality?.({ levels, current: -1 });
        updateFrame();
        await control(attempt, "rate", latest.current.rate ?? 1);
        await control(attempt, "volume", latest.current.volume ?? 1);
        await control(attempt, "mute", Number(!!latest.current.muted));
        if (!isCurrent(attempt)) return;
        await control(attempt, wantsPlay.current ? "play" : "pause");
        if (isCurrent(attempt)) {
          if (startupSample) startupSample.readyToPollAt = performance.now();
          statusEnabled = attempt;
          void read(attempt);
        }
      })().catch(() => fail(attempt, stage));
    }

    const marker = surface.current;
    let frame = 0;
    let lastRect = "";
    let previousViewport: boolean | undefined;
    function updateFrame() {
      frame = 0;
      if (!alive || !marker || !token || session.current !== token) return;
      const attempt = token;
      const viewport = latest.current.viewport ?? !latest.current.inset;
      const { x, y, width, height } = marker.getBoundingClientRect();
      const scroller = !viewport && marker.closest(".hg-native-feed-scroll, .hg-native-article-scroll")?.getBoundingClientRect();
      const rect = { x, y, width, height, top: scroller ? scroller.top : 0,
        bottom: scroller ? scroller.bottom : window.innerHeight, viewport };
      const signature = JSON.stringify(rect);
      if (signature === lastRect) return;
      lastRect = signature;
      const viewportChanged = previousViewport !== undefined && previousViewport !== viewport;
      previousViewport = viewport;
      void invoke("ios_player_frame", { token: attempt, rect }).then(() => {
        if (isCurrent(attempt) && viewportChanged) void control(attempt, "slide_in", 0).catch(() => {});
      }).catch(() => fail(attempt, "frame"));
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(updateFrame); };
    const observer = new ResizeObserver(schedule);
    if (marker) observer.observe(marker);
    window.addEventListener("hg-ios-first-frame", nativeFirstFrame);
    window.addEventListener("resize", schedule);
    window.addEventListener(IOS_LAYOUT_CHANGE, schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("fullscreenchange", schedule);
    document.addEventListener("animationend", schedule);
    document.addEventListener("visibilitychange", visibilityChanged);
    latest.current.onWaiting?.();
    open();

    return () => {
      observer.disconnect();
      window.removeEventListener("hg-ios-first-frame", nativeFirstFrame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener(IOS_LAYOUT_CHANGE, schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("fullscreenchange", schedule);
      document.removeEventListener("animationend", schedule);
      document.removeEventListener("visibilitychange", visibilityChanged);
      cancelAnimationFrame(frame);
      alive = false;
      session.current = 0;
      window.clearTimeout(timer);
      if (token) void control(token, "close").catch(() => {});
    };
  }, [sourceKey]);

  useEffect(() => { send("rate", rate); }, [rate]);
  useEffect(() => { send("volume", volume); }, [volume]);
  useEffect(() => { send("mute", Number(muted)); }, [muted]);

  return <div ref={surface} onClick={props.onClick} className={`absolute inset-0 touch-manipulation hg-native-video ${props.inset ? "is-inline" : ""} ${ready ? "is-ready" : ""}`} aria-hidden="true" />;
});
