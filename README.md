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
| `BASE_URL` | Public origin, e.g. `https://qr.example.com`. Used for canonical URLs, the sitemap and short links. If unset, the build uses the value in `wrangler.jsonc`. |
| `APP_SECRET` | Secret that encrypts two-step secrets and salts visitor hashes. Without Turso, one is generated and kept in `data/app.secret` if unset. **Required with Turso**, and it must never change. |
| `COOKIE_SECURE` | Set to `1` when serving over HTTPS (also implied by an `https://` BASE_URL). |
| `TRUST_PROXY` | Set to `1` only when behind a reverse proxy or CDN that sets `X-Forwarded-For`. |
| `TURSO_DATABASE_URL` | Your Turso database, e.g. `libsql://your-db.turso.io`. When set, Turso becomes the permanent database (see below). |
| `TURSO_AUTH_TOKEN` | Access token for that database. Required with `TURSO_DATABASE_URL`. Treat it like a password. |
| `AUTH_LIMIT_PER_MINUTE` | Sign-in attempts allowed per visitor address per minute (default 15). |
| `PBKDF2_ITERATIONS` | Password hashing cost (default 100000). Existing hashes keep working and are upgraded when changed. |
| `DB_PATH` | Local database file (used only when Turso is not configured). Default `data/qrforge.db`. |

## Using Turso (free hosted database)

By default QRForge stores everything in a local SQLite file. Many hosts erase their disk on every deploy or restart, which would delete accounts. Turso keeps the data in the cloud instead, and both the Node server and the Cloudflare Worker talk to it directly over HTTPS.

1. Create a database at turso.tech and copy its URL (it starts with `libsql://`).
2. In the dashboard, create an access token for it.
3. Put both in `.env` (see `.env.example`), along with a long random `APP_SECRET`.
4. `npm run db:init` creates the tables. (`npm start` also does this on every start.)
5. Optional, once: copy existing local accounts into Turso with `npm run migrate:turso`. It is safe to repeat, never overwrites rows, and refuses to run against a database that holds different accounts.
6. `npm start`. The log shows `Database: Turso (...)`.

Things to know:
- Every database call is a round trip to Turso, so expect roughly 50 to 500 ms for API calls. QR scans redirect immediately and are counted just afterwards.
- Check Turso's current free-tier limits (storage and row reads/writes) before depending on it.
- Turso's "embedded replica" mode (a local copy that syncs) is deliberately not used: it does not guarantee that a write is visible to the very next read, which would weaken replay protection for two-step codes.

## Deploying to Cloudflare (qrforge.co.in)

QRForge runs on Cloudflare Workers. The pages are served from Cloudflare's network, the dynamic routes (`/api`, `/r`, `/p`) run in a Worker, and the data lives in Turso. There is no server to keep running and nothing sleeps.

How the code is organised:
- `server/core.js` is the application. It speaks web `Request`/`Response` and an async database facade, so it runs anywhere.
- `server/app.js` wraps it for Node (local development, the tests, any Node host). `worker/index.js` wraps it for Cloudflare.
- `wrangler.jsonc` configures the Worker. The production domain is written once, in its `BASE_URL` variable, and the build reads it from there.

One-time setup:
1. `npm install`, then put `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `APP_SECRET` in `.env`.
2. `npm run db:init` creates the tables in Turso. The Worker never creates tables, so run this again after any update that changes the schema.
3. `npx wrangler login` signs the command line in to your Cloudflare account.
4. Add the two secrets to the Worker (they are stored encrypted and never appear in the repository):
   `npx wrangler secret put TURSO_AUTH_TOKEN` and `npx wrangler secret put APP_SECRET`
5. `npm run cf:deploy` builds the pages and deploys. The site is then live on a free `qrforge.<your-subdomain>.workers.dev` address.

Test locally in Cloudflare's runtime with `npm run cf:dev` (it reads `.dev.vars`, a git-ignored copy of the secrets). `npm run e2e -- http://localhost:8787` runs about 50 end-to-end checks against any running copy, including the live site.

Using your own domain:
1. Add the domain to Cloudflare ("Add a site"). Cloudflare gives you two nameservers.
2. At your registrar (Hostinger: Domains, DNS / Nameservers), replace the current nameservers with those two. Propagation takes minutes to hours.
3. In `wrangler.jsonc`, uncomment the `routes` block (apex plus `www`), then `npm run cf:deploy`. HTTPS certificates are issued automatically, and `www` redirects to the bare domain.

Automatic deploys: in the Cloudflare dashboard (Workers and Pages, your Worker, Settings, Builds) connect the GitHub repository, build command `npm run build`, deploy command `npx wrangler deploy`. Each push to `main` then deploys itself.

Things to know:
- **CPU limit on the free plan.** Workers Free allows about 10 ms of CPU per request. Hashing a password is deliberately expensive, so sign-up and login may exceed that on the free plan, while redirects and page views are cheap. If sign-up fails with a CPU-limit error, either use Workers Paid (about $5 a month) or lower `PBKDF2_ITERATIONS` in `wrangler.jsonc` (weaker password protection, so prefer upgrading). Two-step login is strongly recommended either way.
- **Data and limits.** Every database call is a round trip to Turso, so API calls take roughly 50 to 500 ms. QR scans redirect immediately and are counted just afterwards. Check the current free limits of both Cloudflare and Turso.
- **PNG images from the API.** The `/api/v1/qr` endpoint returns SVG on Cloudflare (PNG needs Node-only libraries). The generator itself is unaffected.
- **Country analytics** work automatically, because Cloudflare supplies the visitor's country.
- **Rate limits and lockouts** are stored in the database, so they hold across servers and restarts.
- No proxy settings are needed on Cloudflare: the Worker reads Cloudflare's own `CF-Connecting-IP` header, which visitors cannot forge.

Running on an ordinary Node host instead still works: set the variables listed under Configuration, build with `npm run build`, start with `npm start`, and run a single instance.

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
