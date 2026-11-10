import { useState } from "react";
import { isIos } from "../api";
import { IRotateScreen } from "../icons";
import { useStore } from "../store";
import { rotateIOSPlayback } from "./iosPlaybackOrientation";

export default function IOSRotateButton() {
  const { toast } = useStore();
  const [pending, setPending] = useState(false);
  if (!isIos) return null;

  const rotate = async () => {
    const landscape = !window.matchMedia("(orientation: landscape)").matches;
    setPending(true);
    try {
      await rotateIOSPlayback(landscape);
    } catch (error) {
      toast(typeof error === "string" ? error : "暂时无法转屏", "info");
    } finally {
      setPending(false);
    }
  };

  return (
    <button type="button" aria-label="转屏" title="转屏" disabled={pending} onClick={rotate}
      className="hg-ios-media-button pressable">
      <IRotateScreen size={21} />
    </button>
  );
}
