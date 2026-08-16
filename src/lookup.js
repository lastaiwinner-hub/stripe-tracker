'use strict';

/**
 * lookup.js — helpers that fill fields in for you.
 *
 *   address  -> OpenStreetMap Nominatim (free, no key, no signup)
 *   routing  -> routingnumbers.info, the public ABA directory (US only)
 *
 * Both are proxied through the server rather than called from the page so the
 * browser is not blocked by CORS and so we can send a proper User-Agent, which
 * Nominatim's usage policy requires.
 */

const UA = 'StripeTracker/1.0 (local personal use)';

// Nominatim asks for max 1 request/second. The UI debounces, this enforces it.
let lastAddressCall = 0;
async function throttle(ms) {
  const wait = lastAddressCall + ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAddressCall = Date.now();
}

/**
 * US state names -> the two-letter codes Stripe expects. Nominatim returns the
 * full name ("California"); onboarding forms want "CA".
 */
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU', 'american samoa': 'AS',
  'u.s. virgin islands': 'VI', 'united states virgin islands': 'VI',
  'northern mariana islands': 'MP',
};

function stateCode(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (/^[A-Z]{2}$/.test(n)) return n; // already a code
  return STATE_CODES[n.toLowerCase()] || n;
}

/** ZIP+4 comes back from OSM sometimes; Stripe wants the 5-digit form. */
function zip5(postcode) {
  const m = String(postcode || '').match(/\d{5}/);
  return m ? m[0] : '';
}

/**
 * Free-text address search -> structured suggestions.
 * Restricted to the United States: these are US Stripe accounts, and limiting
 * the search stops "Wilmington" matching a dozen towns worldwide.
 */
async function searchAddress(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  await throttle(1100);

  const url = 'https://nominatim.openstreetmap.org/search'
    + `?q=${encodeURIComponent(expandTrailingState(q))}&format=jsonv2&addressdetails=1&limit=6`
    + '&countrycodes=us';
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`Address lookup failed (HTTP ${res.status})`);
  const rows = await res.json();

  const mapped = (rows || [])
    .filter((r) => String(r.address?.country_code || '').toLowerCase() === 'us')
    .map((r) => {
      const a = r.address || {};
      const line1 = [a.house_number, a.road].filter(Boolean).join(' ')
        || a.building || a.amenity || a.neighbourhood || '';
      const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || '';
      const st = stateCode(a.state || a.province || a.region || '');
      return {
        // shown in the dropdown, trimmed of the ", United States" tail
        label: String(r.display_name || '').replace(/,\s*United States$/, ''),
        line1,
        line2: a.suburb && a.suburb !== city ? a.suburb : '',
        city,
        state: st,
        postal_code: zip5(a.postcode),
        country: 'US',
      };
    });

  // OSM often returns the same place two or three times (different OSM objects).
  const seen = new Set();
  const unique = mapped.filter((r) => {
    const k = [r.line1, r.city, r.state, r.postal_code].join('|').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // If the query named a state, float those matches up. Free-text search
  // otherwise ranks by popularity, which sent "Wilmington DE" to Wilmington NC.
  const wanted = stateFromQuery(q);
  if (!wanted) return unique;
  return unique.sort((a, b) => (b.state === wanted) - (a.state === wanted));
}

/**
 * "Wilmington DE" -> "Wilmington Delaware".
 *
 * OSM's free-text search does not recognise two-letter state codes at all, so
 * "Wilmington DE" was silently answered with Wilmington, North Carolina. Only a
 * trailing token is expanded, since that is where a state goes in an address —
 * this avoids mangling words like IN, OR and ME elsewhere in the line.
 */
function expandTrailingState(q) {
  const text = String(q || '').trim();
  const m = text.match(/^(.*?)[\s,]+([A-Za-z]{2})$/);
  if (!m) return text;
  const code = m[2].toUpperCase();
  const name = Object.keys(STATE_CODES).find((k) => STATE_CODES[k] === code);
  if (!name) return text;
  return `${m[1]}, ${name.replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

/** Pull a state out of the typed text — "… DE" or "… Delaware". */
function stateFromQuery(q) {
  const text = String(q || '').toLowerCase();
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (text.includes(name)) return code;
  }
  const m = String(q || '').match(/(?:^|[\s,])([A-Za-z]{2})(?:[\s,]|$)/g);
  if (m) {
    const codes = new Set(Object.values(STATE_CODES));
    for (let i = m.length - 1; i >= 0; i--) { // prefer a trailing state
      const c = m[i].replace(/[^A-Za-z]/g, '').toUpperCase();
      if (codes.has(c)) return c;
    }
  }
  return '';
}

// --- routing numbers --------------------------------------------------------

/**
 * Bank lookups run against the Federal Reserve's own FedACH directory, cached
 * on disk. Downloaded once (~2.8 MB, 18k banks) and refreshed monthly, so a
 * lookup is instant, works offline, and — the point — a routing number never
 * leaves this machine.
 *
 * Fixed-width record layout (FedACH):
 *   0-8 routing · 35-70 name · 71-106 address · 107-126 city
 *   127-128 state · 129-133 zip · 138-147 phone
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FEDACH_PATH = path.join(DATA_DIR, 'fedach.txt');
const FEDACH_URL = 'https://raw.githubusercontent.com/moov-io/fed/master/data/FedACHdir.txt';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let bankIndex = null;

async function ensureDirectory() {
  let stale = true;
  try {
    stale = Date.now() - fs.statSync(FEDACH_PATH).mtimeMs > MAX_AGE_MS;
  } catch {
    stale = true; // not downloaded yet
  }
  if (!stale) return;

  const res = await fetch(FEDACH_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    if (fs.existsSync(FEDACH_PATH)) return; // keep using the stale copy
    throw new Error(`Could not download the bank directory (HTTP ${res.status}).`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FEDACH_PATH, Buffer.from(await res.arrayBuffer()));
  bankIndex = null; // force a reparse
}

function loadIndex() {
  if (bankIndex) return bankIndex;
  const text = fs.readFileSync(FEDACH_PATH, 'latin1');
  bankIndex = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 129) continue;
    const rn = line.slice(0, 9);
    if (bankIndex.has(rn)) continue; // first record wins
    const phone = line.slice(138, 148).trim();
    bankIndex.set(rn, {
      bank_name: line.slice(35, 71).trim(),
      address: line.slice(71, 107).trim(),
      city: line.slice(107, 127).trim(),
      state: line.slice(127, 129).trim(),
      zip: line.slice(129, 134).trim(),
      phone: phone.length === 10 ? `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` : phone,
      routing_number: rn,
    });
  }
  return bankIndex;
}

/** The ABA check digit — catches typos before we bother searching. */
function validAba(rn) {
  const n = rn.split('').map(Number);
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8]);
  return sum % 10 === 0;
}

async function lookupRouting(rn) {
  const clean = String(rn || '').replace(/\D/g, '');
  if (clean.length !== 9) throw new Error('A US routing number is exactly 9 digits.');
  if (!validAba(clean)) throw new Error('That routing number fails its check digit — likely a typo.');

  await ensureDirectory();
  const hit = loadIndex().get(clean);
  if (!hit) throw new Error('Valid format, but no bank found with that routing number.');
  return hit;
}

module.exports = { searchAddress, lookupRouting };
