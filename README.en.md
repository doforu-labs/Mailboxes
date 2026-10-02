<div align="center">
  <h1><img src="./logo-rounded.png" alt="The Mailboxes icon: a white cat face that doubles as an envelope, on pink" width="48" align="absmiddle">&nbsp;&nbsp;Mailboxes</h1>
  <p><em>Send and receive email from your own domain — a completely free, self-hosted email client running entirely on Cloudflare, with a built-in AI agent.</em></p>

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

> **English** · [简体中文](./README.md)

**Mailboxes is free to run.** There are no servers to rent and no per-seat fees — the whole thing lives inside your own Cloudflare account and the Resend free tier. For a personal inbox or a small product, your monthly bill is **$0**.

## Why Mailboxes

Give your product a real inbox on your own domain — `support@`, `hello@`, `sales@` — for **sending, receiving, and auto-replying**, without paying per mailbox per month.

Built for developers shipping products to a global audience:

- **Free by design** — runs within Cloudflare's and Resend's free tiers. No always-on server, no per-user pricing, no credit card to start. → [What it costs](#what-it-costs)
- **Your domain, your data** — mail is stored in your own Cloudflare account: messages in a [D1](https://developers.cloudflare.com/d1/) (SQLite) database, mailbox configuration and attachments in [R2](https://developers.cloudflare.com/r2/). Nothing leaves your account.
- **Deliverability that lands** — outbound mail goes through [Resend](https://resend.com) with proper SPF/DKIM/DMARC, so it reaches Gmail and Outlook instead of spam.
- **Multi-domain, multi-mailbox** — run several domains and as many mailboxes as you like (e.g. a catch-all) from one dashboard.
- **AI inbox agent** — a side panel with **14 tools** that reads incoming mail, searches your conversations, and drafts replies — always requiring your explicit confirmation before sending.
- **Bring your own model** — defaults to Cloudflare Workers AI (no key needed) and can be pointed at any OpenAI-compatible endpoint per mailbox.
- **Global at the edge** — Cloudflare's network serves it from wherever your users are, with no region to pick and nothing to keep online at 3 a.m.

## What it costs

| Component | Free tier | Used for |
| --- | --- | --- |
| Cloudflare [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | 100,000 requests/day | The web app + API |
| Cloudflare [D1](https://developers.cloudflare.com/d1/platform/pricing/) | 5M rows read/day · 100K rows written/day · 5 GB storage | Emails, threads, folders, sessions |
| Cloudflare [R2](https://developers.cloudflare.com/r2/pricing/) | 10 GB storage · 1M Class A + 10M Class B ops / month · **zero egress** | Mailbox config + attachments |
| Cloudflare [Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | 10,000 Neurons/day | The inbox agent (default provider) |
| Cloudflare [Email Routing](https://developers.cloudflare.com/email-routing/) | Included (free) | Receiving mail |
| [Resend](https://resend.com/pricing) | 100 emails/day (3,000/month) | Sending mail |
| **Total** | **$0 / month** | Personal use and small products |

Beyond the free tiers you pay only for what Cloudflare and Resend actually meter — nothing is tied to the number of mailboxes or users.

## Features

- **Login-protected** — the first visitor to a fresh deployment creates the admin account through a setup wizard, and the password is stored in D1 as a salted PBKDF2-SHA256 hash. There is no default password. Sessions last 7 days via an HttpOnly cookie (stored in D1).
- **Full email client** — send and receive via Cloudflare Email Routing, with a rich-text composer, reply/forward threading, folders, search, and attachments.
- **Multiple domains** — one deployment can run several domains at once, each with its own mailbox addresses, its own forwarding rule, and its own sending key. Adding another is just **Add Domain** in **Settings**.
- **Per-mailbox isolation** — each mailbox's configuration is an R2 object and its messages live in D1, keyed by mailbox.
- **Built-in AI agent** — a side panel with 14 email tools for reading, searching, drafting, and sending; responses stream over SSE with tool-call visibility.
- **Auto-draft on new email** — the agent reads inbound mail and generates draft replies, always requiring explicit confirmation before sending.
- **Configurable and persistent** — custom system prompt per mailbox, persistent chat history, and a per-mailbox choice of model provider.
- **Programmatic sending** — per-mailbox API keys let your own apps send mail through `/api/v1/send`.

<div align="center">
  <img src="./demo_domains.png" alt="The Settings page in Mailboxes: Platform Settings shown as configured, and a Domains list holding four domains at once" width="620">
  <p><em>The domain list in Settings — this deployment runs four domains at once, and each domain's catch-all mail can go to a different mailbox.</em></p>
</div>

## Prerequisites

- **Node.js ≥ 20** and npm (the repository ships a `.nvmrc`, so `nvm use` is enough)
- A Cloudflare account (`npm run setup` runs `wrangler login` for you when needed)
- **A domain.** You can add more later whenever you like. You can buy it from any registrar (Namecheap, GoDaddy, Cloudflare Registrar, …), but your domain's DNS has to be managed by Cloudflare: add the domain to your Cloudflare account first, then follow its instructions and switch the domain's nameservers at your registrar to the two Cloudflare gives you. Receiving runs on Cloudflare Email Routing; when you add the domain in the app, it looks that domain up in your Cloudflare account and reports `Zone for "<domain>" not found in Cloudflare` if it isn't there.
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for **receiving**
- A [Resend](https://resend.com) account for **sending** (outbound mail does not use Cloudflare Email Service)
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled for the agent (on by default)

## Quick start

**One command does the whole deploy.** It creates the bucket and database you need (R2 and D1), puts the database ID into the config file, sets up the data tables, then builds and deploys — and prints your URL:

```bash
npm install
npm run setup
```

The script is **safe to re-run**, so just run it again for every later deploy (anything that already exists is skipped; add `-- --dry-run` to see what it would do first).

> The **Deploy to Cloudflare** button at the top of this README works too, but it only creates the Worker — the bucket, the database and the database ID are on you. See the note at the end of this section.

1. **Set up receiving.** In the Cloudflare dashboard, go to your domain → **Email Routing** and create a **catch-all** rule — one that catches mail sent to any address on the domain — and forward it to this Worker. (For a domain that is *not* on Cloudflare DNS, you can instead receive through the Resend inbound webhook at `/api/v1/inbound/resend`.)

   To skip the manual part: finish step 3 below (create your admin account), fill in the Cloudflare credentials under **Settings** (`/settings`) — see Configuration — then add your domain on the home page. The app turns on Email Routing and creates this forwarding rule for you.

2. **Configure Resend for sending** (optional — only needed if you want to send). Sign up at [resend.com](https://resend.com), add your domain, and copy an API key. Then add the domain in the app: the **Add Domain** flow asks for the Resend API key, and you can update it later from the domain menu on the home page.

3. **Create your admin account.** The first time you open the app you are sent straight to the setup wizard at `/setup`, which asks for a username (default `admin`) and a password. No other page is reachable until you do. There is no default password, and no token or environment variable is involved. The window is one-shot: once the account exists, the wizard and its sign-up endpoint both close, and further attempts get a 409.

4. **Create a mailbox.** Once signed in, create a mailbox for any address on your domain (e.g. `hello@yourdomain.com`).

<details>
<summary>Using the <strong>Deploy to Cloudflare</strong> button instead?</summary>

The button only creates the Worker, while the app also needs an R2 bucket and a D1 database. `wrangler.jsonc` in this repository pins resources that live in the author's account, so deploying straight from the button fails. To make the button work:

1. **Fork** the repository.
2. In your fork, create the resources and point the config at them:
   - `wrangler r2 bucket create mailboxes`
   - `wrangler d1 create mailboxes-db`, then copy the returned `database_id` into the `d1_databases` block of `wrangler.jsonc`
   - `wrangler d1 migrations apply mailboxes-db --remote`
3. Click the button **on your fork** (the button in this README points at this repository and would use the author's `database_id`).

Much less work: run `npm run setup` as above.

</details>

## Configuration

- **`wrangler.jsonc`** — set your D1 `database_id`, the R2 bucket name, and any bindings. `npm run setup` fills in `database_id` for you.
- **Domains and Cloudflare credentials (Platform Settings)** — sign in, open **Settings** (`/settings`) → **Platform Settings**, and fill in the two values: **Cloudflare API Token** and **Cloudflare Account ID**. **Verify & Save** checks them before saving (the success message names the account and how many domains were found) and the badge turns into `Configured`; the two values are stored in the database.
  - The "创建预配置 Token →" link in that panel ticks three of the permissions for you. One more has to be added by hand: click Add more, then Zone → Email Routing Rules → Edit, and paste the token back into the field.
  - Once saved, adding a domain in the app turns on Email Routing and creates the forwarding rule for you — no dashboard clicking. If you skip it, use the manual path in step 1 of Quick start.
  - The domain has to be in your Cloudflare account already (subdomains find their parent domain automatically). The app only looks it up; it never adds it for you.
- **R2 bucket** — the app expects a bucket named `mailboxes`:
  ```bash
  wrangler r2 bucket create mailboxes
  ```
- **Admin credentials** — created once by the first-run setup wizard (`/setup`) and stored in D1; there are no credential vars to configure. The wizard is only open while the `admins` table is empty and closes itself as soon as the account exists; if two requests race, only one can win and the other gets a 409. To start over, delete the row and reload: `wrangler d1 execute mailboxes-db --remote --command "DELETE FROM admins"`.
- **Password storage** — the admin password is stored in D1 as a salted **PBKDF2-SHA256** hash, 100,000 iterations (workerd's ceiling for PBKDF2), with the parameters stored alongside the value. An earlier revision kept it in plain text, on the premise that the Free plan caps CPU at 10 ms per request and a KDF would trip Error 1102 intermittently; measuring a real Free-plan deployment showed the practical ceiling is nearer 2,000 ms, and the KDF costs 21-26 ms, so it was reinstated. Details and measurements: [SECURITY.md](SECURITY.md) and [`workers/lib/password.ts`](workers/lib/password.ts).
- **AI provider** — by default the agent uses Cloudflare Workers AI and needs no key. To use a custom model, open a mailbox's **Settings → AI Model**, enable the switch, and enter a base URL, model name, and API key (OpenAI-compatible). If the custom provider is unreachable, the app falls back to Workers AI.
- **Sending** — the Resend API key is configured per domain.

## Local development

> Just want to run it locally? Local development uses Miniflare's local D1/R2 bindings, so no Cloudflare resources are needed up front — steps 3–5 below only matter once you are ready to deploy (and `npm run setup` takes care of them).

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Configure local environment variables:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Create the D1 database:

   ```bash
   wrangler d1 create mailboxes-db
   ```

4. Copy the returned `database_id` into the `d1_databases` array in `wrangler.jsonc`.

5. Create the R2 bucket:

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

For the first deploy, just run `npm run setup` (see Quick start): it creates the missing resources, writes `database_id` back into the config, applies migrations, builds and deploys. For everyday redeploys once the resources exist:

```bash
npm run deploy
```

Then apply migrations in production:

```bash
npm run db:migrate
```

Or use the full command that builds, deploys, and migrates in one step:

```bash
npm run deploy:full
```

`bash deploy.sh` is the same as `npm run setup`.

## Stack

- **Frontend:** React 19, React Router v7 (SSR), Tailwind CSS v4, Zustand, TipTap, [`@cloudflare/kumo`](https://www.npmjs.com/package/@cloudflare/kumo), TanStack Query
- **Backend:** Hono on Cloudflare Workers, [D1](https://developers.cloudflare.com/d1/) (SQLite) via [Drizzle ORM](https://orm.drizzle.team/), [R2](https://developers.cloudflare.com/r2/), Cloudflare [Email Routing](https://developers.cloudflare.com/email-routing/)
- **AI agent:** Cloudflare [Workers AI](https://developers.cloudflare.com/workers-ai/) by default (or any OpenAI-compatible endpoint), with tool calling and SSE streaming
- **Sending:** the [Resend](https://resend.com) REST API

## Architecture

```text
  Browser -- React 19 + React Router v7 (SSR shell, client-side data)
      |  same-origin: /api/v1/* (cookie session) + SSE (AI assistant)
      v
  Cloudflare Worker "mailboxes" -- Hono (entry: workers/app.ts)
      |-- /api/v1/*         -> API routes (workers/index.ts)
      |-- all other paths   -> React Router SSR
      |-- email()           -> inbound entry (receiveEmail)
      `-- static assets     -> Workers Static Assets (injected at build)
      |
      |-->  D1 (SQLite / Drizzle) -- mails, attachments, folders, domains,
      |                              API keys, sessions, admins, settings, AI chats
      |-->  R2 "mailboxes"        -- mailbox config  mailboxes/<id>.json
      |                              attachments  attachments/<email>/<att>/<file>
      |-->  Workers AI            -- default @cf/moonshotai/kimi-k2.6
      |                              falls back to llama-3.3-70b, or any
      |                              OpenAI-compatible endpoint
      `-->  Resend REST API       -- outbound mail  POST /emails

  Inbound takes one of two paths (both write back to D1 and R2):
    A. Cloudflare Email Routing (catch-all rule) -> email() handler
    B. Resend inbound webhook -> POST /api/v1/inbound/resend -> fetch body
```

Beyond the above, the Worker binds nothing else on Cloudflare -- no KV, no Queues, no Durable Objects, no Vectorize, and no Cron triggers.

## How this fork differs from upstream

Mailboxes is a fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). Since the fork point (2026-04-17) there have been **155 commits across 139 files (+18,663 / -8,139 lines)**. The main differences:

- **Sending moved to Resend.** The Cloudflare `send_email` binding was dropped — it requires a paid Workers plan — in favour of the [Resend](https://resend.com) API, which runs on the free plan. Keys are configured per domain in the UI.
- **No Durable Objects, no MCP.** Upstream used three Durable Objects for mailbox state, the AI agent and the MCP server; here it is a stateless Worker plus D1, the assistant calls Workers AI in-request with function calling, and the MCP panel is gone. This was about dropping a layer of framework, **not about cost** — SQLite-backed Durable Objects run on the free plan, and that is the kind upstream used.
- **Its own login instead of Cloudflare Access.** Upstream required `POLICY_AUD` / `TEAM_DOMAIN`; here the first run creates an admin account whose PBKDF2-SHA256 password is stored in D1.
- **Configuration lives in the database and the UI.** Domains, mailboxes and keys are managed in D1 and edited on screen rather than through `wrangler.jsonc` environment variables.
- **Multiple domains.** One instance can serve several domains, each with its own routing and sending settings.
- **New pages:** first-run setup, login, platform settings (Cloudflare credentials), domain details, add-domain wizard, catch-all settings, and the AI panel.
- **Tooling:** `migrations/` (12 SQL files), one-command deploy via `npm run setup`, e2e tests and CI.

### Why it can stay at $0 a month

- There is no always-on server — the whole app is a single Worker.
- Sending avoids the binding that needs a paid plan and stays inside Resend's free tier.
- Metadata goes to D1 and attachments to R2, whose egress is free.
- The assistant uses Workers AI's free daily allocation by default, so no extra API key is needed; you can point it at your own OpenAI-compatible provider instead.
- Inbound mail uses Cloudflare Email Routing, or Resend's inbound webhook when the domain is not hosted on Cloudflare.

See [What it costs](#what-it-costs) for the individual quotas.

## FAQ

### Is it really free?

Yes, for personal use and small products. There is nothing to pay Mailboxes itself. The app runs inside **your own** Cloudflare account, and Cloudflare's and Resend's free tiers cover a personal inbox or an early-stage product — see [What it costs](#what-it-costs) for the exact limits. There is no per-seat or per-mailbox fee, so adding a tenth mailbox costs the same as the first: nothing.

### Adding a domain fails with "the domain is registered to another team"

When you add a domain, Resend may return:

> Failed to create domain on Resend: The `yourdomain.com` domain is registered to another team. You can claim it using the Domain Claim API.

This error comes from **Resend**, not from Mailboxes. A domain can only ever be active on **one Resend team at a time**, and `yourdomain.com` was already added (and most likely verified) on a different Resend team — usually an old account, a teammate's personal account, or a throwaway test account.

**Fix it in one of two ways:**

1. **You control the other team** — sign in to that Resend team, open **Domains**, delete the domain, then add it again from Mailboxes. Make sure you're switched to the correct team in the top-left team switcher.
2. **You don't have access to that team** — claim the domain by proving ownership:
   - **Dashboard:** Domains → **Add Domain** → enter the domain → **Start claim** → add the returned **TXT** record to your DNS (a one-click option is offered for some registrars) → click **I've added the records**.
   - **API:** `POST https://api.resend.com/domains/claim` with `{ "name": "yourdomain.com" }`, add the returned TXT record, then verify and poll until `status` is `completed`.
   - A successful claim **releases the domain from the previous team and transfers it to yours**. Claims expire after **7 days**.
   - If the claim is `blocked` with a reason such as `recent_owner_activity` or `pending_scheduled_emails`, the other team is still actively sending from the domain — contact [Resend support](https://resend.com/help) to release it.

Once the domain is released (or claimed) in Resend, add it again from the Mailboxes app.

> **Note:** This only affects **outbound** sending via Resend. Inbound mail arrives through **Cloudflare Email Routing** (a catch-all rule → this Worker), or the Resend inbound webhook for domains off Cloudflare DNS. Keep your domain's MX records pointed at Cloudflare Email Routing — do not repoint the root MX to Resend or inbound mail will break.

See: [Resend — Claim Domain](https://resend.com/docs/api-reference/domains/claim-domain) · [Domain already registered by another account](https://resend.com/docs/knowledge-base/domain-already-registered)

## Roadmap

- [ ] Structured/rule-based auto-replies (beyond draft-only)
- [ ] Shared team mailboxes
- [ ] More sending providers alongside Resend
- [ ] Contact/CRM light layer

Have an idea? Open an issue.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR, and keep changes focused and tested (`npm test`, `npm run typecheck`).

## Security

Please do not open public issues for security problems — see [SECURITY.md](SECURITY.md).

## License

**AGPL-3.0-only** — the work as a whole, including every addition and modification made in this repository, is distributed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service for others, you must offer them the corresponding complete source code (AGPL section 13).

This work is a derivative of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) and therefore contains upstream Apache-2.0 code: upstream portions are Copyright (c) Cloudflare, Inc. and remain under the [Apache License 2.0](LICENSE-APACHE) (full text in that file), while additions and modifications in this repository are Copyright (c) 2026 Doforu and licensed under the AGPL-3.0. Per-file copyright and license notices are kept in the file headers. See [NOTICE](NOTICE) for the complete attribution.

## Acknowledgements

A fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). Built on [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), [Workers AI](https://developers.cloudflare.com/workers-ai/) and [Resend](https://resend.com). Learn more about the email-inbox pattern in Cloudflare's blog post [Email for Agents](https://blog.cloudflare.com/email-for-agents/). For what this fork changes relative to upstream, see [How this fork differs from upstream](#how-this-fork-differs-from-upstream).
