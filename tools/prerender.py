#!/usr/bin/env python3
"""
Build-time pre-render pipeline for the static score viewer.

For each score listed in scores-src/manifest.json, this:
  1. Runs `mscore --score-media` (real MuseScore 4 desktop CLI) to get
     per-page PNGs, cursor position/timing data (mposXML/sposXML), a
     multi-track MIDI export, and score metadata - all in one JSON blob.
  2. Splits the MIDI by instrument track and renders each one separately
     through fluidsynth + a GM soundfont, producing isolated per-instrument
     audio stems (mscore's own --score-parts / mixer solo state do NOT
     isolate audio in headless export - verified empirically; this MIDI
     split is the approach that actually works).
  3. Writes everything as static files under public/scores/<id>/, plus a
     public/scores/index.json listing what's available.

Requires on PATH: mscore (MuseScore 4 CLI), fluidsynth, ffmpeg.
Requires the `mido` Python package.
"""
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "scores-src"
OUT_DIR = ROOT / "public" / "scores"
SOUNDFONT = ROOT / "tools" / "soundfont" / "MS Basic.sf3"


def run_score_media(mscz_path: Path) -> dict:
    proc = subprocess.run(
        ["mscore", "--score-media", str(mscz_path)],
        capture_output=True, timeout=120,
    )
    out = proc.stdout.decode("utf-8", errors="replace")
    start = out.index("{")
    return json.loads(out[start:])


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


def split_midi_by_instrument(midi_bytes: bytes, workdir: Path) -> list[dict]:
    """Group MIDI tracks by track_name (an instrument can span >1 track,
    e.g. a divisi or grand-staff part) and render each group in isolation.
    Returns [{name, order, midi_path}]."""
    midi_path = workdir / "full.mid"
    midi_path.write_bytes(midi_bytes)
    mid = mido.MidiFile(str(midi_path))

    tempo_msgs = [m for m in mid.tracks[0] if m.type == "set_tempo"]

    groups: dict[str, list] = {}
    order: list[str] = []
    for track in mid.tracks:
        names = [m.name for m in track if m.type == "track_name"]
        has_notes = any(m.type == "note_on" and m.velocity > 0 for m in track)
        if not names or not has_notes:
            continue
        name = names[0]
        if name not in groups:
            groups[name] = []
            order.append(name)
        groups[name].append(track)

    results = []
    for i, name in enumerate(order):
        new_mid = mido.MidiFile(ticks_per_beat=mid.ticks_per_beat)
        for track in groups[name]:
            has_own_tempo = any(m.type == "set_tempo" for m in track)
            new_track = mido.MidiTrack()
            if not has_own_tempo:
                for t in tempo_msgs:
                    new_track.append(t.copy(time=0))
            for msg in track:
                new_track.append(msg)
            new_mid.tracks.append(new_track)

        out_path = workdir / f"track-{i}.mid"
        new_mid.save(str(out_path))
        results.append({"name": name, "order": i, "midi_path": out_path})

    return results


def render_stem(midi_path: Path, out_mp3: Path):
    with tempfile.TemporaryDirectory() as td:
        wav_path = Path(td) / "out.wav"
        subprocess.run(
            ["fluidsynth", "-ni", "-F", str(wav_path), "-r", "44100",
             str(SOUNDFONT), str(midi_path)],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
             "-codec:a", "libmp3lame", "-qscale:a", "4", str(out_mp3)],
            check=True, capture_output=True,
        )


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

    print(f"[{score_id}] splitting + rendering instrument stems ...")
    with tempfile.TemporaryDirectory() as td:
        workdir = Path(td)
        stems = split_midi_by_instrument(midi_bytes, workdir)
        tracks_meta = []
        for stem in stems:
            slug = slugify(stem["name"])
            mp3_path = tracks_dir / f"{slug}.mp3"
            render_stem(stem["midi_path"], mp3_path)
            tracks_meta.append({
                "id": slug, "name": stem["name"], "order": stem["order"],
                "file": f"tracks/{slug}.mp3",
            })
            print(f"    - {stem['name']} -> {mp3_path.name}")

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

    if not SOUNDFONT.exists():
        print(f"error: soundfont not found at {SOUNDFONT}", file=sys.stderr)
        sys.exit(1)

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
