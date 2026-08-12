# Cold Email Sender — built by [@a1wai](https://github.com/a1wai)

A self-hosted cold-outreach console: find leads, write templates, and run paced e-mail campaigns from your own inbox.

Every dependency is open-source or has a permanent free tier. There is nothing to pay for, no account to create with this project, and no server of ours in the loop — you deploy it, you own the data, and mail goes out through your own SMTP account.

```
Next.js 14 (App Router) · Tailwind CSS · nodemailer · axios + cheerio · lucide-react
```

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Getting a Gmail app password](#getting-a-gmail-app-password)
- [Deploying to Vercel](#deploying-to-vercel)
- [Environment variables](#environment-variables)
- [Optional free-tier integrations](#optional-free-tier-integrations)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Responsible use](#responsible-use)
- [Troubleshooting](#troubleshooting)

---

## What it does

Five tabs, in the order you actually use them.

### 1. Lead Finder

Describe your target (industry, city, keywords) and get one-click links into Google, Google Maps, Bing, DuckDuckGo and OpenStreetMap. You review those results and paste the business URLs back in — the app then crawls each site for a contact address.

The crawler reads the homepage plus any obvious `contact` / `about` / `impressum` pages, un-mangles common obfuscations (`hi [at] acme [dot] com`), and ranks what it finds so a named human sorts above `info@`, and `info@` sorts above `noreply@`. Boilerplate from analytics snippets and stock templates is filtered out. Every result is editable inline.

> The app does **not** auto-scrape search-engine result pages. That breaches Google's and Bing's Terms of Service, and the manual review pass is what keeps a list relevant rather than merely large.

### 2. Templates

Unlimited templates with full create/read/update/delete, organised by tags, with a live preview rendered against one of your real leads.

Placeholders are `{{like_this}}`, case-insensitive, and support a fallback after a pipe:

| Placeholder | Resolves to |
|---|---|
| `{{name}}` / `{{first_name}}` | Contact name, or just the first word of it |
| `{{business}}` | Business name |
| `{{website}}` / `{{domain}}` | Full URL / bare domain |
| `{{industry}}` / `{{location}}` | From the Lead Finder form |
| `{{product}}` | What you are offering (set per campaign) |
| `{{reel_link}}` | The portfolio link marked active in Tab 3 |
| `{{sender_name}}` | Your name |
| `{{anything_else}}` | Any custom field on the lead |

`{{name|there}}` renders `there` when the name is unknown. Use fallbacks — a message that opens `Hi ,` is worse than no message. When a placeholder resolves to nothing, the renderer also tidies the leftover punctuation, so `Hi {{name}}, hello` degrades to `Hi, hello` rather than `Hi , hello`.

### 3. Attachments & Links

Drag-and-drop file attachments (3 MB total, capped to stay inside Vercel's request-body limit), plus a library of portfolio/reel links. Mark one link active and `{{reel_link}}` resolves to it everywhere — swapping which reel a campaign points at is one click, not an edit to every template.

Attachments are held in memory only and clear on reload. This is deliberate: base64 file data would blow through the browser's ~5 MB storage quota and evict the leads and templates that actually matter.

### 4. Credentials

Gmail address, sender name, and 16-character app password, with a **Test Connection** button that authenticates without sending, and a **Send test to myself** button that delivers one real message to your own address.

Any SMTP provider works — the advanced panel exposes host, port and encryption, so Zoho, Brevo, Mailgun and Resend all drop in. Same tab holds the compliance footer settings (postal address, unsubscribe URL).

### 5. Campaign

Select recipients, pick a template, set the delay range, and run it. You get pre-flight checks that block the send button until real problems are fixed, a live log, a countdown between sends, per-recipient status in the table, and working pause/resume/stop.

**Dry run is on by default.** It renders every message and exercises the whole pipeline without touching SMTP. Leave it on for the first pass.

---

## Quick start

Requires Node.js 18.17 or newer.

```bash
git clone https://github.com/a1wai/coldmailsender.git
cd coldmailsender
npm install
npm run dev
```

Open <http://localhost:3000>. No `.env` file is needed to start — credentials can be typed into Tab 4, and everything persists in your browser.

To keep secrets off the browser instead, copy `.env.example` to `.env.local` and fill in `SMTP_USER` / `SMTP_PASS`.

---

## Getting a Gmail app password

A normal Google password will always be rejected by SMTP. You need a 16-character app password:

1. Turn on 2-Step Verification at <https://myaccount.google.com/security> (app passwords are unavailable without it).
2. Go to <https://myaccount.google.com/apppasswords>.
3. Create one named anything you like — "Cold Email Sender" is fine.
4. Copy the 16 characters. Google shows them as four groups (`abcd efgh ijkl mnop`); paste them however you like, the app strips spaces.
5. Paste into Tab 4, then hit **Test Connection**.

Revoke it from that same page whenever you want; it grants mail access only and never exposes your real password.

**Limits worth knowing:** free Gmail allows 500 recipients/day, Workspace 2,000. The header tracks your daily count and the queue stops before it exceeds the cap.

---

## Deploying to Vercel

### Via the dashboard

1. **Push to GitHub.** Fork this repository or push your own copy.
2. **Import it.** At <https://vercel.com/new>, pick the repo. Vercel detects Next.js — leave every build setting at its default.
3. **Add environment variables** (all optional — see the table below). At minimum, consider `SMTP_USER` and `SMTP_PASS` so credentials never live in a browser. Add them under *Environment Variables* before the first deploy, or in *Settings → Environment Variables* afterwards.
4. **Deploy.** The build takes a minute or two.
5. **Open your URL** and go to Tab 4 → *Test Connection*.

### Via the CLI

```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production
```

Set variables with `vercel env add SMTP_USER production` (repeat per variable), then redeploy so they take effect.

### Notes specific to Vercel

- **Function timeouts.** Routes declare `maxDuration = 30`, which the Hobby plan permits. Nothing needs a long-running function — see [How it works](#how-it-works).
- **Request body cap.** Roughly 4.5 MB per request, which is why attachments are capped at 3 MB after base64 overhead.
- **Keep the tab open.** The send loop runs in your browser. Closing the tab stops the campaign (you get a confirmation prompt first). For unattended sending, configure QStash.
- **Your deployment is public by default.** Anyone with the URL can load the console. It ships with `noindex`, but if you set server-side `SMTP_*` variables, treat the URL as a secret — anyone who finds it could send mail as you. Add [Vercel Authentication](https://vercel.com/docs/security/deployment-protection) under *Settings → Deployment Protection*, or leave credentials out of the environment and type them in per session.

---

## Environment variables

Every one is optional. Full annotated list in [`.env.example`](.env.example).

| Variable | Purpose |
|---|---|
| `SMTP_USER`, `SMTP_PASS` | Server-side credentials, so the browser never holds your password |
| `SMTP_FROM_NAME`, `SMTP_REPLY_TO` | Display name and an alternate reply address |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Non-Gmail providers (defaults: `smtp.gmail.com`, `465`, `true`) |
| `SENDER_POSTAL_ADDRESS` | Physical address for the footer — legally required for commercial mail |
| `UNSUBSCRIBE_EMAIL`, `UNSUBSCRIBE_URL` | Opt-out targets; also populate the `List-Unsubscribe` header |
| `FIRECRAWL_API_KEY` | Enables the JS-rendering scraper fallback |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_CALLBACK_BASE_URL` | Background queue |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Persist leads and campaign history |
| `SCRAPER_RESPECT_ROBOTS`, `SCRAPER_TIMEOUT_MS`, `SCRAPER_MAX_PAGES`, `SCRAPER_USER_AGENT` | Crawler tuning |

The header shows a green badge for each integration it detects, so you can confirm a variable actually took effect.

---

## Optional free-tier integrations

All three are genuinely optional. The app is fully functional with none of them.

### Firecrawl — deeper scraping

The built-in scraper reads raw HTML, so it cannot see contact details on sites that render entirely client-side (React/Vue SPAs, Framer, some Wix templates). Firecrawl runs a real browser.

Get a free key at <https://firecrawl.dev> (no card required), set `FIRECRAWL_API_KEY`, and the scraper automatically retries its misses through it.

### Upstash QStash — unattended sending

By default the browser drives the send loop, so the tab must stay open. QStash schedules each message as a delayed HTTP callback instead, letting a campaign finish after you close the browser.

Free tier (500 messages/day) at <https://upstash.com>. Set `QSTASH_TOKEN`, both signing keys, and `QSTASH_CALLBACK_BASE_URL` to your public HTTPS deployment URL. Callbacks are signature-verified before anything is sent, so the endpoint cannot be driven by someone who guesses the URL.

### Supabase — persistence across devices

Keeps leads and campaign history in Postgres instead of one browser, and gives you a suppression list of everyone already contacted.

1. Create a free project at <https://supabase.com>.
2. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor.
3. Set the three environment variables.

The schema enables row-level security with no permissive policies, so the public anon key cannot read your leads — writes go through the service-role key, which is only ever read server-side. **Do not** loosen that without understanding the consequence: your anon key ships to every visitor's browser.

---

## How it works

### One e-mail per request

The single most important design decision. A campaign that waits 5–15 seconds between 100 messages runs for roughly 20 minutes — far beyond any serverless function timeout.

So the schedule lives in the browser (`lib/queue.js`) and each send is its own sub-second call to `/api/send-email`. Every invocation finishes in about a second, nothing approaches the limit, and pause/stop take effect immediately. The trade-off is the open tab, which QStash removes if you need it.

### Why the delays matter

Sending is sequential with a randomised gap. Parallel sending is the fastest possible way to get an account rate-limited, and a perfectly regular interval is itself a bot signal. The floor is 3 seconds because Gmail starts throttling below roughly that.

### Deliverability choices baked in

Bodies are plain text converted to minimal HTML, because heavily-designed markup is a well-known spam signal on a first contact. Every message carries a plain-text alternative. The compliance footer adds `List-Unsubscribe` (and `List-Unsubscribe-Post` when you supply an HTTPS endpoint), which Gmail and Outlook both weigh when choosing between inbox and spam.

### Security

- **SSRF protection.** Every scrape target is DNS-resolved and rejected if it points at a loopback, link-local, RFC1918 or CGNAT address. Without this, a public deployment would happily proxy requests to cloud metadata endpoints on an attacker's behalf. Redirect targets are re-checked, not just the original URL.
- **robots.txt** is honoured by default, with longest-match-wins rule precedence.
- **Credentials** default to `sessionStorage` (gone when the tab closes) rather than `localStorage`; "Remember on this device" is an explicit opt-in. They are used for one SMTP connection and never written to a store or a log. Backups deliberately exclude them.
- **Rate limiting** on all three API routes, and QStash signature verification on send callbacks.
- **Lead data is escaped** before being interpolated into HTML, so a business name containing markup cannot inject anything into the message you send.

---

## Project structure

```
app/
  layout.js                  Root layout and metadata
  page.js                    Shell: tabs and all shared state
  globals.css                Tailwind layers and component classes
  api/
    scrape/route.js          Batch crawl → leads
    send-email/route.js      Sends exactly one message
    test-smtp/route.js       POST verifies credentials; GET reports integrations
components/
  Header.jsx                 Branding, daily quota, integration badges, backup
  LeadFinder.jsx             Tab 1
  TemplateManager.jsx        Tab 2
  AttachmentManager.jsx      Tab 3
  SmtpSettings.jsx           Tab 4
  CampaignDashboard.jsx      Tab 5
  LeadTable.jsx              Shared table: selection, inline edit, sort, filter
  ui.jsx                     Shared primitives
lib/
  scraper.js                 Crawler, SSRF guard, robots.txt, extraction  (server)
  mailer.js                  nodemailer wrapper, compliance footer        (server)
  templates.js               Placeholder rendering                        (isomorphic)
  queue.js                   Paced send queue                             (isomorphic)
  storage.js                 Browser persistence, import/export           (client)
  search-urls.js             Directory links and URL parsing              (isomorphic)
  constants.js               Shared limits
  http.js                    JSON envelopes, body guard, rate limiter
  adapters/                  firecrawl.js · qstash.js · supabase.js
supabase/schema.sql          Optional database schema
```

Server-only modules import Node built-ins and must never be imported from a client component — that is why `search-urls.js` and `constants.js` are separate from `scraper.js` and `mailer.js`.

The adapters talk to their services over plain REST rather than pulling in `@supabase/supabase-js` or `@upstash/qstash`, which keeps the dependency list to exactly the eight packages listed at the top.

---

## Responsible use

This tool sends unsolicited commercial e-mail. That is legal in most places when done properly and illegal when it is not, and the difference is mostly down to you.

**The rules that generally apply:**

- **Never hide who you are.** Accurate `From`, accurate subject line, no misleading pretext.
- **Always offer an opt-out, and honour it.** Same day, no exceptions, no "confirm your unsubscribe" friction. Keep the footer enabled.
- **Include a real postal address.** Required by CAN-SPAM (US), CASL (Canada) and equivalents.
- **The EU and UK are stricter.** GDPR and PECR mean B2C cold e-mail generally requires prior consent. B2B to a corporate address is often defensible under legitimate interest, but that is a judgement call about *your* situation, and this README is not legal advice.
- **Some places require opt-in outright.** Canada's CASL and Australia's Spam Act are consent-first regimes with real penalties.

**What this tool does to help:** the compliance footer is on by default and carries your postal address plus an opt-out line; `List-Unsubscribe` headers are set; sends are paced and capped; dry run is the default; and if you connect Supabase you get a suppression list of everyone already contacted.

**What it cannot do:** decide whether your outreach is welcome. Scrape only what is publicly published, respect robots.txt, keep volumes sane, target people your offer genuinely fits, and stop the moment someone asks. A small, relevant, honest list outperforms a big one anyway — and it is the version that does not get your domain blacklisted.

---

## Troubleshooting

**"Username and Password not accepted"**
You are using your Google account password. You need an [app password](#getting-a-gmail-app-password), and 2-Step Verification must be on.

**"Could not reach the SMTP server (ETIMEDOUT)"**
Outbound SMTP is blocked on your network — common on corporate Wi-Fi and some hosting. Try port 587 with STARTTLS instead of 465, or a different network.

**Scraper finds no e-mail on a site that clearly has one**
Usually a JavaScript-rendered page. Add a free Firecrawl key. It can also mean the address is inside an image or a contact form, in which case nothing will extract it — add it by hand.

**"Blocked by robots.txt"**
The site asked crawlers to stay out of that path. Respect it, or visit the page yourself and add the address manually.

**Leads disappeared**
They live in browser storage, so clearing site data or switching browsers loses them. Use the **Backup** button in the header; restore with **Restore**.

**Campaign stopped partway**
The tab was closed or the machine slept. Reopen, select the leads still marked `queued`, and resume — already-sent leads are marked `sent`, so nobody gets a duplicate. Configure QStash to avoid this entirely.

**Gmail daily limit reached**
500/day on free accounts, 2,000 on Workspace, and it resets on a rolling 24-hour basis rather than at midnight. Wait it out, or use an SMTP provider with a higher cap.

---

## Licence

MIT. Use it, fork it, sell what you make with it.

Built by [@a1wai](https://github.com/a1wai).
