// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Domain-configuration regression guards for `workers/setup.ts`.
 *
 * Two checks live here, both about what a "correctly configured domain" looks
 * like in THIS fork:
 *
 *   1. `POST /api/v1/setup/verify-mx` — the handler used to compare a domain's
 *      MX against a SINGLE hard-coded literal, `mailboxes.pages.dev` (the
 *      upstream agentic-inbox deployment host). This fork does not deploy
 *      there, and real inbound mail arrives through Cloudflare Email Routing,
 *      whose MX records are always `route1/2/3.mx.cloudflare.net`. The old
 *      literal therefore reported EVERY correctly configured domain — e.g.
 *      `doforu.app` and `doforu.ai` — as `verified: false`. The handler now
 *      accepts a SET of inbound targets (`ACCEPTED_INBOUND_MX_TARGETS`),
 *      compares case-insensitively and ignores the trailing root dot that the
 *      DoH JSON answer carries. The cases below pin: a route*.mx.cloudflare.net
 *      answer passes (with the trailing dot and mixed case), all three route
 *      hosts pass (not just one), the legacy `mailboxes.pages.dev` still passes
 *      (no pass→fail regression), a foreign host fails with `matched: null`,
 *      and the pre-existing failure shape is unchanged.
 *
 *      Reverse verification: re-setting the comparison to the old
 *      `=== "mailboxes.pages.dev"` literal makes cases a/b/e FAIL.
 *
 *      A second `verify-mx` group pins the MATCH SEMANTICS: the check is a
 *      normalised EQUALITY test, so hosts that merely contain / prefix /
 *      suffix an accepted target (`evil-route1.mx.cloudflare.net`,
 *      `xroute1.mx.cloudflare.net`, `route1.mx.cloudflare.net.attacker.com`,
 *      `route1.mx.cloudflare.netX`, `mailboxes.pages.dev.attacker.com`) and
 *      the unlisted `route4.mx.cloudflare.net` must all answer
 *      `verified: false`, while the real targets pass in any letter case and
 *      with or without the trailing root dot.
 *
 *   2. `POST /api/v1/setup/detect-dns-provider` — the production
 *      `DNS_PROVIDERS` table plus the production
 *      `detectProviderFromNameservers` loop, driven through the REAL route.
 *      A suspected defect was that `/ns\d*\.cloudflare\.com/i` would NOT match
 *      the letter-prefixed Cloudflare nameservers actually handed out
 *      (`walt.ns.cloudflare.com`, `ziggy.ns.cloudflare.com`; confirmed by
 *      `dig`/DoH for `doforu.app`), so Cloudflare would be misreported as
 *      "Other".
 *
 *      That defect was REFUTED by running the exact regex against the samples:
 *      `\d*` is zero-or-more and `RegExp.test` matches UNANCHORED, so the
 *      pattern matches the `ns.cloudflare.com` substring of
 *      `walt.ns.cloudflare.com`. The regex is therefore deliberately UNCHANGED —
 *      these cases only LOCK the existing behavior so a future "tightening" to
 *      `ns\d+\.` or an `^` anchor cannot silently regress it, and they assert
 *      the non-Cloudflare providers still land in their own buckets.
 *
 *      HISTORY / why this group was rewritten: it used to RE-DECLARE
 *      `DNS_PROVIDERS` and re-implement the loop in the test, because both
 *      symbols are module-private in `setup.ts`. That made the assertions test
 *      a COPY: renaming the production Cloudflare row to "BrokenProvider" left
 *      the suite fully green, i.e. the cases protected the production table
 *      ZERO. The copy is gone; the cases now drive the real route with
 *      `mock.module("node:dns")` serving `dns.promises.resolveNs`, so a change
 *      to the production table or to the detection loop turns them RED.
 *
 * No test in this file performs a real DNS/HTTP request: the DoH call goes
 * through a `mock.module` stub of `./lib/fetch-with-timeout`, and the
 * nameserver cases are fed by a `mock.module` stub of `node:dns`.
 *
 * To run: npm test
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Hono } from "hono";

// ── DoH stub ────────────────────────────────────────────────────────
//
// `setup.ts` performs the DoH query with `fetchWithTimeout` imported from
// `./lib/fetch-with-timeout`. That is the only network call on the verify-mx
// path, so replacing the module with a scripted stub makes the whole route
// deterministic. The stub hands back a real `Response`, mirroring the
// `application/dns-json` payload Cloudflare's DoH endpoint returns.
type DohAnswer = { type: number; data: string; TTL: number };

let nextDohResponse: () => Response = () => {
	throw new Error("nextDohResponse was not configured");
};

const mockFetchWithTimeout = mock.fn(
	async (_url: string | URL, _options: RequestInit = {}): Promise<Response> =>
		nextDohResponse(),
);

mock.module("./lib/fetch-with-timeout", {
	namedExports: { fetchWithTimeout: mockFetchWithTimeout },
});

// ── NS answer for the /detect-dns-provider stub ─────────────────────
//
// A `mock.fn` — NOT a captured closure over a mutable variable — is what makes
// the answer re-scriptable per case. Under `tsx` this file is transpiled to
// CJS, and `mock.module` SNAPSHOTS its options bag at registration time: a
// closure reading a later-reassigned module-level binding (or a mutated
// object property) keeps serving the value captured at import, which silently
// pinned every case to the FIRST scripted answer (observed as a route that
// returned the previous case's NS set). `mockImplementation` on a `mock.fn`
// mutates the object the route actually holds, so each case really re-scripts.
//
// The final implementation intentionally THROWS: a case that forgets to script
// an answer must fail loudly instead of resolving something the real world
// never said. Returns either an NS list, or rejects like a resolver failure
// (NXDOMAIN / timeout) — see the `resolveNs` cases further down.
//
// Registered HERE, before `import("./setup")`: module mocks only bind to
// modules loaded AFTER the registration, so a later `mock.module("node:dns")`
// would leave `setup.ts` holding the REAL resolver (observed as the route
// answering from a live lookup while the stub's call count stayed 0).
const resolveNsStub = mock.fn(
	async (_domain: string): Promise<string[]> => {
		throw new Error("resolveNsStub was not scripted for this case");
	},
);

// A deliberately MINIMAL `node:dns`: only `promises.resolveNs` — the single
// entry point these routes use — is provided, and it is deny-by-default (a
// case must script an answer via `scriptNameservers`). Every other method is
// left ABSENT rather than stubbed, so a future change that reaches for a
// different lookup fails loudly instead of quietly hitting the real resolver.
//
// NOTE: this must be a `defaultExport`-only mock. Node's module mocker cannot
// carry `namedExports` alongside a default export here: adding a
// `namedExports.promises` SHADOWS the default export's own `promises` and
// breaks `dns.promises.resolveNs` (confirmed by hand against Node 24).
mock.module("node:dns", {
	defaultExport: { promises: { resolveNs: resolveNsStub } },
});

/** Script the answer the next `resolveNs` call receives (an NS list). */
function scriptNameservers(nameservers: string[]): void {
	resolveNsStub.mock.mockImplementation(async () => nameservers);
}

/** Script a resolver REJECTION (NXDOMAIN / timeout) for the next call. */
function scriptNameserverFailure(): void {
	resolveNsStub.mock.mockImplementation(async () => {
		throw new Error("ENOTFOUND");
	});
}

// Imported AFTER the module mock so the route binds the stub.
const { default: setup } = await import("./setup");

// A standalone Hono mount: verify-mx needs no D1/R2 binding, so no `env` shim
// is required and nothing else in setup.ts is exercised by the import.
const app = new Hono();
app.route("/", setup);

/** Build a DoH JSON answer of MX records (`type: 15`), as Cloudflare emits it. */
function mxResponse(exchanges: string[]): Response {
	const Answer: DohAnswer[] = exchanges.map((data, i) => ({
		type: 15,
		data: `${(i + 1) * 2} ${data}`, // "priority exchange"
		TTL: 300,
	}));
	return Response.json({ Status: 0, Answer });
}

async function postVerifyMx(domain: string): Promise<{
	status: number;
	body: Record<string, unknown>;
}> {
	const res = await app.request("/api/v1/setup/verify-mx", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ domain }),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ── verify-mx ───────────────────────────────────────────────────────

describe("verify-mx accepts the real inbound MX targets", () => {
	it("passes on route1.mx.cloudflare.net with a trailing dot and mixed case", async () => {
		// The DoH answer string is what lands in `matched.exchange`; the handler
		// strips the trailing dot when parsing but the target set must also
		// tolerate it. Feed the mixed-case + trailing-dot form on purpose.
		nextDohResponse = () => mxResponse(["Route1.MX.Cloudflare.NET."]);
		const { status, body } = await postVerifyMx("doforu.app");

		assert.equal(status, 200);
		assert.equal(body.verified, true, "a Cloudflare Email Routing MX must verify");
		assert.deepEqual(body.matched, {
			priority: 2,
			exchange: "Route1.MX.Cloudflare.NET", // trailing dot stripped by the parser
		});
	});

	it("passes on every route*.mx.cloudflare.net host, not just one", async () => {
		// Guards the fix at the level that matters: the set is CONSULTED, so the
		// other two Cloudflare Email Routing hosts also verify. Reverting to the
		// single `mailboxes.pages.dev` literal fails this case.
		for (const exchange of [
			"route1.mx.cloudflare.net.",
			"route2.mx.cloudflare.net.",
			"route3.mx.cloudflare.net.",
		]) {
			nextDohResponse = () => mxResponse([exchange]);
			const { body } = await postVerifyMx("doforu.ai");
			assert.equal(
				body.verified,
				true,
				`${exchange} should be accepted as a valid inbound MX target`,
			);
			assert.ok(body.matched, "matched must point at the record that hit");
		}
	});

	it("matches a route host at Cloudflare's real priority (case-insensitive)", async () => {
		// Priorities 2/68/70 are what Cloudflare Email Routing publishes; the
		// matcher must be priority-agnostic (it keys on the exchange only).
		nextDohResponse = () => mxResponse(["route3.mx.cloudflare.net."]);
		const { body } = await postVerifyMx("example.com");
		const records = body.records as Array<{ priority: number; exchange: string }>;
		// mxResponse assigned priority (i+1)*2 = 2 for the single record.
		assert.equal(records[0].priority, 2);
		assert.equal(body.verified, true);
	});

	it("still passes on the legacy mailboxes.pages.dev target (compatibility)", async () => {
		nextDohResponse = () => mxResponse(["mailboxes.pages.dev."]);
		const { status, body } = await postVerifyMx("legacy.example");

		assert.equal(status, 200);
		assert.equal(body.verified, true, "the old upstream target must not regress to fail");
		assert.deepEqual(body.matched, { priority: 2, exchange: "mailboxes.pages.dev" });
	});

	it("fails a foreign MX host and returns matched: null", async () => {
		nextDohResponse = () => mxResponse(["smtp.google.com."]);
		const { status, body } = await postVerifyMx("gmail-ish.example");

		assert.equal(status, 200);
		assert.equal(body.verified, false);
		assert.equal(body.matched, null, "an unmatched MX yields matched: null");
		// The records are still reported so the UI can show what was found.
		assert.deepEqual(body.records, [{ priority: 2, exchange: "smtp.google.com" }]);
	});

	it("returns verified:false + records:[] when the domain has no MX records", async () => {
		// A successful DoH lookup whose Answer carries no type-15 record is the
		// "domain has no MX yet" shape: not an exception, just an empty match.
		nextDohResponse = () => Response.json({ Status: 0, Answer: [] });
		const { status, body } = await postVerifyMx("no-mx.example");

		assert.equal(status, 200);
		assert.equal(body.verified, false);
		assert.equal(body.matched, null);
		assert.deepEqual(body.records, []);
	});

	it("keeps the existing failure shape when the DoH request throws", async () => {
		// The handler's catch returns `{ verified: false, error, records: [] }`
		// (no `matched` key) and a 200. Asserted as-is so the shape is pinned.
		nextDohResponse = () => {
			throw new Error("network down");
		};
		const { status, body } = await postVerifyMx("broken.example");

		assert.equal(status, 200);
		assert.equal(body.verified, false);
		assert.deepEqual(body.records, []);
		assert.equal(typeof body.error, "string");
		assert.ok((body.error as string).length > 0, "a localized error string is returned");
	});

	it("rejects a missing domain with 400", async () => {
		const res = await app.request("/api/v1/setup/verify-mx", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(res.status, 400);
	});
});

// ── verify-mx: EXACT match, not substring ───────────────────────────
//
// The accepted-MX check must be a normalised EQUALITY test, never a substring
// or suffix containment. These cases pin that semantic from both sides:
//
//   - a host that merely CONTAINS an accepted target (`evil-route1…`),
//     PREFIXES one (`xroute1…`), SUFFIXES an accepted target with extra labels
//     (`route1.mx.cloudflare.net.attacker.com`), or extends its final label
//     (`route1.mx.cloudflare.netX`) must NOT verify;
//   - a DIFFERENT Cloudflare route host that is not in the set (`route4…`)
//     must NOT verify — the set is a whitelist, not a `route\d` family;
//   - an unrelated accepted host with an attacker suffix
//     (`mailboxes.pages.dev.attacker.com`) must NOT verify;
//   - the genuinely accepted hosts still DO verify, in any letter case and
//     with or without the trailing root dot.
//
// Without these, switching the production check to `.includes(...)` on a
// substring (or a `startsWith`/`endsWith` test) would keep the suite green
// while accepting attacker-controlled zones — the exact class of bug this set
// exists to prevent. All answers come from the mocked DoH stub; no DNS is
// contacted.

describe("verify-mx requires EXACT equality with an accepted target", () => {
	it("rejects hosts that merely CONTAIN an accepted target", async () => {
		for (const exchange of [
			"route1.mx.cloudflare.net.attacker.com",
			"evil-route1.mx.cloudflare.net",
			"xroute1.mx.cloudflare.net",
			"route1.mx.cloudflare.netX",
			"mailboxes.pages.dev.attacker.com",
		]) {
			nextDohResponse = () => mxResponse([exchange]);
			const { status, body } = await postVerifyMx("victim.example");

			assert.equal(status, 200);
			assert.equal(
				body.verified,
				false,
				`${exchange} must NOT verify: it is not exactly an accepted target`,
			);
			assert.equal(body.matched, null, `${exchange} must not produce a match`);
			// The offending record is still reported, so the UI can show it.
			assert.deepEqual(body.records, [{ priority: 2, exchange: exchange.replace(/\.$/, "") }]);
		}
	});

	it("rejects an unlisted Cloudflare route host (the set is a whitelist)", async () => {
		// `route4` is NOT one of the three hosts Cloudflare Email Routing
		// publishes, so it must not pass merely by looking similar.
		nextDohResponse = () => mxResponse(["route4.mx.cloudflare.net"]);
		const { body } = await postVerifyMx("victim.example");

		assert.equal(body.verified, false, "route4.mx.cloudflare.net is not an accepted target");
		assert.equal(body.matched, null);
	});

	it("accepts an exact target regardless of letter case or trailing dot", async () => {
		for (const [exchange, expectedExchange] of [
			["ROUTE1.MX.CLOUDFLARE.NET", "ROUTE1.MX.CLOUDFLARE.NET"],
			["Route3.MX.Cloudflare.NET.", "Route3.MX.Cloudflare.NET"],
			["MAILBOXES.PAGES.DEV.", "MAILBOXES.PAGES.DEV"],
		] as const) {
			nextDohResponse = () => mxResponse([exchange]);
			const { body } = await postVerifyMx("doforu.app");

			assert.equal(body.verified, true, `${exchange} must verify (case/root-dot insensitive)`);
			// The parser strips the trailing dot but preserves the original case.
			assert.deepEqual(body.matched, { priority: 2, exchange: expectedExchange });
		}
	});
});

// ── POST /api/v1/setup/detect-dns-provider ──────────────────────────
//
// These cases drive the REAL route and assert its `provider` field, so what is
// under test is the PRODUCTION provider table plus the PRODUCTION detection
// loop in `workers/setup.ts` — not a transcription of them.
//
// ── Why this is a rewrite (the defect this section used to have) ────────────
// `DNS_PROVIDERS` and `detectProviderFromNameservers` are module-private, and
// an earlier revision of this file solved that by RE-DECLARING the whole table
// and re-implementing the loop here. That made the four cases below assert a
// COPY: mutating the production table (e.g. renaming its Cloudflare row to
// "BrokenProvider") left the suite fully green, i.e. the cases protected the
// production table ZERO. The copy is gone; nothing below names a provider or a
// nameserver pattern. The only literals are domain-ish nameservers that must
// resolve to a provider, which is what a route-level test can honestly state.
//
// ── How the route is driven offline ────────────────────────────────────────
// The route resolves the NS set through `dns.promises.resolveNs(domain)` (the
// module-private `dns` import at the top of `setup.ts`). Stubbing that default
// export — Node's `--experimental-test-module-mocks`, already in `npm test` —
// makes the deny-by-default module stub below serve the answer, with NO real
// resolver and no DoH traffic. Verified by hand before being encoded: a
// deliberately wrong stub would otherwise be indistinguishable from a real
// lookup.
//
// MUTATION EVIDENCE (what makes these cases load-bearing):
//   - rename the production Cloudflare row to "BrokenProvider" → the two
//     Cloudflare cases FAIL;
//   - drop "route2…" from a production list these cases pin → that case FAILS.

// The stub itself, and the two scripting helpers, are registered near the top
// of this file (before `import("./setup")`) — see the `node:dns` section there.

async function postDetectProvider(domain: string): Promise<{
	status: number;
	body: Record<string, unknown>;
}> {
	const res = await app.request("/api/v1/setup/detect-dns-provider", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ domain }),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/v1/setup/detect-dns-provider — production table, real route", () => {
	it("matches the letter-prefixed Cloudflare nameservers actually in use", async () => {
		// `doforu.app` serves exactly these two (confirmed via dig/DoH). The
		// suspected defect — that the Cloudflare pattern misses them — is false:
		// the pattern's digit run is zero-or-more and `RegExp.test` is unanchored.
		// These cases lock that in, so a future "tightening" of the pattern (or
		// anchoring it with `^`) cannot silently regress the common case.
		for (const nameservers of [
			["walt.ns.cloudflare.com"],
			["ziggy.ns.cloudflare.com"],
			["walt.ns.cloudflare.com", "ziggy.ns.cloudflare.com"],
		]) {
			scriptNameservers(nameservers);
			const { status, body } = await postDetectProvider("doforu.app");
			assert.equal(status, 200);
			// The route echoes the RESOLVED set, so this also proves the stub was
			// consulted (a mis-wired mock would report an empty set).
			assert.deepEqual(body.nameservers, nameservers);
			assert.equal(
				body.provider,
				"Cloudflare",
				`the production table must classify ${nameservers.join(", ")} as Cloudflare`,
			);
		}
	});

	it("still matches the numeric ns1 form", async () => {
		for (const nameserver of ["ns1.cloudflare.com", "ns3.cloudflare.com"]) {
			scriptNameservers([nameserver]);
			const { body } = await postDetectProvider("doforu.app");
			assert.equal(body.provider, "Cloudflare", `${nameserver} must classify as Cloudflare`);
		}
	});

	it("keeps non-Cloudflare providers in their own buckets", async () => {
		// `Other` for a provider the table does not (yet) know, and the two
		// buckets that are most likely to be confused with Cloudflare.
		for (const [nameserver, provider] of [
			["dns1.p01.nsone.net", "Other"],
			["ns1.google.com", "Google Cloud DNS"],
			["ns-123.awsdns-45.org", "AWS Route 53"],
			["ns-99.awsdns-01.com", "AWS Route 53"],
		] as const) {
			scriptNameservers([nameserver]);
			const { body } = await postDetectProvider("example.com");
			assert.equal(body.provider, provider, `${nameserver} must classify as ${provider}`);
		}
	});

	it("cloudflare.com is matched case-insensitively", async () => {
		scriptNameservers(["WALT.NS.CLOUDFLARE.COM"]);
		const { body } = await postDetectProvider("doforu.app");
		assert.equal(body.provider, "Cloudflare");
	});

	it("reports Other when the nameserver lookup throws (NXDOMAIN/timeout)", async () => {
		// The route swallows a resolver failure and returns an EMPTY set with
		// `Other` — 200, never a 5xx. Pinned as-is; also the proof that the
		// stub above is not merely echoing a hard-coded success.
		scriptNameserverFailure();
		const { status, body } = await postDetectProvider("nx.example");
		assert.equal(status, 200);
		assert.equal(body.provider, "Other");
		assert.deepEqual(body.nameservers, []);
	});

	it("rejects a missing domain with 400 without touching the resolver", async () => {
		// An UNSCRIPTED stub (back to its throwing default) is left in place: if
		// a 400 ever reached the resolver, the request would surface the
		// rejection instead of the client error asserted below.
		resolveNsStub.mock.mockImplementation(async () => {
			throw new Error("the resolver must not run for a 400");
		});
		const res = await app.request("/api/v1/setup/detect-dns-provider", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(res.status, 400);
	});
});
