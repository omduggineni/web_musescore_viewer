(() => {
  'use strict';

  const els = {
    picker: document.getElementById('scorePicker'),
    title: document.getElementById('scoreTitle'),
    composer: document.getElementById('scoreComposer'),
    pages: document.getElementById('pages'),
    channels: document.getElementById('channels'),
    playBtn: document.getElementById('playBtn'),
    seek: document.getElementById('seek'),
    timeLabel: document.getElementById('timeLabel'),
    midiLink: document.getElementById('midiLink'),
  };

  const SEEK_RESOLUTION = 1000;

  /** @type {AudioContext|null} */
  let audioCtx = null;
  let masterGain = null;

  let currentScore = null;   // meta.json contents
  let positions = null;      // positions.json contents
  let elementsById = null;   // Map<id, element>
  let pageEls = [];          // [{el, img, cursorEl}]

  /** @type {Map<string, {buffer:AudioBuffer, gain:GainNode, panner:StereoPannerNode,
   *   volume:number, pan:number, muted:boolean, solo:boolean, source:AudioBufferSourceNode|null}>} */
  let tracks = new Map();

  let playing = false;
  let startCtxTime = 0;      // audioCtx.currentTime when playback last (re)started
  let startOffset = 0;       // playback position (seconds) at that moment
  let duration = 0;          // seconds
  let rafHandle = null;
  let seekDragging = false;

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function getCurrentTime() {
    if (!playing) return startOffset;
    return startOffset + (audioCtx.currentTime - startCtxTime);
  }

  function isAudible(t) {
    const anySolo = Array.from(tracks.values()).some(x => x.solo);
    if (anySolo) return t.solo;
    return !t.muted;
  }

  function applyGain(id, t) {
    t.gain.gain.value = isAudible(t) ? t.volume : 0;
  }

  // ---------- Loading a score ----------

  async function loadIndex() {
    const res = await fetch('scores/index.json');
    const list = await res.json();
    els.picker.innerHTML = '';
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      els.picker.appendChild(opt);
    }
    return list;
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
    const [meta, pos] = await Promise.all([
      fetch(base + 'meta.json').then(r => r.json()),
      fetch(base + 'positions.json').then(r => r.json()),
    ]);
    currentScore = meta;
    positions = pos;
    elementsById = new Map(positions.elements.map(e => [e.id, e]));
    duration = meta.duration || 0;

    els.title.textContent = meta.title;
    els.composer.textContent = meta.composer || '';
    els.picker.value = id;
    els.midiLink.href = base + 'score.mid';
    els.midiLink.download = `${meta.title}.mid`;

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

      const cursorEl = document.createElement('div');
      cursorEl.className = 'cursor-hl';

      pageDiv.appendChild(img);
      pageDiv.appendChild(cursorEl);
      els.pages.appendChild(pageDiv);
      pageEls.push({ el: pageDiv, img, cursorEl });
    }
  }

  function renderMixer(trackMetas) {
    for (const tm of trackMetas) {
      const state = {
        buffer: null, gain: null, panner: null,
        volume: 0.85, pan: 0, muted: false, solo: false, source: null,
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
        if (state.gain) applyGain(tm.id, state);
      });
      panInput.addEventListener('input', () => {
        state.pan = parseFloat(panInput.value);
        if (state.panner) state.panner.pan.value = state.pan;
      });
      muteBtn.addEventListener('click', () => {
        state.muted = !state.muted;
        muteBtn.classList.toggle('active-mute', state.muted);
        refreshAllGains();
      });
      soloBtn.addEventListener('click', () => {
        state.solo = !state.solo;
        soloBtn.classList.toggle('active-solo', state.solo);
        refreshAllGains();
      });
    }
  }

  function refreshAllGains() {
    for (const [id, t] of tracks) {
      if (t.gain) applyGain(id, t);
    }
  }

  async function loadAudioTracks(base, trackMetas) {
    ensureAudioCtx();
    await Promise.all(trackMetas.map(async tm => {
      const res = await fetch(base + tm.file);
      const arr = await res.arrayBuffer();
      const buffer = await audioCtx.decodeAudioData(arr);
      const t = tracks.get(tm.id);
      t.buffer = buffer;
      duration = Math.max(duration, buffer.duration);

      const panner = audioCtx.createStereoPanner();
      panner.pan.value = t.pan;
      const gain = audioCtx.createGain();
      gain.gain.value = 0; // engaged in startPlayback/applyGain
      panner.connect(gain);
      gain.connect(masterGain);

      t.panner = panner;
      t.gain = gain;
      applyGain(tm.id, t);
    }));
  }

  // ---------- Playback ----------

  function ensureAudioCtx() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioCtx.destination);
  }

  function startSourcesAt(offsetSeconds) {
    for (const t of tracks.values()) {
      if (!t.buffer) continue;
      const source = audioCtx.createBufferSource();
      source.buffer = t.buffer;
      source.connect(t.panner);
      const within = Math.min(Math.max(offsetSeconds, 0), t.buffer.duration);
      source.start(0, within);
      t.source = source;
    }
  }

  function stopSources() {
    for (const t of tracks.values()) {
      if (t.source) {
        try { t.source.stop(); } catch (e) { /* already stopped */ }
        t.source.disconnect();
        t.source = null;
      }
    }
  }

  function startPlayback() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (startOffset >= duration) startOffset = 0;
    startSourcesAt(startOffset);
    startCtxTime = audioCtx.currentTime;
    playing = true;
    els.playBtn.textContent = 'Pause';
    tickLoop();
  }

  function stopPlayback() {
    if (playing) {
      startOffset = getCurrentTime();
      stopSources();
      playing = false;
    }
    els.playBtn.textContent = 'Play';
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function seekTo(seconds) {
    const wasPlaying = playing;
    if (playing) stopSources();
    startOffset = Math.min(Math.max(seconds, 0), duration);
    startCtxTime = audioCtx.currentTime;
    if (wasPlaying) {
      startSourcesAt(startOffset);
      playing = true;
    }
    updateTimeUI();
    updateCursor();
  }

  function tickLoop() {
    if (!playing) return;
    const t = getCurrentTime();
    if (t >= duration) {
      stopPlayback();
      startOffset = duration;
      updateTimeUI();
      updateCursor();
      return;
    }
    updateTimeUI();
    updateCursor();
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

  els.picker.addEventListener('change', () => {
    loadScore(els.picker.value);
  });

  window.addEventListener('resize', updateCursor);

  (async function init() {
    const list = await loadIndex();
    if (list.length === 0) return;
    const requested = scoreIdFromUrl();
    const id = list.some(s => s.id === requested) ? requested : list[0].id;
    await loadScore(id);
  })();
})();
