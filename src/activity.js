'use strict';

// Read-only account activity. Never persists keys or modifies Stripe objects.
const cache = new Map();
async function request(key, path, params = {}) {
  const response = await fetch(`https://api.stripe.com/v1${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20' },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Stripe request unavailable (HTTP ${response.status})`);
  return body;
}
async function activity(account, key, after) {
  const cacheId = `${account.id}:${after || ''}`;
  const existing = cache.get(cacheId);
  if (existing && Date.now() - existing.time < 60000) return existing.value;
  const sources = {
    account: ['/account'], balance: ['/balance'],
    charges: ['/charges', { limit: 50, ...(after ? { starting_after: after } : {}), 'expand[]': 'data.balance_transaction' }],
    payouts: ['/payouts', { limit: 25 }], transactions: ['/balance_transactions', { limit: 100 }],
    disputes: ['/disputes', { limit: 25 }], refunds: ['/refunds', { limit: 25 }],
  };
  const result = { checked_at: new Date().toISOString(), errors: {} };
  await Promise.all(Object.entries(sources).map(async ([name, [path, params]]) => {
    try { result[name] = await request(key, path, params); }
    catch (error) { result.errors[name] = error.message; }
  }));
  const a = result.account;
  if (a) result.account = {
    id: a.id, country: a.country, currency: a.default_currency,
    charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled,
    requirements: a.requirements, schedule: a.settings?.payouts?.schedule,
    business_name: a.business_profile?.name,
  };
  // Charge objects do not contain API keys. Drop client secrets from any nested payload.
  const clean = JSON.parse(JSON.stringify(result, (field, value) =>
    /secret|api_key/i.test(field) ? undefined : value));
  if (cache.size > 250) cache.clear();
  cache.set(cacheId, { time: Date.now(), value: clean });
  return clean;
}
module.exports = { activity };
