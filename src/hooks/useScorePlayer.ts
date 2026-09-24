import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type {
  BeatMapEntry,
  Positions,
  PositionElement,
  ScoreMeta,
  TempoMapEntry,
  TrackState,
} from '../types';
import type { SeekBarHandle } from '../components/SeekBar';
import type { TimeLabelHandle } from '../components/TimeLabel';
import type { PagesViewHandle } from '../components/PagesView';
import type { TempoControlHandle } from '../components/TempoControl';
import { ZOOM_MIN, ZOOM_MAX } from '../constants';

export interface TrackUiState {
  id: string;
  name: string;
  initialVolume: number;
  muted: boolean;
  solo: boolean;
}

interface UseScorePlayerArgs {
  scoreId: string | null;
  mainRef: RefObject<HTMLElement>;
}

// Chrome/Firefox/Safari all support this under some spelling; setting all
// three is harmless where a given one doesn't exist.
function setPreservesPitch(el: HTMLMediaElement, value: boolean) {
  el.preservesPitch = value;
  el.mozPreservesPitch = value;
  el.webkitPreservesPitch = value;
}

// The single hook holding the AudioContext/masterGain/metronomeGain graph,
// the per-track audio nodes, tempoMap/beatMap, the rAF tick loop, seek/
// play/pause/metronome-schedule logic, and currentBaseBpm()/tempo-label
// math - a relocation of src/app.js's playback engine into a hook, not a
// redesign. Exposes the refs three (well, four - see TempoControlHandle)
// components need for the rAF hot path, plus the state components should
// re-render on, plus action functions.
export function useScorePlayer({ scoreId, mainRef }: UseScorePlayerArgs) {
  const seekBarRef = useRef<SeekBarHandle>(null);
  const timeLabelRef = useRef<TimeLabelHandle>(null);
  const pagesViewRef = useRef<PagesViewHandle>(null);
  const tempoControlRef = useRef<TempoControlHandle>(null);

  const [scoreMeta, setScoreMeta] = useState<ScoreMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlayingState] = useState(false);
  const [duration, setDurationState] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const [metronomeOn, setMetronomeOnState] = useState(false);
  const [trackList, setTrackList] = useState<TrackUiState[]>([]);
  const [zoomLevel, setZoomLevelState] = useState(1);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const metronomeGainRef = useRef<GainNode | null>(null);

  const currentScoreRef = useRef<ScoreMeta | null>(null);
  const positionsRef = useRef<Positions | null>(null);
  const elementsByIdRef = useRef<Map<number, PositionElement>>(new Map());
  const eventPositionByElIdRef = useRef<Map<number, number>>(new Map());
  const tempoMapRef = useRef<TempoMapEntry[]>([]);
  const beatMapRef = useRef<BeatMapEntry[]>([]);
  const nextBeatIndexRef = useRef(0);
  const metronomeOnRef = useRef(false);

  const tracksRef = useRef<Map<string, TrackState>>(new Map());
  const stallingTracksRef = useRef<Set<string>>(new Set());
  const pendingStartRef = useRef<Set<string>>(new Set());
  const pendingStartTimersRef = useRef<Map<string, number>>(new Map());

  const playingRef = useRef(false);
  const startOffsetRef = useRef(0);
  const durationRef = useRef(0);
  const speedRef = useRef(1);
  const rafHandleRef = useRef<number | null>(null);
  const seekDraggingRef = useRef(false);
  const lastCursorKeyRef = useRef<string | null>(null);
  const zoomScrollFracRef = useRef<{ fracY: number; fracX: number } | null>(null);

  // ---------- helpers ----------

  function getClockElement(): HTMLAudioElement | null {
    for (const t of tracksRef.current.values()) {
      if (t.audioEl) return t.audioEl;
    }
    return null;
  }

  // Any one track's <audio> element is the clock: with real media elements
  // currentTime already accounts for playbackRate on its own, so there's no
  // need to hand-track elapsed time.
  const getCurrentTime = useCallback((): number => {
    if (!playingRef.current) return startOffsetRef.current;
    const el = getClockElement();
    return el ? el.currentTime : startOffsetRef.current;
  }, []);

  function isAudible(t: TrackState): boolean {
    const anySolo = Array.from(tracksRef.current.values()).some((x) => x.solo);
    if (anySolo) return t.solo;
    return !t.muted;
  }

  function applyGain(t: TrackState) {
    const v = isAudible(t) ? t.volume : 0;
    if (t.gain) t.gain.gain.value = v;
    else if (t.audioEl) t.audioEl.volume = v;
  }

  function refreshAllGains() {
    for (const t of tracksRef.current.values()) applyGain(t);
  }

  function ensureAudioCtx() {
    if (audioCtxRef.current) return;
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    const metronome = ctx.createGain();
    metronome.gain.value = 0.5;
    metronome.connect(master);
    audioCtxRef.current = ctx;
    masterGainRef.current = master;
    metronomeGainRef.current = metronome;
  }

  // The tempo in effect at the current playhead, not just the score's
  // initial marking - scores with a rit./accelerando/fermata have several.
  const currentBaseBpm = useCallback((): number => {
    const tempoMap = tempoMapRef.current;
    if (tempoMap.length === 0) return currentScoreRef.current?.bpm || 0;
    const t = getCurrentTime();
    let lo = 0;
    let hi = tempoMap.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tempoMap[mid].time <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return tempoMap[idx].bpm;
  }, [getCurrentTime]);

  const updateTempoUI = useCallback(() => {
    tempoControlRef.current?.updateLabel(currentBaseBpm(), speedRef.current);
  }, [currentBaseBpm]);

  // ---------- cursor sync ----------
  //
  // No toggle, no inference - just scroll to the cursor whenever it moves
  // to a new staff line or page, so playback keeps the active line on
  // screen without re-centering on every single note. `forceScroll` (from
  // seeking or clicking a note) always jumps regardless.

  // The element that actually scrolls the score into view: #pagesWrap on
  // desktop, but below 700px #pagesWrap/#mixer share one scroll region on
  // #main instead (see the mobile media query in style.css) - detected via
  // computed overflow rather than duplicating that breakpoint here, so the
  // two stay in sync automatically if either one changes.
  function scrollHost(): HTMLElement | null {
    const wrap = pagesViewRef.current?.getPagesWrapEl() ?? null;
    if (wrap && getComputedStyle(wrap).overflowY === 'visible') {
      return mainRef.current;
    }
    return wrap ?? mainRef.current;
  }

  function cursorScrollDelta(
    cursorRect: { top: number; left: number; width: number; height: number },
    wrapRect: { top: number; left: number; width: number; height: number },
  ) {
    const deltaY =
      cursorRect.height <= wrapRect.height
        ? cursorRect.top - (wrapRect.top + (wrapRect.height - cursorRect.height) / 2)
        : cursorRect.top - wrapRect.top;
    const deltaX =
      cursorRect.width <= wrapRect.width
        ? cursorRect.left - (wrapRect.left + (wrapRect.width - cursorRect.width) / 2)
        : cursorRect.left - wrapRect.left;
    return { deltaY, deltaX };
  }

  const updateCursor = useCallback(
    (forceScroll = false) => {
      const positions = positionsRef.current;
      const pages = pagesViewRef.current;
      if (!positions || positions.events.length === 0 || !pages) return;
      const tMs = getCurrentTime() * 1000;

      // events are sorted by position ascending; find the last one <= tMs
      const events = positions.events;
      let lo = 0;
      let hi = events.length - 1;
      let idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].position <= tMs) {
          idx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const activeEvent = events[idx];
      const elInfo = elementsByIdRef.current.get(activeEvent.elid);
      if (!elInfo) return;

      const scale = pages.getPageScale(elInfo.page);
      if (!scale) return;

      pages.moveCursor(elInfo.page, elInfo.x * scale, elInfo.y * scale, elInfo.sx * scale, elInfo.sy * scale);

      const key = `${elInfo.page}:${elInfo.y}`;
      const lineChanged = key !== lastCursorKeyRef.current;
      lastCursorKeyRef.current = key;
      if (!forceScroll && !lineChanged) return;

      const pageRect = pages.getPageRect(elInfo.page);
      if (!pageRect) return;
      const cursorRect = {
        top: pageRect.top + elInfo.y * scale,
        left: pageRect.left + elInfo.x * scale,
        width: elInfo.sx * scale,
        height: elInfo.sy * scale,
      };

      const host = scrollHost();
      if (!host) return;
      const wrapRect = host.getBoundingClientRect();
      const { deltaY, deltaX } = cursorScrollDelta(cursorRect, wrapRect);
      if (Math.abs(deltaY) > 1 || Math.abs(deltaX) > 1) {
        host.scrollBy({ top: deltaY, left: deltaX, behavior: 'smooth' });
      }
    },
    [getCurrentTime],
  );

  // ---------- time / tick loop ----------

  const updateTimeUI = useCallback(() => {
    const t = getCurrentTime();
    if (!seekDraggingRef.current) {
      seekBarRef.current?.setValue(durationRef.current > 0 ? t / durationRef.current : 0);
    }
    timeLabelRef.current?.setText(t, durationRef.current);
  }, [getCurrentTime]);

  // Finds the first beat at/after `fromTime` so scheduleMetronome() doesn't
  // fire every beat since the start of the piece when playback starts/seeks.
  function resetMetronomeSchedule(fromTime: number) {
    const beatMap = beatMapRef.current;
    let lo = 0;
    let hi = beatMap.length - 1;
    let idx = beatMap.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beatMap[mid].time >= fromTime) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    nextBeatIndexRef.current = idx;
  }

  function playClick(time: number, isDownbeat: boolean) {
    const ctx = audioCtxRef.current;
    const metronomeGain = metronomeGainRef.current;
    if (!ctx || !metronomeGain) return;
    const osc = ctx.createOscillator();
    const envelope = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = isDownbeat ? 1500 : 1000;
    const peak = isDownbeat ? 0.45 : 0.25;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(peak, time + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(envelope);
    envelope.connect(metronomeGain);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  // Look-ahead scheduler: beat times are in the media's own (unsped-up)
  // timeline, same as getCurrentTime(), so 1 second of that timeline takes
  // 1/speed real seconds to actually play - that's the conversion below.
  function scheduleMetronome() {
    const ctx = audioCtxRef.current;
    if (!metronomeOnRef.current || !ctx) return;
    const beatMap = beatMapRef.current;
    const nowPiece = getCurrentTime();
    const lookaheadPiece = 0.25 * speedRef.current;
    while (
      nextBeatIndexRef.current < beatMap.length &&
      beatMap[nextBeatIndexRef.current].time <= nowPiece + lookaheadPiece
    ) {
      const beat = beatMap[nextBeatIndexRef.current];
      const delay = Math.max(0, (beat.time - nowPiece) / speedRef.current);
      playClick(ctx.currentTime + delay, beat.downbeat);
      nextBeatIndexRef.current++;
    }
  }

  const setPlaying = useCallback((v: boolean) => {
    playingRef.current = v;
    setPlayingState(v);
  }, []);

  const stopPlayback = useCallback(() => {
    if (playingRef.current) {
      startOffsetRef.current = getCurrentTime();
      for (const t of tracksRef.current.values()) {
        t.audioEl?.pause();
      }
      setPlaying(false);
      // A manual pause while frozen for buffering should read as just
      // "paused", not still spin a loading indicator for a fetch nothing
      // is waiting on anymore.
      resetStallTracking();
    }
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
  }, [getCurrentTime, setPlaying]);

  const tickLoop = useCallback(() => {
    if (!playingRef.current) return;
    const t = getCurrentTime();
    if (t >= durationRef.current) {
      stopPlayback();
      startOffsetRef.current = durationRef.current;
      updateTimeUI();
      updateCursor();
      updateTempoUI();
      return;
    }
    updateTimeUI();
    updateCursor();
    updateTempoUI();
    scheduleMetronome();
    rafHandleRef.current = requestAnimationFrame(tickLoop);
  }, [getCurrentTime, stopPlayback, updateTimeUI, updateCursor, updateTempoUI]);

  // A track's 'waiting' event means the browser paused *that one* element
  // for lack of buffered data. Left alone, every other track keeps
  // playing and drifts ahead of it - the displayed time (driven by
  // whichever track getClockElement() happens to pick) would keep
  // advancing even though part of the mix has gone silent. Freeze every
  // track the instant any of them stalls, and resume them all together
  // once every stalled track has recovered, so nothing can outrun
  // anything else and the score only advances when the full ensemble
  // actually can.
  //
  // Every play() call - not just the very first one; a manual pause/resume
  // re-triggers it too (verified) - fires its own brief, self-resolving
  // 'waiting' while the decoder re-primes. Freezing on that immediately
  // pauses every *other* track mid-blip - but pause() on a track whose own
  // play() hasn't resolved yet aborts that attempt, and its 'playing' then
  // never fires (verified: this deadlocked every resume, permanently stuck
  // paused). markPendingStart() below marks a track right as we call
  // play() on it, and handleTrackWaiting ignores 'waiting' for a track
  // that's still pending its own start - so the routine blip never
  // triggers the freeze cascade that kills it. A genuine mid-playback
  // stall (the track isn't pending - nobody just called play() on it) is
  // still frozen with zero added delay. The one gap this leaves - a real
  // stall that happens to coincide exactly with a play() call, which looks
  // identical to the routine blip from the outside - is caught by
  // PENDING_START_TIMEOUT_MS as a backstop; it's generous on purpose since
  // it only matters for that rare coincidence, never for the routine blip
  // (always resolves in <1ms, confirmed empirically) or for a stall
  // detected on an already-started track (still instant).
  const PENDING_START_TIMEOUT_MS = 2000;

  function freezeForStall(trackId: string) {
    const wasEmpty = stallingTracksRef.current.size === 0;
    stallingTracksRef.current.add(trackId);
    if (!wasEmpty) return;
    // Snap every track to the stalled one's own (frozen) position before
    // pausing them, so resuming afterwards starts them all perfectly
    // aligned instead of leaving the healthy ones wherever they'd
    // wandered to.
    const freezeAt = tracksRef.current.get(trackId)?.audioEl?.currentTime;
    for (const t of tracksRef.current.values()) {
      if (!t.audioEl) continue;
      t.audioEl.pause();
      if (freezeAt !== undefined) t.audioEl.currentTime = freezeAt;
    }
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    setBuffering(true);
    updateTimeUI();
    updateCursor();
    updateTempoUI();
  }

  function markPendingStart(trackId: string) {
    const existing = pendingStartTimersRef.current.get(trackId);
    if (existing !== undefined) clearTimeout(existing);
    pendingStartRef.current.add(trackId);
    pendingStartTimersRef.current.set(
      trackId,
      window.setTimeout(() => {
        pendingStartTimersRef.current.delete(trackId);
        if (!pendingStartRef.current.delete(trackId)) return;
        if (!playingRef.current) return;
        freezeForStall(trackId);
      }, PENDING_START_TIMEOUT_MS),
    );
  }

  function clearPendingStart(trackId: string) {
    const timer = pendingStartTimersRef.current.get(trackId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingStartTimersRef.current.delete(trackId);
    }
    pendingStartRef.current.delete(trackId);
  }

  function resetStallTracking() {
    stallingTracksRef.current.clear();
    for (const timer of pendingStartTimersRef.current.values()) clearTimeout(timer);
    pendingStartTimersRef.current.clear();
    pendingStartRef.current.clear();
    setBuffering(false);
  }

  const handleTrackWaiting = useCallback((trackId: string) => {
    if (!playingRef.current) return;
    if (pendingStartRef.current.has(trackId)) return;
    freezeForStall(trackId);
  }, []);

  const handleTrackRecovered = useCallback((trackId: string) => {
    clearPendingStart(trackId);
    if (!stallingTracksRef.current.delete(trackId)) return;
    if (stallingTracksRef.current.size > 0 || !playingRef.current) return;
    setBuffering(false);
    for (const [id, t] of tracksRef.current.entries()) {
      markPendingStart(id);
      t.audioEl?.play().catch(() => {});
    }
    tickLoop();
  }, [tickLoop]);

  const startPlayback = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    resetStallTracking();
    if (startOffsetRef.current >= durationRef.current) startOffsetRef.current = 0;
    for (const [id, t] of tracksRef.current.entries()) {
      if (!t.audioEl) continue;
      t.audioEl.currentTime = startOffsetRef.current;
      t.audioEl.playbackRate = speedRef.current;
      markPendingStart(id);
      // A play() request can be interrupted by a pause() before it resolves
      // (e.g. rapid space/arrow-key presses) - expected, not a bug; swallow
      // the resulting rejection so it doesn't spam the console.
      t.audioEl.play().catch(() => {});
    }
    resetMetronomeSchedule(startOffsetRef.current);
    setPlaying(true);
    updateCursor();
    tickLoop();
  }, [setPlaying, updateCursor, tickLoop]);

  const togglePlay = useCallback(() => {
    ensureAudioCtx();
    if (playingRef.current) stopPlayback();
    else startPlayback();
  }, [stopPlayback, startPlayback]);

  const seekTo = useCallback(
    (seconds: number, forceScroll = false) => {
      startOffsetRef.current = Math.min(Math.max(seconds, 0), durationRef.current);
      // Seeking a *playing* element makes the browser briefly pause-then-
      // auto-resume it on its own, firing the same 'waiting'/'playing'
      // pair as any other play() - without markPendingStart here,
      // handleTrackWaiting treats that as a real stall and pauses every
      // track, which cancels the browser's in-flight auto-resume before
      // its 'playing' ever fires. Net effect (verified): seeking during
      // playback froze the score permanently. Only relevant while
      // actually playing - a paused element doesn't auto-resume from a
      // seek, so there's nothing to guard while stopped.
      if (playingRef.current) {
        for (const id of tracksRef.current.keys()) markPendingStart(id);
      }
      for (const t of tracksRef.current.values()) {
        if (t.audioEl) t.audioEl.currentTime = startOffsetRef.current;
      }
      resetMetronomeSchedule(startOffsetRef.current);
      updateTimeUI();
      updateCursor(forceScroll);
      updateTempoUI();
    },
    [updateTimeUI, updateCursor, updateTempoUI],
  );

  const onSeekInput = useCallback((fraction: number) => {
    seekDraggingRef.current = true;
    timeLabelRef.current?.setText(fraction * durationRef.current, durationRef.current);
  }, []);

  const onSeekChange = useCallback(
    (fraction: number) => {
      seekTo(fraction * durationRef.current, true);
      seekDraggingRef.current = false;
    },
    [seekTo],
  );

  const setSpeedValue = useCallback(
    (value: number) => {
      speedRef.current = value;
      setSpeedState(value);
      // <audio>.playbackRate can change live without resetting currentTime
      // or needing a restart - and with preservesPitch set, it only
      // changes speed.
      for (const t of tracksRef.current.values()) {
        if (t.audioEl) t.audioEl.playbackRate = value;
      }
      updateTempoUI();
    },
    [updateTempoUI],
  );

  const setMetronomeOn = useCallback(
    (on: boolean) => {
      metronomeOnRef.current = on;
      setMetronomeOnState(on);
      if (on) resetMetronomeSchedule(getCurrentTime());
    },
    [getCurrentTime],
  );

  const toggleMetronome = useCallback(() => {
    ensureAudioCtx();
    setMetronomeOn(!metronomeOnRef.current);
  }, [setMetronomeOn]);

  const setTrackVolume = useCallback((id: string, volume: number) => {
    const t = tracksRef.current.get(id);
    if (!t) return;
    t.volume = volume;
    applyGain(t);
  }, []);

  const setTrackPan = useCallback((id: string, pan: number) => {
    const t = tracksRef.current.get(id);
    if (!t) return;
    t.pan = pan;
    if (t.panner) t.panner.pan.value = pan;
  }, []);

  const toggleTrackMute = useCallback((id: string) => {
    const t = tracksRef.current.get(id);
    if (!t) return;
    t.muted = !t.muted;
    if (t.muted && t.solo) t.solo = false;
    refreshAllGains();
    setTrackList((list) => list.map((tr) => (tr.id === id ? { ...tr, muted: t.muted, solo: t.solo } : tr)));
  }, []);

  const toggleTrackSolo = useCallback((id: string) => {
    const t = tracksRef.current.get(id);
    if (!t) return;
    t.solo = !t.solo;
    if (t.solo && t.muted) t.muted = false;
    refreshAllGains();
    setTrackList((list) => list.map((tr) => (tr.id === id ? { ...tr, muted: t.muted, solo: t.solo } : tr)));
  }, []);

  // Nearest element on `page` to point (px, py), both in PNG-pixel space.
  // Distance to a rect is 0 when the point is inside it, so a click on a
  // notehead/rest always wins; elsewhere this falls back to whatever's
  // closest.
  function findElementAtPoint(page: number, px: number, py: number): PositionElement | null {
    const positions = positionsRef.current;
    if (!positions) return null;
    let best: PositionElement | null = null;
    let bestDist = Infinity;
    for (const el of positions.elements) {
      if (el.page !== page) continue;
      const dx = px < el.x ? el.x - px : Math.max(0, px - (el.x + el.sx));
      const dy = py < el.y ? el.y - py : Math.max(0, py - (el.y + el.sy));
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
    return best;
  }

  const onPageClick = useCallback(
    (pageIndex: number, offsetX: number, offsetY: number) => {
      const positions = positionsRef.current;
      if (!positions || positions.elements.length === 0) return;
      const scale = pagesViewRef.current?.getPageScale(pageIndex) ?? 0;
      if (!scale) return;
      const px = offsetX / scale;
      const py = offsetY / scale;
      const el = findElementAtPoint(pageIndex, px, py);
      if (!el) return;
      const ms = eventPositionByElIdRef.current.get(el.id);
      if (ms === undefined) return;
      ensureAudioCtx();
      seekTo(ms / 1000, true);
    },
    [seekTo],
  );

  // Scrolls by one screenful of the visible area (direction -1/+1) - same
  // as native PageUp/PageDown, so it scrolls by however much is actually
  // visible rather than jumping to a specific page element.
  const stepPage = useCallback((direction: 1 | -1) => {
    const host = scrollHost();
    if (!host) return;
    host.scrollBy({ top: direction * host.clientHeight, behavior: 'smooth' });
  }, []);

  // Keeps the same relative scroll position across a zoom change (as a
  // fraction of the total scrollable distance in each direction), so
  // zooming in/out doesn't jump to an earlier/later page. Measured here
  // (before the DOM re-renders with the new --zoom), restored in the
  // useLayoutEffect below (after it does).
  const setZoom = useCallback((level: number) => {
    const wrap = scrollHost();
    if (wrap) {
      const oldScrollableY = wrap.scrollHeight - wrap.clientHeight;
      const oldScrollableX = wrap.scrollWidth - wrap.clientWidth;
      zoomScrollFracRef.current = {
        fracY: oldScrollableY > 0 ? wrap.scrollTop / oldScrollableY : 0,
        fracX: oldScrollableX > 0 ? wrap.scrollLeft / oldScrollableX : 0,
      };
    }
    setZoomLevelState(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level)));
  }, []);

  useLayoutEffect(() => {
    const wrap = scrollHost();
    const frac = zoomScrollFracRef.current;
    if (wrap && frac) {
      const newScrollableY = wrap.scrollHeight - wrap.clientHeight;
      const newScrollableX = wrap.scrollWidth - wrap.clientWidth;
      wrap.scrollTop = frac.fracY * newScrollableY;
      wrap.scrollLeft = frac.fracX * newScrollableX;
    }
    zoomScrollFracRef.current = null;
    updateCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomLevel]);

  // A new score's pages/positions have committed to the DOM by now -
  // position the cursor at the playhead (0 on a fresh load), matching
  // src/app.js's renderPages() -> applyLayout() -> updateCursor() chain,
  // which today runs synchronously as part of loadScore().
  useLayoutEffect(() => {
    updateCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreMeta]);

  // window resize -> recompute cursor position (no forced scroll), kept as
  // a bare top-level listener like src/app.js's own.
  useEffect(() => {
    function onResize() {
      updateCursor();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateCursor]);

  // ---------- loading a score ----------

  useEffect(() => {
    if (!scoreId) return;
    let cancelled = false;

    (async () => {
      stopPlayback();
      tracksRef.current.clear();
      resetStallTracking();
      setTrackList([]);
      setLoading(true);
      lastCursorKeyRef.current = null;
      startOffsetRef.current = 0;
      timeLabelRef.current?.setText(0, 0);
      seekBarRef.current?.setValue(0);

      const base = `scores/${scoreId}/`;
      const [meta, pos, tempos, beats]: [ScoreMeta, Positions, TempoMapEntry[], BeatMapEntry[]] = await Promise.all([
        fetch(base + 'meta.json').then((r) => r.json()),
        fetch(base + 'positions.json').then((r) => r.json()),
        fetch(base + 'tempo-map.json').then((r) => r.json()),
        fetch(base + 'beats.json').then((r) => r.json()),
      ]);
      if (cancelled) return;

      currentScoreRef.current = meta;
      positionsRef.current = pos;
      tempoMapRef.current = tempos;
      beatMapRef.current = beats;
      nextBeatIndexRef.current = 0;
      setMetronomeOn(false);
      elementsByIdRef.current = new Map(pos.elements.map((e) => [e.id, e]));
      eventPositionByElIdRef.current = new Map(pos.events.map((e) => [e.elid, e.position]));
      durationRef.current = meta.duration || 0;
      setDurationState(durationRef.current);

      setScoreMeta(meta);

      speedRef.current = 1;
      setSpeedState(1);
      updateTempoUI();

      tracksRef.current = new Map(
        meta.tracks.map((tm) => [
          tm.id,
          { audioEl: null, gain: null, panner: null, volume: 0.85, pan: 0, muted: false, solo: false } as TrackState,
        ]),
      );
      setTrackList(
        meta.tracks.map((tm) => ({ id: tm.id, name: tm.name, initialVolume: 0.85, muted: false, solo: false })),
      );

      ensureAudioCtx();
      const ctx = audioCtxRef.current;
      const master = masterGainRef.current;
      if (ctx && master) {
        await Promise.all(
          meta.tracks.map(
            (tm) =>
              new Promise<void>((resolve, reject) => {
                const t = tracksRef.current.get(tm.id);
                if (!t) return resolve();

                const audioEl = new Audio();
                audioEl.preload = 'auto';
                setPreservesPitch(audioEl, true);
                // 'canplay' (enough buffered to start) rather than
                // 'canplaythrough' (browser estimates the *whole* file will
                // arrive without stalling) - the latter effectively waits
                // for a full download on anything but a very fast
                // connection, even though these files are served with
                // range-request support and keep streaming in via
                // preload='auto' once playback starts.
                audioEl.addEventListener('canplay', () => resolve(), { once: true });
                audioEl.addEventListener('error', () => reject(new Error(`failed to load ${tm.file}`)), {
                  once: true,
                });
                audioEl.addEventListener('waiting', () => handleTrackWaiting(tm.id));
                audioEl.addEventListener('playing', () => handleTrackRecovered(tm.id));
                audioEl.src = base + tm.file;
                t.audioEl = audioEl;

                // createMediaElementSource routes the element's audio
                // through this graph instead of straight to the speakers -
                // it stops going to the speakers on its own the moment
                // this is called.
                const source = ctx.createMediaElementSource(audioEl);
                const panner = ctx.createStereoPanner();
                panner.pan.value = t.pan;
                const gain = ctx.createGain();
                gain.gain.value = 0; // engaged in applyGain below
                source.connect(panner);
                panner.connect(gain);
                gain.connect(master);
                t.panner = panner;
                t.gain = gain;
                applyGain(t);
              }),
          ),
        );
      }
      if (cancelled) return;

      setLoading(false);
      updateTimeUI();

      const url = new URL(location.href);
      url.searchParams.set('score', scoreId);
      history.replaceState(null, '', url);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreId]);

  return {
    seekBarRef,
    timeLabelRef,
    pagesViewRef,
    tempoControlRef,

    scoreMeta,
    loading,
    buffering,
    playing,
    duration,
    speed,
    metronomeOn,
    trackList,
    zoomLevel,

    togglePlay,
    onSeekInput,
    onSeekChange,
    setSpeedValue,
    toggleMetronome,
    setTrackVolume,
    setTrackPan,
    toggleTrackMute,
    toggleTrackSolo,
    onPageClick,
    stepPage,
    setZoom,
    recomputeCursor: updateCursor,
  };
}
