'use strict';

/* Login and first-run owner setup. Kept separate from app.js so the gate can
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

function note(html) {
  const el = $('#mode-note');
  el.innerHTML = html;
  el.hidden = false;
}

/** A rough strength read, so a weak owner password gets pushed back on. */
function strength(pw) {
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^\w\s]/.test(pw)) score++;
  return score;
}

(async () => {
  try {
    const s = await api('GET', '/auth/status');
    if (s.signed_in) { location.href = '/'; return; }

    firstRun = !s.configured;

    if (firstRun && !s.can_setup) {
      // Reached through a tunnel before an owner exists — refuse politely.
      note('<b>Not set up yet.</b><br>The owner account has to be created on the computer running the app. '
        + 'Open it there first, then come back and sign in.');
      $('#form').hidden = true;
      return;
    }

    if (firstRun) {
      note('<b>Create the owner account.</b><br>This password is the only thing between the internet and your '
        + 'live Stripe keys — make it long and unique. You can add other people afterwards from Settings.');
      $('#pw-label').textContent = 'New password (at least 8 characters)';
      $('#pw').autocomplete = 'new-password';
      $('#confirm-row').hidden = false;
      $('#go').textContent = 'Create owner account';
      $('#pw').addEventListener('input', () => {
        const pw = $('#pw').value;
        if (!pw) { say('', false); return; }
        const s2 = strength(pw);
        say(pw.length < 8 ? 'At least 8 characters.'
          : s2 <= 1 ? 'That is weak — longer, or add a symbol.'
            : s2 <= 3 ? 'Reasonable.' : 'Strong.', pw.length < 8 || s2 <= 1);
      });
    } else if (s.locked) {
      say('Too many failed attempts — try again in a few minutes.');
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
