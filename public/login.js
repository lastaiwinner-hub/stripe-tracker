'use strict';

/* Login / first-run password setup. Kept separate from app.js so the gate can
   serve this page without a session. */

const $ = (s) => document.querySelector(s);

let firstRun = false;

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function say(text, bad = true) {
  const el = $('#msg');
  el.textContent = text;
  el.className = 'login-msg ' + (bad ? 'bad' : 'good');
}

(async () => {
  try {
    const s = await api('GET', '/auth/status');
    if (s.signed_in) { location.href = '/'; return; }

    firstRun = !s.configured;
    if (firstRun && !s.can_setup) {
      // reached over the tunnel before an owner exists — refuse politely
      $('#mode-note').innerHTML =
        '<b>Not set up yet.</b><br>The owner account has to be created on the computer running the app. Open it there first, then come back and sign in.';
      $('#form').hidden = true;
      return;
    }
    if (firstRun) {
      $('#mode-note').innerHTML =
        '<b>Create the owner account.</b><br>This is the only thing standing between the internet and your Stripe keys — make the password long and unique. You can add more people afterwards from Settings.';
      $('#pw-label').textContent = 'New password (min 8 characters)';
      $('#pw').autocomplete = 'new-password';
      $('#confirm-row').hidden = false;
      $('#go').textContent = 'Create owner account';
    } else {
      $('#mode-note').textContent = 'Sign in to continue.';
      if (s.locked) say('Too many failed attempts — try again later.');
    }
  } catch (e) {
    say(e.message);
  }
  $('#email').focus();
})();

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#pw').value;
  const email = $('#email').value.trim();
  const btn = $('#go');

  if (firstRun) {
    if (pw.length < 8) { say('At least 8 characters, please.'); return; }
    if (pw !== $('#pw2').value) { say('The two passwords do not match.'); return; }
  }

  btn.disabled = true;
  say(firstRun ? 'Creating…' : 'Checking…', false);
  try {
    await api('POST', firstRun ? '/auth/setup' : '/auth/login', { email, password: pw });
    location.href = '/';
  } catch (err) {
    btn.disabled = false;
    say(err.message);
    $('#pw').value = '';
    $('#pw').focus();
  }
});
