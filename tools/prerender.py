#!/usr/bin/env python3
"""
Build-time pre-render pipeline for the static score viewer.

For each score listed in scores-src/manifest.json, this:
  1. Runs `mscore --score-media` (real MuseScore 4 desktop CLI) to get
     per-page PNGs, cursor position/timing data (mposXML/sposXML), a
     multi-track MIDI export, and score metadata - all in one JSON blob.
  2. Runs `mscore --score-parts` to get one isolated .mscz per instrument,
     then renders each straight to MP3 via `mscore -o part.mp3 part.mscz`.
     This uses MuseScore's own playback engine directly, so dynamics,
     articulation and expression come through correctly - unlike an
     earlier approach here that exported one combined MIDI file and
     re-synthesized it through fluidsynth with a generic soundfont.

     (Two things that look like they should isolate per-instrument audio
     do NOT: exporting --score-parts and rendering the *original* score
     is a no-op - the part .mscz still renders the full mix - and editing
     a part's own audiosettings.json mute/solo state is silently ignored
     by headless export. What actually works: rendering each
     --score-parts .mscz directly, since it structurally contains only
     that one instrument's Part/Staff data. Verified empirically - three
     parts of the same score came back with distinct checksums and
     distinct volume profiles matching each part's actual note content.)
  3. Writes everything as static files under public/scores/<id>/, plus a
     public/scores/index.json listing what's available.

Requires on PATH: mscore (MuseScore 4 CLI). No other dependencies.
"""
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "scores-src"
OUT_DIR = ROOT / "public" / "scores"


def run_score_media(mscz_path: Path) -> dict:
    proc = subprocess.run(
        ["mscore", "--score-media", str(mscz_path)],
        capture_output=True, timeout=120,
    )
    out = proc.stdout.decode("utf-8", errors="replace")
    start = out.index("{")
    return json.loads(out[start:])


def run_score_parts(mscz_path: Path) -> list[tuple[str, bytes]]:
    proc = subprocess.run(
        ["mscore", "--score-parts", str(mscz_path)],
        capture_output=True, timeout=120,
    )
    out = proc.stdout.decode("utf-8", errors="replace")
    start = out.index("{")
    data = json.loads(out[start:])
    return [
        (name, base64.b64decode(b64))
        for name, b64 in zip(data["parts"], data["partsBin"])
    ]


def render_part_audio(part_mscz_bytes: bytes, out_mp3: Path, workdir: Path):
    part_mscz_path = workdir / "part.mscz"
    part_mscz_path.write_bytes(part_mscz_bytes)
    # mscore frequently SIGABRTs on exit (crash-reporter/MuseSampler cleanup)
    # *after* successfully writing its output - verified repeatedly earlier
    # in this project. Don't treat a nonzero exit as failure; only the
    # output file's actual presence/size tells us whether it worked.
    subprocess.run(
        ["mscore", "-o", str(out_mp3), str(part_mscz_path)],
        capture_output=True, timeout=120,
    )
    if not out_mp3.exists() or out_mp3.stat().st_size == 0:
        raise RuntimeError(f"mscore did not produce {out_mp3}")


def parse_positions_xml(xml_b64: str) -> dict:
    # MuseScore's PositionsWriter scales pagePos() by
    # `(exportPngDpiResolution / engraving::DPI) * 12.0`, which is 12.0 at the
    # default PNG export DPI (1200) - i.e. these coordinates are 12x finer
    # than the 1200 DPI PNG pixel grid that --score-media's bundled pngs use.
    # Divide by 12 here so positions.json is directly in PNG-pixel units.
    UNITS_PER_PNG_PIXEL = 12.0

    xml = base64.b64decode(xml_b64).decode("utf-8")
    elements = []
    for m in re.finditer(
        r'<element id="(\d+)" x="([\d.]+)" y="([\d.]+)" sx="([\d.]+)" sy="([\d.]+)" page="(\d+)">',
        xml,
    ):
        eid, x, y, sx, sy, page = m.groups()
        elements.append({
            "id": int(eid),
            "x": float(x) / UNITS_PER_PNG_PIXEL,
            "y": float(y) / UNITS_PER_PNG_PIXEL,
            "sx": float(sx) / UNITS_PER_PNG_PIXEL,
            "sy": float(sy) / UNITS_PER_PNG_PIXEL,
            "page": int(page),
        })
    events = []
    for m in re.finditer(r'<event elid="(\d+)" position="(\d+)">', xml):
        elid, pos = m.groups()
        events.append({"elid": int(elid), "position": int(pos)})
    events.sort(key=lambda e: e["position"])
    return {"elements": elements, "events": events}


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "track"


def process_score(score_id: str, title_override: str | None = None):
    src = SRC_DIR / f"{score_id}.mscz"
    if not src.exists():
        print(f"skip {score_id}: {src} not found", file=sys.stderr)
        return None

    print(f"[{score_id}] running mscore --score-media ...")
    media = run_score_media(src)

    out_dir = OUT_DIR / score_id
    tracks_dir = out_dir / "tracks"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    tracks_dir.mkdir(parents=True)

    npages = len(media["pngs"])
    for i, png_b64 in enumerate(media["pngs"]):
        (out_dir / f"page-{i}.png").write_bytes(base64.b64decode(png_b64))

    positions = parse_positions_xml(media["sposXML"])
    (out_dir / "positions.json").write_text(json.dumps(positions))

    midi_bytes = base64.b64decode(media["midi"])
    (out_dir / "score.mid").write_bytes(midi_bytes)

    print(f"[{score_id}] running mscore --score-parts + rendering audio ...")
    parts = run_score_parts(src)
    tracks_meta = []
    with tempfile.TemporaryDirectory() as td:
        workdir = Path(td)
        for order, (name, part_bytes) in enumerate(parts):
            slug = slugify(name)
            mp3_path = tracks_dir / f"{slug}.mp3"
            render_part_audio(part_bytes, mp3_path, workdir)
            tracks_meta.append({
                "id": slug, "name": name, "order": order,
                "file": f"tracks/{slug}.mp3",
            })
            print(f"    - {name} -> {mp3_path.name}")

    meta = media["metadata"]
    score_meta = {
        "id": score_id,
        "title": title_override or meta.get("title") or score_id,
        "composer": meta.get("composer", ""),
        "tempoText": meta.get("tempoText", ""),
        "duration": meta.get("duration", 0),
        "npages": npages,
        "tracks": tracks_meta,
    }
    (out_dir / "meta.json").write_text(json.dumps(score_meta, indent=2))
    print(f"[{score_id}] done: {npages} page(s), {len(tracks_meta)} track(s)")
    return score_meta


def main():
    manifest_path = SRC_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text())

    index = []
    for entry in manifest["scores"]:
        result = process_score(entry["id"], entry.get("title"))
        if result:
            index.append({
                "id": result["id"], "title": result["title"],
                "composer": result["composer"],
            })

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=2))
    print(f"\nwrote {OUT_DIR / 'index.json'} with {len(index)} score(s)")


if __name__ == "__main__":
    main()
