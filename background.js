'use strict';

/* ------------------------------------------------------------------ *
 * background.js  — all network I/O lives here so CORS is a non-issue.
 * Sources, in order of preference:
 *   1. YouTube Music's own (undocumented) timed-lyrics endpoint
 *   2. LRCLIB — free, no key, real synced .lrc data
 * ------------------------------------------------------------------ */

const LRCLIB = 'https://lrclib.net/api';
const YT_ORIGIN = 'https://music.youtube.com';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_PAGE_DATA': {
          const tabId = sender.tab && sender.tab.id;
          if (!tabId) throw new Error('no sender tab');
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              const cfg = {};
              let media = null;
              try {
                const y = window.ytcfg;
                if (y && y.get) {
                  cfg.INNERTUBE_API_KEY = y.get('INNERTUBE_API_KEY');
                  cfg.INNERTUBE_CLIENT_VERSION = y.get('INNERTUBE_CLIENT_VERSION');
                  cfg.VISITOR_DATA = y.get('VISITOR_DATA');
                  cfg.HL = y.get('HL');
                  cfg.GL = y.get('GL');
                }
                const md = navigator.mediaSession && navigator.mediaSession.metadata;
                if (md) {
                  media = {
                    title: md.title || '',
                    artist: md.artist || '',
                    album: md.album || '',
                    artwork: (md.artwork && md.artwork[0] && md.artwork[0].src) || ''
                  };
                }
              } catch (e) { /* partial data is fine */ }
              return { cfg, media, title: document.title || '' };
            }
          });
          sendResponse((results && results[0] && results[0].result) || null);
          break;
        }
        case 'GET_LYRICS':
          sendResponse(await getLyrics(msg));
          break;
        case 'GET_IMAGE_DATA_URL':
          sendResponse({ dataUrl: await toDataUrl(msg.url) });
          break;
        case 'PING':
          sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
          break;
        default:
          sendResponse({ error: 'Unknown message: ' + msg.type });
      }
    } catch (err) {
      sendResponse({ error: (err && err.message) || String(err) });
    }
  })();
  return true; // channel stays open for the async reply
});

/* ---------------------------------------------------------------- dispatcher */

async function getLyrics(req) {
  const preference = req.source || 'auto';
  // YouTube's web client does not currently serve timed lyrics (the Lyrics
  // tab is a plain LyricFind blob), so LRCLIB is the primary source.
  const order = preference === 'youtube'
    ? ['youtube', 'lrclib']
    : preference === 'lrclib'
      ? ['lrclib']
      : ['lrclib', 'youtube'];

  const errors = [];
  for (const source of order) {
    try {
      const result = source === 'youtube'
        ? await fromYouTube(req)
        : await fromLRCLIB(req);
      if (result && result.lines && result.lines.length) {
        return { ok: true, ...result };
      }
      errors.push(source + ': no synced lyrics');
    } catch (err) {
      errors.push(source + ': ' + ((err && err.message) || String(err)));
    }
  }
  return { ok: false, lines: [], errors };
}

/* ------------------------------------------------- YouTube Music internal API */

async function fromYouTube({ videoId, ytcfg }) {
  if (!videoId) throw new Error('no video id');
  if (!ytcfg || !ytcfg.INNERTUBE_API_KEY) throw new Error('no innertube key');

  const key = ytcfg.INNERTUBE_API_KEY;
  const version = ytcfg.INNERTUBE_CLIENT_VERSION || '2.20250310.01.00';
  const visitor = ytcfg.VISITOR_DATA || '';
  const hl = ytcfg.HL || 'en';
  const gl = ytcfg.GL || 'US';

  const context = {
    client: {
      clientName: 'WEB_MUSIC',
      clientVersion: version,
      hl,
      gl,
      ...(visitor ? { visitorData: visitor } : {})
    }
  };
  const baseHeaders = {
    'content-type': 'application/json',
    origin: YT_ORIGIN,
    'x-youtube-client-name': '67',
    'x-youtube-client-version': version,
    ...(visitor ? { 'x-goog-visitor-id': visitor } : {})
  };

  // `get_lyrics` is a 404 on the current web client; `next` is kept as a
  // forward-compatible probe in case timed data appears again.
  const endpoints = [
    { name: 'next', body: { context, videoId } }
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(
        `${YT_ORIGIN}/youtubei/v1/${ep.name}?key=${encodeURIComponent(key)}&prettyPrint=false`,
        {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(ep.body),
          credentials: 'include',
          signal: AbortSignal.timeout(10000)
        }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const lines = extractTimedLyrics(json);
      if (lines.length) {
        return {
          lines,
          source: 'youtube',
          sourceLabel: 'YouTube Music',
          endpoint: ep.name
        };
      }
    } catch (_) {
      /* try the next endpoint */
    }
  }
  return null;
}

/* Walks *any* Innertube response shape and collects objects that carry both a
 * timestamp and a string. Google renames these fields every few months, so a
 * generic walker is far more durable than hardcoding one schema. */
const TIME_KEYS = ['startMs', 'startTimeMs', 'startTime', 'startMsV2', 'timeMs', 'beginMs', 'start'];
const TEXT_KEYS = ['lyric', 'text', 'line', 'content', 'simpleText', 'lyricsLine', 'value'];

function extractTimedLyrics(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) extractTimedLyrics(child, out);
    return out;
  }

  const timeKey = TIME_KEYS.find(k => node[k] !== undefined && node[k] !== null);
  if (timeKey) {
    let text = '';
    for (const k of TEXT_KEYS) {
      const v = node[k];
      if (typeof v === 'string') { text = v; break; }
      if (v && Array.isArray(v.runs)) { text = v.runs.map(r => r.text || '').join(''); break; }
      if (v && typeof v === 'object') {
        const s = v.simpleText || v.text || v.content;
        if (typeof s === 'string') { text = s; break; }
      }
    }
    if (!text && node.lyricsData && typeof node.lyricsData === 'string') text = node.lyricsData;

    if (text && text.trim()) {
      let raw = Number(node[timeKey]);
      if (Number.isFinite(raw)) {
        // ms-valued keys are > 100 for any real lyric line; small values are seconds.
        const time = raw > 100 ? raw / 1000 : raw;
        const cleaned = cleanText(text);
        // Innertube `next` responses also carry timestamps for chapters/ads;
        // those aren't lyric lines, so keep only plausible lyric-sized strings.
        if (cleaned && cleaned.length <= 160 && time >= 0 && time <= 7200) {
          out.push({ time, text: cleaned, words: parseWordTimings(text) });
        }
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === timeKey) continue;
    extractTimedLyrics(node[key], out);
  }
  return out;
}

/* ------------------------------------------------------------------- LRCLIB */

async function fromLRCLIB({ title, artist, album, duration }) {
  const t = cleanTitle(title);
  const tNoFeat = stripFeatured(t);
  const a = cleanArtist(artist);
  if (!t && !a) return null;

  const titleVariants = tNoFeat && tNoFeat !== t ? [t, tNoFeat] : [t];
  let data = null;

  for (const trackName of titleVariants) {
    // Try the exact track first, then progressively drop fields that might
    // disagree with LRCLIB's metadata (album name / duration in particular).
    const base = {};
    if (trackName) base.track_name = trackName;
    if (a) base.artist_name = a;
    if (album) base.album_name = cleanTitle(album);
    if (Number.isFinite(duration) && duration > 1) base.duration = String(Math.round(duration));

    const attempts = [{ ...base }];
    if (base.album_name) { const x = { ...base }; delete x.album_name; attempts.push(x); }
    if (base.duration) { const x = { ...base }; delete x.duration; attempts.push(x); }
    if (base.album_name && base.duration) {
      const x = { ...base }; delete x.album_name; delete x.duration; attempts.push(x);
    }

    for (const params of attempts) {
      try {
        const res = await fetch(`${LRCLIB}/get?${new URLSearchParams(params).toString()}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (json && json.syncedLyrics) { data = json; break; }
      } catch (_) { /* next attempt */ }
    }
    if (data) break;

    const q = [a, trackName].filter(Boolean).join(' ');
    if (q) {
      try {
        const res = await fetch(`${LRCLIB}/search?query=${encodeURIComponent(q)}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const results = await res.json();
          if (Array.isArray(results) && results.length) {
            const ranked = results.slice().sort((x, y) => {
              const xs = x.syncedLyrics ? 0 : 1;
              const ys = y.syncedLyrics ? 0 : 1;
              if (xs !== ys) return xs - ys;
              if (Number.isFinite(duration) && duration > 1) {
                return Math.abs((x.duration || 0) - duration) - Math.abs((y.duration || 0) - duration);
              }
              return 0;
            });
            if (ranked[0] && ranked[0].syncedLyrics) { data = ranked[0]; break; }
          }
        }
      } catch (_) { /* ignore */ }
    }
  }

  if (!data || !data.syncedLyrics) return null;
  const lines = parseLRC(data.syncedLyrics);
  if (!lines.length) return null;
  return {
    lines,
    source: 'lrclib',
    sourceLabel: 'LRCLIB',
    trackName: data.trackName || t,
    artistName: data.artistName || a
  };
}

function parseLRC(lrc) {
  const out = [];
  const tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(lrc).split(/\r?\n/)) {
    const tags = [];
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(raw)) !== null) tags.push(m);
    if (!tags.length) continue;

    const stripped = raw.replace(tagRe, '');
    const text = cleanText(stripped);
    if (!text) continue;
    const explicitWords = parseWordTimings(stripped);

    for (const tag of tags) {
      const frac = tag[3] ? Number('0.' + tag[3]) : 0;
      const time = Number(tag[1]) * 60 + Number(tag[2]) + frac;
      if (Number.isFinite(time)) out.push({ time, text, words: explicitWords });
    }
  }
  out.sort((a, b) => a.time - b.time);
  const unique = dedupe(out);

  // Line-level LRC is the norm. Estimate per-word timings using the song's own
  // measured vocal pace (chars/sec) so ballads and fast rap both stay locked in.
  const cpsSamples = [];
  for (let i = 0; i < unique.length; i++) {
    const next = unique[i + 1];
    if (!next) continue;
    const span = next.time - unique[i].time;
    const chars = unique[i].text.replace(/\s+/g, '').length;
    if (span >= 1.0 && span <= 5.5 && chars >= 6) {
      cpsSamples.push(chars / (span * 0.88));
    }
  }
  cpsSamples.sort((a, b) => a - b);
  const rawCps = cpsSamples.length ? cpsSamples[Math.floor(cpsSamples.length / 2)] : 12;
  const songCps = Math.min(20, Math.max(7, rawCps));

  for (let i = 0; i < unique.length; i++) {
    const line = unique[i];
    const next = unique[i + 1];
    if (line.words && line.words.length) {
      for (let j = 0; j < line.words.length; j++) {
        const nw = line.words[j + 1];
        line.words[j].end = nw ? nw.time : (next ? Math.min(next.time, line.words[j].time + 0.8) : line.words[j].time + 0.8);
      }
      continue;
    }
    let span = next ? next.time - line.time : 4;
    if (!Number.isFinite(span) || span <= 0) span = 4;
    const tokens = line.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const weights = tokens.map(w => {
      const core = Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length);
      const pause = /[,;?!:—–-]$/.test(w) ? 2 : 0;
      return core + pause;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const naturalDur = Math.max(0.85, 0.18 + total / songCps);
    const activeSpan = span <= 5.2
      ? Math.min(span * 0.88, naturalDur * 1.45)
      : Math.min(span * 0.85, naturalDur);
    let cursor = line.time;
    line.words = tokens.map((tok, j) => {
      const dur = (weights[j] / total) * activeSpan;
      const word = { time: cursor, end: cursor + dur, text: tok, estimated: true };
      cursor += dur;
      return word;
    });
  }
  return unique;
}

function parseWordTimings(text) {
  const re = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;
  const tokens = [];
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const frac = m[3] ? Number('0.' + m[3]) : 0;
    tokens.push({ index: m.index, end: re.lastIndex, time: Number(m[1]) * 60 + Number(m[2]) + frac });
  }
  return tokens.map((tok, i) => ({
    time: tok.time,
    text: cleanText(String(text).slice(tok.end, tokens[i + 1] ? tokens[i + 1].index : String(text).length))
  })).filter(w => w.text);
}

function dedupe(lines) {
  const seen = new Set();
  return lines.filter(l => {
    const k = l.time.toFixed(2) + '|' + l.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cleanText(s) {
  return String(s || '')
    .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '')
    .replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s*[\[(]\s*(?:official\s*)?(?:music\s*)?(?:video|lyrics?|lyric\s*video|audio|hd|hq|4k|8k|visualizer|visualiser|mv|teaser|clip|full\s*album|explicit)[^\])]*\s*[\])]/gi, '')
    .replace(/\s*[|｜]\s*(?:youtube\s*music|yt\s*music)[^\n]*/gi, '')
    .replace(/\s*[-–—]\s*(?:youtube\s*music|yt\s*music)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFeatured(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s*[\[(]\s*(?:feat\.?|ft\.?|featuring|with)\b[^\])]*[\])]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+[^-–—|]+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtist(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s*[-–—|]\s*(?:topic|vevo|youtube\s*music|yt\s*music)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ artwork */

async function toDataUrl(url) {
  if (!url || !/^https?:/i.test(url)) throw new Error('bad image url');
  const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('image HTTP ' + res.status);
  const mime = ((res.headers.get('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg').trim();
  if (!mime.startsWith('image/')) throw new Error('not an image');
  const buf = await res.arrayBuffer();
  let bytes = '';
  const view = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    bytes += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bytes)}`;
}
