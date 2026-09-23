# web_musescore_viewer

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

## Layout

```
src/     website source (index.html, style.css, app.js) - checked in
scores/  original .mscz files + manifest.json - NOT checked in (see below)
dist/    build output: src/ + rendered scores - NOT checked in
tools/   prerender.py, the build pipeline
```

`scores/` and `dist/` are gitignored except for a `.gitkeep` each, so a
fresh clone has empty (but present) folders. `scores/` isn't checked in
because the original score files may be large and/or not something you
have the right to redistribute; `dist/` isn't checked in because it's
entirely derived from `src/` + `scores/` via the build.

## Building

```sh
npm run build
```

This runs `tools/prerender.py`, the only thing that knows about MuseScore.
For each score listed in `scores/manifest.json`, it:

1. Runs the real MuseScore 4 desktop CLI (`mscore --score-media`) to get
   per-page PNGs, cursor position/timing data (mposXML/sposXML), a
   multi-track MIDI export, and score metadata - all in one call.
2. Runs `mscore --score-parts` to get one isolated `.mscz` per instrument,
   then renders each straight to MP3 via `mscore -o part.mp3 part.mscz`.
   This uses MuseScore's own playback engine directly, so dynamics,
   articulation and expression come through correctly.

   (Two things that look like they should isolate per-instrument audio do
   NOT: exporting `--score-parts` and rendering the *original* score is a
   no-op - the part `.mscz` still renders the full mix - and editing a
   part's own `audiosettings.json` mute/solo state is silently ignored by
   headless export. What actually works: rendering each `--score-parts`
   `.mscz` directly, since it structurally contains only that one
   instrument's Part/Staff data. Verified empirically - parts of the same
   score come back with distinct checksums and volume profiles matching
   each part's actual note content.)
3. Builds a tempo map (time -> BPM) from the MIDI export via `mido`, so
   the player can show the tempo actually in effect at the playhead
   through a rit./accelerando/fermata, not just the score's initial
   marking.
4. Copies `src/` and writes everything else as static files under
   `dist/scores/<id>/`: page images, `positions.json` (cursor sync data),
   `meta.json`, `tempo-map.json`, `score.mid`, and one MP3 per instrument
   under `tracks/`.

`dist/` is the deployable site - upload it as-is to any static host
(GitHub Pages, S3, Cloudflare Pages, ...). No server, no special headers.

Requires on `PATH`: `mscore` (MuseScore 4) and the Python `mido` package.

### Cursor sync coordinate system

MuseScore's position export (`positionswriter.cpp`) scales coordinates by
`(exportPngDpiResolution / engraving::DPI) * 12.0`, which is exactly `12.0`
at the default export DPI (1200) that `--score-media`'s bundled PNGs also
use. `prerender.py` divides the raw coordinates by 12 so `positions.json`
is directly in PNG-pixel units - the viewer just scales by
`displayedWidth / naturalWidth` at render time.

### Mixer semantics

A track is audible if: no track is soloed and it isn't muted, OR it is
itself soloed (standard mixer behavior). Mute and solo are mutually
exclusive per track - selecting one clears the other on that same track.

### Firefox

Firefox has long-standing bugs (Bugzilla 966247/1517199/1251640/1648277)
where a rate-changed, pitch-preserved `<audio>` element routed through Web
Audio glitches/pops, worse with more simultaneous tracks - Chrome and
Safari don't share this bug. Rather than give up per-track Web Audio
mixing (panning, clean gain nodes) on Firefox, the speed control is
disabled there instead, with a tooltip linking to the bug.

## Adding scores

Drop a `.mscz` file in `scores/`, add its id (and optional title override)
to `scores/manifest.json`:

```json
{ "scores": [{ "id": "my-score" }, { "id": "other", "title": "Custom Title" }] }
```

then re-run `npm run build`.

## Serving locally

```sh
npm run build
npm run serve
```

Then open `http://localhost:8000/index.html?score=<id>`.

## License

MuseScore Studio is GPL-3.0-only. This repo's own files (`tools/`, `src/`)
are released under the same license.
