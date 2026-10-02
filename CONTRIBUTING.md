# Contributing to Mailboxes

Thanks for your interest in improving Mailboxes! This project is a fork of
[cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) and welcomes
issues and pull requests.

## Getting set up

See the **Local development** section of the [README](README.md) for the full setup
(install deps, create the D1 database and R2 bucket, run migrations, `npm run dev`).

## Before you open a PR

- **Keep it focused.** One feature or fix per PR; avoid drive-by reformatting.
- **Run the checks:**

  ```bash
  npm run typecheck
  npm test
  npm run build
  ```

  CI runs these same three on every push and pull request — see
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

- **Add tests** for behavior changes where practical (`workers/**/*.test.ts`).
- **Update docs** (README.md / README.zh-CN.md) if you change configuration, setup
  steps, or user-facing behavior.

## Commit & PR style

- Write clear, imperative commit messages (e.g. `fix: handle empty inbox list`).
- Describe **what** changed and **why** in the PR description, and link related issues.
- Screenshots are appreciated for UI changes.

## Reporting bugs

Open an issue with:

- What you expected vs. what happened
- Steps to reproduce
- Your environment (Cloudflare plan, browser, commit/version)
- Relevant logs (redact API keys and personal data)

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and
constructive — harassment or hostile behavior will not be tolerated.

## Changelog

Notable changes are recorded in [`CHANGELOG.md`](CHANGELOG.md), following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).
