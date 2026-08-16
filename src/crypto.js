'use strict';

/**
 * crypto.js — AES-256-GCM for the credential fields.
 *
 * The key lives in data/secret.key (0600 where the OS honours it), generated on
 * first run. This protects the database file itself: copying stripe.db off the
 * machine, a stray backup, or a sync client picking it up all yield ciphertext.
 *
 * It is NOT protection against someone who already has read access to this
 * folder — the key sits next to the data by design, so the app can poll and
 * alert unattended without a human typing a master password. Account Vault is
 * the place for credentials that need that stronger guarantee.
 */

const path = require('path');
const fs = require('fs');
const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_PATH = path.join(DATA_DIR, 'secret.key');

let key = null;

function getKey() {
  if (key) return key;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_PATH)) {
    key = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('data/secret.key is corrupt — expected 32 bytes.');
  } else {
    key = randomBytes(32);
    fs.writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
    console.log('[crypto] generated data/secret.key — back it up with the database.');
  }
  return key;
}

/** '' / null round-trip as null so empty fields stay empty. */
function encrypt(plain) {
  const s = plain === undefined || plain === null ? '' : String(plain);
  if (s === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return ''; // wrong key or tampered blob — never throw into a request
  }
}

module.exports = { encrypt, decrypt, KEY_PATH };
