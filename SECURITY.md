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
responsible for your deployment's secrets (`AUTH_USERNAME` / `AUTH_PASSWORD`, the Resend
API key, and any other bindings). Never commit real credentials — use `.dev.vars`
locally and Cloudflare secrets in production.
