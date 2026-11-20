#!/usr/bin/env python3
"""Create the static Tauri updater manifest from signed build artifacts."""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

def collect_signed_assets(root: Path):
    pairs = {}
    for sig_path in root.rglob("*.sig"):
        asset = sig_path.with_suffix("")
        if asset.is_file():
            if asset.name in pairs:
                raise ValueError(f"duplicate signed asset name: {asset.name}")
            signature = sig_path.read_text(encoding="utf-8").strip()
            if not signature:
                raise ValueError(f"empty signature: {sig_path}")
            pairs[asset.name] = (asset, signature, str(asset.relative_to(root)).lower())
    return pairs


def choose(pairs, token, suffixes):
    candidates = [(name, val) for name, val in pairs.items()
                  if token in (name.lower() + " " + val[2]) and any(name.lower().endswith(s) for s in suffixes)]
    if len(candidates) != 1:
        raise ValueError(f"expected one signed {token} updater archive, found: {[n for n, _ in candidates]}")
    return candidates[0]


def asset_url(repo, tag, filename):
    return f"https://github.com/{repo}/releases/download/{quote(tag, safe='')}/{quote(filename, safe='')}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--repo", required=True, help="owner/repository")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--pub-date", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        parser.error("--repo must be owner/repository")
    if args.tag != f"openixsuit-ce-v{args.version}":
        parser.error("tag must match openixsuit-ce-v<version>")

    pairs = collect_signed_assets(args.artifacts)
    formats = (
        ("linux-x86_64", "linux-x64", (".appimage",)),
        ("darwin-aarch64", "macos-arm64", (".app.tar.gz",)),
        ("windows-x86_64-msi", "windows-x64", (".msi",)),
        ("windows-x86_64-nsis", "windows-x64", ("-setup.exe", "_setup.exe")),
    )
    platforms = {}
    for target, artifact, suffixes in formats:
        name, (_, signature, _) = choose(pairs, artifact, suffixes)
        platforms[target] = {"signature": signature, "url": asset_url(args.repo, args.tag, name)}
    platforms["windows-x86_64"] = platforms["windows-x86_64-msi"]

    manifest = {
        "version": args.version,
        "notes": "",
        "pub_date": args.pub_date,
        "platforms": platforms,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        print(f"manifest generation failed: {exc}", file=sys.stderr)
        sys.exit(1)
