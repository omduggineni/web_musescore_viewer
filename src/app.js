(() => {
  'use strict';

  const els = {
    title: document.getElementById('scoreTitle'),
    composer: document.getElementById('scoreComposer'),
    tempoLabel: document.getElementById('tempoLabel'),
    speedSlider: document.getElementById('speedSlider'),
    speedValue: document.getElementById('speedValue'),
    viewModeBtn: document.getElementById('viewModeBtn'),
    pages: document.getElementById('pages'),
    channels: document.getElementById('channels'),
    playBtn: document.getElementById('playBtn'),
    seek: document.getElementById('seek'),
    timeLabel: document.getElementById('timeLabel'),
  };

  const SEEK_RESOLUTION = 1000;

  // Firefox has long-standing bugs (bugzilla 966247/1517199/1251640/1648277)
  // where a rate-changed, pitch-preserved <audio> element routed through
  // Web Audio via createMediaElementSource glitches/pops - worse with more
  // simultaneous tracks. Chrome/Safari don't share this bug. Rather than
  // give up the Web Audio mixing graph (panning, clean gain nodes) on
  // Firefox, we just disable the speed control there - see wireSpeedSlider.
  const isFirefox = /firefox/i.test(navigator.userAgent);
  const FIREFOX_BUG_URL = 'https://bugzilla.mozilla.org/show_bug.cgi?id=1517199';

  /** @type {AudioContext|null} */
  let audioCtx = null;
  let masterGain = null;

  let currentScore = null;   // meta.json contents
  let positions = null;      // positions.json contents
  let elementsById = null;   // Map<id, element>
  let eventPositionByElId = null; // Map<elementId, ms>
  let tempoMap = [];         // [{time (sec), bpm}, ...] sorted by time
  let pageEls = [];          // [{el, img, cursorEl}]

  /** @type {Map<string, {audioEl:HTMLAudioElement, gain:GainNode, panner:StereoPannerNode,
   *   volume:number, pan:number, muted:boolean, solo:boolean}>} */
  let tracks = new Map();

  let layoutMode = 'centered'; // or 'book'
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

    const base = `scores/${id}/`;
    const [meta, pos, tempos] = await Promise.all([
      fetch(base + 'meta.json').then(r => r.json()),
      fetch(base + 'positions.json').then(r => r.json()),
      fetch(base + 'tempo-map.json').then(r => r.json()),
    ]);
    currentScore = meta;
    positions = pos;
    tempoMap = tempos;
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

  function renderPages(base, npages) {
    pageEls = [];
    for (let i = 0; i < npages; i++) {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'page';

      const img = document.createElement('img');
      img.src = base + `page-${i}.png`;
      img.alt = `Page ${i + 1}`;
      img.draggable = false;
      img.addEventListener('click', (e) => onPageClick(i, img, e));

      const cursorEl = document.createElement('div');
      cursorEl.className = 'cursor-hl';

      pageDiv.appendChild(img);
      pageDiv.appendChild(cursorEl);
      pageEls.push({ el: pageDiv, img, cursorEl });
    }
    applyLayout();
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

  function renderMixer(trackMetas) {
    for (const tm of trackMetas) {
      const state = {
        audioEl: null, gain: null, panner: null,
        volume: 0.85, pan: 0, muted: false, solo: false,
      };
      tracks.set(tm.id, state);

      const ch = document.createElement('div');
      ch.className = 'channel';
      ch.innerHTML = `
        <div class="channel-name" title="${tm.name}">${tm.name}</div>
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
        applyGain(tm.id, state);
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
  }

  function startPlayback() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (startOffset >= duration) startOffset = 0;
    for (const t of tracks.values()) {
      if (!t.audioEl) continue;
      t.audioEl.currentTime = startOffset;
      t.audioEl.playbackRate = speed;
      t.audioEl.play();
    }
    playing = true;
    els.playBtn.textContent = 'Pause';
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
    els.playBtn.textContent = 'Play';
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function seekTo(seconds) {
    startOffset = Math.min(Math.max(seconds, 0), duration);
    for (const t of tracks.values()) {
      if (t.audioEl) t.audioEl.currentTime = startOffset;
    }
    updateTimeUI();
    updateCursor();
    updateTempoUI();
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

  let lastActivePage = -1;

  function updateCursor() {
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

    pageEls.forEach((p, i) => {
      p.cursorEl.style.display = i === elInfo.page ? 'block' : 'none';
    });

    const page = pageEls[elInfo.page];
    if (!page) return;
    const scale = page.img.clientWidth / page.img.naturalWidth || 0;
    if (!scale) return;

    page.cursorEl.style.left = `${elInfo.x * scale}px`;
    page.cursorEl.style.top = `${elInfo.y * scale}px`;
    page.cursorEl.style.width = `${elInfo.sx * scale}px`;
    page.cursorEl.style.height = `${elInfo.sy * scale}px`;

    if (elInfo.page !== lastActivePage) {
      lastActivePage = elInfo.page;
      page.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

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
    const scale = img.clientWidth / img.naturalWidth;
    if (!scale) return;

    const px = e.offsetX / scale;
    const py = e.offsetY / scale;
    const el = findElementAtPoint(pageIndex, px, py);
    if (!el) return;

    const ms = eventPositionByElId.get(el.id);
    if (ms === undefined) return;

    ensureAudioCtx();
    seekTo(ms / 1000);
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
    seekTo(frac * duration);
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

  els.viewModeBtn.addEventListener('click', () => {
    layoutMode = layoutMode === 'centered' ? 'book' : 'centered';
    els.viewModeBtn.textContent = layoutMode === 'centered' ? 'Book view' : 'Centered view';
    applyLayout();
  });

  window.addEventListener('resize', updateCursor);

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
