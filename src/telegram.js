'use strict';

/**
 * telegram.js — pushes each user's unnotified events to their own Telegram chat,
 * and answers commands sent back to the bot.
 *
 * Per-user, like the Google Sheet: everyone connects their own bot (token from
 * @BotFather) and their own chat. Alerts about your accounts only ever reach
 * your bot; nothing crosses between users.
 *
 * Three things this had to learn:
 *   1. Telegram allows roughly 20 messages a minute to a group. One message per
 *      event meant a burst of sales hit 429, and the logs filled with
 *      "Too Many Requests: retry after 41". Routine batches are now digested.
 *   2. `retry_after` was captured on the error object and then never used.
 *   3. Messages over 4,096 characters are rejected outright — a long fraud
 *      warning carrying refund advice could cross it and be dropped as
 *      permanently unsendable.
 */

const d = require('./db');
const { requestJSON, sleep } = require('./http');

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

/** Telegram's hard ceiling is 4,096; leave room for the truncation footer. */
const MAX_CHARS = 3900;

/** Above this many routine alerts, send one digest instead of N messages. */
const DIGEST_THRESHOLD = 4;

const ALL_KINDS = [
  'sale', 'risk', 'decline', 'review', 'fraud', 'inquiry', 'dispute',
  'refund', 'payout', 'paused', 'health', 'error', 'action', 'other',
];

/** Kinds that always go out on their own, however busy the queue is. */
const NEVER_DIGEST = new Set(['fraud', 'inquiry', 'dispute', 'paused', 'action']);

/** Failures that mean the chat itself is unusable, not just this one message. */
const CHAT_UNREACHABLE =
  /chat not found|bot was blocked|bot was kicked|unauthorized|deactivated|not enough rights|have no rights|not a member|CHAT_WRITE_FORBIDDEN|chat_id is empty/i;

function config(userId) {
  const token = d.getUserSecret(userId, 'tg_token', '');
  const chatId = d.getUserSetting(userId, 'tg_chat_id', '');
  return { token, chatId, ready: !!token && !!chatId };
}

/** Which event kinds this user wants pushed. All on by default. */
function enabledKinds(userId) {
  const raw = d.getUserSetting(userId, 'tg_kinds', ALL_KINDS.join(','));
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

async function tg(token, method, body) {
  if (!token) throw new Error('No Telegram bot token saved yet.');
  const json = await requestJSON(API(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    timeout: 20_000,
    retries: 1,
    // Telegram answers 200 OK with {ok:false} for application errors, so the
    // HTTP status alone is not the verdict.
    isOk: (j) => j && j.ok === true,
    parseError: (j, res) => j?.description || `Telegram ${method} failed (HTTP ${res.status})`,
    retryAfterFrom: (j) => j?.parameters?.retry_after || null,
  });
  return json.result;
}

/** Ask Telegram which chat this user's bot was started in. */
async function detectChatId(userId) {
  const { token } = config(userId);
  const updates = await tg(token, 'getUpdates', { timeout: 0 });
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat || updates[i].channel_post?.chat;
    if (chat?.id) return { chatId: String(chat.id), name: chat.title || chat.first_name || chat.username || '' };
  }
  return null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const ICON = { critical: '🚨', warning: '⚠️', good: '✅', info: 'ℹ️' };

/**
 * Keep a message inside Telegram's limit. Cutting mid-tag would break the HTML
 * parse and get the whole message rejected, so trim back to a line break.
 */
function clamp(text) {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const at = cut.lastIndexOf('\n');
  return `${at > MAX_CHARS * 0.6 ? cut.slice(0, at) : cut}\n…<i>(truncated)</i>`;
}

function formatEvent(ev) {
  const lines = [`${ICON[ev.severity] || 'ℹ️'} <b>${esc(ev.title)}</b>`];
  if (ev.detail) lines.push(esc(ev.detail));
  if (ev.account_label && !String(ev.title).includes(ev.account_label)) {
    lines.push(`<i>Account: ${esc(ev.account_label)}</i>`);
  }
  return clamp(lines.join('\n'));
}

/**
 * Roll a batch of routine alerts into one message.
 *
 * A burst of sales used to be a burst of notifications, which is how the rate
 * limit got hit. Grouping by kind also makes the shape of the last few minutes
 * readable at a glance instead of a wall of near-identical lines.
 */
function formatDigest(events) {
  const KIND_LABEL = {
    sale: '💰 Sales', risk: '⚡ High-risk sales', decline: '❌ Declined',
    review: '🔍 Under review', refund: '↩️ Refunds', payout: '🏦 Payouts',
    health: '🩺 Account changes', error: '🔌 Connection',
    action: '⚡ Actions you took', other: 'ℹ️ Other',
  };

  const byKind = new Map();
  for (const ev of events) {
    if (!byKind.has(ev.kind)) byKind.set(ev.kind, []);
    byKind.get(ev.kind).push(ev);
  }

  const lines = [`📊 <b>${events.length} updates</b>`];

  for (const [kind, list] of byKind) {
    lines.push('', `<b>${KIND_LABEL[kind] || esc(kind)}</b> · ${list.length}`);

    // Money kinds get a total, per currency so nothing incomparable is summed.
    const totals = {};
    for (const e of list) {
      const amt = Number(e.amount) || 0;
      if (!amt || !e.currency) continue;
      const c = String(e.currency).toUpperCase();
      totals[c] = (totals[c] || 0) + amt;
    }
    const totalLine = Object.entries(totals)
      .map(([c, v]) => `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c}`)
      .join(' + ');
    if (totalLine) lines.push(`  ${totalLine} total`);

    const perAccount = new Map();
    for (const e of list) {
      const k = e.account_label || 'unknown';
      perAccount.set(k, (perAccount.get(k) || 0) + 1);
    }
    for (const [acct, n] of [...perAccount].slice(0, 8)) {
      lines.push(`  • ${esc(acct)}${n > 1 ? ` ×${n}` : ''}`);
    }
    if (perAccount.size > 8) lines.push(`  • …and ${perAccount.size - 8} more accounts`);
  }

  return clamp(lines.join('\n'));
}

async function sendMessage(userId, text) {
  const { token, chatId } = config(userId);
  if (!chatId) throw new Error('No Telegram chat id yet — press Start in your bot chat, then hit Detect.');

  const payload = { text, parse_mode: 'HTML', disable_web_page_preview: true };
  try {
    return await tg(token, 'sendMessage', { chat_id: chatId, ...payload });
  } catch (err) {
    // Turning a group into a supergroup changes its chat id for good, and every
    // later send fails until the new one is stored. Telegram hands us the new id
    // with the error, so adopt it and deliver rather than making the user redo
    // the setup by hand.
    const moved = err.body?.parameters?.migrate_to_chat_id;
    if (!moved) throw err;

    d.setUserSetting(userId, 'tg_chat_id', String(moved));
    console.log(`[telegram] user ${userId}: chat migrated to supergroup ${moved}, saved`);
    return tg(token, 'sendMessage', { chat_id: String(moved), ...payload });
  }
}

/** True while the user has asked for silence with /mute. */
function isMuted(userId) {
  return Number(d.getUserSetting(userId, 'mute_until', '0')) > Date.now();
}

/**
 * Send everything not yet sent, each user through their own bot.
 *
 * Urgent kinds always go out individually with their full detail — a fraud
 * warning carries the refund link, and burying that in a digest would defeat
 * the point of having it. Routine chatter above the threshold is summarised.
 */
async function flush() {
  const allPending = d.unnotifiedEvents();
  // Telegram muted only for STRIPE JW ATHENTIC (account 88; acct_1UIIOg0mN4FLtRDr).
  const mutedPending = allPending.filter((ev) => ev.account_stripe_id === 'acct_1UIIOg0mN4FLtRDr');
  if (mutedPending.length) d.markNotified(mutedPending.map((ev) => ev.id));
  const pending = allPending.filter((ev) => ev.account_stripe_id !== 'acct_1UIIOg0mN4FLtRDr');
  if (!pending.length) return { sent: 0 };

  const byUser = new Map();
  for (const ev of pending) {
    if (!ev.user_id) continue; // orphaned event, nothing to send it to
    if (!byUser.has(ev.user_id)) byUser.set(ev.user_id, []);
    byUser.get(ev.user_id).push(ev);
  }

  const done = [];
  let sent = 0;

  for (const [userId, all] of byUser) {
    const cfg = config(userId);
    if (!cfg.ready) continue;  // this user hasn't connected a bot; leave queued
    if (isMuted(userId)) continue;
    const kinds = enabledKinds(userId);

    // Drop muted kinds up front so they never count toward the digest.
    const wanted = [];
    for (const ev of all) {
      if (kinds.has(ev.kind)) wanted.push(ev);
      else done.push(ev.id);
    }
    if (!wanted.length) continue;

    const urgent = wanted.filter((e) => NEVER_DIGEST.has(e.kind) || e.severity === 'critical');
    const routine = wanted.filter((e) => !urgent.includes(e));

    /** Returns false when the rest of this user's batch should wait a cycle. */
    const deliver = async (text, ids) => {
      try {
        await sendMessage(userId, text);
        done.push(...ids);
        sent++;
        await sleep(1200); // stay under ~20 messages/minute to a group chat
        return true;
      } catch (e) {
        if (e.transient) {
          const wait = e.retryAfterMs ? ` (Telegram asked for ${Math.round(e.retryAfterMs / 1000)}s)` : '';
          console.error(`[telegram] user ${userId}: ${e.message}${wait} — will retry next cycle`);
          return false;
        }
        if (CHAT_UNREACHABLE.test(e.message)) {
          // The problem is the chat, not this message, so nothing queued for
          // this user can land. Stop rather than burning the whole batch.
          console.error(`[telegram] user ${userId}: ${e.message} — reconnect the bot in Settings`);
          return false;
        }
        // Just this message is unsendable; the rest of the batch may be fine.
        done.push(...ids);
        console.error(`[telegram] user ${userId}: ${e.message} — dropped ${ids.length} alert(s)`);
        return true;
      }
    };

    let ok = true;
    for (const ev of urgent) {
      ok = await deliver(formatEvent(ev), [ev.id]);
      if (!ok) break;
    }
    if (!ok) continue;

    if (routine.length >= DIGEST_THRESHOLD) {
      await deliver(formatDigest(routine), routine.map((e) => e.id));
    } else {
      for (const ev of routine) {
        if (!(await deliver(formatEvent(ev), [ev.id]))) break;
      }
    }
  }

  d.markNotified(done);
  return { sent };
}

// --- commands ---------------------------------------------------------------

/**
 * The bot could only ever talk at you. Now it answers back, so the fleet can be
 * checked from a phone without opening the tunnel at all.
 *
 * getUpdates is called with `timeout: 0` — never long-polling — so reading
 * commands can't hold the main poll loop open.
 */
const COMMANDS = {
  '/status': 'fleet health, one line per problem account',
  '/balance': 'available and pending, per currency',
  '/today': "today's sales and volume",
  '/week': 'the last 7 days, with a chart',
  '/mute': 'pause alerts for one hour',
  '/unmute': 'resume alerts',
  '/help': 'this list',
};

const HEALTH_ICON = {
  healthy: '🟢', docs: '🟡', restricted: '🟠', suspended: '🔴',
  pending: '🔵', error: '🔌', unknown: '⚪',
};

function moneyLine(map) {
  const entries = Object.entries(map || {}).filter(([, v]) => Math.abs(v) > 0.005);
  if (!entries.length) return '0';
  return entries
    .map(([c, v]) => `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.toUpperCase()}`)
    .join(' + ');
}

function buildStatus(userId) {
  const accounts = d.listAccountsPublic(userId);
  if (!accounts.length) return 'No Stripe accounts connected yet.';

  const bad = accounts.filter((a) => ['suspended', 'restricted', 'docs', 'error'].includes(a.health));
  const lines = [
    `<b>${accounts.length} accounts</b> · ${accounts.length - bad.length} healthy · ${bad.length} need attention`,
  ];
  if (!bad.length) {
    lines.push('', 'Everything is healthy. ✅');
    return lines.join('\n');
  }
  lines.push('');
  for (const a of bad.slice(0, 20)) {
    lines.push(`${HEALTH_ICON[a.health] || '⚪'} <b>${esc(a.label)}</b> — ${esc(a.health)}`);
    if (a.requirements) lines.push(`    needs: ${esc(a.requirements)}`);
    else if (a.last_error) lines.push(`    ${esc(a.last_error)}`);
  }
  if (bad.length > 20) lines.push(`…and ${bad.length - 20} more`);
  return clamp(lines.join('\n'));
}

function buildBalance(userId) {
  const accounts = d.listAccountsPublic(userId);
  const avail = {};
  const pend = {};
  const add = (into, map) => {
    for (const [c, v] of Object.entries(map || {})) into[c] = (into[c] || 0) + v;
  };
  for (const a of accounts) {
    add(avail, a.balances_available);
    add(pend, a.balances_pending);
  }
  return [
    '<b>Fleet balance</b>',
    `Available: ${moneyLine(avail)}`,
    `Pending: ${moneyLine(pend)}`,
    '',
    `<i>Across ${accounts.length} accounts. Currencies are kept apart, never summed.</i>`,
  ].join('\n');
}

function buildToday(userId) {
  const accounts = d.listAccountsPublic(userId);
  const sales = accounts.reduce((s, a) => s + (a.sales_today || 0), 0);
  const volume = accounts.reduce((s, a) => s + (a.volume_today || 0), 0);
  const top = accounts
    .filter((a) => a.sales_today > 0)
    .sort((a, b) => (b.volume_today || 0) - (a.volume_today || 0))
    .slice(0, 5);

  const lines = [
    `<b>Today: ${sales} sale${sales === 1 ? '' : 's'}</b>`,
    `${volume.toLocaleString('en-US', { maximumFractionDigits: 2 })} in volume`,
  ];
  if (top.length) {
    lines.push('');
    for (const a of top) {
      lines.push(`  • ${esc(a.label)} — ${a.sales_today} × ${Math.round(a.volume_today).toLocaleString('en-US')}`);
    }
  }
  return lines.join('\n');
}

function buildWeek(userId) {
  const rows = d.dailyTotals(userId, 7);
  if (!rows.length) return 'No history yet — it starts building from the next check.';

  const max = Math.max(...rows.map((r) => r.volume || 0), 1);
  const lines = ['<b>Last 7 days</b>', '<pre>'];
  for (const r of rows) {
    const bars = '█'.repeat(Math.max(1, Math.round(((r.volume || 0) / max) * 12)));
    const vol = Math.round(r.volume || 0).toLocaleString('en-US').padStart(9);
    lines.push(`${r.day.slice(5)} ${vol}  ${bars}`);
  }
  lines.push('</pre>');

  const sales = rows.reduce((s, r) => s + (r.sales || 0), 0);
  const volume = rows.reduce((s, r) => s + (r.volume || 0), 0);
  const disputes = rows.reduce((s, r) => s + (r.disputes || 0), 0);
  lines.push(`${sales} sales · ${Math.round(volume).toLocaleString('en-US')} volume`);
  if (disputes) lines.push(`⚠️ ${disputes} dispute${disputes === 1 ? '' : 's'} this week`);
  return lines.join('\n');
}

function answer(userId, text) {
  const cmd = String(text || '').trim().split(/[\s@]/)[0].toLowerCase();
  switch (cmd) {
    case '/status': return buildStatus(userId);
    case '/balance': return buildBalance(userId);
    case '/today': return buildToday(userId);
    case '/week': return buildWeek(userId);
    case '/mute':
      d.setUserSetting(userId, 'mute_until', String(Date.now() + 3600_000));
      return '🔕 Alerts paused for one hour. Send /unmute to resume sooner.';
    case '/unmute':
      d.setUserSetting(userId, 'mute_until', '0');
      return '🔔 Alerts resumed.';
    case '/help':
    case '/start':
      return ['<b>Stripe Tracker</b>', '', ...Object.entries(COMMANDS).map(([c, w]) => `${c} — ${w}`)].join('\n');
    default:
      return null; // not one of ours; stay quiet
  }
}

/**
 * Read new messages for one user's bot and reply to any command.
 * The update offset is stored so each message is handled exactly once.
 */
async function pollCommands(userId) {
  const cfg = config(userId);
  if (!cfg.ready) return 0;

  const offset = Number(d.getUserSetting(userId, 'tg_offset', '0'));
  let updates;
  try {
    updates = await tg(cfg.token, 'getUpdates', { offset: offset || undefined, timeout: 0, limit: 20 });
  } catch (e) {
    if (!e.transient) console.error(`[telegram] user ${userId}: command poll — ${e.message}`);
    return 0;
  }
  if (!updates.length) return 0;

  let handled = 0;
  for (const u of updates) {
    d.setUserSetting(userId, 'tg_offset', String(u.update_id + 1));
    const msg = u.message || u.channel_post;
    if (!msg?.text) continue;
    // Only answer in the chat this user connected, never any chat the bot joins.
    if (String(msg.chat?.id) !== String(cfg.chatId)) continue;

    const reply = answer(userId, msg.text);
    if (!reply) continue;
    try {
      await sendMessage(userId, reply);
      handled++;
      await sleep(400);
    } catch (e) {
      console.error(`[telegram] user ${userId}: reply failed — ${e.message}`);
    }
  }
  return handled;
}

/** Answer commands for every user who has connected a bot. */
async function pollAllCommands() {
  let handled = 0;
  for (const u of d.listUsers()) {
    if (!u.active) continue;
    handled += await pollCommands(u.id).catch(() => 0);
  }
  return handled;
}

module.exports = {
  config, detectChatId, sendMessage, flush, enabledKinds, tg,
  ALL_KINDS, COMMANDS, pollCommands, pollAllCommands, isMuted,
  formatDigest, formatEvent, answer,
};
