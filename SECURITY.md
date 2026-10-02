# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, report them privately via GitHub's
[**Report a vulnerability**](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
feature on the **Security** tab of this repository, or contact the maintainers directly.

Please include:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept if possible)
- Affected versions / commit
- Any suggested remediation

We will acknowledge your report as soon as we can and keep you informed of the fix.

## Scope

Mailboxes is self-hosted: it runs inside **your own** Cloudflare account, and you are
responsible for your deployment's secrets (your Resend API key, your Cloudflare API
token, and any other bindings). Never commit real credentials — use `.dev.vars`
locally and Cloudflare secrets in production.

## Admin password storage

The admin password is created by the first-run setup wizard and stored in D1 as a
salted **PBKDF2-SHA256** hash, 100,000 iterations, in the format:

```text
pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>
```

100,000 is workerd's ceiling for PBKDF2 — a higher iteration count does not increase the
work factor, so this is the strongest configuration available. The algorithm name is
stored alongside the value, so the parameters can be raised later without a schema
change. See the header of [`workers/lib/password.ts`](workers/lib/password.ts).

### Why this is not the Free plan's 10 ms limit

An earlier revision of this project stored the password in plain text, on the premise
that the Workers **Free** plan allows only 10 ms of CPU per request, and that a KDF
would therefore make login fail intermittently with
[Error 1102](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/).

That premise did not survive measurement. Three probe Workers were deployed and their
`cpuTime` / `outcome` read back out of `wrangler tail`:

| Probe | cpuTime | outcome |
| --- | --- | --- |
| Burn CPU in a loop | 1,894 ms | `ok` |
| Burn CPU in a loop | 2,020 ms | `exceededCpu` |
| `setTimeout` sleeping 8 s | 0 ms | `ok` |

The sleeping probe was never killed while the looping probe died just past 2 s, so the
ceiling sits near **2,000 ms of CPU**, not 10 ms. For contrast, the KDF costs:

| Operation | Measured cpuTime |
| --- | --- |
| PBKDF2-SHA256 @ 100,000 iterations | 21-26 ms |
| `POST /api/v1/auth/login`, full request (p50) | 3 ms |
| `POST /api/v1/auth/login`, full request (p99) | 25 ms |

That is roughly 1% of the measured budget, so plain-text storage bought nothing and was
reverted.

> **Caveat:** the 2,000 ms figure was measured on one Free-plan account in 2026.
> Cloudflare's *published* Free-plan limit remains 10 ms, so treat the number as
> account-dependent rather than as a guarantee.

### If your account really does enforce 10 ms

`workers/lib/password.ts` is the only file that has to change:

- Lower `PBKDF2_ITERATIONS`. Beware that a count low enough to still fail
  *intermittently* is the worst possible outcome — worse than a documented trade-off.
- Put **Cloudflare Access** in front of the deployment, so the Worker's own login is not
  the only gate.
- Or move to a Workers **Paid** plan and raise the work factor instead of lowering it.

Login timing is deliberately equalised: an unknown username still runs a full KDF
against a placeholder hash, so response time does not reveal which usernames exist.
