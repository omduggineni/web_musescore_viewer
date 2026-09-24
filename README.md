# web_musescore_viewer

A statically-hostable score viewer/player for a pre-specified set of scores.
Everything is pre-rendered at build time by real MuseScore 4 (no WebAssembly,
no MuseScore code running in the browser at all) - the site itself is a
React + TypeScript app, built with Vite, reading static files.

Per score, the viewer shows the engraved page(s) as images with a cursor
that tracks the beat as it plays, a mixer with independent volume, pan,
mute and solo per instrument, and a toggleable metronome that follows the
score's actual meter and tempo changes.

> This project originally set out to compile MuseScore 4 itself to
> WebAssembly for in-browser editing. That path was abandoned: MuseScore's
> own wasm build has been broken in their CI since ~January 2026 (verified
> across multiple commits), and even a from-scratch AOT x86-to-wasm binary
> translation approach (in the style of CheerpX/WebVM) was assessed and
> ruled out as disproportionate. This is a different, narrower tool: a
> viewer/player, pre-rendered, not an in-browser editor.

## Layout

```
src/     website source (React/TypeScript components, hooks, style.css) - checked in
public/  score assets written by tools/prerender.mjs - NOT checked in (see below)
scores/  original .mscz files + manifest.json - NOT checked in (see below)
dist/    build output: bundled src/ + copied public/ - NOT checked in
tools/   prerender.mjs, the build pipeline
```

`scores/` and `public/` are gitignored except for a `.gitignore` each, so a
fresh clone has empty (but present) folders. `scores/` isn't checked in
because the original score files may be large and/or not something you
have the right to redistribute; `public/` isn't checked in for the same
reason (it's `prerender.mjs`'s output, derived from `scores/`); `dist/` isn't
checked in because it's entirely derived from `src/` + `public/` via the
Vite build.

## Building

```sh
npm run build
```

This runs `tools/prerender.mjs`, the only thing that knows about MuseScore.
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
3. Builds a tempo map (time -> BPM) from the MIDI export via `midi-file`,
   so the player can show the tempo actually in effect at the playhead
   through a rit./accelerando/fermata, not just the score's initial
   marking.
4. Writes everything else as static files under `public/scores/<id>/`:
   page images, `positions.json` (cursor sync data), `meta.json`,
   `tempo-map.json`, `beats.json`, and one MP3 per instrument under
   `tracks/`. Vite's `publicDir` mechanism then copies `public/` into
   `dist/` alongside the compiled app on `vite build` (and serves it
   directly, unbundled, during `npm run dev`).

`dist/` is the deployable site - upload it as-is to any static host
(GitHub Pages, S3, Cloudflare Pages, ...). No server, no special headers.

Requires on `PATH`: `mscore` (MuseScore 4), `ffmpeg`, and Node (`npm install`
must have been run - `svgo`, used to optimize the exported SVG pages, and
`midi-file`, used to parse the MIDI export, are both devDependencies).

### Cursor sync coordinate system

MuseScore's position export (`positionswriter.cpp`) scales coordinates by
`(exportPngDpiResolution / engraving::DPI) * 12.0`, which is exactly `12.0`
at the default export DPI (1200) that `--score-media`'s bundled PNGs also
use. `prerender.mjs` divides the raw coordinates by 12 so `positions.json`
is directly in PNG-pixel units - the viewer just scales by
`displayedWidth / naturalWidth` at render time.

### Mixer semantics

A track is audible if: no track is soloed and it isn't muted, OR it is
itself soloed (standard mixer behavior). Mute and solo are mutually
exclusive per track - selecting one clears the other on that same track.

## Adding scores

Drop a `.mscz` file in `scores/`, add its id (and optional title override)
to `scores/manifest.json`:

```json
{ "scores": [{ "id": "my-score" }, { "id": "other", "title": "Custom Title" }] }
```

then re-run `npm run build`.

## Serving locally

For day-to-day frontend work, once `public/scores/` has been populated at
least once by `node tools/prerender.mjs`:

```sh
npm run dev
```

This starts Vite with HMR at `http://localhost:5173/?score=<id>`.

To check the real production build instead:

```sh
npm run build
npm run serve
```

Then open `http://localhost:8000/index.html?score=<id>`.

## Keyboard shortcuts

Space play/pause · Page Up/Down (or Fn+Up/Down on a Mac) scroll by one
screenful · M toggles the metronome. Ignored while a form control (a
slider) has focus, so its own native keyboard handling still works.

## Icons

Toolbar icons (metronome, page-layout toggle, zoom in/out, fullscreen,
mixer toggle) are React components in `src/components/icons.tsx` rendering
inline SVG - copied from [Lucide](https://lucide.dev) (ISC license). No
icon font or library is fetched at runtime.

## License

MuseScore Studio is GPL-3.0-only. This repo's own files (`tools/`, `src/`)
are released under the same license. The inlined Lucide icons (see above)
remain under their own ISC license.
