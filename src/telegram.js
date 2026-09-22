'use strict';

/**
 * telegram.js — pushes each user's unnotified events to their own Telegram chat.
 *
 * Per-user, like the Google Sheet: everyone connects their own bot (token from
 * @BotFather) and their own chat. Alerts about your accounts only ever reach
 * your bot; nothing crosses between users.
 *
 * Setup is the user's: talk to @BotFather, create a bot, paste the token, then
 * press Start in the chat so the bot may message them. getUpdates finds the
 * chat id automatically so nobody has to hunt for a numeric id.
 */

const d = require('./db');

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

const ALL_KINDS = [
  'sale', 'risk', 'decline', 'review', 'fraud', 'inquiry', 'dispute',
  'refund', 'payout', 'paused', 'health', 'error', 'other',
];

/** Failures that mean the chat itself is unusable, not just this one message. */
const CHAT_UNREACHABLE =
  /chat not found|bot was blocked|bot was kicked|unauthorized|deactivated|not enough rights|have no rights|not a member|CHAT_WRITE_FORBIDDEN|chat_id is empty/i;

function config(userId) {
  const token = d.getUserSetting(userId, 'tg_token', '');
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
  const res = await fetch(API(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(json.description || `Telegram ${method} failed (HTTP ${res.status})`);
    // Telegram answers some failures with the information needed to recover —
    // notably migrate_to_chat_id when a group becomes a supergroup, and
    // retry_after when we are rate limited. Keep it on the error.
    err.status = res.status;
    err.errorCode = json.error_code;
    err.parameters = json.parameters || {};
    throw err;
  }
  return json.result;
}

/**
 * Is this worth trying again later, or is the message never going to land?
 * Anything we cannot classify is treated as permanent: a message that keeps
 * failing must not sit at the head of the queue and block everything behind it.
 */
function isTransient(err) {
  if (err.status === undefined) return true; // fetch/DNS/timeout — no HTTP reply
  if (err.status === 429) return true; // rate limited
  return err.status >= 500; // Telegram-side outage
}

/** Ask Telegram which chat this user's bot was started in. */
async function detectChatId(userId) {
  const { token } = config(userId);
  const updates = await tg(token, 'getUpdates', {});
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

function formatEvent(ev) {
  const head = `${ICON[ev.severity] || 'ℹ️'} <b>${esc(ev.title)}</b>`;
  const lines = [head];
  if (ev.detail) lines.push(esc(ev.detail));
  if (ev.account_label && !String(ev.title).includes(ev.account_label)) {
    lines.push(`<i>Account: ${esc(ev.account_label)}</i>`);
  }
  return lines.join('\n');
}

function formatPayoutSummary(results) {
  const working = (results || []).filter((r) => r.ok && r.health === 'healthy' && r.payouts_enabled);
  const lines = ['🏦 <b>Payout summary — working accounts</b>'];

  if (!working.length) {
    lines.push('No healthy, payout-enabled accounts were found.');
    return lines.join('\n');
  }

  for (const r of working) {
    const label = esc(r.label || `Account ${r.id}`);
    const p = r.payout;
    if (!p) {
      const note = r.payout_error ? `Payout details unavailable: ${esc(r.payout_error)}` : 'No payout is currently scheduled.';
      lines.push(`\n✅ <b>${label}</b>\n${note}`);
      continue;
    }
    const amount = `${Number(p.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${esc(String(p.currency).toUpperCase())}`;
    const when = p.arrival_date
      ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(p.arrival_date * 1000))
      : 'date not supplied by Stripe';
    const status = String(p.status).replace(/_/g, ' ');
    lines.push(
      `\n✅ <b>${label}</b>`,
      `${p.is_upcoming ? 'Next payout' : 'Latest payout'}: <b>${amount}</b>`,
      `Status: ${esc(status)} · Bank date: <b>${esc(when)}</b>`,
      `Method: ${esc(p.method || 'standard')}${p.destination ? ` · ${esc(p.destination)}` : ''}`
    );
  }
  lines.push('\n<i>Dates are shown in UTC and come directly from Stripe.</i>');
  return lines.join('\n');
}

async function sendPayoutSummary(userId, results) {
  if (!config(userId).ready) return { sent: 0, skipped: 'telegram not connected' };
  if (!enabledKinds(userId).has('payout')) return { sent: 0, skipped: 'payout alerts muted' };
  await sendMessage(userId, formatPayoutSummary(results));
  return { sent: 1 };
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
    const moved = err.parameters?.migrate_to_chat_id;
    if (!moved) throw err;

    d.setUserSetting(userId, 'tg_chat_id', String(moved));
    console.log(`[telegram] user ${userId}: chat migrated to supergroup ${moved}, saved`);
    return tg(token, 'sendMessage', { chat_id: String(moved), ...payload });
  }
}

/**
 * Send everything not yet sent, each user through their own bot.
 * Marks as notified even on a permanent failure so one bad event can't block
 * the queue forever.
 */
async function flush() {
  const pending = d.unnotifiedEvents();
  if (!pending.length) return { sent: 0 };

  // group by owner so each batch uses the right bot
  const byUser = new Map();
  for (const ev of pending) {
    if (!ev.user_id) continue; // orphaned event, nothing to send it to
    if (!byUser.has(ev.user_id)) byUser.set(ev.user_id, []);
    byUser.get(ev.user_id).push(ev);
  }

  const done = [];
  let sent = 0;

  for (const [userId, events] of byUser) {
    const cfg = config(userId);
    if (!cfg.ready) continue; // this user hasn't connected a bot; leave queued
    const kinds = enabledKinds(userId);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!kinds.has(ev.kind)) { done.push(ev.id); continue; } // muted kind
      try {
        await sendMessage(userId, formatEvent(ev));
        done.push(ev.id);
        sent++;
      } catch (e) {
        if (isTransient(e)) {
          // Worth another go: leave the batch queued and pick it up next cycle.
          console.error(`[telegram] user ${userId}: ${e.message} — will retry`);
          break;
        }
        if (CHAT_UNREACHABLE.test(e.message)) {
          // The problem is the chat, not this message, so nothing queued for
          // this user can land. Drop the batch instead of retrying it forever —
          // that is what silently stopped every alert once before.
          for (let j = i; j < events.length; j++) done.push(events[j].id);
          console.error(
            `[telegram] user ${userId}: ${e.message} — dropped ${events.length - i} alert(s); ` +
            'reconnect the bot in Settings'
          );
          break;
        }
        // Just this message is unsendable; the rest of the batch may be fine.
        done.push(ev.id);
        console.error(`[telegram] user ${userId}: ${e.message} — dropped 1 alert`);
      }
    }
  }

  d.markNotified(done);
  return { sent };
}

module.exports = {
  config, detectChatId, sendMessage, sendPayoutSummary, formatPayoutSummary,
  flush, enabledKinds, tg, ALL_KINDS,
};
