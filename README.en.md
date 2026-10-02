<div align="center">
  <h1>Mailboxes</h1>
  <p><em>Send, receive, and auto-reply from your own domain — a self-hosted email client with an AI agent, running entirely on Cloudflare.</em></p>

  <p>
    <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg"></a>
    <img alt="Runs on free tiers" src="https://img.shields.io/badge/cost-%240%20on%20free%20tiers-brightgreen">
    <a href="https://github.com/doforu-labs/Mailboxes/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  </p>

  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/doforu-labs/Mailboxes"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

  <p><sub>© 2026 <strong>Doforu</strong> · derivative of <a href="https://github.com/cloudflare/agentic-inbox">cloudflare/agentic-inbox</a> · licensing and attribution in <a href="NOTICE">NOTICE</a></sub></p>
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
- **Per-mailbox isolation** — each mailbox's configuration is an R2 object and its messages live in D1, keyed by mailbox.
- **Built-in AI agent** — a side panel with 14 email tools for reading, searching, drafting, and sending; responses stream over SSE with tool-call visibility.
- **Auto-draft on new email** — the agent reads inbound mail and generates draft replies, always requiring explicit confirmation before sending.
- **Configurable and persistent** — custom system prompt per mailbox, persistent chat history, and a per-mailbox choice of model provider.
- **Programmatic sending** — per-mailbox API keys let your own apps send mail through `/api/v1/send`.

## Quick start

**Important:** the **Deploy to Cloudflare** button only creates the Worker. It is *not* enough on its own — you must also complete the steps below, **in particular creating the D1 database**, before the app will work.

1. **Deploy to Cloudflare.** Click the button. The deploy flow provisions R2 and Workers AI in your account.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/doforu-labs/Mailboxes)

2. **Create the D1 database and run migrations.** The repository ships with the original author's `database_id` in `wrangler.jsonc`, so you must swap in your own:

   ```bash
   wrangler d1 create mailboxes-db
   ```

   Copy the returned `database_id` into the `d1_databases` block of `wrangler.jsonc`, then apply the migrations:

   ```bash
   npm run db:migrate
   ```

3. **Set up receiving.** In the Cloudflare dashboard, go to your domain → **Email Routing** and create a **catch-all** rule that forwards to this Worker. (For a domain that is *not* on Cloudflare DNS, you can instead receive through the Resend inbound webhook at `/api/v1/inbound/resend`.)

4. **Configure Resend for sending** (optional — only needed if you want to send). Sign up at [resend.com](https://resend.com), add your domain, and copy an API key. Then add the domain in the app: the **Add Domain** flow asks for the Resend API key, and you can update it later from the domain menu on the home page.

5. **Create your admin account.** The first time you open the app you are sent straight to the setup wizard at `/setup`, which asks for a username (default `admin`) and a password. No other page is reachable until you do. There is no default password, and no token or environment variable is involved. The window is one-shot: once the account exists, the wizard and its sign-up endpoint both close, and further attempts get a 409.

6. **Create a mailbox.** Once signed in, create a mailbox for any address on your domain (e.g. `hello@yourdomain.com`).

## Configuration

- **`wrangler.jsonc`** — set your D1 `database_id`, the R2 bucket name, and any bindings.
- **R2 bucket** — the app expects a bucket named `mailboxes`:
  ```bash
  wrangler r2 bucket create mailboxes
  ```
- **Admin credentials** — created once by the first-run setup wizard (`/setup`) and stored in D1; there are no credential vars to configure. The wizard is only open while the `admins` table is empty and closes itself as soon as the account exists; if two requests race, only one can win and the other gets a 409. To start over, delete the row and reload: `wrangler d1 execute mailboxes-db --remote --command "DELETE FROM admins"`.
- **Password storage** — the admin password is stored in D1 as a salted **PBKDF2-SHA256** hash, 100,000 iterations (workerd's ceiling for PBKDF2), with the parameters stored alongside the value. An earlier revision kept it in plain text, on the premise that the Free plan caps CPU at 10 ms per request and a KDF would trip Error 1102 intermittently; measuring a real Free-plan deployment showed the practical ceiling is nearer 2,000 ms, and the KDF costs 21-26 ms, so it was reinstated. Details and measurements: [SECURITY.md](SECURITY.md) and [`workers/lib/password.ts`](workers/lib/password.ts).
- **AI provider** — by default the agent uses Cloudflare Workers AI and needs no key. To use a custom model, open a mailbox's **Settings → AI Model**, enable the switch, and enter a base URL, model name, and API key (OpenAI-compatible). If the custom provider is unreachable, the app falls back to Workers AI.
- **Sending** — the Resend API key is configured per domain.

## Local development

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

## Prerequisites

- A Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for **receiving**
- A [Resend](https://resend.com) account for **sending** (outbound mail does not use Cloudflare Email Service)
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled for the agent (on by default)

## Stack

- **Frontend:** React 19, React Router v7 (SSR), Tailwind CSS v4, Zustand, TipTap, [`@cloudflare/kumo`](https://www.npmjs.com/package/@cloudflare/kumo), TanStack Query
- **Backend:** Hono on Cloudflare Workers, [D1](https://developers.cloudflare.com/d1/) (SQLite) via [Drizzle ORM](https://orm.drizzle.team/), [R2](https://developers.cloudflare.com/r2/), Cloudflare [Email Routing](https://developers.cloudflare.com/email-routing/)
- **AI agent:** Cloudflare [Workers AI](https://developers.cloudflare.com/workers-ai/) by default (or any OpenAI-compatible endpoint), with tool calling and SSE streaming
- **Sending:** the [Resend](https://resend.com) REST API

## Architecture

```text
┌────────────────────────────────────────┐
│  Browser - React SPA                   │
│  email client + AI agent panel         │
└───────────────────┬────────────────────┘
                    │  HTTP / SSE
┌───────────────────▼────────────────────┐
│  Hono Worker  (API + SSR)              │
└───┬────────────────────────────────────┘
    │
    ├──►  D1 (SQLite)    mails, threads, folders
    ├──►  R2             mailbox config, attachments
    ├──►  Workers AI     (default) or OpenAI-compatible
    ├──►  Resend API     outbound mail
    │
    └──►  Inbound: Cloudflare Email Routing (catch-all) -> Worker
                 or Resend inbound webhook -> POST /api/v1/inbound/resend
```

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

Apache 2.0 — see [LICENSE](LICENSE).

This work is a derivative of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). Upstream portions are Copyright (c) Cloudflare, Inc.; additions and modifications in this repository are Copyright (c) 2026 Doforu. See [NOTICE](NOTICE).

## Acknowledgements

A fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). Built on [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), [Workers AI](https://developers.cloudflare.com/workers-ai/) and [Resend](https://resend.com). Learn more about the email-inbox pattern in Cloudflare's blog post [Email for Agents](https://blog.cloudflare.com/email-for-agents/).
