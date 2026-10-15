<div align="center">
  <h1><picture><source media="(prefers-color-scheme: dark)" srcset="./logo-rounded-dark.png"><img src="./logo-rounded.png" alt="The Mailboxes icon: a white letter M whose middle valley doubles as an envelope flap, on a black tile" width="48" align="absmiddle"></picture>&nbsp;&nbsp;Mailboxes</h1>
  <p><em>Use your own domain for product email, plus an AI assistant that asks before it sends. Runs on Cloudflare's free tiers.</em></p>

  <p>
    <a href="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml/badge.svg"></a>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
    <img alt="Runs on free tiers" src="https://img.shields.io/badge/cost-%240%20on%20free%20tiers-brightgreen">
    <a href="https://github.com/doforu-labs/Mailboxes/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  </p>

  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/doforu-labs/Mailboxes"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

  <img src="./demo_app.png" alt="The Mailboxes UI: the mailbox and its folders on the left, the inbox in the middle, and an opened email in the reading pane" width="880">
</div>

---

> **English** · [简体中文](./README.zh-CN.md)

`support@` and `hello@` should live on the domain you already own. A hosted inbox charges for every seat, and a mailbox on its own still leaves you writing every reply.

Mailboxes is that inbox, with an assistant beside it. It runs in **your Cloudflare account**, on the free tiers — nothing to rent, and nothing to pay Mailboxes. Incoming mail arrives through [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/). Outgoing mail goes out through [Resend](https://resend.com), with SPF, DKIM, and DMARC so it is set up to reach Gmail and Outlook. The assistant can read what came in, search older threads, and draft a reply. **It does not send until you confirm.**

A personal inbox or a small product stays at **$0 a month**. The allowances are in [What it costs](#what-it-costs).

## What you get

Everything here ships in **v0.2.1**. For what is not built yet, see the [roadmap](#roadmap).

- **Addresses on your domain.** `support@`, `hello@`, `sales@`, a catch-all, or several domains from one screen. Each domain has its own addresses, its own forwarding rule, and its own sending key. Add another with **Add Domain** in **Settings**.
- **An inbox you can work in.** Rich-text composer, reply and forward, threads, folders, search, and attachments.
- **An assistant that waits for you.** The side panel reads mail, searches conversations, and drafts replies — 14 tools. The reply streams in, and you can see each tool it calls. Drafts land in that mailbox's Drafts folder. **Sending always needs your confirmation.** Each mailbox can have its own prompt, and the chat is saved.
- **Your own model, if you want one.** The default is Cloudflare's built-in AI (Workers AI — no key). Any mailbox can use an OpenAI-compatible endpoint instead, and falls back to the default if that endpoint is unreachable.
- **Adding a domain can set itself up.** Save a Cloudflare API token and account id, and adding a domain turns on Email Routing and writes the catch-all for you. Save that domain's Resend key, and the app creates the domain on Resend, writes the DNS records, and starts verification. This is fully automatic when the domain's DNS is already on Cloudflare; otherwise the app lists the records for you to add.
- **Mail stays in your Cloudflare account.** Messages live in a database ([D1](https://developers.cloudflare.com/d1/)). Mailbox settings and attachments live in file storage ([R2](https://developers.cloudflare.com/r2/)).
- **A login with no default password.** The first visitor creates the admin account in a setup wizard. The password is stored as a salted hash. Sessions last 7 days, in an HttpOnly cookie.
- **A few looks.** Three extra themes (midnight, porcelain, sakura) besides the default, each in light and dark. See [`app/themes/README.md`](app/themes/README.md).
- **A key for an outside assistant.** Grok Bot, or any other host that speaks MCP or HTTP tools, can read and send with the same 14 tools. See [External access](#external-access).

<div align="center">
  <img src="./demo_domains.png" alt="The Settings page in Mailboxes: Platform Settings shown as configured, and a Domains list holding four domains at once" width="620">
  <p><em>Settings, with four domains on one deployment. Each domain can send its catch-all mail to a different mailbox.</em></p>
</div>

## Compared with agentic-inbox

Cloudflare publishes [agentic-inbox](https://github.com/cloudflare/agentic-inbox), an official inbox-and-assistant app. Mailboxes is for the same job. The rows below are the choices that differ — pick by the one you care about.

| | Mailboxes | agentic-inbox |
| --- | --- | --- |
| Sending on a free plan | [Resend](https://resend.com)'s free tier (100 emails/day). Each domain has its own key, set in the app. | Cloudflare Email Service (the `send_email` binding), which needs a paid Workers plan. |
| Durable Objects | None. One stateless app, plus a database and file storage. | Three: mailbox state, the AI agent, and its MCP server. |
| Sign-in | You create an admin account the first time you open the app. No default password. | [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). You set `POLICY_AUD` and `TEAM_DOMAIN`. |
| Domains | Add several in the app. Each has its own addresses, catch-all, and sending key. | A deploy-time setting (`DOMAINS` in the Worker config), not a screen in the app. |
| License | [AGPL-3.0](LICENSE). If you run a modified version as a service for other people, you must offer them the source. | [Apache-2.0](https://github.com/cloudflare/agentic-inbox/blob/main/LICENSE). |

Two things the table does not mean. Dropping Durable Objects is a simpler shape, **not a lower bill** — the SQLite-backed kind agentic-inbox uses already runs on the free plan. And both products wait for a person before anything is sent. agentic-inbox can draft a reply when mail arrives; Mailboxes drafts when you ask, and automatic replies are still on the [roadmap](#roadmap).

Mailboxes builds on agentic-inbox and includes its code. How the licenses sit together is under [License](#license).

## What it costs

You pay nothing to Mailboxes. The app runs inside your own Cloudflare account, and the free allowances below cover a personal inbox or an early product. Past them, you pay only what Cloudflare and Resend meter. The price does not grow with the number of mailboxes or people.

| Piece | Free allowance | What it's for |
| --- | --- | --- |
| The app ([Workers](https://developers.cloudflare.com/workers/platform/pricing/)) | 100,000 requests/day | The website and API |
| Database ([D1](https://developers.cloudflare.com/d1/platform/pricing/)) | 5M rows read/day · 100K rows written/day · 5 GB | Emails, threads, folders, sessions |
| File storage ([R2](https://developers.cloudflare.com/r2/pricing/)) | 10 GB · 1M Class A + 10M Class B ops/month · **zero egress** | Mailbox settings and attachments |
| The assistant ([Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)) | 10,000 Neurons/day | The default model |
| Receiving ([Email Routing](https://developers.cloudflare.com/email-routing/)) | Included | Incoming mail |
| Sending ([Resend](https://resend.com/pricing)) | 100 emails/day (3,000/month) | Outgoing mail |
| **Total** | **$0 / month** | Personal use and small products |

There is no machine to keep running. Receiving is included with Email Routing (or Resend's inbound webhook, if the domain's DNS is not on Cloudflare). Sending stays on Resend's free tier. The assistant uses the free daily AI allowance unless you connect your own model.

## Before you start

- **Node.js 20 or newer**, and npm (the repository ships a `.nvmrc`, so `nvm use` is enough)
- A Cloudflare account (`npm run setup` runs `wrangler login` when it needs to)
- **A domain.** You can add more later. Buy it anywhere (Namecheap, GoDaddy, Cloudflare Registrar, …), but its DNS has to be managed by Cloudflare: add the domain to your Cloudflare account, then at your registrar switch the nameservers to the two Cloudflare gives you. When you add the domain in the app, it looks the domain up in your account and reports `Zone for "<domain>" not found in Cloudflare` if it isn't there.
- [Email Routing](https://developers.cloudflare.com/email-routing/) for **receiving**
- A [Resend](https://resend.com) account for **sending** (outgoing mail does not use Cloudflare Email Service)
- [Workers AI](https://developers.cloudflare.com/workers-ai/) for the assistant (on by default)

## Quick start

**`npm run setup` is the first deploy.** It creates the file storage and the database (an R2 bucket and a D1 database), writes the database id into the config, builds, deploys, and prints your URL. If the database is the one this run just created (empty), it also creates the tables. It does **not** migrate a database you already had in production (see [Production deploy](#production-deploy)):

```bash
npm install
npm run setup
```

Once those resources exist, everyday redeploys are `npm run deploy` (see [Production deploy](#production-deploy)).

The script is **safe to re-run**. Anything that already exists is skipped. Add `-- --dry-run` to see what it would do first.

> The **Deploy to Cloudflare** button at the top works too, but it only creates the app. The bucket, the database, and the database id are on you. See the note at the end of this section.

1. **Turn on receiving.** In the Cloudflare dashboard, open your domain → **Email Routing**, create a **catch-all** rule (mail to any address on the domain), and forward it to this app. If the domain is *not* on Cloudflare DNS, you can receive through the Resend inbound webhook at `/api/v1/inbound/resend` instead.

   To skip the manual part: finish step 3 (create your admin account), fill in the Cloudflare credentials under **Settings** (`/settings`) — see [Configuration](#configuration) — then add the domain on the home page. The app turns on Email Routing and creates the forwarding rule for you.

2. **Connect Resend for sending** (only if you want to send). Sign up at [resend.com](https://resend.com) and copy an API key. **You do not add the domain on Resend yourself** — the app creates it. **Add Domain** in the app asks for the Resend API key, and you can change it later from the domain menu on the home page. If Resend says the domain "is registered to another team", see the [FAQ](#faq).

3. **Create your admin account.** The first time you open the app you land on `/setup`. Choose a username (default `admin`) and a password. No other page opens until you do. There is no default password, and no token or environment variable to set. The window is one-shot: once the account exists, the wizard and its sign-up endpoint both close, and a later attempt gets a 409.

4. **Create a mailbox.** Once signed in, create a mailbox for any address on your domain (for example `hello@yourdomain.com`).

<details>
<summary>Using the <strong>Deploy to Cloudflare</strong> button instead?</summary>

The button only creates the Worker. The app also needs an R2 bucket and a D1 database. `wrangler.jsonc` in this repository points at resources in the author's account, so deploying straight from the button fails. To make the button work:

1. **Fork** the repository.
2. In your fork, create the resources and point the config at them:
   - `wrangler r2 bucket create mailboxes`
   - `wrangler d1 create mailboxes-db`, then copy the returned `database_id` into the `d1_databases` block of `wrangler.jsonc`
   - `wrangler d1 migrations apply mailboxes-db --remote`
3. Click the button **on your fork** (the button in this README points at this repository and would use the author's `database_id`).

Much less work: run `npm run setup` as above.

</details>

## Configuration

Most of this is filled in by `npm run setup`, or edited in the app after you sign in.

- **`wrangler.jsonc`** — your database id (D1 `database_id`), the file-storage bucket name (R2), and any bindings. `npm run setup` fills in `database_id`.
- **Cloudflare credentials (Platform Settings)** — sign in, open **Settings** (`/settings`) → **Platform Settings**, and enter **Cloudflare API Token** and **Cloudflare Account ID**. **Verify & Save** checks them before saving (the success message names the account and how many domains were found) and the badge turns into `Configured`. Both values are stored in the database.
  - The "Create a pre-configured Token →" link in that panel selects three of the permissions for you. One more has to be added by hand: click Add more, then Zone → Email Routing Rules → Edit, and paste the token back into the field.
  - Once saved, adding a domain turns on Email Routing and creates the forwarding rule — no dashboard clicking. If you skip the credentials, use the manual path in step 1 of [Quick start](#quick-start).
  - The domain has to be in your Cloudflare account already (subdomains find their parent domain automatically). The app looks it up; it never adds it for you.
- **File storage** — the app expects an R2 bucket named `mailboxes`:
  ```bash
  wrangler r2 bucket create mailboxes
  ```
- **Admin account** — created once by the first-run wizard (`/setup`) and stored in the database. There is no credential variable to set. The wizard is open only while the `admins` table is empty, and it closes as soon as the account exists. If two requests race, only one wins and the other gets a 409. To start over, delete the row and reload: `wrangler d1 execute mailboxes-db --remote --command "DELETE FROM admins"`.
- **Password storage** — a salted **PBKDF2-SHA256** hash, 100,000 iterations, in the database. There is no default password. Why hashing fits the free plan, with measurements: [SECURITY.md](SECURITY.md) and [`workers/lib/password.ts`](workers/lib/password.ts).
- **AI provider** — Workers AI by default, with no key. For a custom model, open a mailbox's **Settings → AI Model**, turn the switch on, and enter a base URL, model name, and API key (OpenAI-compatible). If that provider is unreachable, the app falls back to Workers AI.
- **Sending** — the Resend API key is set per domain.

## Local development

> Just want to run it on your machine? Local development uses a local database and local file storage, so you don't need Cloudflare resources yet. Steps 3–5 matter only when you are ready to deploy (`npm run setup` does them for you).

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Configure local environment variables:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Create the database (D1):

   ```bash
   wrangler d1 create mailboxes-db
   ```

4. Copy the returned `database_id` into the `d1_databases` array in `wrangler.jsonc`.

5. Create the file-storage bucket (R2):

   ```bash
   wrangler r2 bucket create mailboxes
   ```

6. Apply database migrations locally:

   ```bash
   npm run db:migrate:local
   ```

7. Start the development server:

   ```bash
   npm run dev
   ```

### Production deploy

**First deploy — `npm run setup`.** It creates anything missing (R2 bucket, D1 database), writes `database_id` back into the config, builds, and deploys. By default it does **not** apply migrations to a production database you already had: it runs a read-only `wrangler d1 migrations list <db> --remote`, and if anything is pending it **stops**, lists the migration filenames, and asks you to re-run with `--migrate`. The exception is a database created by that same run — an empty database has nothing to lose, so it is initialized right away. `bash deploy.sh` is the same as `npm run setup`.

**Everyday redeploy — `npm run deploy`.** It builds and deploys only. It does not touch migrations and does not create resources.

```bash
npm run deploy
```

**Apply migrations to production.** `npm run setup -- --migrate` applies pending remote migrations as part of setup. To apply them on their own:

```bash
npm run db:migrate
```

**Everything in one step.** `npm run deploy:full` builds, deploys, and applies remote migrations:

```bash
npm run deploy:full
```

**Preview a run without writing anything.** `npm run setup -- --dry-run` runs the read-only cloud queries, a deploy rehearsal (`wrangler deploy --dry-run`, which uploads nothing), and a report. It changes nothing.

### Do not run wrangler deploy directly

Run `wrangler deploy` (or `npx wrangler deploy`) by hand and you can publish a stale build with no error and no warning.

**Why.** This project uses `@cloudflare/vite-plugin`. `npm run build` writes `.wrangler/deploy/config.json`, which redirects wrangler to `build/server/wrangler.json` (`main: index.js`, `assets.directory: ../client`, `no_bundle: true`, and no `build` key). A bare `wrangler deploy` follows that redirect and uploads whatever is already in `build/` — it runs **no build at all**. This has already happened once.

**What to run instead:** `npm run deploy` (everyday), `npm run setup` or `bash deploy.sh` (first time, and when creating resources), `npm run deploy:full` (deploy plus migrations).

**There is a guard now.** `npm run build` injects a freshness check into the generated `build/server/wrangler.json` (see [`scripts/deploy-freshness-guard.mjs`](scripts/deploy-freshness-guard.mjs)), so when `build/` is older than the sources a bare `wrangler deploy` fails and tells you what to run (override with `ALLOW_STALE_DEPLOY=1` if you really mean it). `npm run deploy` and `bash deploy.sh` stay the supported entry points.

> Adding a `build.command` to `wrangler.jsonc` does not prevent this. Under the Cloudflare Vite plugin that field is ignored — the plugin deletes `config["build"]` when it generates the config, and the official Custom builds documentation marks it "Not applicable if you're using the Cloudflare Vite plugin".

## External access

An outside agent can **read and send** with a Bearer `agk_…` key — the same **14 tools** as the in-app assistant, without a browser login. A missing or wrong key returns **401**. `X-API-Key` is accepted as well.

With that key the client can:

- **List mailboxes** — `list_mailboxes`. Call this first. Almost every other tool needs the `mailboxId` it returns (the mailbox address).
- **Read and search** — `list_emails`, `get_email`, `search_emails`, `get_thread`.
- **Draft** — `draft_email` and `draft_reply` take a plain `body`. They save a draft and do not send.
- **Send** — `send_email` and `send_reply` take `bodyHtml`. Calling either one delivers real mail. This path has no confirm screen in the app; the caller is the confirmation. The in-app assistant still asks you before it sends.

The rest of the 14 (mark read, move, delete, update a draft, discard a draft) are on the same list. `GET /tools` returns all of them.

**Clients.** Any MCP client, or any caller that uses an HTTP tool list:

- **MCP** — `POST /mcp`, with `initialize`, `tools/list`, `tools/call`, and `ping`. Stateless: no session id, no Durable Object.
- **HTTP tool gateway** — `GET /tools` returns the schemas (OpenAI `functions` shape). `POST /tools/call` runs one, with a body of `{ "name", "arguments" }`.

**Grok Bot**, and similar desktop or agent hosts that speak MCP or HTTP tools, connect this way: point the host at your app and give it the key.

**Create a key.** Sign in and open **Settings** → **Agent API Keys** (`/api/v1/agent-api-keys`, session-cookie authenticated). Keys look like `agk_` followed by 64 hex characters, are stored in the database as a SHA-256 hash, are **shown exactly once** when created, and can be revoked at any time. Every use is recorded.

**Example.** Read the inbox over HTTP. Replace the host and the mailbox address:

```bash
curl -s https://YOUR_APP/tools/call \
  -H "Authorization: Bearer agk_…" \
  -H "Content-Type: application/json" \
  -d '{"name":"list_emails","arguments":{"mailboxId":"hello@yourdomain.com","folder":"inbox"}}'
```

The same read over MCP:

```bash
curl -s https://YOUR_APP/mcp \
  -H "Authorization: Bearer agk_…" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_emails","arguments":{"mailboxId":"hello@yourdomain.com","folder":"inbox"}}}'
```

To send, call `send_email` with `to`, `subject`, `bodyHtml`, and `mailboxId`. `send_reply` also needs the original email's `id`. To draft instead, call `draft_email` or `draft_reply` with a plain `body` (not `bodyHtml`).

Both surfaces use the built-in tool definitions. External calls take the **deterministic path**: draft and send skip the assistant's AI rewrite, so a message goes out exactly as written. Read-only results are **limited to a public field list** — internal ids, raw message headers, and other internal fields are left out.

> This replaced the old per-domain `mb_…` sending keys, which were removed along with `POST /api/v1/send`. There is no send-only HTTP endpoint today. Outside callers use the tool gateway or MCP above.

## FAQ

### Is it really free?

Yes, for personal use and small products. There is nothing to pay Mailboxes itself. The app runs in **your** Cloudflare account, and the free allowances above cover a personal inbox or an early product — see [What it costs](#what-it-costs). There is no per-seat or per-mailbox fee, so a tenth mailbox costs the same as the first.

### Adding a domain fails with "the domain is registered to another team"

When you add a domain, Resend may return:

> Failed to create domain on Resend: The `yourdomain.com` domain is registered to another team. You can claim it using the Domain Claim API.

This error comes from **Resend**, not from Mailboxes. A domain can only be active on **one Resend team at a time**, and `yourdomain.com` was already added (and most likely verified) on a different Resend team — usually an old account, a teammate's personal account, or a throwaway test account.

**Fix it in one of two ways:**

1. **You control the other team** — sign in to that Resend team, open **Domains**, delete the domain, then add it again from Mailboxes. Check the team switcher at the top left.
2. **You don't have access to that team** — claim the domain by proving you own it:
   - **Dashboard:** Domains → **Add Domain** → enter the domain → **Start claim** → add the returned **TXT** record to your DNS (some registrars offer a one-click add) → click **I've added the records**.
   - **API:** `POST https://api.resend.com/domains/claim` with `{ "name": "yourdomain.com" }`, add the returned TXT record, then verify and poll until `status` is `completed`.
   - A successful claim **releases the domain from the previous team and transfers it to yours**. Claims expire after **7 days**.
   - If the claim is `blocked` with a reason such as `recent_owner_activity` or `pending_scheduled_emails`, the other team is still sending from the domain — contact [Resend support](https://resend.com/help) to release it.

Once the domain is released or claimed in Resend, add it again from Mailboxes.

> **Receiving is separate.** This only affects **outgoing** mail through Resend. Incoming mail arrives through **Cloudflare Email Routing** (a catch-all rule to this app), or the Resend inbound webhook for domains that are not on Cloudflare DNS. Keep the domain's MX records pointed at Cloudflare Email Routing. Pointing the root MX at Resend will break incoming mail.

See: [Resend — Claim Domain](https://resend.com/docs/api-reference/domains/claim-domain) · [Domain already registered by another account](https://resend.com/docs/knowledge-base/domain-already-registered)

## Roadmap

**Done ✅** already ships in the current version (v0.2.1) — see [What you get](#what-you-get). **Planned** is not started.

### Done ✅

- ✅ **Guided first deploy** — `npm run setup` creates the R2 bucket and D1 database, writes `database_id`, builds and deploys, and creates the tables when it has just made an empty database. Later migrations stay opt-in (`--migrate`)
- ✅ **Receiving sets itself up** — save a Cloudflare API token and account id in Platform Settings, and adding a domain turns on Email Routing and writes the catch-all (`*@your-domain` → this app). Fully automatic only when DNS is on Cloudflare; other DNS providers get a step-by-step guide
- ✅ **Sending sets itself up** — save a per-domain Resend API key and the app creates the domain on Resend, writes the MX/TXT/CNAME records into your Cloudflare DNS, and starts a verification. Without Cloudflare credentials it lists the records for you to add
- ✅ **Setup wizard with no default password** — salted PBKDF2-SHA256 hash stored in the database
- ✅ **Your own login and sessions** — HttpOnly cookie, 7 days, sessions in the database
- ✅ **Several domains** — each with its own addresses and sending key
- ✅ **Catch-all routing** — point a domain's catch-all at any mailbox
- ✅ **Full email client** — rich-text composer, threads, reply/forward, folders, drafts, search, attachments
- ✅ **Sender display-name parsing** — including RFC 2047 encoded words, with a data migration

### Planned

- [ ] **Auto-replies** — send a reply automatically when mail arrives, with no human confirmation. Today you draft in the side panel and send after confirming.
- [ ] **Shared team mailboxes** — several people on one mailbox, with members and permissions. Today there is a single admin.
- [ ] **More sending providers** — sending currently supports Resend only.
- [ ] **A light contact layer** — there is no contact record today, only people parsed from message headers.

Have an idea? Open an issue.

## Under the hood

The sections above are enough to run it. This one is the map.

### Stack

- **Frontend:** React 19, React Router v7 (SSR), Tailwind CSS v4, Zustand, TipTap, [`@cloudflare/kumo`](https://www.npmjs.com/package/@cloudflare/kumo), TanStack Query
- **Backend:** Hono on Cloudflare Workers, [D1](https://developers.cloudflare.com/d1/) (SQLite) via [Drizzle ORM](https://orm.drizzle.team/), [R2](https://developers.cloudflare.com/r2/), Cloudflare [Email Routing](https://developers.cloudflare.com/email-routing/)
- **Assistant:** Cloudflare [Workers AI](https://developers.cloudflare.com/workers-ai/) by default (or any OpenAI-compatible endpoint), with tool calling and SSE streaming
- **Sending:** the [Resend](https://resend.com) REST API

### How a request moves

```text
  Browser -- React 19 + React Router v7 (SSR shell, client-side data)
      |  same-origin: /api/v1/* (cookie session) + SSE (AI assistant)
      v
  Cloudflare Worker "mailboxes" -- Hono (entry: workers/app.ts)
      |-- /api/v1/*         -> API routes (workers/index.ts)
      |-- POST /mcp         -> external agent gateway (stateless MCP)
      |-- GET /tools        -> external agent gateway (HTTP tool schema)
      |-- POST /tools/call  -> external agent gateway (HTTP tool call)
      |-- all other paths   -> React Router SSR
      |-- email()           -> inbound entry (receiveEmail)
      `-- static assets     -> Workers Static Assets (injected at build)
      |
      |-->  D1 (SQLite / Drizzle) -- mails, attachments, folders, domains,
      |                              sessions, admins, settings, AI chats,
      |                              agent API keys
      |-->  R2 "mailboxes"        -- mailbox config  mailboxes/<id>.json
      |                              attachments  attachments/<email>/<att>/<file>
      |-->  Workers AI            -- default @cf/moonshotai/kimi-k2.6
      |                              falls back to llama-3.3-70b, or any
      |                              OpenAI-compatible endpoint
      `-->  Resend REST API       -- outbound mail  POST /emails

  Inbound takes one of two paths (both write back to D1 and R2):
    A. Cloudflare Email Routing (catch-all rule) -> email() handler
    B. Resend inbound webhook -> POST /api/v1/inbound/resend -> fetch body

  External clients (MCP or HTTP) authenticate with a Bearer `agk_…` API key:
    Bearer agk_… -> POST /mcp | GET /tools | POST /tools/call (tool gateway)
```

The Worker binds nothing else on Cloudflare — no KV, no Queues, no Durable Objects, no Vectorize, and no Cron triggers. The MCP server and the HTTP tool gateway are hand-written and stateless: they authenticate with an API key (a database row), read and write the same database and file storage as the rest of the app, and reuse the same 14 tool definitions. Each mailbox's settings are its own file in R2, and its messages in D1 are keyed by mailbox.

The admin password is a salted PBKDF2-SHA256 hash, 100,000 iterations (workerd's ceiling for PBKDF2), stored in D1 with the parameters alongside the value. An earlier revision kept it in plain text, on the premise that the free plan caps CPU at 10 ms per request and a slow hash would trip Error 1102. Measuring a real free-plan deployment showed the practical ceiling is nearer 2,000 ms, and the hash costs 21–26 ms, so hashing was put back. Details: [SECURITY.md](SECURITY.md).

## Contributing

**Contributions of every kind are welcome** — bug fixes, new features, docs, translations, or a clearer screenshot.

- Found a bug or have an idea? [Open an issue](https://github.com/doforu-labs/Mailboxes/issues).
- Want to change the code? Fork the repo, branch off `main`, and send a pull request. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.
- Keep changes focused (one feature or fix per PR) and make sure the checks pass: `npm run typecheck`, `npm test`, `npm run build`.

No contribution is too small — a typo fix or a clearer sentence is as welcome as a new feature. New here? Issues labelled [`good first issue`](https://github.com/doforu-labs/Mailboxes/labels/good%20first%20issue) are a good place to start.

## Security

Please do not open public issues for security problems — see [SECURITY.md](SECURITY.md).

## License

**AGPL-3.0-only** — the work as a whole, including every addition and modification made in this repository, is distributed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service for others, you must offer them the corresponding complete source code (AGPL section 13).

This work builds on [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) and therefore contains upstream Apache-2.0 code. Upstream portions are Copyright (c) Cloudflare, Inc. and remain under the [Apache License 2.0](LICENSE-APACHE) (full text in that file). Additions and modifications in this repository are Copyright (c) 2026 Doforu and licensed under the AGPL-3.0. Per-file copyright and license notices stay in the file headers. See [NOTICE](NOTICE) for the complete attribution.

## Acknowledgements

Built on [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). Runs on [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), [Workers AI](https://developers.cloudflare.com/workers-ai/), and [Resend](https://resend.com). Cloudflare's blog post [Email for Agents](https://blog.cloudflare.com/email-for-agents/) is the longer story of this kind of inbox. For the product differences, see [Compared with agentic-inbox](#compared-with-agentic-inbox).
