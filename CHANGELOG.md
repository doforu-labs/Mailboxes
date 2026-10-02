# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **README language swap.** `README.md` is now the English document, so the repository's
  front page reads for an English-speaking audience; the Simplified Chinese version moved
  to [`README.zh-CN.md`](README.zh-CN.md). The Add Domain steps no longer tell you to
  register the domain on Resend by hand — the app does it, and doing it manually makes
  Resend reject the domain with "registered to another team".

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
- **Auto-draft on inbound mail** — the agent reads new mail and prepares a reply, which
  is never sent without explicit confirmation.
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

[Unreleased]: https://github.com/doforu-labs/Mailboxes/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/doforu-labs/Mailboxes/releases/tag/v0.1.0
