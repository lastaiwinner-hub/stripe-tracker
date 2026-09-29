'use strict';

/**
 * http.js — the one place this app talks to the network.
 *
 * Every outbound call in the old code used a bare `fetch` with no timeout and
 * no retry. One dropped packet therefore became a hard error, which marked a
 * Stripe account unreachable, which fired a critical alert, which fired a
 * second "recovered" alert on the next poll. 503 of the 524 connection alerts
 * in the event history say literally "fetch failed".
 *
 * So: everything gets a deadline, and anything that is worth trying again is
 * tried again with jittered backoff before it is allowed to become an error.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

/** Network-level failures (DNS, reset, timeout) have no HTTP status at all. */
class HttpError extends Error {
  constructor(message, { status, code, body, transient } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.body = body;
    this._transient = transient;
  }

  /** Worth another attempt: no reply, rate limited, or the far side broke. */
  get transient() {
    if (this._transient !== undefined) return this._transient;
    if (this.status === undefined) return true;   // never got an answer
    if (this.status === 429) return true;         // rate limited
    return this.status >= 500;                    // their side, not ours
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential with jitter, so many accounts retrying don't sync up. */
function backoffMs(attempt) {
  const base = 400 * 2 ** attempt;
  return Math.round(base + Math.random() * base * 0.5);
}

/**
 * fetch + JSON + timeout + retry.
 *
 * `parseError(json, res)` lets each API turn its own error envelope into a
 * message (Stripe uses `error.message`, Telegram uses `description`, Google
 * nests it under `error.message`).
 */
async function requestJSON(url, {
  method = 'GET',
  headers = {},
  body,
  timeout = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  parseError,
  isOk,
  retryAfterFrom,
} = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Honour an explicit retry-after when the server gave us one; it knows
      // better than our backoff curve does.
      const wait = lastErr?.retryAfterMs ?? backoffMs(attempt - 1);
      await sleep(Math.min(wait, 60_000));
    }

    let res;
    let json;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      // AbortError (our deadline) or a TypeError from undici ("fetch failed").
      const msg = e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `timed out after ${Math.round(timeout / 1000)}s`
        : e.message || String(e);
      lastErr = new HttpError(msg, { transient: true, code: e.name });
      continue;
    }

    const ok = isOk ? isOk(json, res) : res.ok;
    if (ok) return json;

    const message = (parseError && parseError(json, res)) || `HTTP ${res.status}`;
    const err = new HttpError(message, {
      status: res.status,
      code: json?.error?.code,
      body: json,
    });

    const retryAfter = retryAfterFrom
      ? retryAfterFrom(json, res)
      : Number(res.headers.get('retry-after')) || null;
    if (retryAfter) err.retryAfterMs = retryAfter * 1000;

    if (!err.transient) throw err;   // 4xx that will fail identically next time
    lastErr = err;
  }

  throw lastErr;
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * The poller used to await one account at a time: 41 accounts x 4+ calls is
 * 164 strictly serial round-trips inside a 60-second budget. Stripe's read
 * limit is 100 req/s, so a pool of six is nowhere near it and turns a
 * 40-65 second cycle into roughly 8-12 seconds.
 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runner = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runner)
  );
  return results;
}

module.exports = { requestJSON, HttpError, pool, sleep, backoffMs };
