# Support

Mailboxes is a single-maintainer open-source project. There is no support contract, no
service-level agreement and no paid tier. Help is best-effort, and it comes from the
maintainer and from other people running their own deployments.

Because you host your own copy, you are also its operator. Nobody else can see your D1
database, your R2 bucket or your logs.

## Where to go

| What you want | Where |
| --- | --- |
| Ask a question, or get help with a deployment | [Discussions → Q&A](https://github.com/doforu-labs/Mailboxes/discussions/categories/q-a) |
| Suggest an idea, or add weight to one | [Discussions → Ideas](https://github.com/doforu-labs/Mailboxes/discussions/categories/ideas) |
| Show a deployment or a fork | [Discussions → Show and tell](https://github.com/doforu-labs/Mailboxes/discussions/categories/show-and-tell) |
| Anything that fits nowhere else | [Discussions → General](https://github.com/doforu-labs/Mailboxes/discussions/categories/general) |
| Report a bug you can reproduce | [Issues](https://github.com/doforu-labs/Mailboxes/issues) |
| Report a security problem | [Private advisory](https://github.com/doforu-labs/Mailboxes/security/advisories/new) — **never** a public issue; see [`SECURITY.md`](SECURITY.md) |

Issues are for bugs that can be reproduced and for focused feature requests that state the
use case behind them. Questions filed as issues will be moved to Discussions. That is not a
brush-off — it is so the answer stays findable for the next person.

## Before you ask

Three steps answer most questions:

1. Read the [FAQ](README.md#faq). It covers the free-tier quotas and the
   `"the domain is registered to another team"` error.
2. Run what CI runs, and include the output:
   ```sh
   npm run typecheck
   npm test
   npm run build
   ```
3. Search the existing discussions and issues.

## What to include in a bug report

- What you did, what you expected, and what happened instead.
- `node -v`, `npm -v`, `npx wrangler --version`, and the commit you deployed.
- Whether the deployment is on the Workers **Free** or **Paid** plan.
- The relevant Worker logs (`npx wrangler tail`), with secrets removed.
- A screenshot or screen recording for anything visible in the UI.

## Scope

**In scope** — bugs in this repository, deployment failures this repository causes, and
questions about how the code works.

**Not in scope** — your Resend or Cloudflare account, deliverability problems rooted in a
third party's DNS configuration, custom development, and debugging forks. To send a change
instead of a request, read [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Free-tier limits

Mailboxes is built to run inside Cloudflare's and Resend's free tiers. Those quotas belong
to your accounts, not to this project, and nobody here can raise them. If you hit one, the
fix is in your Cloudflare or Resend dashboard. The quotas this project relies on are listed
under [What it costs](README.md#what-it-costs).

## Not affiliated with Cloudflare

Mailboxes is an independent fork of
[`cloudflare/agentic-inbox`](https://github.com/cloudflare/agentic-inbox), distributed under
the AGPL-3.0 with the upstream Apache-2.0 notices preserved (see [`NOTICE`](NOTICE)). It is
not affiliated with, sponsored by or endorsed by Cloudflare, Inc. Everything written here
is this project's own.
