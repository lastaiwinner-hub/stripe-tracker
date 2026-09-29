'use strict';

/* Stripe Tracker frontend — plain JS, no build step. UI helpers live in ui.js. */

const { $, $$, esc, money, moneyMap, compact, ago, toast,
  sparkline, areaChart, css, openModal, ask, confirmDialog, openPalette } = window.UI;

/**
 * Browser storage throws outright in some contexts — a private window with site
 * data blocked, an embedded view with an opaque origin. A remembered tab is not
 * worth a blank page.
 */
function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* preference just won't stick */ }
}

const state = {
  groups: [], accounts: [], events: [], totals: { available: {}, pending: {} },
  stats: { totals: [], per_account: [] },
  version: -1, tab: 'pulse',
  tg: null, sheets: null, me: null, users: [],
  lastPoll: '', lastPollMs: 0, lastStall: '', pollEnabled: true, pollSeconds: 60,
  mutedUntil: 0, isAdmin: false,
  // view state
  acctView: readPref('acctView', 'table'),
  acctSort: { key: 'label', dir: 1 },
  acctFilter: '', healthFilter: null,
  alertFilter: { sev: null, kind: null, account: null, q: '' },
  consoleAccount: null, consoleQuery: '', consoleResults: null, consoleBusy: false,
  blockLists: null,
  work: null, workLoading: false, workAt: 0, workFilter: 'all',
  openPanels: new Set(),
  boardFree: readPref('boardFree', '0') === '1',
  boardCompact: readPref('boardCompact', '0') === '1',
  boardSort: readPref('boardSort', 'health'),
  collapsed: new Set(JSON.parse(readPref('collapsedGroups', '[]') || '[]')),
};

const HEALTH = {
  healthy: 'healthy', docs: 'docs needed', restricted: 'restricted',
  suspended: 'suspended', pending: 'pending', error: 'unreachable', unknown: 'not checked',
};
const HEALTH_ORDER = ['suspended', 'error', 'restricted', 'docs', 'pending', 'unknown', 'healthy'];
const BAD = ['suspended', 'restricted', 'docs', 'error'];

const KINDS = [
  ['sale', '💰 Sales'], ['risk', '⚡ High-risk sales'], ['decline', '❌ Declined / blocked'],
  ['review', '🔍 Under review'], ['fraud', '🚩 Fraud warnings'], ['inquiry', '🔔 Pre-dispute inquiries'],
  ['dispute', '⚠️ Disputes'], ['refund', '↩️ Refunds'], ['payout', '🏦 Payouts'],
  ['paused', '🛑 Payments/payouts paused'], ['health', '🩺 Account problems'],
  ['error', '🔌 Connection errors'], ['action', '⚡ Actions you took'],
  ['other', 'ℹ️ Everything else'],
];
const EV_ICON = {
  sale: '💰', risk: '⚡', decline: '❌', review: '🔍', fraud: '🚩', inquiry: '🔔',
  dispute: '⚠️', refund: '↩️', payout: '🏦', paused: '🛑', health: '🩺', error: '🔌',
  action: '⚡', other: 'ℹ️',
};

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// --- loading ----------------------------------------------------------------

async function loadState() {
  const s = await api('GET', '/state');
  Object.assign(state, {
    groups: s.groups, accounts: s.accounts, events: s.events, totals: s.totals,
    version: s.version, lastPoll: s.last_poll, lastPollMs: s.last_poll_ms,
    lastStall: s.last_stall, pollEnabled: s.poll_enabled, pollSeconds: s.poll_seconds,
    mutedUntil: s.muted_until, isAdmin: s.is_admin,
  });
  paintChips();
}

async function loadStats() {
  state.stats = await api('GET', '/stats?days=30');
}

async function loadTg() { state.tg = await api('GET', '/telegram'); paintChips(); }
async function loadSheets() { state.sheets = await api('GET', '/sheets/config'); paintChips(); }
async function loadMe() {
  const s = await api('GET', '/auth/status');
  state.me = s.user || null;
}
async function loadUsers() {
  if (!state.me || state.me.role !== 'admin') { state.users = []; return; }
  state.users = (await api('GET', '/auth/users')).users;
}

/**
 * Header status. Kept out of render() so it can keep ticking even while the
 * Settings tab is open — that tab used to freeze every background update, so
 * the chips silently went stale without ever saying so.
 */
function paintChips() {
  const stale = state.lastPoll
    && Date.now() - new Date(state.lastPoll).getTime() > state.pollSeconds * 1000 * 4;

  const poll = $('#poll-chip');
  if (poll) {
    const cls = !state.pollEnabled ? '' : stale ? 'bad' : 'on live';
    const text = !state.pollEnabled ? 'checks paused'
      : stale ? 'monitoring stalled'
        : `checked ${ago(state.lastPoll)}`;
    poll.innerHTML = `<span class="dot ${cls}"></span>${esc(text)}`;
    poll.classList.toggle('alarm', !!stale && state.pollEnabled);
    poll.title = state.lastPollMs
      ? `Last cycle took ${(state.lastPollMs / 1000).toFixed(1)}s across ${state.accounts.length} accounts`
      : '';
  }

  const tg = $('#tg-chip');
  if (tg && state.tg) {
    const muted = state.mutedUntil > Date.now();
    tg.innerHTML = `<span class="dot ${muted ? 'warn' : state.tg.ready ? 'on' : state.tg.has_token ? 'warn' : ''}"></span>`
      + (muted ? 'alerts muted' : state.tg.ready ? 'telegram' : state.tg.has_token ? 'no chat' : 'telegram off');
  }

  const sh = $('#sheet-chip');
  if (sh && state.sheets) {
    sh.innerHTML = `<span class="dot ${state.sheets.configured ? (state.sheets.auto ? 'on' : 'warn') : ''}"></span>`
      + (state.sheets.configured ? (state.sheets.auto ? 'sheet auto' : 'sheet manual') : 'sheet off');
  }

  const actBadge = $('#act-badge');
  if (actBadge) {
    const t = state.work && state.work.totals;
    const n = t ? t.disputes + t.warnings + t.reviews + t.capturable : 0;
    actBadge.textContent = n > 99 ? '99+' : n;
    actBadge.style.display = n ? '' : 'none';
  }

  const badge = $('#alerts-badge');
  if (badge) {
    const n = state.events.filter((e) => e.severity === 'critical').length;
    badge.textContent = n > 99 ? '99+' : n;
    badge.style.display = n ? '' : 'none';
  }
}

// --- derived data -----------------------------------------------------------

/** Daily rows for one account, newest last, gaps filled so sparklines are honest. */
function seriesFor(accountId, days = 14) {
  const rows = state.stats.per_account.filter((r) => r.account_id === accountId);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ day, volume: r ? r.volume : 0, sales: r ? r.sales : 0, disputes: r ? r.disputes : 0 });
  }
  return out;
}

/** Disputes per 100 sales over the window — the number that predicts trouble. */
function disputeRate(accountId) {
  const rows = state.stats.per_account.filter((r) => r.account_id === accountId);
  const sales = rows.reduce((s, r) => s + (r.sales || 0), 0);
  const disputes = rows.reduce((s, r) => s + (r.disputes || 0), 0);
  if (!sales) return { rate: null, sales, disputes };
  return { rate: (disputes / sales) * 100, sales, disputes };
}

function groupName(id) {
  return state.groups.find((g) => g.id === id)?.name || 'Ungrouped';
}

function visibleAccounts() {
  const q = state.acctFilter.trim().toLowerCase();
  let list = state.accounts;
  if (state.healthFilter) list = list.filter((a) => a.health === state.healthFilter);
  if (q) {
    list = list.filter((a) => [a.label, a.business_name, a.legal_name, a.stripe_id,
      a.login_email, a.website, groupName(a.group_id)]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  const { key, dir } = state.acctSort;
  return [...list].sort((a, b) => {
    if (key === 'health') {
      return (HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health)) * dir;
    }
    if (key === 'group') return String(groupName(a.group_id)).localeCompare(String(groupName(b.group_id))) * dir;
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'number' || typeof bv === 'number') return ((av || 0) - (bv || 0)) * dir;
    return String(av || '').localeCompare(String(bv || '')) * dir;
  });
}

// --- rendering --------------------------------------------------------------

const PAGE_TITLE = {
  pulse: 'Pulse', accounts: 'Accounts', act: 'Act', alerts: 'Alerts', settings: 'Settings',
};

function render() {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const title = $('#page-title');
  if (title) title.textContent = PAGE_TITLE[state.tab] || 'Stripe Tracker';
  const view = $('#view');
  if (state.tab === 'pulse') renderPulse(view);
  else if (state.tab === 'accounts') renderAccounts(view);
  else if (state.tab === 'act') renderAct(view);
  else if (state.tab === 'alerts') renderAlerts(view);
  else renderSettings(view);
}

async function refresh() { await loadState(); render(); }

// ============================================================================
// Pulse
// ============================================================================

function renderPulse(root) {
  const a = state.accounts;
  const rows = state.stats.totals;
  const last30 = rows.slice(-30);
  const prev = last30.slice(0, Math.floor(last30.length / 2));
  const recent = last30.slice(Math.floor(last30.length / 2));

  const sum = (list, k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const volNow = sum(recent, 'volume');
  const volPrev = sum(prev, 'volume');
  const delta = volPrev > 0 ? ((volNow - volPrev) / volPrev) * 100 : null;

  const salesToday = a.reduce((s, x) => s + (x.sales_today || 0), 0);
  const volToday = a.reduce((s, x) => s + (x.volume_today || 0), 0);
  const disputes30 = sum(last30, 'disputes');
  const sales30 = sum(last30, 'sales');
  const rate30 = sales30 ? (disputes30 / sales30) * 100 : null;

  const counts = {};
  for (const x of a) counts[x.health] = (counts[x.health] || 0) + 1;
  const bad = a.filter((x) => BAD.includes(x.health));

  const needs = [...bad].sort(
    (x, y) => HEALTH_ORDER.indexOf(x.health) - HEALTH_ORDER.indexOf(y.health)
  );

  root.innerHTML = `
    <div class="page">
      ${state.lastStall ? `<div class="warn-note crit" style="margin-bottom:14px">
        <b>Monitoring stalled once</b> — a check ran far past its interval and the watchdog released it
        (${esc(ago(state.lastStall))}). Alerts resumed automatically.
      </div>` : ''}

      <div class="kpis">
        <div class="kpi">
          <div class="kpi-label">Volume · 30 days</div>
          <div class="kpi-val">${compact(sum(last30, 'volume'))}</div>
          <div class="kpi-sub">
            ${delta === null ? `${sales30} sales` : `
              <span class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}%</span>
              vs the previous ${prev.length} days`}
          </div>
          <canvas class="kpi-spark" data-spark="volume"></canvas>
        </div>

        <div class="kpi">
          <div class="kpi-label">Today</div>
          <div class="kpi-val good">${compact(volToday)}</div>
          <div class="kpi-sub">${salesToday} sale${salesToday === 1 ? '' : 's'} across the fleet</div>
          <canvas class="kpi-spark" data-spark="sales"></canvas>
        </div>

        <div class="kpi">
          <div class="kpi-label">Available</div>
          <div class="kpi-multi">
            <b>${esc(moneyMap(state.totals.available, { compact: true }))}</b><br>
            <span>pending ${esc(moneyMap(state.totals.pending, { compact: true }))}</span>
          </div>
          <div class="kpi-sub" style="margin-top:8px">Currencies kept separate, never summed</div>
        </div>

        <div class="kpi">
          <div class="kpi-label">Dispute rate · 30d</div>
          <div class="kpi-val ${rate30 === null ? '' : rate30 >= 0.75 ? 'crit' : rate30 >= 0.4 ? 'warn' : 'good'}">
            ${rate30 === null ? '—' : rate30.toFixed(2) + '<small>%</small>'}
          </div>
          <div class="kpi-sub">${disputes30} dispute${disputes30 === 1 ? '' : 's'} in ${sales30} sales${rate30 !== null && rate30 >= 0.75 ? ' · above Stripe’s 0.75% line' : ''}</div>
          <canvas class="kpi-spark" data-spark="disputes"></canvas>
        </div>

        <div class="kpi">
          <div class="kpi-label">Needs attention</div>
          <div class="kpi-val ${bad.length ? 'warn' : 'good'}">${bad.length}<small>/ ${a.length}</small></div>
          <div class="kpi-sub">${bad.length ? 'listed on the right' : 'every account healthy'}</div>
        </div>
      </div>

      <div class="grid-2">
        <div>
          <div class="card">
            <div class="card-head">
              <h3>Volume, last 30 days</h3>
              <div class="spacer"></div>
              <span class="eyebrow">daily</span>
            </div>
            <div class="chart-wrap">
              <canvas id="main-chart"></canvas>
              <div class="chart-tip" id="chart-tip"></div>
            </div>
            <div class="chart-legend">
              <span><i style="background:var(--good)"></i>Volume</span>
              <span><i style="background:var(--crit)"></i>Disputes (scaled)</span>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Fleet health</h3></div>
            <div class="card-sub">${a.length} accounts. Click a band to filter the list.</div>
            <div class="fleet">
              ${HEALTH_ORDER.filter((h) => counts[h]).map((h) => `
                <button class="fleet-seg" data-h="${h}" style="flex:${counts[h]}"
                        title="${counts[h]} ${esc(HEALTH[h])}">${counts[h] > 1 ? counts[h] : ''}</button>`).join('')}
            </div>
            <div class="fleet-key">
              ${HEALTH_ORDER.filter((h) => counts[h]).map((h) => `
                <button data-key="${h}"><i class="fleet-seg" data-h="${h}"></i>${esc(HEALTH[h])} · ${counts[h]}</button>`).join('')}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>What needs you</h3></div>
          <div class="card-sub">Worst first. Click through to the account.</div>
          ${needs.length ? `<div class="attn">${needs.slice(0, 14).map((x) => `
            <button class="attn-row" data-open="${x.id}">
              <span class="hb hb-${esc(x.health)}">${esc(HEALTH[x.health] || x.health)}</span>
              <span>
                <span class="attn-name">${esc(x.label || 'unnamed')}</span>
                <span class="attn-why">${esc(x.requirements || x.disabled_reason || x.last_error || groupName(x.group_id))}</span>
              </span>
              <span class="attn-right">${esc(ago(x.last_checked))}</span>
            </button>`).join('')}
            ${needs.length > 14 ? `<div class="side-note" style="padding:10px 12px">…and ${needs.length - 14} more</div>` : ''}
          </div>` : '<div class="empty" style="padding:34px"><b>All clear</b>Nothing is restricted, missing documents or unreachable.</div>'}
        </div>
      </div>
    </div>`;

  // charts
  const tip = $('#chart-tip');
  const chart = $('#main-chart');
  if (chart) areaChart(chart, last30, { valueKey: 'volume', lineKey: 'disputes', tip, height: 200 });

  $$('[data-spark]').forEach((c) => {
    const key = c.dataset.spark;
    const color = key === 'disputes' ? css('--crit') : key === 'sales' ? css('--info') : css('--good');
    sparkline(c, last30.map((r) => r[key] || 0), { color, height: 34 });
  });

  $$('.fleet-seg[data-h]', root).forEach((b) => {
    if (!b.dataset.h || b.tagName !== 'BUTTON') return;
    b.onclick = () => { state.healthFilter = b.dataset.h; state.tab = 'accounts'; render(); };
  });
  $$('.fleet-key [data-key]').forEach((b) => {
    b.onclick = () => { state.healthFilter = b.dataset.key; state.tab = 'accounts'; render(); };
  });
  $$('[data-open]').forEach((b) => {
    b.onclick = () => openCredentials(Number(b.dataset.open), 'login');
  });
}

// ============================================================================
// Accounts
// ============================================================================

function renderAccounts(root) {
  const counts = {};
  for (const x of state.accounts) counts[x.health] = (counts[x.health] || 0) + 1;
  const list = visibleAccounts();

  root.innerHTML = `
    <div class="page">
      <div class="toolbar">
        <button class="btn" id="add-acct">+ Stripe account</button>
        <button class="btn secondary" id="add-group">+ Group</button>
        <button class="btn secondary" id="poll-now">⟳ Check all now</button>
        <div class="spacer"></div>
        <div class="search-box">
          <input type="search" id="acct-q" placeholder="Filter accounts…" value="${esc(state.acctFilter)}">
        </div>
        <div class="view-switch">
          <button data-view="table" class="${state.acctView === 'table' ? 'active' : ''}">Table</button>
          <button data-view="board" class="${state.acctView === 'board' ? 'active' : ''}">Board</button>
          <button data-view="orbit" class="${state.acctView === 'orbit' ? 'active' : ''}">Orbit 3D</button>
        </div>
      </div>

      <div class="toolbar filters">
        <button class="fchip ${!state.healthFilter ? 'on' : ''}" data-hf="">All <span class="n">${state.accounts.length}</span></button>
        ${HEALTH_ORDER.filter((h) => counts[h]).map((h) => `
          <button class="fchip ${state.healthFilter === h ? 'on' : ''}" data-hf="${h}">
            ${esc(HEALTH[h])} <span class="n">${counts[h]}</span>
          </button>`).join('')}
        <div class="spacer"></div>
        <span class="side-note">${list.length} shown${state.acctView === 'board' ? ' · drag cards freely, drop one on another group to move it' : ''}</span>
      </div>

      <div id="acct-body"></div>
    </div>`;

  $('#acct-q').oninput = (e) => {
    state.acctFilter = e.target.value;
    renderAcctBody();
    $('#acct-q').focus();
  };
  $$('[data-hf]').forEach((b) => {
    b.onclick = () => { state.healthFilter = b.dataset.hf || null; render(); };
  });
  $$('[data-view]').forEach((b) => {
    b.onclick = () => {
      state.acctView = b.dataset.view;
      writePref('acctView', state.acctView);
      render();
    };
  });

  $('#add-group').onclick = async () => {
    const name = await ask({ title: 'New group', label: 'Group name (brand)', placeholder: 'e.g. Northwind' });
    if (name === null) return;
    await api('POST', '/groups', { name: name.trim() || 'New group' });
    await refresh();
  };

  $('#add-acct').onclick = async () => {
    const label = await ask({ title: 'New Stripe account', label: 'Name for this account', placeholder: 'e.g. Northwind US' });
    if (label === null) return;
    const { id } = await api('POST', '/accounts', { label: label.trim() || 'New account' });
    await refresh();
    promptForKey(id);
  };

  $('#poll-now').onclick = async () => {
    const btn = $('#poll-now');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const r = await api('POST', '/poll');
      await Promise.all([loadState(), loadStats()]);
      render();
      const failed = r.results.filter((x) => x.ok === false).length;
      toast(`Checked ${r.results.length} account${r.results.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}. Telegram sent ${r.telegram.sent || 0}.`, failed ? '' : 'good');
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = '⟳ Check all now';
    }
  };

  renderAcctBody();
}

function renderAcctBody() {
  const body = $('#acct-body');
  if (!body) return;
  // The 3D view owns an animation loop and pointer handlers; tear it down
  // whenever we leave it rather than leaving a canvas running off-screen.
  if (orbit && state.acctView !== 'orbit') { orbit.dispose(); orbit = null; }
  if (state.acctView === 'table') renderTable(body);
  else if (state.acctView === 'orbit') renderOrbit(body);
  else renderBoard(body);
}

// --- orbit (3D) -------------------------------------------------------------

let orbit = null;

/**
 * The same structure as the board — group hubs, accounts on connector lines —
 * laid out in three dimensions. Depth lets the whole fleet sit on one screen,
 * and anything needing a decision pulses where it is.
 */
function renderOrbit(root) {
  const list = visibleAccounts();
  root.innerHTML = `
    <div class="orbit-wrap">
      <canvas id="orbit-canvas" aria-label="3D view of the account fleet"></canvas>
      <div class="orbit-tip" id="orbit-tip" hidden></div>
      <div class="orbit-controls">
        <button class="btn secondary sm" id="orbit-spin">Pause spin</button>
        <button class="btn secondary sm" id="orbit-reset">Reset view</button>
      </div>
      <div class="orbit-legend">
        ${HEALTH_ORDER.map((h) => `<span><i style="background:${Orbit.HEALTH_COLOR[h]}"></i>${esc(HEALTH[h])}</span>`).join('')}
      </div>
      <div class="orbit-hint">drag to rotate · scroll to zoom · click a node to open it</div>
    </div>`;

  const canvas = $('#orbit-canvas', root);
  const tip = $('#orbit-tip', root);

  orbit = Orbit.create(canvas, {
    getData: () => ({
      groups: state.groups,
      accounts: visibleAccounts(),
      groupOf: (id) => groupName(id),
    }),
    onSelect: (a) => openCredentials(a.id, 'login'),
    onHover: (a, x, y) => {
      if (!a) { tip.hidden = true; return; }
      const rect = canvas.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(x - rect.left + 14, 8), rect.width - 220) + 'px';
      tip.style.top = Math.max(y - rect.top - 10, 8) + 'px';
      tip.innerHTML = `
        <div class="ot-name">${esc(a.label || 'unnamed')}</div>
        <div class="ot-row"><span class="hb hb-${esc(a.health)}">${esc(HEALTH[a.health] || a.health)}</span></div>
        <div class="ot-row">${esc(groupName(a.group_id))}</div>
        <div class="ot-row mono">${esc(moneyMap(a.balances_available, { compact: true }))} available</div>
        <div class="ot-row mono">${a.sales_today || 0} sales today · ${compact(a.volume_today)}</div>`;
    },
  });

  $('#orbit-spin').onclick = (e) => { e.target.textContent = orbit.toggleSpin() ? 'Pause spin' : 'Resume spin'; };
  $('#orbit-reset').onclick = () => orbit.resetView();

  if (!list.length) {
    root.insertAdjacentHTML('beforeend',
      '<div class="empty" style="margin-top:12px"><b>Nothing to show</b>Clear the filter to see the fleet.</div>');
  }
}

const COLUMNS = [
  { key: 'label', label: 'Account' },
  { key: 'group', label: 'Group' },
  { key: 'health', label: 'Health' },
  { key: 'balance_available', label: 'Available', num: true },
  { key: 'balance_pending', label: 'Pending', num: true },
  { key: 'volume_today', label: 'Today', num: true },
  { key: 'spark', label: '14 days', sort: false },
  { key: 'dispute', label: 'Dispute rate', num: true, sort: false },
  { key: 'last_checked', label: 'Checked' },
  { key: 'actions', label: '', sort: false },
];

function renderTable(root) {
  const list = visibleAccounts();
  if (!list.length) {
    root.innerHTML = `<div class="empty"><b>Nothing matches</b>${state.accounts.length
      ? 'Try a different filter.' : 'Add a Stripe account to get started.'}</div>`;
    return;
  }

  const arrow = (k) => (state.acctSort.key === k ? `<span class="arrow">${state.acctSort.dir > 0 ? '↑' : '↓'}</span>` : '');

  root.innerHTML = `
    <div class="table-wrap">
      <table class="acct-table">
        <thead><tr>
          ${COLUMNS.map((c) => `
            <th class="${c.num ? 'num ' : ''}${c.sort === false ? 'no-sort' : ''}"
                ${c.sort === false ? '' : `data-sort="${c.key}"`}>${esc(c.label)}${c.sort === false ? '' : arrow(c.key)}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${list.map((x) => {
            const dr = disputeRate(x.id);
            const rateCls = dr.rate === null ? 'cool' : dr.rate >= 0.75 ? 'hot' : dr.rate >= 0.4 ? 'warm' : 'cool';
            return `
            <tr data-row="${x.id}">
              <td class="name">${esc(x.label) || '<i>unnamed</i>'}
                ${x.stripe_id ? `<span class="sid">${esc(x.stripe_id)}</span>` : ''}</td>
              <td class="grp">${esc(groupName(x.group_id))}</td>
              <td><span class="hb hb-${esc(x.health)}">${esc(HEALTH[x.health] || x.health)}</span></td>
              <td class="num" title="${esc(moneyMap(x.balances_available))}">${esc(moneyMap(x.balances_available, { compact: true }))}</td>
              <td class="num" title="${esc(moneyMap(x.balances_pending))}">${esc(moneyMap(x.balances_pending, { compact: true }))}</td>
              <td class="num">${x.sales_today || 0} · ${compact(x.volume_today)}</td>
              <td class="spark-cell"><canvas data-row-spark="${x.id}"></canvas></td>
              <td class="num"><span class="risk ${rateCls}">${dr.rate === null ? '—' : dr.rate.toFixed(2) + '%'}</span></td>
              <td class="num" style="color:var(--faint)">${esc(ago(x.last_checked))}</td>
              <td>
                <div class="row-actions">
                  <button class="mini activity-launch" data-activity="${x.id}" title="Sales and payout details">Activity</button>
                  <button class="mini" data-poll="${x.id}" title="check now">⟳</button>
                  <button class="mini" data-creds="${x.id}" title="credentials">🔒</button>
                  <button class="mini" data-key="${x.id}" title="API key">🔑</button>
                  <button class="mini" data-del="${x.id}" title="remove">✕</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  $$('[data-sort]', root).forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      state.acctSort = { key: k, dir: state.acctSort.key === k ? -state.acctSort.dir : 1 };
      renderAcctBody();
    };
  });

  $$('[data-row-spark]', root).forEach((c) => {
    const id = Number(c.dataset.rowSpark);
    sparkline(c, seriesFor(id, 14).map((r) => r.volume), { color: css('--good'), height: 24 });
  });

  $$('[data-row]', root).forEach((tr) => {
    tr.ondblclick = () => openCredentials(Number(tr.dataset.row), 'login');
  });

  wireAccountActions(root);
}

function wireAccountActions(root) {
  $$('[data-key]', root).forEach((el) => { el.onclick = (e) => { e.stopPropagation(); promptForKey(Number(el.dataset.key)); }; });
  $$('[data-creds]', root).forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openCredentials(Number(el.dataset.creds), 'login'); }; });
  $$('[data-biz]', root).forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openCredentials(Number(el.dataset.biz), 'business'); }; });

  $$('[data-poll]', root).forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const old = el.textContent;
      el.textContent = '…';
      try {
        const r = await api('POST', `/accounts/${el.dataset.poll}/poll`);
        await Promise.all([loadState(), loadStats()]);
        render();
        toast(r.ok ? `Updated — ${HEALTH[r.health] || r.health}` : `Failed: ${r.error || r.skipped}`, r.ok ? 'good' : 'error');
      } catch (err) {
        toast(err.message, 'error');
        el.textContent = old;
      }
    };
  });

  $$('[data-del]', root).forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const a = state.accounts.find((x) => x.id === Number(el.dataset.del));
      const ok = await confirmDialog({
        title: 'Remove from tracker',
        body: `<b>${esc(a?.label || 'This account')}</b> will be removed from Stripe Tracker, along with its stored credentials and history.<br><br>Your Stripe account itself is untouched.`,
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;
      await api('DELETE', `/accounts/${a.id}`);
      await refresh();
      toast('Removed.', 'good');
    };
  });
}

// --- board view (free-drag canvas) ------------------------------------------

const CARD_W = 268;

function acctHTML(x) {
  const h = x.health || 'unknown';
  const creds = x.has_password || x.has_twofa || x.login_email;
  const pos = Number.isFinite(x.pos_x) && Number.isFinite(x.pos_y) ? `left:${x.pos_x}px; top:${x.pos_y}px;` : '';
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
        <span class="hb hb-${esc(h)}">${esc(HEALTH[h] || h)}</span>
        ${x.stripe_id ? `<span class="sid">${esc(x.stripe_id)}</span>` : ''}
      </div>
      <div class="figs">
        <div class="fig"><span>available</span><b class="g">${esc(moneyMap(x.balances_available, { compact: true }))}</b></div>
        <div class="fig"><span>today</span><b>${x.sales_today || 0} · ${compact(x.volume_today)}</b></div>
      </div>
      <canvas class="acct-spark" data-card-spark="${x.id}"></canvas>
      ${x.requirements ? `<div class="req">📄 ${esc(x.requirements)}</div>` : ''}
      ${x.disabled_reason ? `<div class="req">⛔ ${esc(x.disabled_reason)}</div>` : ''}
      ${x.last_error ? `<div class="err">🔌 ${esc(x.last_error)}</div>` : ''}
      <div class="pills">
        <button class="pill activity-launch" data-activity="${x.id}">Sales & payouts</button>
        ${x.has_key
          ? `<button class="pill ok" data-key="${x.id}" title="checked ${esc(ago(x.last_checked))}">🔑 ${esc(x.key_hint)}</button>`
          : `<button class="pill todo" data-key="${x.id}">🔑 add API key</button>`}
        ${creds
          ? `<button class="pill ok" data-creds="${x.id}">🔒 ${esc(x.login_email || 'credentials')}</button>`
          : `<button class="pill todo" data-creds="${x.id}">🔒 add login</button>`}
        ${x.business_fields
          ? `<button class="pill ok" data-biz="${x.id}" title="${esc(x.legal_name || '')}">🏢 ${x.business_fields} field${x.business_fields === 1 ? '' : 's'}</button>`
          : `<button class="pill todo" data-biz="${x.id}">🏢 add business info</button>`}
      </div>
    </div>`;
}

/**
 * The board, laid out rather than dragged.
 *
 * Free positioning is lovely with eight accounts and unusable with forty: cards
 * end up overlapping, scattered and impossible to scan. So the default is a
 * computed grid inside collapsible group sections — the same group-then-accounts
 * structure, but it cannot become a mess. Dragging is still there behind
 * "Free layout" for anyone who wants it.
 */
function renderBoard(root) {
  if (state.boardFree) return renderFreeBoard(root);

  const shown = visibleAccounts();
  const byGroup = new Map(state.groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const a of shown) {
    if (a.group_id && byGroup.has(a.group_id)) byGroup.get(a.group_id).push(a);
    else ungrouped.push(a);
  }

  const SORTS = {
    health: (a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health),
    volume: (a, b) => (b.volume_today || 0) - (a.volume_today || 0),
    name: (a, b) => String(a.label || '').localeCompare(String(b.label || '')),
    balance: (a, b) => (b.balance_available || 0) - (a.balance_available || 0),
  };
  const sorter = SORTS[state.boardSort] || SORTS.health;

  const section = (g, list) => {
    if (!list.length && g.id !== 0) return groupSection(g, list, sorter);
    if (!list.length) return '';
    return groupSection(g, list, sorter);
  };

  root.innerHTML = `
    <div class="board-toolbar">
      <label class="switch-row" style="margin:0">Sort
        <select id="b-sort" style="width:auto;margin-left:6px">
          <option value="health"${state.boardSort === 'health' ? ' selected' : ''}>Needs attention first</option>
          <option value="volume"${state.boardSort === 'volume' ? ' selected' : ''}>Volume today</option>
          <option value="balance"${state.boardSort === 'balance' ? ' selected' : ''}>Available balance</option>
          <option value="name"${state.boardSort === 'name' ? ' selected' : ''}>Name</option>
        </select>
      </label>
      <button class="btn secondary sm" id="b-compact">${state.boardCompact ? 'Comfortable' : 'Compact'}</button>
      <button class="btn secondary sm" id="b-collapse">${state.collapsed.size ? 'Expand all' : 'Collapse all'}</button>
      <div class="spacer"></div>
      <button class="btn secondary sm" id="b-free">Free layout</button>
    </div>
    <div class="board${state.boardCompact ? ' compact' : ''}">
      ${state.groups.map((g) => section(g, byGroup.get(g.id) || [])).join('')}
      ${ungrouped.length ? groupSection({ id: 0, name: 'Ungrouped' }, ungrouped, sorter) : ''}
    </div>`;

  $('#b-sort').onchange = (e) => { state.boardSort = e.target.value; writePref('boardSort', state.boardSort); renderAcctBody(); };
  $('#b-compact').onclick = () => {
    state.boardCompact = !state.boardCompact;
    writePref('boardCompact', state.boardCompact ? '1' : '0');
    renderAcctBody();
  };
  $('#b-collapse').onclick = () => {
    if (state.collapsed.size) state.collapsed.clear();
    else {
      state.groups.forEach((g) => state.collapsed.add(g.id));
      state.collapsed.add(0);
    }
    saveCollapsed();
    renderAcctBody();
  };
  $('#b-free').onclick = () => { state.boardFree = true; writePref('boardFree', '1'); renderAcctBody(); };

  $$('[data-grp]', root).forEach((h) => {
    h.onclick = () => {
      const id = Number(h.dataset.grp);
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      saveCollapsed();
      renderAcctBody();
    };
  });

  $$('[data-card-spark]', root).forEach((c) => {
    sparkline(c, seriesFor(Number(c.dataset.cardSpark), 14).map((r) => r.volume),
      { color: css('--c-green'), height: 26 });
  });

  $$('[data-rename]', root).forEach((el) => {
    el.classList.add('editable');
    el.onclick = (e) => {
      e.stopPropagation();
      const a = state.accounts.find((x) => x.id === Number(el.dataset.rename));
      if (a) inlineRename(el, a.label, (label) => api('PATCH', `/accounts/${a.id}`, { label }));
    };
  });

  wireAccountActions(root);
}

function saveCollapsed() {
  writePref('collapsedGroups', JSON.stringify([...state.collapsed]));
}

/** One group: a header that stays readable collapsed, and a grid of cards. */
function groupSection(g, list, sorter) {
  const open = !state.collapsed.has(g.id);
  const sorted = [...list].sort(sorter);
  const bad = list.filter((x) => BAD.includes(x.health)).length;

  const avail = {};
  for (const x of list) {
    for (const [c, v] of Object.entries(x.balances_available || {})) avail[c] = (avail[c] || 0) + v;
  }
  const today = list.reduce((n, x) => n + (x.volume_today || 0), 0);

  const counts = {};
  for (const x of list) counts[x.health] = (counts[x.health] || 0) + 1;

  return `
    <div class="grp${open ? '' : ' collapsed'}">
      <button class="grp-head" data-grp="${g.id}" aria-expanded="${open}">
        <span class="grp-caret">▼</span>
        <span>
          <span class="grp-name">${esc(g.name)}</span>
          <span class="grp-count"> · ${list.length} account${list.length === 1 ? '' : 's'}${bad ? ` · ${bad} need attention` : ''}</span>
        </span>
        <span class="grp-meta">
          <span class="grp-bar" title="${HEALTH_ORDER.filter((h) => counts[h]).map((h) => `${counts[h]} ${HEALTH[h]}`).join(', ')}">
            ${HEALTH_ORDER.filter((h) => counts[h]).map((h) => `
              <i style="flex:${counts[h]};background:${healthColor(h)}"></i>`).join('')}
          </span>
          <span class="grp-fig"><span>available</span><b>${esc(moneyMap(avail, { compact: true }))}</b></span>
          <span class="grp-fig"><span>today</span><b>${compact(today)}</b></span>
        </span>
      </button>
      <div class="grp-body">
        ${sorted.length ? `<div class="card-grid">${sorted.map(acctHTML).join('')}</div>`
          : '<div class="side-note">No accounts here yet.</div>'}
      </div>
    </div>`;
}

function healthColor(h) {
  return {
    healthy: css('--c-green'), docs: css('--c-amber'), restricted: css('--c-orange'),
    suspended: css('--c-red'), pending: css('--c-blue'), error: css('--c-purple'),
    unknown: css('--c-grey'),
  }[h] || css('--c-grey');
}

function renderFreeBoard(root) {
  const shown = new Set(visibleAccounts().map((a) => a.id));
  const grouped = new Map(state.groups.map((g) => [g.id, []]));
  const ungrouped = [];
  for (const a of state.accounts) {
    if (!shown.has(a.id)) continue;
    if (a.group_id && grouped.has(a.group_id)) grouped.get(a.group_id).push(a);
    else ungrouped.push(a);
  }

  const groupBlock = (g, list) => {
    const bad = list.filter((x) => BAD.includes(x.health)).length;
    const avail = {};
    for (const x of list) {
      for (const [c, v] of Object.entries(x.balances_available || {})) avail[c] = (avail[c] || 0) + v;
    }
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
              <div class="fig"><span>available</span><b class="g">${esc(moneyMap(avail, { compact: true }))}</b></div>
              <div class="fig"><span>today</span><b>${compact(list.reduce((s, x) => s + (x.volume_today || 0), 0))}</b></div>
            </div>
          </div>
        </div>
        <div class="canvas" data-canvas="${g.id}">
          ${list.map(acctHTML).join('')}
          ${list.length ? '' : '<span class="side-note drop-hint">drag accounts here</span>'}
        </div>
      </div>`;
  };

  root.innerHTML = `
    <div class="toolbar" style="margin-bottom:12px">
      <button class="btn secondary sm" id="tidy" title="re-flow every card into neat rows">Re-flow cards</button>
      <button class="btn secondary sm" id="b-structured">Back to organised layout</button>
      <span class="side-note">Free layout — drag cards anywhere; drop one on another group to move it.</span>
    </div>
    <div class="tree-wrap">
      ${state.groups.map((g) => groupBlock(g, grouped.get(g.id) || [])).join('')}
      ${groupBlock({ id: 0, name: 'Ungrouped' }, ungrouped)}
    </div>`;

  $('#b-structured').onclick = () => { state.boardFree = false; writePref('boardFree', '0'); renderAcctBody(); };

  $('#tidy').onclick = async () => {
    try {
      await api('POST', '/positions', state.accounts.map((a) => ({ id: a.id, x: null, y: null })));
      await refresh();
      toast('Cards re-flowed.', 'good');
    } catch (e) { toast(e.message, 'error'); }
  };

  $$('[data-card-spark]', root).forEach((c) => {
    const id = Number(c.dataset.cardSpark);
    sparkline(c, seriesFor(id, 14).map((r) => r.volume), { color: css('--good'), height: 26 });
  });

  $$('[data-rename-group]', root).forEach((el) => {
    el.classList.add('editable');
    el.onclick = () => {
      const g = state.groups.find((x) => x.id === Number(el.dataset.renameGroup));
      if (g) inlineRename(el, g.name, (name) => api('PATCH', `/groups/${g.id}`, { name }));
    };
  });

  $$('[data-del-group]', root).forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Delete group',
        body: 'Its accounts move to <b>Ungrouped</b>. Nothing else is removed.',
        confirmText: 'Delete group',
        danger: true,
      });
      if (!ok) return;
      await api('DELETE', `/groups/${el.dataset.delGroup}`);
      await refresh();
    };
  });

  $$('[data-rename]', root).forEach((el) => {
    el.classList.add('editable');
    el.onclick = (e) => {
      e.stopPropagation();
      const a = state.accounts.find((x) => x.id === Number(el.dataset.rename));
      if (a) inlineRename(el, a.label, (label) => api('PATCH', `/accounts/${a.id}`, { label }));
    };
  });

  wireAccountActions(root);
  layoutCards();
  attachCardDrag();
}

function layoutCards() {
  $$('.canvas').forEach((canvas) => {
    const cards = $$('.acct', canvas);
    const perRow = Math.max(1, Math.floor(((canvas.clientWidth || 900) - 20) / (CARD_W + 22)));
    let placed = 0;
    cards.forEach((card) => {
      const a = state.accounts.find((x) => x.id === Number(card.dataset.acct));
      if (a && Number.isFinite(a.pos_x) && Number.isFinite(a.pos_y)) return; // user-placed
      card.style.left = `${20 + (placed % perRow) * (CARD_W + 22)}px`;
      card.style.top = `${20 + Math.floor(placed / perRow) * 232}px`;
      placed++;
    });
    sizeCanvas(canvas);
  });
  drawGroupLines();
}

function sizeCanvas(canvas) {
  let maxBottom = 0;
  let maxRight = 0;
  $$('.acct', canvas).forEach((c) => {
    maxBottom = Math.max(maxBottom, c.offsetTop + c.offsetHeight);
    maxRight = Math.max(maxRight, c.offsetLeft + c.offsetWidth);
  });
  canvas.style.height = `${Math.max(84, maxBottom + 24)}px`;
  canvas.style.minWidth = `${Math.max(0, maxRight + 24)}px`;
}

function groupUnder(x, y) {
  let best = null;
  for (const g of $$('.tree-group')) {
    const r = g.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = g;
  }
  return best;
}

/**
 * The click-suppression listener used to be added to #view on every render.
 * #view is never replaced — only its innerHTML — so they stacked up, one more
 * live capture listener per refresh, for the lifetime of the tab.
 */
let suppressClick = false;
let dragWired = false;

function wireDragOnce() {
  if (dragWired) return;
  dragWired = true;
  $('#view').addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

function attachCardDrag() {
  wireDragOnce();
  let drag = null;

  $$('.acct').forEach((card) => {
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, .pill')) return; // let controls do their job
      drag = {
        card,
        canvas: card.closest('.canvas'),
        sourceGroup: card.closest('.tree-group'),
        id: Number(card.dataset.acct),
        startX: e.clientX, startY: e.clientY,
        origX: card.offsetLeft, origY: card.offsetTop,
        moved: false,
      };
      try { card.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    });

    card.addEventListener('pointermove', (e) => {
      if (!drag || drag.card !== card) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
      if (!drag.moved) { drag.moved = true; card.classList.add('dragging'); }
      card.style.left = `${drag.origX + dx}px`;
      card.style.top = `${drag.origY + dy}px`;
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
      try {
        if (targetGroup && targetGroup !== d.sourceGroup) {
          const gid = Number(targetGroup.dataset.group);
          const r = $('.canvas', targetGroup).getBoundingClientRect();
          const x = Math.max(0, e.clientX - r.left - CARD_W / 2);
          const y = Math.max(0, e.clientY - r.top - 20);
          await api('PATCH', `/accounts/${d.id}`, { group_id: gid === 0 ? null : gid });
          await api('POST', '/positions', [{ id: d.id, x, y }]);
          await refresh();
        } else {
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
      } catch (err) { toast(err.message, 'error'); }
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

function drawGroupLines() {
  $$('.tree-group').forEach((group) => {
    const svg = $('svg.lines', group);
    const head = $('.group-node', group);
    if (!svg || !head) return;
    const gRect = group.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${gRect.width} ${gRect.height}`);
    const b = head.getBoundingClientRect();
    const x1 = b.left - gRect.left + b.width / 2;
    const y1 = b.bottom - gRect.top;
    let paths = '';
    $$('.canvas .acct', group).forEach((child) => {
      const c = child.getBoundingClientRect();
      const x2 = c.left - gRect.left + c.width / 2;
      const y2 = c.top - gRect.top;
      const my = (y1 + y2) / 2;
      paths += `<path d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" stroke="${css('--line')}" stroke-width="1.6" fill="none"/>`;
    });
    svg.innerHTML = paths;
  });
}

function inlineRename(el, current, onSave) {
  if (el.querySelector('input')) return;
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
    if (!save || value === (current || '').trim()) { el.innerHTML = original; return; }
    try { await onSave(value); await refresh(); }
    catch (e) { toast(e.message, 'error'); el.innerHTML = original; }
  };

  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  input.onpointerdown = (e) => e.stopPropagation();
  input.onclick = (e) => e.stopPropagation();
}

// ============================================================================
// Alerts
// ============================================================================

/**
 * Collapse identical repeats into one row.
 *
 * The history holds 1,742 events of which roughly 1,100 were the same handful
 * of connection blips repeating. Showing them one after another was the single
 * thing that made this tab unusable.
 */
function collapseEvents(list) {
  const out = [];
  const index = new Map();
  for (const ev of list) {
    const key = `${ev.account_id}|${ev.kind}|${ev.title}`;
    const hit = index.get(key);
    if (hit && out.length - hit.pos < 40) {
      hit.row.children.push(ev);
      continue;
    }
    const row = { ...ev, children: [] };
    index.set(key, { row, pos: out.length });
    out.push(row);
  }
  return out;
}

function renderAlerts(root) {
  const f = state.alertFilter;
  let list = state.events;
  if (f.sev) list = list.filter((e) => e.severity === f.sev);
  if (f.kind) list = list.filter((e) => e.kind === f.kind);
  if (f.account) list = list.filter((e) => e.account_id === f.account);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((e) => `${e.title} ${e.detail} ${e.account_label}`.toLowerCase().includes(q));
  }

  const sevCount = {};
  for (const e of state.events) sevCount[e.severity] = (sevCount[e.severity] || 0) + 1;
  const kindCount = {};
  for (const e of state.events) kindCount[e.kind] = (kindCount[e.kind] || 0) + 1;

  const rows = collapseEvents(list);
  const hidden = list.length - rows.length;

  root.innerHTML = `
    <div class="page">
      <div class="toolbar">
        <div class="filters">
          <button class="fchip ${!f.sev ? 'on' : ''}" data-sev="">All <span class="n">${state.events.length}</span></button>
          ${['critical', 'warning', 'good', 'info'].filter((s) => sevCount[s]).map((s) => `
            <button class="fchip ${f.sev === s ? 'on' : ''}" data-sev="${s}">${s} <span class="n">${sevCount[s]}</span></button>`).join('')}
        </div>
        <div class="spacer"></div>
        <div class="search-box"><input type="search" id="ev-q" placeholder="Search alerts…" value="${esc(f.q)}"></div>
        <select id="ev-kind" style="width:auto">
          <option value="">every kind</option>
          ${KINDS.filter(([k]) => kindCount[k]).map(([k, lbl]) => `
            <option value="${k}" ${f.kind === k ? 'selected' : ''}>${esc(lbl)} (${kindCount[k]})</option>`).join('')}
        </select>
        <select id="ev-acct" style="width:auto">
          <option value="">every account</option>
          ${state.accounts.map((a) => `<option value="${a.id}" ${f.account === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
        </select>
        <button class="btn secondary" id="clear-ev">Clear history</button>
      </div>

      <div class="side-note" style="margin-bottom:10px">
        ${rows.length} row${rows.length === 1 ? '' : 's'}${hidden > 0 ? ` · ${hidden} repeat${hidden === 1 ? '' : 's'} folded in` : ''}
        ${list.length !== state.events.length ? ` · filtered from ${state.events.length}` : ''}
      </div>

      ${rows.length ? `<div class="ev-list">${rows.map((e, i) => `
        <div class="ev sev-${esc(e.severity)}${e.children.length ? ' grouped' : ''}" ${e.children.length ? `data-expand="${i}"` : ''}>
          <div class="ico">${EV_ICON[e.kind] || 'ℹ️'}</div>
          <div class="body">
            <div class="t">${esc(e.title)}${e.children.length ? `<span class="rep">×${e.children.length + 1}</span>` : ''}</div>
            ${e.detail ? `<div class="d">${esc(e.detail)}</div>` : ''}
            ${e.children.length ? `<div class="ev-children" hidden data-children="${i}">
              ${e.children.slice(0, 25).map((c) => `
                <div class="ev-child"><span class="c-when">${esc(ago(c.created_at))}</span><span>${esc(c.detail || c.title)}</span></div>`).join('')}
              ${e.children.length > 25 ? `<div class="ev-child"><span class="c-when">…</span><span>${e.children.length - 25} more</span></div>` : ''}
            </div>` : ''}
          </div>
          <div class="when">${esc(ago(e.created_at))}${e.notified ? '<span class="sent">sent</span>' : ''}</div>
        </div>`).join('')}</div>`
      : `<div class="empty"><b>${state.events.length ? 'Nothing matches that filter' : 'Nothing yet'}</b>${state.events.length
        ? 'Try widening it.' : 'Alerts appear here and reach Telegram at the same moment.'}</div>`}
    </div>`;

  $$('[data-sev]').forEach((b) => {
    b.onclick = () => { state.alertFilter.sev = b.dataset.sev || null; render(); };
  });
  $('#ev-kind').onchange = (e) => { state.alertFilter.kind = e.target.value || null; render(); };
  $('#ev-acct').onchange = (e) => { state.alertFilter.account = Number(e.target.value) || null; render(); };
  $('#ev-q').oninput = (e) => {
    state.alertFilter.q = e.target.value;
    render();
    const q = $('#ev-q');
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  };

  $$('[data-expand]').forEach((el) => {
    el.onclick = () => {
      const kids = $(`[data-children="${el.dataset.expand}"]`, el);
      if (kids) kids.hidden = !kids.hidden;
    };
  });

  $('#clear-ev').onclick = async () => {
    const ok = await confirmDialog({
      title: 'Clear alert history',
      body: 'Removes every alert from this list. Messages already delivered stay in Telegram, and history in the daily charts is unaffected.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    await api('DELETE', '/events');
    await refresh();
  };
}

// ============================================================================
// Act — everything waiting on a decision, and the buttons to decide
// ============================================================================

/**
 * The worklist.
 *
 * Nothing here asks for an id. Every item arrives with the charge already
 * fetched — who paid, on what card, from where, how risky Stripe thought it
 * was — so the decision can be made from the row itself.
 */
async function loadWork(force = false) {
  if (state.workLoading) return;
  if (!force && state.work && Date.now() - state.workAt < 120000) return;
  state.workLoading = true;
  if (state.tab === 'act') render();
  try {
    state.work = await api('GET', '/worklist');
    state.workAt = Date.now();
    // Open the accounts that need something, so the first thing on screen is
    // the thing to do rather than a list of closed drawers.
    if (!state.openPanels.size) {
      state.work.accounts.filter((a) => a.todo > 0).slice(0, 4)
        .forEach((a) => state.openPanels.add(a.account_id));
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.workLoading = false;
    paintChips();
    if (state.tab === 'act') render();
  }
}

const dueIn = (unix) => {
  if (!unix) return null;
  const h = Math.round((unix * 1000 - Date.now()) / 3600000);
  if (h < 0) return { text: 'overdue', urgent: true };
  if (h < 24) return { text: `${h}h left`, urgent: true };
  if (h < 72) return { text: `${Math.round(h / 24)}d left`, urgent: true };
  return { text: `${Math.round(h / 24)}d left`, urgent: false };
};

const when = (unix) => (unix ? ago(new Date(unix * 1000).toISOString()) : '');

function renderAct(root) {
  const w = state.work;
  const t = w && w.totals;

  const accounts = w ? w.accounts : [];
  const q = state.workFilter === 'all' ? '' : state.workFilter;
  const visible = q === 'todo' ? accounts.filter((a) => a.todo > 0) : accounts;

  root.innerHTML = `
    <div class="page">
      <div class="wl-head">
        <div>
          <div class="wl-title">Control panel</div>
          <div class="wl-sub">
            ${w ? `${w.scanned} accounts · scanned in ${(w.took_ms / 1000).toFixed(1)}s · ${esc(ago(new Date(state.workAt).toISOString()))}`
                : 'Loading every account and everything you can do to it…'}
          </div>
          ${state.workLoading ? '<div class="wl-progress"><i></i></div>' : ''}
        </div>
        <div class="spacer"></div>
        <div class="view-switch">
          <button data-f="all" class="${state.workFilter === 'all' ? 'active' : ''}">All accounts</button>
          <button data-f="todo" class="${state.workFilter === 'todo' ? 'active' : ''}">Needs action</button>
        </div>
        <button class="btn secondary" id="wl-refresh"${state.workLoading ? ' disabled' : ''}>
          ${state.workLoading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      ${!w ? (state.workLoading
          ? '<div class="empty"><b>Opening every account…</b>Pulling payments, disputes, fraud warnings, held funds and balances — with the payment behind each one.</div>'
          : '<div class="empty"><b>Not loaded yet</b>Press Refresh.</div>')
        : !visible.length
        ? '<div class="empty ok-empty"><b>Nothing needs action</b>Every account is clear.</div>'
        : visible.map(accountPanel).join('')}

      <div class="warn-note" style="margin-top:18px">
        Everything here writes to Stripe with that account's own key, asks before it acts, carries an
        idempotency key so a retry can never act twice, and lands in Alerts as an audit trail.
      </div>
    </div>`;

  $('#wl-refresh').onclick = () => loadWork(true);
  $$('[data-f]', root).forEach((b) => {
    b.onclick = () => { state.workFilter = b.dataset.f; render(); };
  });
  $$('[data-panel]', root).forEach((h) => {
    h.onclick = () => {
      const id = Number(h.dataset.panel);
      if (state.openPanels.has(id)) state.openPanels.delete(id);
      else state.openPanels.add(id);
      render();
    };
  });
  wireActButtons(root);
}

/**
 * One account, fully opened up.
 *
 * The queue told you what was on fire. This tells you everything the key can
 * do to this account — refund any recent payment because you feel like it,
 * capture, block, pay out, cancel — without going and finding an id first.
 */
function accountPanel(row) {
  if (row.error) {
    return `<div class="ap">
      <div class="ap-head" style="cursor:default">
        <span class="ap-caret"> </span>
        <span><span class="ap-name">${esc(row.label)}</span>
          <span class="ap-sub">${esc(row.error)}</span></span>
      </div></div>`;
  }

  const id = row.account_id;
  const open = state.openPanels.has(id);
  const avail = row.balance && row.balance.available;
  const payable = avail && Object.values(avail).some((v) => v > 0.005);

  return `
    <div class="ap${open ? ' open' : ''}">
      <button class="ap-head" data-panel="${id}" aria-expanded="${open}">
        <span class="ap-caret">▶</span>
        <span>
          <span class="ap-name">${esc(row.label)}</span>
          <span class="ap-sub">
            <span class="hb hb-${esc(row.health)}">${esc(HEALTH[row.health] || row.health)}</span>
            &nbsp;${row.recent.length} recent payment${row.recent.length === 1 ? '' : 's'}
          </span>
        </span>
        <span class="ap-right">
          <span class="ap-fig"><span>available</span><b>${esc(moneyMap(avail, { compact: true }))}</b></span>
          <span class="ap-todo${row.todo ? '' : ' clear'}">${row.todo ? `${row.todo} to action` : 'clear'}</span>
        </span>
      </button>

      <div class="ap-body">
        <div class="ap-tools">
          <button class="btn sm" data-payout="${id}"${payable ? '' : ' disabled'}>Pay out ${payable ? esc(moneyMap(avail, { compact: true })) : '—'}</button>
          <button class="btn secondary sm" data-op2="blocklist" data-acct="${id}">Block list</button>
          <button class="btn secondary sm" data-op2="find" data-acct="${id}">Find by id or email</button>
          <button class="btn secondary sm" data-creds="${id}">Credentials</button>
          <button class="btn secondary sm" data-poll="${id}">Re-check now</button>
        </div>

        ${row.warnings.length ? section('Fraud warnings — refund stops the chargeback', row.warnings.map((wn) => {
          const ch = wn.charge || {};
          return payRow(id, ch, {
            tone: 'high',
            tag: esc(wn.fraud_type.replace(/_/g, ' ')),
            extra: `reported ${esc(when(wn.created))}`,
            actions: [
              `<button class="btn sm" data-refund="${id}" data-charge="${esc(ch.id || '')}" data-reason="fraudulent">Refund ${esc(money(ch.refundable, ch.currency))}</button>`,
              blockBtns(id, ch),
            ].join(''),
          });
        }).join('')) : ''}

        ${row.disputes.length ? section('Disputes', row.disputes.map((dp) => {
          const ch = dp.charge || {};
          const due = dueIn(dp.due_by);
          return `
            <div class="pay">
              <div class="pay-amt">${esc(money(dp.amount, dp.currency))}</div>
              <div>
                <div class="pay-who">${esc(ch.email || ch.name || 'unknown customer')}
                  <span class="pay-tag ${due && due.urgent ? 'high' : 'mid'}">${esc(dp.is_inquiry ? 'inquiry' : 'dispute')}</span>
                </div>
                <div class="pay-meta">
                  <span>${esc(String(dp.reason).replace(/_/g, ' '))}</span>
                  ${ch.card ? `<span>${esc(ch.card)}</span>` : ''}
                  ${due ? `<span>${esc(due.text)}</span>` : ''}
                  ${dp.submission_count ? `<span>evidence sent ${dp.submission_count}×</span>` : ''}
                </div>
              </div>
              <div></div>
              <div class="pay-acts">
                ${dp.is_inquiry && ch.id ? `<button class="btn sm" data-refund="${id}" data-charge="${esc(ch.id)}" data-reason="requested_by_customer">Refund</button>` : ''}
                <button class="btn secondary sm" data-evidence="${id}" data-dispute="${esc(dp.id)}">Evidence</button>
                <button class="btn danger sm" data-accept="${id}" data-dispute="${esc(dp.id)}" data-amount="${dp.amount}" data-cur="${esc(dp.currency)}">Accept</button>
              </div>
            </div>`;
        }).join('')) : ''}

        ${row.reviews.length ? section('Held for review', row.reviews.map((rv) => {
          const ch = rv.charge || {};
          return payRow(id, ch, {
            tone: 'mid', tag: 'held', extra: esc(rv.reason || 'manual'),
            actions: `
              <button class="btn sm" data-review="${id}" data-rev="${esc(rv.id)}" data-decision="approve">Approve</button>
              <button class="btn danger sm" data-review="${id}" data-rev="${esc(rv.id)}" data-decision="reject">Reject</button>`,
          });
        }).join('')) : ''}

        ${row.capturable.length ? section('Authorised but not captured', row.capturable.map((pi) => `
          <div class="pay">
            <div class="pay-amt">${esc(money(pi.capturable, pi.currency))}</div>
            <div>
              <div class="pay-who">${esc(pi.email || pi.description || 'uncaptured payment')}
                <span class="pay-tag mid">uncaptured</span></div>
              <div class="pay-meta"><span>authorised ${esc(when(pi.created))}</span>
                <span>of ${esc(money(pi.amount, pi.currency))}</span></div>
            </div>
            <div></div>
            <div class="pay-acts">
              <button class="btn sm" data-op2="capture" data-acct="${id}" data-pi="${esc(pi.id)}"
                data-amount="${pi.capturable}" data-total="${pi.amount}" data-cur="${esc(pi.currency)}">Capture</button>
              <button class="btn danger sm" data-op2="cancel-pi" data-acct="${id}" data-pi="${esc(pi.id)}">Cancel</button>
            </div>
          </div>`).join('')) : ''}

        ${row.payouts.length ? section('Payouts in flight', row.payouts.map((po) => `
          <div class="pay">
            <div class="pay-amt">${esc(money(po.amount, po.currency))}</div>
            <div>
              <div class="pay-who">Payout <span class="pay-tag done">${esc(po.status)}</span></div>
              <div class="pay-meta">${po.arrival_date ? `<span>arrives ${new Date(po.arrival_date * 1000).toDateString()}</span>` : ''}</div>
            </div>
            <div></div>
            <div class="pay-acts">
              ${po.cancellable
                ? `<button class="btn danger sm" data-op2="payout-cancel" data-acct="${id}" data-payout="${esc(po.id)}">Cancel</button>`
                : `<button class="btn danger sm" data-op2="payout-reverse" data-acct="${id}" data-payout="${esc(po.id)}">Reverse</button>`}
            </div>
          </div>`).join('')) : ''}

        ${row.recent.length ? section(`Recent payments — refund any of them`, row.recent.map((ch) => payRow(id, ch, {
          tone: ch.risk_level === 'highest' ? 'high' : ch.risk_level === 'elevated' ? 'mid' : '',
          tag: ch.refunded ? 'refunded' : ch.disputed ? 'disputed' : ch.risk_level || '',
          extra: esc(when(ch.created)),
          actions: ch.refunded || ch.disputed ? '' : [
            `<button class="btn secondary sm" data-refund="${id}" data-charge="${esc(ch.id)}" data-reason="requested_by_customer">Refund</button>`,
            `<button class="btn secondary sm" data-op2="${ch.fraud_report === 'fraudulent' ? 'safe' : 'fraud'}" data-acct="${id}" data-charge="${esc(ch.id)}">${ch.fraud_report === 'fraudulent' ? 'Mark safe' : 'Report fraud'}</button>`,
            blockBtns(id, ch),
          ].join(''),
        })).join('')) : '<div class="side-note">No payments in the recent window.</div>'}
      </div>
    </div>`;
}

function section(title, body) {
  if (!body) return '';
  return `<div class="ap-sec"><div class="ap-sec-title">${esc(title)}<i></i></div>${body}</div>`;
}

function blockBtns(id, ch) {
  return [
    ch.email ? `<button class="btn secondary sm" data-op2="block-email" data-acct="${id}" data-value="${esc(ch.email)}">Block email</button>` : '',
    ch.card_fingerprint ? `<button class="btn secondary sm" data-op2="block-card" data-acct="${id}" data-value="${esc(ch.card_fingerprint)}">Block card</button>` : '',
  ].join('');
}

/** One payment, stated fully, with its actions beside it. */
function payRow(id, ch, o) {
  const tagCls = o.tone === 'high' ? 'high' : o.tone === 'mid' ? 'mid' : 'done';
  return `
    <div class="pay">
      <div class="pay-amt">${esc(money(ch.amount, ch.currency))}</div>
      <div>
        <div class="pay-who">${esc(ch.email || ch.name || ch.description || 'no customer on file')}
          ${o.tag ? `<span class="pay-tag ${tagCls}">${esc(o.tag)}</span>` : ''}</div>
        <div class="pay-meta">
          ${ch.card ? `<span>${esc(ch.card)}</span>` : ''}
          ${ch.country ? `<span>${esc(ch.country)}</span>` : ''}
          ${o.extra ? `<span>${o.extra}</span>` : ''}
          ${ch.refunded_amount > 0 && !ch.refunded ? `<span>${esc(money(ch.refunded_amount, ch.currency))} refunded</span>` : ''}
          ${ch.risk_score !== undefined && ch.risk_score !== null ? `<span>risk ${ch.risk_score}</span>` : ''}
        </div>
      </div>
      <div>${ch.dashboard_url ? `<a class="wl-link" href="${esc(ch.dashboard_url)}" target="_blank" rel="noopener">Stripe ↗</a>` : ''}</div>
      <div class="pay-acts">${o.actions || ''}</div>
    </div>`;
}

function wireActButtons(root) {
  // Buttons that carry their own operation, used by the worklist rows.
  $$('[data-op2]', root).forEach((b) => {
    b.onclick = () => runWorkAction(b.dataset);
  });

  $$('[data-refund]', root).forEach((b) => {
    b.onclick = () => openRefund(Number(b.dataset.refund), b.dataset.charge, b.dataset.reason);
  });
  $$('[data-review]', root).forEach((b) => {
    b.onclick = () => doReview(Number(b.dataset.review), b.dataset.rev, b.dataset.decision);
  });
  $$('[data-accept]', root).forEach((b) => {
    b.onclick = () => doAcceptDispute(Number(b.dataset.accept), b.dataset.dispute, Number(b.dataset.amount), b.dataset.cur);
  });
  $$('[data-evidence]', root).forEach((b) => {
    b.onclick = () => openEvidence(Number(b.dataset.evidence), b.dataset.dispute);
  });
  $$('[data-payout]', root).forEach((b) => {
    b.onclick = () => openPayout(Number(b.dataset.payout));
  });
}


/** The worklist's own action dispatcher — everything already has its context. */
async function runWorkAction(d) {
  const id = Number(d.acct);
  const after = async (msg) => {
    toast(msg, 'good');
    await Promise.all([refresh(), loadWork(true)]);
  };

  try {
    switch (d.op2) {
      case 'fraud':
      case 'safe': {
        const report = d.op2 === 'fraud' ? 'fraudulent' : 'safe';
        const ok = await confirmDialog({
          title: report === 'fraudulent' ? 'Report as fraudulent' : 'Mark as safe',
          body: report === 'fraudulent'
            ? 'Tells Stripe this payment was fraud, so Radar learns from it and weights similar payments accordingly.'
            : 'Tells Stripe this payment was legitimate after all.',
          confirmText: 'Report',
        });
        if (!ok) return;
        await api('POST', `/accounts/${id}/fraud-report`, { charge_id: d.charge, report });
        return after(`Reported ${report}.`);
      }

      case 'blocklist':
        state.consoleAccount = id;
        return showBlockLists();
      case 'find':
        state.consoleAccount = id;
        return openFind(id);

      case 'block-email':
        return openBlock(id, 'email', d.value);
      case 'block-card':
        return openBlock(id, 'card_fingerprint', d.value);

      case 'capture':
        return openCapture(id, {
          id: d.pi,
          amount: Number(d.total),
          amount_capturable: Number(d.amount),
          currency: d.cur,
          raw_status: 'requires_capture',
        });

      case 'cancel-pi': {
        const ok = await confirmDialog({
          title: 'Cancel this payment',
          body: 'The authorisation is released and the customer is never charged. This cannot be undone.',
          confirmText: 'Cancel payment', danger: true,
        });
        if (!ok) return;
        await api('POST', `/accounts/${id}/cancel-payment`, { payment_intent: d.pi, reason: 'abandoned' });
        return after('Payment cancelled.');
      }

      case 'payout-cancel': {
        const ok = await confirmDialog({
          title: 'Cancel this payout',
          body: 'The payout is stopped and the money stays in your Stripe balance.',
          confirmText: 'Cancel payout', danger: true,
        });
        if (!ok) return;
        await api('POST', `/accounts/${id}/payout-action`, { payout_id: d.payout, op: 'cancel' });
        return after('Payout cancelled.');
      }

      default:
        return;
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Refund: load the real charge, show exactly what is at stake, then commit. */
async function openRefund(accountId, chargeId, presetReason) {
  const acct = state.accounts.find((a) => a.id === accountId);
  if (!chargeId) { toast('That warning has no charge attached.', 'error'); return; }

  let ch;
  try {
    toast('Loading the charge…');
    ch = await api('GET', `/accounts/${accountId}/charge/${encodeURIComponent(chargeId)}`);
  } catch (e) { toast(e.message, 'error'); return; }

  const { el, close } = openModal(`
    <div class="modal-head"><b>↩️ Refund — ${esc(acct ? acct.label : 'account')}</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="charge-card">
        <div class="cc-amount">${esc(money(ch.amount, ch.currency))}</div>
        <div class="cc-rows">
          ${ch.customer_email ? `<div><span>Customer</span><b>${esc(ch.customer_email)}</b></div>` : ''}
          ${ch.card ? `<div><span>Card</span><b>${esc(ch.card)}</b></div>` : ''}
          ${ch.description ? `<div><span>Description</span><b>${esc(ch.description)}</b></div>` : ''}
          ${ch.risk_level ? `<div><span>Radar risk</span><b>${esc(ch.risk_level)}</b></div>` : ''}
          <div><span>Already refunded</span><b>${esc(money(ch.amount_refunded, ch.currency))}</b></div>
          <div><span>Still refundable</span><b class="g">${esc(money(ch.refundable, ch.currency))}</b></div>
        </div>
      </div>

      ${ch.disputed ? '<div class="warn-note crit">Already disputed — a refund will not stop it now. Submit evidence or accept the dispute instead.</div>' : ''}
      ${ch.refunded ? '<div class="warn-note">Already fully refunded. Nothing left to do here.</div>' : ''}

      <label for="rf-amount">Amount — leave blank to refund all of it</label>
      <input type="number" id="rf-amount" step="0.01" min="0" max="${ch.refundable}" placeholder="${ch.refundable}">

      <label for="rf-reason">Reason</label>
      <select id="rf-reason">
        <option value="fraudulent"${presetReason === 'fraudulent' ? ' selected' : ''}>Fraudulent — also teaches Radar</option>
        <option value="requested_by_customer"${presetReason === 'requested_by_customer' ? ' selected' : ''}>Requested by customer</option>
        <option value="duplicate">Duplicate</option>
      </select>

      <div class="warn-note">This moves real money and cannot be undone.</div>
      <div id="rf-msg" class="side-note" style="margin-top:10px"></div>
    </div>
    <div class="modal-foot">
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn" data-go${ch.refunded || ch.disputed ? ' disabled' : ''}>Refund</button>
    </div>`);

  const msg = $('#rf-msg', el);
  $('[data-go]', el).onclick = async () => {
    const btn = $('[data-go]', el);
    btn.disabled = true;
    msg.textContent = 'Sending to Stripe…';
    try {
      const r = await api('POST', `/accounts/${accountId}/refund`, {
        charge_id: ch.id,
        amount: $('#rf-amount', el).value,
        reason: $('#rf-reason', el).value,
      });
      close();
      toast(`Refunded ${money(r.refund.amount, r.refund.currency)}.`, 'good');
      await Promise.all([refresh(), loadWork(true)]);
    } catch (e) {
      btn.disabled = false;
      msg.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
    }
  };
}

async function doReview(accountId, reviewId, decision) {
  const ok = await confirmDialog({
    title: decision === 'approve' ? 'Approve this payment' : 'Reject this payment',
    body: decision === 'approve'
      ? 'Stripe releases the payment and the funds are captured.'
      : 'Stripe cancels the payment and the cardholder is refunded.',
    confirmText: decision === 'approve' ? 'Approve' : 'Reject',
    danger: decision === 'reject',
  });
  if (!ok) return;
  try {
    await api('POST', `/accounts/${accountId}/review`, { review_id: reviewId, decision });
    toast(`Review ${decision}d.`, 'good');
    await Promise.all([refresh(), loadWork(true)]);
  } catch (e) { toast(e.message, 'error'); }
}

async function doAcceptDispute(accountId, disputeId, amount, currency) {
  const ok = await confirmDialog({
    title: 'Accept this dispute',
    body: `You give up <b>${esc(money(amount, currency))}</b>. The funds stay withdrawn, the chargeback `
      + 'stands, and this cannot be reversed. Worth doing only when you know you would lose.',
    confirmText: 'Accept and lose the funds',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', `/accounts/${accountId}/dispute/close`, { dispute_id: disputeId });
    toast('Dispute accepted.', 'good');
    await Promise.all([refresh(), loadWork(true)]);
  } catch (e) { toast(e.message, 'error'); }
}

const EVIDENCE_FIELDS = [
  ['product_description', 'What was sold'],
  ['customer_name', 'Customer name'],
  ['customer_email_address', 'Customer email'],
  ['billing_address', 'Billing address'],
  ['shipping_carrier', 'Shipping carrier'],
  ['shipping_tracking_number', 'Tracking number'],
  ['shipping_date', 'Shipping date'],
  ['service_date', 'Service date'],
  ['refund_policy_disclosure', 'How the refund policy was shown'],
  ['cancellation_policy_disclosure', 'How the cancellation policy was shown'],
  ['uncategorized_text', 'Anything else worth saying'],
];

function openEvidence(accountId, disputeId) {
  const { el, close } = openModal(`
    <div class="modal-head"><b>⚠️ Dispute evidence</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="side-note" style="margin:10px 0">
        Save a draft as often as you like. Submitting sends it to the bank and locks it for good.
      </div>
      ${EVIDENCE_FIELDS.map(([k, lbl]) => `
        <label for="ev-${k}">${esc(lbl)}</label>
        <input type="text" id="ev-${k}" data-ev="${k}" autocomplete="off">`).join('')}
      <div class="warn-note">Submitting is final — evidence cannot be edited afterwards.</div>
      <div id="ev-msg" class="side-note" style="margin-top:10px"></div>
    </div>
    <div class="modal-foot">
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn secondary" data-draft>Save draft</button>
      <button class="btn" data-submit>Submit to bank</button>
    </div>`, { wide: true });

  const msg = $('#ev-msg', el);
  const collect = () => {
    const out = {};
    $$('[data-ev]', el).forEach((i) => { if (i.value.trim()) out[i.dataset.ev] = i.value.trim(); });
    return out;
  };

  const send = async (submit) => {
    const evidence = collect();
    if (!Object.keys(evidence).length) { msg.textContent = 'Fill in at least one field first.'; return; }
    if (submit) {
      const ok = await confirmDialog({
        title: 'Submit evidence to the bank',
        body: 'This is final. The evidence cannot be changed after it is sent.',
        confirmText: 'Submit',
        danger: true,
      });
      if (!ok) return;
    }
    msg.textContent = submit ? 'Submitting…' : 'Saving…';
    try {
      await api('POST', `/accounts/${accountId}/dispute/evidence`, { dispute_id: disputeId, evidence, submit });
      close();
      toast(submit ? 'Evidence submitted.' : 'Draft saved.', 'good');
      await Promise.all([refresh(), loadWork(true)]);
    } catch (e) {
      msg.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
    }
  };

  $('[data-draft]', el).onclick = () => send(false);
  $('[data-submit]', el).onclick = () => send(true);
}

function openPayout(accountId) {
  const a = state.accounts.find((x) => x.id === accountId);
  const avail = (a && a.balances_available) || {};
  const currencies = Object.keys(avail).filter((c) => avail[c] > 0);

  const { el, close } = openModal(`
    <div class="modal-head"><b>🏦 Pay out — ${esc(a ? a.label : 'account')}</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      ${currencies.length ? `
        <div class="charge-card">
          <div class="cc-amount">${esc(moneyMap(avail))}</div>
          <div class="cc-rows"><div><span>Available now</span><b class="g">ready to send</b></div></div>
        </div>
        <label for="po-cur">Currency</label>
        <select id="po-cur">${currencies.map((c) => `<option value="${c}">${c.toUpperCase()} — ${esc(money(avail[c], c))}</option>`).join('')}</select>
        <label for="po-amount">Amount — leave blank to send it all</label>
        <input type="number" id="po-amount" step="0.01" min="0" placeholder="everything available">
        <div class="warn-note">Creates a real payout to the bank account on file.</div>`
      : '<div class="warn-note">Nothing is available to pay out on this account right now.</div>'}
      <div id="po-msg" class="side-note" style="margin-top:10px"></div>
    </div>
    <div class="modal-foot">
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn" data-go${currencies.length ? '' : ' disabled'}>Pay out</button>
    </div>`);

  const msg = $('#po-msg', el);
  const go = $('[data-go]', el);
  if (!currencies.length) return;
  go.onclick = async () => {
    go.disabled = true;
    msg.textContent = 'Creating the payout…';
    try {
      const r = await api('POST', `/accounts/${accountId}/payout`, {
        amount: $('#po-amount', el).value,
        currency: $('#po-cur', el).value,
      });
      close();
      toast(`Payout created — ${money(r.payout.amount, r.payout.currency)}.`, 'good');
      await refresh();
    } catch (e) {
      go.disabled = false;
      msg.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
    }
  };
}


// --- the console: look anything up, then act on it --------------------------

function consoleAccountId() {
  if (state.consoleAccount) return state.consoleAccount;
  const first = state.accounts.find((a) => a.has_key);
  return first ? first.id : null;
}

async function runLookup() {
  const id = consoleAccountId();
  if (!id) { toast('Add a Stripe API key to an account first.', 'error'); return; }
  const q = ($('#con-q') || {}).value || state.consoleQuery;
  if (!String(q).trim()) { toast('Paste a Stripe id or an email.', 'error'); return; }

  state.consoleAccount = id;
  state.consoleQuery = q;
  state.consoleBusy = true;
  render();
  try {
    const r = await api('GET', `/accounts/${id}/lookup?q=${encodeURIComponent(q)}`);
    state.consoleResults = { account_id: id, results: r.results || [] };
    if (!r.results.length) toast('Nothing found for that.', 'error');
  } catch (e) {
    state.consoleResults = null;
    toast(e.message, 'error');
  } finally {
    state.consoleBusy = false;
    render();
  }
}

const OBJ_LABEL = {
  charge: 'Charge', payment_intent: 'Payment', customer: 'Customer', dispute: 'Dispute',
  payout: 'Payout', refund: 'Refund', subscription: 'Subscription', invoice: 'Invoice',
  review: 'Review', fraud_warning: 'Fraud warning',
};

/** Only the fields worth reading, per object type. */
function objFields(o) {
  const f = [];
  const m = (v, c) => (v === undefined || v === null || v === '' ? null : money(v, c));
  switch (o.kind) {
    case 'charge':
      f.push(['Amount', m(o.amount, o.currency)], ['Refunded', m(o.refunded_amount, o.currency)],
        ['Status', o.raw_status], ['Customer', o.email || o.customer],
        ['Card', o.card], ['Radar risk', o.risk_level],
        ['Fraud report', o.fraud_report], ['Disputed', o.disputed ? 'yes' : 'no']);
      break;
    case 'payment_intent':
      f.push(['Amount', m(o.amount, o.currency)], ['Capturable', m(o.amount_capturable, o.currency)],
        ['Status', o.raw_status], ['Capture method', o.capture_method], ['Charge', o.latest_charge]);
      break;
    case 'customer':
      f.push(['Email', o.email], ['Name', o.name], ['Delinquent', o.delinquent ? 'yes' : 'no']);
      break;
    case 'dispute':
      f.push(['Amount', m(o.amount, o.currency)], ['Reason', o.reason], ['Status', o.raw_status],
        ['Charge', o.charge], ['Evidence submitted', String(o.submission_count)]);
      break;
    case 'payout':
      f.push(['Amount', m(o.amount, o.currency)], ['Status', o.raw_status], ['Method', o.method]);
      break;
    case 'refund':
      f.push(['Amount', m(o.amount, o.currency)], ['Status', o.raw_status], ['Reason', o.reason], ['Charge', o.charge]);
      break;
    case 'subscription':
      f.push(['Status', o.raw_status], ['Customer', o.customer],
        ['Ends at period end', o.cancel_at_period_end ? 'yes' : 'no']);
      break;
    case 'invoice':
      f.push(['Amount due', m(o.amount, o.currency)], ['Status', o.raw_status],
        ['Number', o.number], ['Paid', o.paid ? 'yes' : 'no']);
      break;
    case 'review':
      f.push(['Open', o.open ? 'yes' : 'no'], ['Reason', o.reason], ['Charge', o.charge]);
      break;
    case 'fraud_warning':
      f.push(['Type', o.fraud_type], ['Charge', o.charge]);
      break;
    default:
      f.push(['Status', o.raw_status]);
  }
  return f.filter(([, v]) => v !== null && v !== undefined && v !== '');
}

/** Exactly the actions Stripe allows on this object, in its current state. */
function objActions(o) {
  const a = [];
  switch (o.kind) {
    case 'charge':
      if (!o.refunded && !o.disputed) a.push(['refund', 'Refund', 'btn']);
      if (o.fraud_report !== 'fraudulent') a.push(['fraud', 'Report fraud', 'btn secondary']);
      if (o.fraud_report) a.push(['safe', 'Report safe', 'btn secondary']);
      if (o.email) a.push(['block-email', 'Block this email', 'btn secondary']);
      if (o.card_fingerprint) a.push(['block-card', 'Block this card', 'btn secondary']);
      break;
    case 'payment_intent':
      if (o.amount_capturable > 0) a.push(['capture', 'Capture funds', 'btn']);
      if (!['succeeded', 'canceled'].includes(o.raw_status)) a.push(['cancel-pi', 'Cancel payment', 'btn danger']);
      break;
    case 'customer':
      if (o.email) a.push(['block-email', 'Block this email', 'btn secondary']);
      a.push(['del-customer', 'Delete customer', 'btn danger']);
      break;
    case 'dispute':
      if (/needs_response/.test(o.raw_status)) {
        a.push(['evidence', 'Submit evidence', 'btn']);
        a.push(['accept', 'Accept dispute', 'btn danger']);
      }
      break;
    case 'payout':
      if (o.cancellable) a.push(['payout-cancel', 'Cancel payout', 'btn danger']);
      if (o.reversible) a.push(['payout-reverse', 'Reverse payout', 'btn danger']);
      break;
    case 'subscription':
      if (o.raw_status !== 'canceled') {
        a.push(['sub-end', 'Cancel at period end', 'btn secondary']);
        a.push(['sub-now', 'Cancel now', 'btn danger']);
      }
      break;
    case 'invoice':
      if (!o.paid) {
        a.push(['inv-void', 'Void invoice', 'btn secondary']);
        a.push(['inv-uncollectible', 'Write off', 'btn danger']);
      }
      break;
    case 'review':
      if (o.open) {
        a.push(['rev-approve', 'Approve', 'btn']);
        a.push(['rev-reject', 'Reject', 'btn danger']);
      }
      break;
    case 'fraud_warning':
      a.push(['refund-charge', 'Refund the charge', 'btn']);
      break;
    default:
      break;
  }
  return a;
}

function drawConsoleResults() {
  const box = $('#con-results');
  if (!box || !state.consoleResults) return;
  const { account_id, results } = state.consoleResults;

  box.innerHTML = results.map((o, i) => `
    <div class="obj-card">
      <div class="obj-head">
        <span class="obj-kind">${esc(OBJ_LABEL[o.kind] || o.kind)}</span>
        <span class="obj-id">${esc(o.id)}</span>
      </div>
      <div class="obj-body">
        ${objFields(o).map(([k, v]) => `
          <div class="obj-field"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
      ${objActions(o).length ? `<div class="obj-actions">
        ${objActions(o).map(([op, lbl, cls]) => `
          <button class="${cls} sm" data-op="${op}" data-i="${i}">${esc(lbl)}</button>`).join('')}
      </div>` : ''}
    </div>`).join('');

  $$('[data-op]', box).forEach((b) => {
    b.onclick = () => runObjectAction(account_id, results[Number(b.dataset.i)], b.dataset.op);
  });
}

/** One dispatcher for every action the console can offer. */
async function runObjectAction(accountId, o, op) {
  const post = (path, body) => api('POST', `/accounts/${accountId}/${path}`, body);
  const done = async (msg) => {
    toast(msg, 'good');
    await Promise.all([refresh(), loadWork(true)]);
    await runLookup();
  };

  try {
    switch (op) {
      case 'refund':
        return openRefund(accountId, o.id, o.risk_level === 'highest' ? 'fraudulent' : 'requested_by_customer');
      case 'refund-charge':
        return openRefund(accountId, o.charge, 'fraudulent');

      case 'fraud':
      case 'safe': {
        const report = op === 'fraud' ? 'fraudulent' : 'safe';
        const ok = await confirmDialog({
          title: report === 'fraudulent' ? 'Report as fraudulent' : 'Report as safe',
          body: report === 'fraudulent'
            ? 'Tells Stripe this payment was fraud. Radar learns from it and weights similar payments accordingly.'
            : 'Tells Stripe this payment was legitimate after all.',
          confirmText: 'Report',
        });
        if (!ok) return null;
        await post('fraud-report', { charge_id: o.id, report });
        return done(`Reported ${report}.`);
      }

      case 'block-email':
        return openBlock(accountId, 'email', o.email);
      case 'block-card':
        return openBlock(accountId, 'card_fingerprint', o.card_fingerprint);

      case 'capture':
        return openCapture(accountId, o);

      case 'cancel-pi': {
        const ok = await confirmDialog({
          title: 'Cancel this payment',
          body: 'The authorisation is released and the customer is not charged. This cannot be undone.',
          confirmText: 'Cancel payment', danger: true,
        });
        if (!ok) return null;
        await post('cancel-payment', { payment_intent: o.id, reason: 'fraudulent' });
        return done('Payment cancelled.');
      }

      case 'del-customer': {
        const ok = await confirmDialog({
          title: 'Delete this customer',
          body: 'Removes the customer at Stripe and cancels any subscriptions they hold. Permanent.',
          confirmText: 'Delete customer', danger: true,
        });
        if (!ok) return null;
        await post('customer/delete', { customer_id: o.id });
        return done('Customer deleted.');
      }

      case 'evidence':
        return openEvidence(accountId, o.id);
      case 'accept':
        return doAcceptDispute(accountId, o.id, o.amount, o.currency);

      case 'payout-cancel':
      case 'payout-reverse': {
        const isCancel = op === 'payout-cancel';
        const ok = await confirmDialog({
          title: isCancel ? 'Cancel this payout' : 'Reverse this payout',
          body: isCancel
            ? 'The payout is stopped and the money stays in your Stripe balance.'
            : 'Pulls a payout that has already been sent back from the bank account.',
          confirmText: isCancel ? 'Cancel payout' : 'Reverse payout', danger: true,
        });
        if (!ok) return null;
        await post('payout-action', { payout_id: o.id, op: isCancel ? 'cancel' : 'reverse' });
        return done(isCancel ? 'Payout cancelled.' : 'Payout reversed.');
      }

      case 'sub-end':
      case 'sub-now': {
        const atEnd = op === 'sub-end';
        const ok = await confirmDialog({
          title: atEnd ? 'Cancel at period end' : 'Cancel immediately',
          body: atEnd
            ? 'The subscription keeps running until the period already paid for ends, then stops.'
            : 'Stops the subscription right now. No further invoices are created.',
          confirmText: 'Cancel subscription', danger: !atEnd,
        });
        if (!ok) return null;
        await post('subscription/cancel', { subscription_id: o.id, at_period_end: atEnd });
        return done(atEnd ? 'Set to end at period close.' : 'Subscription cancelled.');
      }

      case 'inv-void':
      case 'inv-uncollectible': {
        const isVoid = op === 'inv-void';
        const ok = await confirmDialog({
          title: isVoid ? 'Void this invoice' : 'Write this invoice off',
          body: isVoid
            ? 'Voids the invoice so it can never be paid. Permanent.'
            : 'Marks the invoice uncollectible — it stays on record as a loss.',
          confirmText: isVoid ? 'Void' : 'Write off', danger: true,
        });
        if (!ok) return null;
        await post('invoice', { invoice_id: o.id, op: isVoid ? 'void' : 'mark_uncollectible' });
        return done(isVoid ? 'Invoice voided.' : 'Invoice written off.');
      }

      case 'rev-approve':
        return doReview(accountId, o.id, 'approve');
      case 'rev-reject':
        return doReview(accountId, o.id, 'reject');

      default:
        return null;
    }
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}


/** The id/email lookup, on demand rather than occupying the page. */
function openFind(accountId) {
  const a = state.accounts.find((x) => x.id === accountId);
  const { el, close } = openModal(`
    <div class="modal-head"><b>Find in ${esc(a ? a.label : 'account')}</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <label for="find-q">Stripe id or customer email</label>
      <div class="cred-row">
        <input type="text" id="find-q" placeholder="ch_… pi_… cus_… dp_… py_… sub_… in_… or an email" spellcheck="false">
        <button class="btn sm" data-go>Find</button>
      </div>
      <div id="find-out"></div>
    </div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn secondary" data-cancel>Close</button></div>`, { wide: true });

  const out = $('#find-out', el);
  const input = $('#find-q', el);

  const go = async () => {
    const q = input.value.trim();
    if (!q) return;
    out.innerHTML = '<div class="side-note" style="margin-top:14px">Looking…</div>';
    try {
      const r = await api('GET', `/accounts/${accountId}/lookup?q=${encodeURIComponent(q)}`);
      state.consoleResults = { account_id: accountId, results: r.results || [] };
      if (!r.results.length) { out.innerHTML = '<div class="side-note" style="margin-top:14px">Nothing found.</div>'; return; }
      out.innerHTML = '<div id="con-results"></div>';
      drawConsoleResults();
    } catch (e) {
      out.innerHTML = `<div class="warn-note">${esc(e.message)}</div>`;
    }
  };

  $('[data-go]', el).onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  void close;
}

function openCapture(accountId, pi) {
  const { el, close } = openModal(`
    <div class="modal-head"><b>Capture funds</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="charge-card">
        <div class="cc-amount">${esc(money(pi.amount_capturable, pi.currency))}</div>
        <div class="cc-rows">
          <div><span>Authorised total</span><b>${esc(money(pi.amount, pi.currency))}</b></div>
          <div><span>Status</span><b>${esc(pi.raw_status)}</b></div>
        </div>
      </div>
      <label for="cap-amount">Amount — leave blank to capture it all</label>
      <input type="number" id="cap-amount" step="0.01" min="0" max="${pi.amount_capturable}" placeholder="${pi.amount_capturable}">
      <div class="warn-note">Capturing takes the money. Anything not captured is released back to the cardholder.</div>
      <div id="cap-msg" class="side-note" style="margin-top:10px"></div>
    </div>
    <div class="modal-foot">
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn" data-go>Capture</button>
    </div>`);

  const msg = $('#cap-msg', el);
  $('[data-go]', el).onclick = async () => {
    const btn = $('[data-go]', el);
    btn.disabled = true;
    msg.textContent = 'Capturing…';
    try {
      await api('POST', `/accounts/${accountId}/capture`, {
        payment_intent: pi.id, amount: $('#cap-amount', el).value,
      });
      close();
      toast('Funds captured.', 'good');
      await Promise.all([refresh(), runLookup()]);
    } catch (e) {
      btn.disabled = false;
      msg.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
    }
  };
}

function openBlock(accountId, type, value) {
  const LABELS = { email: 'email address', card_fingerprint: 'card', ip_address: 'IP address', country: 'country' };
  const { el, close } = openModal(`
    <div class="modal-head"><b>Block this ${esc(LABELS[type] || type)}</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <label for="blk-value">Value</label>
      <input type="text" id="blk-value" value="${esc(value || '')}" spellcheck="false">
      <div class="warn-note">
        This adds the value to a Radar block list. It only stops future payments where a Radar
        <b>rule</b> references that list — Stripe creates one by default on most accounts, but if
        yours has none, add a rule in the Stripe dashboard under Radar → Rules.
      </div>
      <div id="blk-msg" class="side-note" style="margin-top:10px"></div>
    </div>
    <div class="modal-foot">
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn" data-go>Block</button>
    </div>`);

  const msg = $('#blk-msg', el);
  $('[data-go]', el).onclick = async () => {
    const btn = $('[data-go]', el);
    btn.disabled = true;
    msg.textContent = 'Adding to the block list…';
    try {
      await api('POST', `/accounts/${accountId}/block`, { type, value: $('#blk-value', el).value });
      close();
      toast('Blocked.', 'good');
      await refresh();
    } catch (e) {
      btn.disabled = false;
      msg.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
    }
  };
}

async function showBlockLists() {
  const id = consoleAccountId();
  if (!id) { toast('Add a Stripe API key to an account first.', 'error'); return; }
  let data;
  try {
    toast('Loading block lists…');
    data = await api('GET', `/accounts/${id}/blocklists`);
  } catch (e) { toast(e.message, 'error'); return; }

  const lists = data.lists || [];
  const { el } = openModal(`
    <div class="modal-head"><b>Radar block lists</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      ${lists.length ? lists.map((l) => `
        <div style="margin-top:14px">
          <div style="font-weight:600;font-size:13.5px">${esc(l.name)} <code>${esc(l.alias)}</code></div>
          <div class="side-note">${esc(l.item_type)} · ${l.items.length} entr${l.items.length === 1 ? 'y' : 'ies'}</div>
          <div class="block-list">
            ${l.items.length ? l.items.map((i) => `
              <div class="block-row">
                <span class="bv">${esc(i.value)}</span>
                <button class="mini" data-unblock="${esc(i.id)}">Remove</button>
              </div>`).join('') : '<div class="side-note">Empty.</div>'}
          </div>
        </div>`).join('')
      : '<div class="side-note" style="margin-top:14px">No Radar value lists exist on this account yet. Blocking something creates one.</div>'}
      <div class="warn-note">
        A list only blocks payments where a Radar rule references it. Check Radar → Rules in the
        Stripe dashboard if a block does not seem to take effect.
      </div>
    </div>
    <div class="modal-foot"><div class="spacer"></div><button class="btn secondary" data-cancel>Close</button></div>`, { wide: true });

  $$('[data-unblock]', el).forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api('POST', `/accounts/${id}/unblock`, { item_id: b.dataset.unblock });
        b.closest('.block-row').remove();
        toast('Removed from the block list.', 'good');
      } catch (e) { b.disabled = false; toast(e.message, 'error'); }
    };
  });
}

// ============================================================================
// Credentials / key modals
// ============================================================================

const PANEL = {
  login: {
    title: '🔒 Login',
    fields: [
      ['login_email', 'Login email'], ['password', 'Password', 's'],
      ['twofa', '2FA secret / recovery', 's'], ['backup_codes', 'Backup codes', 's'],
      ['phone', 'Login phone'], ['dashboard_url', 'Dashboard URL'], ['cred_notes', 'Notes', 's'],
    ],
  },
  business: {
    title: '🏢 Business',
    fields: [
      ['legal_name', 'Legal business name'], ['dba', 'Doing business as / trading name'],
      ['type', 'Business type (individual / LLC / company)'], ['industry', 'Industry / MCC'],
      ['website', 'Website submitted'], ['publishable_key', 'Publishable key (pk_…)'],
      ['product_description', 'Product description submitted'], ['statement_descriptor', 'Statement descriptor'],
      ['support_email', 'Support email'], ['support_phone', 'Support phone'],
      ['tax_id', 'Tax ID / EIN', 's'], ['vat_number', 'VAT number', 's'],
      ['registration_number', 'Company registration number', 's'], ['incorporation_date', 'Incorporation date'],
    ],
  },
  address: {
    title: '📍 Address',
    fields: [
      ['line1', 'Address line 1'], ['line2', 'Address line 2'], ['city', 'City'],
      ['state', 'State / province'], ['postal_code', 'Postal code'], ['country', 'Country'],
      ['business_phone', 'Business phone'],
    ],
  },
  rep: {
    title: '👤 Representative',
    fields: [
      ['name', 'Full legal name'], ['title', 'Job title / role'], ['email', 'Email'], ['phone', 'Phone'],
      ['dob', 'Date of birth', 's'], ['id_number', 'SSN / ID number', 's'],
      ['home_address', 'Home address', 's'], ['documents', 'ID documents submitted', 's'],
    ],
  },
  bank: {
    title: '🏦 Bank',
    fields: [
      ['bank_name', 'Bank name'], ['account_holder', 'Account holder name'],
      ['account_number', 'Account number', 's'], ['routing_number', 'Routing / sort code', 's'],
      ['iban', 'IBAN', 's'], ['swift', 'SWIFT / BIC', 's'],
      ['payout_schedule', 'Payout schedule'], ['bank_notes', 'Notes', 's'],
    ],
  },
};
const SECTION_ORDER = ['login', 'business', 'address', 'rep', 'bank', 'custom'];

function fieldRowHTML(section, key, label, secret, value) {
  return `
    <label>${esc(label)}</label>
    <div class="cred-row">
      <input data-sec="${section}" data-f="${esc(key)}" type="${secret ? 'password' : 'text'}"
             value="${esc(value || '')}" ${secret ? 'autocomplete="new-password"' : ''} spellcheck="false">
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

  let creds;
  let biz;
  try {
    [creds, biz] = await Promise.all([
      api('GET', `/accounts/${id}/credentials`),
      api('GET', `/accounts/${id}/business`),
    ]);
  } catch (e) { toast(e.message, 'error'); return; }

  const valueFor = (section, key) => (section === 'login' ? creds[key] : (biz[section] || {})[key]);

  const { el: back, close } = openModal(`
    <div class="modal-head">
      <b>${esc(a.label || 'account')}</b>
      <span class="hb hb-${esc(a.health)}">${esc(HEALTH[a.health] || a.health)}</span>
      <button class="modal-x" aria-label="Close">✕</button>
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
            <label for="addr-search">🔎 Find a US address — type it and pick a match</label>
            <div class="cred-row">
              <input id="addr-search" type="text" placeholder="e.g. 1209 Orange St, Wilmington DE" autocomplete="off">
            </div>
            <div id="addr-results" class="lookup-list" hidden></div>
            <div id="addr-msg" class="side-note" style="margin-top:6px"></div>` : ''}
          ${PANEL[s].fields.map(([k, label, sec]) => fieldRowHTML(s, k, label, sec === 's', valueFor(s, k))).join('')}
          ${s === 'bank' ? '<div id="bank-msg" class="side-note" style="margin-top:10px"></div>' : ''}
        </div>`).join('')}
      <div class="msec" data-body="custom" ${startSection === 'custom' ? '' : 'hidden'}>
        <div class="side-note" style="margin:12px 0">Anything else you submitted or want to remember for this account.</div>
        <div id="custom-list">${(biz.custom || []).map(customRowHTML).join('')}</div>
        <button class="btn ghost" id="add-custom" style="margin-top:10px">+ add field</button>
      </div>
      <div class="warn-note">
        Every value here is encrypted with AES-256-GCM before it is written to disk — as is the
        Stripe API key. The key file sits beside the database in <code>data/</code>, so this protects
        the database file itself, not someone who already has access to this PC.
      </div>
    </div>
    <div class="modal-foot">
      <span class="side-note" id="cred-msg"></span>
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn" data-save>Save</button>
    </div>`, { wide: true });

  const note = (msg) => { $('#cred-msg', back).textContent = msg; };

  $$('.mtab', back).forEach((tab) => {
    tab.onclick = () => {
      $$('.mtab', back).forEach((t) => t.classList.toggle('active', t === tab));
      $$('.msec', back).forEach((sec) => { sec.hidden = sec.dataset.body !== tab.dataset.sect; });
    };
  });

  async function copyValue(input) {
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); document.execCommand('copy'); }
    note('Copied ✓');
  }

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
    if (drop) drop.closest('.custom-row').remove();
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
      addrTimer = setTimeout(async () => {
        const seq = ++addrSeq;
        try {
          const { results } = await api('GET', `/lookup/address?q=${encodeURIComponent(q)}`);
          if (seq !== addrSeq) return; // a newer keystroke already won
          if (!results.length) {
            addrList.hidden = true;
            addrMsg.textContent = 'No US match — you can still type the fields in by hand.';
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
        const already = nameField && nameField.value.trim();
        if (nameField && !already) nameField.value = info.bank_name;
        bankMsg.innerHTML = `<span style="color:var(--good)">✓ ${esc(info.bank_name)}</span>`
          + (info.city ? ` <span style="color:var(--muted)">— ${esc(info.city)}, ${esc(info.state)}</span>` : '')
          + (already && already !== info.bank_name
            ? '<br><span style="color:var(--warn)">Bank name was already filled in — left as it is.</span>' : '');
      } catch (e) {
        bankMsg.innerHTML = `<span style="color:var(--warn)">${esc(e.message)}</span>`;
      }
    };
    routingInput.addEventListener('blur', doLookup);
    routingInput.addEventListener('change', doLookup);
  }

  $('#add-custom', back).onclick = () => {
    const list = $('#custom-list', back);
    list.insertAdjacentHTML('beforeend', customRowHTML());
    list.lastElementChild.querySelector('.c-label').focus();
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
      toast('Saved.', 'good');
    } catch (e) { toast(e.message, 'error'); }
  };
}

function promptForKey(id) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return;

  const { el: back, close } = openModal(`
    <div class="modal-head"><b>🔑 Stripe API key — ${esc(a.label || 'account')}</b><button class="modal-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      ${a.has_key ? `<div class="ok-note">A key is already saved (<code>${esc(a.key_hint)}</code>). Pasting a new one replaces it.</div>` : ''}
      <label for="key-input">Secret key</label>
      <div class="cred-row">
        <input id="key-input" type="password" placeholder="sk_live_…" autocomplete="new-password" spellcheck="false">
        <button class="mini" data-eye title="show/hide">👁</button>
      </div>
      <div class="warn-note">
        Encrypted with AES-256-GCM before it is written to disk, and never sent back to the browser.
        The app makes read-only calls (account, balance, charges, disputes, refunds, payouts) and never
        writes to Stripe. A restricted key (<code>rk_…</code>) works here identically.
      </div>
      <div id="key-status" class="side-note" style="margin-top:12px"></div>
    </div>
    <div class="modal-foot">
      <div class="spacer"></div>
      <button class="btn secondary" data-cancel>Cancel</button>
      <button class="btn" data-save>Verify &amp; save</button>
    </div>`);

  const input = $('#key-input', back);
  const status = $('#key-status', back);
  $('[data-eye]', back).onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-save]', back).click(); } };

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
      toast(`Connected — ${r.info.business_name || r.info.id} · ${HEALTH[r.info.health] || r.info.health}`, 'good');
    } catch (e) {
      btn.disabled = false;
      status.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
    }
  };
}

// ============================================================================
// Settings
// ============================================================================

function renderSettings(root) {
  const t = state.tg || {};
  const sh = state.sheets || {};
  const kinds = new Set(t.kinds || []);
  const muted = state.mutedUntil > Date.now();
  const admin = state.me && state.me.role === 'admin';

  root.innerHTML = `
    <div class="page"><div class="set-grid">
      <div>
        <div class="card">
          <div class="card-head"><h3>📨 Telegram alerts</h3></div>
          <div class="card-sub">Your own bot and chat. Alerts about your accounts reach nobody else.</div>

          <label for="tg-token">Bot token (from @BotFather)</label>
          <input type="password" id="tg-token" placeholder="${t.has_token ? 'Saved — type a new one to replace' : '123456789:AAE…'}">
          <div class="row">
            <button class="btn secondary" id="tg-save">Save token</button>
            <button class="btn secondary" id="tg-detect">Detect chat</button>
            <div class="spacer"></div>
            <button class="btn" id="tg-test" ${t.ready ? '' : 'disabled'}>Send test</button>
          </div>
          ${t.chat_id ? `<div class="ok-note">Chat connected — ${esc(t.chat_name || '')} <code>${esc(t.chat_id)}</code></div>` : ''}

          <div class="row">
            <label class="switch-row" style="margin:0">
              <input type="checkbox" id="tg-mute" ${muted ? 'checked' : ''}>
              Pause my alerts for an hour
            </label>
            ${muted ? `<span class="side-note">resumes ${esc(new Date(state.mutedUntil).toLocaleTimeString())}</span>` : ''}
          </div>

          <label>Alert me about</label>
          <div class="checks">
            ${KINDS.map(([k, lbl]) => `
              <label><input type="checkbox" class="k" value="${k}" ${kinds.has(k) ? 'checked' : ''}> ${lbl}</label>`).join('')}
          </div>
          <div class="row">
            <label class="switch-row" style="margin:0">
              <input type="checkbox" id="verbose" ${t.verbose ? 'checked' : ''}>
              Verbose — alert on <i>every</i> Stripe event type
            </label>
          </div>
          <div class="row">
            <div class="spacer"></div>
            <button class="btn secondary" id="prefs-save">Save preferences</button>
          </div>

          <details class="help">
            <summary>Commands your bot answers</summary>
            <div class="steps">
              <div class="cmd-list">
                ${Object.entries(t.commands || {}).map(([c, w]) => `<div><code>${esc(c)}</code><span>${esc(w)}</span></div>`).join('')}
              </div>
              Send any of these to your bot to check the fleet from your phone without opening the tunnel.
            </div>
          </details>

          <details class="help">
            <summary>Setting up the bot (2 minutes)</summary>
            <div class="steps"><ol>
              <li>In Telegram open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> → send <code>/newbot</code> → pick any name.</li>
              <li>Paste the token it gives you above and press <b>Save token</b>.</li>
              <li>Open your new bot's chat and press <b>Start</b> — this is what lets it message you.</li>
              <li>Press <b>Detect chat</b>, then <b>Send test</b>.</li>
            </ol></div>
          </details>
        </div>

        ${admin ? `
        <div class="card">
          <div class="card-head"><h3>⏱️ Checking</h3><span class="eyebrow">shared by everyone</span></div>
          <div class="card-sub">One background loop serves every account on this machine, so these two settings affect all users.</div>
          <label for="poll-secs">Check Stripe every (seconds)</label>
          <input type="number" id="poll-secs" min="20" max="3600" value="${state.pollSeconds}">
          <div class="row">
            <label class="switch-row" style="margin:0">
              <input type="checkbox" id="poll-on" ${state.pollEnabled ? 'checked' : ''}> Automatic checking on
            </label>
            <div class="spacer"></div>
            <button class="btn secondary" id="poll-save">Save</button>
          </div>
          <div class="side-note" style="margin-top:10px">
            Last cycle: ${state.lastPollMs ? `${(state.lastPollMs / 1000).toFixed(1)}s for ${state.accounts.length} accounts` : 'not measured yet'}
            · accounts are checked six at a time.
          </div>
        </div>` : ''}

        <div class="card">
          <div class="card-head"><h3>📊 Google Sheet</h3></div>
          <div class="card-sub">A one-way mirror of the tracker. Rewritten when something changes, at most every 5 minutes.</div>
          <label for="sh-sheet">Spreadsheet URL (or ID)</label>
          <input type="text" id="sh-sheet" value="${esc(sh.sheet_id || '')}" placeholder="https://docs.google.com/spreadsheets/d/…">
          <label for="sh-sa">Service-account key (paste the whole JSON file)</label>
          <textarea id="sh-sa" placeholder="${sh.client_email ? 'Key saved — paste again only to replace it' : '{ "type": "service_account", … }'}"></textarea>
          ${sh.client_email ? `<div class="ok-note">Key saved — share your sheet with:<br><code>${esc(sh.client_email)}</code></div>` : ''}
          <div class="row">
            <label class="switch-row" style="margin:0"><input type="checkbox" id="sh-auto" ${sh.auto ? 'checked' : ''}> Update automatically</label>
          </div>
          <div class="row">
            <label class="switch-row" style="margin:0"><input type="checkbox" id="sh-secrets" ${sh.include_secrets ? 'checked' : ''}> Include passwords, keys &amp; sensitive columns</label>
          </div>
          ${sh.include_secrets ? `<div class="warn-note crit">
            <b>The sheet is carrying secrets in plain text.</b> API keys, passwords, 2FA, SSN/ID, tax ID and
            bank numbers are written to Google unencrypted. Keep the sheet private — never "anyone with the
            link" — and share it only with your own Google account.
          </div>` : `<div class="side-note" style="margin-top:8px">Sensitive columns are left out. Tick the box only if you accept that they leave this machine in plain text.</div>`}
          <div class="row">
            <div class="spacer"></div>
            <button class="btn secondary" id="sh-save">Save</button>
            <button class="btn" id="sh-push" ${sh.configured ? '' : 'disabled'}>⇪ Update sheet now</button>
          </div>
          ${sh.configured ? '' : `<div class="side-note" style="margin-top:10px">
            ${sh.sheet_id ? '✅' : '⬜'} Spreadsheet URL &nbsp; ${sh.client_email ? '✅' : '⬜'} Service-account key
          </div>`}
          ${sh.last_push ? `<div class="log-box">${esc(describePush(sh.last_push))}</div>` : ''}
          <details class="help">
            <summary>Setting up the sheet (one time, free)</summary>
            <div class="steps"><ol>
              <li><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> → create a project.</li>
              <li>Search <b>Google Sheets API</b> → <b>Enable</b>.</li>
              <li><b>IAM &amp; Admin → Service Accounts → Create service account</b> → Done.</li>
              <li>Open it → <b>Keys → Add key → Create new key → JSON</b>.</li>
              <li>Open that file, copy everything, paste it above.</li>
              <li>Create a Google Sheet, press <b>Share</b>, share it with the service-account email as <b>Editor</b>.</li>
            </ol></div>
          </details>
        </div>
      </div>

      <div>
        ${admin ? `
        <div class="card">
          <div class="card-head"><h3>👥 People with access</h3></div>
          <div class="card-sub">
            Signed in as <b>${esc(state.me.email)}</b>. Everyone here can see and edit everything,
            including Stripe keys and credentials.
          </div>
          <table class="users">
            <thead><tr><th>Email</th><th style="width:92px">Role</th><th style="width:66px">Status</th><th style="width:96px">Last login</th><th></th></tr></thead>
            <tbody>
              ${(state.users || []).map((u) => `
                <tr>
                  <td>${esc(u.email)}${u.id === state.me.id ? ' <span class="side-note">(you)</span>' : ''}</td>
                  <td><select data-role="${u.id}" ${u.id === state.me.id ? 'disabled' : ''}>
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>owner</option>
                    <option value="member" ${u.role === 'member' ? 'selected' : ''}>member</option>
                  </select></td>
                  <td><span class="${u.active ? 'u-on' : 'u-off'}">${u.active ? 'active' : 'disabled'}</span></td>
                  <td class="side-note">${u.last_login ? esc(ago(u.last_login)) : 'never'}</td>
                  <td style="text-align:right">${u.id === state.me.id ? '' : `
                    <div class="row-actions" style="opacity:1">
                      <button class="mini" data-toggle="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'disable' : 'enable'}</button>
                      <button class="mini" data-resetpw="${u.id}">reset pw</button>
                      <button class="mini" data-deluser="${u.id}">✕</button>
                    </div>`}</td>
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
          <div class="card-head"><h3>🔑 Your password</h3></div>
          <div class="card-sub">Changing it signs you out on every other device.</div>
          <label for="pw-cur">Current password</label>
          <input type="password" id="pw-cur" autocomplete="current-password">
          <label for="pw-new">New password (at least 8 characters)</label>
          <input type="password" id="pw-new" autocomplete="new-password">
          <div class="row">
            <div class="spacer"></div>
            <button class="btn secondary" id="pw-save">Change password</button>
          </div>
          <div id="pw-msg" class="side-note" style="margin-top:10px"></div>
        </div>

        <div class="card">
          <div class="card-head"><h3>🔐 How your secrets are stored</h3></div>
          <div class="steps" style="padding:0">
            Stripe keys, login passwords, 2FA secrets, SSN/ID numbers, bank details, your bot token and your
            Google service-account key are all encrypted with <b>AES-256-GCM</b> before they touch the
            database. The page only ever receives a masked hint like <code>secret · live · …4f2a</code>.<br><br>
            The encryption key lives in <code>data/secret.key</code>, next to the database. That protects the
            database <i>file</i> — a stray copy, a backup, a sync client — not somebody who already has access
            to this PC. <b>Back the key up together with the database:</b> without it the encrypted fields
            cannot be recovered.
          </div>
        </div>
      </div>
    </div></div>`;

  wireSettings();
}

function describePush(p) {
  if (!p) return '';
  if (p.ok === false) return `Last push failed ${ago(p.at)}\n${p.error || ''}`;
  return `Pushed ${p.accounts} account${p.accounts === 1 ? '' : 's'} across ${p.tabs} tabs, ${ago(p.at)}`
    + (p.secrets_included ? '\nSecrets tab included.' : '\nSensitive columns excluded.');
}

function wireSettings() {
  $('#tg-save').onclick = async () => {
    try {
      await api('POST', '/telegram', { token: $('#tg-token').value });
      await loadTg();
      render();
      toast('Token saved — now press Start in your bot, then Detect chat.', 'good');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#tg-detect').onclick = async () => {
    try {
      const r = await api('POST', '/telegram/detect');
      await loadTg();
      render();
      toast(`Chat found — ${r.name || r.chatId}`, 'good');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#tg-test').onclick = async () => {
    try { await api('POST', '/telegram/test'); toast('Test message sent — check Telegram.', 'good'); }
    catch (e) { toast(e.message, 'error'); }
  };

  $('#tg-mute').onchange = async (e) => {
    try {
      const r = await api('POST', '/telegram/mute', { minutes: e.target.checked ? 60 : 0 });
      state.mutedUntil = r.muted_until;
      paintChips();
      toast(e.target.checked ? 'Alerts paused for an hour.' : 'Alerts resumed.', 'good');
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#prefs-save').onclick = async () => {
    try {
      await api('POST', '/telegram', {
        kinds: $$('.k').filter((c) => c.checked).map((c) => c.value),
        verbose: $('#verbose').checked,
      });
      await loadTg();
      render();
      toast('Preferences saved.', 'good');
    } catch (e) { toast(e.message, 'error'); }
  };

  const pollSave = $('#poll-save');
  if (pollSave) {
    pollSave.onclick = async () => {
      try {
        await api('POST', '/telegram', { poll_seconds: Number($('#poll-secs').value) });
        await api('POST', '/poll/toggle', { enabled: $('#poll-on').checked });
        await loadState();
        render();
        toast('Checking settings saved.', 'good');
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  $('#pw-save').onclick = async () => {
    const msg = $('#pw-msg');
    try {
      await api('POST', '/auth/password', { current: $('#pw-cur').value, password: $('#pw-new').value });
      $('#pw-cur').value = '';
      $('#pw-new').value = '';
      msg.innerHTML = '<span style="color:var(--good)">Password changed — other devices were signed out.</span>';
    } catch (e) {
      msg.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`;
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
      render();
      toast(state.sheets.configured ? 'Saved — you can push the sheet now.' : 'Saved, but the service-account key is still missing.', 'good');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#sh-push').onclick = async () => {
    const btn = $('#sh-push');
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      const r = await api('POST', '/sheets/push');
      await loadSheets();
      render();
      toast(`Sheet updated — ${r.report.accounts} accounts across ${r.report.tabs} tabs.`, 'good');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '⇪ Update sheet now';
      toast(e.message, 'error');
    }
  };

  if (!(state.me && state.me.role === 'admin')) return;
  const umsg = $('#users-msg');
  const bad = (m) => { umsg.innerHTML = `<span style="color:var(--crit)">${esc(m)}</span>`; };

  $('#nu-add').onclick = async () => {
    try {
      const who = $('#nu-email').value;
      await api('POST', '/auth/users', { email: who, password: $('#nu-pw').value, role: $('#nu-role').value });
      $('#nu-email').value = '';
      $('#nu-pw').value = '';
      await loadUsers();
      render();
      toast(`Added ${who} — give them the link and the password you chose.`, 'good');
    } catch (e) { bad(e.message); }
  };

  $$('[data-role]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api('PATCH', `/auth/users/${sel.dataset.role}`, { role: sel.value });
        await loadUsers();
        render();
        toast('Role updated.', 'good');
      } catch (e) { bad(e.message); await loadUsers(); render(); }
    };
  });

  $$('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('PATCH', `/auth/users/${b.dataset.toggle}`, { active: b.dataset.active !== '1' });
        await loadUsers();
        render();
        toast('Updated.', 'good');
      } catch (e) { bad(e.message); }
    };
  });

  $$('[data-resetpw]').forEach((b) => {
    b.onclick = async () => {
      const pw = await ask({
        title: 'Reset password',
        label: 'New password for this person',
        placeholder: 'at least 8 characters',
        password: true,
        confirmText: 'Reset',
        note: 'They will be signed out of every device.',
      });
      if (pw === null || !pw.trim()) return;
      try {
        await api('PATCH', `/auth/users/${b.dataset.resetpw}`, { password: pw });
        toast('Password reset — they were signed out everywhere.', 'good');
      } catch (e) { bad(e.message); }
    };
  });

  $$('[data-deluser]').forEach((b) => {
    b.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Remove this person',
        body: 'Their access ends immediately, and <b>everything they own is deleted</b> — their Stripe accounts, stored credentials, groups and alert history.',
        confirmText: 'Remove permanently',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('DELETE', `/auth/users/${b.dataset.deluser}`);
        await loadUsers();
        render();
        toast('Access removed.', 'good');
      } catch (e) { bad(e.message); }
    };
  });
}

// ============================================================================
// Command palette
// ============================================================================

function paletteItems(q) {
  const items = [];
  const match = (s) => !q || String(s || '').toLowerCase().includes(q);

  for (const a of state.accounts) {
    if (!match(`${a.label} ${a.business_name} ${a.legal_name} ${a.stripe_id} ${groupName(a.group_id)}`)) continue;
    items.push({
      group: 'Accounts',
      icon: { healthy: '🟢', docs: '🟡', restricted: '🟠', suspended: '🔴', pending: '🔵', error: '🔌' }[a.health] || '⚪',
      title: a.label || 'unnamed',
      sub: `${groupName(a.group_id)} · ${HEALTH[a.health] || a.health}`,
      right: moneyMap(a.balances_available, { compact: true }),
      run: () => openCredentials(a.id, 'login'),
    });
  }

  const actions = [
    { icon: '📈', title: 'Go to Pulse', run: () => { state.tab = 'pulse'; render(); } },
    { icon: '🗂️', title: 'Go to Accounts', run: () => { state.tab = 'accounts'; render(); } },
    { icon: '🔔', title: 'Go to Alerts', run: () => { state.tab = 'alerts'; render(); } },
    { icon: '⚙️', title: 'Go to Settings', run: () => { state.tab = 'settings'; render(); } },
    { icon: '⟳', title: 'Check all accounts now', sub: 'poll Stripe immediately', run: async () => {
      toast('Checking…');
      try {
        const r = await api('POST', '/poll');
        await Promise.all([loadState(), loadStats()]);
        render();
        toast(`Checked ${r.results.length} accounts.`, 'good');
      } catch (e) { toast(e.message, 'error'); }
    } },
    { icon: '🚨', title: 'Show critical alerts only', run: () => { state.alertFilter = { sev: 'critical', kind: null, account: null, q: '' }; state.tab = 'alerts'; render(); } },
    { icon: '🩺', title: 'Show accounts needing attention', run: () => { state.healthFilter = 'restricted'; state.tab = 'accounts'; render(); } },
    { icon: '➕', title: 'Add a Stripe account', run: () => { state.tab = 'accounts'; render(); $('#add-acct').click(); } },
    { icon: '⎋', title: 'Sign out', run: () => signOut() },
  ];
  for (const a of actions) if (match(a.title + ' ' + (a.sub || ''))) items.push({ group: 'Actions', ...a });

  return items;
}

async function signOut() {
  try { await api('POST', '/auth/logout'); } catch { /* going to the login page anyway */ }
  location.href = '/login.html';
}

// ============================================================================
// Boot
// ============================================================================

/**
 * Only skip the DOM rebuild — never the status chips. The old version bailed
 * out of the whole refresh on the Settings tab and whenever any input had
 * focus, so the header quietly stopped telling the truth.
 */
function busyEditing() {
  if ($('.modal-back')) return true;
  const el = document.activeElement;
  return !!el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

setInterval(async () => {
  try {
    const { version } = await api('GET', '/version');
    if (version === state.version) { paintChips(); return; }
    await loadState();
    if (state.tab === 'pulse' || state.tab === 'accounts') await loadStats();
    if (!busyEditing() && state.tab !== 'settings') render();
  } catch { /* server restarting — try again next tick */ }
}, 5000);

// Keep "3m ago" honest between polls.
setInterval(paintChips, 15000);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette(paletteItems);
    return;
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    openPalette(paletteItems);
  }
});

$$('.tab').forEach((b) => {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    render();
    if (state.tab === 'act') loadWork();
  };
});
$('#cmd-open').onclick = () => openPalette(paletteItems);
$('#logout').onclick = signOut;

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.tab === 'accounts' && state.acctView === 'board') layoutCards();
    else if (!busyEditing()) render(); // never wipe a field someone is typing in
  }, 150);
});

(async () => {
  try {
    await loadMe();
    await Promise.all([loadState(), loadStats(), loadTg(), loadSheets(), loadUsers()]);
    render();
    // The worklist is a live Stripe scan, so it runs after first paint.
    loadWork();
  } catch (e) {
    toast(e.message, 'error');
  }
})();
