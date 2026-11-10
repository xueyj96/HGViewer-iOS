import { invoke } from "@tauri-apps/api/core";

let rotationQueue = Promise.resolve();
let ownsLandscape = false;

function enqueueRotation(rotate: () => Promise<void>) {
  const operation = rotationQueue.then(rotate);
  rotationQueue = operation.catch(() => {});
  return operation;
}

async function applyOrientation(landscape: boolean) {
  await invoke<void>("set_ios_orientation", { landscape });
  ownsLandscape = landscape;
}

export function rotateIOSPlayback(landscape: boolean) {
  return enqueueRotation(() => applyOrientation(landscape));
}

export function restoreIOSPlaybackOrientation() {
  // Check after earlier requests settle. A rejected request never changes ownership.
  return enqueueRotation(async () => {
    if (ownsLandscape) await applyOrientation(false);
  });
}
