'use strict';

/**
 * db.js — SQLite schema + helpers for the Stripe tracker.
 *
 * groups           brands/folders the user creates
 * stripe_accounts  one row per Stripe account (holds a restricted API key)
 * events           everything the poller noticed, newest first
 * settings         telegram config, poll cursors, etc.
 *
 * Same self-healing connection pattern as whop-structure: a Windows
 * "disk I/O error" poisons a SQLite handle permanently, so we reopen + retry.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createHash } = require('crypto');
const { encrypt, decrypt } = require('./crypto');

/**
 * Is this value already an AES-GCM blob from crypto.js, or still plaintext?
 * Blobs are base64 of iv(12) + tag(16) + ciphertext, so they are at least 28
 * bytes and decode cleanly. A Telegram token or a JSON key file does neither.
 */
function looksEncrypted(v) {
  const s = String(v || '');
  if (!s || /[^A-Za-z0-9+/=]/.test(s)) return false;
  try {
    return Buffer.from(s, 'base64').length >= 29;
  } catch {
    return false;
  }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'stripe.db');

let db = openDb();

function openDb() {
  const conn = new Database(DB_PATH);
  try {
    conn.pragma('journal_mode = WAL');
  } catch {
    conn.pragma('journal_mode = DELETE');
  }
  conn.pragma('foreign_keys = ON');
  return conn;
}

function isIoError(e) {
  return /disk I\/O error|database is locked|not a database|SQLITE_IOERR/i.test(e.message || '');
}

let stmts = new Map();
function prep(sql) {
  let s = stmts.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmts.set(sql, s);
  }
  return s;
}

function withRetry(fn) {
  try {
    return fn();
  } catch (e) {
    if (!isIoError(e)) throw e;
    console.error('[db] I/O error, reopening database:', e.message);
    try { db.close(); } catch { /* already broken */ }
    db = openDb();
    stmts = new Map();
    return fn();
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS stripe_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    label          TEXT NOT NULL DEFAULT '',
    group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    api_key        TEXT NOT NULL DEFAULT '',
    stripe_id      TEXT NOT NULL DEFAULT '',
    email          TEXT NOT NULL DEFAULT '',
    country        TEXT NOT NULL DEFAULT '',
    currency       TEXT NOT NULL DEFAULT '',
    business_name  TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',

    -- live values refreshed by the poller
    health          TEXT NOT NULL DEFAULT 'unknown',
    charges_enabled INTEGER NOT NULL DEFAULT 0,
    payouts_enabled INTEGER NOT NULL DEFAULT 0,
    requirements    TEXT NOT NULL DEFAULT '',
    disabled_reason TEXT NOT NULL DEFAULT '',
    balance_available REAL NOT NULL DEFAULT 0,
    balance_pending   REAL NOT NULL DEFAULT 0,
    volume_today      REAL NOT NULL DEFAULT 0,
    sales_today       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT NOT NULL DEFAULT '',
    last_checked   TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES stripe_accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT '',
    severity   TEXT NOT NULL DEFAULT 'info',
    title      TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    amount     REAL,
    currency   TEXT NOT NULL DEFAULT '',
    stripe_ref TEXT NOT NULL DEFAULT '',
    notified   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Per-user settings (each person's own Google Sheet, etc).
  -- Telegram deliberately stays in the global 'settings' table: one bot,
  -- one chat, shared by everyone.
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    pw_hash    TEXT NOT NULL DEFAULT '',
    pw_salt    TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT 'member',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT '',
    last_login TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    label      TEXT NOT NULL DEFAULT ''
  );

  -- One row per account per day, written by the poller. Without this the app
  -- could only answer "what happened today": everything reset at midnight, so
  -- there was no trend, no 30-day total and -- the one that actually keeps
  -- accounts alive -- no dispute rate.
  CREATE TABLE IF NOT EXISTS daily_stats (
    account_id INTEGER NOT NULL REFERENCES stripe_accounts(id) ON DELETE CASCADE,
    day        TEXT    NOT NULL,          -- YYYY-MM-DD in the account's own timezone
    currency   TEXT    NOT NULL DEFAULT '',
    sales      INTEGER NOT NULL DEFAULT 0,
    volume     REAL    NOT NULL DEFAULT 0,
    refunds    INTEGER NOT NULL DEFAULT 0,
    refunded   REAL    NOT NULL DEFAULT 0,
    declines   INTEGER NOT NULL DEFAULT 0,
    disputes   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, day)
  );

  -- Indexes on user_id live in migrate(), because that column is added by
  -- ALTER TABLE further down and does not exist on a brand-new database yet.
  CREATE INDEX IF NOT EXISTS idx_acc_group   ON stripe_accounts(group_id);
  CREATE INDEX IF NOT EXISTS idx_ev_account  ON events(account_id);
  CREATE INDEX IF NOT EXISTS idx_ev_created  ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_ds_day      ON daily_stats(day);
  CREATE INDEX IF NOT EXISTS idx_sess_user   ON sessions(user_id);
`);

/**
 * Credential columns were added after the first release; SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so check the table before altering it.
 */
(function migrate() {
  // sessions predates multi-user; it has no user_id. They are throwaway tokens,
  // so recreating the table (and forcing a re-login) is the honest fix.
  const sessionCols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  if (sessionCols.size && !sessionCols.has('user_id')) {
    db.exec(`
      DROP TABLE sessions;
      CREATE TABLE sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL DEFAULT 0,
        label      TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  // Multi-tenancy: every group, account and event belongs to one user.
  // Existing rows predate this and are handed to the first admin.
  const ownerCols = [
    ['groups', 'user_id'],
    ['stripe_accounts', 'user_id'],
    ['events', 'user_id'],
  ];
  for (const [table, col] of ownerCols) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (cols.size && !cols.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
    }
  }
  // Safe now that every ownerCols ALTER above has run. Every hot query filters
  // on user_id and nothing covered it.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_acc_user ON stripe_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_grp_user ON groups(user_id);
    CREATE INDEX IF NOT EXISTS idx_ev_user  ON events(user_id, id DESC);
  `);

  const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (firstAdmin) {
    for (const [table] of ownerCols) {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(firstAdmin.id);
    }

    // The Google Sheet and the Telegram bot used to be single global
    // connections; both now belong to a user. Hand the existing ones to the
    // first admin, once.
    const moved = [];
    const globalToUser = [
      'sheet_id', 'service_account', 'sheets_auto', 'sheets_include_secrets', 'last_sheet_push',
      'tg_token', 'tg_chat_id', 'tg_chat_name', 'tg_kinds', 'verbose_events',
    ];
    for (const key of globalToUser) {
      const old = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!old) continue;
      const already = db.prepare('SELECT 1 FROM user_settings WHERE user_id = ? AND key = ?').get(firstAdmin.id, key);
      if (already) continue;
      db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(firstAdmin.id, key, old.value);
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      moved.push(key);
    }
    if (moved.length) console.log(`[db] moved shared settings to user ${firstAdmin.id}: ${moved.join(', ')}`);
  }

  const existing = new Set(db.prepare('PRAGMA table_info(stripe_accounts)').all().map((c) => c.name));
  const additions = [
    ['login_email', "TEXT NOT NULL DEFAULT ''"],
    ['phone', "TEXT NOT NULL DEFAULT ''"],
    ['dashboard_url', "TEXT NOT NULL DEFAULT ''"],
    ['enc_password', 'TEXT'],
    ['enc_twofa', 'TEXT'],
    ['enc_backup_codes', 'TEXT'],
    ['enc_cred_notes', 'TEXT'],
    // Everything submitted to Stripe during onboarding, as one encrypted JSON
    // blob: business details, address, representative, bank, custom fields.
    ['enc_business', 'TEXT'],
    // Mirrored in plaintext purely so the cards can show them without a reveal.
    ['legal_name', "TEXT NOT NULL DEFAULT ''"],
    ['website', "TEXT NOT NULL DEFAULT ''"],
    // Free-drag position inside the group box; null until first moved.
    ['pos_x', 'REAL'],
    ['pos_y', 'REAL'],
    // The live Stripe key, encrypted. The old plaintext `api_key` column is
    // emptied by the migration below and kept only so old rows still read.
    ['enc_api_key', 'TEXT'],
    // Balances as {currency: amount} JSON. The old scalar columns added USD to
    // EUR and showed the sum under one currency label.
    ['balances_available', "TEXT NOT NULL DEFAULT ''"],
    ['balances_pending', "TEXT NOT NULL DEFAULT ''"],
    // Consecutive failed polls. An account is only declared unreachable after
    // FAIL_THRESHOLD of them, so one dropped packet is no longer an incident.
    ['fail_streak', 'INTEGER NOT NULL DEFAULT 0'],
    // The account's own timezone, so "today" rolls over when Stripe says it does.
    ['timezone', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, decl] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE stripe_accounts ADD COLUMN ${name} ${decl}`);
  }

  // --- Stripe keys were stored in plaintext -------------------------------
  // Every other secret in this table (password, 2FA, SSN, bank numbers) went
  // through crypto.js from the start; the live sk_live_ key -- the single most
  // valuable thing here -- did not. Move them across once, then blank the
  // plaintext column so a copy of stripe.db is worthless on its own.
  {
    const plain = db.prepare("SELECT id, api_key FROM stripe_accounts WHERE api_key <> '' AND (enc_api_key IS NULL OR enc_api_key = '')").all();
    if (plain.length) {
      const move = db.transaction((rows) => {
        const up = db.prepare("UPDATE stripe_accounts SET enc_api_key = ?, api_key = '' WHERE id = ?");
        for (const r of rows) up.run(encrypt(r.api_key), r.id);
      });
      move(plain);
      console.log(`[db] encrypted ${plain.length} Stripe API key(s) and cleared the plaintext column`);
    }
    // Anything left in api_key after that is a straggler from a concurrent write.
    db.prepare("UPDATE stripe_accounts SET api_key = '' WHERE api_key <> '' AND enc_api_key IS NOT NULL").run();
  }

  // --- Telegram tokens and Google service-account keys, same story ---------
  {
    const SECRET_KEYS = ['tg_token', 'service_account'];
    const rows = db.prepare(
      `SELECT user_id, key, value FROM user_settings WHERE key IN (${SECRET_KEYS.map(() => '?').join(',')}) AND value <> ''`
    ).all(...SECRET_KEYS);
    const stillPlain = rows.filter((r) => !looksEncrypted(r.value));
    if (stillPlain.length) {
      const move = db.transaction((list) => {
        const up = db.prepare('UPDATE user_settings SET value = ? WHERE user_id = ? AND key = ?');
        for (const r of list) up.run(encrypt(r.value), r.user_id, r.key);
      });
      move(stillPlain);
      console.log(`[db] encrypted ${stillPlain.length} bot token / service-account key(s)`);
    }
  }

  // --- de-duplication was global, not per user ----------------------------
  // With one index across every user, two people tracking the same Stripe
  // account meant the second one silently never heard about anything --
  // INSERT OR IGNORE swallowed it without a trace.
  {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ev_ref'").get();
    if (idx) {
      db.exec('DROP INDEX idx_ev_ref');
      console.log('[db] replaced the global event de-dup index with a per-user one');
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ev_ref_user ON events(user_id, stripe_ref) WHERE stripe_ref <> ''");
  }

  // --- leftovers from the single-password era -----------------------------
  {
    const gone = db.prepare("DELETE FROM settings WHERE key IN ('auth_hash', 'auth_salt')").run();
    if (gone.changes) console.log('[db] dropped stale single-password credentials from settings');
  }

  // Session tokens are hashed from now on. A stored raw token and a stored
  // hash are both 64 hex characters, so they cannot be told apart by shape --
  // clear the table once, under a flag, and let everyone sign in again.
  {
    const done = db.prepare("SELECT value FROM settings WHERE key = 'sessions_hashed'").get();
    if (!done) {
      const n = db.prepare('DELETE FROM sessions').run().changes;
      db.prepare("INSERT INTO settings (key, value) VALUES ('sessions_hashed', '1')").run();
      if (n) console.log(`[db] cleared ${n} pre-hash session(s) -- everyone signs in once more`);
    }
  }
})();

const ACCOUNT_FIELDS = [
  'label', 'group_id', 'api_key', 'email', 'notes', 'business_name',
  'login_email', 'phone', 'dashboard_url',
];

/** Encrypted credential fields: written and read only through the /credentials routes. */
const CRED_FIELDS = {
  password: 'enc_password',
  twofa: 'enc_twofa',
  backup_codes: 'enc_backup_codes',
  cred_notes: 'enc_cred_notes',
};

function now() {
  return new Date().toISOString();
}

// --- settings ---------------------------------------------------------------

function getSetting(key, fallback = null) {
  const row = withRetry(() => prep('SELECT value FROM settings WHERE key = ?').get(key));
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  withRetry(() =>
    prep('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  );
}
function getVersion() {
  return Number(getSetting('data_version', '0'));
}
function bumpVersion() {
  setSetting('data_version', String(getVersion() + 1));
}

// --- per-user settings ------------------------------------------------------

function getUserSetting(userId, key, fallback = null) {
  const row = withRetry(() =>
    prep('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key)
  );
  return row ? row.value : fallback;
}

/**
 * Per-user secrets (bot token, Google service-account key) go through the same
 * AES-GCM path as everything else. Reads tolerate a plaintext value so a row
 * the migration has not touched yet still works.
 */
function getUserSecret(userId, key, fallback = '') {
  const raw = getUserSetting(userId, key, '');
  if (!raw) return fallback;
  if (!looksEncrypted(raw)) return raw;
  return decrypt(raw) || fallback;
}

function setUserSecret(userId, key, value) {
  const v = String(value ?? '');
  setUserSetting(userId, key, v === '' ? '' : encrypt(v));
}

function setUserSetting(userId, key, value) {
  withRetry(() =>
    prep(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`)
      .run(userId, key, String(value))
  );
}

// --- groups -----------------------------------------------------------------

function listGroups(userId) {
  return withRetry(() =>
    prep('SELECT * FROM groups WHERE user_id = ? ORDER BY sort_order, id').all(userId)
  );
}
function getGroup(id) {
  return withRetry(() => prep('SELECT * FROM groups WHERE id = ?').get(id));
}
function createGroup(userId, name) {
  const info = withRetry(() =>
    prep(`INSERT INTO groups (user_id, name, sort_order)
          VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM groups WHERE user_id = ?))`)
      .run(userId, String(name || 'New group').trim(), userId)
  );
  bumpVersion();
  return Number(info.lastInsertRowid);
}
function renameGroup(id, name) {
  const changes = withRetry(() => prep('UPDATE groups SET name = ? WHERE id = ?').run(String(name).trim(), id).changes);
  if (changes) bumpVersion();
  return changes;
}
function deleteGroup(id) {
  // accounts fall back to "ungrouped" thanks to ON DELETE SET NULL
  const changes = withRetry(() => prep('DELETE FROM groups WHERE id = ?').run(id).changes);
  if (changes) bumpVersion();
  return changes;
}

// --- accounts ---------------------------------------------------------------

/**
 * The account's Stripe key, decrypted. Reads the encrypted column and falls
 * back to the legacy plaintext one so a row the migration has not reached yet
 * still polls.
 */
function accountKey(a) {
  if (!a) return '';
  if (a.enc_api_key) return decrypt(a.enc_api_key);
  return a.api_key || '';
}

/** Balances are stored as {currency: amount} JSON — USD and EUR never merge. */
function parseMoneyMap(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Never let the raw API key reach the browser — only a masked hint. */
function maskKey(key) {
  if (!key) return '';
  const tail = key.slice(-4);
  const kind = key.startsWith('rk_') ? 'restricted' : key.startsWith('sk_') ? 'secret' : 'key';
  const mode = key.includes('_test_') ? 'test' : 'live';
  return `${kind} · ${mode} · …${tail}`;
}

/**
 * What the browser is allowed to see: never the API key, never a credential
 * blob — only booleans saying whether each one is filled in.
 */
function publicAccount(a) {
  const {
    api_key, enc_api_key, enc_password, enc_twofa, enc_backup_codes,
    enc_cred_notes, enc_business, ...rest
  } = a;
  const key = accountKey(a);
  return {
    ...rest,
    balances_available: parseMoneyMap(a.balances_available),
    balances_pending: parseMoneyMap(a.balances_pending),
    has_key: !!key,
    key_hint: maskKey(key),
    has_password: !!enc_password,
    has_twofa: !!enc_twofa,
    has_backup_codes: !!enc_backup_codes,
    has_cred_notes: !!enc_cred_notes,
    has_business: !!enc_business,
    business_fields: enc_business ? countBusinessFields(enc_business) : 0,
  };
}

/** How many business fields are actually filled in — shown on the card's pill. */
function countBusinessFields(blob) {
  try {
    const b = JSON.parse(decrypt(blob) || '{}');
    let n = 0;
    for (const section of ['business', 'address', 'rep', 'bank']) {
      for (const v of Object.values(b[section] || {})) if (String(v ?? '').trim()) n++;
    }
    n += (b.custom || []).filter((f) => String(f.value ?? '').trim()).length;
    return n;
  } catch {
    return 0;
  }
}

/** Decrypt one account's credentials — only for an explicit reveal request. */
function getCredentials(id) {
  const a = getAccount(id);
  if (!a) throw new Error('Account not found.');
  const out = { login_email: a.login_email || '', phone: a.phone || '', dashboard_url: a.dashboard_url || '' };
  for (const [name, col] of Object.entries(CRED_FIELDS)) out[name] = decrypt(a[col]);
  return out;
}

/**
 * Save credentials. A field left undefined keeps its stored value, so the UI
 * can save one field without having to send the others back.
 */
function setCredentials(id, patch) {
  const plain = {};
  for (const f of ['login_email', 'phone', 'dashboard_url']) {
    if (patch[f] !== undefined) plain[f] = String(patch[f] ?? '').trim();
  }
  const enc = {};
  for (const [name, col] of Object.entries(CRED_FIELDS)) {
    if (patch[name] !== undefined) enc[col] = encrypt(patch[name]);
  }
  const all = { ...plain, ...enc };
  const cols = Object.keys(all);
  if (!cols.length) return 0;
  const sql = `UPDATE stripe_accounts SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`;
  const changes = withRetry(() => prep(sql).run({ ...all, ts: now(), id }).changes);
  if (changes) bumpVersion();
  return changes;
}

function listAccounts(userId) {
  return withRetry(() =>
    prep('SELECT * FROM stripe_accounts WHERE user_id = ? ORDER BY group_id, id').all(userId)
  );
}
/** Every account across all users — only the poller should use this. */
function listAllAccounts() {
  return withRetry(() => prep('SELECT * FROM stripe_accounts ORDER BY user_id, id').all());
}
function listAccountsPublic(userId) {
  return listAccounts(userId).map(publicAccount);
}
function getAccount(id) {
  return withRetry(() => prep('SELECT * FROM stripe_accounts WHERE id = ?').get(id));
}

function normalizeAccount(patch) {
  const out = {};
  for (const f of ACCOUNT_FIELDS) {
    if (patch[f] === undefined) continue;
    if (f === 'group_id') {
      const n = Number(patch[f]);
      out[f] = patch[f] === null || patch[f] === '' || !Number.isFinite(n) ? null : n;
    } else {
      out[f] = String(patch[f] ?? '').trim();
    }
  }
  return out;
}

function createAccount(userId, patch) {
  const a = {
    label: '', group_id: null, api_key: '', email: '', notes: '', business_name: '',
    ...normalizeAccount(patch),
  };
  const enc_api_key = a.api_key ? encrypt(a.api_key) : null;
  a.api_key = '';
  const info = withRetry(() =>
    prep(`INSERT INTO stripe_accounts (user_id, label, group_id, api_key, enc_api_key, email, notes, business_name, created_at, updated_at)
          VALUES (@user_id, @label, @group_id, '', @enc_api_key, @email, @notes, @business_name, @ts, @ts)`)
      .run({ ...a, enc_api_key, user_id: userId, ts: now() })
  );
  bumpVersion();
  return Number(info.lastInsertRowid);
}

function patchAccount(id, patch) {
  const clean = normalizeAccount(patch);
  // A key arriving from the UI is encrypted on the way in and the plaintext
  // column is explicitly blanked, so no path can reintroduce a cleartext key.
  if (clean.api_key !== undefined) {
    clean.enc_api_key = clean.api_key ? encrypt(clean.api_key) : null;
    clean.api_key = '';
  }
  const cols = Object.keys(clean);
  if (!cols.length) return 0;
  const sql = `UPDATE stripe_accounts SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`;
  const changes = withRetry(() => prep(sql).run({ ...clean, ts: now(), id }).changes);
  if (changes) bumpVersion();
  return changes;
}

/** Written by the poller only — live Stripe state, not user input. */
function updateLive(id, live) {
  const cols = Object.keys(live);
  if (!cols.length) return 0;
  const sql = `UPDATE stripe_accounts SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`;
  const changes = withRetry(() => prep(sql).run({ ...live, id }).changes);
  if (changes) bumpVersion();
  return changes;
}

/** Where a card sits inside its group box. Not a user-content edit — no version bump. */
function setPosition(id, x, y) {
  withRetry(() => prep('UPDATE stripe_accounts SET pos_x = ?, pos_y = ? WHERE id = ?').run(x, y, id));
}

function deleteAccount(id) {
  const changes = withRetry(() => prep('DELETE FROM stripe_accounts WHERE id = ?').run(id).changes);
  if (changes) bumpVersion();
  return changes;
}

// --- events -----------------------------------------------------------------

/**
 * Insert an event. stripe_ref makes it idempotent: polling the same charge
 * twice can't produce two alerts (unique index ignores the second insert).
 * Returns the new row id, or null when it was a duplicate.
 */
function addEvent(ev) {
  // An event belongs to whoever owns the account it came from.
  let userId = ev.user_id ?? null;
  if (userId === null && ev.account_id) {
    const acc = getAccount(ev.account_id);
    userId = acc ? acc.user_id : null;
  }
  const row = {
    user_id: userId,
    account_id: ev.account_id ?? null,
    kind: ev.kind || '',
    severity: ev.severity || 'info',
    title: ev.title || '',
    detail: ev.detail || '',
    amount: ev.amount ?? null,
    currency: ev.currency || '',
    stripe_ref: ev.stripe_ref || '',
    created_at: ev.created_at || now(),
  };
  const info = withRetry(() =>
    prep(`INSERT OR IGNORE INTO events
            (user_id, account_id, kind, severity, title, detail, amount, currency, stripe_ref, created_at)
          VALUES (@user_id, @account_id, @kind, @severity, @title, @detail, @amount, @currency, @stripe_ref, @created_at)`)
      .run(row)
  );
  if (!info.changes) return null;
  bumpVersion();
  return Number(info.lastInsertRowid);
}

function listEvents(userId, limit = 200) {
  return withRetry(() =>
    prep(`SELECT e.*, a.label AS account_label, a.stripe_id AS account_stripe_id
          FROM events e LEFT JOIN stripe_accounts a ON a.id = e.account_id
          WHERE e.user_id = ?
          ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(userId, limit)
  );
}

function unnotifiedEvents() {
  return withRetry(() =>
    prep(`SELECT e.*, a.label AS account_label, a.stripe_id AS account_stripe_id
          FROM events e LEFT JOIN stripe_accounts a ON a.id = e.account_id
          WHERE e.notified = 0 ORDER BY e.id`).all()
  );
}

function markNotified(ids) {
  if (!ids.length) return;
  withRetry(() =>
    prep(`UPDATE events SET notified = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  );
}

// --- users ------------------------------------------------------------------

function listUsers() {
  return withRetry(() =>
    prep('SELECT id, email, role, active, created_at, last_login FROM users ORDER BY id').all()
  );
}
function countUsers() {
  return withRetry(() => prep('SELECT COUNT(*) AS n FROM users').get()).n;
}
function countAdmins() {
  return withRetry(() => prep("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get()).n;
}
function getUserByEmail(email) {
  return withRetry(() => prep('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase()));
}
function getUser(id) {
  return withRetry(() => prep('SELECT * FROM users WHERE id = ?').get(id));
}

function createUser({ email, pw_hash, pw_salt, role }) {
  const info = withRetry(() =>
    prep(`INSERT INTO users (email, pw_hash, pw_salt, role, active, created_at)
          VALUES (?, ?, ?, ?, 1, ?)`)
      .run(String(email).trim().toLowerCase(), pw_hash, pw_salt, role === 'admin' ? 'admin' : 'member', now())
  );
  return Number(info.lastInsertRowid);
}

function updateUser(id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return 0;
  const sql = `UPDATE users SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`;
  return withRetry(() => prep(sql).run({ ...patch, id }).changes);
}

/**
 * The user_id columns were added by ALTER TABLE, which cannot attach a foreign
 * key in SQLite, so nothing cascaded: a removed person's accounts, encrypted
 * credentials and events all survived -- and the poller kept using their live
 * Stripe keys forever. Do it by hand, in one transaction.
 */
function deleteUser(id) {
  return withRetry(() => {
    const run = db.transaction((userId) => {
      const accounts = db.prepare('SELECT id FROM stripe_accounts WHERE user_id = ?').all(userId);
      const dropStats = db.prepare('DELETE FROM daily_stats WHERE account_id = ?');
      for (const a of accounts) dropStats.run(a.id);
      db.prepare('DELETE FROM events WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM stripe_accounts WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM groups WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      for (const a of accounts) db.prepare('DELETE FROM settings WHERE key = ?').run(`cursor_${a.id}`);
      return db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes;
    });
    return run(id);
  });
}

function touchLogin(id) {
  withRetry(() => prep('UPDATE users SET last_login = ? WHERE id = ?').run(now(), id));
}

/** Sign out every device belonging to one user. */
function clearUserSessions(userId) {
  withRetry(() => prep('DELETE FROM sessions WHERE user_id = ?').run(userId));
}

// --- sessions ---------------------------------------------------------------

/**
 * Only a SHA-256 of the cookie value is stored. Read access to stripe.db used
 * to be enough to impersonate every signed-in user; now the rows are useless
 * without the token the browser holds.
 */
const sessionHash = (token) => createHash('sha256').update(String(token)).digest('hex');

function createSession(token, userId, expiresAt, label) {
  withRetry(() =>
    prep('INSERT INTO sessions (token, user_id, created_at, expires_at, label) VALUES (?, ?, ?, ?, ?)')
      .run(sessionHash(token), userId, now(), expiresAt, label || '')
  );
}

function getSession(token) {
  return withRetry(() =>
    prep(`SELECT s.*, u.email, u.role, u.active
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`).get(sessionHash(token))
  );
}

function deleteSession(token) {
  withRetry(() => prep('DELETE FROM sessions WHERE token = ?').run(sessionHash(token)));
}

/** Drop expired rows, and every row when the password changes. */
function pruneSessions() {
  withRetry(() => prep('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()));
}

function clearSessions() {
  withRetry(() => prep('DELETE FROM sessions').run());
}

/** Remove specific events by id — used to tidy up test alerts. */
function deleteEvents(ids) {
  if (!ids || !ids.length) return 0;
  const changes = withRetry(() =>
    prep(`DELETE FROM events WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes
  );
  if (changes) bumpVersion();
  return changes;
}

function clearEvents(userId) {
  withRetry(() => prep('DELETE FROM events WHERE user_id = ?').run(userId));
  bumpVersion();
}

/** The whole onboarding record, decrypted. Explicit reveal only. */
function getBusiness(id) {
  const a = getAccount(id);
  if (!a) throw new Error('Account not found.');
  let b = {};
  try {
    b = JSON.parse(decrypt(a.enc_business) || '{}');
  } catch {
    b = {};
  }
  return {
    business: b.business || {},
    address: b.address || {},
    rep: b.rep || {},
    bank: b.bank || {},
    custom: Array.isArray(b.custom) ? b.custom : [],
  };
}

/**
 * Replace the onboarding record. Stored as one encrypted blob, with legal name
 * and website mirrored to plaintext columns so the cards can display them.
 */
function setBusiness(id, payload) {
  const clean = {
    business: payload.business || {},
    address: payload.address || {},
    rep: payload.rep || {},
    bank: payload.bank || {},
    custom: (Array.isArray(payload.custom) ? payload.custom : [])
      .filter((f) => String(f.label ?? '').trim() || String(f.value ?? '').trim())
      .map((f) => ({ label: String(f.label ?? '').trim(), value: String(f.value ?? '') })),
  };
  const changes = withRetry(() =>
    prep(`UPDATE stripe_accounts
          SET enc_business = @blob, legal_name = @legal_name, website = @website, updated_at = @ts
          WHERE id = @id`)
      .run({
        blob: encrypt(JSON.stringify(clean)),
        legal_name: String(clean.business.legal_name || '').trim(),
        website: String(clean.business.website || '').trim(),
        ts: now(),
        id,
      }).changes
  );
  if (changes) bumpVersion();
  return changes;
}

// --- daily history ----------------------------------------------------------

/**
 * Upsert one account-day. The poller recomputes the current day from Stripe on
 * every pass, so a plain REPLACE of the counters is correct and idempotent --
 * no double counting when the same charge is seen twice.
 */
function recordDay(accountId, day, stats) {
  const row = {
    account_id: accountId,
    day,
    currency: stats.currency || '',
    sales: stats.sales || 0,
    volume: stats.volume || 0,
    refunds: stats.refunds || 0,
    refunded: stats.refunded || 0,
    declines: stats.declines || 0,
    disputes: stats.disputes || 0,
    ts: now(),
  };
  withRetry(() =>
    prep(`INSERT INTO daily_stats (account_id, day, currency, sales, volume, refunds, refunded, declines, disputes, updated_at)
          VALUES (@account_id, @day, @currency, @sales, @volume, @refunds, @refunded, @declines, @disputes, @ts)
          ON CONFLICT(account_id, day) DO UPDATE SET
            currency = excluded.currency,
            sales    = excluded.sales,
            volume   = excluded.volume,
            refunds  = excluded.refunds,
            refunded = excluded.refunded,
            declines = MAX(daily_stats.declines, excluded.declines),
            disputes = MAX(daily_stats.disputes, excluded.disputes),
            updated_at = excluded.updated_at`).run(row)
  );
}

/** Bump a counter that is fed by events rather than recomputed from Stripe. */
function bumpDay(accountId, day, column, by = 1) {
  if (!['declines', 'disputes', 'refunds'].includes(column)) return;
  withRetry(() =>
    prep(`INSERT INTO daily_stats (account_id, day, ${column}, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, day) DO UPDATE SET
            ${column} = daily_stats.${column} + excluded.${column},
            updated_at = excluded.updated_at`).run(accountId, day, by, now())
  );
}

/** Every day-row for one user's accounts over the last N days. */
function listDailyStats(userId, days = 30) {
  if (days === null) {
    return withRetry(() =>
      prep(`SELECT ds.* FROM daily_stats ds
            JOIN stripe_accounts a ON a.id = ds.account_id
            WHERE a.user_id = ?
            ORDER BY ds.day`).all(userId)
    );
  }
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return withRetry(() =>
    prep(`SELECT ds.* FROM daily_stats ds
          JOIN stripe_accounts a ON a.id = ds.account_id
          WHERE a.user_id = ? AND ds.day >= ?
          ORDER BY ds.day`).all(userId, from)
  );
}

/** One row per day across the whole user: what the overview chart draws. */
function dailyTotals(userId, days = 30) {
  if (days === null) {
    return withRetry(() =>
      prep(`SELECT ds.day,
                   SUM(ds.sales)    AS sales,
                   SUM(ds.volume)   AS volume,
                   SUM(ds.refunds)  AS refunds,
                   SUM(ds.refunded) AS refunded,
                   SUM(ds.declines) AS declines,
                   SUM(ds.disputes) AS disputes
            FROM daily_stats ds
            JOIN stripe_accounts a ON a.id = ds.account_id
            WHERE a.user_id = ?
            GROUP BY ds.day ORDER BY ds.day`).all(userId)
    );
  }
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return withRetry(() =>
    prep(`SELECT ds.day,
                 SUM(ds.sales)    AS sales,
                 SUM(ds.volume)   AS volume,
                 SUM(ds.refunds)  AS refunds,
                 SUM(ds.refunded) AS refunded,
                 SUM(ds.declines) AS declines,
                 SUM(ds.disputes) AS disputes
          FROM daily_stats ds
          JOIN stripe_accounts a ON a.id = ds.account_id
          WHERE a.user_id = ? AND ds.day >= ?
          GROUP BY ds.day ORDER BY ds.day`).all(userId, from)
  );
}

// --- maintenance ------------------------------------------------------------

/**
 * The events table only ever grew, and the write-ahead log had never been
 * checkpointed -- 4.1 MB of WAL against a 557 KB database. Both are cheap to
 * keep in hand once something actually asks.
 */
function pruneEvents(keepDays = 90) {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  const n = withRetry(() => prep('DELETE FROM events WHERE created_at < ? AND notified = 1').run(cutoff).changes);
  if (n) bumpVersion();
  return n;
}

function checkpoint() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* a busy reader just means we try again next hour */ }
}

module.exports = {
  now, accountKey, looksEncrypted,
  recordDay, bumpDay, listDailyStats, dailyTotals, pruneEvents, checkpoint,
  getUserSecret, setUserSecret,
  getSetting, setSetting, getVersion, bumpVersion,
  getUserSetting, setUserSetting,
  listGroups, getGroup, createGroup, renameGroup, deleteGroup,
  listAccounts, listAllAccounts, listAccountsPublic, getAccount, publicAccount, maskKey,
  createAccount, patchAccount, updateLive, deleteAccount, setPosition,
  getCredentials, setCredentials, getBusiness, setBusiness,
  addEvent, listEvents, unnotifiedEvents, markNotified, deleteEvents, clearEvents,
  createSession, getSession, deleteSession, pruneSessions, clearSessions,
  listUsers, countUsers, countAdmins, getUser, getUserByEmail,
  createUser, updateUser, deleteUser, touchLogin, clearUserSessions,
};
