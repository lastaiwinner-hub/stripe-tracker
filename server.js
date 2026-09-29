'use strict';

/**
 * Stripe Tracker — standalone app.
 * Groups Stripe accounts by brand, polls the Stripe API for their health and
 * money movement, and pushes anything noteworthy to Telegram.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const d = require('./src/db');
const routes = require('./src/routes');
const stripe = require('./src/stripe');
const telegram = require('./src/telegram');
const sheets = require('./src/sheets');

const auth = require('./src/auth');

const app = express();

// Behind a Cloudflare tunnel the client IP and protocol arrive in headers.
app.set('trust proxy', true);
app.disable('x-powered-by');
app.disable('etag'); // no conditional caching of credential responses

app.use(auth.securityHeaders);
app.use(express.json({ limit: '2mb' }));

// Everything below the gate needs a session — including the static files, so a
// stranger who finds the tunnel URL sees a login screen and nothing else.
app.use(auth.gate);

/**
 * Serve index.html with a version stamp on every asset it pulls in.
 *
 * Cache-Control alone was not enough. The app is reached through a Cloudflare
 * tunnel, and once a browser has cached app.js under an edge-supplied TTL it
 * will keep running the old copy through ordinary reloads -- which is exactly
 * how a fixed file kept producing a broken page.
 *
 * index.html itself is never cached, so stamping the URLs here means a changed
 * file is a changed URL, and a changed URL cannot be served from any cache.
 */
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSIONED = ['app.js', 'ui.js', 'orbit.js', 'styles.css', 'login.js'];

function assetVersion(file) {
  try {
    const st = fs.statSync(path.join(PUBLIC_DIR, file));
    return crypto.createHash('sha1')
      .update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 10);
  } catch {
    return '0';
  }
}

function sendStamped(name, res, next) {
  fs.readFile(path.join(PUBLIC_DIR, name), 'utf8', (err, html) => {
    if (err) return next();
    for (const asset of VERSIONED) {
      html = html
        .replace(`src="${asset}"`, `src="${asset}?v=${assetVersion(asset)}"`)
        .replace(`href="${asset}"`, `href="${asset}?v=${assetVersion(asset)}"`);
    }
    res.type('html').send(html);
  });
}

app.get(['/', '/index.html'], (req, res, next) => sendStamped('index.html', res, next));
app.get('/login.html', (req, res, next) => sendStamped('login.html', res, next));

app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));
app.use('/api', routes);

const PORT = process.env.PORT || 4700;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stripe Tracker running at http://localhost:${PORT}`);
  if (!auth.isConfigured()) {
    console.log('No password set yet — open the app and choose one on the login screen.');
  }
});

// Tidy expired sessions hourly, and keep the database from growing without end.
d.pruneSessions();
setInterval(() => {
  d.pruneSessions();
  // The write-ahead log had never been checkpointed — 4.1 MB of WAL against a
  // 557 KB database — and the events table only ever accumulated.
  d.pruneEvents(90);
  d.checkpoint();
}, 60 * 60 * 1000);

/**
 * Poll loop. Interval is user-configurable, so re-check the clock every 10s
 * rather than locking an interval in at boot.
 */
let polling = false;
let lastPollAt = 0;
let pollStartedAt = 0;

/**
 * Nothing in this app used to have a network timeout, so one socket that never
 * answered parked `polling` at true for good: no alerts, no error, no log line,
 * and a header chip that kept counting up looking perfectly healthy. Timeouts
 * make that far less likely; this makes it impossible to happen silently.
 */
const STALL_FACTOR = 5;

function pollIntervalMs() {
  return Number(d.getSetting('poll_seconds', '60')) * 1000;
}

setInterval(async () => {
  if (polling) {
    const stalledFor = Date.now() - pollStartedAt;
    if (stalledFor > STALL_FACTOR * pollIntervalMs()) {
      console.error(
        `[poll] STALLED — a cycle has been running for ${Math.round(stalledFor / 1000)}s. ` +
        'Releasing the lock so monitoring resumes.'
      );
      d.setSetting('last_stall', d.now());
      polling = false;
    }
    return;
  }
  if (d.getSetting('poll_enabled', '1') !== '1') return;
  if (Date.now() - lastPollAt < pollIntervalMs()) return;

  polling = true;
  pollStartedAt = Date.now();
  lastPollAt = Date.now();
  try {
    await stripe.pollAll();           // every user's accounts, six at a time
    await telegram.flush();           // each user's own bot
    await telegram.pollAllCommands(); // answer /status, /balance, /week …
    await sheets.autoPushAll();       // each user's own spreadsheet
  } catch (e) {
    console.error('[poll]', e.message);
  } finally {
    polling = false;
  }
}, 10_000);

// A rejection inside a detached promise should be loud, not silent.
process.on('unhandledRejection', (e) => {
  console.error('[unhandled]', e && e.message ? e.message : e);
});
