<div align="center">
  <h1><picture><source media="(prefers-color-scheme: dark)" srcset="./logo-rounded-dark.png"><img src="./logo-rounded.png" alt="The Mailboxes icon: a white letter M whose middle valley doubles as an envelope flap, on a black tile" width="48" align="absmiddle"></picture>&nbsp;&nbsp;Mailboxes</h1>
  <p><em>A free mailbox for your agent.<br>An address of its own, on the domain you already own, for $0 a month.</em></p>

  <p>
    <a href="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/doforu-labs/Mailboxes/actions/workflows/ci.yml/badge.svg"></a>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
    <img alt="Free" src="https://img.shields.io/badge/cost-%240%20on%20free%20plans-brightgreen">
    <a href="https://github.com/doforu-labs/Mailboxes/pulls"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
  </p>

  <img src="./demo_app.png" alt="Mailboxes open on an inbox, with the assistant's draft waiting in the side panel" width="880">
</div>

---

> **English** · [简体中文](./README.zh-CN.md)

Your agent can read, write, search and plan. What it does not have is an address.

Ask it to answer a customer, watch a newsletter, or sign up for a service, and it needs a real mailbox on a real domain — one a stranger can actually send to. A hosted inbox charges for every seat. An API-only inbox wants a subscription before your agent has sent a single message.

Mailboxes is that mailbox, and it is free. Your agent gets `hello@yourdomain.com`. Mail arrives. It reads what came in, searches what came before, and writes the reply. **You press send.** It all runs in your own Cloudflare account on the free plans, so there is nothing to rent and nothing to pay us.

## What your agent gets

- **An address it can keep.** Any address on your domain — `hello@`, `support@`, `agent@` — or a catch-all that catches everything sent to the domain. Several domains side by side.
- **Mail it can read.** Every message lands in its inbox with the full thread and its attachments, not a webhook payload you have to reshape.
- **A memory it can search.** "What did the customer say last month?" is a question it answers from your own mail, not from a summary you pasted in.
- **Something it can write.** It drafts replies right in the mailbox it is working in. Sending is the one step it cannot take alone.
- **A door for the agent you already use.** Talk to it in the built-in panel, or plug in your own: any MCP client, or any host that can call HTTP tools, with a key from Settings.
- **A screen for you.** The whole thing is a mail client you can work in too — folders, threads, search, a rich-text composer, attachments, themes. The agent sits beside your inbox, not instead of it.

## Getting a mailbox running

You need three things: a **domain** whose DNS is on Cloudflare, **Node.js 20+**, and a free **Cloudflare account**.

```bash
npm install
npm run setup
```

`npm run setup` creates the storage, creates the database, builds, deploys, and prints your URL. It is safe to re-run — anything that already exists is skipped.

Then open that URL:

1. **Create your account.** The first visit is a setup wizard. There is no default password and nothing to configure beforehand.
2. **Create a mailbox.** Pick an address on your domain, say `hello@yourdomain.com`.
3. **Turn on receiving.** Save a Cloudflare API token under **Settings**, then add the domain: the app turns on Email Routing and points the catch-all at your mailbox. Without the token, it is one catch-all rule in the Cloudflare dashboard.
4. **Turn on sending**, if you want your agent to send at all. Paste a free [Resend](https://resend.com) API key when you add the domain, and the app creates the domain there and writes the DNS records itself.

## Does it cost anything?

No. You pay us nothing, and a personal inbox or a small product stays inside the free plans: 100,000 requests a day, 5 GB of mail, 10 GB of attachments, 10,000 AI neurons a day, and 100 outgoing emails a day from Resend. A tenth mailbox costs the same as the first — there is no per-seat anything.

## Connect your own agent

Open **Settings → Agent API Keys**, create a key, and copy it. It is shown once, and every use of it is recorded.

- **MCP client** → point it at `https://your-app.workers.dev/mcp`
- **Anything that calls HTTP tools** → `GET /tools` lists them, `POST /tools/call` runs one
- Send the key as `Authorization: Bearer mbx_...`

Your agent gets the same 14 tools as the built-in panel. Make the key **read-only** if it should never send, or limit it to a couple of mailboxes.

## FAQ

### Is it really free?

Yes — for personal use and small products. You pay nothing to Mailboxes; the app runs inside your own Cloudflare account, on Cloudflare's and Resend's free plans.

### Adding a domain says it is "registered to another team."

That message comes from Resend, not from Mailboxes. A domain can only be active on one Resend team at a time, so it is still sitting on an old account. Delete it there, or claim it in Resend with a TXT record and it moves to you. Incoming mail is unaffected — it arrives through Cloudflare Email Routing.

### Can my agent send without asking me?

Not today. It drafts, you confirm. Automatic replies are next on the list.

### Which model runs the assistant?

Cloudflare's built-in AI, with no key to set. Any mailbox can point at an OpenAI-compatible endpoint instead, and falls back to the default if that endpoint stops answering.

## What is coming

- Auto-replies — a reply goes out on its own when mail arrives
- Shared team mailboxes — several people on one mailbox, with permissions
- More sending providers, beyond Resend
- A contact layer, instead of people parsed out of headers

<details>
<summary><strong>For whoever deploys and maintains it</strong></summary>

Everyday redeploys are `npm run deploy`. It applies any new database migrations first; ones already applied are skipped.

Do not run `wrangler deploy` on its own — it skips the migrations and skips the deploy guard the build adds, so a schema change can reach production without its tables.

To run it locally, `npm run dev` uses a local database and local storage, so no Cloudflare resources are needed yet. `npm run setup -- --dry-run` shows what the first deploy would do.

The admin password hashing — and why it fits the free plan's CPU limit — is written up in [SECURITY.md](SECURITY.md). Everything else is entered in the app under **Settings**: there is no credentials file and no environment variable to set. The code is commented where the reasoning matters.

</details>

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service for other people, you have to offer them the source.

Mailboxes builds on Cloudflare's [agentic-inbox](https://github.com/cloudflare/agentic-inbox) and includes its Apache-2.0 code; that stays Apache-2.0 (see [LICENSE-APACHE](LICENSE-APACHE) and [NOTICE](NOTICE)), and everything added or changed here is AGPL-3.0.

Built on [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), [Workers AI](https://developers.cloudflare.com/workers-ai/), and [Resend](https://resend.com). Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
