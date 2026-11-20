import { logLine } from "../api";

export type Snapshot = {
  time: number; duration: number; width: number; height: number; status: number; ready: number;
  app_state: number; error_domain: number; error_code: number; underlying_domain: number; underlying_code: number;
  native_elapsed_ms?: number; item_ready_ms?: number; layer_ready_ms?: number; warm_asset?: number; standby_hit?: number;
  first_hls_media_response?: {
    requestMs: number;
    bytes: number;
    streamed?: boolean;
    watch?: {
      queueMs: number; cacheLookupMs?: number; upstreamReadMs?: number; recordMs?: number; cacheHit?: boolean; prefetchHit?: boolean;
      network?: { queueMs: number; attempts: number; responseHeadersMs?: number; firstBodyByteMs?: number; remainingBodyMs?: number };
    };
  };
};

export type PlaybackStartupTiming = {
  selectedAt: number;
  cacheMs?: number;
  resolveMs?: number;
  source?: "local" | "retained" | "preloaded" | "fresh" | "fresh_after_preload_failure";
};

type NativeLevel = { index: number; height: number; bitrate: number };
export type NativeOpen = {
  levels: NativeLevel[]; warm_input: boolean; input_ms: number;
  preload_join_ms?: number | null; manifest_ms?: number | null;
  main_queue_ms?: number; native_timing?: { close_ms: number; attach_ms: number };
};
const observedMs = (value?: number) => value !== undefined && value >= 0 ? Math.round(value) : undefined;

export type StartupSample = { requestedAt: number; nativeOpenedAt: number; readyToPollAt?: number; native: NativeOpen };

let remainingSamples = 48;

export function reportPlaybackStartup(
  attempt: number,
  kind: "online" | "offline",
  current: Snapshot,
  sample: StartupSample,
  timing: PlaybackStartupTiming | undefined,
  reopen: boolean,
  firstFrameWake: boolean,
) {
  if (remainingSamples <= 0) return;
  remainingSamples--;
  const frameAt = performance.now();
  const hlsMedia = current.first_hls_media_response;
  void logLine(`[playback-startup] ${JSON.stringify({
    at: Date.now(), attempt, kind, reopen,
    source: timing?.source ?? (kind === "offline" ? "local" : undefined),
    selectionToFrameMs: timing && !reopen ? Math.round(frameAt - timing.selectedAt) : undefined,
    cacheMs: timing?.cacheMs === undefined ? undefined : Math.round(timing.cacheMs),
    resolveMs: timing?.resolveMs === undefined ? undefined : Math.round(timing.resolveMs),
    nativePreloadJoinMs: sample.native.preload_join_ms ?? undefined,
    hlsManifestMs: sample.native.manifest_ms ?? undefined,
    firstHlsMediaResponseMs: hlsMedia?.requestMs,
    firstHlsMediaResponseBytes: hlsMedia?.bytes,
    firstHlsMediaStreamed: hlsMedia?.streamed,
    firstHlsMediaQueueMs: hlsMedia?.watch?.queueMs,
    firstHlsMediaCacheLookupMs: hlsMedia?.watch?.cacheLookupMs ?? undefined,
    firstHlsMediaUpstreamReadMs: hlsMedia?.watch?.upstreamReadMs ?? undefined,
    firstHlsMediaNetworkQueueMs: hlsMedia?.watch?.network?.queueMs,
    firstHlsMediaNetworkAttempts: hlsMedia?.watch?.network?.attempts,
    firstHlsMediaResponseHeadersMs: hlsMedia?.watch?.network?.responseHeadersMs ?? undefined,
    firstHlsMediaFirstBodyByteMs: hlsMedia?.watch?.network?.firstBodyByteMs ?? undefined,
    firstHlsMediaRemainingBodyMs: hlsMedia?.watch?.network?.remainingBodyMs ?? undefined,
    firstHlsMediaRecordMs: hlsMedia?.watch?.recordMs ?? undefined,
    firstHlsMediaCacheHit: hlsMedia?.watch?.cacheHit ?? undefined,
    firstHlsMediaPrefetchHit: hlsMedia?.watch?.prefetchHit,
    nativeWarmAsset: current.warm_asset === undefined ? undefined : ["none", "pending", "loaded"][current.warm_asset],
    nativeItemReadyMs: observedMs(current.item_ready_ms),
    nativeLayerReadyMs: observedMs(current.layer_ready_ms),
    nativeReadyToStatusMs: current.layer_ready_ms !== undefined && current.layer_ready_ms >= 0
      && current.native_elapsed_ms !== undefined ? observedMs(current.native_elapsed_ms - current.layer_ready_ms) : undefined,
    nativeWarmInput: sample.native.warm_input,
    nativeStandbyHit: current.standby_hit === undefined ? undefined : !!current.standby_hit,
    nativeInputMs: sample.native.input_ms,
    nativeMainQueueMs: sample.native.main_queue_ms,
    nativeCloseMs: observedMs(sample.native.native_timing?.close_ms),
    nativeAttachMs: observedMs(sample.native.native_timing?.attach_ms),
    nativeFirstFrameWake: firstFrameWake,
    openMs: Math.round(sample.nativeOpenedAt - sample.requestedAt),
    configureMs: sample.readyToPollAt === undefined ? undefined : Math.round(sample.readyToPollAt - sample.nativeOpenedAt),
    firstFramePollMs: sample.readyToPollAt === undefined ? undefined : Math.round(frameAt - sample.readyToPollAt),
  })}`);
}
