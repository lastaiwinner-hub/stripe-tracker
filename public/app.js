'use strict';

/* Stripe Tracker frontend — plain JS, no build step. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  groups: [], accounts: [], events: [],
  version: -1, tab: 'structure',
  tg: null, lastPoll: '', pollEnabled: true,
  busy: false,
};

const HEALTH = {
  healthy: 'healthy', docs: 'docs needed', restricted: 'restricted',
  suspended: 'suspended', pending: 'pending', error: 'error', unknown: 'not checked',
};
const KINDS = [
  ['sale', '💰 Sales'],
  ['risk', '⚡ High-risk sales'],
  ['decline', '❌ Declined / blocked'],
  ['review', '🔍 Under review'],
  ['fraud', '🚩 Fraud warnings (pre-chargeback)'],
  ['inquiry', '🔔 Pre-dispute inquiries'],
  ['dispute', '⚠️ Disputes'],
  ['refund', '↩️ Refunds'],
  ['payout', '🏦 Payouts'],
  ['paused', '🛑 Payments/payouts paused'],
  ['health', '🩺 Account problems'],
  ['error', '🔌 Connection errors'],
  ['other', 'ℹ️ Everything else'],
];

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n, cur) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 }) + (cur ? ' ' + String(cur).toUpperCase() : '');
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function loadState() {
  const s = await api('GET', '/state');
  Object.assign(state, {
    groups: s.groups, accounts: s.accounts, events: s.events,
    version: s.version, lastPoll: s.last_poll, pollEnabled: s.poll_enabled,
  });
  $('#poll-chip').textContent = s.poll_enabled ? `⏱️ checked ${ago(s.last_poll)}` : '⏸️ polling off';
}

async function loadTg() {
  state.tg = await api('GET', '/telegram');
  const c = $('#tg-chip');
  c.textContent = state.tg.ready ? '🟢 telegram: on' : state.tg.has_token ? '🟡 telegram: no chat' : '⚪ telegram: off';
}

async function loadMe() {
  const s = await api('GET', '/auth/status');
  state.me = s.user || null;
  const chip = $('#logout');
  if (chip && state.me) chip.title = `Signed in as ${state.me.email} — click to sign out`;
}

async function loadUsers() {
  if (!state.me || state.me.role !== 'admin') { state.users = []; return; }
  const r = await api('GET', '/auth/users');
  state.users = r.users;
}

async function loadSheets() {
  state.sheets = await api('GET', '/sheets/config');
  const c = $('#sheet-chip');
  if (!c) return;
  c.textContent = !state.sheets.configured ? '⚪ sheet: off'
    : state.sheets.auto ? '🟢 sheet: auto' : '🟡 sheet: manual';
}

function render() {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'structure') renderStructure();
  else if (state.tab === 'alerts') renderAlerts();
  else renderSettings();
}

async function refresh() { await loadState(); render(); }

// --- accounts / groups ------------------------------------------------------

function summaryHTML() {
  const a = state.accounts;
  const avail = a.reduce((s, x) => s + (x.balance_available || 0), 0);
  const pending = a.reduce((s, x) => s + (x.balance_pending || 0), 0);
  const today = a.reduce((s, x) => s + (x.volume_today || 0), 0);
  const sales = a.reduce((s, x) => s + (x.sales_today || 0), 0);
  const bad = a.filter((x) => ['suspended', 'restricted', 'docs', 'error'].includes(x.health)).length;
  return `
    <div class="summary">
      <div class="stat"><div class="lbl">Accounts</div><div class="val">${a.length}</div></div>
      <div class="stat"><div class="lbl">Needs attention</div><div class="val ${bad ? 'red' : 'green'}">${bad}</div></div>
      <div class="stat"><div class="lbl">Sales today</div><div class="val">${sales}</div></div>
      <div class="stat"><div class="lbl">Volume today</div><div class="val green">${money(today)}</div></div>
      <div class="stat"><div class="lbl">Available</div><div class="val green">${money(avail)}</div></div>
      <div class="stat"><div class="lbl">Pending</div><div class="val amber">${money(pending)}</div></div>
    </div>`;
}

const CARD_W = 268;

function acctHTML(x) {
  const h = x.health || 'unknown';
  const creds = x.has_password || x.has_twofa || x.login_email;
  const pos = Number.isFinite(x.pos_x) && Number.isFinite(x.pos_y)
    ? `left:${x.pos_x}px; top:${x.pos_y}px;`
    : '';
  return `
    <div class="node-card acct h-${esc(h)}" data-acct="${x.id}" style="${pos}">
      <div class="acct-actions">
        <button data-poll="${x.id}" title="check now">⟳</button>
        <button data-creds="${x.id}" title="credentials">🔒</button>
        <button data-key="${x.id}" title="Stripe API key">🔑</button>
        <button data-del="${x.id}" title="remove from tracker">✕</button>
      </div>
      <div class="nm" data-rename="${x.id}" title="click to rename">${esc(x.label) || '<i>unnamed</i>'}</div>
      <div class="sub">
        <span class="hbadge hb-${esc(h)}">${esc(HEALTH[h] || h)}</span>
        ${x.stripe_id ? `<span class="sid">${esc(x.stripe_id)}</span>` : ''}
      </div>
      ${x.legal_name || x.website ? `<div class="sub biz-line">🏢 ${esc(x.legal_name || '')}${x.legal_name && x.website ? ' · ' : ''}${esc(x.website || '')}</div>` : ''}
      <div class="figs">
        <div class="fig"><span>available</span><b class="g">${money(x.balance_available, x.currency)}</b></div>
        <div class="fig"><span>pending</span><b class="a">${money(x.balance_pending, x.currency)}</b></div>
        <div class="fig"><span>today</span><b>${x.sales_today || 0} · ${money(x.volume_today)}</b></div>
      </div>
      ${x.requirements ? `<div class="req">📄 ${esc(x.requirements)}</div>` : ''}
      ${x.disabled_reason ? `<div class="req">⛔ ${esc(x.disabled_reason)}</div>` : ''}
      ${x.last_error ? `<div class="err">🔌 ${esc(x.last_error)}</div>` : ''}
      <div class="pills">
        ${x.has_key
          ? `<span class="pill ok" data-key="${x.id}" title="checked ${esc(ago(x.last_checked))}">🔑 ${esc(x.key_hint)}</span>`
          : `<span class="pill todo" data-key="${x.id}">🔑 add API key</span>`}
        ${creds
          ? `<span class="pill ok" data-creds="${x.id}">🔒 ${esc(x.login_email || 'credentials')}</span>`
          : `<span class="pill todo" data-creds="${x.id}">🔒 add login</span>`}
        ${x.business_fields
          ? `<span class="pill ok" data-biz="${x.id}" title="${esc(x.legal_name || '')}">🏢 ${x.business_fields} field${x.business_fields === 1 ? '' : 's'}</span>`
          : `<span class="pill todo" data-biz="${x.id}">🏢 add business info</span>`}
      </div>
    </div>`;
}

function renderStructure() {
  const grouped = new Map(state.groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const a of state.accounts) {
    if (a.group_id && grouped.has(a.group_id)) grouped.get(a.group_id).push(a);
    else ungrouped.push(a);
  }

  const groupBlock = (g, list) => {
    const avail = list.reduce((s, x) => s + (x.balance_available || 0), 0);
    const today = list.reduce((s, x) => s + (x.volume_today || 0), 0);
    const bad = list.filter((x) => ['suspended', 'restricted', 'docs', 'error'].includes(x.health)).length;
    const isReal = g.id !== 0;
    return `
      <div class="tree-group" data-group="${g.id}">
        <svg class="lines"></svg>
        <div class="head-row">
          <div class="node-card group-node">
            ${isReal ? `<button class="group-x" data-del-group="${g.id}" title="delete group">✕</button>` : ''}
            <div class="nm" ${isReal ? `data-rename-group="${g.id}" title="click to rename"` : ''}>${esc(g.name)}</div>
            <div class="sub">${list.length} account${list.length === 1 ? '' : 's'}${bad ? ` · <span class="bad">${bad} need attention</span>` : ''}</div>
            <div class="figs">
              <div class="fig"><span>available</span><b class="g">${money(avail)}</b></div>
              <div class="fig"><span>today</span><b>${money(today)}</b></div>
            </div>
          </div>
        </div>
        <div class="canvas" data-canvas="${g.id}">
          ${list.map(acctHTML).join('')}
          ${list.length ? '' : '<span class="side-note drop-hint">drag accounts here</span>'}
        </div>
      </div>`;
  };

  $('#view').innerHTML = `
    <div class="toolbar">
      <button class="btn" id="add-acct">+ Stripe account</button>
      <button class="btn secondary" id="add-group">+ Group</button>
      <button class="btn secondary" id="poll-now">⟳ Check all now</button>
      <button class="btn secondary" id="tidy" title="re-flow every card into neat rows">⤢ Tidy</button>
      <div class="spacer"></div>
      <span class="side-note">drag cards freely · drop one on another group to move it</span>
    </div>
    ${summaryHTML()}
    <div class="tree-wrap">
      ${state.groups.map((g) => groupBlock(g, grouped.get(g.id) || [])).join('')}
      ${groupBlock({ id: 0, name: 'Ungrouped' }, ungrouped)}
    </div>
    ${!state.accounts.length ? '<div class="empty">No Stripe accounts yet — hit “+ Stripe account”, then add its API key and login details.</div>' : ''}
  `;

  drawGroupLines();

  $('#add-group').onclick = async () => {
    const name = prompt('Group name (brand):', '');
    if (name === null) return;
    await api('POST', '/groups', { name: name.trim() || 'New group' });
    await refresh();
  };

  $('#add-acct').onclick = async () => {
    const label = prompt('Name for this Stripe account:', '');
    if (label === null) return;
    const { id } = await api('POST', '/accounts', { label: label.trim() || 'New account' });
    await refresh();
    promptForKey(id);
  };

  $('#poll-now').onclick = async () => {
    const btn = $('#poll-now');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api('POST', '/poll');
      await refresh();
      const failed = r.results.filter((x) => x.ok === false).length;
      toast(`Checked ${r.results.length} account(s)${failed ? `, ${failed} failed` : ''}. Telegram sent ${r.telegram.sent || 0}.`);
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '⟳ Check all now'; }
  };

  $('#tidy').onclick = async () => {
    try {
      await api('POST', '/positions', state.accounts.map((a) => ({ id: a.id, x: null, y: null })));
      await refresh();
      toast('Cards re-flowed ✓');
    } catch (e) { toast(e.message, true); }
  };

  $$('[data-rename-group]').forEach((el) => {
    el.classList.add('editable');
    el.title = 'click to rename';
    el.onclick = () => {
      const g = state.groups.find((x) => x.id === Number(el.dataset.renameGroup));
      if (!g) return;
      inlineRename(el, g.name, (name) => api('PATCH', `/groups/${g.id}`, { name }));
    };
  });

  $$('[data-del-group]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('Delete this group? Its accounts move to Ungrouped.')) return;
      await api('DELETE', `/groups/${el.dataset.delGroup}`);
      await refresh();
    };
  });

  $$('[data-rename]').forEach((el) => {
    el.classList.add('editable');
    el.title = 'click to rename';
    el.onclick = (e) => {
      e.stopPropagation();
      const a = state.accounts.find((x) => x.id === Number(el.dataset.rename));
      if (!a) return;
      inlineRename(el, a.label, (label) => api('PATCH', `/accounts/${a.id}`, { label }));
    };
  });

  $$('[data-del]').forEach((el) => {
    el.onclick = async () => {
      const a = state.accounts.find((x) => x.id === Number(el.dataset.del));
      if (!confirm(`Delete "${a?.label || 'account'}" from the tracker? (Your Stripe account itself is untouched.)`)) return;
      await api('DELETE', `/accounts/${a.id}`);
      await refresh();
    };
  });

  $$('[data-key]').forEach((el) => { el.onclick = () => promptForKey(Number(el.dataset.key)); });
  $$('[data-creds]').forEach((el) => { el.onclick = () => openCredentials(Number(el.dataset.creds), 'login'); });
  $$('[data-biz]').forEach((el) => { el.onclick = () => openCredentials(Number(el.dataset.biz), 'business'); });

  $$('[data-poll]').forEach((el) => {
    el.onclick = async () => {
      el.textContent = '…';
      try {
        const r = await api('POST', `/accounts/${el.dataset.poll}/poll`);
        await refresh();
        toast(r.ok ? `Updated — ${HEALTH[r.health] || r.health}` : `Failed: ${r.error || r.skipped}`, !r.ok);
      } catch (e) { toast(e.message, true); await refresh(); }
    };
  });

  layoutCards();
  attachCardDrag();
}

/**
 * Give every card an absolute position: keep the one it was dragged to, or
 * flow it into rows on first sight. Then grow each canvas to fit its cards.
 */
function layoutCards() {
  $$('.canvas').forEach((canvas) => {
    const cards = $$('.acct', canvas);
    const perRow = Math.max(1, Math.floor(((canvas.clientWidth || 900) - 20) / (CARD_W + 22)));
    let placed = 0;
    cards.forEach((card) => {
      const a = state.accounts.find((x) => x.id === Number(card.dataset.acct));
      if (a && Number.isFinite(a.pos_x) && Number.isFinite(a.pos_y)) return; // user-placed
      const col = placed % perRow;
      const row = Math.floor(placed / perRow);
      card.style.left = `${20 + col * (CARD_W + 22)}px`;
      card.style.top = `${20 + row * 210}px`;
      placed++;
    });
    sizeCanvas(canvas);
  });
  drawGroupLines();
}

/** The canvas is absolutely laid out, so its height has to be computed. */
function sizeCanvas(canvas) {
  let maxBottom = 0;
  let maxRight = 0;
  $$('.acct', canvas).forEach((c) => {
    maxBottom = Math.max(maxBottom, c.offsetTop + c.offsetHeight);
    maxRight = Math.max(maxRight, c.offsetLeft + c.offsetWidth);
  });
  canvas.style.height = `${Math.max(90, maxBottom + 24)}px`;
  // let the box scroll sideways if cards are dragged far right
  canvas.style.minWidth = `${Math.max(0, maxRight + 24)}px`;
}

/**
 * Pointer-based dragging: move a card anywhere inside its box, or drop it on
 * another group to reassign it. Positions persist.
 */
/**
 * Which group box is at this point on screen. Uses geometry rather than
 * elementFromPoint so it still works when the cursor is over a card, a gap
 * between boxes, or the dragged card itself.
 */
function groupUnder(x, y) {
  let best = null;
  for (const g of $$('.tree-group')) {
    const r = g.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = g;
  }
  return best;
}

function attachCardDrag() {
  let drag = null;
  let suppressClick = false;

  const view = $('#view');

  // a drag that ends on a button must not also fire that button's click
  view.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  $$('.acct').forEach((card) => {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, .pill')) return; // let controls do their job
      const canvas = card.closest('.canvas');
      drag = {
        card,
        canvas,
        sourceGroup: card.closest('.tree-group'),
        id: Number(card.dataset.acct),
        startX: e.clientX,
        startY: e.clientY,
        origX: card.offsetLeft,
        origY: card.offsetTop,
        moved: false,
      };
      try { card.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    });

    card.addEventListener('pointermove', (e) => {
      if (!drag || drag.card !== card) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
      if (!drag.moved) {
        drag.moved = true;
        card.classList.add('dragging');
      }
      card.style.left = `${drag.origX + dx}px`;
      card.style.top = `${drag.origY + dy}px`;

      // highlight whichever group the cursor is over
      const over = groupUnder(e.clientX, e.clientY);
      $$('.tree-group').forEach((g) => g.classList.toggle('drop-target', g === over && g !== drag.sourceGroup));
      drawGroupLines();
    });

    card.addEventListener('pointerup', async (e) => {
      if (!drag || drag.card !== card) return;
      const d = drag;
      drag = null;
      try { card.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
      card.classList.remove('dragging');
      $$('.tree-group').forEach((g) => g.classList.remove('drop-target'));
      if (!d.moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);

      const targetGroup = groupUnder(e.clientX, e.clientY);
      const sourceGroup = d.sourceGroup;

      try {
        if (targetGroup && targetGroup !== sourceGroup) {
          const gid = Number(targetGroup.dataset.group);
          const canvas = $('.canvas', targetGroup);
          const r = canvas.getBoundingClientRect();
          const x = Math.max(0, e.clientX - r.left - CARD_W / 2);
          const y = Math.max(0, e.clientY - r.top - 20);
          await api('PATCH', `/accounts/${d.id}`, { group_id: gid === 0 ? null : gid });
          await api('POST', '/positions', [{ id: d.id, x, y }]);
          await refresh();
        } else {
          // dropped inside its own box (or outside everything) — just save where it sits
          const x = Math.max(0, card.offsetLeft);
          const y = Math.max(0, card.offsetTop);
          card.style.left = `${x}px`;
          card.style.top = `${y}px`;
          await api('POST', '/positions', [{ id: d.id, x, y }]);
          const a = state.accounts.find((v) => v.id === d.id);
          if (a) { a.pos_x = x; a.pos_y = y; }
          sizeCanvas(d.canvas);
          drawGroupLines();
        }
      } catch (err) { toast(err.message, true); }
    });

    card.addEventListener('pointercancel', () => {
      if (drag && drag.card === card) {
        card.classList.remove('dragging');
        $$('.tree-group').forEach((g) => g.classList.remove('drop-target'));
        drag = null;
      }
    });
  });
}

/**
 * Turn a label into a text box in place. Enter or clicking away saves, Escape
 * cancels. Replaces the old prompt() dialogs, which were easy to dismiss by
 * accident and looked nothing like the rest of the app.
 */
function inlineRename(el, current, onSave) {
  if (el.querySelector('input')) return; // already editing
  const original = el.innerHTML;
  const input = document.createElement('input');
  input.className = 'nm-edit';
  input.value = current || '';
  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (!save || value === (current || '').trim()) {
      el.innerHTML = original;
      return;
    }
    try {
      await onSave(value);
      await refresh();
    } catch (e) {
      toast(e.message, true);
      el.innerHTML = original;
    }
  };

  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onpointerdown = (e) => e.stopPropagation(); // don't start a card drag
  input.onclick = (e) => e.stopPropagation();
}

/** Curved connectors from the group node down to each account card. */
function drawGroupLines() {
  $$('.tree-group').forEach((group) => {
    const svg = $('svg.lines', group);
    if (!svg) return;
    const gRect = group.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${gRect.width} ${gRect.height}`);
    const head = $('.group-node', group);
    if (!head) return;
    const b = head.getBoundingClientRect();
    const x1 = b.left - gRect.left + b.width / 2;
    const y1 = b.bottom - gRect.top;
    let paths = '';
    $$('.canvas .acct', group).forEach((child) => {
      const c = child.getBoundingClientRect();
      const x2 = c.left - gRect.left + c.width / 2;
      const y2 = c.top - gRect.top;
      const my = (y1 + y2) / 2;
      paths += `<path d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" stroke="#3d4763" stroke-width="1.6" fill="none"/>`;
    });
    svg.innerHTML = paths;
  });
}

// --- credentials panel ------------------------------------------------------

/**
 * Every stored field, by panel section. `s` marks a secret: masked by default,
 * with an eye toggle. Anything not listed here can go in Custom fields.
 */
const PANEL = {
  login: {
    title: '🔒 Login',
    fields: [
      ['login_email', 'Login email'],
      ['password', 'Password', 's'],
      ['twofa', '2FA secret / recovery', 's'],
      ['backup_codes', 'Backup codes', 's'],
      ['phone', 'Login phone'],
      ['dashboard_url', 'Dashboard URL'],
      ['cred_notes', 'Notes', 's'],
    ],
  },
  business: {
    title: '🏢 Business',
    fields: [
      ['legal_name', 'Legal business name'],
      ['dba', 'Doing business as / trading name'],
      ['type', 'Business type (individual / LLC / company)'],
      ['industry', 'Industry / MCC'],
      ['website', 'Website submitted'],
      ['publishable_key', 'Publishable key (pk_…)'],
      ['product_description', 'Product description submitted'],
      ['statement_descriptor', 'Statement descriptor'],
      ['support_email', 'Support email'],
      ['support_phone', 'Support phone'],
      ['tax_id', 'Tax ID / EIN', 's'],
      ['vat_number', 'VAT number', 's'],
      ['registration_number', 'Company registration number', 's'],
      ['incorporation_date', 'Incorporation date'],
    ],
  },
  address: {
    title: '📍 Business address',
    fields: [
      ['line1', 'Address line 1'],
      ['line2', 'Address line 2'],
      ['city', 'City'],
      ['state', 'State / province'],
      ['postal_code', 'Postal code'],
      ['country', 'Country'],
      ['business_phone', 'Business phone'],
    ],
  },
  rep: {
    title: '👤 Representative',
    fields: [
      ['name', 'Full legal name'],
      ['title', 'Job title / role'],
      ['email', 'Email'],
      ['phone', 'Phone'],
      ['dob', 'Date of birth', 's'],
      ['id_number', 'SSN / ID number', 's'],
      ['home_address', 'Home address', 's'],
      ['documents', 'ID documents submitted', 's'],
    ],
  },
  bank: {
    title: '🏦 Payout / bank',
    fields: [
      ['bank_name', 'Bank name'],
      ['account_holder', 'Account holder name'],
      ['account_number', 'Account number', 's'],
      ['routing_number', 'Routing / sort code', 's'],
      ['iban', 'IBAN', 's'],
      ['swift', 'SWIFT / BIC', 's'],
      ['payout_schedule', 'Payout schedule'],
      ['bank_notes', 'Notes', 's'],
    ],
  },
};

const SECTION_ORDER = ['login', 'business', 'address', 'rep', 'bank', 'custom'];

function fieldRowHTML(section, key, label, secret, value) {
  return `
    <label>${esc(label)}</label>
    <div class="cred-row">
      <input data-sec="${section}" data-f="${esc(key)}" type="${secret ? 'password' : 'text'}"
             value="${esc(value || '')}" ${secret ? 'autocomplete="new-password"' : ''}>
      ${secret ? '<button class="mini" data-eye title="show/hide">👁</button>' : ''}
      <button class="mini" data-copy title="copy">📋</button>
    </div>`;
}

function customRowHTML(f = { label: '', value: '' }) {
  return `
    <div class="custom-row">
      <input class="c-label" placeholder="field name (e.g. Proxy used)" value="${esc(f.label || '')}">
      <input class="c-value" placeholder="value" value="${esc(f.value || '')}">
      <button class="mini" data-copy-custom title="copy">📋</button>
      <button class="mini" data-drop-custom title="remove">✕</button>
    </div>`;
}

async function openCredentials(id, startSection = 'login') {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return;

  let creds, biz;
  try {
    [creds, biz] = await Promise.all([
      api('GET', `/accounts/${id}/credentials`),
      api('GET', `/accounts/${id}/business`),
    ]);
  } catch (e) { toast(e.message, true); return; }

  const valueFor = (section, key) =>
    section === 'login' ? creds[key] : (biz[section] || {})[key];

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal wide">
      <div class="modal-head">
        <b>${esc(a.label || 'account')} — details</b>
        <button class="modal-x" title="close">✕</button>
      </div>
      <div class="modal-tabs">
        ${SECTION_ORDER.map((s) => `
          <button class="mtab ${s === startSection ? 'active' : ''}" data-sect="${s}">
            ${s === 'custom' ? '➕ Custom' : PANEL[s].title}
          </button>`).join('')}
      </div>
      <div class="modal-body">
        ${SECTION_ORDER.filter((s) => s !== 'custom').map((s) => `
          <div class="msec" data-body="${s}" ${s === startSection ? '' : 'hidden'}>
            ${s === 'address' ? `
              <label>🔎 Find US address — type it and pick a match</label>
              <div class="cred-row">
                <input id="addr-search" type="text" placeholder="e.g. 1209 Orange St, Wilmington DE" autocomplete="off">
              </div>
              <div id="addr-results" class="lookup-list" hidden></div>
              <div id="addr-msg" class="side-note" style="margin-top:6px"></div>
            ` : ''}
            ${PANEL[s].fields.map(([k, label, sec]) =>
              fieldRowHTML(s, k, label, sec === 's', valueFor(s, k))).join('')}
            ${s === 'bank' ? '<div id="bank-msg" class="side-note" style="margin-top:10px"></div>' : ''}
          </div>`).join('')}
        <div class="msec" data-body="custom" ${startSection === 'custom' ? '' : 'hidden'}>
          <div class="side-note" style="margin-bottom:10px">
            Anything else you submitted or want to remember for this account.
          </div>
          <div id="custom-list">${(biz.custom || []).map(customRowHTML).join('')}</div>
          <button class="btn ghost" id="add-custom" style="margin-top:10px">+ add field</button>
        </div>
        <div class="warn-note">
          Everything here is encrypted (AES-256-GCM) before it is written to disk. The key file sits
          beside the database in <code>data/</code>, so this protects the database file itself —
          not someone who already has access to this PC.
        </div>
      </div>
      <div class="modal-foot">
        <span class="side-note" id="cred-msg"></span>
        <div class="spacer"></div>
        <button class="btn secondary" data-cancel>Cancel</button>
        <button class="btn" data-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const close = () => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };
  $('.modal-x', back).onclick = close;
  $('[data-cancel]', back).onclick = close;
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  $$('.mtab', back).forEach((tab) => {
    tab.onclick = () => {
      $$('.mtab', back).forEach((t) => t.classList.toggle('active', t === tab));
      $$('.msec', back).forEach((sec) => { sec.hidden = sec.dataset.body !== tab.dataset.sect; });
    };
  });

  const note = (msg) => { $('#cred-msg', back).textContent = msg; };

  async function copyValue(input) {
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    note('Copied ✓');
  }

  // delegated so rows added later behave the same
  back.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      const inp = eye.parentElement.querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) { copyValue(copy.parentElement.querySelector('input')); return; }
    const copyC = e.target.closest('[data-copy-custom]');
    if (copyC) { copyValue(copyC.parentElement.querySelector('.c-value')); return; }
    const drop = e.target.closest('[data-drop-custom]');
    if (drop) { drop.closest('.custom-row').remove(); }
  });

  // --- address autocomplete ---
  const addrInput = $('#addr-search', back);
  const addrList = $('#addr-results', back);
  const addrMsg = $('#addr-msg', back);
  let addrTimer = null;
  let addrSeq = 0;

  const setField = (section, key, value) => {
    const el = back.querySelector(`input[data-sec="${section}"][data-f="${key}"]`);
    if (el && value) el.value = value;
  };

  if (addrInput) {
    addrInput.addEventListener('input', () => {
      clearTimeout(addrTimer);
      const q = addrInput.value.trim();
      if (q.length < 3) { addrList.hidden = true; addrMsg.textContent = ''; return; }
      addrMsg.textContent = 'Searching…';
      // debounce: Nominatim asks for at most one request per second
      addrTimer = setTimeout(async () => {
        const seq = ++addrSeq;
        try {
          const { results } = await api('GET', `/lookup/address?q=${encodeURIComponent(q)}`);
          if (seq !== addrSeq) return; // a newer keystroke already won
          if (!results.length) {
            addrList.hidden = true;
            addrMsg.textContent = 'No US match — you can still type the fields manually.';
            return;
          }
          addrMsg.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} — click one to fill the fields`;
          addrList.innerHTML = results.map((r, i) => `
            <div class="lookup-item" data-i="${i}">
              <div class="li-main">${esc([r.line1, r.city, r.state].filter(Boolean).join(', ') || r.label)}</div>
              <div class="li-sub">${esc(r.label)}</div>
            </div>`).join('');
          addrList.hidden = false;
          $$('.lookup-item', addrList).forEach((item) => {
            item.onclick = () => {
              const r = results[Number(item.dataset.i)];
              setField('address', 'line1', r.line1);
              setField('address', 'line2', r.line2);
              setField('address', 'city', r.city);
              setField('address', 'state', r.state);
              setField('address', 'postal_code', r.postal_code);
              setField('address', 'country', r.country);
              addrList.hidden = true;
              addrMsg.textContent = 'Filled ✓ — check it and adjust anything that is off.';
            };
          });
        } catch (e) {
          if (seq !== addrSeq) return;
          addrList.hidden = true;
          addrMsg.textContent = e.message;
        }
      }, 600);
    });
  }

  // --- routing number -> bank name ---
  const routingInput = back.querySelector('input[data-sec="bank"][data-f="routing_number"]');
  const bankMsg = $('#bank-msg', back);
  if (routingInput) {
    const doLookup = async () => {
      const rn = routingInput.value.replace(/\D/g, '');
      if (rn.length !== 9) { if (bankMsg) bankMsg.textContent = ''; return; }
      bankMsg.textContent = 'Looking up bank…';
      try {
        const info = await api('GET', `/lookup/routing?rn=${rn}`);
        const nameField = back.querySelector('input[data-sec="bank"][data-f="bank_name"]');
        if (nameField && !nameField.value.trim()) nameField.value = info.bank_name;
        bankMsg.innerHTML = `<span style="color:var(--green)">✓ ${esc(info.bank_name)}</span>`
          + (info.city ? ` <span style="color:var(--muted)">— ${esc(info.city)}, ${esc(info.state)}</span>` : '')
          + (nameField && nameField.value.trim() && nameField.value.trim() !== info.bank_name
            ? '<br><span style="color:var(--amber)">Bank name field already filled — left as it is.</span>' : '');
      } catch (e) {
        bankMsg.innerHTML = `<span style="color:var(--amber)">${esc(e.message)}</span>`;
      }
    };
    routingInput.addEventListener('blur', doLookup);
    routingInput.addEventListener('change', doLookup);
  }

  $('#add-custom', back).onclick = () => {
    $('#custom-list', back).insertAdjacentHTML('beforeend', customRowHTML());
    $('#custom-list', back).lastElementChild.querySelector('.c-label').focus();
  };

  $('[data-save]', back).onclick = async () => {
    const credPatch = {};
    const bizPatch = { business: {}, address: {}, rep: {}, bank: {}, custom: [] };

    $$('input[data-sec]', back).forEach((inp) => {
      const { sec, f } = inp.dataset;
      if (sec === 'login') credPatch[f] = inp.value;
      else bizPatch[sec][f] = inp.value;
    });
    $$('.custom-row', back).forEach((row) => {
      bizPatch.custom.push({
        label: row.querySelector('.c-label').value,
        value: row.querySelector('.c-value').value,
      });
    });

    try {
      await api('PUT', `/accounts/${id}/credentials`, credPatch);
      await api('PUT', `/accounts/${id}/business`, bizPatch);
      close();
      await refresh();
      toast('Saved ✓');
    } catch (e) { toast(e.message, true); }
  };

  const first = $('input', back);
  if (first) first.focus();
}

function promptForKey(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return;

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <b>🔑 Stripe API key — ${esc(a.label || 'account')}</b>
        <button class="modal-x" title="close">✕</button>
      </div>
      <div class="modal-body">
        ${a.has_key ? `<div class="ok-note">A key is already saved (${esc(a.key_hint)}). Pasting a new one replaces it.</div>` : ''}
        <label>Secret key</label>
        <div class="cred-row">
          <input id="key-input" type="password" placeholder="sk_live_…" autocomplete="new-password" spellcheck="false">
          <button class="mini" data-eye title="show/hide">👁</button>
        </div>
        <div class="warn-note" style="margin-top:12px">
          Stored on this PC only and never sent back to the browser. The app makes read-only calls
          (account, balance, charges, disputes, refunds, payouts) — it never writes to Stripe.
          Restricted keys (<code>rk_…</code>) work here too if you ever want one.
        </div>
        <div id="key-status" class="side-note" style="margin-top:12px"></div>
      </div>
      <div class="modal-foot">
        <div class="spacer"></div>
        <button class="btn secondary" data-cancel>Cancel</button>
        <button class="btn" data-save>Verify &amp; save</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const input = $('#key-input', back);
  const status = $('#key-status', back);
  const close = () => back.remove();

  back.onclick = (e) => { if (e.target === back) close(); };
  $('.modal-x', back).onclick = close;
  $('[data-cancel]', back).onclick = close;
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') $('[data-save]', back).click();
  });
  $('[data-eye]', back).onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  $('[data-save]', back).onclick = async () => {
    const key = input.value.trim();
    if (!key) { status.textContent = 'Paste a key first.'; return; }
    const btn = $('[data-save]', back);
    btn.disabled = true;
    status.textContent = 'Checking with Stripe…';
    try {
      const r = await api('POST', `/accounts/${id}/key`, { api_key: key });
      input.value = '';
      close();
      await refresh();
      toast(`Connected ✓ ${r.info.business_name || r.info.id} — ${HEALTH[r.info.health] || r.info.health}`);
    } catch (e) {
      btn.disabled = false;
      status.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
    }
  };

  input.focus();
}

// --- alerts -----------------------------------------------------------------

const EV_ICON = {
  sale: '💰', risk: '⚡', decline: '❌', review: '🔍', fraud: '🚩', inquiry: '🔔',
  dispute: '⚠️', refund: '↩️', payout: '🏦', paused: '🛑', health: '🩺',
  error: '🔌', other: 'ℹ️',
};

function renderAlerts() {
  $('#view').innerHTML = `
    <div class="toolbar">
      <span class="side-note">${state.events.length} recent event(s) · newest first</span>
      <div class="spacer"></div>
      <button class="btn secondary" id="clear-ev">Clear list</button>
    </div>
    ${state.events.length ? state.events.map((e) => `
      <div class="ev sev-${esc(e.severity)}">
        <div class="ico">${EV_ICON[e.kind] || 'ℹ️'}</div>
        <div class="body">
          <div class="t">${esc(e.title)}</div>
          ${e.detail ? `<div class="d">${esc(e.detail)}</div>` : ''}
        </div>
        <div class="when">${esc(ago(e.created_at))}${e.notified ? ' · sent' : ''}</div>
      </div>`).join('')
      : '<div class="empty">Nothing yet. Alerts appear here and go to Telegram at the same time.</div>'}
  `;
  $('#clear-ev').onclick = async () => {
    if (!confirm('Clear the alert history? (Telegram messages already sent stay in Telegram.)')) return;
    await api('DELETE', '/events');
    await refresh();
  };
}

// --- settings ---------------------------------------------------------------

function renderSettings() {
  const t = state.tg || {};
  const sh = state.sheets || {};
  const kinds = new Set(t.kinds || []);
  $('#view').innerHTML = `
    <div class="grid2">
      <div>
        <div class="card">
          <h3>📨 Telegram alerts</h3>
          <div class="steps" style="margin-bottom:4px">
            Your own bot and chat — alerts about your accounts go only here.
          </div>
          <label>Bot token (from @BotFather)</label>
          <input type="password" id="tg-token" placeholder="${t.has_token ? 'Saved ✓ — type a new one to replace' : '123456789:AAE…'}">
          <div class="row">
            <button class="btn secondary" id="tg-save">Save token</button>
            <button class="btn secondary" id="tg-detect">Detect chat</button>
            <div class="spacer"></div>
            <button class="btn" id="tg-test" ${t.ready ? '' : 'disabled'}>Send test</button>
          </div>
          ${t.chat_id ? `<div class="ok-note">Chat connected ✓ ${esc(t.chat_name || '')} (${esc(t.chat_id)})</div>` : ''}
          <label>Alert me about</label>
          <div class="checks">
            ${KINDS.map(([k, lbl]) => `
              <label><input type="checkbox" class="k" value="${k}" ${kinds.has(k) ? 'checked' : ''}> ${lbl}</label>`).join('')}
          </div>
          <div class="row" style="margin-top:10px">
            <label style="margin:0;display:flex;align-items:center;gap:7px;cursor:pointer">
              <input type="checkbox" id="verbose" ${t.verbose ? 'checked' : ''}>
              Verbose — alert on <i>every</i> Stripe event type
            </label>
          </div>
          <label>Check Stripe every (seconds)</label>
          <input type="number" id="poll-secs" min="20" max="3600" value="${t.poll_seconds || 60}">
          <div class="row">
            <label style="margin:0;display:flex;align-items:center;gap:7px;cursor:pointer">
              <input type="checkbox" id="poll-on" ${state.pollEnabled ? 'checked' : ''}> Automatic checking on
            </label>
            <div class="spacer"></div>
            <button class="btn secondary" id="prefs-save">Save preferences</button>
          </div>
        </div>

        <div class="card">
          <h3>📊 Google Sheet</h3>
          <label>Spreadsheet URL (or ID)</label>
          <input type="text" id="sh-sheet" value="${esc(sh.sheet_id || '')}" placeholder="https://docs.google.com/spreadsheets/d/…">
          <label>Service-account key (paste the whole JSON file)</label>
          <textarea id="sh-sa" placeholder="${sh.client_email ? 'Key saved ✓ — paste again only to replace it' : '{ \&quot;type\&quot;: \&quot;service_account\&quot;, … }'}"></textarea>
          ${sh.client_email ? `<div class="ok-note">Key saved ✓ — share your sheet with:<br><code>${esc(sh.client_email)}</code></div>` : ''}
          <div class="row">
            <label style="margin:0;display:flex;align-items:center;gap:7px;cursor:pointer">
              <input type="checkbox" id="sh-auto" ${sh.auto ? 'checked' : ''}> Update after every check
            </label>
          </div>
          <div class="row">
            <label style="margin:0;display:flex;align-items:center;gap:7px;cursor:pointer">
              <input type="checkbox" id="sh-secrets" ${sh.include_secrets ? 'checked' : ''}> Include passwords, keys &amp; sensitive columns
            </label>
          </div>
          ${sh.include_secrets ? `<div class="warn-note">
            The sheet carries API keys, passwords, 2FA, SSN/ID, tax ID and bank numbers in plain text.
            Keep it private — never "anyone with the link" — and share it only with your own Google account.
          </div>` : ''}
          <div class="row">
            <div class="spacer"></div>
            <button class="btn secondary" id="sh-save">Save</button>
            <button class="btn" id="sh-push" ${sh.configured ? '' : 'disabled'}
                    title="${sh.configured ? 'Rewrite every tab now' : 'Save a sheet URL and a service-account key first'}">⇪ Update sheet now</button>
          </div>
          ${sh.configured ? '' : `<div class="warn-note">
            <b>“Update sheet now” is greyed out because setup isn't finished:</b><br>
            ${sh.sheet_id ? '✅' : '⬜'} Spreadsheet URL saved<br>
            ${sh.client_email ? '✅' : '⬜'} Service-account key saved${sh.client_email ? '' : ' — paste the JSON above and press <b>Save</b>'}
          </div>`}
          <div id="sh-log">${sh.last_push ? esc(JSON.stringify(sh.last_push, null, 2)) : 'Not pushed yet.'}</div>
        </div>

        ${state.me && state.me.role === 'admin' ? `
        <div class="card">
          <h3>👥 People with access</h3>
          <div class="steps" style="margin-bottom:10px">
            Signed in as <b>${esc(state.me.email)}</b> (owner). Everyone you add can see and edit
            everything in this app, including Stripe keys and credentials — only add people you trust.
          </div>
          <table class="users">
            <thead><tr><th>Email</th><th style="width:96px">Role</th><th style="width:70px">Status</th><th style="width:120px">Last login</th><th style="width:120px"></th></tr></thead>
            <tbody>
              ${(state.users || []).map((u) => `
                <tr>
                  <td>${esc(u.email)}${u.id === state.me.id ? ' <span class="side-note">(you)</span>' : ''}</td>
                  <td>
                    <select data-role="${u.id}" ${u.id === state.me.id ? 'disabled' : ''}>
                      <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>owner</option>
                      <option value="member" ${u.role === 'member' ? 'selected' : ''}>member</option>
                    </select>
                  </td>
                  <td><span class="${u.active ? 'u-on' : 'u-off'}">${u.active ? 'active' : 'disabled'}</span></td>
                  <td class="side-note">${u.last_login ? esc(ago(u.last_login)) : 'never'}</td>
                  <td style="text-align:right">
                    ${u.id === state.me.id ? '' : `
                      <button class="mini" data-toggle="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'disable' : 'enable'}</button>
                      <button class="mini" data-resetpw="${u.id}">reset pw</button>
                      <button class="mini" data-deluser="${u.id}">✕</button>`}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          <label>Add someone</label>
          <div class="adduser">
            <input type="email" id="nu-email" placeholder="their@email.com">
            <input type="password" id="nu-pw" placeholder="password you set for them" autocomplete="new-password">
            <select id="nu-role"><option value="member">member</option><option value="admin">owner</option></select>
            <button class="btn" id="nu-add">Add</button>
          </div>
          <div id="users-msg" class="side-note" style="margin-top:10px"></div>
        </div>` : ''}

        <div class="card">
          <h3>🔑 ${state.me ? 'Your password' : 'App password'}</h3>
          <div class="steps" style="margin-bottom:4px">
            Protects this app when it is reachable from the internet. Changing it signs out every device.
          </div>
          <label>Current password</label>
          <input type="password" id="pw-cur" autocomplete="current-password">
          <label>New password (min 8 characters)</label>
          <input type="password" id="pw-new" autocomplete="new-password">
          <div class="row">
            <div class="spacer"></div>
            <button class="btn secondary" id="pw-save">Change password</button>
          </div>
          <div id="pw-msg" class="side-note" style="margin-top:10px"></div>
        </div>

        <div class="card">
          <h3>🔐 About your API keys</h3>
          <div class="steps">
            Keys live in this app's local database on your PC and are <b>never sent to the browser</b> —
            the page only ever sees a masked hint like <code>secret · live · …4f2a</code>.<br><br>
            The tracker only reads from Stripe. Treat a secret key like a password: don't paste it into
            chats, screenshots or shared docs, and roll it in the Stripe dashboard if it ever gets out.
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h3>1️⃣ Telegram bot (2 min)</h3>
          <div class="steps">
            1. In Telegram, open <a href="https://t.me/BotFather" target="_blank">@BotFather</a> → send <code>/newbot</code> → pick any name.<br>
            2. It replies with a token like <code>123456789:AAE…</code> — paste it on the left and hit <b>Save token</b>.<br>
            3. Open your new bot's chat and press <b>Start</b> (this is what lets it message you).<br>
            4. Hit <b>Detect chat</b> here, then <b>Send test</b>. A message should land in Telegram.<br><br>
            Everyone with an account here sets up their <b>own</b> bot — your alerts never reach anybody else's chat.
          </div>
        </div>
        <div class="card">
          <h3>2️⃣ Stripe key (per account)</h3>
          <div class="steps">
            Do this once for <b>each</b> Stripe account, logged into that account:<br>
            1. Go to <a href="https://dashboard.stripe.com/apikeys" target="_blank">dashboard.stripe.com/apikeys</a>.<br>
            2. Under <b>Standard keys</b>, reveal and copy the <b>Secret key</b> (<code>sk_live_…</code>).<br>
            3. In the Accounts tab click the 🔑 pill on that card and paste it.<br>
            4. The app verifies it with Stripe on the spot and pulls the account's health, balance and today's sales.<br><br>
            The tracker only ever <b>reads</b> from Stripe — it never creates charges, refunds or payouts.
            If you'd rather hand it a key that <i>cannot</i> write even in principle, create a
            <b>restricted key</b> with Read on Charges, Balance, Disputes, Refunds, Payouts and Account;
            it works here identically.
          </div>
        </div>
        <div class="card">
          <h3>3️⃣ Google Sheet (one time, free)</h3>
          <div class="steps">
            1. <a href="https://console.cloud.google.com/" target="_blank">console.cloud.google.com</a> → create a project.<br>
            2. Search <b>Google Sheets API</b> → <b>Enable</b>.<br>
            3. <b>IAM &amp; Admin → Service Accounts → Create service account</b> → Done.<br>
            4. Open it → <b>Keys → Add key → Create new key → JSON</b>. A file downloads.<br>
            5. Open that file in Notepad, copy everything, paste it on the left.<br>
            6. Create a Google Sheet, press <b>Share</b>, and share it with the service-account email
               (shown on the left after saving) as <b>Editor</b>.<br>
            7. Paste the sheet URL, <b>Save</b>, then <b>Update sheet now</b>.<br><br>
            Tabs written: <code>Overview</code>, <code>Login &amp; keys</code>, <code>Business</code>,
            <code>Address</code>, <code>Representative</code>, <code>Bank</code>,
            <code>Custom fields</code>, <code>Groups</code>.
            The app rewrites them on every check — edit the app, not the sheet.<br><br>
            If you already made a service account for the Whop Structure app, reuse that same JSON here.
          </div>
        </div>
        <div class="card">
          <h3>❓ Why checks, not webhooks</h3>
          <div class="steps">
            This app runs on your own PC, so Stripe can't push events to it without exposing a public address.
            Instead it asks Stripe every ${t.poll_seconds || 120}s what changed. Alerts arrive within that window,
            and nothing is ever reported twice.<br><br>
            Keep the app running (or leave the window open) for alerts to flow.
          </div>
        </div>
      </div>
    </div>
  `;

  $('#tg-save').onclick = async () => {
    try {
      await api('POST', '/telegram', { token: $('#tg-token').value });
      await loadTg(); renderSettings(); toast('Token saved ✓ — now press Start in your bot, then Detect chat.');
    } catch (e) { toast(e.message, true); }
  };

  $('#tg-detect').onclick = async () => {
    try {
      const r = await api('POST', '/telegram/detect');
      await loadTg(); renderSettings(); toast(`Chat found ✓ ${r.name || r.chatId}`);
    } catch (e) { toast(e.message, true); }
  };

  $('#tg-test').onclick = async () => {
    try { await api('POST', '/telegram/test'); toast('Test message sent — check Telegram ✓'); }
    catch (e) { toast(e.message, true); }
  };

  if (state.me && state.me.role === 'admin') {
    const umsg = $('#users-msg');
    const ok = (m) => { umsg.innerHTML = `<span style="color:var(--green)">${esc(m)}</span>`; };
    const bad = (m) => { umsg.innerHTML = `<span style="color:var(--red)">${esc(m)}</span>`; };

    $('#nu-add').onclick = async () => {
      try {
        await api('POST', '/auth/users', {
          email: $('#nu-email').value,
          password: $('#nu-pw').value,
          role: $('#nu-role').value,
        });
        const who = $('#nu-email').value;
        $('#nu-email').value = ''; $('#nu-pw').value = '';
        await loadUsers(); renderSettings();
        toast(`Added ${who} ✓ — give them the link and the password you chose.`);
      } catch (e) { bad(e.message); }
    };

    $$('[data-role]').forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api('PATCH', `/auth/users/${sel.dataset.role}`, { role: sel.value });
          await loadUsers(); renderSettings(); toast('Role updated ✓');
        } catch (e) { bad(e.message); await loadUsers(); renderSettings(); }
      };
    });

    $$('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api('PATCH', `/auth/users/${b.dataset.toggle}`, { active: b.dataset.active === '1' ? false : true });
          await loadUsers(); renderSettings(); toast('Updated ✓');
        } catch (e) { bad(e.message); }
      };
    });

    $$('[data-resetpw]').forEach((b) => {
      b.onclick = async () => {
        const pw = prompt('New password for this person (min 8 characters):', '');
        if (pw === null || !pw.trim()) return;
        try {
          await api('PATCH', `/auth/users/${b.dataset.resetpw}`, { password: pw });
          ok('Password reset — they were signed out of every device.');
        } catch (e) { bad(e.message); }
      };
    });

    $$('[data-deluser]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Remove this person’s access completely?')) return;
        try {
          await api('DELETE', `/auth/users/${b.dataset.deluser}`);
          await loadUsers(); renderSettings(); toast('Access removed ✓');
        } catch (e) { bad(e.message); }
      };
    });
  }

  $('#pw-save').onclick = async () => {
    const msg = $('#pw-msg');
    try {
      await api('POST', '/auth/password', {
        current: $('#pw-cur').value,
        password: $('#pw-new').value,
      });
      $('#pw-cur').value = ''; $('#pw-new').value = '';
      msg.innerHTML = '<span style="color:var(--green)">Password changed ✓ — other devices were signed out.</span>';
    } catch (e) {
      msg.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
    }
  };

  $('#sh-save').onclick = async () => {
    try {
      await api('POST', '/sheets/config', {
        sheet: $('#sh-sheet').value,
        service_account_json: $('#sh-sa').value,
        auto: $('#sh-auto').checked,
        include_secrets: $('#sh-secrets').checked,
      });
      await loadSheets();
      renderSettings();
      toast(state.sheets.configured
        ? 'Saved ✓ — you can hit “Update sheet now”'
        : 'Saved, but the service-account key is still missing.');
    } catch (e) { toast(e.message, true); }
  };

  $('#sh-push').onclick = async () => {
    const btn = $('#sh-push');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      const r = await api('POST', '/sheets/push');
      await loadSheets(); renderSettings();
      toast(`Sheet updated ✓ ${r.report.accounts} account(s) across ${r.report.tabs} tabs`);
    } catch (e) {
      btn.disabled = false; btn.textContent = '⇪ Update sheet now';
      toast(e.message, true);
    }
  };

  $('#prefs-save').onclick = async () => {
    try {
      await api('POST', '/telegram', {
        kinds: $$('.k').filter((c) => c.checked).map((c) => c.value),
        poll_seconds: Number($('#poll-secs').value),
        verbose: $('#verbose').checked,
      });
      await api('POST', '/poll/toggle', { enabled: $('#poll-on').checked });
      await loadTg(); await loadState(); renderSettings(); toast('Preferences saved ✓');
    } catch (e) { toast(e.message, true); }
  };
}

// --- polling / init ---------------------------------------------------------

function busyEditing() {
  if ($('.modal-back')) return true; // never re-render under an open dialog
  const el = document.activeElement;
  return el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

setInterval(async () => {
  try {
    if (busyEditing() || state.tab === 'settings') return;
    const { version } = await api('GET', '/version');
    if (version !== state.version) await refresh();
    else $('#poll-chip').textContent = state.pollEnabled ? `⏱️ checked ${ago(state.lastPoll)}` : '⏸️ polling off';
  } catch { /* server restarting — ignore */ }
}, 5000);

$$('.tab').forEach((b) => { b.onclick = () => { state.tab = b.dataset.tab; render(); }; });

$('#logout').onclick = async () => {
  try { await api('POST', '/auth/logout'); } catch { /* going to the login page anyway */ }
  location.href = '/login.html';
};

// connector lines are pixel-positioned, so they need redrawing on resize
window.addEventListener('resize', () => { if (state.tab === 'structure') layoutCards(); });

(async () => {
  await loadMe();
  await Promise.all([loadState(), loadTg(), loadSheets(), loadUsers()]);
  render();
})();
