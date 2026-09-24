#!/usr/bin/env node
/**
 * Build-time pre-render pipeline for the static score viewer.
 *
 * For each score listed in scores/manifest.json, this:
 *   1. Runs `mscore --score-media` (real MuseScore 4 desktop CLI) to get
 *      cursor position/timing data (mposXML/sposXML), a multi-track MIDI
 *      export, and score metadata - all in one JSON blob.
 *   1b. Runs `mscore -o page.svg` separately to get one SVG per page, then
 *      optimizes each with svgo (as a subprocess, so its CPU-bound work
 *      parallelizes across cores like the other steps here - svgo has no
 *      worker-thread API of its own). MuseScore renders every glyph -
 *      noteheads, beams, slurs, lyrics, dynamics - as an SVG <path>, so
 *      there's no font dependency, and at ~20-70x smaller than the
 *      equivalent PNG with no quality loss, it beats every raster format
 *      tested (PNG/WebP/AVIF) for this line-art content - see
 *      parsePositionsXml() below for why the coordinate math still lines up
 *      with these SVGs unchanged.
 *   2. Runs `mscore --score-parts` to get one isolated .mscz per instrument,
 *      then renders each straight to FLAC via `mscore -o part.flac
 *      part.mscz` and AAC-encodes that FLAC with ffmpeg - one lossy step
 *      (FLAC -> AAC), not two, since MuseScore's own MP3 export would mean
 *      transcoding lossy-to-lossy. Rendering to audio at all uses MuseScore's
 *      own playback engine directly, so dynamics, articulation and expression
 *      come through correctly - unlike an earlier approach here that exported
 *      one combined MIDI file and re-synthesized it through fluidsynth with a
 *      generic soundfont.
 *
 *      (Two things that look like they should isolate per-instrument audio
 *      do NOT: exporting --score-parts and rendering the *original* score
 *      is a no-op - the part .mscz still renders the full mix - and editing
 *      a part's own audiosettings.json mute/solo state is silently ignored
 *      by headless export. What actually works: rendering each
 *      --score-parts .mscz directly, since it structurally contains only
 *      that one instrument's Part/Staff data. Verified empirically - three
 *      parts of the same score came back with distinct checksums and
 *      distinct volume profiles matching each part's actual note content.)
 *   3. Writes everything as static files under public/scores/<id>/, plus a
 *      public/scores/index.json listing what's available. Vite's publicDir
 *      mechanism serves/copies public/ (including these) alongside the built
 *      app in both `npm run dev` and `npm run build`.
 *
 * Requires on PATH: mscore (MuseScore 4 CLI) and ffmpeg (AAC-encodes the FLAC
 * audio parts), plus `npm install` having been run (svgo, used to optimize
 * the exported SVG pages, and midi-file, used to parse the MIDI export for
 * the tempo map and per-beat map, are both dependencies).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMidi } from "midi-file";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "scores");
const OUT_DIR = path.join(ROOT, "public", "scores");
const SVGO_BIN = path.join(ROOT, "node_modules", ".bin", "svgo");

// Every subprocess call (mscore, ffmpeg, svgo) goes through the shared
// limiter below, so however many scores/parts/pages end up running at once
// logically, the actual number of live subprocesses - the thing that costs
// real CPU and memory - stays capped here. Leave one core free for the rest
// of the system.
const MAX_WORKERS = Math.max(1, (os.cpus()?.length || 2) - 1);

// ---------------------------------------------------------------------------
// Concurrency limiter + subprocess helper
// ---------------------------------------------------------------------------

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function runNext() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task().then(
      (v) => { active--; resolve(v); runNext(); },
      (e) => { active--; reject(e); runNext(); },
    );
  }
  return function limit(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
  };
}

const limitSubprocess = createLimiter(MAX_WORKERS);

function runCmd(cmd, args, { timeoutMs = 120_000 } = {}) {
  return limitSubprocess(() => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
  }));
}

// ---------------------------------------------------------------------------
// mscore invocations
// ---------------------------------------------------------------------------

async function runScoreMedia(mszPath) {
  const { stdout } = await runCmd("mscore", ["--score-media", mszPath]);
  const out = stdout.toString("utf-8");
  const start = out.indexOf("{");
  return JSON.parse(out.slice(start));
}

const SVG_TAG_RE = /<svg\b[^>]*>/;
const SVG_VIEWBOX_RE = /viewBox="0 0 ([\d.]+) ([\d.]+)"/;

function pinSvgIntrinsicSize(svgText) {
  // MuseScore's raw SVG export declares width/height in mm (e.g.
  // "215.9mm"). svgo's numeric cleanup converts that to a 96dpi pixel
  // approximation, which would silently change img.naturalWidth/Height in
  // the browser and break the pixel math below. Pin width/height to the
  // viewBox's own numbers *before* svgo runs, so they survive untouched
  // (bare numbers matching viewBox have no unit to convert).
  const tagMatch = SVG_TAG_RE.exec(svgText);
  const vbMatch = SVG_VIEWBOX_RE.exec(tagMatch[0]);
  const [, w, h] = vbMatch;
  let newTag = tagMatch[0].replace(/\swidth="[^"]*"/, ` width="${w}"`);
  newTag = newTag.replace(/\sheight="[^"]*"/, ` height="${h}"`);
  return svgText.slice(0, tagMatch.index) + newTag + svgText.slice(tagMatch.index + tagMatch[0].length);
}

async function runScoreSvg(mszPath) {
  // One svgo-optimized SVG per page, in page order. MuseScore's SVG
  // viewBox comes out numerically identical to --score-media's default
  // (1200 DPI) PNG pixel grid (e.g. "0 0 10200 13200" for a US Letter
  // page), so positions.json's existing scaling (see parsePositionsXml)
  // lines up with these SVGs with no changes needed.
  const workdir = await mkdtemp(path.join(os.tmpdir(), "prerender-svg-"));
  try {
    await runCmd("mscore", ["-o", path.join(workdir, "page.svg"), mszPath]);

    const entries = await readdir(workdir);
    const pages = entries
      .filter((f) => /^page-\d+\.svg$/.test(f))
      .map((f) => ({ name: f, n: parseInt(/-(\d+)\.svg$/.exec(f)[1], 10) }))
      .sort((a, b) => a.n - b.n)
      .map((f) => path.join(workdir, f.name));

    if (pages.length === 0) {
      throw new Error(`mscore produced no SVG pages for ${mszPath}`);
    }

    for (const page of pages) {
      const text = await readFile(page, "utf-8");
      await writeFile(page, pinSvgIntrinsicSize(text), "utf-8");
    }

    const svgoProc = await runCmd(SVGO_BIN, ["--multipass", "-f", workdir, "-o", workdir, "-q"]);
    if (svgoProc.code !== 0) {
      throw new Error(`svgo failed on ${mszPath}: ${svgoProc.stderr.toString("utf-8")}`);
    }

    const out = [];
    for (const page of pages) out.push(await readFile(page));
    return out;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function runScoreParts(mszPath) {
  const { stdout } = await runCmd("mscore", ["--score-parts", mszPath]);
  const out = stdout.toString("utf-8");
  const start = out.indexOf("{");
  const data = JSON.parse(out.slice(start));
  return data.parts.map((name, i) => [name, Buffer.from(data.partsBin[i], "base64")]);
}

async function renderPartAudio(partMszBytes, partMszPath, outM4a) {
  // Render straight to FLAC (lossless) rather than MP3, then AAC-encode
  // that - not MuseScore's own lossy MP3 output - so there's exactly one
  // lossy step in the chain instead of MP3-then-AAC transcoding artifacts
  // compounding on top of each other.
  await writeFile(partMszPath, partMszBytes);
  const flacPath = partMszPath.replace(/\.mscz$/, ".flac");
  // mscore frequently SIGABRTs on exit (crash-reporter/MuseSampler cleanup)
  // *after* successfully writing its output - verified repeatedly earlier
  // in this project. Don't treat a nonzero exit as failure; only the
  // output file's actual presence/size tells us whether it worked.
  await runCmd("mscore", ["-o", flacPath, partMszPath]);
  if (!existsSync(flacPath) || (await readFile(flacPath)).length === 0) {
    throw new Error(`mscore did not produce ${flacPath}`);
  }

  const ffmpegProc = await runCmd("ffmpeg", [
    "-y", "-i", flacPath,
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    outM4a,
  ]);
  if (!existsSync(outM4a) || (await readFile(outM4a)).length === 0) {
    throw new Error(`ffmpeg did not produce ${outM4a}: ${ffmpegProc.stderr.toString("utf-8")}`);
  }
}

async function getAudioDuration(filePath) {
  const { stdout } = await runCmd("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseFloat(stdout.toString("utf-8").trim());
}

// ---------------------------------------------------------------------------
// positions.json
// ---------------------------------------------------------------------------

function parsePositionsXml(xmlB64) {
  // MuseScore's PositionsWriter scales pagePos() by
  // `(exportPngDpiResolution / engraving::DPI) * 12.0`, which is 12.0 at the
  // default PNG export DPI (1200) - i.e. these coordinates are 12x finer
  // than the 1200 DPI PNG pixel grid. Divide by 12 here so positions.json
  // lines up 1:1 with the SVG pages' own viewBox units (runScoreSvg pins
  // each page's width/height to its viewBox, and that viewBox comes out
  // numerically identical to the 1200 DPI PNG pixel grid - e.g. both are
  // "10200x13200" for a US Letter page - so this divisor is unchanged even
  // though the frontend no longer renders a PNG at all).
  const UNITS_PER_PNG_PIXEL = 12.0;

  const xml = Buffer.from(xmlB64, "base64").toString("utf-8");
  const elements = [];
  const elRe = /<element id="(\d+)" x="([\d.]+)" y="([\d.]+)" sx="([\d.]+)" sy="([\d.]+)" page="(\d+)">/g;
  for (const m of xml.matchAll(elRe)) {
    const [, eid, x, y, sx, sy, page] = m;
    elements.push({
      id: parseInt(eid, 10),
      x: parseFloat(x) / UNITS_PER_PNG_PIXEL,
      y: parseFloat(y) / UNITS_PER_PNG_PIXEL,
      sx: parseFloat(sx) / UNITS_PER_PNG_PIXEL,
      sy: parseFloat(sy) / UNITS_PER_PNG_PIXEL,
      page: parseInt(page, 10),
    });
  }
  const events = [];
  const evRe = /<event elid="(\d+)" position="(\d+)">/g;
  for (const m of xml.matchAll(evRe)) {
    const [, elid, position] = m;
    events.push({ elid: parseInt(elid, 10), position: parseInt(position, 10) });
  }
  events.sort((a, b) => a.position - b.position);
  return { elements, events };
}

// ---------------------------------------------------------------------------
// MIDI reading (via the `midi-file` package) - replays track 0's
// set_tempo/time_signature meta events in order with accurate delta times,
// mirroring what `mido.MidiFile(...).tracks[0]` gave the Python version.
// ---------------------------------------------------------------------------

function parseTrack0Events(midiBytes) {
  const { header, tracks } = parseMidi(midiBytes);
  if (header.ticksPerFrame) {
    throw new Error("SMPTE-based MIDI division is not supported");
  }
  const events = tracks[0].map((msg) => {
    if (msg.type === "setTempo") {
      return { deltaTicks: msg.deltaTime, type: "set_tempo", tempo: msg.microsecondsPerBeat };
    }
    if (msg.type === "timeSignature") {
      return { deltaTicks: msg.deltaTime, type: "time_signature", numerator: msg.numerator, denominator: msg.denominator };
    }
    return { deltaTicks: msg.deltaTime, type: "other" };
  });
  return { ticksPerBeat: header.ticksPerBeat, events };
}

function tick2second(ticks, ticksPerBeat, tempoUsPerBeat) {
  return (ticks * tempoUsPerBeat) / (ticksPerBeat * 1_000_000);
}

function extractTempoMap(midiBytes) {
  // [{time (sec), bpm}, ...], sorted by time - the tempo actually in
  // effect at each point, for scores with tempo changes (rit., a fermata,
  // an accelerando). MuseScore only ever writes set_tempo on track 0.
  const { ticksPerBeat, events } = parseTrack0Events(midiBytes);
  const tempoMap = [];
  let curTempo = 500000; // MIDI default, 120 BPM, until the first set_tempo
  let curTime = 0.0;
  for (const msg of events) {
    curTime += tick2second(msg.deltaTicks, ticksPerBeat, curTempo);
    if (msg.type === "set_tempo") {
      curTempo = msg.tempo;
      tempoMap.push({ time: round3(curTime), bpm: Math.round(60_000_000 / curTempo) });
    }
  }
  return tempoMap;
}

function buildBeatMap(midiBytes, duration) {
  // [{time (sec), downbeat: bool}, ...] for every beat in the piece,
  // driving the mixer's metronome. MuseScore's MIDI export always places a
  // time_signature meta message exactly on a barline, so the meter is
  // constant between one and the next; tempo can still change within that
  // span (rit., accel.), so beats are generated one at a time using
  // whatever tempo is active at each beat's own start.
  const { ticksPerBeat, events } = parseTrack0Events(midiBytes);

  const tempoChanges = []; // [(time, seconds per quarter note)], sorted by time
  const timesigChanges = []; // [(time, numerator, denominator)], sorted by time
  let curTempo = 500000; // MIDI default, 120 BPM
  let curTime = 0.0;
  for (const msg of events) {
    curTime += tick2second(msg.deltaTicks, ticksPerBeat, curTempo);
    if (msg.type === "set_tempo") {
      curTempo = msg.tempo;
      tempoChanges.push([curTime, curTempo / 1_000_000]);
    } else if (msg.type === "time_signature") {
      timesigChanges.push([curTime, msg.numerator, msg.denominator]);
    }
  }
  if (tempoChanges.length === 0 || tempoChanges[0][0] > 0) tempoChanges.unshift([0.0, 0.5]);
  if (timesigChanges.length === 0 || timesigChanges[0][0] > 0) timesigChanges.unshift([0.0, 4, 4]);

  function quarterSecondsAt(t) {
    let q = tempoChanges[0][1];
    for (const [ts, qs] of tempoChanges) {
      if (ts > t) break;
      q = qs;
    }
    return q;
  }

  const beats = [];
  for (let i = 0; i < timesigChanges.length; i++) {
    const [spanStart, numerator, denominator] = timesigChanges[i];
    const spanEnd = i + 1 < timesigChanges.length ? timesigChanges[i + 1][0] : duration;
    let t = spanStart;
    let beatInMeasure = 0;
    while (t < spanEnd - 1e-6) {
      beats.push({ time: round3(t), downbeat: beatInMeasure === 0 });
      t += (quarterSecondsAt(t) * 4) / denominator;
      beatInMeasure = (beatInMeasure + 1) % numerator;
    }
  }
  return beats;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function slugify(name) {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "track";
}

async function processScore(scoreId, titleOverride) {
  const src = path.join(SRC_DIR, `${scoreId}.mscz`);
  if (!existsSync(src)) {
    console.error(`skip ${scoreId}: ${src} not found`);
    return null;
  }

  console.log(`[${scoreId}] running mscore --score-media ...`);
  const media = await runScoreMedia(src);

  const outDir = path.join(OUT_DIR, scoreId);
  const tracksDir = path.join(outDir, "tracks");
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(tracksDir, { recursive: true });

  console.log(`[${scoreId}] exporting + optimizing SVG pages ...`);
  const svgPages = await runScoreSvg(src);
  const npages = svgPages.length;
  for (let i = 0; i < svgPages.length; i++) {
    await writeFile(path.join(outDir, `page-${i}.svg`), svgPages[i]);
  }

  const positions = parsePositionsXml(media.sposXML);
  await writeFile(path.join(outDir, "positions.json"), JSON.stringify(positions));

  const midiBytes = Buffer.from(media.midi, "base64");
  await writeFile(path.join(outDir, "score.mid"), midiBytes);
  const tempoMap = extractTempoMap(midiBytes);
  await writeFile(path.join(outDir, "tempo-map.json"), JSON.stringify(tempoMap));
  const beatMap = buildBeatMap(midiBytes, media.metadata?.duration || 0);
  await writeFile(path.join(outDir, "beats.json"), JSON.stringify(beatMap));

  const parts = await runScoreParts(src);
  console.log(`[${scoreId}] running mscore --score-parts + rendering audio (${parts.length} part(s)) ...`);

  // Each part's render is just submitted here; the shared subprocess
  // limiter (see runCmd) is what actually bounds how many run at once,
  // across this score's parts *and* every other score's, so this doesn't
  // need its own concurrency cap.
  const workdir = await mkdtemp(path.join(os.tmpdir(), "prerender-parts-"));
  let tracksMeta;
  try {
    tracksMeta = await Promise.all(parts.map(async ([name, partBytes], order) => {
      const slug = slugify(name);
      const m4aPath = path.join(tracksDir, `${slug}.m4a`);
      const partMszPath = path.join(workdir, `part-${order}.mscz`);
      await renderPartAudio(partBytes, partMszPath, m4aPath);
      console.log(`    - ${name} -> ${path.basename(m4aPath)}`);
      return { id: slug, name, order, file: `tracks/${slug}.m4a` };
    }));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }

  // All parts are exports of the same score, just with different
  // instruments muted, so they must all run the same length - a mismatch
  // means one part's render silently diverged and would cause audible
  // desync in the mixer. The known cause (verified on bokura.mscz,
  // measure 20): mscore --score-parts isolates each staff into its own
  // single-staff excerpt before rendering, and a fermata's tempo-halving
  // pause only applies to excerpts that literally contain the fermata -
  // so if it's written on some voice staves at a shared rest/hold but not
  // others, the "missing fermata" staves play straight through while the
  // others pause, and the isolated renders drift apart by the pause's
  // length. Fix in the .mscx: add the same fermata (or remove it) so
  // every staff has matching fermata placement at that measure.
  const trackDurations = await Promise.all(
    tracksMeta.map((t) => getAudioDuration(path.join(outDir, t.file))),
  );
  const [firstDuration] = trackDurations;
  for (let i = 1; i < trackDurations.length; i++) {
    assert.strictEqual(
      round3(trackDurations[i]),
      round3(firstDuration),
      `[${scoreId}] track duration mismatch: "${tracksMeta[0].name}" is ${firstDuration}s but "${tracksMeta[i].name}" is ${trackDurations[i]}s. ` +
        `Likely cause: a fermata (or other tempo-affecting mark) is written on some voice staves but not others at the same measure - ` +
        `mscore --score-parts renders each staff in isolation, so only the staves with the fermata get its pause, and the parts drift apart. ` +
        `Check the .mscx for a Fermata present on some staves but missing on others at the same measure.`,
    );
  }

  const meta = media.metadata || {};
  const scoreMeta = {
    id: scoreId,
    title: titleOverride || meta.title || scoreId,
    composer: meta.composer || "",
    tempoText: meta.tempoText || "",
    // metadata.tempo is already plain BPM (verified: e.g. nodkrai's own
    // printed tempo marking is "= 103" and this reports 103, not 103*60).
    // It's the score's marked/nominal tempo - scores with tempo changes
    // mid-piece (a rit., a fermata) only get this one representative value.
    bpm: Math.round(meta.tempo || 0),
    duration: meta.duration || 0,
    npages,
    tracks: tracksMeta,
  };
  await writeFile(path.join(outDir, "meta.json"), JSON.stringify(scoreMeta, null, 2));
  console.log(`[${scoreId}] done: ${npages} page(s), ${tracksMeta.length} track(s)`);
  return scoreMeta;
}

async function main() {
  const manifestPath = path.join(SRC_DIR, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

  // Scores are all kicked off up front; Promise.all preserves manifest
  // order in `results` regardless of completion order, so index.json comes
  // out the same as it would running one score at a time. The shared
  // subprocess limiter (see runCmd) keeps actual concurrency near the CPU
  // count no matter how many scores are in flight at once.
  const results = await Promise.all(
    manifest.scores.map((entry) => processScore(entry.id, entry.title)),
  );

  const index = results
    .filter((result) => result !== null)
    .map((result) => ({ id: result.id, title: result.title, composer: result.composer }));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log(`\nwrote ${path.join(OUT_DIR, "index.json")} with ${index.length} score(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
