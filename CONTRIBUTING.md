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
  ```

- **Add tests** for behavior changes where practical (`workers/**/*.test.ts`).
- **Update docs** (README.md / README.en.md) if you change configuration, setup
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

Be kind and constructive. Harassment or hostile behavior will not be tolerated.
