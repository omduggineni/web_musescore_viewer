(() => {
  'use strict';

  const els = {
    title: document.getElementById('scoreTitle'),
    composer: document.getElementById('scoreComposer'),
    tempoLabel: document.getElementById('tempoLabel'),
    metronomeBtn: document.getElementById('metronomeBtn'),
    speedSlider: document.getElementById('speedSlider'),
    speedValue: document.getElementById('speedValue'),
    viewCenteredBtn: document.getElementById('viewCenteredBtn'),
    viewBookBtn: document.getElementById('viewBookBtn'),
    zoomOutBtn: document.getElementById('zoomOutBtn'),
    zoomInBtn: document.getElementById('zoomInBtn'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    fullscreenIcon: document.getElementById('fullscreenIcon'),
    mixer: document.getElementById('mixer'),
    mixerToggleBtn: document.getElementById('mixerToggleBtn'),
    pagesWrap: document.getElementById('pagesWrap'),
    pages: document.getElementById('pages'),
    channels: document.getElementById('channels'),
    playBtn: document.getElementById('playBtn'),
    playIcon: document.getElementById('playIcon'),
    seek: document.getElementById('seek'),
    timeLabel: document.getElementById('timeLabel'),
  };

  const SEEK_RESOLUTION = 1000;

  // Firefox has long-standing bugs (bugzilla 966247/1517199/1251640/1648277)
  // where a rate-changed, pitch-preserved <audio> element routed through
  // Web Audio via createMediaElementSource glitches/pops - worse with more
  // simultaneous tracks. Chrome/Safari don't share this bug. Rather than
  // give up the Web Audio mixing graph (panning, clean gain nodes) on
  // Firefox, we just disable the speed control there - see the isFirefox
  // block below.
  const isFirefox = /firefox/i.test(navigator.userAgent);
  const FIREFOX_BUG_URL = 'https://bugzilla.mozilla.org/show_bug.cgi?id=1517199';

  const ZOOM_STEP = 0.15;
  const ZOOM_MIN = 0.55;
  const ZOOM_MAX = 2.5;

  // How far inside the viewport edges the active staff must stay while
  // "following" (see the Cursor sync section) - a fraction of the
  // viewport's own height, not a fixed pixel count, so it scales with
  // zoom/window size.
  const FOLLOW_MARGIN_FRACTION = 0.12;
  // How long a programmatic scroll can go without a 'scrollend' before we
  // give up waiting for one and clear the flag anyway (older/inconsistent
  // 'scrollend' support) - longer than the CSS scroll-behavior:smooth
  // default duration for any scroll distance this app produces.
  const FOLLOW_SCROLL_FALLBACK_MS = 700;

  // Lucide icon paths (ISC license), swapped into a single <svg> on state
  // change rather than keeping two elements and toggling which is hidden.
  const PLAY_ICON = '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />';
  const PAUSE_ICON = '<rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" />';
  const MAXIMIZE_ICON = '<path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />';
  const MINIMIZE_ICON = '<path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />';

  /** @type {AudioContext|null} */
  let audioCtx = null;
  let masterGain = null;
  let metronomeGain = null;

  let currentScore = null;   // meta.json contents
  let positions = null;      // positions.json contents
  let elementsById = null;   // Map<id, element>
  let eventPositionByElId = null; // Map<elementId, ms>
  let tempoMap = [];         // [{time (sec), bpm}, ...] sorted by time
  let beatMap = [];          // [{time (sec), downbeat}, ...] sorted by time
  let nextBeatIndex = 0;     // metronome scheduler's position in beatMap
  let metronomeOn = false;
  let mixerOpen = true;
  let zoomLevel = 1;
  let pageEls = [];          // [{el, img, cursorEl}]
  /** @type {IntersectionObserver|null} */
  let pageObserver = null;   // lazy-loads/unloads page images as they scroll
  // All pages of a score share the same pixel dimensions. Cached from
  // whichever page loads first so scale can be computed for a page whose
  // own image hasn't loaded yet (e.g. clicking a still-grey page).
  let sharedNaturalWidth = 0;
  let sharedNaturalHeight = 0;

  /** @type {Map<string, {audioEl:HTMLAudioElement, gain:GainNode, panner:StereoPannerNode,
   *   volume:number, pan:number, muted:boolean, solo:boolean}>} */
  let tracks = new Map();

  let layoutMode = 'centered'; // or 'book'
  // Whether the view should keep scrolling to follow the active staff.
  // Explicit rather than inferred from position history: armed by
  // pressing play, seeking, or clicking a note; disarmed the moment the
  // user scrolls away from the active staff on their own (see the Cursor
  // sync section), and re-armed if they scroll back to it.
  let followEnabled = false;
  let followScrollActive = false; // true while a scroll we started is in flight
  let followScrollFallbackTimer = null;
  // The active staff's page/position/scale, kept instead of a precomputed
  // rect: handleManualScroll() below recomputes computeCursorRect() from
  // page.el's *current* getBoundingClientRect() each time, since a stored
  // viewport-relative rect goes stale the instant the page scrolls
  // (including our own follow-scroll moving it) - comparing a pre-scroll
  // snapshot against the post-scroll viewport was flipping followEnabled
  // back off right after arming it.
  let currentCursorPage = null;
  let currentCursorElInfo = null;
  let currentCursorScale = 0;
  let playing = false;
  let startOffset = 0;       // playback position (seconds) while paused
  let duration = 0;          // seconds
  let speed = 1;             // playback rate multiplier
  let rafHandle = null;
  let seekDragging = false;

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Any one track's <audio> element is the clock: with real media elements
  // (as opposed to AudioBufferSourceNode) currentTime already accounts for
  // playbackRate on its own, so there's no need to hand-track elapsed time.
  function getClockElement() {
    for (const t of tracks.values()) {
      if (t.audioEl) return t.audioEl;
    }
    return null;
  }

  function getCurrentTime() {
    if (!playing) return startOffset;
    const el = getClockElement();
    return el ? el.currentTime : startOffset;
  }

  function isAudible(t) {
    const anySolo = Array.from(tracks.values()).some(x => x.solo);
    if (anySolo) return t.solo;
    return !t.muted;
  }

  function applyGain(id, t) {
    const v = isAudible(t) ? t.volume : 0;
    if (t.gain) t.gain.gain.value = v;
    else if (t.audioEl) t.audioEl.volume = v;
  }

  // Chrome/Firefox/Safari all support this under some spelling; setting all
  // three is harmless where a given one doesn't exist.
  function setPreservesPitch(el, value) {
    el.preservesPitch = value;
    el.mozPreservesPitch = value;
    el.webkitPreservesPitch = value;
  }

  function updateSpeedUI() {
    els.speedValue.textContent = `${speed.toFixed(2)}×`;
    updateTempoUI();
  }

  // The tempo in effect at the current playhead, not just the score's
  // initial marking - scores with a rit./accelerando/fermata have several.
  function currentBaseBpm() {
    if (tempoMap.length === 0) return (currentScore && currentScore.bpm) || 0;
    const t = getCurrentTime();
    let lo = 0, hi = tempoMap.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tempoMap[mid].time <= t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return tempoMap[idx].bpm;
  }

  function updateTempoUI() {
    const baseBpm = currentBaseBpm();
    if (!baseBpm) {
      els.tempoLabel.textContent = '';
      return;
    }
    const effectiveBpm = Math.round(baseBpm * speed);
    els.tempoLabel.textContent = speed === 1
      ? `♩ = ${baseBpm}`
      : `♩ = ${effectiveBpm} (${baseBpm} × ${speed.toFixed(2)})`;
  }

  // ---------- Loading a score ----------

  async function loadIndex() {
    const res = await fetch('scores/index.json');
    return res.json();
  }

  function scoreIdFromUrl() {
    return new URLSearchParams(location.search).get('score');
  }

  async function loadScore(id) {
    stopPlayback();
    tracks.clear();
    els.channels.innerHTML = '';
    els.pages.innerHTML = '';
    els.playBtn.disabled = true;
    els.seek.disabled = true;
    els.seek.value = 0;
    els.timeLabel.textContent = '0:00 / 0:00';
    followEnabled = false;
    currentCursorPage = null;
    currentCursorElInfo = null;

    const base = `scores/${id}/`;
    const [meta, pos, tempos, beats] = await Promise.all([
      fetch(base + 'meta.json').then(r => r.json()),
      fetch(base + 'positions.json').then(r => r.json()),
      fetch(base + 'tempo-map.json').then(r => r.json()),
      fetch(base + 'beats.json').then(r => r.json()),
    ]);
    currentScore = meta;
    positions = pos;
    tempoMap = tempos;
    beatMap = beats;
    nextBeatIndex = 0;
    setMetronomeOn(false);
    elementsById = new Map(positions.elements.map(e => [e.id, e]));
    eventPositionByElId = new Map(positions.events.map(e => [e.elid, e.position]));
    duration = meta.duration || 0;

    els.title.textContent = meta.title;
    els.composer.textContent = meta.composer || '';

    speed = 1;
    els.speedSlider.value = 1;
    updateSpeedUI();

    renderPages(base, meta.npages);
    renderMixer(meta.tracks);
    await loadAudioTracks(base, meta.tracks);

    els.playBtn.disabled = false;
    els.seek.disabled = false;
    updateTimeUI();

    const url = new URL(location.href);
    url.searchParams.set('score', id);
    history.replaceState(null, '', url);
  }

  // PNG-pixel-to-screen-pixel ratio for `img`. Falls back to the shared
  // natural dimensions (cached from whichever page loaded first) when
  // `img` itself hasn't loaded yet, so clicking/highlighting a still-grey
  // page works immediately instead of waiting on that specific image.
  function pageScale(img) {
    const naturalWidth = img.naturalWidth || sharedNaturalWidth;
    return naturalWidth ? img.clientWidth / naturalWidth : 0;
  }

  // Pages are typically full-resolution PNGs a couple MB each, and a long
  // score can have dozens - loading them all upfront wastes bandwidth and
  // memory for pages nobody's looking at. Each <img> holds its real URL in
  // data-src until an IntersectionObserver says it's near the visible
  // area, and loses its src again once scrolled well away.
  const PAGE_LOAD_MARGIN = '600px 0px';

  function renderPages(base, npages) {
    if (pageObserver) pageObserver.disconnect();
    els.pages.style.removeProperty('--page-ratio');
    sharedNaturalWidth = 0;
    sharedNaturalHeight = 0;
    pageEls = [];
    for (let i = 0; i < npages; i++) {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'page';

      const img = document.createElement('img');
      img.dataset.src = base + `page-${i}.png`;
      img.alt = `Page ${i + 1}`;
      img.draggable = false;
      img.addEventListener('click', (e) => onPageClick(i, img, e));
      // Once we know one page's aspect ratio, apply it to all of them so
      // an unloaded (src-less) page still reserves the right amount of
      // space instead of collapsing and jumping the scroll position. Also
      // cache the actual pixel dimensions (all pages share them) so scale
      // can be computed for a page whose own image isn't loaded yet.
      img.addEventListener('load', () => {
        if (!sharedNaturalWidth) {
          sharedNaturalWidth = img.naturalWidth;
          sharedNaturalHeight = img.naturalHeight;
        }
        if (!els.pages.style.getPropertyValue('--page-ratio')) {
          els.pages.style.setProperty('--page-ratio', `${img.naturalWidth} / ${img.naturalHeight}`);
        }
      }, { once: true });

      const cursorEl = document.createElement('div');
      cursorEl.className = 'cursor-hl';

      pageDiv.appendChild(img);
      pageDiv.appendChild(cursorEl);
      pageEls.push({ el: pageDiv, img, cursorEl });
    }

    applyLayout(); // attach to the DOM first, so intersection checks see real layout

    pageObserver = new IntersectionObserver(onPageVisibilityChange, {
      root: els.pagesWrap,
      rootMargin: PAGE_LOAD_MARGIN,
    });
    for (const p of pageEls) pageObserver.observe(p.img);
  }

  function onPageVisibilityChange(entries) {
    for (const entry of entries) {
      const img = entry.target;
      if (entry.isIntersecting) {
        if (!img.getAttribute('src')) img.src = img.dataset.src;
      } else if (img.getAttribute('src')) {
        img.removeAttribute('src');
      }
    }
  }

  // Re-parents the existing page elements into the current layout (does not
  // recreate them, so click/cursor listeners on each <img> stay intact).
  function applyLayout() {
    els.pages.className = layoutMode === 'book' ? 'layout-book' : 'layout-centered';
    els.pages.innerHTML = '';

    if (layoutMode === 'centered') {
      for (const p of pageEls) els.pages.appendChild(p.el);
    } else {
      // Book pagination: two-page spreads throughout, starting with page 1.
      let i = 0;
      while (i < pageEls.length) {
        const spread = document.createElement('div');
        spread.className = 'spread';
        spread.appendChild(pageEls[i].el);
        if (pageEls[i + 1]) {
          spread.appendChild(pageEls[i + 1].el);
        } else {
          // Lone trailing page (odd page count): a same-sized invisible
          // placeholder occupies the second slot so the spread's centering
          // math is identical to a full spread's, putting this page's left
          // edge exactly where a real left-hand page would sit - not at the
          // container's own edge, and not centered by itself either.
          const placeholder = document.createElement('div');
          placeholder.className = 'page page-placeholder';
          spread.appendChild(placeholder);
        }
        i += 2;
        els.pages.appendChild(spread);
      }
    }
    updateCursor();
  }

  // Builds one mixer channel (name, volume, pan, mute, solo) and registers
  // its state in `tracks`.
  function createChannel(id, name, initialVolume) {
    const state = {
      audioEl: null, gain: null, panner: null,
      volume: initialVolume, pan: 0, muted: false, solo: false,
    };
    tracks.set(id, state);

    const ch = document.createElement('div');
    ch.className = 'channel';
    ch.innerHTML = `
      <div class="channel-name" title="${name}">${name}</div>
      <div class="channel-row">
        <label>Vol</label>
        <input type="range" min="0" max="1" step="0.01" value="${state.volume}" data-role="volume">
      </div>
      <div class="channel-row">
        <label>Pan</label>
        <input type="range" min="-1" max="1" step="0.01" value="0" data-role="pan">
      </div>
      <div class="channel-toggles">
        <button type="button" class="toggle-btn" data-role="mute">Mute</button>
        <button type="button" class="toggle-btn" data-role="solo">Solo</button>
      </div>
    `;
    els.channels.appendChild(ch);

    const volumeInput = ch.querySelector('[data-role="volume"]');
    const panInput = ch.querySelector('[data-role="pan"]');
    const muteBtn = ch.querySelector('[data-role="mute"]');
    const soloBtn = ch.querySelector('[data-role="solo"]');

    volumeInput.addEventListener('input', () => {
      state.volume = parseFloat(volumeInput.value);
      applyGain(id, state);
    });
    panInput.addEventListener('input', () => {
      state.pan = parseFloat(panInput.value);
      if (state.panner) state.panner.pan.value = state.pan;
    });
    muteBtn.addEventListener('click', () => {
      state.muted = !state.muted;
      if (state.muted && state.solo) {
        state.solo = false;
        soloBtn.classList.remove('active-solo');
      }
      muteBtn.classList.toggle('active-mute', state.muted);
      refreshAllGains();
    });
    soloBtn.addEventListener('click', () => {
      state.solo = !state.solo;
      if (state.solo && state.muted) {
        state.muted = false;
        muteBtn.classList.remove('active-mute');
      }
      soloBtn.classList.toggle('active-solo', state.solo);
      refreshAllGains();
    });

    return state;
  }

  function renderMixer(trackMetas) {
    for (const tm of trackMetas) {
      createChannel(tm.id, tm.name, 0.85);
    }
  }

  function refreshAllGains() {
    for (const [id, t] of tracks) {
      applyGain(id, t);
    }
  }

  async function loadAudioTracks(base, trackMetas) {
    ensureAudioCtx();
    await Promise.all(trackMetas.map(tm => new Promise((resolve, reject) => {
      const t = tracks.get(tm.id);

      const audioEl = new Audio();
      audioEl.preload = 'auto';
      setPreservesPitch(audioEl, true);
      audioEl.addEventListener('canplaythrough', () => resolve(), { once: true });
      audioEl.addEventListener('error', () => reject(new Error(`failed to load ${tm.file}`)), { once: true });
      audioEl.src = base + tm.file;
      t.audioEl = audioEl;

      // createMediaElementSource routes the element's audio through this
      // graph instead of straight to the speakers - it stops going to the
      // speakers on its own the moment this is called.
      const source = audioCtx.createMediaElementSource(audioEl);
      const panner = audioCtx.createStereoPanner();
      panner.pan.value = t.pan;
      const gain = audioCtx.createGain();
      gain.gain.value = 0; // engaged in applyGain below
      source.connect(panner);
      panner.connect(gain);
      gain.connect(masterGain);
      t.panner = panner;
      t.gain = gain;
      applyGain(tm.id, t);
    })));
  }

  // ---------- Playback ----------

  function ensureAudioCtx() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioCtx.destination);
    metronomeGain = audioCtx.createGain();
    metronomeGain.gain.value = 0.5;
    metronomeGain.connect(masterGain);
  }

  function setPlayButtonState(isPlaying) {
    els.playIcon.innerHTML = isPlaying ? PAUSE_ICON : PLAY_ICON;
    els.playBtn.title = isPlaying ? 'Pause' : 'Play';
    els.playBtn.setAttribute('aria-pressed', String(isPlaying));
  }

  function startPlayback() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (startOffset >= duration) startOffset = 0;
    for (const t of tracks.values()) {
      if (!t.audioEl) continue;
      t.audioEl.currentTime = startOffset;
      t.audioEl.playbackRate = speed;
      // A play() request can be interrupted by a pause() before it resolves
      // (e.g. rapid space/arrow-key presses) - that's expected, not a bug;
      // swallow the resulting rejection so it doesn't spam the console.
      t.audioEl.play().catch(() => {});
    }
    resetMetronomeSchedule(startOffset);
    playing = true;
    setPlayButtonState(true);
    // Pressing play always (re-)arms follow and snaps to the playhead,
    // regardless of whatever was scrolled into view beforehand.
    updateCursor(/* forceScroll */ true);
    tickLoop();
  }

  function stopPlayback() {
    if (playing) {
      startOffset = getCurrentTime();
      for (const t of tracks.values()) {
        if (t.audioEl) t.audioEl.pause();
      }
      playing = false;
    }
    setPlayButtonState(false);
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function seekTo(seconds, forceScroll = false) {
    startOffset = Math.min(Math.max(seconds, 0), duration);
    for (const t of tracks.values()) {
      if (t.audioEl) t.audioEl.currentTime = startOffset;
    }
    resetMetronomeSchedule(startOffset);
    updateTimeUI();
    updateCursor(forceScroll);
    updateTempoUI();
  }

  // ---------- Metronome ----------

  // Finds the first beat at/after `fromTime` so scheduleMetronome() doesn't
  // fire every beat since the start of the piece when playback starts/seeks.
  function resetMetronomeSchedule(fromTime) {
    let lo = 0, hi = beatMap.length - 1, idx = beatMap.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beatMap[mid].time >= fromTime) { idx = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    nextBeatIndex = idx;
  }

  function playClick(time, isDownbeat) {
    const osc = audioCtx.createOscillator();
    const envelope = audioCtx.createGain();
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
    if (!metronomeOn || !audioCtx) return;
    const nowPiece = getCurrentTime();
    const lookaheadPiece = 0.25 * speed;
    while (nextBeatIndex < beatMap.length && beatMap[nextBeatIndex].time <= nowPiece + lookaheadPiece) {
      const beat = beatMap[nextBeatIndex];
      const delay = Math.max(0, (beat.time - nowPiece) / speed);
      playClick(audioCtx.currentTime + delay, beat.downbeat);
      nextBeatIndex++;
    }
  }

  function tickLoop() {
    if (!playing) return;
    const t = getCurrentTime();
    if (t >= duration) {
      stopPlayback();
      startOffset = duration;
      updateTimeUI();
      updateCursor();
      updateTempoUI();
      return;
    }
    updateTimeUI();
    updateCursor();
    updateTempoUI();
    scheduleMetronome();
    rafHandle = requestAnimationFrame(tickLoop);
  }

  function updateTimeUI() {
    const t = getCurrentTime();
    if (!seekDragging) {
      els.seek.value = duration > 0 ? Math.round((t / duration) * SEEK_RESOLUTION) : 0;
    }
    els.timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(duration)}`;
  }

  // ---------- Cursor sync ----------
  //
  // "Follow" (see followEnabled above) is the whole model here: while armed,
  // the view keeps the active staff comfortably on screen, including across
  // staff/page changes during playback; scrolling away from it by hand
  // disarms follow so nothing fights the user, and scrolling back to it
  // re-arms. This replaced an earlier approach that inferred "was the
  // cursor visible before this change" from position history - simpler on
  // paper, but it broke in different ways on different engines (e.g. a
  // sliver of overlap counting as "visible" and leaving a staff half-cut-
  // off; a CSS-transitioned rect read back mid-transition on Firefox but
  // not Chrome). Explicit state sidesteps that whole class of bug.

  // The cursor's on-screen rect computed from position data directly,
  // rather than reading it back via page.cursorEl.getBoundingClientRect()
  // right after setting its style - that rect can be mid-transition
  // (.cursor-hl animates top/left/width/height for smooth movement between
  // notes already on screen) and isn't guaranteed to already reflect the
  // target value when read back synchronously, inconsistently across
  // browsers. Computing it ourselves sidesteps the question entirely.
  function computeCursorRect(page, elInfo, scale) {
    const pageRect = page.el.getBoundingClientRect();
    const top = pageRect.top + elInfo.y * scale;
    const left = pageRect.left + elInfo.x * scale;
    const width = elInfo.sx * scale;
    const height = elInfo.sy * scale;
    return { top, left, width, height, bottom: top + height, right: left + width };
  }

  // Whether `rect` sits comfortably inside `wrapRect` - fully contained
  // with margin to spare, not merely overlapping at the edge - or, when
  // `rect` is bigger than the margin-adjusted viewport in a dimension
  // (e.g. very high zoom), aligned to the near edge (top over bottom, left
  // over right) so as much as possible shows. Used to decide whether
  // follow needs to scroll, and (see handleManualScroll) whether a manual
  // scroll has taken the staff out of comfortable view - the stricter of
  // the two checks used there, for leaving follow armed. Horizontal
  // position is ignored: at high zoom a staff line is wider than the
  // viewport, so the cursor legitimately walks off the left/right edge
  // while playing along a single line - that's normal reading, not the
  // user scrolling away.
  function isComfortable(rect, wrapRect) {
    const margin = wrapRect.height * FOLLOW_MARGIN_FRACTION;
    return rect.height <= wrapRect.height - 2 * margin
      ? (rect.top >= wrapRect.top + margin && rect.bottom <= wrapRect.bottom - margin)
      : Math.abs(rect.top - wrapRect.top) < 1;
  }

  // Whether `rect` overlaps `wrapRect` at all, vertically - not
  // comfortable, not centered, just some overlap. The looser of the two
  // checks in handleManualScroll, used for re-arming follow: scrolling
  // back to where the staff is merely visible again is enough to resume,
  // rather than requiring a scroll all the way back to comfortable -
  // follow's own scrolling then re-centers it from there anyway.
  function isRoughlyVisible(rect, wrapRect) {
    return rect.top < wrapRect.bottom && rect.bottom > wrapRect.top;
  }

  // The (deltaY, deltaX) to scroll by so `cursorRect` becomes visible:
  // centered in a dimension where it fits, or - when it's bigger than the
  // viewport in that dimension - aligned to the near edge so as much as
  // possible shows, prioritizing the top of the cursor over the bottom
  // (and the left over the right).
  function cursorScrollDelta(cursorRect, wrapRect) {
    const deltaY = cursorRect.height <= wrapRect.height
      ? cursorRect.top - (wrapRect.top + (wrapRect.height - cursorRect.height) / 2)
      : cursorRect.top - wrapRect.top;
    const deltaX = cursorRect.width <= wrapRect.width
      ? cursorRect.left - (wrapRect.left + (wrapRect.width - cursorRect.width) / 2)
      : cursorRect.left - wrapRect.left;
    return { deltaY, deltaX };
  }

  // Scrolls #pagesWrap and tags it as our own doing, so the 'scroll'
  // listener below doesn't mistake the resulting events for a manual
  // scroll and disarm follow. Cleared on 'scrollend', with a timed
  // fallback in case that event doesn't fire.
  function followScrollBy(deltaY, deltaX) {
    followScrollActive = true;
    if (followScrollFallbackTimer) clearTimeout(followScrollFallbackTimer);
    followScrollFallbackTimer = setTimeout(() => { followScrollActive = false; }, FOLLOW_SCROLL_FALLBACK_MS);
    els.pagesWrap.scrollBy({ top: deltaY, left: deltaX, behavior: 'smooth' });
  }

  // Stops an in-flight follow scroll immediately (rather than letting the
  // browser's smooth-scroll animation keep running and fight the user) -
  // called the instant manual scroll input (wheel/touch) is detected.
  function cancelFollowScroll() {
    if (!followScrollActive) return;
    const wrap = els.pagesWrap;
    wrap.scrollTo({ top: wrap.scrollTop, left: wrap.scrollLeft, behavior: 'auto' });
    followScrollActive = false;
    if (followScrollFallbackTimer) { clearTimeout(followScrollFallbackTimer); followScrollFallbackTimer = null; }
  }

  // `forceScroll` is for a deliberate one-shot jump (the seek bar, or
  // clicking a note): it always arms follow and always centers on the
  // result, skipping the comfort check entirely - "regardless of the
  // above logic," since the point is guaranteeing you see where you
  // jumped to, not just topping up an already-fine view.
  function updateCursor(forceScroll = false) {
    if (!positions || positions.events.length === 0) return;
    const tMs = getCurrentTime() * 1000;

    // events are sorted by position ascending; find the last one <= tMs
    const events = positions.events;
    let lo = 0, hi = events.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].position <= tMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const activeEvent = events[idx];
    const elInfo = elementsById.get(activeEvent.elid);
    if (!elInfo) return;

    const page = pageEls[elInfo.page];
    if (!page) return;
    const scale = pageScale(page.img);
    if (!scale) return;

    currentCursorPage = page;
    currentCursorElInfo = elInfo;
    currentCursorScale = scale;
    const cursorRect = computeCursorRect(page, elInfo, scale);

    pageEls.forEach((p, i) => {
      p.cursorEl.style.display = i === elInfo.page ? 'block' : 'none';
    });

    page.cursorEl.style.left = `${elInfo.x * scale}px`;
    page.cursorEl.style.top = `${elInfo.y * scale}px`;
    page.cursorEl.style.width = `${elInfo.sx * scale}px`;
    page.cursorEl.style.height = `${elInfo.sy * scale}px`;

    if (forceScroll) {
      followEnabled = true;
      const wrapRect = els.pagesWrap.getBoundingClientRect();
      const { deltaY, deltaX } = cursorScrollDelta(cursorRect, wrapRect);
      if (Math.abs(deltaY) > 1 || Math.abs(deltaX) > 1) followScrollBy(deltaY, deltaX);
    } else if (followEnabled) {
      const wrapRect = els.pagesWrap.getBoundingClientRect();
      if (!isComfortable(cursorRect, wrapRect)) {
        // Vertical-only while continuously following - re-centering
        // horizontally on every note would be distracting when reading
        // across a staff line wider than the viewport (high zoom).
        const { deltaY } = cursorScrollDelta(cursorRect, wrapRect);
        followScrollBy(deltaY, 0);
      }
    }
  }

  // A #pagesWrap 'scroll' event we didn't cause ourselves (see
  // followScrollBy/cancelFollowScroll) - the user dragged the scrollbar,
  // used a wheel/touchpad, or paged with PageUp/Down (stepPage() doesn't
  // tag its own scroll as ours, since that's deliberate manual navigation
  // too). Recomputes the staff's rect fresh (rather than reusing one from
  // updateCursor) since page.el's getBoundingClientRect() reflects
  // wherever the page has scrolled to by now, including from this very
  // scroll event.
  //
  // Disarming and re-arming use different thresholds on purpose: leaving
  // follow armed requires the staff to still be comfortably shown (the
  // stricter check - drifting to the edge counts as "scrolled away"), but
  // resuming only requires the staff to be visible again at all (the
  // looser one) - otherwise you'd have to scroll all the way back to
  // comfortable just to resume, when follow's own scrolling re-centers it
  // from anywhere visible anyway.
  function handleManualScroll() {
    if (!currentCursorPage) return;
    const rect = computeCursorRect(currentCursorPage, currentCursorElInfo, currentCursorScale);
    const wrapRect = els.pagesWrap.getBoundingClientRect();
    followEnabled = followEnabled ? isComfortable(rect, wrapRect) : isRoughlyVisible(rect, wrapRect);
  }

  els.pagesWrap.addEventListener('wheel', cancelFollowScroll, { passive: true });
  els.pagesWrap.addEventListener('touchmove', cancelFollowScroll, { passive: true });
  els.pagesWrap.addEventListener('scrollend', () => {
    followScrollActive = false;
    if (followScrollFallbackTimer) { clearTimeout(followScrollFallbackTimer); followScrollFallbackTimer = null; }
  });
  els.pagesWrap.addEventListener('scroll', () => {
    if (followScrollActive) return; // an echo of our own scroll
    handleManualScroll();
  });

  // Nearest element on `page` to point (px, py), both in PNG-pixel space.
  // Distance to a rect is 0 when the point is inside it, so a click on a
  // notehead/rest always wins; elsewhere (margins, gaps between systems)
  // this falls back to whatever's closest.
  function findElementAtPoint(page, px, py) {
    let best = null;
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

  function onPageClick(pageIndex, img, e) {
    if (!positions || positions.elements.length === 0) return;
    const scale = pageScale(img);
    if (!scale) return;

    const px = e.offsetX / scale;
    const py = e.offsetY / scale;
    const el = findElementAtPoint(pageIndex, px, py);
    if (!el) return;

    const ms = eventPositionByElId.get(el.id);
    if (ms === undefined) return;

    ensureAudioCtx();
    seekTo(ms / 1000, /* forceScroll */ true);
  }

  // Scrolls by one screenful of the visible area (direction -1/+1) - same
  // as native PageUp/PageDown, so it scrolls by however much is actually
  // visible rather than jumping to a specific page element.
  function stepPage(direction) {
    els.pagesWrap.scrollBy({ top: direction * els.pagesWrap.clientHeight, behavior: 'smooth' });
  }

  // ---------- Wiring ----------

  els.playBtn.addEventListener('click', () => {
    ensureAudioCtx();
    if (playing) stopPlayback();
    else startPlayback();
  });

  els.seek.addEventListener('input', () => {
    seekDragging = true;
    const frac = parseInt(els.seek.value, 10) / SEEK_RESOLUTION;
    els.timeLabel.textContent = `${fmtTime(frac * duration)} / ${fmtTime(duration)}`;
  });
  els.seek.addEventListener('change', () => {
    const frac = parseInt(els.seek.value, 10) / SEEK_RESOLUTION;
    seekTo(frac * duration, /* forceScroll */ true);
    seekDragging = false;
  });

  els.speedSlider.addEventListener('input', () => {
    speed = parseFloat(els.speedSlider.value);
    updateSpeedUI();
    // <audio>.playbackRate can change live without resetting currentTime or
    // needing a restart - and with preservesPitch set, it only changes speed.
    for (const t of tracks.values()) {
      if (t.audioEl) t.audioEl.playbackRate = speed;
    }
  });

  function setViewMode(mode) {
    layoutMode = mode;
    els.viewCenteredBtn.classList.toggle('active', mode === 'centered');
    els.viewCenteredBtn.setAttribute('aria-pressed', String(mode === 'centered'));
    els.viewBookBtn.classList.toggle('active', mode === 'book');
    els.viewBookBtn.setAttribute('aria-pressed', String(mode === 'book'));
    applyLayout();
  }

  els.viewCenteredBtn.addEventListener('click', () => setViewMode('centered'));
  els.viewBookBtn.addEventListener('click', () => setViewMode('book'));
  setViewMode(layoutMode);

  // Keeps the same relative scroll position across a zoom change (as a
  // fraction of the total scrollable distance in each direction), so
  // zooming in/out doesn't jump to an earlier/later page.
  function setZoom(level) {
    const wrap = els.pagesWrap;
    const oldScrollableY = wrap.scrollHeight - wrap.clientHeight;
    const oldScrollableX = wrap.scrollWidth - wrap.clientWidth;
    const fracY = oldScrollableY > 0 ? wrap.scrollTop / oldScrollableY : 0;
    const fracX = oldScrollableX > 0 ? wrap.scrollLeft / oldScrollableX : 0;

    zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
    els.pages.style.setProperty('--zoom', zoomLevel);
    els.zoomOutBtn.disabled = zoomLevel <= ZOOM_MIN;
    els.zoomInBtn.disabled = zoomLevel >= ZOOM_MAX;

    const newScrollableY = wrap.scrollHeight - wrap.clientHeight;
    const newScrollableX = wrap.scrollWidth - wrap.clientWidth;
    wrap.scrollTop = fracY * newScrollableY;
    wrap.scrollLeft = fracX * newScrollableX;

    updateCursor();
  }

  els.zoomOutBtn.addEventListener('click', () => setZoom(zoomLevel - ZOOM_STEP));
  els.zoomInBtn.addEventListener('click', () => setZoom(zoomLevel + ZOOM_STEP));
  setZoom(zoomLevel);

  function setFullscreen(on) {
    if (on) document.documentElement.requestFullscreen().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  els.fullscreenBtn.addEventListener('click', () => setFullscreen(!document.fullscreenElement));

  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    els.fullscreenBtn.classList.toggle('active', on);
    els.fullscreenBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
    els.fullscreenBtn.setAttribute('aria-pressed', String(on));
    els.fullscreenIcon.innerHTML = on ? MINIMIZE_ICON : MAXIMIZE_ICON;
  });

  function setMixerOpen(open) {
    mixerOpen = open;
    els.mixer.hidden = !open;
    els.mixerToggleBtn.classList.toggle('active', open);
    els.mixerToggleBtn.setAttribute('aria-pressed', String(open));
    updateCursor();
  }

  els.mixerToggleBtn.addEventListener('click', () => setMixerOpen(!mixerOpen));
  setMixerOpen(mixerOpen);

  function setMetronomeOn(on) {
    metronomeOn = on;
    els.metronomeBtn.classList.toggle('active', on);
    els.metronomeBtn.setAttribute('aria-pressed', String(on));
    if (on) resetMetronomeSchedule(getCurrentTime());
  }

  els.metronomeBtn.addEventListener('click', () => {
    ensureAudioCtx();
    setMetronomeOn(!metronomeOn);
  });

  window.addEventListener('resize', updateCursor);

  // Keyboard shortcuts: space play/pause, page up/down (same as
  // Fn+up/Fn+down on a Mac keyboard - the browser reports those
  // identically as "PageUp"/"PageDown") scroll a page, M toggles the
  // metronome. Skipped while a form control has focus (e.g. a
  // mixer slider), so its own native arrow-key/space handling still works,
  // and skipped for any shortcut-style modifier combo (ctrl/meta/alt).
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        ensureAudioCtx();
        if (playing) stopPlayback(); else startPlayback();
        break;
      case 'PageUp':
        e.preventDefault();
        stepPage(-1);
        break;
      case 'PageDown':
        e.preventDefault();
        stepPage(1);
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        ensureAudioCtx();
        setMetronomeOn(!metronomeOn);
        break;
    }
  });

  if (isFirefox) {
    els.speedSlider.disabled = true;
    const tooltip = `Speed control is disabled in Firefox due to a browser bug ` +
      `that causes audio glitches when playback rate changes on multi-track ` +
      `audio (${FIREFOX_BUG_URL})`;
    els.speedSlider.title = tooltip;
    document.getElementById('speedWrap').title = tooltip;
  }

  (async function init() {
    const list = await loadIndex();
    if (list.length === 0) return;
    const requested = scoreIdFromUrl();
    const id = list.some(s => s.id === requested) ? requested : list[0].id;
    await loadScore(id);
  })();
})();
