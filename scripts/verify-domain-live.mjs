// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * LIVE domain-wiring probe — real domains, real DNS, no mocks.
 *
 *   node scripts/verify-domain-live.mjs
 *   npx tsx scripts/verify-domain-live.mjs
 *   npx tsx scripts/verify-domain-live.mjs doforu.app example.com  # explicit set
 *
 * WHAT THIS IS FOR
 * ----------------
 * `workers/setup-domain-checks.test.ts` locks the *logic* of the MX check and
 * the DNS-provider table against stubbed DNS answers, and
 * `workers/setup-domain-state.test.ts` locks the local state machine. Neither
 * can answer the question that actually matters for this deployment: "is
 * `doforu.app` — and its siblings — currently wired up correctly in the real
 * world?" This script answers it by driving the same production handlers
 * against live DNS.
 *
 * HOW IT DRIVES PRODUCTION CODE
 * -----------------------------
 * The real `workers/setup.ts` Hono app is imported and mounted in-process via
 * `workers/setup-test-harness.ts`, exactly as the repo's tests do — only the
 * sub-app, bypassing the cookie-session `requireAuth` that `workers/index.ts`
 * layers on top. Requests go through `app.request(...)`, so the handlers,
 * their parsing, their normalisation and their response shaping are the
 * production ones.
 *
 * NOTHING IS MOCKED. `fetch` is NOT stubbed, so:
 *   - `verify-mx` performs a genuine Cloudflare DoH request
 *     (`https://cloudflare-dns.com/dns-query?name=<domain>&type=MX`) through
 *     the production `fetchWithTimeout`;
 *   - `detect-dns-provider` performs a genuine NS lookup via
 *     `node:dns`'s `resolveNs`.
 *
 * The DoH path is the trustworthy one on this machine: the local `dig` is
 * hijacked by a fake-IP resolver, but DoH over HTTPS is not, so the MX answers
 * printed below are the real published records.
 *
 * EXIT CODE
 * ---------
 *   0 — every domain: `verify-mx.verified === true` AND the detected provider
 *       is Cloudflare.
 *   1 — at least one domain failed either check (details are printed).
 *   2 — the probe could not run at all (harness/engine unavailable).
 *
 * The thresholds are NOT relaxed to make a run pass: if a domain genuinely
 * does not verify, that is reported and the exit code is non-zero.
 */

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

// ── Configuration ───────────────────────────────────────────────────

/** Domains expected to be wired up: Cloudflare NS + Email Routing MX. */
const DEFAULT_DOMAINS = [
	"doforu.app",
	"doforu.ai",
	"pennyresearch.com",
	"infspeed.com",
];

/** The provider every domain above is expected to resolve to. */
const EXPECTED_PROVIDER = "Cloudflare";

const REPO_ROOT = resolvePath(fileURLToPath(new URL("..", import.meta.url)));

// ── Harness (production code, no mocks) ─────────────────────────────

/**
 * `workers/setup-test-harness.ts` is TypeScript, so this script is run through
 * `tsx` (see the header). The specifier is an absolute `file://` URL so the
 * import does not depend on the process CWD.
 */
const HARNESS_URL = pathToFileURL(
	resolvePath(REPO_ROOT, "workers/setup-test-harness.ts"),
).href;

let harness;
try {
	harness = await import(HARNESS_URL);
} catch (err) {
	console.error(
		`[fatal] could not load the setup harness from ${HARNESS_URL}\n` +
			`        run this script with tsx, e.g.  npx tsx scripts/verify-domain-live.mjs\n` +
			`        cause: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(2);
}

// ── Helpers ─────────────────────────────────────────────────────────

const b = (value) => `\x1b[1m${value}\x1b[0m`;
const green = (value) => `\x1b[32m${value}\x1b[0m`;
const red = (value) => `\x1b[31m${value}\x1b[0m`;
const yellow = (value) => `\x1b[33m${value}\x1b[0m`;
const dim = (value) => `\x1b[2m${value}\x1b[0m`;

/** POST a JSON body through the real sub-app and parse the JSON response. */
async function postJson(app, path, body, env) {
	const res = await app.request(
		path,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { error: `non-JSON response: ${text.slice(0, 200)}` };
	}
	return { status: res.status, json };
}

/** Run both checks for one domain. Never throws — failures become data. */
async function checkDomain(app, env, domain) {
	const result = { domain, verified: false, mx: null, dns: null, problems: [] };

	// 1. POST /api/v1/setup/verify-mx — real Cloudflare DoH query.
	try {
		const { status, json } = await postJson(
			app,
			"/api/v1/setup/verify-mx",
			{ domain },
			env,
		);
		result.mx = { httpStatus: status, ...json };
		if (json.verified === true) {
			result.verified = true;
		} else if (typeof json.error === "string") {
			result.problems.push(`verify-mx returned error: ${json.error}`);
		} else {
			result.problems.push("MX did not match any accepted inbound target");
		}
	} catch (err) {
		result.problems.push(
			`verify-mx threw: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 2. POST /api/v1/setup/detect-dns-provider — real NS lookup.
	try {
		const { status, json } = await postJson(
			app,
			"/api/v1/setup/detect-dns-provider",
			{ domain },
			env,
		);
		result.dns = { httpStatus: status, ...json };
		if (json.provider !== EXPECTED_PROVIDER) {
			result.problems.push(
				`provider is "${json.provider}", expected "${EXPECTED_PROVIDER}"`,
			);
		}
	} catch (err) {
		result.problems.push(
			`detect-dns-provider threw: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return result;
}

// ── Main ────────────────────────────────────────────────────────────

const domains = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const targets = domains.length > 0 ? domains : DEFAULT_DOMAINS;

if (typeof harness.hasSqliteEngine !== "function" || !harness.hasSqliteEngine()) {
	console.error(
		"[fatal] the setup harness could not initialise (node:sqlite needs Node >= 22)",
	);
	process.exit(2);
}

const app = await harness.createSetupApp();
// Neither route needs D1 or R2 — only the ping/locale middleware defaults — but
// the handlers do read `c.env`, so an env object must be present.
const env = harness.createEnv(harness.createSqlite());

console.log(b("Mailboxes — live domain wiring probe"));
console.log(dim(`  app:     workers/setup.ts (mounted directly; requireAuth bypassed)`));
console.log(dim(`  network: REAL — Cloudflare DoH for MX, node:dns for NS (nothing mocked)`));
console.log(dim(`  expect:  every domain verifies AND resolves to ${EXPECTED_PROVIDER}`));
console.log("");

const results = [];
for (const domain of targets) {
	console.log(b(`── ${domain} ${"─".repeat(Math.max(0, 46 - domain.length))}`));

	const result = await checkDomain(app, env, domain);
	results.push(result);

	// verify-mx
	const mx = result.mx;
	if (!mx) {
		console.log(`  verify-mx           ${red("FAILED TO RUN")}`);
	} else {
		const mark = mx.verified === true ? green("verified: true ") : red("verified: false");
		console.log(`  verify-mx           ${mark}  ${dim(`(HTTP ${mx.httpStatus})`)}`);
		if (mx.error) console.log(`    error:            ${yellow(mx.error)}`);
		const records = Array.isArray(mx.records) ? mx.records : [];
		if (records.length === 0) {
			console.log(`    MX records:       ${dim("(none published)")}`);
		} else {
			for (const record of records) {
				const hit = mx.matched && mx.matched.exchange === record.exchange;
				console.log(
					`    MX ${String(record.priority).padStart(3)}            ${record.exchange}` +
						(hit ? `  ${green("<-- matched accepted target")}` : ""),
				);
			}
		}
		if (mx.matched) {
			console.log(
				`    matched:          priority ${mx.matched.priority}, exchange ${mx.matched.exchange}`,
			);
		} else {
			console.log(`    matched:          ${dim("null")}`);
		}
	}

	// detect-dns-provider
	const dns = result.dns;
	if (!dns) {
		console.log(`  detect-dns-provider ${red("FAILED TO RUN")}`);
	} else {
		const ok = dns.provider === EXPECTED_PROVIDER;
		console.log(
			`  detect-dns-provider ${(ok ? green("provider: ") : red("provider: ")) + b(dns.provider)}  ${dim(`(HTTP ${dns.httpStatus})`)}`,
		);
		const nameservers = Array.isArray(dns.nameservers) ? dns.nameservers : [];
		console.log(
			`    nameservers:      ${nameservers.length ? nameservers.join(", ") : dim("(none resolved)")}`,
		);
		if (dns.error) console.log(`    error:            ${yellow(dns.error)}`);
	}

	if (result.problems.length > 0) {
		for (const problem of result.problems) console.log(`  ${red("!")} ${problem}`);
	}
	console.log("");
}

// ── Summary ─────────────────────────────────────────────────────────

const verifiedCount = results.filter((r) => r.verified).length;
const cloudflareCount = results.filter(
	(r) => r.dns && r.dns.provider === EXPECTED_PROVIDER,
).length;
const allVerified = verifiedCount === results.length;
const allCloudflare = cloudflareCount === results.length;
const pass = allVerified && allCloudflare;

console.log(b("SUMMARY"));
console.log(
	`  verify-mx verified:        ${verifiedCount}/${results.length}` +
		(allVerified ? `  ${green("OK")}` : `  ${red("NOT ALL")}`),
);
console.log(
	`  provider == ${EXPECTED_PROVIDER}:${" ".repeat(Math.max(1, 12 - EXPECTED_PROVIDER.length))}` +
		`${cloudflareCount}/${results.length}` +
		(allCloudflare ? `  ${green("OK")}` : `  ${red("NOT ALL")}`),
);
console.log("");

if (pass) {
	console.log(
		green(b("PASS")) +
			` — all ${results.length} domains verify against the real inbound MX targets ` +
			`and resolve to ${EXPECTED_PROVIDER}.`,
	);
	process.exit(0);
}

for (const result of results) {
	const bad = !result.verified || !result.dns || result.dns.provider !== EXPECTED_PROVIDER;
	if (!bad) continue;
	console.log(
		red(b("FAIL")) +
			` — ${result.domain}: ${result.problems.length ? result.problems.join("; ") : "unknown"}`,
	);
}
process.exit(1);
