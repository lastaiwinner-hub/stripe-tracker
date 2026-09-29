'use strict';

/**
 * sheets.js — pushes the whole tracker into a Google Sheet, one way.
 *
 * One-way by design: health, balances and sales are owned by Stripe, so an
 * edit in the sheet would either be meaningless or be overwritten on the next
 * poll. The app is the source of truth; the sheet is an organised mirror.
 *
 * Auth is a service-account JWT (RS256 via node:crypto) traded for an access
 * token — no dependencies, same approach as the whop-structure app.
 */

const { createSign } = require('crypto');
const d = require('./db');
const { requestJSON } = require('./http');

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// --- config -----------------------------------------------------------------

/** Each user connects their own spreadsheet and their own service account. */
function getConfig(userId) {
  const sheetId = d.getUserSetting(userId, 'sheet_id');
  const saRaw = d.getUserSecret(userId, 'service_account', '');
  if (!sheetId || !saRaw) return null;
  try {
    const sa = JSON.parse(saRaw);
    if (!sa.client_email || !sa.private_key) return null;
    return { sheetId, sa };
  } catch {
    return null;
  }
}

/**
 * Defaults to OFF. It used to default to on, so connecting a spreadsheet quietly
 * pushed API keys, passwords, 2FA secrets, SSNs, tax IDs and bank numbers to
 * Google in plaintext every 60 seconds unless you went looking for the tick box.
 * Opting in to that is a decision, not a default.
 */
const includeSecrets = (userId) => d.getUserSetting(userId, 'sheets_include_secrets', '0') === '1';

// --- auth -------------------------------------------------------------------

// Tokens are per service account, so cache them per user.
const tokenCache = new Map();

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getToken(sa, userId) {
  const hit = tokenCache.get(userId);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  }));
  const input = `${header}.${claims}`;
  const jwt = `${input}.${b64url(createSign('RSA-SHA256').update(input).sign(sa.private_key))}`;

  const body = await requestJSON('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
    timeout: 20_000,
    retries: 2,
    parseError: (j) => `Google auth failed: ${j.error_description || j.error || 'unknown'}`,
  });
  tokenCache.set(userId, { token: body.access_token, exp: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

async function gapi(token, method, url, body) {
  return requestJSON(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: 30_000,
    retries: 2,
    parseError: (json, res) => `Sheets API: ${json.error?.message || `HTTP ${res.status}`}`,
  });
}

// --- tab helpers ------------------------------------------------------------

/** Create any missing tabs, drop ones this app used to write, return name -> numeric id. */
async function ensureTabs(token, sheetId, titles) {
  let meta = await gapi(token, 'GET', `${BASE}/${sheetId}?fields=sheets.properties(title,sheetId)`);
  const byName = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));

  const requests = [];
  for (const title of titles) {
    if (!byName.has(title)) requests.push({ addSheet: { properties: { title } } });
  }
  // clean up tabs from older versions — only ones this app created
  for (const stale of OBSOLETE_TABS) {
    if (byName.has(stale) && !titles.includes(stale)) {
      requests.push({ deleteSheet: { sheetId: byName.get(stale) } });
    }
  }

  if (requests.length) {
    await gapi(token, 'POST', `${BASE}/${sheetId}:batchUpdate`, { requests });
    meta = await gapi(token, 'GET', `${BASE}/${sheetId}?fields=sheets.properties(title,sheetId)`);
  }
  return new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
}

/**
 * Make the sheet readable: frozen bold header, tinted header band, sensible
 * column widths, and the account column frozen so wide tabs stay legible.
 */
async function formatTabs(token, sheetId, tabIds, tabs) {
  const requests = [];
  for (const [name, rows] of Object.entries(tabs)) {
    const id = tabIds.get(name);
    if (id === undefined) continue;
    const cols = rows[0]?.length || 1;

    requests.push({
      updateSheetProperties: {
        properties: { sheetId: id, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.24, green: 0.22, blue: 0.6 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
      },
    });
    requests.push({
      autoResizeDimensions: {
        dimensions: { sheetId: id, dimension: 'COLUMNS', startIndex: 0, endIndex: cols },
      },
    });
  }
  if (requests.length) await gapi(token, 'POST', `${BASE}/${sheetId}:batchUpdate`, { requests });
}

async function writeTab(token, sheetId, tab, rows) {
  const range = encodeURIComponent(`'${tab}'!A1:BZ50000`);
  await gapi(token, 'POST', `${BASE}/${sheetId}/values/${range}:clear`, {});
  await gapi(
    token,
    'PUT',
    `${BASE}/${sheetId}/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`,
    { values: rows.length ? rows : [['(empty)']] }
  );
}

/** Google rejects a cell over 50k chars; also keep everything a string. */
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.length > 49000 ? s.slice(0, 49000) + '…(truncated)' : s;
}

const row = (arr) => arr.map(cell);

// --- sheet builders ---------------------------------------------------------

const OVERVIEW_HEAD = [
  'ID', 'Account', 'Group', 'Stripe ID', 'Health', 'Charges enabled', 'Payouts enabled',
  'Requirements', 'Disabled reason', 'Available', 'Pending', 'Currency',
  'Sales today', 'Volume today', 'Last checked', 'Last error',
  'Legal name', 'Website', 'Login email', 'Notes',
];

function overviewRows(accounts, groupName) {
  return accounts.map((a) => row([
    a.id, a.label, groupName(a.group_id), a.stripe_id, a.health,
    a.charges_enabled ? 'yes' : 'no', a.payouts_enabled ? 'yes' : 'no',
    a.requirements, a.disabled_reason,
    a.balance_available, a.balance_pending, (a.currency || '').toUpperCase(),
    a.sales_today, a.volume_today, a.last_checked, a.last_error,
    a.legal_name, a.website, a.login_email, a.notes,
  ]));
}

/**
 * One tab per category, so each stays narrow and readable instead of one
 * 22-column wall. `secret: true` columns are dropped when the user opts out.
 * Section 'cred' comes from the credentials record, the rest from business.
 */
const TAB_SPECS = [
  {
    name: 'Login & keys',
    cols: [
      ['cred', 'login_email', 'Login email'],
      ['cred', 'password', 'Password', true],
      ['cred', 'twofa', '2FA secret', true],
      ['cred', 'backup_codes', 'Backup codes', true],
      ['cred', 'phone', 'Login phone'],
      ['cred', 'dashboard_url', 'Dashboard URL'],
      ['acct', 'api_key', 'Stripe secret key', true],
      ['business', 'publishable_key', 'Publishable key'],
      ['cred', 'cred_notes', 'Notes', true],
    ],
  },
  {
    name: 'Business',
    cols: [
      ['business', 'legal_name', 'Legal name'],
      ['business', 'dba', 'DBA / trading name'],
      ['business', 'type', 'Business type'],
      ['business', 'industry', 'Industry / MCC'],
      ['business', 'website', 'Website'],
      ['business', 'product_description', 'Product description'],
      ['business', 'statement_descriptor', 'Statement descriptor'],
      ['business', 'support_email', 'Support email'],
      ['business', 'support_phone', 'Support phone'],
      ['business', 'incorporation_date', 'Incorporation date'],
      ['business', 'tax_id', 'Tax ID / EIN', true],
      ['business', 'vat_number', 'VAT number', true],
      ['business', 'registration_number', 'Registration number', true],
    ],
  },
  {
    name: 'Address',
    cols: [
      ['address', 'line1', 'Address line 1'],
      ['address', 'line2', 'Address line 2'],
      ['address', 'city', 'City'],
      ['address', 'state', 'State / province'],
      ['address', 'postal_code', 'Postal code'],
      ['address', 'country', 'Country'],
      ['address', 'business_phone', 'Business phone'],
    ],
  },
  {
    name: 'Representative',
    cols: [
      ['rep', 'name', 'Full legal name'],
      ['rep', 'title', 'Title / role'],
      ['rep', 'email', 'Email'],
      ['rep', 'phone', 'Phone'],
      ['rep', 'dob', 'Date of birth', true],
      ['rep', 'id_number', 'SSN / ID number', true],
      ['rep', 'home_address', 'Home address', true],
      ['rep', 'documents', 'Documents submitted', true],
    ],
  },
  {
    name: 'Bank',
    cols: [
      ['bank', 'bank_name', 'Bank name'],
      ['bank', 'account_holder', 'Account holder'],
      ['bank', 'account_number', 'Account number', true],
      ['bank', 'routing_number', 'Routing / sort code', true],
      ['bank', 'iban', 'IBAN', true],
      ['bank', 'swift', 'SWIFT / BIC', true],
      ['bank', 'payout_schedule', 'Payout schedule'],
      ['bank', 'bank_notes', 'Notes', true],
    ],
  },
];

/** Tabs earlier versions wrote that are no longer part of the set. */
const OBSOLETE_TABS = ['Alerts', 'Secrets', 'Business info'];

function pick(section, key, biz, creds, acct) {
  if (section === 'cred') return creds[key];
  if (section === 'acct') return acct[key];
  return (biz[section] || {})[key];
}

// --- the push ---------------------------------------------------------------

// One push at a time per user; two people can push simultaneously.
const pushing = new Set();

async function pushNow(userId) {
  const cfg = getConfig(userId);
  if (!cfg) throw new Error('Google Sheets is not set up yet (see the Sheets card in Settings).');
  if (pushing.has(userId)) throw new Error('A sheet update is already running.');
  pushing.add(userId);
  try {
    return await run(cfg, userId);
  } finally {
    pushing.delete(userId);
  }
}

/**
 * Assemble every tab as {name: rows}. Kept separate from the network calls so
 * the exact sheet contents can be inspected without touching Google.
 */
function buildAll(userId) {
  const secrets = includeSecrets(userId);
  const out = {};
  const accounts = d.listAccounts(userId);
  const groups = d.listGroups(userId);
  const groupName = (gid) => groups.find((g) => g.id === gid)?.name || 'Ungrouped';

  // Decrypt once per account; reused by every tab below.
  const detail = new Map();
  for (const a of accounts) {
    detail.set(a.id, { biz: d.getBusiness(a.id), creds: d.getCredentials(a.id) });
  }

  // 1. Overview — the index: which accounts exist and how they are doing
  out.Overview = [OVERVIEW_HEAD, ...overviewRows(accounts.map(d.publicAccount), groupName)];

  // 2-6. One tab per credential category
  for (const spec of TAB_SPECS) {
    const cols = spec.cols.filter(([, , , isSecret]) => secrets || !isSecret);
    out[spec.name] = [
      ['Account', 'Group', ...cols.map(([, , label]) => label)],
      ...accounts.map((a) => {
        const { biz, creds } = detail.get(a.id);
        return row([
          a.label, groupName(a.group_id),
          ...cols.map(([s, k]) => pick(s, k, biz, creds, a)),
        ]);
      }),
    ];
  }

  // 7. Custom fields — one row per field, so any number of them fits
  const customRows = [];
  for (const a of accounts) {
    for (const f of detail.get(a.id).biz.custom || []) {
      customRows.push(row([a.label, groupName(a.group_id), f.label, f.value]));
    }
  }
  out['Custom fields'] = [['Account', 'Group', 'Field', 'Value'], ...customRows];

  // 8. Groups
  out.Groups = [
    ['Group', 'Accounts', 'Available total'],
    ...groups.map((g) => {
      const list = accounts.filter((a) => a.group_id === g.id);
      return row([g.name, list.length, list.reduce((s, a) => s + (a.balance_available || 0), 0)]);
    }),
  ];

  return { tabs: out, accounts: accounts.length, secrets };
}

async function run(cfg, userId) {
  const token = await getToken(cfg.sa, userId);
  const { tabs, accounts, secrets } = buildAll(userId);
  const names = Object.keys(tabs);

  const tabIds = await ensureTabs(token, cfg.sheetId, names);
  for (const name of names) {
    await writeTab(token, cfg.sheetId, name, tabs[name]);
  }

  // Re-running the header band, freeze panes and auto-resize on every push was
  // a third of the API budget for something that almost never changes. Do it on
  // the first push, when the column set changes, and once a day after that.
  const shape = names.map((n) => `${n}:${tabs[n][0]?.length || 0}`).join('|');
  const lastShape = d.getUserSetting(userId, 'sheet_shape', '');
  const lastFormat = Number(d.getUserSetting(userId, 'sheet_formatted_at', '0'));
  if (shape !== lastShape || Date.now() - lastFormat > 86400_000) {
    await formatTabs(token, cfg.sheetId, tabIds, tabs);
    d.setUserSetting(userId, 'sheet_shape', shape);
    d.setUserSetting(userId, 'sheet_formatted_at', String(Date.now()));
  }

  const stamp = {
    at: d.now(),
    ok: true,
    accounts,
    tabs: names.length,
    secrets_included: secrets,
  };
  d.setUserSetting(userId, 'last_sheet_push', JSON.stringify(stamp));
  return stamp;
}

/** Never rewrite the whole spreadsheet more often than this. */
const MIN_AUTO_PUSH_MS = 5 * 60 * 1000;

/**
 * Called after each poll; silent when unconfigured or switched off.
 *
 * This used to fire on every cycle for every user: 8 tabs cleared and rewritten
 * plus a metadata read and a formatting batch, roughly 20 API calls per user per
 * minute whether or not a single byte had changed. Google's quota is 60 writes
 * per minute per user, which is why the logs carry "The operation was aborted"
 * and "Internal error encountered".
 *
 * Two gates now: the tracker's own `data_version` counter must have moved, and
 * at least five minutes must have passed.
 */
async function maybeAutoPush(userId) {
  if (pushing.has(userId)) return;
  if (d.getUserSetting(userId, 'sheets_auto', '1') !== '1') return;
  if (!getConfig(userId)) return;

  const version = d.getVersion();
  const lastVersion = Number(d.getUserSetting(userId, 'sheet_version', '-1'));
  const lastAt = Number(d.getUserSetting(userId, 'sheet_pushed_at', '0'));

  if (version === lastVersion) return;                       // nothing changed
  if (Date.now() - lastAt < MIN_AUTO_PUSH_MS) return;        // too soon

  try {
    await pushNow(userId);
    d.setUserSetting(userId, 'sheet_version', String(version));
    d.setUserSetting(userId, 'sheet_pushed_at', String(Date.now()));
  } catch (e) {
    // Back off on failure too, so a broken sheet doesn't retry every minute.
    d.setUserSetting(userId, 'sheet_pushed_at', String(Date.now()));
    d.setUserSetting(userId, 'last_sheet_push', JSON.stringify({ at: d.now(), ok: false, error: e.message }));
    throw e;
  }
}

/** Every user who has connected a sheet — used by the background loop. */
async function autoPushAll() {
  for (const u of d.listUsers()) {
    if (!getConfig(u.id)) continue;
    try {
      await maybeAutoPush(u.id);
    } catch (e) {
      console.error(`[sheets] user ${u.id}:`, e.message);
    }
  }
}

module.exports = { getConfig, pushNow, maybeAutoPush, autoPushAll, includeSecrets, buildAll };
