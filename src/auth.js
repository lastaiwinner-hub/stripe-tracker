'use strict';

/**
 * auth.js — password gate for the whole app.
 *
 * Needed because this app holds live Stripe keys, passwords, SSNs and bank
 * details, and is about to be reachable from the internet through a Cloudflare
 * tunnel. Nothing gets served without a valid session.
 *
 *   password -> scrypt(N=16384) with a random salt, compared in constant time
 *   session  -> 32 random bytes, stored server-side, sent as an HttpOnly cookie
 *
 * The password is set by the user in the browser on first run; it is never
 * written to disk in plaintext and never leaves the server.
 */

const { randomBytes, scryptSync, timingSafeEqual } = require('crypto');
const d = require('./db');

const COOKIE = 'st_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// --- users & passwords ------------------------------------------------------

/** Configured once the first account (the owner) exists. */
function isConfigured() {
  return d.countUsers() > 0;
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
}

function checkPasswordRules(password) {
  const pw = String(password || '');
  if (pw.length < 8) throw new Error('Password must be at least 8 characters.');
  return pw;
}

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That does not look like an email address.');
  return e;
}

function makeCredentials(password) {
  const pw = checkPasswordRules(password);
  const pw_salt = randomBytes(16).toString('hex');
  return { pw_salt, pw_hash: hashPassword(pw, pw_salt) };
}

/** Create a user. role 'admin' can manage other users. */
function addUser({ email, password, role }) {
  const e = normalizeEmail(email);
  if (d.getUserByEmail(e)) throw new Error('An account with that email already exists.');
  return d.createUser({ email: e, role, ...makeCredentials(password) });
}

/** Replace one user's password and sign their devices out. */
function setUserPassword(userId, password) {
  d.updateUser(userId, makeCredentials(password));
  d.clearUserSessions(userId);
}

function verifyLogin(email, password) {
  const user = d.getUserByEmail(email);
  if (!user || !user.active) return null;
  const expected = Buffer.from(user.pw_hash, 'hex');
  const actual = Buffer.from(hashPassword(String(password || ''), user.pw_salt), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return user;
}

// --- brute-force throttle ---------------------------------------------------

/**
 * Exposed to the internet, so failed logins are rate limited per client IP.
 * In-memory is fine: a restart clearing the counters is not a weakness when
 * the lockout exists to slow down online guessing.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 6;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  // Cloudflare puts the real client IP here; express 'trust proxy' fills req.ip
  return req.headers['cf-connecting-ip'] || req.ip || 'unknown';
}

/**
 * True only for requests that reached the server directly from this machine or
 * the local network — never through the tunnel.
 *
 * Creating the owner account is gated on this. Otherwise, on a fresh install,
 * whoever found the public URL first could claim ownership and walk off with
 * the Stripe keys.
 */
function isLocalRequest(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return false; // came via Cloudflare
  const raw = (req.socket && req.socket.remoteAddress) || '';
  const ip = raw.replace(/^::ffff:/, '');
  return ip === '127.0.0.1'
    || ip === '::1'
    || /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function throttleState(req) {
  const rec = attempts.get(clientIp(req));
  if (!rec) return { locked: false, left: MAX_ATTEMPTS };
  if (Date.now() > rec.until) return { locked: false, left: MAX_ATTEMPTS };
  return { locked: rec.count >= MAX_ATTEMPTS, left: Math.max(0, MAX_ATTEMPTS - rec.count), until: rec.until };
}

function noteFailure(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  if (!rec || Date.now() > rec.until) {
    attempts.set(ip, { count: 1, until: Date.now() + WINDOW_MS });
  } else {
    rec.count++;
    rec.until = Date.now() + WINDOW_MS; // keep extending while they keep trying
  }
}

function clearFailures(req) {
  attempts.delete(clientIp(req));
}

// --- sessions ---------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.secure;
}

function startSession(res, req, userId, label) {
  const token = randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_MS;
  d.createSession(token, userId, expires, label || '');
  const bits = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (isSecure(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
  return token;
}

function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) d.deleteSession(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function sessionFrom(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = d.getSession(token);
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) {
    d.deleteSession(token); // expired, or the account was disabled
    return null;
  }
  return row;
}

const isLoggedIn = (req) => !!sessionFrom(req);
const currentUser = (req) => {
  const s = sessionFrom(req);
  return s ? { id: s.user_id, email: s.email, role: s.role } : null;
};

/** Route guard for the user-management endpoints. */
function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'Only the owner can manage accounts.' });
  next();
}

// --- middleware -------------------------------------------------------------

// Served without a session so the login screen can render.
const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/styles.css', '/favicon.ico']);
const PUBLIC_API = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup']);

function gate(req, res, next) {
  if (PUBLIC_API.has(req.path) || PUBLIC_PATHS.has(req.path)) return next();
  if (isLoggedIn(req)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  return res.redirect('/login.html');
}

module.exports = {
  COOKIE,
  isConfigured, addUser, setUserPassword, verifyLogin,
  normalizeEmail, checkPasswordRules, isLocalRequest,
  startSession, endSession, isLoggedIn, sessionFrom, currentUser, requireAdmin,
  throttleState, noteFailure, clearFailures, clientIp,
  gate,
};
