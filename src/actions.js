'use strict';

/**
 * actions.js — the only part of this app that changes anything at Stripe.
 *
 * Everything else reads. These are the moves that are actually worth making
 * from a monitoring tool, i.e. the ones where minutes matter:
 *
 *   refund   — the one that stops an early fraud warning becoming a chargeback
 *   review   — approve or reject a payment Radar is holding
 *   dispute  — accept one you know you will lose, or submit evidence
 *   payout   — pull the available balance to the bank now
 *
 * Rules that apply to all of them:
 *   - Only ever called from an explicit confirmation in the browser. The poller
 *     never writes.
 *   - Every call carries an idempotency key (see stripe.spost), so a retry
 *     after a timeout cannot refund twice.
 *   - Every attempt is recorded as an event, successful or not, so the alert
 *     history doubles as an audit trail of what was done and by whom.
 */

const { randomUUID } = require('crypto');
const d = require('./db');
const { sget, spost, sdel, money, toMajor } = require('./stripe');
const { pool } = require('./http');

/** Record what was done. Kind `action` so it is filterable in the Alerts tab. */
function log(acc, { ok, title, detail, amount, currency, ref }) {
  d.addEvent({
    account_id: acc.id,
    kind: 'action',
    severity: ok ? 'good' : 'warning',
    title,
    detail,
    amount: amount ?? null,
    currency: currency || '',
    // Unique per attempt, always. The events table de-duplicates on stripe_ref,
    // and several of these refs are deterministic (`cap_pi_1`), so two captures
    // on the same payment silently produced one audit row. An audit trail has
    // to record the second attempt as well as the first.
    stripe_ref: `act_${ref ? ref + '_' : ''}${randomUUID()}`,
  });
}

const label = (acc) => acc.label || acc.business_name || `account ${acc.id}`;

/** The key, or a clear error rather than a confusing 401 from Stripe. */
function keyFor(acc) {
  const key = d.accountKey(acc);
  if (!key) throw new Error('This account has no Stripe API key saved yet.');
  return key;
}

/**
 * A restricted key with only read permissions will fail on write with a
 * specific Stripe error. Translate it into something actionable.
 */
function explain(e) {
  const m = e.message || String(e);
  if (/does not have the required permissions|not have access|restricted/i.test(m)) {
    return new Error(
      'This key cannot write. It is a read-only restricted key — replace it with a '
      + 'standard secret key, or grant the restricted key write access to that resource.'
    );
  }
  return e;
}

// --- charges & refunds ------------------------------------------------------

/** Everything the refund dialog needs to show before anyone commits. */
async function loadCharge(acc, chargeId) {
  const ch = await sget(keyFor(acc), `/charges/${chargeId}`);
  return {
    id: ch.id,
    amount: toMajor(ch.amount, ch.currency),
    amount_refunded: toMajor(ch.amount_refunded, ch.currency),
    refundable: toMajor(ch.amount - ch.amount_refunded, ch.currency),
    currency: ch.currency,
    refunded: !!ch.refunded,
    disputed: !!ch.disputed,
    status: ch.status,
    created: ch.created,
    description: ch.description || '',
    customer_email: ch.billing_details?.email || ch.receipt_email || '',
    card: ch.payment_method_details?.card
      ? `${ch.payment_method_details.card.brand} …${ch.payment_method_details.card.last4}`
      : '',
    risk_level: ch.outcome?.risk_level || '',
    dashboard_url: `https://dashboard.stripe.com/payments/${ch.id}`,
  };
}

/**
 * Refund a charge, fully or partially.
 *
 * `reason` is Stripe's enum. `fraudulent` also marks the charge as fraud in
 * Radar, which is what you want after an early fraud warning — it teaches
 * Radar and it is the signal that stops the chargeback.
 */
async function refund(acc, { charge_id, amount, reason }) {
  const key = keyFor(acc);
  if (!charge_id) throw new Error('Which charge? None was given.');

  const ch = await loadCharge(acc, charge_id);
  if (ch.refunded) throw new Error('That charge is already fully refunded.');
  if (ch.disputed) {
    throw new Error(
      'That charge is already disputed — refunding no longer stops it. '
      + 'Respond with evidence, or accept the dispute.'
    );
  }

  const params = { charge: charge_id };
  // Omitted amount means "the whole thing" to Stripe.
  if (amount !== undefined && amount !== null && amount !== '') {
    const major = Number(amount);
    if (!Number.isFinite(major) || major <= 0) throw new Error('Refund amount must be a positive number.');
    if (major > ch.refundable + 1e-9) {
      throw new Error(`Only ${money(ch.refundable * 100, ch.currency)} is still refundable on that charge.`);
    }
    const zeroDecimal = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
    params.amount = Math.round(zeroDecimal.includes(ch.currency) ? major : major * 100);
  }
  if (['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) params.reason = reason;

  try {
    const r = await spost(key, '/refunds', params);
    const value = toMajor(r.amount, r.currency);
    log(acc, {
      ok: true,
      title: `↩️ Refunded ${money(r.amount, r.currency)} on ${label(acc)}`,
      detail: [
        `Charge: ${charge_id}`,
        ch.customer_email ? `Customer: ${ch.customer_email}` : '',
        reason ? `Reason: ${reason}` : '',
        params.amount ? 'Partial refund.' : 'Full refund.',
        `Refund id: ${r.id}`,
      ].filter(Boolean).join('\n'),
      amount: value,
      currency: r.currency,
      ref: r.id,
    });
    return { ok: true, refund: { id: r.id, amount: value, currency: r.currency, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, {
      ok: false,
      title: `⚠️ Refund failed on ${label(acc)}`,
      detail: `Charge: ${charge_id}\n${err.message}`,
    });
    throw err;
  }
}

// --- Radar reviews ----------------------------------------------------------

/** Approve or reject a payment Stripe is holding for manual review. */
async function review(acc, { review_id, decision }) {
  const key = keyFor(acc);
  if (!review_id) throw new Error('Which review? None was given.');
  if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject.');

  try {
    const r = await spost(key, `/reviews/${review_id}/${decision}`, {});
    log(acc, {
      ok: true,
      title: `🔍 Review ${decision === 'approve' ? 'approved' : 'rejected'} on ${label(acc)}`,
      detail: `Review: ${review_id}\nCharge: ${r.charge || '—'}\nNow: ${r.closed_reason || r.open ? 'open' : 'closed'}`,
      ref: review_id + '_' + decision,
    });
    return { ok: true, review: { id: r.id, open: r.open, closed_reason: r.closed_reason } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Review action failed on ${label(acc)}`, detail: `${review_id}\n${err.message}` });
    throw err;
  }
}

// --- disputes ---------------------------------------------------------------

/**
 * Accept a dispute (Stripe calls it "close"). Irreversible: the money is gone
 * and the chargeback stands. Worth doing when you know you cannot win, because
 * it stops the clock and avoids the evidence work.
 */
async function closeDispute(acc, { dispute_id }) {
  const key = keyFor(acc);
  if (!dispute_id) throw new Error('Which dispute? None was given.');

  try {
    const r = await spost(key, `/disputes/${dispute_id}/close`, {});
    log(acc, {
      ok: true,
      title: `⚠️ Dispute accepted on ${label(acc)}: ${money(r.amount, r.currency)}`,
      detail: `Dispute: ${dispute_id}\nReason: ${r.reason}\nStatus: ${r.status}\nAccepted — the funds stay withdrawn.`,
      amount: toMajor(r.amount, r.currency),
      currency: r.currency,
      ref: dispute_id + '_close',
    });
    return { ok: true, dispute: { id: r.id, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Accepting dispute failed on ${label(acc)}`, detail: `${dispute_id}\n${err.message}` });
    throw err;
  }
}

/** Submit evidence for a dispute. Free-text fields only — no file uploads. */
async function submitEvidence(acc, { dispute_id, evidence, submit }) {
  const key = keyFor(acc);
  if (!dispute_id) throw new Error('Which dispute? None was given.');

  const ALLOWED = [
    'product_description', 'customer_name', 'customer_email_address',
    'customer_purchase_ip', 'billing_address', 'shipping_address',
    'shipping_carrier', 'shipping_tracking_number', 'shipping_date',
    'service_date', 'refund_policy_disclosure', 'cancellation_policy_disclosure',
    'uncategorized_text',
  ];

  const params = {};
  for (const [k, v] of Object.entries(evidence || {})) {
    if (ALLOWED.includes(k) && String(v || '').trim()) params[`evidence[${k}]`] = String(v).trim();
  }
  if (!Object.keys(params).length) throw new Error('No evidence filled in yet.');
  // submit:false saves a draft you can keep editing; true sends it to the bank.
  if (submit) params.submit = 'true';

  try {
    const r = await spost(key, `/disputes/${dispute_id}`, params);
    log(acc, {
      ok: true,
      title: `⚠️ Dispute evidence ${submit ? 'submitted' : 'saved'} on ${label(acc)}`,
      detail: [
        `Dispute: ${dispute_id}`,
        `Fields: ${Object.keys(params).filter((k) => k !== 'submit').length}`,
        `Status: ${r.status}`,
        submit ? 'Sent to the bank — it can no longer be edited.' : 'Saved as a draft, not yet sent.',
      ].join('\n'),
      ref: dispute_id + (submit ? '_submit' : '_draft') + '_' + Date.now(),
    });
    return { ok: true, dispute: { id: r.id, status: r.status, submission_count: r.evidence_details?.submission_count } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Dispute evidence failed on ${label(acc)}`, detail: `${dispute_id}\n${err.message}` });
    throw err;
  }
}

// --- payouts ----------------------------------------------------------------

/** Send the available balance to the bank now, rather than on schedule. */
async function payout(acc, { amount, currency }) {
  const key = keyFor(acc);
  const cur = String(currency || acc.currency || 'usd').toLowerCase();

  const bal = await sget(key, '/balance');
  const avail = (bal.available || []).find((b) => String(b.currency).toLowerCase() === cur);
  if (!avail || avail.amount <= 0) throw new Error(`Nothing available to pay out in ${cur.toUpperCase()}.`);

  const zeroDecimal = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
  let minor = avail.amount;
  if (amount !== undefined && amount !== null && amount !== '') {
    const major = Number(amount);
    if (!Number.isFinite(major) || major <= 0) throw new Error('Payout amount must be a positive number.');
    minor = Math.round(zeroDecimal.includes(cur) ? major : major * 100);
    if (minor > avail.amount) {
      throw new Error(`Only ${money(avail.amount, cur)} is available right now.`);
    }
  }

  try {
    const r = await spost(key, '/payouts', { amount: minor, currency: cur });
    log(acc, {
      ok: true,
      title: `🏦 Payout created on ${label(acc)}: ${money(r.amount, r.currency)}`,
      detail: `Payout: ${r.id}\nStatus: ${r.status}\nArrives: ${r.arrival_date ? new Date(r.arrival_date * 1000).toDateString() : 'unknown'}`,
      amount: toMajor(r.amount, r.currency),
      currency: r.currency,
      ref: r.id,
    });
    return { ok: true, payout: { id: r.id, amount: toMajor(r.amount, r.currency), currency: r.currency, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Payout failed on ${label(acc)}`, detail: err.message });
    throw err;
  }
}

// --- the queue --------------------------------------------------------------

/**
 * Everything across one account that is currently waiting on a decision.
 *
 * This is the point of the whole feature: the tracker already knew a fraud
 * warning had arrived, and then made you go and open the Stripe dashboard to
 * do anything about it.
 */
async function pending(acc) {
  const key = keyFor(acc);
  const out = { disputes: [], reviews: [], fraud: [] };

  const [disputes, reviews, efw] = await Promise.all([
    sget(key, '/disputes', { limit: 20 }).catch(() => ({ data: [] })),
    sget(key, '/reviews', { limit: 20 }).catch(() => ({ data: [] })),
    sget(key, '/radar/early_fraud_warnings', { limit: 20 }).catch(() => ({ data: [] })),
  ]);

  for (const p of disputes.data || []) {
    if (!/needs_response|warning_needs_response/.test(p.status)) continue;
    out.disputes.push({
      id: p.id,
      amount: toMajor(p.amount, p.currency),
      currency: p.currency,
      reason: p.reason,
      status: p.status,
      charge: typeof p.charge === 'string' ? p.charge : p.charge?.id,
      due_by: p.evidence_details?.due_by || null,
      is_inquiry: String(p.status).startsWith('warning_'),
    });
  }

  for (const r of reviews.data || []) {
    if (!r.open) continue;
    out.reviews.push({
      id: r.id,
      reason: r.reason,
      charge: typeof r.charge === 'string' ? r.charge : r.charge?.id,
      opened: r.created,
    });
  }

  for (const w of efw.data || []) {
    if (w.actionable === false) continue;
    out.fraud.push({
      id: w.id,
      fraud_type: w.fraud_type,
      charge: typeof w.charge === 'string' ? w.charge : w.charge?.id,
      created: w.created,
    });
  }

  return out;
}

/**
 * Everything waiting on a decision across one user's whole fleet.
 *
 * Done server-side with the same bounded pool the poller uses: 41 accounts x 3
 * endpoints is 123 calls, and the browser should not be making those one at a
 * time over a tunnel.
 */
async function pendingForUser(userId) {
  const accounts = d.listAccounts(userId).filter((a) => d.accountKey(a));
  const results = await pool(accounts, 6, async (acc) => {
    try {
      const p = await pending(acc);
      const n = p.disputes.length + p.reviews.length + p.fraud.length;
      if (!n) return null;
      return {
        account_id: acc.id,
        label: acc.label || acc.business_name || `account ${acc.id}`,
        currency: acc.currency || '',
        ...p,
      };
    } catch (e) {
      return { account_id: acc.id, label: acc.label, error: e.message };
    }
  });

  const rows = results.filter(Boolean);
  const count = (k) => rows.reduce((n, r) => n + (r[k] ? r[k].length : 0), 0);
  return {
    scanned: accounts.length,
    accounts: rows,
    totals: {
      disputes: count('disputes'),
      reviews: count('reviews'),
      fraud: count('fraud'),
      errors: rows.filter((r) => r.error).length,
    },
  };
}


// --- look anything up -------------------------------------------------------

/**
 * Paste any Stripe id and get the object back, whatever it is.
 *
 * The prefix says what the thing is, so one box can find a charge, a payment,
 * a customer, a dispute, a payout, a subscription or an invoice — and the UI
 * can then offer exactly the actions that apply to it.
 */
const ID_KINDS = [
  ['ch_', 'charge', '/charges/'],
  ['py_', 'payout', '/payouts/'],
  ['po_', 'payout', '/payouts/'],
  ['pi_', 'payment_intent', '/payment_intents/'],
  ['cus_', 'customer', '/customers/'],
  ['dp_', 'dispute', '/disputes/'],
  ['du_', 'dispute', '/disputes/'],
  ['re_', 'refund', '/refunds/'],
  ['sub_', 'subscription', '/subscriptions/'],
  ['in_', 'invoice', '/invoices/'],
  ['prv_', 'review', '/reviews/'],
  ['issfr_', 'fraud_warning', '/radar/early_fraud_warnings/'],
];

/** Trim a Stripe object down to what the UI shows and acts on. */
function summarise(kind, o) {
  const base = { kind, id: o.id, raw_status: o.status || '' };
  switch (kind) {
    case 'charge':
      return {
        ...base,
        amount: toMajor(o.amount, o.currency),
        refunded_amount: toMajor(o.amount_refunded, o.currency),
        currency: o.currency,
        refunded: !!o.refunded,
        disputed: !!o.disputed,
        captured: !!o.captured,
        paid: !!o.paid,
        created: o.created,
        description: o.description || '',
        customer: typeof o.customer === 'string' ? o.customer : o.customer?.id || '',
        email: o.billing_details?.email || o.receipt_email || '',
        card: o.payment_method_details?.card
          ? `${o.payment_method_details.card.brand} …${o.payment_method_details.card.last4}`
          : '',
        card_fingerprint: o.payment_method_details?.card?.fingerprint || '',
        ip: o.billing_details?.address?.postal_code ? '' : (o.outcome?.risk_level ? '' : ''),
        risk_level: o.outcome?.risk_level || '',
        risk_score: o.outcome?.risk_score,
        fraud_report: o.fraud_details?.user_report || o.fraud_details?.stripe_report || '',
        payment_intent: typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id || '',
      };
    case 'payment_intent':
      return {
        ...base,
        amount: toMajor(o.amount, o.currency),
        amount_capturable: toMajor(o.amount_capturable, o.currency),
        currency: o.currency,
        capture_method: o.capture_method,
        created: o.created,
        description: o.description || '',
        customer: typeof o.customer === 'string' ? o.customer : o.customer?.id || '',
        latest_charge: typeof o.latest_charge === 'string' ? o.latest_charge : o.latest_charge?.id || '',
      };
    case 'customer':
      return {
        ...base,
        email: o.email || '',
        name: o.name || '',
        created: o.created,
        delinquent: !!o.delinquent,
        balance: o.balance,
        currency: o.currency || '',
      };
    case 'dispute':
      return {
        ...base,
        amount: toMajor(o.amount, o.currency),
        currency: o.currency,
        reason: o.reason,
        charge: typeof o.charge === 'string' ? o.charge : o.charge?.id || '',
        due_by: o.evidence_details?.due_by || null,
        is_inquiry: String(o.status || '').startsWith('warning_'),
        submission_count: o.evidence_details?.submission_count || 0,
      };
    case 'payout':
      return {
        ...base,
        amount: toMajor(o.amount, o.currency),
        currency: o.currency,
        arrival_date: o.arrival_date,
        method: o.method,
        created: o.created,
        cancellable: o.status === 'pending',
        reversible: o.status === 'paid',
      };
    case 'refund':
      return { ...base, amount: toMajor(o.amount, o.currency), currency: o.currency, reason: o.reason || '',
        charge: typeof o.charge === 'string' ? o.charge : o.charge?.id || '' };
    case 'subscription':
      return { ...base, customer: typeof o.customer === 'string' ? o.customer : o.customer?.id || '',
        cancel_at_period_end: !!o.cancel_at_period_end, current_period_end: o.current_period_end,
        created: o.created };
    case 'invoice':
      return { ...base, amount: toMajor(o.amount_due, o.currency), currency: o.currency,
        customer: typeof o.customer === 'string' ? o.customer : o.customer?.id || '',
        number: o.number || '', paid: !!o.paid };
    case 'review':
      return { ...base, open: !!o.open, reason: o.reason || '',
        charge: typeof o.charge === 'string' ? o.charge : o.charge?.id || '' };
    case 'fraud_warning':
      return { ...base, fraud_type: o.fraud_type || '',
        charge: typeof o.charge === 'string' ? o.charge : o.charge?.id || '', created: o.created };
    default:
      return base;
  }
}

/** Find one object by id, or search customers/charges by email. */
async function lookup(acc, query) {
  const key = keyFor(acc);
  const q = String(query || '').trim();
  if (!q) throw new Error('Nothing to look up.');

  const match = ID_KINDS.find(([prefix]) => q.startsWith(prefix));
  if (match) {
    const [, kind, path] = match;
    const o = await sget(key, path + encodeURIComponent(q));
    return { results: [summarise(kind, o)] };
  }

  if (q.includes('@')) {
    // Stripe's search index lags writes by up to a minute; that is fine for
    // finding an existing customer.
    const [customers, charges] = await Promise.all([
      sget(key, '/customers', { email: q, limit: 5 }).catch(() => ({ data: [] })),
      sget(key, '/charges/search', { query: `billing_details.email:"${q.replace(/"/g, '')}"`, limit: 10 })
        .catch(() => ({ data: [] })),
    ]);
    return {
      results: [
        ...(customers.data || []).map((o) => summarise('customer', o)),
        ...(charges.data || []).map((o) => summarise('charge', o)),
      ],
    };
  }

  throw new Error('Paste a Stripe id (ch_…, pi_…, cus_…, dp_…, py_…, sub_…, in_…) or an email address.');
}

// --- fraud reporting and blocking ------------------------------------------

/**
 * Tell Stripe a charge was fraudulent (or that it was fine after all).
 *
 * This is what trains Radar on your own traffic. Reporting fraud here is also
 * the honest follow-up to refunding an early fraud warning.
 */
async function reportFraud(acc, { charge_id, report }) {
  const key = keyFor(acc);
  if (!charge_id) throw new Error('Which charge? None was given.');
  if (!['fraudulent', 'safe'].includes(report)) throw new Error('Report must be fraudulent or safe.');

  try {
    const r = await spost(key, `/charges/${charge_id}`, { 'fraud_details[user_report]': report });
    log(acc, {
      ok: true,
      title: `🚩 Charge reported ${report} on ${label(acc)}`,
      detail: `Charge: ${charge_id}\nRadar now learns from this.`,
      ref: `${charge_id}_${report}`,
    });
    return { ok: true, charge: { id: r.id, fraud_details: r.fraud_details } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Fraud report failed on ${label(acc)}`, detail: `${charge_id}\n${err.message}` });
    throw err;
  }
}

/**
 * Radar value lists — the block lists.
 *
 * Worth being straight about how these work: adding a value only blocks future
 * payments if a Radar rule references that list. Stripe creates default lists
 * and default rules for most accounts; where it has not, the value is stored
 * and does nothing until a rule exists. The UI says so rather than implying a
 * block that is not happening.
 */
async function blockLists(acc) {
  const key = keyFor(acc);
  const lists = await sget(key, '/radar/value_lists', { limit: 20 });
  const out = [];
  for (const l of lists.data || []) {
    const items = await sget(key, '/radar/value_list_items', { value_list: l.id, limit: 100 })
      .catch(() => ({ data: [] }));
    out.push({
      id: l.id,
      alias: l.alias,
      name: l.name,
      item_type: l.item_type,
      items: (items.data || []).map((i) => ({ id: i.id, value: i.value, created: i.created })),
    });
  }
  return { lists: out };
}

const LIST_FOR = {
  email: { alias: 'block_emails', name: 'Blocked emails', item_type: 'email' },
  card_fingerprint: { alias: 'block_cards', name: 'Blocked cards', item_type: 'card_fingerprint' },
  ip_address: { alias: 'block_ips', name: 'Blocked IPs', item_type: 'ip_address' },
  country: { alias: 'block_countries', name: 'Blocked countries', item_type: 'country' },
};

/** Add a value to the right block list, creating the list the first time. */
async function block(acc, { type, value }) {
  const key = keyFor(acc);
  const spec = LIST_FOR[type];
  if (!spec) throw new Error('Block type must be email, card_fingerprint, ip_address or country.');
  if (!String(value || '').trim()) throw new Error('Nothing to block — the value is empty.');

  try {
    const existing = await sget(key, '/radar/value_lists', { alias: spec.alias, limit: 1 });
    let list = (existing.data || [])[0];
    if (!list) {
      list = await spost(key, '/radar/value_lists', {
        alias: spec.alias, name: spec.name, item_type: spec.item_type,
      });
    }
    const item = await spost(key, '/radar/value_list_items', {
      value_list: list.id, value: String(value).trim(),
    });
    log(acc, {
      ok: true,
      title: `🛑 Blocked ${type.replace('_', ' ')} on ${label(acc)}`,
      detail: `Value: ${value}\nList: ${list.alias}\nTakes effect for future payments wherever a Radar rule uses this list.`,
      ref: item.id,
    });
    return { ok: true, item: { id: item.id, value: item.value, list: list.alias } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Block failed on ${label(acc)}`, detail: `${type} ${value}\n${err.message}` });
    throw err;
  }
}

/** Take a value back off a block list. */
async function unblock(acc, { item_id }) {
  const key = keyFor(acc);
  if (!item_id) throw new Error('Which entry? None was given.');
  try {
    await sdel(key, `/radar/value_list_items/${item_id}`);
    log(acc, { ok: true, title: `✅ Unblocked an entry on ${label(acc)}`, detail: `Entry: ${item_id}`, ref: `un_${item_id}` });
    return { ok: true };
  } catch (e) {
    const err = explain(e);
    throw err;
  }
}

// --- payment intents --------------------------------------------------------

/** Capture funds that were authorised but never taken. */
async function capture(acc, { payment_intent, amount }) {
  const key = keyFor(acc);
  if (!payment_intent) throw new Error('Which payment? None was given.');

  const pi = await sget(key, `/payment_intents/${payment_intent}`);
  const params = {};
  if (amount !== undefined && amount !== null && amount !== '') {
    const major = Number(amount);
    if (!Number.isFinite(major) || major <= 0) throw new Error('Capture amount must be a positive number.');
    const zero = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
    const minor = Math.round(zero.includes(pi.currency) ? major : major * 100);
    if (minor > pi.amount_capturable) {
      throw new Error(`Only ${money(pi.amount_capturable, pi.currency)} is capturable on that payment.`);
    }
    params.amount_to_capture = minor;
  }

  try {
    const r = await spost(key, `/payment_intents/${payment_intent}/capture`, params);
    log(acc, {
      ok: true,
      title: `💰 Captured ${money(r.amount_received, r.currency)} on ${label(acc)}`,
      detail: `Payment: ${payment_intent}\nStatus: ${r.status}`,
      amount: toMajor(r.amount_received, r.currency),
      currency: r.currency,
      ref: `cap_${payment_intent}`,
    });
    return { ok: true, payment_intent: { id: r.id, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Capture failed on ${label(acc)}`, detail: `${payment_intent}\n${err.message}` });
    throw err;
  }
}

/** Cancel a payment that has not been captured. */
async function cancelPayment(acc, { payment_intent, reason }) {
  const key = keyFor(acc);
  if (!payment_intent) throw new Error('Which payment? None was given.');
  const params = {};
  if (['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'].includes(reason)) {
    params.cancellation_reason = reason;
  }
  try {
    const r = await spost(key, `/payment_intents/${payment_intent}/cancel`, params);
    log(acc, {
      ok: true,
      title: `🚫 Payment cancelled on ${label(acc)}`,
      detail: `Payment: ${payment_intent}\nReason: ${reason || 'none given'}\nStatus: ${r.status}`,
      ref: `pican_${payment_intent}`,
    });
    return { ok: true, payment_intent: { id: r.id, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Cancel failed on ${label(acc)}`, detail: `${payment_intent}\n${err.message}` });
    throw err;
  }
}

// --- payouts ----------------------------------------------------------------

/** Stop a payout that has not left yet, or claw back one that has. */
async function payoutAction(acc, { payout_id, op }) {
  const key = keyFor(acc);
  if (!payout_id) throw new Error('Which payout? None was given.');
  if (!['cancel', 'reverse'].includes(op)) throw new Error('Payout action must be cancel or reverse.');
  try {
    const r = await spost(key, `/payouts/${payout_id}/${op}`, {});
    log(acc, {
      ok: true,
      title: `🏦 Payout ${op === 'cancel' ? 'cancelled' : 'reversed'} on ${label(acc)}: ${money(r.amount, r.currency)}`,
      detail: `Payout: ${payout_id}\nStatus: ${r.status}`,
      amount: toMajor(r.amount, r.currency),
      currency: r.currency,
      ref: `${payout_id}_${op}`,
    });
    return { ok: true, payout: { id: r.id, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Payout ${op} failed on ${label(acc)}`, detail: `${payout_id}\n${err.message}` });
    throw err;
  }
}

// --- recurring revenue ------------------------------------------------------

/** Stop a subscription — now, or at the end of the period it is paid for. */
async function cancelSubscription(acc, { subscription_id, at_period_end }) {
  const key = keyFor(acc);
  if (!subscription_id) throw new Error('Which subscription? None was given.');
  try {
    const r = at_period_end
      ? await spost(key, `/subscriptions/${subscription_id}`, { cancel_at_period_end: 'true' })
      : await sdel(key, `/subscriptions/${subscription_id}`);
    log(acc, {
      ok: true,
      title: `🔁 Subscription ${at_period_end ? 'set to end' : 'cancelled'} on ${label(acc)}`,
      detail: `Subscription: ${subscription_id}\nStatus: ${r.status}`,
      ref: `sub_${subscription_id}_${at_period_end ? 'end' : 'now'}`,
    });
    return { ok: true, subscription: { id: r.id, status: r.status, cancel_at_period_end: !!r.cancel_at_period_end } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Subscription cancel failed on ${label(acc)}`, detail: `${subscription_id}\n${err.message}` });
    throw err;
  }
}

/** Void an invoice, or write it off as uncollectible. */
async function invoiceAction(acc, { invoice_id, op }) {
  const key = keyFor(acc);
  if (!invoice_id) throw new Error('Which invoice? None was given.');
  if (!['void', 'mark_uncollectible'].includes(op)) throw new Error('Invoice action must be void or mark_uncollectible.');
  try {
    const r = await spost(key, `/invoices/${invoice_id}/${op}`, {});
    log(acc, {
      ok: true,
      title: `🧾 Invoice ${op === 'void' ? 'voided' : 'written off'} on ${label(acc)}`,
      detail: `Invoice: ${invoice_id}\nStatus: ${r.status}`,
      ref: `${invoice_id}_${op}`,
    });
    return { ok: true, invoice: { id: r.id, status: r.status } };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Invoice ${op} failed on ${label(acc)}`, detail: `${invoice_id}\n${err.message}` });
    throw err;
  }
}

/** Delete a customer outright, which also cancels their subscriptions. */
async function deleteCustomer(acc, { customer_id }) {
  const key = keyFor(acc);
  if (!customer_id) throw new Error('Which customer? None was given.');
  try {
    const r = await sdel(key, `/customers/${customer_id}`);
    log(acc, {
      ok: true,
      title: `👤 Customer deleted on ${label(acc)}`,
      detail: `Customer: ${customer_id}\nAny subscriptions they had are cancelled too.`,
      ref: `delcus_${customer_id}`,
    });
    return { ok: true, deleted: !!r.deleted };
  } catch (e) {
    const err = explain(e);
    log(acc, { ok: false, title: `⚠️ Customer delete failed on ${label(acc)}`, detail: `${customer_id}\n${err.message}` });
    throw err;
  }
}

/**
 * What this key is actually allowed to do.
 *
 * A restricted key can read some resources and not others, so rather than
 * offering buttons that will 403, probe cheaply and let the UI grey out what
 * is unavailable.
 */
async function capabilities(acc) {
  const key = keyFor(acc);
  const probe = async (path, params) => {
    try { await sget(key, path, params || { limit: 1 }); return true; }
    catch { return false; }
  };
  const [charges, disputes, reviews, payouts, radar, customers, subs, invoices] = await Promise.all([
    probe('/charges'), probe('/disputes'), probe('/reviews'), probe('/payouts'),
    probe('/radar/value_lists'), probe('/customers'), probe('/subscriptions'), probe('/invoices'),
  ]);
  return {
    key_kind: String(key).startsWith('rk_') ? 'restricted' : 'standard',
    livemode: String(key).includes('_live_'),
    charges, disputes, reviews, payouts, radar, customers,
    subscriptions: subs, invoices,
  };
}


// --- the action centre ------------------------------------------------------

/**
 * Everything actionable across one account, already enriched.
 *
 * The point is that nothing should have to be looked up by hand. A dispute is
 * useless without knowing who paid, on what card, for how much — so every item
 * arrives with its charge already attached and the amounts already converted.
 *
 * Enrichment is bounded per category: a busy account should not turn one scan
 * into two hundred requests.
 */
const ENRICH_CAP = 8;

async function enrichCharge(key, chargeId, cache) {
  if (!chargeId) return null;
  if (cache.has(chargeId)) return cache.get(chargeId);
  const p = sget(key, `/charges/${chargeId}`)
    .then((ch) => ({
      id: ch.id,
      amount: toMajor(ch.amount, ch.currency),
      refunded_amount: toMajor(ch.amount_refunded, ch.currency),
      refundable: toMajor(ch.amount - ch.amount_refunded, ch.currency),
      currency: ch.currency,
      refunded: !!ch.refunded,
      disputed: !!ch.disputed,
      created: ch.created,
      description: ch.description || '',
      email: ch.billing_details?.email || ch.receipt_email || '',
      name: ch.billing_details?.name || '',
      country: ch.payment_method_details?.card?.country || '',
      card: ch.payment_method_details?.card
        ? `${ch.payment_method_details.card.brand} …${ch.payment_method_details.card.last4}`
        : '',
      card_fingerprint: ch.payment_method_details?.card?.fingerprint || '',
      risk_level: ch.outcome?.risk_level || '',
      risk_score: ch.outcome?.risk_score,
      fraud_report: ch.fraud_details?.user_report || '',
      customer: typeof ch.customer === 'string' ? ch.customer : ch.customer?.id || '',
      dashboard_url: `https://dashboard.stripe.com/payments/${ch.id}`,
    }))
    .catch(() => null);
  cache.set(chargeId, p);
  return p;
}

/**
 * One account's full worklist. Every entry is ready to act on: no ids to copy,
 * no second lookup, nothing left for the operator to assemble.
 */
async function worklist(acc) {
  const key = keyFor(acc);
  const cache = new Map();

  const [disputes, warnings, reviews, intents, charges, payouts, balance] = await Promise.all([
    sget(key, '/disputes', { limit: 25 }).catch(() => ({ data: [] })),
    sget(key, '/radar/early_fraud_warnings', { limit: 25 }).catch(() => ({ data: [] })),
    sget(key, '/reviews', { limit: 25 }).catch(() => ({ data: [] })),
    sget(key, '/payment_intents', { limit: 25 }).catch(() => ({ data: [] })),
    sget(key, '/charges', { limit: 50 }).catch(() => ({ data: [] })),
    sget(key, '/payouts', { limit: 10 }).catch(() => ({ data: [] })),
    sget(key, '/balance').catch(() => ({ available: [], pending: [] })),
  ]);

  // --- disputes and inquiries, with the charge behind each one -------------
  const openDisputes = (disputes.data || [])
    .filter((p) => /needs_response/.test(p.status))
    .slice(0, ENRICH_CAP);
  const disputeRows = await Promise.all(openDisputes.map(async (p) => ({
    id: p.id,
    amount: toMajor(p.amount, p.currency),
    currency: p.currency,
    reason: p.reason,
    status: p.status,
    is_inquiry: String(p.status).startsWith('warning_'),
    due_by: p.evidence_details?.due_by || null,
    submission_count: p.evidence_details?.submission_count || 0,
    charge: await enrichCharge(key, typeof p.charge === 'string' ? p.charge : p.charge?.id, cache),
  })));

  // --- early fraud warnings: the ones where a refund still helps -----------
  const openWarnings = (warnings.data || [])
    .filter((w) => w.actionable !== false)
    .slice(0, ENRICH_CAP);
  const warningRows = (await Promise.all(openWarnings.map(async (w) => ({
    id: w.id,
    fraud_type: w.fraud_type || '',
    created: w.created,
    charge: await enrichCharge(key, typeof w.charge === 'string' ? w.charge : w.charge?.id, cache),
  })))).filter((w) => w.charge && !w.charge.refunded);

  // --- payments Radar is holding -------------------------------------------
  const openReviews = (reviews.data || []).filter((r) => r.open).slice(0, ENRICH_CAP);
  const reviewRows = await Promise.all(openReviews.map(async (r) => ({
    id: r.id,
    reason: r.reason || '',
    opened: r.created,
    charge: await enrichCharge(key, typeof r.charge === 'string' ? r.charge : r.charge?.id, cache),
  })));

  // --- authorised money nobody has taken yet -------------------------------
  const capturable = (intents.data || [])
    .filter((pi) => pi.status === 'requires_capture' && pi.amount_capturable > 0)
    .slice(0, ENRICH_CAP)
    .map((pi) => ({
      id: pi.id,
      amount: toMajor(pi.amount, pi.currency),
      capturable: toMajor(pi.amount_capturable, pi.currency),
      currency: pi.currency,
      created: pi.created,
      description: pi.description || '',
      email: pi.receipt_email || '',
    }));

  // --- risky payments Stripe let through -----------------------------------
  const risky = (charges.data || [])
    .filter((ch) => ['elevated', 'highest'].includes(ch.outcome?.risk_level)
      && ch.status === 'succeeded' && !ch.refunded && !ch.disputed)
    .slice(0, ENRICH_CAP)
    .map((ch) => ({
      id: ch.id,
      amount: toMajor(ch.amount, ch.currency),
      refundable: toMajor(ch.amount - ch.amount_refunded, ch.currency),
      currency: ch.currency,
      created: ch.created,
      email: ch.billing_details?.email || ch.receipt_email || '',
      card: ch.payment_method_details?.card
        ? `${ch.payment_method_details.card.brand} …${ch.payment_method_details.card.last4}`
        : '',
      card_fingerprint: ch.payment_method_details?.card?.fingerprint || '',
      country: ch.payment_method_details?.card?.country || '',
      risk_level: ch.outcome.risk_level,
      risk_score: ch.outcome.risk_score,
      description: ch.description || '',
    }));

  // --- recent payments, so anything can be refunded at will ----------------
  // Not just the risky ones: the operator should be able to act on any recent
  // charge without going hunting for an id.
  const recent = (charges.data || [])
    .filter((ch) => ch.status === 'succeeded')
    .slice(0, 25)
    .map((ch) => ({
      id: ch.id,
      amount: toMajor(ch.amount, ch.currency),
      refunded_amount: toMajor(ch.amount_refunded, ch.currency),
      refundable: toMajor(ch.amount - ch.amount_refunded, ch.currency),
      currency: ch.currency,
      refunded: !!ch.refunded,
      disputed: !!ch.disputed,
      created: ch.created,
      email: ch.billing_details?.email || ch.receipt_email || '',
      name: ch.billing_details?.name || '',
      card: ch.payment_method_details?.card
        ? `${ch.payment_method_details.card.brand} …${ch.payment_method_details.card.last4}`
        : '',
      card_fingerprint: ch.payment_method_details?.card?.fingerprint || '',
      country: ch.payment_method_details?.card?.country || '',
      risk_level: ch.outcome?.risk_level || '',
      risk_score: ch.outcome?.risk_score,
      fraud_report: ch.fraud_details?.user_report || '',
      description: ch.description || '',
      customer: typeof ch.customer === 'string' ? ch.customer : ch.customer?.id || '',
      dashboard_url: `https://dashboard.stripe.com/payments/${ch.id}`,
    }));

  // --- payouts still stoppable ---------------------------------------------
  const pendingPayouts = (payouts.data || [])
    .filter((p) => ['pending', 'in_transit'].includes(p.status))
    .slice(0, 5)
    .map((p) => ({
      id: p.id,
      amount: toMajor(p.amount, p.currency),
      currency: p.currency,
      status: p.status,
      arrival_date: p.arrival_date,
      cancellable: p.status === 'pending',
    }));

  const byCurrency = (arr) => {
    const out = {};
    for (const b of arr || []) {
      const c = String(b.currency || '').toLowerCase();
      out[c] = (out[c] || 0) + toMajor(b.amount, b.currency);
    }
    return out;
  };

  return {
    disputes: disputeRows,
    warnings: warningRows,
    reviews: reviewRows,
    capturable,
    risky,
    recent,
    payouts: pendingPayouts,
    balance: { available: byCurrency(balance.available), pending: byCurrency(balance.pending) },
  };
}

/** Every account's worklist, gathered concurrently. */
async function worklistForUser(userId) {
  const accounts = d.listAccounts(userId).filter((a) => d.accountKey(a));
  const started = Date.now();

  const rows = await pool(accounts, 5, async (acc) => {
    try {
      const w = await worklist(acc);
      const todo = w.disputes.length + w.warnings.length + w.reviews.length
        + w.capturable.length + w.risky.length;
      // Every account with a working key is returned, quiet or not: the Act tab
      // is a control panel for the whole fleet, not only a queue of problems.
      return {
        account_id: acc.id,
        label: acc.label || acc.business_name || `account ${acc.id}`,
        health: acc.health,
        currency: acc.currency || '',
        todo,
        ...w,
      };
    } catch (e) {
      return { account_id: acc.id, label: acc.label, error: e.message };
    }
  });

  const list = rows.filter(Boolean);
  const sum = (k) => list.reduce((n, r) => n + (r[k] ? r[k].length : 0), 0);

  // Worst first: an account with disputes outranks one with a spare balance.
  const weight = (r) => (r.disputes?.length || 0) * 100 + (r.warnings?.length || 0) * 80
    + (r.reviews?.length || 0) * 40 + (r.capturable?.length || 0) * 20 + (r.risky?.length || 0) * 5;
  list.sort((a, b) => weight(b) - weight(a));

  return {
    scanned: accounts.length,
    took_ms: Date.now() - started,
    accounts: list,
    totals: {
      disputes: sum('disputes'),
      warnings: sum('warnings'),
      reviews: sum('reviews'),
      capturable: sum('capturable'),
      risky: sum('risky'),
      payouts: sum('payouts'),
      errors: list.filter((r) => r.error).length,
    },
  };
}

module.exports = {
  loadCharge, refund, review, closeDispute, submitEvidence, payout,
  pending, pendingForUser, worklist, worklistForUser, lookup, summarise,
  reportFraud, blockLists, block, unblock,
  capture, cancelPayment, payoutAction,
  cancelSubscription, invoiceAction, deleteCustomer, capabilities,
};
