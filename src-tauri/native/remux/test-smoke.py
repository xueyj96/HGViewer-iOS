#!/usr/bin/env python3
"""Generate local synthetic fixtures and exercise the HGRemux C ABI executable."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]

def run(args):
    return subprocess.run([str(x) for x in args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

def generate(folder, *, fragmented=False, audio=True, size="320x180", codec="libx264", sample_rate=48000, dense=False):
    folder.mkdir(parents=True)
    args = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25"]
    if audio: args += ["-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={sample_rate}"]
    args += ["-t", "5", "-c:v", codec, "-threads", "2", "-bf", "2", "-g", "25"]
    if codec == "libx265": args += ["-x265-params", "pools=1:frame-threads=1:log-level=error"]
    if dense: args += ["-vf", "noise=alls=30:allf=t+u", "-crf", "0"]
    args += ["-c:a", "aac"] if audio else ["-an"]
    args += ["-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod"]
    if fragmented: args += ["-hls_segment_type", "fmp4"]
    suffix = "mp4" if fragmented else "ts"
    args += ["-hls_segment_filename", folder / f"%d.{suffix}", folder / "index.m3u8"]
    run(args)
    return folder / "index.m3u8"

def video_frames(path):
    text = run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"]).stdout
    return [line.rsplit(",", 1)[-1].strip() for line in text.splitlines() if line and not line.startswith("#")]

def audio_hash(path):
    return run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"]).stdout.strip()

def packet_timeline(path):
    text = run(["ffprobe", "-v", "error", "-show_packets", "-show_entries", "packet=codec_type,pts_time,dts_time", "-of", "json", path]).stdout
    packets = json.loads(text)["packets"]
    origin = min(float(packet["dts_time"]) for packet in packets)
    tracks = {}
    for packet in packets:
        tracks.setdefault(packet["codec_type"], []).append((float(packet["pts_time"]) - origin, float(packet["dts_time"]) - origin))
    return tracks

def assert_timeline_equal(source, output):
    before, after = packet_timeline(source), packet_timeline(output)
    assert before.keys() == after.keys(), "track types changed"
    for kind in before:
        assert len(before[kind]) == len(after[kind]), (kind, "packet count changed")
        assert all(abs(a - b) < 0.001 for left, right in zip(before[kind], after[kind]) for a, b in zip(left, right)), (kind, "relative PTS/DTS changed")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "build/remux")
    args = parser.parse_args()
    engine = args.engine.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    def call(label, arguments, expected):
        completed = subprocess.run([str(engine), *map(str, arguments)], text=True, capture_output=True)
        assert completed.returncode == expected, (label, completed.returncode, completed.stdout, completed.stderr)
        results.append(dict(test=label, result=completed.returncode, detail=completed.stdout.strip()))
        return completed.stdout
    with tempfile.TemporaryDirectory(prefix="hg-remux-smoke-", dir=args.output) as temporary:
        base = Path(temporary).resolve()
        sources = {}
        for name, fragmented, audio, codec, rate, dense in (
            ("ts-bframes-aac", False, True, "libx264", 48000, False),
            ("fmp4", True, True, "libx264", 48000, False),
            ("noaudio", False, False, "libx264", 48000, False),
            ("aac-44100", False, True, "libx264", 44100, False),
            ("hevc-ts", False, True, "libx265", 48000, False),
            ("byte-budgets", False, True, "libx264", 48000, True),
        ):
            source = generate(base / name, fragmented=fragmented, audio=audio, codec=codec, sample_rate=rate,
                              size="640x360" if dense else "320x180", dense=dense)
            sources[name] = source
            if dense:
                assert sum(p.stat().st_size for p in source.parent.glob("*.ts")) > 8 * 1024 * 1024, "fixture does not exercise byte budgets"
            output = source.parent / "episode_1_20261113.mp4"
            before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.parent.iterdir() if p.is_file()}
            call(name, [source, output], 0)
            assert video_frames(source) == video_frames(output), name + " decoded video differs"
            assert_timeline_equal(source, output)
            if audio: assert audio_hash(source) == audio_hash(output), name + " decoded audio differs"
            assert all(hashlib.sha256((source.parent / name).read_bytes()).hexdigest() == digest for name, digest in before.items())
            call(name + "-validate", ["--validate", output], 0)
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
            call(name + "-no-overwrite", [source, output], 6)
            assert hashlib.sha256(output.read_bytes()).hexdigest() == digest
            broken = source.parent / "truncated-output.mp4"
            broken.write_bytes(output.read_bytes()[:-17])
            call(name + "-reject-truncated-output", ["--validate", broken], 4)
        source = sources["ts-bframes-aac"]
        for flag in ("--cancel", "--cancel-after"):
            output = base / (flag[2:] + ".mp4")
            detail = call(flag, [flag, source, output], 1)
            if flag == "--cancel-after":
                progress = int(detail.split("progress=", 1)[1].split()[0])
                assert 0 < progress < 10000, "cancellation did not interrupt packet processing"
                size = int(detail.split("cancel_bytes=", 1)[1].split()[0])
                assert size > 0, "cancellation happened before any output reached the file"
            assert not output.exists()
        for name in ("truncated", "truncated-fmp4", "discontinuity", "codec-change", "aac-config-change", "remote", "traversal"):
            folder = base / name
            shutil.copytree((sources["fmp4"] if name == "truncated-fmp4" else source).parent, folder)
            manifest = folder / "index.m3u8"
            if name == "truncated":
                segment = folder / "4.ts"
                segment.write_bytes(segment.read_bytes()[:-100])
                expected = 4
            elif name == "truncated-fmp4":
                segment = folder / "4.mp4"
                segment.write_bytes(segment.read_bytes()[:-10])
                expected = 4
            elif name == "discontinuity":
                manifest.write_text(manifest.read_text().replace("0.ts", "#EXT-X-DISCONTINUITY\n0.ts"))
                expected = 2
            elif name == "codec-change":
                other = generate(base / "other-codec-config", size="640x360")
                shutil.copy2(other.parent / "2.ts", folder / "2.ts")
                expected = 2
            elif name == "aac-config-change":
                shutil.copy2(sources["aac-44100"].parent / "2.ts", folder / "2.ts")
                expected = 2
            else:
                replacement = "https://example.invalid/0.ts" if name == "remote" else "../0.ts"
                manifest.write_text(manifest.read_text().replace("0.ts", replacement))
                expected = 4
            output = folder / "new.mp4"
            call(name, [manifest, output], expected)
            assert not output.exists(), name
        assert not list(base.rglob("*.hgremux-*")), "private output remained after normal failures"
    report = args.output / "smoke-results.json"
    report.write_text(json.dumps(dict(engine=str(engine), tests=results, decoded_media_equal=True, relative_timestamps_equal=True), ensure_ascii=False, indent=2) + "\n")
    print(f"PASS {len(results)} engine cases; decoded video/audio identical; {report}")

if __name__ == "__main__": main()
