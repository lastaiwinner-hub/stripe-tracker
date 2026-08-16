'use strict';

/**
 * stripe.js — talks to the Stripe REST API and turns what it sees into events.
 *
 * Polling, not webhooks: this app runs on localhost, so Stripe could not reach
 * it with a webhook without a public tunnel. Every account is polled on a timer
 * with a per-account cursor so nothing is reported twice.
 *
 * Only read endpoints are used. A restricted (rk_…) read-only key is enough.
 */

const d = require('./db');

const API = 'https://api.stripe.com/v1';

/** GET a Stripe endpoint with one account's key. */
async function sget(key, path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  }
  const url = `${API}${path}${qs.toString() ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = json.error?.message || `HTTP ${res.status}`;
    const err = new Error(m);
    err.statusCode = res.status;
    err.stripeCode = json.error?.code;
    throw err;
  }
  return json;
}

/** Stripe amounts are in the smallest unit (cents). */
function toMajor(amount, currency) {
  const zeroDecimal = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
  if (!Number.isFinite(amount)) return 0;
  return zeroDecimal.includes(String(currency).toLowerCase()) ? amount : amount / 100;
}

function money(amount, currency) {
  const v = toMajor(amount, currency);
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${String(currency || '').toUpperCase()}`;
}

/**
 * Work out an account's health from what Stripe reports.
 * suspended > restricted > docs > pending > healthy
 */
function deriveHealth(acct) {
  const req = acct.requirements || {};
  const disabled = req.disabled_reason || '';
  if (!acct.charges_enabled && /rejected|terminated|suspend/i.test(disabled)) return 'suspended';
  if (Array.isArray(req.past_due) && req.past_due.length) return 'docs';
  if (!acct.charges_enabled || !acct.payouts_enabled) return 'restricted';
  if (Array.isArray(req.currently_due) && req.currently_due.length) return 'docs';
  if (req.pending_verification && req.pending_verification.length) return 'pending';
  return 'healthy';
}

/** Turn Stripe's requirement keys into something readable in Telegram. */
function prettyRequirements(req) {
  const all = [...(req.past_due || []), ...(req.currently_due || [])];
  if (!all.length) return '';
  return [...new Set(all)]
    .slice(0, 8)
    .map((r) => r.replace(/_/g, ' ').replace(/\./g, ' → '))
    .join(', ');
}

/**
 * Stripe event types worth a push. Anything not listed still gets recorded
 * when "verbose" is on, but these are the ones that matter unprompted.
 *
 *   kind     -> groups events for the per-type mute list in Settings
 *   severity -> critical | warning | good | info
 */
const EVENT_MAP = {
  // money in
  'charge.succeeded':                 { kind: 'sale',    severity: 'good',     icon: '💰', label: 'Sale' },
  // synthesised locally, not a real Stripe type — see pollEvents()
  'local.high_risk_sale':             { kind: 'risk',    severity: 'warning',  icon: '⚡', label: 'High-risk sale' },
  'local.dispute_inquiry':            { kind: 'inquiry', severity: 'critical', icon: '🔔', label: 'PRE-DISPUTE INQUIRY' },
  'payment_intent.succeeded':         { kind: 'sale',    severity: 'good',     icon: '💰', label: 'Payment succeeded', quiet: true },
  // money refused
  'charge.failed':                    { kind: 'decline', severity: 'warning',  icon: '❌', label: 'Payment declined' },
  'payment_intent.payment_failed':    { kind: 'decline', severity: 'warning',  icon: '❌', label: 'Payment failed' },
  'issuing_authorization.request':    { kind: 'decline', severity: 'info',     icon: '❌', label: 'Authorization request', quiet: true },
  // fraud / manual review
  'review.opened':                    { kind: 'review',  severity: 'warning',  icon: '🔍', label: 'Payment under review' },
  'review.closed':                    { kind: 'review',  severity: 'info',     icon: '🔍', label: 'Review closed' },
  'radar.early_fraud_warning.created':{ kind: 'fraud',   severity: 'critical', icon: '🚩', label: 'Early fraud warning' },
  // disputes — note charge.dispute.created also covers pre-dispute *inquiries*
  // (status warning_*), which are the early warning, not yet a chargeback.
  'charge.dispute.created':           { kind: 'dispute', severity: 'critical', icon: '⚠️', label: 'Dispute opened' },
  'charge.dispute.updated':           { kind: 'dispute', severity: 'warning',  icon: '⚠️', label: 'Dispute updated' },
  'charge.dispute.closed':            { kind: 'dispute', severity: 'info',     icon: '⚠️', label: 'Dispute closed' },
  'charge.dispute.funds_withdrawn':   { kind: 'dispute', severity: 'critical', icon: '⚠️', label: 'Dispute funds withdrawn' },
  'charge.dispute.funds_reinstated':  { kind: 'dispute', severity: 'good',     icon: '⚠️', label: 'Dispute funds returned' },
  // refunds
  'charge.refunded':                  { kind: 'refund',  severity: 'warning',  icon: '↩️', label: 'Refunded' },
  'charge.refund.updated':            { kind: 'refund',  severity: 'info',     icon: '↩️', label: 'Refund updated', quiet: true },
  // payouts
  'payout.paid':                      { kind: 'payout',  severity: 'info',     icon: '🏦', label: 'Payout paid' },
  'payout.failed':                    { kind: 'payout',  severity: 'critical', icon: '❌', label: 'Payout FAILED' },
  'payout.canceled':                  { kind: 'payout',  severity: 'warning',  icon: '🏦', label: 'Payout canceled' },
  // the account itself
  'account.updated':                  { kind: 'health',  severity: 'info',     icon: '🩺', label: 'Account updated', quiet: true },
  'capability.updated':               { kind: 'health',  severity: 'warning',  icon: '🩺', label: 'Capability changed', quiet: true },
  'account.application.deauthorized': { kind: 'health',  severity: 'critical', icon: '🩺', label: 'Application deauthorized' },
};

const HEALTH_LABEL = {
  healthy: 'Healthy',
  docs: 'Documents required',
  restricted: 'Restricted',
  suspended: 'Suspended',
  pending: 'Pending verification',
  error: 'Connection error',
  unknown: 'Not checked yet',
};

/** Human-readable one-liner for whatever object an event carries. */
function describeEvent(ev) {
  const o = ev.data?.object || {};
  const bits = [];

  switch (ev.type) {
    case 'charge.failed':
    case 'payment_intent.payment_failed': {
      const err = o.last_payment_error || {};
      const code = o.failure_code || err.decline_code || err.code || o.outcome?.reason || 'unknown';
      const msg = o.failure_message || err.message || o.outcome?.seller_message || '';
      bits.push(`Reason: ${code}`);
      if (msg) bits.push(msg);
      if (o.outcome?.type === 'blocked') bits.push('⛔ Blocked by Stripe Radar');
      if (o.outcome?.risk_level) bits.push(`Risk: ${o.outcome.risk_level}`);
      break;
    }
    case 'charge.succeeded':
      if (o.description) bits.push(o.description);
      if (o.billing_details?.email || o.receipt_email) bits.push(o.billing_details?.email || o.receipt_email);
      if (o.outcome?.risk_level && o.outcome.risk_level !== 'normal') bits.push(`Risk: ${o.outcome.risk_level}`);
      break;
    case 'review.opened':
      bits.push(`Reason: ${o.reason || 'unknown'}`);
      if (o.charge?.amount) bits.push(money(o.charge.amount, o.charge.currency));
      break;
    case 'review.closed':
      bits.push(`Closed as: ${o.closed_reason || 'unknown'}`);
      break;
    case 'radar.early_fraud_warning.created':
      bits.push(`Fraud type: ${o.fraud_type || 'unknown'}`);
      bits.push('The cardholder\'s bank reported this as fraud. A chargeback usually follows within days — refunding now normally prevents it.');
      break;
    case 'local.dispute_inquiry':
      bits.push(`Inquiry status: ${o.status}`);
      if (o.reason) bits.push(`Reason: ${o.reason}`);
      bits.push('This is a pre-dispute inquiry, NOT yet a chargeback. Refunding now usually stops it escalating.');
      if (o.evidence_details?.due_by) {
        bits.push(`Respond by: ${new Date(o.evidence_details.due_by * 1000).toUTCString()}`);
      }
      break;
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
      bits.push(`Reason: ${o.reason || 'unknown'} · status: ${o.status}`);
      if (o.evidence_details?.due_by) {
        bits.push(`Evidence due: ${new Date(o.evidence_details.due_by * 1000).toUTCString()}`);
      }
      break;
    case 'payout.failed':
      bits.push(`Status: ${o.status}`);
      if (o.failure_message) bits.push(o.failure_message);
      if (o.failure_balance_transaction) bits.push('Funds returned to your Stripe balance.');
      break;
    case 'payout.paid':
      if (o.arrival_date) bits.push(`Arrives ${new Date(o.arrival_date * 1000).toDateString()}`);
      break;
    case 'charge.refunded':
      if (o.amount_refunded) bits.push(`Refunded ${money(o.amount_refunded, o.currency)}`);
      break;
    default:
      if (o.status) bits.push(`Status: ${o.status}`);
  }
  return bits.filter(Boolean).join('\n');
}

/** Amount carried by an event's object, if any. */
function eventAmount(o) {
  const raw = o.amount ?? o.amount_captured ?? o.amount_refunded ?? null;
  return raw === null ? null : { raw, currency: o.currency || '' };
}

/**
 * For an early warning, look up the charge it points at and say plainly
 * whether a refund is still possible — that refund is what stops the
 * chargeback from ever being filed.
 */
async function refundAdvice(key, chargeId) {
  if (!chargeId) return '';
  try {
    const ch = await sget(key, `/charges/${chargeId}`);
    const lines = [`Charge: ${ch.id} · ${money(ch.amount, ch.currency)}`];
    const who = ch.billing_details?.email || ch.receipt_email;
    if (who) lines.push(`Customer: ${who}`);
    if (ch.description) lines.push(ch.description);

    if (ch.refunded) {
      lines.push('✅ Already fully refunded — nothing to do.');
    } else if (ch.amount_refunded > 0) {
      lines.push(`⚠️ Partially refunded (${money(ch.amount_refunded, ch.currency)}). Refund the rest to be safe.`);
    } else if (ch.disputed) {
      lines.push('❗ Already disputed — too late to refund; respond with evidence instead.');
    } else {
      lines.push('👉 REFUND NOW to stop this becoming a chargeback:');
      lines.push(`https://dashboard.stripe.com/payments/${ch.id}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `(could not load charge ${chargeId}: ${e.message})`;
  }
}

/**
 * Pull /v1/events — everything Stripe recorded on the account. This is what
 * catches declines, Radar blocks, reviews, fraud warnings and paused
 * capabilities; the targeted endpoints below only supply counters.
 */
async function pollEvents(acc, key, since, firstRun) {
  const label = acc.label || acc.business_name || `account ${acc.id}`;
  const verbose = d.getUserSetting(acc.user_id, 'verbose_events', '0') === '1';
  let newest = since;
  let starting_after;
  let pages = 0;

  do {
    const page = await sget(key, '/events', { limit: 100, 'created[gt]': since, starting_after });
    const list = page.data || [];
    for (const ev of list) {
      if (ev.created > newest) newest = ev.created;
      if (firstRun) continue; // never replay history on the first check

      const o = ev.data?.object || {};
      let type = ev.type;

      // A dispute whose status is warning_* is an *inquiry* — the bank asking
      // questions before any money moves. This is the window to refund.
      if (type.startsWith('charge.dispute.') && String(o.status || '').startsWith('warning_')) {
        type = 'local.dispute_inquiry';
      }

      const map = EVENT_MAP[type];
      if (!map && !verbose) continue;
      if (map?.quiet && !verbose) continue;

      const amt = eventAmount(o);
      const head = map
        ? `${map.icon} ${map.label} on ${label}${amt ? `: ${money(amt.raw, amt.currency)}` : ''}`
        : `ℹ️ ${type} on ${label}`;

      // Early fraud warnings arrive before the chargeback; enrich them with the
      // charge so the alert says exactly what to refund.
      let extra = '';
      if (type === 'radar.early_fraud_warning.created' && o.charge) {
        extra = await refundAdvice(key, typeof o.charge === 'string' ? o.charge : o.charge.id);
      }
      if (type === 'local.dispute_inquiry' && o.charge) {
        extra = await refundAdvice(key, typeof o.charge === 'string' ? o.charge : o.charge.id);
      }

      d.addEvent({
        account_id: acc.id,
        kind: map?.kind || 'other',
        severity: map?.severity || 'info',
        title: head,
        detail: [describeEvent({ ...ev, type }), extra].filter(Boolean).join('\n'),
        amount: amt ? toMajor(amt.raw, amt.currency) : null,
        currency: amt?.currency || '',
        stripe_ref: ev.id, // unique per event — dedupe is automatic
        created_at: new Date(ev.created * 1000).toISOString(),
      });

      // A sale Stripe let through but rated risky is worth a separate heads-up.
      if (type === 'charge.succeeded' && ['elevated', 'highest'].includes(o.outcome?.risk_level)) {
        const m = EVENT_MAP['local.high_risk_sale'];
        d.addEvent({
          account_id: acc.id,
          kind: m.kind,
          severity: m.severity,
          title: `${m.icon} ${m.label} on ${label}: ${money(o.amount, o.currency)}`,
          detail: [
            `Risk level: ${o.outcome.risk_level}${o.outcome.risk_score !== undefined ? ` (score ${o.outcome.risk_score})` : ''}`,
            o.billing_details?.email || o.receipt_email || '',
            'Stripe allowed this payment but rated it risky — worth reviewing before you fulfil.',
            `Charge: ${o.id}`,
          ].filter(Boolean).join('\n'),
          amount: toMajor(o.amount, o.currency),
          currency: o.currency,
          stripe_ref: `risk_${o.id}`,
          created_at: new Date(ev.created * 1000).toISOString(),
        });
      }
    }
    starting_after = page.has_more && list.length ? list[list.length - 1].id : null;
    pages++;
  } while (starting_after && pages < 10); // safety valve on very busy accounts

  return newest;
}

/**
 * Poll a single account: identity, balance, health, then every Stripe event
 * since the last cursor.
 */
async function pollAccount(acc) {
  const key = acc.api_key;
  if (!key) return { skipped: 'no API key' };

  const label = acc.label || acc.business_name || `account ${acc.id}`;
  const cursorKey = `cursor_${acc.id}`;
  // First run: only look at the last hour so we don't alert on all history.
  const firstRun = !d.getSetting(cursorKey);
  const since = Number(d.getSetting(cursorKey, String(Math.floor(Date.now() / 1000) - 3600)));
  let newCursor = since;

  const live = { last_checked: d.now(), last_error: '' };

  try {
    // ---- identity + health ----
    const acct = await sget(key, '/account');
    const req = acct.requirements || {};
    const health = deriveHealth(acct);

    live.stripe_id = acct.id || '';
    live.email = acct.email || acc.email || '';
    live.country = acct.country || '';
    live.currency = acct.default_currency || '';
    live.business_name = acct.business_profile?.name || acct.settings?.dashboard?.display_name || acc.business_name || '';
    live.charges_enabled = acct.charges_enabled ? 1 : 0;
    live.payouts_enabled = acct.payouts_enabled ? 1 : 0;
    live.requirements = prettyRequirements(req);
    live.disabled_reason = req.disabled_reason || '';
    live.health = health;

    // Payments or payouts being switched off is the single most urgent thing
    // that can happen, so it gets its own alert rather than a generic health one.
    const wasCharges = acc.charges_enabled === 1;
    const wasPayouts = acc.payouts_enabled === 1;
    const knownBefore = acc.health && acc.health !== 'unknown';

    if (knownBefore && wasCharges && !acct.charges_enabled) {
      d.addEvent({
        account_id: acc.id,
        kind: 'paused',
        severity: 'critical',
        title: `🛑 PAYMENTS PAUSED on ${label}`,
        detail: [
          'Stripe has stopped this account taking payments.',
          live.disabled_reason ? `Reason: ${live.disabled_reason}` : '',
          live.requirements ? `Needs: ${live.requirements}` : '',
        ].filter(Boolean).join('\n'),
        stripe_ref: `charges_off_${acc.id}_${Date.now()}`,
      });
    } else if (knownBefore && !wasCharges && acct.charges_enabled) {
      d.addEvent({
        account_id: acc.id, kind: 'paused', severity: 'good',
        title: `✅ Payments resumed on ${label}`,
        stripe_ref: `charges_on_${acc.id}_${Date.now()}`,
      });
    }

    if (knownBefore && wasPayouts && !acct.payouts_enabled) {
      d.addEvent({
        account_id: acc.id,
        kind: 'paused',
        severity: 'critical',
        title: `🛑 PAYOUTS PAUSED on ${label}`,
        detail: [
          'Stripe has stopped paying out to your bank.',
          live.disabled_reason ? `Reason: ${live.disabled_reason}` : '',
          live.requirements ? `Needs: ${live.requirements}` : '',
        ].filter(Boolean).join('\n'),
        stripe_ref: `payouts_off_${acc.id}_${Date.now()}`,
      });
    } else if (knownBefore && !wasPayouts && acct.payouts_enabled) {
      d.addEvent({
        account_id: acc.id, kind: 'paused', severity: 'good',
        title: `✅ Payouts resumed on ${label}`,
        stripe_ref: `payouts_on_${acc.id}_${Date.now()}`,
      });
    }

    // Any other change of overall health (documents now required, etc.)
    if (knownBefore && acc.health !== health) {
      const worse = ['suspended', 'restricted', 'docs'].includes(health);
      d.addEvent({
        account_id: acc.id,
        kind: 'health',
        severity: worse ? (health === 'suspended' ? 'critical' : 'warning') : 'good',
        title: `${worse ? '🩺' : '✅'} ${label}: ${HEALTH_LABEL[health] || health}`,
        detail: [
          live.requirements ? `Needs: ${live.requirements}` : '',
          live.disabled_reason ? `Reason: ${live.disabled_reason}` : '',
          `charges ${acct.charges_enabled ? 'on' : 'OFF'} · payouts ${acct.payouts_enabled ? 'on' : 'OFF'}`,
        ].filter(Boolean).join('\n'),
        stripe_ref: `health_${acc.id}_${health}_${Date.now()}`,
      });
    }

    // ---- balance ----
    const bal = await sget(key, '/balance');
    const sum = (arr) => (arr || []).reduce((s, b) => s + toMajor(b.amount, b.currency), 0);
    live.balance_available = sum(bal.available);
    live.balance_pending = sum(bal.pending);

    // ---- today's counters (no alerts — those come from /events) ----
    const dayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const charges = await sget(key, '/charges', { limit: 100, 'created[gte]': dayStart });
    let salesToday = 0;
    let volumeToday = 0;
    for (const ch of charges.data || []) {
      if (ch.status !== 'succeeded' || ch.refunded) continue;
      salesToday++;
      volumeToday += toMajor(ch.amount, ch.currency);
    }
    live.sales_today = salesToday;
    live.volume_today = volumeToday;

    // ---- everything Stripe recorded: sales, declines, blocks, reviews,
    //      fraud warnings, disputes, refunds, payouts ----
    newCursor = await pollEvents(acc, key, since, firstRun);

    d.setSetting(cursorKey, String(Math.max(newCursor, since)));
    d.updateLive(acc.id, live);
    return { ok: true, health };
  } catch (e) {
    // A key that stops working is itself worth an alert.
    const msg = e.message || String(e);
    live.health = 'error';
    live.last_error = msg;
    d.updateLive(acc.id, live);
    if (acc.health !== 'error') {
      d.addEvent({
        account_id: acc.id,
        kind: 'error',
        severity: 'critical',
        title: `🔌 Cannot reach ${label}`,
        detail: msg,
        stripe_ref: `err_${acc.id}_${Date.now()}`,
      });
    }
    return { ok: false, error: msg };
  }
}

/** Poll every account of every user — the background loop. */
async function pollAll() {
  const accounts = d.listAllAccounts().filter((a) => a.api_key);
  const results = [];
  for (const acc of accounts) {
    results.push({ id: acc.id, label: acc.label, ...(await pollAccount(acc)) });
  }
  d.setSetting('last_poll', d.now());
  return results;
}

/** Poll just one user's accounts — what "Check all now" calls. */
async function pollUser(userId) {
  const accounts = d.listAccounts(userId).filter((a) => a.api_key);
  const results = [];
  for (const acc of accounts) {
    results.push({ id: acc.id, label: acc.label, ...(await pollAccount(acc)) });
  }
  d.setSetting('last_poll', d.now());
  return results;
}

/** Validate a key before saving it, and report who it belongs to. */
async function testKey(key) {
  const acct = await sget(key, '/account');
  return {
    id: acct.id,
    email: acct.email || '',
    country: acct.country || '',
    business_name: acct.business_profile?.name || acct.settings?.dashboard?.display_name || '',
    charges_enabled: !!acct.charges_enabled,
    payouts_enabled: !!acct.payouts_enabled,
    health: deriveHealth(acct),
  };
}

module.exports = {
  pollAll, pollUser, pollAccount, testKey, money, toMajor, HEALTH_LABEL,
  EVENT_MAP, describeEvent, eventAmount, // exported so alert formatting is testable
};
