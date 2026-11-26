'use strict';

const DEFAULTS = {
  enabled: true,
  autoApply: true,
  source: 'auto',
  showSource: true
};

const $ = (id) => document.getElementById(id);

(async function init() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  $('enabled').checked = cfg.enabled;
  $('autoApply').checked = cfg.autoApply;
  $('showSource').checked = cfg.showSource;
  setSource(cfg.source);

  ['enabled', 'autoApply', 'showSource'].forEach(key => {
    $(key).addEventListener('change', e => save({ [key]: e.target.checked }));
  });

  $('source').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    setSource(btn.dataset.value);
    save({ source: btn.dataset.value });
  });

  await refreshStatus();
})();

function setSource(value) {
  document.querySelectorAll('#source button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === value);
  });
}

async function save(obj) { await chrome.storage.sync.set(obj); }

function send(msg) {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id || !/music\.youtube\.com/.test(tab.url || '')) return resolve({});
      chrome.tabs.sendMessage(tab.id, msg, res => resolve(res || {}));
    });
  });
}

async function refreshStatus() {
  const dot = $('status-dot');
  const text = $('status-text');
  const info = await send({ type: 'GET_STATE' });

  if (!info || (!info.track && !info.lines)) {
    dot.className = 'status-dot bad';
    text.textContent = 'Open YouTube Music and play a song';
    return;
  }

  if (info.fetching) {
    dot.className = 'status-dot';
    text.textContent = 'Loading lyrics…';
  } else if (info.lines > 0 && info.applied) {
    dot.className = 'status-dot ok';
    text.textContent = `${info.source} · ${info.lines} lines · active`;
  } else if (info.lines > 0) {
    dot.className = 'status-dot';
    text.textContent = `${info.source} · ${info.lines} lines · toggle on`;
  } else {
    dot.className = 'status-dot bad';
    text.textContent = 'No synced lyrics found for this track';
  }
  text.title = (info.errors || []).join(' | ');

  if (info.track) {
    $('track').hidden = false;
    $('track-title').textContent = info.track;
    $('track-artist').textContent = info.artist || '';
  }
}
