'use strict';

const express = require('express');
const d = require('./db');
const stripe = require('./stripe');
const telegram = require('./telegram');
const sheets = require('./sheets');
const lookup = require('./lookup');
const actions = require('./actions');
const auth = require('./auth');

const router = express.Router();
const { activity, nextPayout } = require('./activity');

/**
 * Every failure used to come back as 400, including "not found" and "not
 * allowed", which made the client unable to tell them apart.
 */
function safe(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      const status = e.status
        || (/not found|no such/i.test(e.message) ? 404
          : /not signed in/i.test(e.message) ? 401
            : /only the owner|cannot|not allowed/i.test(e.message) ? 403
              : 400);
      res.status(status).json({ error: e.message });
    }
  };
}

// --- auth -------------------------------------------------------------------

router.get('/auth/status', (req, res) => {
  const t = auth.throttleState(req);
  res.json({
    configured: auth.isConfigured(),
    signed_in: auth.isLoggedIn(req),
    user: auth.currentUser(req),
    can_setup: auth.isLocalRequest(req),
    locked: t.locked,
    attempts_left: t.left,
  });
});

/**
 * First run only: create the owner account. Refuses once anyone exists, and
 * only accepts the request from this machine or the local network — a stranger
 * who finds the tunnel URL must never be able to claim ownership.
 */
router.post('/auth/setup', safe((req, res) => {
  if (auth.isConfigured()) throw new Error('This app already has an owner. Sign in instead.');
  if (!auth.isLocalRequest(req)) {
    throw new Error('The owner account can only be created on the computer running the app, not over the internet.');
  }
  const id = auth.addUser({ email: req.body?.email, password: req.body?.password, role: 'admin' });
  auth.startSession(res, req, id, 'setup');
  res.json({ ok: true });
}));

router.post('/auth/login', safe((req, res) => {
  const t = auth.throttleState(req);
  if (t.locked) {
    const mins = Math.ceil((t.until - Date.now()) / 60000);
    throw new Error(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  const user = auth.verifyLogin(req.body?.email, req.body?.password);
  if (!user) {
    auth.noteFailure(req);
    const left = auth.throttleState(req).left;
    // deliberately vague: never reveal whether the email exists
    throw new Error(`Wrong email or password.${left <= 3 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`);
  }
  auth.clearFailures(req);
  d.touchLogin(user.id);
  auth.startSession(res, req, user.id, req.headers['user-agent'] || '');
  res.json({ ok: true, role: user.role });
}));

router.post('/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

/** Change your own password. */
router.post('/auth/password', safe((req, res) => {
  const me = auth.currentUser(req);
  if (!me) throw new Error('Not signed in.');
  if (!auth.verifyLogin(me.email, req.body?.current)) throw new Error('Current password is wrong.');
  auth.setUserPassword(me.id, req.body?.password);
  auth.startSession(res, req, me.id, 'password change'); // keep this device signed in
  res.json({ ok: true });
}));

// --- user management (owner only) -------------------------------------------

router.get('/auth/users', auth.requireAdmin, (req, res) => {
  res.json({ users: d.listUsers(), me: auth.currentUser(req) });
});

router.post('/auth/users', auth.requireAdmin, safe((req, res) => {
  const { email, password, role } = req.body || {};
  const id = auth.addUser({ email, password, role: role === 'admin' ? 'admin' : 'member' });
  res.json({ ok: true, id });
}));

router.patch('/auth/users/:id', auth.requireAdmin, safe((req, res) => {
  const id = Number(req.params.id);
  const me = auth.currentUser(req);
  const target = d.getUser(id);
  if (!target) throw new Error('No such account.');

  const { role, active, password } = req.body || {};
  const lastAdmin = target.role === 'admin' && d.countAdmins() <= 1;

  if (role !== undefined) {
    if (lastAdmin && role !== 'admin') throw new Error('This is the only owner — promote someone else first.');
    d.updateUser(id, { role: role === 'admin' ? 'admin' : 'member' });
  }
  if (active !== undefined) {
    if (id === me.id) throw new Error('You cannot disable your own account.');
    if (lastAdmin && !active) throw new Error('This is the only owner — promote someone else first.');
    d.updateUser(id, { active: active ? 1 : 0 });
    if (!active) d.clearUserSessions(id);
  }
  if (password !== undefined && String(password).trim() !== '') {
    auth.setUserPassword(id, password);
  }
  res.json({ ok: true });
}));

router.delete('/auth/users/:id', auth.requireAdmin, safe((req, res) => {
  const id = Number(req.params.id);
  const me = auth.currentUser(req);
  if (id === me.id) throw new Error('You cannot delete your own account.');
  const target = d.getUser(id);
  if (!target) throw new Error('No such account.');
  if (target.role === 'admin' && d.countAdmins() <= 1) {
    throw new Error('This is the only owner — promote someone else first.');
  }
  d.clearUserSessions(id);
  res.json({ ok: true, changes: d.deleteUser(id) });
}));

// --- ownership helpers ------------------------------------------------------

/** The signed-in user's id. Every data route scopes to this. */
const uid = (req) => auth.currentUser(req).id;

/** Fetch an account and refuse it if it belongs to someone else. */
function ownedAccount(req, id) {
  const acc = d.getAccount(Number(id));
  if (!acc || acc.user_id !== uid(req)) throw new Error('Account not found.');
  return acc;
}

function ownedGroup(req, id) {
  const g = d.getGroup(Number(id));
  if (!g || g.user_id !== uid(req)) throw new Error('Group not found.');
  return g;
}

// --- state ------------------------------------------------------------------

router.get('/state', (req, res) => {
  const me = uid(req);
  const accounts = d.listAccountsPublic(me); // api_key never leaves the server

  // Currencies are totalled separately. Adding USD to EUR and labelling the
  // result with one of them was how the old summary strip lied.
  const totals = { available: {}, pending: {} };
  for (const a of accounts) {
    for (const [c, v] of Object.entries(a.balances_available || {})) {
      totals.available[c] = (totals.available[c] || 0) + v;
    }
    for (const [c, v] of Object.entries(a.balances_pending || {})) {
      totals.pending[c] = (totals.pending[c] || 0) + v;
    }
  }

  res.json({
    groups: d.listGroups(me),
    accounts,
    events: d.listEvents(me, 400),
    totals,
    last_poll: d.getSetting('last_poll', ''),
    last_poll_ms: Number(d.getSetting('last_poll_ms', '0')),
    last_stall: d.getSetting('last_stall', ''),
    poll_enabled: d.getSetting('poll_enabled', '1') === '1',
    poll_seconds: Number(d.getSetting('poll_seconds', '60')),
    muted_until: Number(d.getUserSetting(me, 'mute_until', '0')),
    is_admin: auth.currentUser(req).role === 'admin',
    version: d.getVersion(),
  });
});

/** Daily history: what every trend line, sparkline and total is drawn from. */
router.get('/stats', safe((req, res) => {
  const me = uid(req);
  const allTime = String(req.query.days || '').toLowerCase() === 'all';
  const days = allTime ? null : Math.max(1, Math.min(730, Number(req.query.days) || 30));
  res.json({
    days: allTime ? 'all' : days,
    totals: d.dailyTotals(me, days),
    per_account: d.listDailyStats(me, days),
  });
}));

router.get('/version', (req, res) => res.json({ version: d.getVersion() }));

// --- groups -----------------------------------------------------------------

router.post('/groups', safe((req, res) => res.json({ id: d.createGroup(uid(req), req.body?.name) })));

router.patch('/groups/:id', safe((req, res) => {
  ownedGroup(req, req.params.id);
  res.json({ changes: d.renameGroup(Number(req.params.id), req.body?.name) });
}));

router.delete('/groups/:id', safe((req, res) => {
  ownedGroup(req, req.params.id);
  res.json({ changes: d.deleteGroup(Number(req.params.id)) });
}));

// --- accounts ---------------------------------------------------------------

router.post('/accounts', safe((req, res) => {
  const body = { ...(req.body || {}) };
  // can't file an account under someone else's group
  if (body.group_id) ownedGroup(req, body.group_id);
  res.json({ id: d.createAccount(uid(req), body) });
}));

router.patch('/accounts/:id', safe((req, res) => {
  ownedAccount(req, req.params.id);
  const body = { ...(req.body || {}) };
  if (body.group_id) ownedGroup(req, body.group_id);
  res.json({ changes: d.patchAccount(Number(req.params.id), body) });
}));

router.delete('/accounts/:id', safe((req, res) => {
  ownedAccount(req, req.params.id);
  res.json({ changes: d.deleteAccount(Number(req.params.id)) });
}));

/**
 * Card positions from the drag layer. body: [{id, x, y}, ...]
 * A null x/y clears the position so the card falls back to auto-layout.
 */
router.post('/positions', safe((req, res) => {
  for (const p of req.body || []) {
    ownedAccount(req, p.id);
    const clear = p.x === null || p.y === null;
    d.setPosition(Number(p.id), clear ? null : Number(p.x), clear ? null : Number(p.y));
  }
  res.json({ ok: true });
}));

router.get('/accounts/:id/next-payout', safe(async (req, res) => {
  const account = ownedAccount(req, req.params.id);
  const key = typeof d.accountKey === 'function' ? d.accountKey(account) : account.api_key;
  if (!key) throw new Error('Add a Stripe API key for this account first.');
  res.set('Cache-Control', 'no-store');
  res.json(await nextPayout(account, key));
}));

router.get('/accounts/:id/activity', safe(async (req, res) => {
  const account = ownedAccount(req, req.params.id);
  const after = String(req.query.after || '');
  if (after && !/^ch_[A-Za-z0-9]+$/.test(after)) throw new Error('Invalid charge cursor.');
  const key = typeof d.accountKey === 'function' ? d.accountKey(account) : account.api_key;
  if (!key) throw new Error('Add a Stripe API key for this account first.');
  res.set('Cache-Control', 'no-store');
  res.json(await activity(account, key, after));
}));

// --- credentials ------------------------------------------------------------

/** Decrypted values — only sent when the owner explicitly asks to reveal them. */
router.get('/accounts/:id/credentials', safe((req, res) => {
  ownedAccount(req, req.params.id);
  res.json(d.getCredentials(Number(req.params.id)));
}));

router.put('/accounts/:id/credentials', safe((req, res) => {
  ownedAccount(req, req.params.id);
  res.json({ changes: d.setCredentials(Number(req.params.id), req.body || {}) });
}));

/** Business / onboarding record — same reveal-on-request rule as credentials. */
router.get('/accounts/:id/business', safe((req, res) => {
  ownedAccount(req, req.params.id);
  res.json(d.getBusiness(Number(req.params.id)));
}));

router.put('/accounts/:id/business', safe((req, res) => {
  ownedAccount(req, req.params.id);
  res.json({ changes: d.setBusiness(Number(req.params.id), req.body || {}) });
}));

/** Validate a key against Stripe, then store it and pull first data. */
router.post('/accounts/:id/key', safe(async (req, res) => {
  ownedAccount(req, req.params.id);
  const id = Number(req.params.id);
  const key = String(req.body?.api_key || '').trim();
  if (!key) throw new Error('Paste a Stripe API key first.');
  if (!/^(rk|sk)_(test|live)_/.test(key)) {
    throw new Error('That does not look like a Stripe secret key (it should start with rk_ or sk_).');
  }
  const info = await stripe.testKey(key); // throws if Stripe rejects it
  d.patchAccount(id, { api_key: key });
  const acc = d.getAccount(id);
  await stripe.pollAccount(acc);
  res.json({ ok: true, info });
}));

router.post('/accounts/:id/poll', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await stripe.pollAccount(acc));
}));

// --- actions (the only routes that write to Stripe) -------------------------

/**
 * Every one of these is reached from an explicit confirmation in the browser,
 * scoped to an account the signed-in user owns, and recorded as an event.
 */

/**
 * The action queue for the whole fleet. One request, scanned concurrently on
 * the server rather than 41 round-trips from the browser.
 */
router.get('/pending', safe(async (req, res) => {
  res.json(await actions.pendingForUser(uid(req)));
}));

/**
 * The full worklist: every actionable item across the fleet, each one already
 * enriched with the charge behind it so nothing has to be looked up by hand.
 */
router.get('/worklist', safe(async (req, res) => {
  res.json(await actions.worklistForUser(uid(req)));
}));

/** What is waiting on a decision for this account, live from Stripe. */
router.get('/accounts/:id/pending', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.pending(acc));
}));

/** Charge detail, so a refund dialog can show what is actually being refunded. */
router.get('/accounts/:id/charge/:charge', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.loadCharge(acc, String(req.params.charge)));
}));

router.post('/accounts/:id/refund', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.refund(acc, req.body || {}));
}));

router.post('/accounts/:id/review', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.review(acc, req.body || {}));
}));

router.post('/accounts/:id/dispute/close', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.closeDispute(acc, req.body || {}));
}));

router.post('/accounts/:id/dispute/evidence', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.submitEvidence(acc, req.body || {}));
}));

/** What this account's key is actually permitted to do. */
router.get('/accounts/:id/capabilities', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.capabilities(acc));
}));

/** Paste any Stripe id (or an email) and get the object back. */
router.get('/accounts/:id/lookup', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.lookup(acc, req.query.q));
}));

/** Teach Radar: this charge was fraud, or it was fine after all. */
router.post('/accounts/:id/fraud-report', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.reportFraud(acc, req.body || {}));
}));

router.get('/accounts/:id/blocklists', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.blockLists(acc));
}));

router.post('/accounts/:id/block', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.block(acc, req.body || {}));
}));

router.post('/accounts/:id/unblock', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.unblock(acc, req.body || {}));
}));

/** Take authorised-but-uncaptured funds. */
router.post('/accounts/:id/capture', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.capture(acc, req.body || {}));
}));

router.post('/accounts/:id/cancel-payment', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.cancelPayment(acc, req.body || {}));
}));

/** Stop a payout in flight, or claw back one already sent. */
router.post('/accounts/:id/payout-action', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.payoutAction(acc, req.body || {}));
}));

router.post('/accounts/:id/subscription/cancel', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.cancelSubscription(acc, req.body || {}));
}));

router.post('/accounts/:id/invoice', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.invoiceAction(acc, req.body || {}));
}));

router.post('/accounts/:id/customer/delete', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.deleteCustomer(acc, req.body || {}));
}));

router.post('/accounts/:id/payout', safe(async (req, res) => {
  const acc = ownedAccount(req, req.params.id);
  res.json(await actions.payout(acc, req.body || {}));
}));

// --- polling ----------------------------------------------------------------

/** "Check all now" only checks your own accounts. */
router.post('/poll', safe(async (req, res) => {
  const results = await stripe.pollUser(uid(req));
  const tg = await telegram.flush().catch((e) => ({ sent: 0, error: e.message }));
  await sheets.maybeAutoPush(uid(req)).catch(() => {});
  res.json({ results, telegram: tg });
}));

/**
 * Server-wide, not personal: one background loop serves everybody. A member
 * unticking this used to switch off monitoring for every account on the machine,
 * silently, from a card labelled as their own preferences.
 */
router.post('/poll/toggle', auth.requireAdmin, safe((req, res) => {
  d.setSetting('poll_enabled', req.body?.enabled ? '1' : '0');
  res.json({ ok: true });
}));

// --- events -----------------------------------------------------------------

router.delete('/events', safe((req, res) => { d.clearEvents(uid(req)); res.json({ ok: true }); }));

// --- telegram ---------------------------------------------------------------

router.get('/telegram', (req, res) => {
  const me = uid(req);
  const cfg = telegram.config(me);
  res.json({
    has_token: !!cfg.token,
    chat_id: cfg.chatId,
    chat_name: d.getUserSetting(me, 'tg_chat_name', ''),
    ready: cfg.ready,
    kinds: [...telegram.enabledKinds(me)],
    all_kinds: telegram.ALL_KINDS,
    verbose: d.getUserSetting(me, 'verbose_events', '0') === '1',
    poll_seconds: Number(d.getSetting('poll_seconds', '60')), // server-wide
    commands: telegram.COMMANDS,
    muted_until: Number(d.getUserSetting(me, 'mute_until', '0')),
  });
});

/** Pause or resume this user's own alerts — same switch as /mute in the bot. */
router.post('/telegram/mute', safe((req, res) => {
  const me = uid(req);
  const mins = Number(req.body?.minutes);
  const until = mins > 0 ? Date.now() + Math.min(mins, 1440) * 60_000 : 0;
  d.setUserSetting(me, 'mute_until', String(until));
  res.json({ ok: true, muted_until: until });
}));

router.post('/telegram', safe((req, res) => {
  const me = uid(req);
  const { token, kinds, poll_seconds, verbose } = req.body || {};
  if (verbose !== undefined) d.setUserSetting(me, 'verbose_events', verbose ? '1' : '0');
  if (token !== undefined && String(token).trim() !== '') {
    const t = String(token).trim();
    if (!/^\d+:[\w-]{30,}$/.test(t)) {
      throw new Error('That does not look like a bot token — BotFather gives something like 123456789:AAE…');
    }
    d.setUserSecret(me, 'tg_token', t);
    // a new bot means the old chat id is meaningless
    d.setUserSetting(me, 'tg_chat_id', '');
    d.setUserSetting(me, 'tg_chat_name', '');
  }
  if (Array.isArray(kinds)) d.setUserSetting(me, 'tg_kinds', kinds.join(','));
  if (poll_seconds !== undefined) {
    // Shared by everyone, so only an owner may move it.
    if (auth.currentUser(req).role !== 'admin') {
      throw Object.assign(new Error('Only the owner can change how often the server checks Stripe.'), { status: 403 });
    }
    const n = Math.max(20, Math.min(3600, Number(poll_seconds) || 60));
    d.setSetting('poll_seconds', String(n));
  }
  res.json({ ok: true });
}));

router.post('/telegram/detect', safe(async (req, res) => {
  const me = uid(req);
  const found = await telegram.detectChatId(me);
  if (!found) throw new Error('No chat found yet — open your bot in Telegram and press Start (or send it any message), then try again.');
  d.setUserSetting(me, 'tg_chat_id', found.chatId);
  d.setUserSetting(me, 'tg_chat_name', found.name);
  res.json({ ok: true, ...found });
}));

router.post('/telegram/test', safe(async (req, res) => {
  await telegram.sendMessage(uid(req),
    '✅ <b>Stripe Tracker connected.</b>\nYou will get alerts here for sales, declines, disputes, refunds, payouts and account problems.');
  res.json({ ok: true });
}));

// --- field lookups ----------------------------------------------------------

/** Type an address, get structured suggestions back. */
router.get('/lookup/address', safe(async (req, res) => {
  res.json({ results: await lookup.searchAddress(req.query.q) });
}));

/** Routing number -> bank name, the way Stripe fills it in. */
router.get('/lookup/routing', safe(async (req, res) => {
  res.json(await lookup.lookupRouting(req.query.rn));
}));

// --- google sheets ----------------------------------------------------------

router.get('/sheets/config', (req, res) => {
  const me = uid(req);
  const cfg = sheets.getConfig(me);
  res.json({
    configured: !!cfg,
    sheet_id: d.getUserSetting(me, 'sheet_id', ''),
    client_email: cfg ? cfg.sa.client_email : null,
    auto: d.getUserSetting(me, 'sheets_auto', '1') === '1',
    include_secrets: sheets.includeSecrets(me),
    last_push: JSON.parse(d.getUserSetting(me, 'last_sheet_push') || 'null'),
  });
});

router.post('/sheets/config', safe((req, res) => {
  const me = uid(req);
  const { sheet, service_account_json, auto, include_secrets } = req.body || {};

  if (sheet !== undefined && String(sheet).trim() !== '') {
    // accept a full Sheets URL or a bare spreadsheet id
    const m = String(sheet).match(/\/d\/([a-zA-Z0-9-_]+)/);
    const id = m ? m[1] : String(sheet).trim();
    if (!id) throw new Error('Spreadsheet URL or ID is empty.');
    d.setUserSetting(me, 'sheet_id', id);
  }

  if (service_account_json !== undefined && String(service_account_json).trim() !== '') {
    let sa;
    try {
      sa = JSON.parse(service_account_json);
    } catch {
      throw new Error('That is not valid JSON — paste the whole service-account key file.');
    }
    if (!sa.client_email || !sa.private_key) {
      throw new Error('JSON is missing client_email/private_key — make sure it is a service-account key.');
    }
    d.setUserSecret(me, 'service_account', JSON.stringify(sa));
  }

  if (auto !== undefined) d.setUserSetting(me, 'sheets_auto', auto ? '1' : '0');
  if (include_secrets !== undefined) d.setUserSetting(me, 'sheets_include_secrets', include_secrets ? '1' : '0');

  res.json({ ok: true });
}));

router.post('/sheets/push', safe(async (req, res) => {
  res.json({ ok: true, report: await sheets.pushNow(uid(req)) });
}));

module.exports = router;
