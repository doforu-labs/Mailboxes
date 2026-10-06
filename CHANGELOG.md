# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Deploy freshness guard for a bare `wrangler deploy`.** A bare `wrangler deploy`
  follows the Vite plugin's config redirect and uploads whatever already sits in
  `build/` without building, which silently ships a stale artifact (it has happened
  once). Since `build.command` is deleted from the hand-written `wrangler.jsonc` by
  the plugin, the assertion is injected into the *generated* config instead:
  `scripts/inject-deploy-guard.mjs` runs at the end of every `npm run build` and adds
  `build.command` to `build/server/wrangler.json`, which runs
  `scripts/deploy-freshness-guard.mjs`. That guard asserts the build is fresh only for
  `deploy` / `versions upload` (decided from `WRANGLER_COMMAND`, which wrangler exports
  to the custom-build process); every other command — including `wrangler types`, used
  by `npm run typecheck` — passes through untouched. When `build/` is older than the
  sources the deploy fails with the newest source, the oldest artifact, and the two
  ways to fix it. Escape hatch: `ALLOW_STALE_DEPLOY=1`.

### Fixed

- **First deploy no longer fails on the Vite redirect.** `scripts/setup.mjs` used to
  append `--config <root>/wrangler.jsonc` to *every* wrangler call, including `deploy`.
  That bypasses the redirect the Cloudflare Vite plugin writes after each build
  (`.wrangler/deploy/config.json` → `build/server/wrangler.json`), so wrangler
  re-bundled the raw `workers/app.ts` on the spot and died on the build-time virtual
  module `virtual:react-router/server-build`. The `deploy` call (and its `--dry-run`
  rehearsal) now omits `--config` and follows the redirect instead.

### Changed

- **Remote migrations are opt-in by default.** `npm run setup` no longer applies
  production migrations automatically: it runs a read-only
  `wrangler d1 migrations list <db> --remote`, and if anything is pending it stops,
  lists the migration filenames, and asks you to re-run with `--migrate`. The one
  exception is a D1 database created by the same run — an empty database has nothing
  to damage, so it is treated as first-time initialization and migrated on the spot.
  `--migrate` keeps the old explicit behaviour.

### Documentation

- **Both READMEs now warn against a bare `wrangler deploy`.** Because the Vite plugin
  redirects wrangler to `build/server/wrangler.json`, running `wrangler deploy` directly
  uploads whatever is already in `build/` without building anything — it ships a stale
  artifact silently, with no error and no warning. The docs point at the supported
  entries (`npm run deploy`, `npm run setup` / `bash deploy.sh`, `npm run deploy:full`)
  and note that `build.command` in `wrangler.jsonc` is not a safeguard here: the
  Cloudflare Vite plugin deletes that field when it generates the config.

## [0.2.0] - 2026-10-06

### Added

- **External agent access — global API keys, an MCP server and an HTTP tool
  gateway.** An outside LLM or MCP client can now call the same 14 tools the
  built-in agent uses. Create keys under **Settings → Agent API Keys**
  (`/api/v1/agent-api-keys`: `POST` to create, `GET` to list, `DELETE /:id` to
  revoke — session-cookie authenticated). A key is `agk_` followed by 64 hex
  characters, stored as a SHA-256 hash, **shown exactly once** at creation, and
  revocable; every use is audited. Callers authenticate with
  `Authorization: Bearer <key>` against either:
  - **`POST /mcp`** — a minimal, hand-written, **stateless** MCP server
    (JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`, `ping`), or
  - **`GET /tools`** / **`POST /tools/call`** — an HTTP tool gateway for callers
    that do not speak MCP.
  Both surfaces reuse the built-in agent's exact tool definitions.
- **No new Cloudflare bindings.** The gateway is a stateless Worker route: keys
  are D1 rows and tool execution reuses the existing D1/R2 access, so there are
  still no Durable Objects, KV, Queues or Vectorize bindings.
- **Deterministic path for external calls.** Tool calls from the gateway skip
  the agent's internal AI body-verification (`skipVerifyDraft`), so a draft or
  reply is sent exactly as written rather than being rewritten.
- **Field whitelisting on tool output.** Read-only tool results returned to
  external callers are reshaped to a public field whitelist — internal
  identifiers, raw message headers and other internal fields are not exposed.

### Fixed

- **Tool parameters that refer to an email now use the same names the tools
  return.** `get_email`, `mark_email_read`, `move_email` and `delete_email`
  took `emailId`, `get_thread` took `threadId`, and `draft_reply` / `send_reply`
  took `originalEmailId` — while `list_emails` / `search_emails` *return* `id`
  and `thread_id`. A model that copied the value straight out of a list result
  therefore missed the required key. They now take `id` / `thread_id`, and the
  descriptions say which returned field to read. The old spellings still work
  (normalized to the canonical key, canonical wins on conflict); `update_draft`
  and `discard_draft` keep `draftId`, which already matched its own return
  field. No result shape changed, and no bare `id` is ever reinterpreted as a
  `thread_id`.
- **A missing required tool argument is now reported instead of failing
  downstream.** The external tool gateway validates `required` against the
  (alias-normalized) arguments before executing, answering
  `{ ok:false, error:"missing required parameter: <name>" }` — previously an
  absent argument reached the query layer and came back as an opaque failure a
  calling model could not act on.
- **Tool errors no longer swallow their cause.** `executeToolCall` now keeps
  `error` stable and adds a `detail` field carrying the real exception message
  — the agent loop gets the diagnostic it was previously only logging, so it
  can self-correct. `detail` is internal: the external gateway never forwards
  it, and unparseable tool arguments answer with
  `invalid tool arguments: could not parse JSON` rather than escaping as an
  exception.
- **Claims the code did not back.** The v0.1.0 notes and both READMEs described replies
  being drafted automatically as mail arrives. No such trigger exists: the `EMAIL_AGENT`
  auto-draft path was removed and the D1 change detection named as its replacement was
  never built. Drafting is started from the agent panel, and automatic replies are listed
  under [Roadmap → Planned](README.md#roadmap) rather than shipped. The v0.1.0 release
  notes were corrected in place; the tag itself still points at the original commit.
- **Stale links in the v0.1.0 release notes** — they pointed at `README.en.md` (renamed to
  `README.zh-CN.md`/`README.md`) and at a legacy repository URL.

### Changed

- **README language swap.** `README.md` is now the English document, so the repository's
  front page reads for an English-speaking audience; the Simplified Chinese version moved
  to [`README.zh-CN.md`](README.zh-CN.md). The Add Domain steps no longer tell you to
  register the domain on Resend by hand — the app does it, and doing it manually makes
  Resend reject the domain with "registered to another team".

### Removed

- **BREAKING:** **Per-domain programmatic sending API keys.** The `mb_`-prefixed keys that let an
  external application send mail through `POST /api/v1/send` are gone, along with the
  endpoint, its management UI and the `api_keys` table (`migrations/0012_drop_api_keys.sql`).
  Resend sending credentials (`resend_api_key`) are untouched: the app still sends and
  receives mail exactly as before, and the built-in AI agent still sends through the
  shared mail pipeline.

## [0.1.0] - 2026-10-02

First public release.

Mailboxes began life as a fork of
[`cloudflare/agentic-inbox`](https://github.com/cloudflare/agentic-inbox) (Apache-2.0);
the upstream notices are retained in [`NOTICE`](NOTICE) and
[`LICENSE-APACHE`](LICENSE-APACHE).

### Added

- **Self-hosted email client on Cloudflare** — the whole application runs on Workers,
  with D1 for mail data and R2 for per-mailbox configuration and attachments. No server
  to rent; the free tiers cover personal and small-product use.
- **First-run setup wizard** — the first visitor to a fresh deployment creates the admin
  account at `/setup`. There is no default password and no credential environment
  variables. The window is one-shot: once an admin exists, the wizard and its endpoint
  close (`409 Already initialised`), including under concurrent submits.
- **Salted PBKDF2-SHA256 password storage** — 100,000 iterations (workerd's ceiling for
  PBKDF2), with the parameters stored alongside the hash so they can be raised later
  without a schema change. Login timing is equalised so an unknown username cannot be
  distinguished from a wrong password.
- **Cookie sessions** — HttpOnly / Secure / SameSite=Lax, 7-day lifetime, stored in D1
  with periodic cleanup of expired rows.
- **Full mail client** — send and receive through Cloudflare Email Routing, with a rich
  text composer, reply/forward threading, folders, search, and attachments.
- **Per-mailbox isolation** — each mailbox's settings are an R2 object, and its mail is
  partitioned in D1.
- **Built-in AI agent** — a side panel exposing 14 mail tools (read, search, draft,
  send), streamed over SSE with the tool calls shown inline.
- **AI-drafted replies** — the agent can read a message and write or revise a reply,
  saving it to the mailbox's Drafts folder. Drafting is started by you from the agent
  panel; nothing is sent until you confirm.
- **Configurable and persistent** — per-mailbox system prompt, saved chat history, and
  a choice of model provider (Workers AI by default, or any OpenAI-compatible endpoint,
  falling back to Workers AI when the custom provider is unreachable).
- **Programmatic sending** — per-mailbox API keys, so your own app can send through
  `POST /api/v1/send`.
- **Documentation in two languages** — [`README.md`](README.md) (English) and
  [`README.zh-CN.md`](README.zh-CN.md) (Simplified Chinese).
- **CI** — typecheck, unit tests and a production build on every push and pull request
  (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Changed

- **Relicensed as AGPL-3.0-only.** Upstream's Apache-2.0 notices are preserved in
  [`LICENSE-APACHE`](LICENSE-APACHE) and [`NOTICE`](NOTICE), as Apache-2.0 §4 requires.

### Security

- Admin passwords moved from plain-text storage to salted PBKDF2-SHA256 hashes. The
  premise behind the original plain-text decision — that the Free plan's 10 ms CPU limit
  would make a KDF fail intermittently — did not survive measurement on a real Free-plan
  deployment, where the ceiling sits near 2,000 ms and the KDF costs 21-26 ms. The
  measurements are written up in [`SECURITY.md`](SECURITY.md).
- To report a vulnerability, use the private
  [advisory form](https://github.com/doforu-labs/Mailboxes/security/advisories/new)
  rather than a public issue — see [`SECURITY.md`](SECURITY.md).

[Unreleased]: https://github.com/doforu-labs/Mailboxes/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/doforu-labs/Mailboxes/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/doforu-labs/Mailboxes/releases/tag/v0.1.0
