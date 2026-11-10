import type Hls from "hls.js";
import { ICheck } from "../icons";
import { CompactAction, Sheet } from "./ui";
import { IOSCloseButton } from "./IOSPageBar";
import { isIos } from "../api";

type QualityChoice = { index: number; height: number; bitrate: number };
type QualityLevel = QualityChoice & { label: string };
export type PlaybackQuality = { levels: QualityLevel[]; current: number };

export function formatQualityLevels(choices: QualityChoice[]): QualityLevel[] {
  return choices.map((choice) => {
    const { index, height, bitrate } = choice;
    const resolution = height ? `${height}p` : "";
    const rate = bitrate ? `${(bitrate / 1_000_000).toFixed(1)} Mbps` : "";
    const duplicate = choices.some((other) => other.index !== index && other.height === height);
    const label = [resolution, (!resolution || duplicate) ? rate : ""].filter(Boolean).join(" · ") || `档位 ${index + 1}`;
    return { index, height, bitrate, label };
  }).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
}

export function trackPlaybackQuality(hls: Hls, events: typeof Hls.Events, update: (quality: PlaybackQuality) => void) {
  const report = () => {
    const levels = formatQualityLevels(hls.levels.map(({ height, bitrate }, index) => ({ index, height, bitrate })));
    update({ levels, current: hls.currentLevel });
  };
  hls.on(events.MANIFEST_PARSED, report);
  hls.on(events.LEVEL_SWITCHED, report);
  hls.on(events.LEVELS_UPDATED, report);
}

export function QualityRailButton({ selected, quality, onClick }: {
  selected: number; quality: PlaybackQuality; onClick: () => void;
}) {
  const level = quality.levels.find((item) => item.index === selected);
  return <button type="button" aria-label="清晰度" onClick={onClick}
    className="hg-ios-media-button items-center text-[10.5px] font-bold text-white pressable">
    {selected < 0 ? "自动" : level?.height ? `${level.height}p` : "清晰度"}
  </button>;
}

export function QualitySheet({ open, quality, selected, onClose, onSelect }: {
  open: boolean; quality: PlaybackQuality | null; selected: number; onClose: () => void; onSelect: (level: number) => void;
}) {
  const levels = quality?.levels || [];
  const current = levels.find((item) => item.index === quality?.current);
  const choices = [{ index: -1, label: "自动" }, ...(levels.length > 1 ? levels : [])];
  return (
    <Sheet open={open && levels.length > 0} onClose={onClose} z="z-[55]" label="清晰度">
      <div className="hg-ios-browse-content px-4 pb-4">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-sm font-semibold text-on">清晰度</div>
          {isIos ? <IOSCloseButton onClose={onClose} /> : <CompactAction tone="neutral" onClick={onClose}>关闭</CompactAction>}
        </div>
        <p className="mb-2 text-xs text-mut">
          {levels.length === 1 ? "此视频只有一个清晰度" : current ? `当前播放 ${current.label}` : "自动按网速调整"}
        </p>
        <div className="max-h-[38vh] overflow-y-auto rounded-(--r-md) bg-s3">
          {choices.map((item) => (
            <button type="button" key={item.index} aria-pressed={selected === item.index}
              onClick={() => onSelect(item.index)}
              className="flex min-h-11 w-full items-center justify-between border-b border-s4 px-3 text-left text-sm text-on last:border-b-0 pressable">
              {item.label}{selected === item.index && <ICheck size={16} className="text-primary" />}
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
