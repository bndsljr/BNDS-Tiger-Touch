#!/usr/bin/env python3
"""
Fetch the complete Avolites Titan Web API documentation into a local,
greppable corpus.

The docfx-generated site publishes a search index at /index.json whose
`keywords` field contains the FULL text of every API page (description,
namespace, C#/MACRO syntax, HTTP URL pattern, and every parameter). That is
far friendlier to bulk analysis than requesting each of the ~3700 pages.

Usage:
    python3 tools/fetch_titan_api_docs.py [--version 16.0] [--out .cache/api-docs]

Outputs (under --out):
    index.json    raw docfx search index
    ALL.txt       flat corpus, blocks separated by "@@@ <page path>"
    pages.txt     one page path per line
    summary.md    statistics used by the research notes
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

BASE = "https://api.avolites.com/{version}/"


def fetch(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "bnds-titan-tools/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def build(version: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    base = BASE.format(version=version)

    raw = out / "index.json"
    if not raw.exists():
        print(f"downloading {base}index.json ...", file=sys.stderr)
        raw.write_bytes(fetch(base + "index.json"))
    index = json.loads(raw.read_text(encoding="utf-8-sig"))

    blocks: list[tuple[str, str]] = []
    for href, entry in index.items():
        if href == "index.html":
            continue
        text = re.sub(r"\s+", " ", entry.get("keywords") or "").strip()
        blocks.append((href, text))
    blocks.sort()

    with (out / "ALL.txt").open("w", encoding="utf-8") as fh:
        for href, text in blocks:
            fh.write(f"\n@@@ {href}\n{text}\n")
    (out / "pages.txt").write_text(
        "\n".join(href for href, _ in blocks) + "\n", encoding="utf-8"
    )

    # Statistics that the research notes depend on.
    script_v2 = sum(1 for _, t in blocks if "/titan/script/2/" in t)
    script_v1 = sum(1 for _, t in blocks if "/titan/script/" in t and "/titan/script/2/" not in t)
    get_v2 = sum(1 for _, t in blocks if "/titan/get/2/" in t)
    no_http = [h for h, t in blocks if "/titan/" not in t]

    providers: dict[str, int] = {}
    for href, _ in blocks:
        name = Path(href).name.replace(".html", "").split(".")[0]
        providers[name] = providers.get(name, 0) + 1

    lines = [
        f"# Titan API {version} — corpus summary",
        "",
        f"- API pages: **{len(blocks)}**",
        f"- pages calling `/titan/script/2/`: **{script_v2}**",
        f"- pages calling `/titan/script/` without the `2`: **{script_v1}**",
        f"- pages calling `/titan/get/2/`: **{get_v2}**",
        f"- pages with no HTTP example at all: **{len(no_http)}**",
        "",
        "Pages without an HTTP example are type/enum definitions, not callable",
        "methods — i.e. the whole API surface is reachable over HTTP.",
        "",
        "## Pages per top-level provider",
        "",
        "| provider | pages |",
        "| --- | --- |",
    ]
    for name, count in sorted(providers.items(), key=lambda kv: -kv[1]):
        lines.append(f"| `{name}` | {count} |")
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"wrote {len(blocks)} pages to {out/'ALL.txt'}")
    print(f"wrote {out/'summary.md'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", default="16.0")
    ap.add_argument("--out", default=".cache/api-docs")
    args = ap.parse_args()
    build(args.version, Path(args.out))


if __name__ == "__main__":
    main()
