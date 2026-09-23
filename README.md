# webscoreviewer

A statically-hostable MuseScore 4 editor, compiled to WebAssembly, that opens a
`.mscz` score passed as a `?url=` query parameter.

## How this is built

`MuseScore/` is a git submodule pinned to a commit of the unmodified
[musescore/MuseScore](https://github.com/musescore/MuseScore) source tree,
which already includes MuseScore Limited's own in-tree WebAssembly build
(`src/web/appjs`, `src/web/appshell`, `src/web/audioengine`) using
Qt 6.9.2 (`wasm_singlethread`) + Emscripten 3.1.70. No source is duplicated
here — only a submodule reference (a commit pointer) is checked in.

**Why not the latest commit:** current `master` has had a broken wasm build
since ~January 2026 (three maintainer-triggered `Build: Wasm` CI runs failed
in a row; every run since is a failure except on fix branches). This repo is
instead pinned to [`1f4dff8`](https://github.com/musescore/MuseScore/commit/1f4dff8aedb9ad6794d2ff6eb76090e2f9e757d2),
the most recent commit whose own `Build: Wasm` workflow actually passed in
MuseScore's CI. That means this editor is ~8 months behind head — a real,
known tradeoff, not a silent substitution. Re-pointing the submodule at a
newer commit is worth retrying once upstream's wasm build is green again.

The only local change is `overlay/viewer.html`, which replaces
`MuseScore/src/web/appjs/viewer/viewer.html` at build time (see
`.github/workflows/build.yml`). It adds:

- auto-loading a score from `?url=<link-to-a-.mscz-file>` on page load
  (the host serving that file must send permissive CORS headers, since
  there is no server-side proxy in a static deployment)
- a manual "Open file…" fallback
- a "Download .mscz" button wired to the app's existing save callback

Everything else — editing, notation rendering, playback (FluidSynth +
the bundled `MS Basic.sf3` soundfont), and saving — is the unmodified
MuseScore 4 desktop editor running in the browser.

## Building

Trigger the `Build wasm viewer` GitHub Actions workflow
(`workflow_dispatch`). It produces a `wasm-site` artifact containing the
static site (`index.html`, `MuseScoreStudio.wasm`, `MuseAudio.js`,
`sound/MS Basic.sf3`, etc.) — upload that directory as-is to any static
host (GitHub Pages, S3, Cloudflare Pages, ...). Because the build uses
`wasm_singlethread`, no special COOP/COEP headers are required.

## License

MuseScore Studio is GPL-3.0-only. This repo's own files (the workflow and
`overlay/viewer.html`) are released under the same license. If you deploy
a built copy publicly, keep a link back to this repository's source to
satisfy the GPL's source-availability requirement.
