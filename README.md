# webscoreviewer

A statically-hostable score viewer/player for a pre-specified set of scores.
Everything is pre-rendered at build time by real MuseScore 4 (no WebAssembly,
no MuseScore code running in the browser at all) - the site itself is plain
HTML/CSS/JS reading static files.

Per score, the viewer shows the engraved page(s) as images with a cursor
that tracks the beat as it plays, and a mixer with independent volume, pan,
mute and solo per instrument.

> This project originally set out to compile MuseScore 4 itself to
> WebAssembly for in-browser editing. That path was abandoned: MuseScore's
> own wasm build has been broken in their CI since ~January 2026 (verified
> across multiple commits), and even a from-scratch AOT x86-to-wasm binary
> translation approach (in the style of CheerpX/WebVM) was assessed and
> ruled out as disproportionate. This is a different, narrower tool: a
> viewer/player, pre-rendered, not an in-browser editor.

## How it works

`tools/prerender.py` is the only thing that knows about MuseScore. For each
score listed in `scores-src/manifest.json`:

1. Runs the real MuseScore 4 desktop CLI (`mscore --score-media`) to get
   per-page PNGs, cursor position/timing data, a metadata JSON, and a
   multi-track MIDI export - all in one call.
2. Splits the MIDI by instrument track (grouping tracks that share an
   instrument name, e.g. divisi/grand-staff parts) and renders each one
   separately through `fluidsynth` + a GM soundfont, producing isolated
   per-instrument audio stems. (MuseScore's own `--score-parts` and its
   mixer mute/solo state do **not** isolate audio in headless CLI export -
   this was verified empirically; splitting the MIDI is the approach that
   actually produces distinct per-instrument audio.)
3. Writes static output under `public/scores/<id>/`: page images,
   `positions.json` (cursor sync data), `meta.json`, `score.mid`, and one
   MP3 per instrument under `tracks/`.

`public/` is the deployable site - upload it as-is to any static host
(GitHub Pages, S3, Cloudflare Pages, ...). No server, no special headers.

### Cursor sync coordinate system

MuseScore's position export (`positionswriter.cpp`) scales coordinates by
`(exportPngDpiResolution / engraving::DPI) * 12.0`, which is exactly `12.0`
at the default export DPI (1200) that `--score-media`'s bundled PNGs also
use. `prerender.py` divides the raw coordinates by 12 so `positions.json`
is directly in PNG-pixel units - the viewer just scales by
`displayedWidth / naturalWidth` at render time.

### Mixer semantics

A track is audible if: no track is soloed and it isn't muted, OR it is
itself soloed. (Muting a track has no effect once any other track is
soloed - standard mixer behavior.)

## Adding scores

Drop a `.mscz` file in `scores-src/`, add its id to
`scores-src/manifest.json`, then re-run:

```sh
python3 tools/prerender.py
```

Requires on `PATH`: `mscore` (MuseScore 4), `fluidsynth`, `ffmpeg`, and the
Python `mido` package. Also requires a GM soundfont at
`tools/soundfont/MS Basic.sf3` (not committed - copy it from your MuseScore
4 install, e.g. `/Applications/MuseScore 4.app/Contents/Resources/sound/MS Basic.sf3`
on macOS, or download a GM soundfont such as FluidR3Mono_GM.sf3).

The two scores currently included (`reunion`, `text`) are demo/test assets
bundled with MuseScore's own open-source repository - swap them for
whatever scores you actually want to serve.

## Serving locally

```sh
cd public && python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html?score=<id>`.

## License

MuseScore Studio (and its bundled demo/test scores and soundfont) is
GPL-3.0-only. This repo's own files (`tools/`, `public/`) are released
under the same license.
