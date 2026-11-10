import type { HlsConfig } from "hls.js";

// Every Web player keeps upstream resource requests behind the app's media proxy.
export const commonHlsOptions = {
  interstitialsController: undefined,
  contentSteeringController: undefined,
  enableInterstitialPlayback: false,
  enableWorker: true,
  backBufferLength: 30,
  manifestLoadingTimeOut: 20000,
  manifestLoadingMaxRetry: 3,
  fragLoadingMaxRetry: 4,
} satisfies Partial<HlsConfig>;
