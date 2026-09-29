'use strict';

/**
 * ui.js — the shared toolkit: formatting, charts, dialogs, palette.
 *
 * No build step and no dependencies, so everything here is small and does one
 * job. Loaded before app.js; exposes a single `UI` global.
 *
 * Everything lives inside this IIFE on purpose. Classic scripts share one
 * top-level lexical scope, so a bare `const $` here collides with app.js's
 * `const { $ } = window.UI` — and a duplicate const declaration is a
 * SyntaxError that stops app.js parsing entirely, before a line of it runs.
 */
(function () {

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// --- formatting -------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Compact money for dense table cells: 12.4k, 1.2M. */
function compact(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
  if (abs >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toLocaleString('en-US', { maximumFractionDigits: abs < 10 ? 2 : 0 });
}

function money(n, cur) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    + (cur ? ' ' + String(cur).toUpperCase() : '');
}

/**
 * A {currency: amount} map as text. Currencies are never added together —
 * that is exactly the bug this replaces.
 */
function moneyMap(map, { compact: useCompact = false } = {}) {
  const rows = Object.entries(map || {}).filter(([, v]) => Math.abs(v) > 0.005);
  if (!rows.length) return '0';
  rows.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return rows
    .map(([c, v]) => `${useCompact ? compact(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.toUpperCase()}`)
    .join(' · ');
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- toast ------------------------------------------------------------------

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 4000);
}

// --- charts -----------------------------------------------------------------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Size a canvas for the display's pixel ratio so lines stay crisp. */
function fitCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * A sparkline with an area fill and an emphasised endpoint — the last value is
 * the one being asked about, so it gets a dot.
 */
function sparkline(canvas, values, { color = css('--good'), height = 26 } = {}) {
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 90;
  const h = height;
  const ctx = fitCanvas(canvas, w, h);
  ctx.clearRect(0, 0, w, h);

  const vals = (values || []).map((v) => Number(v) || 0);
  if (vals.length < 2) {
    ctx.fillStyle = css('--faint');
    ctx.font = '10px ' + css('--mono');
    ctx.fillText('—', 2, h / 2 + 3);
    return;
  }

  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const pad = 2;
  const x = (i) => (i / (vals.length - 1)) * (w - pad * 2) + pad;
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');

  ctx.beginPath();
  ctx.moveTo(x(0), y(vals[0]));
  for (let i = 1; i < vals.length; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.lineTo(x(vals.length - 1), h);
  ctx.lineTo(x(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x(0), y(vals[0]));
  for (let i = 1; i < vals.length; i++) ctx.lineTo(x(i), y(vals[i]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x(vals.length - 1), y(vals[vals.length - 1]), 2.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * The 30-day chart: volume as an area, a second series as a line, a faint
 * grid, and a crosshair that reads out the exact day under the cursor.
 */
function areaChart(canvas, rows, opts = {}) {
  const {
    height = 190,
    valueKey = 'volume',
    lineKey = null,
    color = css('--good'),
    lineColor = css('--crit'),
    tip = null,
    format = (v) => compact(v),
  } = opts;

  const w = canvas.clientWidth || 600;
  const h = height;
  const ctx = fitCanvas(canvas, w, h);
  ctx.clearRect(0, 0, w, h);

  if (!rows.length) {
    ctx.fillStyle = css('--faint');
    ctx.font = '12px ' + css('--sans');
    ctx.textAlign = 'center';
    ctx.fillText('No history yet — it builds from the next check.', w / 2, h / 2);
    return;
  }

  const padL = 46;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const vals = rows.map((r) => Number(r[valueKey]) || 0);
  const max = Math.max(...vals, 1);
  const x = (i) => padL + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;

  // grid + y labels
  ctx.strokeStyle = css('--line-soft');
  ctx.lineWidth = 1;
  ctx.fillStyle = css('--faint');
  ctx.font = '10px ' + css('--mono');
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(compact(v), padL - 8, yy + 3);
  }

  // x labels: first, middle, last
  ctx.textAlign = 'center';
  for (const i of [0, Math.floor(rows.length / 2), rows.length - 1]) {
    if (rows[i]) ctx.fillText(rows[i].day.slice(5), x(i), h - 6);
  }

  // area
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '05');
  ctx.beginPath();
  ctx.moveTo(x(0), padT + plotH);
  rows.forEach((r, i) => ctx.lineTo(x(i), y(Number(r[valueKey]) || 0)));
  ctx.lineTo(x(rows.length - 1), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(x(i), y(Number(r[valueKey]) || 0)) : ctx.moveTo(x(i), y(Number(r[valueKey]) || 0))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // optional second series, scaled to its own max so a small count stays visible
  if (lineKey) {
    const lv = rows.map((r) => Number(r[lineKey]) || 0);
    const lmax = Math.max(...lv, 1);
    const ly = (v) => padT + plotH - (v / lmax) * plotH * 0.72;
    ctx.beginPath();
    rows.forEach((r, i) => (i ? ctx.lineTo(x(i), ly(lv[i])) : ctx.moveTo(x(i), ly(lv[i]))));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (!tip) return;

  // crosshair readout
  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.max(0, Math.min(rows.length - 1,
      Math.round(((px - padL) / plotW) * (rows.length - 1))));
    const r = rows[i];
    tip.style.opacity = '1';
    tip.style.left = Math.min(Math.max(x(i) - 60, 4), w - 130) + 'px';
    tip.style.top = Math.max(y(Number(r[valueKey]) || 0) - 54, 2) + 'px';
    tip.innerHTML = `<span class="tt-day">${esc(r.day)}</span>`
      + `<b>${format(r[valueKey])}</b>`
      + (lineKey ? ` · <b>${r[lineKey] || 0}</b> ${esc(lineKey)}` : '');
  };
  canvas.onmousemove = onMove;
  canvas.onmouseleave = () => { tip.style.opacity = '0'; };
}

// --- dialogs ----------------------------------------------------------------

/**
 * A modal that actually behaves: focus moves in, Tab is trapped inside, Escape
 * always closes it (the old one only listened while focus happened to be
 * within), and focus returns to whatever opened it.
 */
function openModal(html, { wide = false, onClose } = {}) {
  const opener = document.activeElement;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    if (opener && opener.focus) opener.focus();
    if (onClose) onClose();
  };

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, back).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  $$('.modal-x, [data-cancel]', back).forEach((b) => { b.onclick = close; });

  const first = $(FOCUSABLE, back);
  if (first) first.focus();

  return { el: back, close };
}

/**
 * Replaces the browser prompt() that was still being used to name groups and,
 * worse, to set another person's password in an unmaskable native box.
 */
function ask({ title, label, value = '', placeholder = '', password = false, confirmText = 'Save', note = '' }) {
  return new Promise((resolve) => {
    // The result is staged here first: close() runs onClose, so resolving from
    // inside the click handler after close() would always lose to the cancel path.
    let result = null;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(result); } };

    const { el, close } = openModal(`
      <div class="modal-head"><b>${esc(title)}</b><button class="modal-x" aria-label="Close">✕</button></div>
      <div class="modal-body">
        <label for="ask-input">${esc(label)}</label>
        <input id="ask-input" type="${password ? 'password' : 'text'}"
               value="${esc(value)}" placeholder="${esc(placeholder)}"
               autocomplete="${password ? 'new-password' : 'off'}" spellcheck="false">
        ${note ? `<div class="side-note" style="margin-top:9px">${note}</div>` : ''}
      </div>
      <div class="modal-foot">
        <div class="spacer"></div>
        <button class="btn secondary" data-cancel>Cancel</button>
        <button class="btn" data-ok>${esc(confirmText)}</button>
      </div>`, { onClose: done });

    const input = $('#ask-input', el);
    const submit = () => { result = input.value; close(); };
    $('[data-ok]', el).onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    input.select();
  });
}

/** A confirm() that can say what the consequence is, and stress it when severe. */
function confirmDialog({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(result); } };

    const { el, close } = openModal(`
      <div class="modal-head"><b>${esc(title)}</b><button class="modal-x" aria-label="Close">✕</button></div>
      <div class="modal-body"><p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin-top:12px">${body}</p></div>
      <div class="modal-foot">
        <div class="spacer"></div>
        <button class="btn secondary" data-cancel>Cancel</button>
        <button class="btn${danger ? ' danger' : ''}" data-ok>${esc(confirmText)}</button>
      </div>`, { onClose: done });

    $('[data-ok]', el).onclick = () => { result = true; close(); };
  });
}

// --- command palette --------------------------------------------------------

/**
 * One box that finds any account and runs any action.
 *
 * With 41 cards on a free-drag board, "where is that account" was a scrolling
 * problem. This makes it a two-keystroke problem.
 */
function openPalette(getItems) {
  const opener = document.activeElement;
  const back = document.createElement('div');
  back.className = 'modal-back palette-back';
  back.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <input id="pal-q" type="text" placeholder="Search accounts, or type a command…" autocomplete="off" spellcheck="false">
      <div class="palette-list" id="pal-list" role="listbox"></div>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`;
  document.body.appendChild(back);

  const input = $('#pal-q', back);
  const list = $('#pal-list', back);
  let items = [];
  let cursor = 0;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    if (opener && opener.focus) opener.focus();
  };

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = getItems(q).slice(0, 60);
    cursor = Math.min(cursor, Math.max(0, items.length - 1));

    if (!items.length) {
      list.innerHTML = '<div class="palette-group">No match</div>';
      return;
    }

    let html = '';
    let lastGroup = null;
    items.forEach((it, i) => {
      if (it.group !== lastGroup) {
        html += `<div class="palette-group">${esc(it.group)}</div>`;
        lastGroup = it.group;
      }
      html += `
        <button class="palette-item${i === cursor ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${i === cursor}">
          <span class="pi-icon">${it.icon || '•'}</span>
          <span class="pi-main">
            <span class="pi-title">${esc(it.title)}</span>
            ${it.sub ? `<span class="pi-sub">${esc(it.sub)}</span>` : ''}
          </span>
          ${it.right ? `<span class="pi-right">${esc(it.right)}</span>` : ''}
        </button>`;
    });
    list.innerHTML = html;

    $$('.palette-item', list).forEach((el) => {
      el.onmouseenter = () => { cursor = Number(el.dataset.i); highlight(); };
      el.onclick = () => { const it = items[Number(el.dataset.i)]; close(); it.run(); };
    });
  };

  const highlight = () => {
    $$('.palette-item', list).forEach((el, i) => {
      el.classList.toggle('on', i === cursor);
      el.setAttribute('aria-selected', String(i === cursor));
    });
    const on = $('.palette-item.on', list);
    if (on) on.scrollIntoView({ block: 'nearest' });
  };

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, items.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); highlight(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[cursor];
      if (it) { close(); it.run(); }
    }
  }

  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  input.addEventListener('input', () => { cursor = 0; draw(); });

  draw();
  input.focus();
}

window.UI = {
  $, $$, esc, money, moneyMap, compact, ago, toast,
  sparkline, areaChart, fitCanvas, css,
  openModal, ask, confirmDialog, openPalette,
};

})();
