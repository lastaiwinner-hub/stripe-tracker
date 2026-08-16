# Stripe Tracker

Keep many Stripe accounts organized, watch them live through the Stripe API, and get a
Telegram message the moment something needs your attention.

Standalone app — separate from Account Vault and Whop Structure.

## Run

The app is installed as a **Windows service** (`StripeTracker`) — it starts at boot before anyone logs in, keeps running when you log off, and restarts itself within seconds if it ever crashes. `cloudflared` runs as a service too, so the tunnel comes back with it.

Nothing to launch: just open http://localhost:4700

Managing it (elevated PowerShell):

```powershell
Get-Service StripeTracker        # is it running
Restart-Service StripeTracker    # after changing code
Stop-Service StripeTracker       # take it offline
```

Output goes to `data/service.log` (rotated at 1 MB). `Start Stripe Tracker.bat` still works for a manual foreground run, but stop the service first or port 4700 will be taken.

## What it does

- **Accounts tab** — a tree, like Whop Structure: each group/brand is a node with its Stripe accounts branching below on connector lines. **Cards move freely** — drag one anywhere inside its box and it stays there (positions are saved); drag it onto another group's box to reassign it. The box grows to fit wherever you put things. Each card shows live health, available/pending balance, today's sales count and volume, plus two pills — the API key and the login credentials. A summary strip up top totals everything and counts accounts needing attention.
- **Alerts tab** — every event the tracker noticed, newest first.
- **Settings tab** — Telegram setup, which events to be alerted about, and how often to check.

## Credentials & business info

Click the 🔒 or 🏢 pill on any account card to open its details panel. Six tabs:

| Tab | Holds |
|---|---|
| 🔒 **Login** | login email, password, 2FA secret, backup codes, phone, dashboard URL, notes |
| 🏢 **Business** | legal name, DBA/trading name, business type, industry/MCC, website submitted, product description, statement descriptor, support email/phone, tax ID/EIN, VAT, company registration number, incorporation date |
| 📍 **Business address** | line 1/2, city, state, postal code, country, business phone |
| 👤 **Representative** | full legal name, title, email, phone, date of birth, SSN/ID number, home address, ID documents submitted |
| 🏦 **Payout / bank** | bank name, account holder, account number, routing/sort code, IBAN, SWIFT/BIC, payout schedule, notes |
| ➕ **Custom** | any extra field you name yourself — proxy used, onboarding date, whatever |

Each secret field has a show/hide eye and a copy button.

### Auto-fill

- **Address (US only)** — the Address tab has a search box: type an address, pick a match, and line 1, city, state, postal code and country fill themselves. Powered by OpenStreetMap Nominatim (free, no key). The text you type is sent to OpenStreetMap to be searched; everything else stays local.

  Tuned for US Stripe onboarding: results are restricted to the United States, the state comes back as a two-letter code (`DE`, not `Delaware`), ZIP is trimmed to 5 digits, country is always `US`, and duplicate matches are collapsed. A trailing two-letter state is expanded before searching — OSM does not understand `DE`, so "Wilmington DE" used to silently return Wilmington, **North Carolina**.
- **Bank name** — type a 9-digit US routing number in the Bank tab and the bank name fills in automatically, the way Stripe does it. It checks the ABA check digit first so typos are caught before searching, and won't overwrite a bank name you already typed.

  Bank lookups run against the Federal Reserve's own **FedACH directory**, cached at `data/fedach.txt` (~2.8 MB, ~18,000 banks, refreshed monthly). Downloaded once, then lookups are instant, work offline, and **routing numbers never leave your machine**. US routing numbers only — IBAN/SWIFT are not covered. Cards show the legal name and website at a glance, plus a count of how many business fields are filled.

- Everything above is **encrypted with AES-256-GCM** before it touches the database — including tax IDs, SSN/ID numbers, bank details and custom fields.
- The browser never receives it in bulk — `/api/state` only reports *whether* fields are filled, plus the legal name and website used for display. Values are decrypted solely when you open the panel.
- The key lives in `data/secret.key`, generated on first use. **Back it up together with the database** — without it the encrypted fields cannot be recovered.
- Because the key sits next to the data, this protects the database *file* (a stray copy, a backup, a sync client) — not someone who already has access to this PC. For credentials needing that stronger guarantee, use Account Vault, which locks everything behind a master password.

## What triggers an alert

The tracker reads Stripe's **Events API** (`/v1/events`), so it sees everything the account records — not just successful payments.

| Alert | Fires on |
|---|---|
| 💰 Sales | `charge.succeeded` |
| ⚡ High-risk sales | a payment Stripe **allowed** but rated `elevated`/`highest` risk — review before fulfilling |
| 🔔 **Pre-dispute inquiry** | a dispute object with `warning_*` status — the bank asking questions **before** any chargeback. Includes the charge and a refund link |
| ❌ Declined / blocked | `charge.failed`, `payment_intent.payment_failed` — includes the decline code, the bank's message, and flags **⛔ Blocked by Stripe Radar** with the risk level |
| 🔍 Under review | `review.opened` / `review.closed` — payments held for manual review |
| 🚩 Fraud warnings | `radar.early_fraud_warning.created` — the bank reported fraud **before** filing a chargeback. Includes the charge, customer, and a one-click refund link |
| ⚠️ Disputes | opened, updated, closed, funds withdrawn/reinstated, with the evidence deadline |
| ↩️ Refunds | `charge.refunded` |
| 🏦 Payouts | paid, **failed** (with the bank's reason), canceled |
| 🛑 Paused | payments or payouts being switched off — and again when they resume |
| 🩺 Account problems | documents required, restricted, suspended |
| 🔌 Connection errors | the API key stopped working |

### Catching chargebacks early

Nothing can see a chargeback *before* Stripe does — it starts at the cardholder's bank and Stripe learns about it when the card network says so. What the tracker does instead is surface the two warnings that genuinely arrive **ahead** of the chargeback:

1. **🚩 Early fraud warning** — the issuing bank reports the card as fraudulent, typically days before a dispute is filed. Refunding in this window normally stops the chargeback entirely.
2. **🔔 Pre-dispute inquiry** — the bank requests information first (`warning_*` dispute status). Not yet a chargeback, and refunding usually prevents escalation.

Both alerts look up the charge and tell you exactly what to do: amount, customer, whether it's already refunded/disputed, and a direct dashboard link to refund. **⚡ High-risk sales** give an even earlier (predictive, not certain) signal at the moment of payment.

Each type can be muted individually in Settings. **Verbose** mode additionally alerts on every other Stripe event type (`invoice.*`, `customer.*`, and so on) — off by default because it is noisy.

Default check interval is **60s**, adjustable down to 20s. Events are deduplicated by Stripe's own event ID, so nothing is ever reported twice.

## Health states

| State | Meaning |
|---|---|
| `healthy` | charges and payouts both enabled, nothing owed |
| `docs needed` | Stripe wants documents/info (`currently_due` or `past_due`) |
| `restricted` | charges or payouts switched off |
| `suspended` | account rejected/terminated by Stripe |
| `pending` | documents submitted, Stripe still verifying |
| `error` | the API key stopped working |

## Per-account isolation

Every user account is a separate workspace. Yours holds your Stripe accounts, groups, credentials, business/KYC info, custom fields, alert history and card positions — plus **your own Google Sheet and your own Telegram bot**. Another user signing in sees an empty app and connects their own of everything. Nothing crosses between users, in either direction (owners cannot see members' data either).

The only genuinely shared setting is **how often the server checks Stripe** (`poll_seconds`), since that is one background loop for the whole machine.

## Telegram setup (2 min)

1. In Telegram open [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name.
2. Paste the token it gives you into Settings → **Save token**.
3. Open your bot's chat and press **Start**.
4. Hit **Detect chat**, then **Send test**.

## Stripe key setup (per account)

Logged into each Stripe account:

1. [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
2. Under **Standard keys**, reveal and copy the **Secret key** (`sk_live_…`).
3. In the Accounts tab, click the 🔑 pill on that account's card and paste it — the app verifies it with Stripe immediately.

The tracker only ever **reads** from Stripe (account, balance, charges, disputes, refunds, payouts) — it never creates charges, refunds or payouts. Restricted keys (`rk_…`) with Read on those six resources work identically if you ever prefer one.

## Google Sheet

Settings → **Google Sheet** pushes the whole tracker into a spreadsheet, rewritten after every check (or on demand with **Update sheet now**).

Tabs written — one per credential category, so each stays narrow and readable:

| Tab | Contents |
|---|---|
| `Overview` | every account: group, Stripe ID, health, charges/payouts enabled, requirements, balances, sales & volume today, last checked, errors |
| `Login & keys` | login email, password, 2FA secret, backup codes, login phone, dashboard URL, Stripe secret key, publishable key, notes |
| `Business` | legal name, DBA, type, industry, website, product description, statement descriptor, support contacts, incorporation date, tax ID, VAT, registration number |
| `Address` | address lines, city, state, postal code, country, business phone |
| `Representative` | full legal name, title, email, phone, DOB, SSN/ID, home address, documents submitted |
| `Bank` | bank name, account holder, account number, routing/sort code, IBAN, SWIFT, payout schedule, notes |
| `Custom fields` | one row per custom field, so any number of them fits |
| `Groups` | each group with account count and total available |

Every tab starts with `Account` and `Group` so rows line up across tabs. Headers are bold on a purple band, the top row and account column are frozen, and columns auto-size on each push.

Untick **Include the Secrets tab** in Settings to drop the sensitive columns (passwords, 2FA, API key, tax ID, SSN, bank numbers) — the tabs remain, minus those columns.

**One-way by design.** Health, balances and sales come from Stripe, so an edit in the sheet would be meaningless or overwritten on the next check. Edit in the app; the sheet is the organized mirror.

⚠️ **The `Secrets` tab is plain text on Google's servers.** It undoes the local encryption for those fields. Keep the sheet private — never "anyone with the link" — and share it only with your own Google account. Untick **Include the Secrets tab** to drop it (the tab is not written at all, though you must delete an already-written one yourself).

Setup is the same service-account flow as the sync in Whop Structure — if you already made one there, reuse that JSON.

## Remote access (other laptop, away from the PC)

The app is password-protected: nothing — not even the page itself — is served without a session. Everything else 302s to the login screen or returns 401.

- First run asks for an **email and password** — that becomes the owner account. Passwords are stored as scrypt hashes with random salts, never in plaintext.
- Sessions are random 32-byte tokens in an HttpOnly cookie, valid 30 days, marked `Secure` automatically when behind HTTPS.
- **6 wrong attempts locks that IP out for 15 minutes** (uses Cloudflare's `CF-Connecting-IP` for the real client address). Login errors never reveal whether an email exists.
- Change your own password in Settings → **Your password**.

### Accounts and roles

Settings → **People with access** (owner only):

- **Add someone** with an email, a password you choose for them, and a role. Give them the link and those details.
- **owner** — full access plus user management. **member** — full access to the app, cannot manage users.
- **disable** revokes access instantly (their live sessions die immediately) while keeping the account. **reset pw** sets a new password and signs them out everywhere. **✕** removes them entirely.
- Guard rails: you cannot disable, delete, or demote yourself, and the last remaining owner cannot be removed or demoted.

⚠️ Everyone you add can see **everything** — Stripe keys, passwords, SSNs, bank details. There is no per-field permission.

### Exposing it with a Cloudflare tunnel

cloudflared is already installed (`winget install --id Cloudflare.cloudflared` if you ever need it again).

**Quick tunnel — no account, no domain.** Run **`Start Remote Access.bat`**. It starts the app and the tunnel together and prints a link like `https://random-words.trycloudflare.com`. Open that on the other laptop and sign in. The URL changes on every restart.

**Permanent URL — needs a free Cloudflare account plus a domain added to it.** Run these once, in PowerShell:

```powershell
cd "C:\Program Files (x86)\cloudflared"
.\cloudflared.exe tunnel login
.\cloudflared.exe tunnel create stripe-tracker
.\cloudflared.exe tunnel route dns stripe-tracker stripe.YOURDOMAIN.com
```

`tunnel login` opens a browser to pick the domain. Then create `C:\Users\<you>\.cloudflared\config.yml`:

```yaml
tunnel: stripe-tracker
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: stripe.YOURDOMAIN.com
    service: http://localhost:4700
  - service: http_status:404
```

Run it as a Windows service so it survives reboots:

```powershell
.\cloudflared.exe service install
```

From then on `https://stripe.YOURDOMAIN.com` always points at the app.

**What a Cloudflare account does and does not do:** it gives you a stable URL. It does **not** keep the app online — the tunnel dials out from this PC, so if the machine sleeps or the app stops, the site is down and Telegram alerts stop too. Genuine 24/7 needs an always-on host.

### Safety notes for public exposure

- **The owner account can only be created locally.** Setup is refused for any request arriving through Cloudflare, so a stranger who finds the URL on a fresh install cannot claim ownership.
- Anyone with the link reaches only the login screen. Verified: root → 302 to login, `/api/*` → 401, no data in any response.
- Don't post the link anywhere. Your password is what stands between it and live Stripe keys.

## Notes

- **Keys never reach the browser.** They live in `data/stripe.db` on your PC; the page only receives a masked hint like `restricted · live · …4f2a`.
- `data/` is gitignored — the database and `secret.key` never end up in a repo.
- **Checks, not webhooks.** The app runs on localhost, so Stripe can't push to it without a public address. It asks Stripe every 120s (configurable, 30–3600s) what changed. Each charge/dispute/refund/payout is keyed by its Stripe id, so nothing is ever alerted twice.
- On the first check of a new account the app only looks one hour back, so connecting an old account doesn't flood you with history.
- Keep the app running for alerts to flow.
- Port 4700; listens on 0.0.0.0 so it also works from your phone on the same Wi-Fi.
