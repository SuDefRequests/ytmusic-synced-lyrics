'use strict';

/* ------------------------------------------------------------------ *
 * Synced Lyrics — injects directly into YouTube Music's own Lyrics tab.
 * No floating panel: the original plain text is replaced in place by a
 * line-by-line synced view that keeps the native look and scroll.
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  enabled: true,
  autoApply: true,
  source: 'auto',
  fontSize: 18,
  accent: '#ff5c8a',
  showSource: true,
  dynamicColor: true
};

const state = {
  settings: { ...DEFAULTS },
  videoId: null,
  meta: null,
  lines: [],
  wordsEnabled: false,
  source: '',
  errors: [],
  video: null,
  host: null,          // { wrapper, desc, scroller }
  hidden: [],          // native nodes we hid, with their original display
  nativeEl: null,
  lineEls: [],
  gapEls: [],
  active: -1,
  lastWordKey: '',
  follow: true,        // false once the user scrolls away manually
  followUntil: 0,      // auto-follow resumes after this timestamp
  pill: null,
  dynamicAccent: null,
  lastArtwork: null,
  scrollHandlers: null,
  scrollOp: 0,
  programmaticScroll: false,
  fetching: false,
  applied: false
};

let watchdog = null;
let rafId = null;
let lastFrame = 0;
let observer = null;
let observedSidePanel = null;
let observerTimer = null;
let navSeq = 0;

/* ---------------------------------------------------------------- bootstrap */

(async function init() {
  document.documentElement.dataset.sly = 'init';
  state.settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  // migrate from the old floating-panel version (font size used to be 20–46)
  state.settings.fontSize = Math.min(24, Math.max(12, Number(state.settings.fontSize) || 14));
  bindGlobal();
  observeSidePanel();

  await handleNavigation();

  watchdog = setInterval(async () => {
    observeSidePanel();
    const id = readVideoId();
    if (id && id !== state.videoId) await handleNavigation();
    const v = findVideo();
    if (v && v !== state.video) state.video = v;

    // The lyrics shelf is re-created when tabs are switched.
    if (state.lines.length && state.settings.enabled && state.settings.autoApply) {
      if (!state.nativeEl || !state.nativeEl.isConnected) applyLyrics();
    }
  }, 800);

  rafId = requestAnimationFrame(tick);
})();

/* -------------------------------------------------------------- page reading */

function readVideoId() {
  const m = location.href.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

function readMetaFromDom() {
  let title = '';
  let artist = '';
  let album = '';
  let artwork = '';

  // Most reliable source: the mini player bar (works in the isolated world).
  const bar = deepQuery('ytmusic-player-bar');
  if (bar) {
    const bt = deepQuery('yt-formatted-string.title', bar);
    const bs = deepQuery('.subtitle', bar);
    if (bt) title = (bt.textContent || '').trim();
    if (bs) {
      const parts = (bs.textContent || '').split('•').map(s => s.trim()).filter(Boolean);
      if (!artist && parts[0]) artist = parts[0];
      if (!album && parts[1]) album = parts[1];
    }
  }

  try {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    if (md) {
      if (!title && md.title) title = md.title;
      if (!artist && md.artist) artist = md.artist;
      if (!album && md.album) album = md.album;
      const art = md.artwork && md.artwork[0];
      if (!artwork && art && art.src) artwork = art.src;
    }
  } catch (_) { /* isolated world */ }

  if (!title) {
    // document.title is "Song - Artist | YouTube Music" or "Song | YouTube Music"
    const doc = document.title
      .replace(/\s*[|｜-]\s*YouTube\s*Music\s*$/i, '')
      .trim();
    const parts = doc.split(/\s+[-–—|｜]\s+/);
    title = parts[0] || doc;
    if (!artist && parts[1]) artist = parts[1];
  }
  if (!artwork) {
    const og = document.querySelector('meta[property="og:image"]');
    artwork = og ? og.content : '';
  }
  return { title, artist, album, artwork };
}

function findVideo() {
  return deepQuery('video');
}

function deepQuery(selector, root = document) {
  try {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const r = deepQuery(selector, el.shadowRoot);
        if (r) return r;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

function deepQueryAll(selector, root = document, out = []) {
  try {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
  } catch (_) { /* ignore */ }
  return out;
}

/* mediaSession and ytcfg live in the page's JS world. The background worker
 * injects a MAIN-world script through chrome.scripting (CSP-safe), since an
 * inline <script> would be blocked by YouTube Music's CSP. */
function readPageData() {
  return sendToBackground({ type: 'GET_PAGE_DATA' }).then(
    data => data || { cfg: null, media: null, title: '' }
  );
}

/* --------------------------------------------------------------- navigation */

function mergeMeta(target, src, overwrite = false) {
  if (!src) return;
  if (src.title && (overwrite || !target.title || /^youtube\s*music$/i.test(target.title))) target.title = src.title;
  if (src.artist && (overwrite || !target.artist)) target.artist = src.artist;
  if (src.album && (overwrite || !target.album)) target.album = src.album;
  if (src.artwork && (overwrite || !target.artwork)) target.artwork = src.artwork;
}

async function readCombinedMeta() {
  const [domMeta, page] = await Promise.all([readMetaFromDom(), readPageData()]);
  const meta = { ...domMeta };
  // Prefer the live player bar; use main-world mediaSession to fill gaps
  // (or when DOM only has "YouTube Music").
  if (page.media && page.media.title) {
    mergeMeta(meta, page.media, false);
  } else if (page.title) {
    const cleaned = page.title.replace(/\s*[|｜-]\s*YouTube\s*Music\s*$/i, '').trim();
    if (cleaned && cleaned !== 'YouTube Music') {
      const parts = cleaned.split(/\s+[-–—|｜]\s+/);
      if (!meta.title || /^youtube\s*music$/i.test(meta.title)) meta.title = parts[0];
      if (!meta.artist && parts[1]) meta.artist = parts[1];
    }
  }
  return { meta, page };
}

function isStaleOrEmptyMeta(meta, prevVideoId, id, prevMeta) {
  if (!meta.title || /^youtube\s*music$/i.test(meta.title)) return true;
  if (prevVideoId && prevVideoId !== id && prevMeta && prevMeta.title) {
    return meta.title === prevMeta.title && (meta.artist || '') === (prevMeta.artist || '');
  }
  return false;
}

async function handleNavigation() {
  const id = readVideoId();
  if (!id) return;
  const token = ++navSeq;
  const prevVideoId = state.videoId;
  const prevMeta = state.meta;
  state.videoId = id;
  state.fetching = true;
  state.lines = [];
  state.wordsEnabled = false;
  state.source = '';
  state.errors = [];
  state.meta = null;
  state.dynamicAccent = null;
  state.dynamicTint = null;
  state.lastArtwork = null;
  mountLoading();

  let { meta, page } = await readCombinedMeta();
  if (token !== navSeq || state.videoId !== id) return;

  // On cold load or track switch, the player bar / mediaSession can lag behind
  // the URL change and still hold the previous track's metadata.
  for (let i = 0; i < 4 && isStaleOrEmptyMeta(meta, prevVideoId, id, prevMeta); i++) {
    await sleep(350);
    if (token !== navSeq || state.videoId !== id) return;
    ({ meta, page } = await readCombinedMeta());
    if (token !== navSeq || state.videoId !== id) return;
  }

  state.meta = meta;
  document.documentElement.dataset.sly = 'meta:' + (meta.title || 'none');
  state.video = findVideo();
  const duration = state.video && Number.isFinite(state.video.duration) ? state.video.duration : 0;

  const response = await sendToBackground({
    type: 'GET_LYRICS',
    videoId: id,
    ...meta,
    duration,
    ytcfg: page.cfg,
    source: state.settings.source
  });
  if (token !== navSeq || state.videoId !== id) return;

  state.fetching = false;
  state.errors = (response && response.errors) || [];
  document.documentElement.dataset.sly = 'meta:' + (meta.title || 'none')
    + ' lines:' + ((response && response.lines && response.lines.length) || 0)
    + ' err:' + (state.errors.join(' | ') || 'none').slice(0, 180);

  if (!response || !response.ok || !response.lines || !response.lines.length) {
    state.lines = [];
    state.source = '';
    restoreNative();
    return;
  }

  state.lines = dedupeLines(response.lines);
  state.source = response.sourceLabel || '';
  state.wordsEnabled = state.lines.some(l => l.words && l.words.length);
  applyLyrics();
  maybeColorize(meta.artwork);
}

function dedupeLines(lines) {
  const seen = new Set();
  return lines
    .filter(l => l && typeof l.text === 'string' && Number.isFinite(l.time))
    .sort((a, b) => a.time - b.time)
    .filter(l => {
      const k = l.time.toFixed(2) + '|' + l.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/* ------------------------------------------------------- native panel mount */

function findLyricHost() {
  const side = deepQuery('#side-panel');
  if (!side) return null;

  const selected = deepQueryAll('tp-yt-paper-tab.iron-selected', side)
    .some(el => /lyrics/i.test(el.textContent || ''));
  if (!selected) return null;

  const scroller = deepQuery('ytmusic-tab-renderer#tab-renderer', side) || deepQuery('#tab-renderer', side);
  if (!scroller) return null;

  const shelves = deepQueryAll('ytmusic-description-shelf-renderer', scroller);
  for (const shelf of shelves) {
    const wrapper = deepQuery('.wrapper', shelf);
    const desc = wrapper && deepQuery('yt-formatted-string.description', wrapper);
    if (wrapper && desc && (desc.textContent || '').trim().length > 20) {
      return { wrapper, desc, scroller };
    }
  }
  return null;
}

function restoreNative() {
  if (state.nativeEl) state.nativeEl.remove();
  if (state.pill) { state.pill.remove(); state.pill = null; }
  if (state.host && state.host.scroller) {
    state.host.scroller.classList.remove('ytm-pro-lyrics-scroller');
  }
  window.removeEventListener('resize', positionPill);
  unbindScrollAway();
  for (const item of state.hidden) item.el.style.display = item.prev;
  state.hidden = [];
  state.nativeEl = null;
  state.host = null;
  state.lineEls = [];
  state.gapEls = [];
  state.active = -1;
  state.lastWordKey = '';
  state.follow = true;
  state.followUntil = 0;
  state.applied = false;
}

/* Shared mount point for the loading skeleton and the real lyric view. */
function mountRoot(inner) {
  restoreNative();
  if (!state.settings.enabled || !state.settings.autoApply) return null;

  const host = findLyricHost();
  if (!host) return null; // watchdog retries when the Lyrics tab renders

  // Hide both plain-lyric copies and the LyricFind footer.
  const natives = [
    ...deepQueryAll('yt-formatted-string.description', host.wrapper),
    ...deepQueryAll('yt-formatted-string.footer', host.wrapper)
  ];
  for (const el of natives) {
    state.hidden.push({ el, prev: el.style.display || '' });
    el.style.display = 'none';
  }

  const root = document.createElement('div');
  root.id = 'sly-native';
  root.className = 'ytm-pro-lyrics';
  root.innerHTML = inner;
  host.wrapper.insertBefore(root, host.wrapper.firstChild);
  host.scroller.classList.add('ytm-pro-lyrics-scroller');

  state.host = host;
  state.nativeEl = root;
  return root;
}

function mountLoading() {
  const bars = Array.from({ length: 8 }, (_, i) =>
    `<span style="width:${45 + (i % 4) * 11}%"></span>`).join('');
  mountRoot(`<div class="ytm-pro-lyrics-skeleton">${bars}</div>`);
}

function applyLyrics() {
  const root = mountRoot('<div class="ytm-pro-lyrics-source"></div><div class="ytm-pro-lyrics-lines"></div>');
  if (!root || !state.lines.length) return;

  state.applied = true;
  state.follow = true;
  state.followUntil = 0;
  document.documentElement.dataset.sly = 'applied';

  state.pill = createPill();
  bindScrollAway(state.host.scroller);
  window.addEventListener('resize', positionPill);

  const src = root.querySelector('.ytm-pro-lyrics-source');
  src.textContent = state.settings.showSource
    ? `Synced by ${state.source}${state.wordsEnabled ? ' · karaoke' : ''}`
    : '';
  src.style.display = state.settings.showSource ? '' : 'none';

  root.addEventListener('click', (e) => {
    const line = e.target.closest('.ytm-pro-lyrics-line');
    if (!line || !state.video) return;
    const l = state.lines[Number(line.dataset.i)];
    if (!l) return;
    state.video.currentTime = Math.max(0, l.time - 0.05);
    if (state.video.paused) state.video.play().catch(() => {});
  });

  renderLines();
  applyAppearance();
  if (state.settings.dynamicColor && !state.dynamicAccent && state.meta && state.meta.artwork) {
    maybeColorize(state.meta.artwork);
  }
}

function applyAppearance() {
  if (!state.nativeEl) return;
  state.nativeEl.style.setProperty('--sly-font', state.settings.fontSize + 'px');
  if (state.settings.dynamicColor && state.dynamicAccent) {
    state.nativeEl.style.setProperty('--sly-accent', state.dynamicAccent);
    state.nativeEl.style.setProperty('--sly-tint', state.dynamicTint);
  } else {
    state.nativeEl.style.setProperty('--sly-accent', state.settings.accent);
    state.nativeEl.style.setProperty('--sly-tint', 'rgba(255, 92, 138, .1)');
  }
}

/* Pull a muted version of the cover art into the panel, like Spotify does.
 * The artwork is fetched by the background worker as a data URL, so the
 * canvas readback is same-origin and never tainted. */
async function maybeColorize(artwork) {
  if (!state.settings.dynamicColor || !artwork || !state.nativeEl) return;
  if (state.lastArtwork === artwork) return;
  state.lastArtwork = artwork;
  try {
    const res = await sendToBackground({ type: 'GET_IMAGE_DATA_URL', url: artwork });
    if (state.lastArtwork !== artwork || !state.nativeEl) return;
    if (!res || !res.dataUrl) return;
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    if (state.lastArtwork !== artwork || !state.nativeEl) return;
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) < 16) continue;
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
      buckets.set(key, cur);
    }
    let best = null;
    for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
    if (!best) return;
    const r = Math.round(best.r / best.n);
    const g = Math.round(best.g / best.n);
    const b = Math.round(best.b / best.n);
    state.dynamicAccent = `rgb(${r} ${g} ${b})`;
    state.dynamicTint = `rgba(${Math.round(r * .3)} ${Math.round(g * .3)} ${Math.round(b * .3)} / .12)`;
    applyAppearance();
  } catch (_) { /* color is cosmetic */ }
}

/* ------------------------------------------------------------------ renderer */

function formatStamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function renderLines() {
  if (!state.nativeEl) return;
  const container = state.nativeEl.querySelector('.ytm-pro-lyrics-lines');
  container.innerHTML = '';
  state.lineEls = [];
  state.gapEls = [];
  state.active = -1;
  state.lastWordKey = '';

  const frag = document.createDocumentFragment();
  state.lines.forEach((line, i) => {
    // Instrumental / interlude gap: a minimal pulsing three-dot marker.
    const prev = state.lines[i - 1];
    if (prev && line.time - prev.time > 6) {
      const gap = document.createElement('div');
      gap.className = 'ytm-pro-lyrics-gap';
      gap.setAttribute('aria-hidden', 'true');
      gap.dataset.time = String(line.time);
      gap.innerHTML = '<span>•</span><span>•</span><span>•</span>';
      state.gapEls.push(gap);
      frag.appendChild(gap);
    }

    const el = document.createElement('div');
    el.className = 'ytm-pro-lyrics-line';
    el.dataset.i = String(i);
    el.dataset.stamp = formatStamp(line.time);

    if (line.words && line.words.length) {
      const text = document.createElement('span');
      text.className = 'ytm-pro-lyrics-text';
      line.words.forEach((w, wi) => {
        const span = document.createElement('span');
        span.className = 'ytm-pro-lyrics-word'
          + (wi > 0 || /^\s/.test(w.text) ? ' is-space-before' : '');
        span.dataset.w = String(wi);
        span.dataset.t = String(w.time);
        span.textContent = w.text.trim();
        text.appendChild(span);
      });
      el.appendChild(text);
    } else {
      const text = document.createElement('span');
      text.className = 'ytm-pro-lyrics-text';
      text.textContent = line.text;
      el.appendChild(text);
    }
    state.lineEls.push(el);
    frag.appendChild(el);
  });
  container.appendChild(frag);

  requestAnimationFrame(() => {
    paint(state.video ? state.video.currentTime : 0, true);
  });
}

function paint(t, force = false) {
  if (!state.lineEls.length) return;
  const n = state.lines.length;
  let idx = 0;
  while (idx + 1 < n && state.lines[idx + 1].time <= t + 0.08) idx++;

  if (idx !== state.active || force) {
    for (let i = 0; i < n; i++) {
      const el = state.lineEls[i];
      el.classList.toggle('is-active', i === idx);
      el.classList.toggle('is-past', i < idx);
      el.classList.toggle('is-near', Math.abs(i - idx) === 1);
    }
    state.active = idx;
    state.lastWordKey = '';
    updateScroll();
  }

  const line = state.lines[idx];
  if (line && line.words && line.words.length) {
    const el = state.lineEls[idx];
    const wt = t + 0.02;
    let wi = -1;
    for (let i = 0; i < line.words.length; i++) {
      if (wt >= line.words[i].time) wi = i; else break;
    }
    let prog = 0;
    if (wi >= 0) {
      const w = line.words[wi];
      const dur = Math.max(0.08, (w.end || w.time + 0.35) - w.time);
      prog = Math.min(1, Math.max(0, (wt - w.time) / dur));
    }
    const key = idx + ':' + wi + ':' + prog.toFixed(2);
    if (key !== state.lastWordKey) {
      const spans = el.querySelectorAll('.ytm-pro-lyrics-word');
      spans.forEach((s, i) => {
        const sung = i < wi || (i === wi && prog >= 0.98);
        const singing = i === wi && !sung;
        s.classList.toggle('is-sung', sung);
        s.classList.toggle('is-singing', singing);
        if (singing) s.style.setProperty('--w-prog', prog.toFixed(2));
        else s.style.removeProperty('--w-prog');
      });
      state.lastWordKey = key;
    }
  }

  for (const gap of state.gapEls) {
    gap.classList.toggle('is-past', t >= Number(gap.dataset.time));
  }
}

function scrollTarget(idx) {
  if (!state.host || !state.nativeEl || !state.lineEls[idx]) return null;
  const scroller = state.host.scroller;
  const el = state.lineEls[idx];
  const hostTop = state.nativeEl.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top + scroller.scrollTop;
  return Math.max(0, hostTop + el.offsetTop - scroller.clientHeight * 0.38);
}

async function scrollToActive(behavior = 'smooth') {
  const target = scrollTarget(state.active);
  if (target === null) return;
  const scroller = state.host.scroller;
  if (Math.abs(target - scroller.scrollTop) < 4) return;

  const op = ++state.scrollOp;
  state.programmaticScroll = true;
  let result;
  try { result = scroller.scrollTo({ top: target, behavior }); }
  catch (_) {
    scroller.scrollTop = target;
    if (op === state.scrollOp) state.programmaticScroll = false;
    return;
  }

  // Scroll-method promises are Chrome 150+; degrade gracefully elsewhere.
  if (result instanceof Promise) {
    await result;
  } else {
    await new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        scroller.removeEventListener('scrollend', done);
        scroller.removeEventListener('scroll', onScroll);
        resolve();
      };
      const onScroll = () => { clearTimeout(timer); timer = setTimeout(done, 100); };
      scroller.addEventListener('scrollend', done, { once: true });
      scroller.addEventListener('scroll', onScroll, { passive: true });
      timer = setTimeout(done, 100);
    });
  }
  if (op === state.scrollOp) state.programmaticScroll = false;
}

function updateScroll() {
  if (!state.follow) return;
  scrollToActive('smooth');
}

function elIsActiveVisible() {
  if (!state.host || !state.lineEls[state.active]) return false;
  const sc = state.host.scroller;
  const a = state.lineEls[state.active].getBoundingClientRect();
  const s = sc.getBoundingClientRect();
  const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 28;
  if (atBottom && state.active === state.lines.length - 1) return true; // song's last line
  return a.top >= s.top - 4 && a.bottom <= s.bottom + 4;
}

/* ------------------------------------------------------------- sync pill */

function createPill() {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ytm-pro-lyrics-sync';
  pill.setAttribute('aria-label', 'Jump to the line currently playing');
  pill.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="9" width="2.4" height="6" rx="1.2"/>
    <rect x="9" y="5" width="2.4" height="14" rx="1.2"/>
    <rect x="14" y="8" width="2.4" height="8" rx="1.2"/>
    <rect x="19" y="6" width="2.4" height="12" rx="1.2"/>
  </svg><span>Sync</span>`;
  pill.addEventListener('click', async () => {
    pill.classList.remove('is-pulsing');
    void pill.offsetWidth;
    pill.classList.add('is-pulsing');
    state.follow = true;
    hidePill();
    await scrollToActive('smooth');
  });
  pill.addEventListener('animationend', () => pill.classList.remove('is-pulsing'));
  document.body.appendChild(pill);
  positionPill();
  return pill;
}

function positionPill() {
  if (!state.pill || !state.host) return;
  const r = state.host.scroller.getBoundingClientRect();
  state.pill.style.left = 'auto';
  state.pill.style.right = Math.max(8, window.innerWidth - r.right + 22) + 'px';
  state.pill.style.top = Math.round(r.bottom - 72) + 'px';
}

function showPill() {
  if (!state.pill) return;
  positionPill();
  state.pill.classList.add('is-visible');
}

function hidePill() {
  if (state.pill) state.pill.classList.remove('is-visible');
}

function bindScrollAway(scroller) {
  const onUserScroll = () => {
    state.follow = false;
    state.followUntil = Date.now() + 4000;
    showPill();
  };
  const onPointer = (e) => {
    const r = scroller.getBoundingClientRect();
    if (e.clientX > r.right - 14) onUserScroll(); // scrollbar drag
  };
  const onKey = (e) => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) onUserScroll();
  };
  const fns = {
    wheel: onUserScroll,
    touchstart: onUserScroll,
    pointerdown: onPointer,
    keydown: onKey
  };
  for (const [name, fn] of Object.entries(fns)) {
    scroller.addEventListener(name, fn, { passive: true });
  }
  state.scrollHandlers = { scroller, fns };
}

function unbindScrollAway() {
  if (!state.scrollHandlers) return;
  const { scroller, fns } = state.scrollHandlers;
  for (const [name, fn] of Object.entries(fns)) scroller.removeEventListener(name, fn);
  state.scrollHandlers = null;
}

function tick(ts) {
  rafId = requestAnimationFrame(tick);
  if (ts - lastFrame < 16) return;
  lastFrame = ts;
  if (!state.applied || !state.lines.length) return;
  const v = state.video;
  if (v && (v.ended || (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.25))) {
    if (!state.follow) { state.follow = true; state.followUntil = 0; hidePill(); }
  }
  if (!state.follow && Date.now() >= state.followUntil) {
    state.follow = true;
    hidePill();
    updateScroll();
  }
  paint(v ? v.currentTime : 0);
}

/* ------------------------------------------------------------ misc bindings */

function observeSidePanel() {
  const side = deepQuery('#side-panel');
  if (!side) return;
  if (observer && observedSidePanel === side && side.isConnected) return;
  if (observer) observer.disconnect();
  observedSidePanel = side;
  observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      if (!state.lines.length || !state.settings.enabled || !state.settings.autoApply) return;
      if (!state.nativeEl || !state.nativeEl.isConnected) applyLyrics();
    }, 180);
  });
  observer.observe(side, { childList: true, subtree: true });
}

function bindGlobal() {
  document.addEventListener('yt-navigate-finish', () => {
    const id = readVideoId();
    if (id && (id !== state.videoId || (!state.fetching && !state.lines.length))) {
      restoreNative();
      handleNavigation();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleEnabled();
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync') return;
    state.settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
    applyAppearance();
    if (changes.dynamicColor) {
      if (state.settings.dynamicColor) maybeColorize(state.meta && state.meta.artwork);
      else { state.dynamicAccent = null; applyAppearance(); }
    }
    if (changes.enabled || changes.autoApply || changes.showSource) {
      state.settings.enabled && state.settings.autoApply ? applyLyrics() : restoreNative();
    }
    if (changes.source && state.videoId) {
      handleNavigation();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'GET_STATE') {
      reply({
        enabled: state.settings.enabled,
        applied: state.applied,
        source: state.source,
        lines: state.lines.length,
        words: state.wordsEnabled,
        track: state.meta && state.meta.title ? state.meta.title : '',
        artist: state.meta && state.meta.artist ? state.meta.artist : '',
        errors: state.errors || [],
        fetching: state.fetching
      });
    } else if (msg.type === 'SET_ENABLED') {
      state.settings.enabled = !!msg.value;
      chrome.storage.sync.set({ enabled: state.settings.enabled });
      state.settings.enabled && state.settings.autoApply ? applyLyrics() : restoreNative();
      reply({ ok: true });
    } else if (msg.type === 'TOGGLE') {
      toggleEnabled();
      reply({ ok: true });
    }
  });
}

function toggleEnabled() {
  state.settings.enabled = !state.settings.enabled;
  chrome.storage.sync.set({ enabled: state.settings.enabled });
  state.settings.enabled && state.settings.autoApply ? applyLyrics() : restoreNative();
}

function sendToBackground(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, res => {
        void chrome.runtime.lastError;
        resolve(res || {});
      });
    } catch (_) { resolve({}); }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
