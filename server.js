'use strict';

/**
 * Stripe Tracker — standalone app.
 * Groups Stripe accounts by brand, polls the Stripe API for their health and
 * money movement, and pushes anything noteworthy to Telegram.
 */

const path = require('path');
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

app.use(express.json({ limit: '2mb' }));

// Everything below the gate needs a session — including the static files, so a
// stranger who finds the tunnel URL sees a login screen and nothing else.
app.use(auth.gate);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

const PORT = process.env.PORT || 4700;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stripe Tracker running at http://localhost:${PORT}`);
  if (!auth.isConfigured()) {
    console.log('No password set yet — open the app and choose one on the login screen.');
  }
});

// Tidy expired sessions hourly.
d.pruneSessions();
setInterval(() => d.pruneSessions(), 60 * 60 * 1000);

/**
 * Poll loop. Interval is user-configurable, so re-check the clock every 15s
 * rather than locking an interval in at boot.
 */
let polling = false;
let lastPollAt = 0;

setInterval(async () => {
  if (polling) return;
  if (d.getSetting('poll_enabled', '1') !== '1') return;

  const every = Number(d.getSetting('poll_seconds', '60')) * 1000;
  if (Date.now() - lastPollAt < every) return;

  polling = true;
  lastPollAt = Date.now();
  try {
    await stripe.pollAll();      // every user's accounts
    await telegram.flush();      // one shared bot/chat
    await sheets.autoPushAll();  // each user's own spreadsheet
  } catch (e) {
    console.error('[poll]', e.message);
  } finally {
    polling = false;
  }
}, 10_000);
