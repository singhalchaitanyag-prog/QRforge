# QRForge

A QR code generator that matches your brand logo, tests that every code actually scans, and adds dynamic codes, scan analytics and bulk generation.

## Run it

Requires Node 22.9 or newer. The database driver is `libsql` (SQLite-compatible), installed by `npm install`.

```bash
npm install
npm run dev        # builds the pages, then starts http://localhost:3000 (reads settings from .env if present)
```

Other scripts: `npm run build` (regenerate pages), `npm start` (server only), `npm test`.

## What is included

**Generator (runs in the browser, no account needed)**
- 12 content types: URL, text, email, phone, SMS, Wi-Fi, contact (vCard), location, calendar event, WhatsApp, social profiles, UPI payment. Plus bulk generation from a list or CSV into a ZIP.
- Logo upload with automatic palette extraction, shape and color rules, and a scan test (the finished code is decoded and compared with the input). If an auto-designed code fails, it simplifies itself until it passes.
- 8 templates, frames with call-to-action labels, gradients, dot and corner styles.
- Downloads: PNG, JPG, WebP, SVG (frames included) and PDF at a chosen printed size.
- Print check (dot size, scanning distance), mockups (card, flyer, table tent, sticker, phone), undo/redo, share links, recent codes, brand kits (synced to the account when logged in), dark mode, English and Hindi.

**Server (needed for these features)**
- Accounts, dynamic short links (`/r/<code>`) you can edit later, expiry, scan limits, password protection, pause/resume.
- Hosted landing pages (`/p/<code>`), scan analytics (day, device, browser, OS, country if supplied by your host, referrer), CSV export, per-scan webhooks.
- A REST API with API keys exists on the server (`/api/v1/...`) but is intentionally not documented or linked from the site.

**SEO**: 17 use-case landing pages generated from `scripts/pages.mjs`, JSON-LD, sitemap and robots.txt.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000). |
| `BASE_URL` | Public origin, e.g. `https://qr.example.com`. Used for canonical URLs, the sitemap and short links. Set it for production builds: `BASE_URL=https://qr.example.com npm run build`. |
| `APP_SECRET` | Secret that encrypts two-step secrets and salts visitor hashes. Without Turso, one is generated and kept in `data/app.secret` if unset. **Required with Turso**, and it must never change. |
| `COOKIE_SECURE` | Set to `1` when serving over HTTPS (also implied by an `https://` BASE_URL). |
| `TRUST_PROXY` | Set to `1` only when behind a reverse proxy or CDN that sets `X-Forwarded-For`. |
| `TURSO_DATABASE_URL` | Your Turso database, e.g. `libsql://your-db.turso.io`. When set, Turso becomes the permanent database (see below). |
| `TURSO_AUTH_TOKEN` | Access token for that database. Required with `TURSO_DATABASE_URL`. Treat it like a password. |
| `DB_PATH` | Local database file. Default `data/qrforge.db`; with Turso it defaults to a cache file in the system temp folder. |

## Using Turso (free hosted database)

By default QRForge stores everything in a local SQLite file. Many free hosts erase the disk on every deploy or restart, which would delete accounts. Turso keeps the data in the cloud instead.

How it works: the server keeps a local copy of your Turso database in your system's temp folder (not inside OneDrive or Dropbox, whose file locking breaks it). Reads come from the local copy and are fast. Every write is sent to Turso and then appears in the local copy. Turso is the source of truth, so the local file can be deleted at any time and is rebuilt on the next start.

1. Create a database at turso.tech and copy its URL (it starts with `libsql://`).
2. In the dashboard, create an access token for it.
3. Put both in `.env` (see `.env.example`), along with a long random `APP_SECRET`.
4. Optional, once: copy existing local accounts into Turso with `npm run migrate:turso`. It is safe to repeat, never overwrites rows, and refuses to run against a database that holds different accounts.
5. `npm start`. The log shows `Database: Turso (...)`.

On your host, set the same three variables in its environment settings instead of using a `.env` file.

Things to know:
- Each write waits for a round trip to Turso (roughly 0.3 seconds from India in testing), so writes are slower than with a local file. Reads are not affected. QR scans redirect first and are counted afterwards, so visitors never wait for it. While a write is in flight the server does not answer other requests, so a very busy site would outgrow this setup.
- Run **one** server instance. Several instances would each have their own local copy and would not see each other's writes immediately.
- Check Turso's current free-tier limits (storage and row reads/writes) before depending on it.

## Deploying to qrforge.co.in (Node host + custom domain)

The server must run continuously, so use a host that runs Node (Render, Railway or Fly.io). Pick an always-on plan: free plans sleep when idle, and the first scan after a sleep can take a minute. The database lives in Turso, so the host's disk can be wiped freely.

1. Push this project to a GitHub repository (`.env`, `node_modules` and `data` are git-ignored).
2. Create a new web service from the repository. The settings are in `render.yaml` (Render reads it as a Blueprint). On other hosts use build `npm ci && npm run build` and start `npm start`.
3. Set these environment variables in the host's dashboard. Never commit them:
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (use a token you created for production, not one you ever pasted into chat), `APP_SECRET` (the same value for as long as the database exists)
   - `BASE_URL=https://qrforge.co.in`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`
4. Open `/healthz` on the host's temporary address to confirm it is running, and test a sign-up there.
5. Add `qrforge.co.in` (and `www.qrforge.co.in`) as custom domains in the host. It will show the exact DNS records to create (usually an `A` record or `ALIAS` for the root, and a `CNAME` for `www`).
6. Create those records where the domain's DNS is managed (Hostinger hPanel, Domains, DNS / Nameservers), remove any parking records for the same names, wait for DNS to update (minutes to a few hours), and the host issues the HTTPS certificate automatically.
7. Check `https://qrforge.co.in/`, then submit `https://qrforge.co.in/sitemap.xml` in Google Search Console.

Notes:
- With the local-file database instead of Turso, back up `data/`; with Turso, back up `APP_SECRET`.
- Run one instance. The in-memory rate limiter and the local database copy assume a single server process.
- Without `TRUST_PROXY=1` every visitor appears to come from the host's proxy, which would make the sign-in rate limit apply to everyone at once.

## Sign-in security

- **Two-step verification (TOTP)**: works with Google Authenticator, Microsoft Authenticator, 1Password, Authy and similar apps. After the password is accepted the server issues a 5-minute, single-use ticket and asks for the 6-digit code; no session exists until the code is verified. Codes cannot be replayed, and a ticket is voided after 5 wrong codes. Ten single-use recovery codes are created when it is turned on. The authenticator secret is stored AES-256-GCM encrypted.
- **Password rules**: 10 to 200 characters, and common, sequential, repetitive or personal (contains your name or email) passwords are refused. A strength meter guides users; the server enforces the rules.
- **Lockout and rate limits**: 5 wrong passwords for an email address locks sign-in for that address for 15 minutes (the same response is given for unregistered addresses, so it cannot be used to discover accounts), and each IP address is limited to 15 sign-in attempts a minute.
- **Account hygiene**: changing the password or turning off two-step verification signs out all other devices, sensitive actions re-ask for the password, there is a "sign out other devices" button, and the dashboard shows recent security activity.
- **Sign-up**: asks for name, email, password with confirmation, and agreement to the Terms and Privacy policy; a hidden honeypot field filters simple bots.
- **Cookies**: HttpOnly, SameSite=Lax, and the `__Host-` prefix when served over HTTPS.
- **The app secret** (`APP_SECRET`, or `data/app.secret` which is created automatically) encrypts the two-step secrets. Back it up with the database; if it is lost, users with two-step verification enabled cannot complete sign-in.

## Security notes

- Passwords: scrypt with a per-user salt. Sessions: random tokens, stored hashed, HttpOnly + SameSite=Lax cookies. API keys are stored hashed and shown once.
- Redirect targets must be absolute `http(s)` URLs; `javascript:`/`data:` and URLs with embedded credentials are rejected, as are targets that loop back to the service.
- Webhooks must be `https` and resolve to a public address (checked when saved and again when fired); redirects are not followed.
- CSV exports neutralize spreadsheet formulas. Landing pages escape all user content.
- A strict Content-Security-Policy is sent, and CDN scripts are pinned with Subresource Integrity hashes (`scripts/sri.json`; regenerate with `node scripts/sri.mjs` only when you intentionally change a library version).

## Not included yet

These are real gaps to close before a public launch:
- Email verification and **password reset** (there is no mail sending). Users who lose both their password and their recovery codes cannot get back in.
- Hardware security keys / passkeys, and sign-in with Google or other providers.
- Billing or plan limits (every account gets the same limits; 1000 links each).
- Abuse handling for malicious redirect destinations (for example Safe Browsing checks, reporting form, admin tooling). Dynamic short links are a common phishing vector, so this matters.
- Native Zapier / Google Sheets integrations. Webhooks work with Zapier, Make and n8n "catch hook" triggers today.
- Hindi covers the generator interface only. The use-case page copy and the dashboard are English.
- Privacy and Terms pages describe what this software does but are not legal advice. Have them reviewed for your jurisdiction and add your company details and contact address.

## Layout

```
server/      HTTP server, database schema and Turso support, helpers (no framework)
public/      Static site: css/, js/ (ES modules), images/, generated .html pages
templates/   Page template and docs/legal/dashboard fragments
scripts/     build.mjs (pages + sitemap), pages.mjs (SEO content), sri.mjs
test/        node:test suites (server, content types, theme, PDF writer, bulk)
```
