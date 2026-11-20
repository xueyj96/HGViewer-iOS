#!/usr/bin/env python3
"""Build pinned minimal LGPL HGRemux.xcframework. Requires Xcode and Python 3.12+."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "src-tauri/native/remux"
OUTPUT = ROOT / "build/remux"
VERSION = "9.0.2"
EXPECTED_SHA256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
EXPECTED_FINGERPRINT = "FCF986EA15E6E293A5644F10B4322F04D67658D8"
ARCHIVE = OUTPUT / "downloads" / f"ffmpeg-{VERSION}.tar.xz"
SIGNATURE = ARCHIVE.with_suffix(ARCHIVE.suffix + ".asc")
PUBLIC_KEY = OUTPUT / "downloads/ffmpeg-devel.asc"
EXPORTS = ("hg_remux_job_create", "hg_remux_job_cancel", "hg_remux_job_destroy", "hg_remux_run", "hg_remux_validate", "hg_remux_job_progress", "hg_remux_job_error", "hg_remux_version")

def run(args, *, cwd=None, log=None):
    print("+ " + " ".join(str(arg) for arg in args), flush=True)
    subprocess.run([str(arg) for arg in args], cwd=cwd, stdout=log, stderr=subprocess.STDOUT, check=True)

def armor_packets(path: Path):
    lines = path.read_text(encoding="ascii").splitlines()
    encoded = "".join(line for line in lines if line and not line.startswith("-----") and not line.startswith("="))
    blob = base64.b64decode(encoded, validate=True)
    offset = 0
    while offset < len(blob):
        header = blob[offset]
        offset += 1
        if header & 0x40:
            tag = header & 0x3F
            first = blob[offset]
            offset += 1
            if first < 192:
                length = first
            elif first < 224:
                length = ((first - 192) << 8) + blob[offset] + 192
                offset += 1
            elif first == 255:
                length = int.from_bytes(blob[offset:offset + 4], "big")
                offset += 4
            else:
                raise ValueError("OpenPGP partial packet lengths are unsupported")
        else:
            tag = (header >> 2) & 0x0F
            length_type = header & 0x03
            if length_type == 0:
                length = blob[offset]
                offset += 1
            elif length_type == 1:
                length = int.from_bytes(blob[offset:offset + 2], "big")
                offset += 2
            elif length_type == 2:
                length = int.from_bytes(blob[offset:offset + 4], "big")
                offset += 4
            else:
                length = len(blob) - offset
        packet = blob[offset:offset + length]
        if len(packet) != length:
            raise ValueError("Truncated OpenPGP packet")
        offset += length
        yield tag, packet


def read_mpi(data: bytes, offset: int) -> tuple[int, int]:
    bits = int.from_bytes(data[offset:offset + 2], "big")
    length = (bits + 7) // 8
    return int.from_bytes(data[offset + 2:offset + 2 + length], "big"), offset + 2 + length


def der_length(length: int) -> bytes:
    if length < 128:
        return bytes([length])
    raw = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def der_tlv(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + der_length(len(body)) + body


def der_integer(value: int) -> bytes:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    if raw[0] & 0x80:
        raw = b"\0" + raw
    return der_tlv(2, raw)


def verify_release_signature() -> None:
    """Verify v4 RSA OpenPGP detached signature using system OpenSSL, no GPG install."""
    public_packets = list(armor_packets(PUBLIC_KEY))
    key = next(packet for tag, packet in public_packets if tag == 6)
    if key[0] != 4 or key[5] not in (1, 2, 3):
        raise ValueError("Expected an OpenPGP v4 RSA primary key")
    fingerprint = hashlib.sha1(b"\x99" + len(key).to_bytes(2, "big") + key).hexdigest().upper()
    if fingerprint != EXPECTED_FINGERPRINT:
        raise ValueError(f"FFmpeg key fingerprint mismatch: {fingerprint}")
    modulus, offset = read_mpi(key, 6)
    exponent, _ = read_mpi(key, offset)

    signature = next(packet for tag, packet in armor_packets(SIGNATURE) if tag == 2)
    if signature[0] != 4 or signature[2] not in (1, 2, 3):
        raise ValueError("Expected a v4 RSA detached signature")
    hash_id = signature[3]
    hash_names = {8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224"}
    hash_name = hash_names.get(hash_id)
    if not hash_name:
        raise ValueError(f"Unsupported OpenPGP hash algorithm id {hash_id}")
    hashed_length = int.from_bytes(signature[4:6], "big")
    signed_prefix = signature[:6 + hashed_length]
    offset = 6 + hashed_length
    unhashed_length = int.from_bytes(signature[offset:offset + 2], "big")
    unhashed = signature[offset + 2:offset + 2 + unhashed_length]
    offset += 2 + unhashed_length

    issuer = None
    sub_offset = 0
    while sub_offset < len(unhashed):
        first = unhashed[sub_offset]
        sub_offset += 1
        if first < 192:
            sub_length = first
        elif first < 255:
            sub_length = ((first - 192) << 8) + unhashed[sub_offset] + 192
            sub_offset += 1
        else:
            sub_length = int.from_bytes(unhashed[sub_offset:sub_offset + 4], "big")
            sub_offset += 4
        if sub_length < 1:
            raise ValueError("Invalid OpenPGP signature subpacket")
        sub_type = unhashed[sub_offset] & 0x7F
        sub_body = unhashed[sub_offset + 1:sub_offset + sub_length]
        sub_offset += sub_length
        if sub_type == 16:
            issuer = sub_body.hex().upper()
    if issuer != fingerprint[-16:]:
        raise ValueError(f"OpenPGP issuer key id mismatch: {issuer}")

    expected_hash_prefix = signature[offset:offset + 2]
    signature_value, end = read_mpi(signature, offset + 2)
    if end != len(signature):
        raise ValueError("Trailing bytes in OpenPGP signature packet")
    hash_input = ARCHIVE.read_bytes() + signed_prefix + b"\x04\xff" + len(signed_prefix).to_bytes(4, "big")
    if hashlib.new(hash_name, hash_input).digest()[:2] != expected_hash_prefix:
        raise ValueError("OpenPGP signature digest prefix mismatch")

    rsa_body = der_integer(modulus) + der_integer(exponent)
    rsa_der = der_tlv(0x30, rsa_body)
    raw_signature = signature_value.to_bytes((modulus.bit_length() + 7) // 8, "big")
    with tempfile.TemporaryDirectory(prefix="ffmpeg-pgp-") as temporary:
        work = Path(temporary)
        key_der, key_pem = work / "rsa.der", work / "rsa.pem"
        signed_data, sig_data = work / "signed.bin", work / "signature.bin"
        key_der.write_bytes(rsa_der)
        signed_data.write_bytes(hash_input)
        sig_data.write_bytes(raw_signature)
        subprocess.run(["openssl", "rsa", "-RSAPublicKey_in", "-inform", "DER", "-in", str(key_der), "-pubout", "-out", str(key_pem)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["openssl", "dgst", f"-{hash_name}", "-verify", str(key_pem), "-signature", str(sig_data), str(signed_data)], check=True)
    print(f"OpenPGP signature: VERIFIED ({fingerprint})")



def tool(sdk, name):
    return subprocess.check_output(["xcrun", "--sdk", sdk, "--find", name], text=True).strip()

def ensure_sources(offline):
    for path, url in ((ARCHIVE, f"https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz"),
                      (SIGNATURE, f"https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz.asc"),
                      (PUBLIC_KEY, "https://ffmpeg.org/ffmpeg-devel.asc")):
        if path.is_file(): continue
        if offline: raise FileNotFoundError(f"Missing pinned source input: {path.name}")
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".download")
        try:
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as target:
                shutil.copyfileobj(response, target)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    actual = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    if actual != EXPECTED_SHA256: raise ValueError(f"FFmpeg archive SHA-256 mismatch: {actual}")
    verify_release_signature()

def build_one(platform, jobs):
    simulator = platform == "ios-simulator-arm64"
    sdk = "iphonesimulator" if simulator else "iphoneos"
    target = "arm64-apple-ios17.0" + ("-simulator" if simulator else "")
    sdk_path = subprocess.check_output(["xcrun", "--sdk", sdk, "--show-sdk-path"], text=True).strip()
    source = OUTPUT / "work" / platform / f"ffmpeg-{VERSION}"
    prefix = OUTPUT / "ffmpeg" / platform
    framework = OUTPUT / platform / "HGRemux.framework"
    log_path = OUTPUT / "logs" / f"{platform}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    source.parent.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        with tarfile.open(ARCHIVE, "r:xz") as archive: archive.extractall(source.parent, filter="data")
    options = [
        "--prefix=" + str(prefix), "--target-os=darwin", "--arch=arm64", "--enable-cross-compile",
        "--enable-pic", "--enable-static", "--disable-shared", "--disable-everything",
        "--disable-gpl", "--disable-nonfree", "--disable-version3", "--disable-network",
        "--disable-programs", "--disable-doc", "--disable-devices", "--disable-filters",
        "--disable-avdevice", "--disable-avfilter", "--disable-swscale", "--disable-swresample",
        "--disable-autodetect", "--disable-debug", "--disable-iconv", "--disable-zlib",
        "--disable-bzlib", "--disable-lzma", "--disable-sdl2", "--enable-pthreads",
        "--enable-avformat", "--enable-avcodec", "--enable-avutil",
        "--enable-demuxer=hls,mpegts,mov", "--enable-muxer=mp4", "--enable-protocol=file",
        "--enable-parser=h264,hevc,aac", "--enable-bsf=aac_adtstoasc,extract_extradata,null",
        "--cc=" + tool(sdk, "clang"), "--ar=" + tool(sdk, "ar"), "--ranlib=" + tool(sdk, "ranlib"),
        "--nm=" + tool(sdk, "nm"), "--sysroot=" + sdk_path,
        "--extra-cflags=-target " + target + " -isysroot " + sdk_path + " -fPIC",
        "--extra-ldflags=-target " + target + " -isysroot " + sdk_path,
    ]
    # Reuse only a build produced by the exact same configuration and source.
    stamp = prefix / "build-configuration.json"
    identity = dict(schema=2, source_sha256=EXPECTED_SHA256, options=options)
    libraries = [prefix / "lib" / f"lib{name}.a" for name in ("avformat", "avcodec", "avutil")]
    def library_hashes():
        return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in libraries}
    try:
        saved = json.loads(stamp.read_text())
        cached = saved.get("configuration") == identity and saved.get("libraries") == library_hashes()
    except (FileNotFoundError, ValueError, OSError):
        cached = False
    if not cached:
        # Never compile a reused mutable work tree and call it official source.
        shutil.rmtree(source.parent)
        source.parent.mkdir(parents=True)
        with tarfile.open(ARCHIVE, "r:xz") as archive: archive.extractall(source.parent, filter="data")
        with log_path.open("w") as log:
            run([source / "configure", *options], cwd=source, log=log)
            components = (source / "config_components.h").read_text()
            config = (source / "config.h").read_text()
            required = ("CONFIG_HLS_DEMUXER 1", "CONFIG_MPEGTS_DEMUXER 1", "CONFIG_MOV_DEMUXER 1", "CONFIG_MP4_MUXER 1", "CONFIG_AAC_ADTSTOASC_BSF 1")
            if any(x not in components for x in required): raise RuntimeError("Missing remux component")
            enabled = [line.split()[1] for line in components.splitlines() if line.startswith("#define CONFIG_") and line.endswith(" 1")]
            if any(x.endswith(("_ENCODER", "_DECODER")) for x in enabled): raise RuntimeError("Unexpected encoder/decoder")
            for flag in ("CONFIG_GPL", "CONFIG_NONFREE", "CONFIG_VERSION3", "CONFIG_NETWORK"):
                if f"#define {flag} 0" not in config: raise RuntimeError(f"Forbidden feature: {flag}")
            run(["make", f"-j{jobs}"], cwd=source, log=log)
            run(["make", "install"], cwd=source, log=log)
        stamp.write_text(json.dumps(dict(configuration=identity, libraries=library_hashes()), indent=2) + "\n")
    framework.mkdir(parents=True, exist_ok=True)
    (framework / "Headers").mkdir(exist_ok=True)
    (framework / "Modules").mkdir(exist_ok=True)
    shutil.copy2(ENGINE / "HGRemux.h", framework / "Headers")
    (framework / "Modules/module.modulemap").write_text('framework module HGRemux {\n umbrella header "HGRemux.h"\n export *\n}\n')
    exports = OUTPUT / "exports.txt"
    exports.write_text("".join("_" + name + "\n" for name in EXPORTS))
    command = ["xcrun", "--sdk", sdk, "clang", "-target", target, "-isysroot", sdk_path,
               "-std=c11", "-O2", "-fPIC", "-dynamiclib", "-Wall", "-Wextra", "-Werror",
               "-I", prefix / "include", ENGINE / "HGRemux.c",
               "-install_name", "@rpath/HGRemux.framework/HGRemux",
               "-Wl,-exported_symbols_list," + str(exports), "-Wl,-dead_strip",
               "-o", framework / "HGRemux"]
    command += ["-Wl,-force_load," + str(lib) for lib in libraries]
    command += ["-framework", "CoreFoundation", "-lm", "-lpthread"]
    run(command)
    info = dict(CFBundleExecutable="HGRemux", CFBundleIdentifier="app.hghub.HGRemux",
                CFBundleName="HGRemux", CFBundlePackageType="FMWK", CFBundleShortVersionString="1.0",
                CFBundleVersion="1", MinimumOSVersion="17.0",
                CFBundleSupportedPlatforms=["iPhoneSimulator" if simulator else "iPhoneOS"])
    (framework / "Info.plist").write_bytes(plistlib.dumps(info))
    run(["codesign", "--force", "--sign", "-", framework])
    return framework

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("ios-arm64", "ios-simulator-arm64"), action="append")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--offline", action="store_true", help="require already downloaded pinned source/signature/key")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 4: parser.error("--jobs must be 1..4")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(OUTPUT).free < 4 * 1024 ** 3: raise RuntimeError("Need at least 4 GiB free")
    ensure_sources(args.offline)
    frameworks = [build_one(platform, args.jobs) for platform in (args.platform or ["ios-arm64", "ios-simulator-arm64"])]
    temporary = OUTPUT / "HGRemux.next.xcframework"
    if temporary.exists(): shutil.rmtree(temporary)
    command = ["xcodebuild", "-create-xcframework"]
    for framework in frameworks: command += ["-framework", framework]
    run(command + ["-output", temporary])
    destination = OUTPUT / "HGRemux.xcframework"
    if destination.exists(): shutil.rmtree(destination)
    temporary.replace(destination)
    packet = OUTPUT / "source-packet"
    if packet.exists(): shutil.rmtree(packet)
    packet_engine = packet / "src-tauri/native/remux"
    packet_downloads = packet / "build/remux/downloads"
    packet_scripts = packet / "scripts"
    for path in (packet_engine, packet_downloads, packet_scripts): path.mkdir(parents=True, exist_ok=True)
    for path in (ARCHIVE, SIGNATURE, PUBLIC_KEY): shutil.copy2(path, packet_downloads)
    for path in ENGINE.glob("*"):
        if path.is_file(): shutil.copy2(path, packet_engine)
    shutil.copy2(Path(__file__), packet_scripts)
    doc = ROOT / "docs/remux-engine.md"
    if doc.is_file():
        (packet / "docs").mkdir(exist_ok=True)
        shutil.copy2(doc, packet / "docs")
    for platform in (args.platform or ["ios-arm64", "ios-simulator-arm64"]):
        configuration = json.dumps(json.loads((OUTPUT / "ffmpeg" / platform / "build-configuration.json").read_text()), ensure_ascii=False, indent=2) + "\n"
        (packet / f"{platform}-configuration.json").write_text(configuration.replace(str(ROOT), "$HG_REMUX_ROOT"))
    with tarfile.open(ARCHIVE, "r:xz") as source:
        license_text = source.extractfile(f"ffmpeg-{VERSION}/COPYING.LGPLv2.1").read()
    (packet / "COPYING.LGPLv2.1").write_bytes(license_text)
    (packet / "ffmpeg-changes.diff").write_text("# Unmodified official FFmpeg source.\n")
    manifest = {str(path.relative_to(OUTPUT)): hashlib.sha256(path.read_bytes()).hexdigest()
                for base in (destination, packet) for path in sorted(base.rglob("*")) if path.is_file()}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(destination)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
