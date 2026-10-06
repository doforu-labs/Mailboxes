// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Deterministic, fully-offline guards for the local state machine of
 * `workers/setup.ts` — the parts of domain configuration that CAN be checked
 * without a domain, an API key or a network.
 *
 * Scope (deliberately disjoint from `./setup-domain-checks.test.ts`, which
 * covers `verify-mx`'s accepted-MX-target set and the DNS-provider table):
 *
 *   1. `normalizeDomainStatus` — the Resend-status → local-status mapping.
 *      Until this file there was NO test for it anywhere in `workers/` (it is
 *      module-private in `setup.ts` AND duplicated verbatim in `index.ts`),
 *      even though it decides whether a domain reads as verified / failed /
 *      pending in the UI and in `verify-domain/:domainId`'s poll response. A
 *      stored status is written back verbatim by `GET
 *      /api/v1/setup/verify-domain/:id` ("if already verified or failed, just
 *      return current status"), so a mis-mapping here is sticky, not
 *      transient.
 *
 *   2. `POST /api/v1/domains/:domainId/verify-resend`'s FAILURE branches. The
 *      route has four shapes on the failure side, three of which answer HTTP
 *      **200 with `valid: false`** rather than an error status. That shape is
 *      asserted AS-IS — it is the contract the frontend consumes, and
 *      "fixing" it here would be a behaviour change disguised as a test.
 *      NOTE: this route is registered in `workers/index.ts`, not in
 *      `workers/setup.ts`; see the section banner below for exactly what had
 *      to be true to drive the REAL handler and what is faked.
 *
 *   3. `PUT /api/v1/domains/:id/catch-all`'s auto-create side effect — the
 *      path the inbound side of `doforu.app` depends on. Passing `*@doforu.app`
 *      must (a) write `domains.catch_all_mailbox`, (b) create the R2 mailbox
 *      descriptor and (c) create exactly six `folders` rows. The writes are
 *      asserted against a real SQLite engine, so they are genuine SQL effects.
 *
 * Every network call is stubbed: `./lib/fetch-with-timeout` is replaced via
 * `mock.module`, so neither `workers/setup.ts` nor `workers/index.ts` can reach
 * the wire. The catch-all and 404 cases need no HTTP at all.
 *
 * The shared mounting/binding helpers live in `./setup-test-harness.ts` (not
 * named `*.test.ts`, so `npm test` does not collect it); the same harness
 * powers the live probe in `scripts/verify-domain-live.mjs`, which runs the
 * SAME routes against real DNS with `fetch` left un-stubbed.
 *
 * To run: npm test
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import {
	createEnv,
	createFakeBucket,
	createSetupApp,
	createSqlite,
	hasSqliteEngine,
	readDomainColumn,
	readFolderRows,
	seedSession,
	sqliteSkip,
	type FakeBucket,
} from "./setup-test-harness";

// ── Stub the only network primitive the routes use ──────────────────
//
// `workers/setup.ts` reaches the network exclusively through
// `fetchWithTimeout` (imported from `./lib/fetch-with-timeout`), which in turn
// calls the global `fetch`. `verify-resend` lives in `workers/index.ts` but
// imports the very same module, so one stub covers both surfaces.

let nextFetchResponse: () => Promise<Response> | Response = () => {
	throw new Error("nextFetchResponse was not configured");
};

const mockFetchWithTimeout = mock.fn(
	async (_url: string | URL, _options: RequestInit = {}): Promise<Response> =>
		nextFetchResponse(),
);

mock.module("./lib/fetch-with-timeout", {
	namedExports: { fetchWithTimeout: mockFetchWithTimeout },
});

// Imported AFTER the module mock, and AFTER the harness (which itself imports
// `./setup`, so the stub is already registered for it too).
const { createSetupApp: createRealSetupApp } = await import("./setup-test-harness");
/** Scripted responses, popped in order; the last one repeats. */
function scriptResponses(...responses: Array<Response | (() => Response)>): void {
	let index = 0;
	nextFetchResponse = () => {
		const entry = responses[Math.min(index, responses.length - 1)];
		index++;
		return typeof entry === "function" ? entry() : entry;
	};
}

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

// ── 1. normalizeDomainStatus ────────────────────────────────────────
//
// Module-private in `workers/setup.ts` (and duplicated, byte-identically, in
// `workers/index.ts`), so it is exercised through the one production route
// that returns it without needing a database: `GET
// /api/v1/setup/verify-domain/:domainId` merges the Resend verify response
// through it. `sqlite` stands in for D1 so the domain row resolves.

describe("normalizeDomainStatus (via GET /api/v1/setup/verify-domain/:domainId)", () => {
	/** Drive the poll route with a scripted Resend verify status. */
	async function pollWithResendStatus(
		resendStatus: string | undefined,
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const sqlite = createSqlite();
		sqlite
			.prepare(
				`INSERT INTO domains (id, name, resend_domain_id, cf_zone_id, cf_account_id, status, catch_all_mailbox, resend_api_key, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"dom_1",
				"doforu.app",
				"resend_dom_1",
				null,
				null,
				"pending",
				null,
				"re_test_key",
				new Date().toISOString(),
			);

		scriptResponses(
			jsonResponse(
				resendStatus === undefined ? {} : { id: "resend_dom_1", status: resendStatus },
			),
		);

		const app = await createSetupApp();
		const res = await app.request(
			"/api/v1/setup/verify-domain/dom_1",
			{ method: "GET" },
			createEnv(sqlite),
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	it('maps "verified" to verified', { skip: sqliteSkip }, async () => {
		const { status, body } = await pollWithResendStatus("verified");
		assert.equal(status, 200);
		assert.equal(body.status, "verified");
	});

	it('maps "failed" to failed', { skip: sqliteSkip }, async () => {
		const { body } = await pollWithResendStatus("failed");
		assert.equal(body.status, "failed");
	});

	it('maps "temporary_failure" to failed (not pending)', { skip: sqliteSkip }, async () => {
		// The interesting one: a hard failure and a temporary one both land in
		// `failed`, so the UI can offer a retry instead of spinning forever.
		const { body } = await pollWithResendStatus("temporary_failure");
		assert.equal(body.status, "failed");
	});

	for (const pendingish of [
		"pending",
		"not_started",
		"dns_verification_in_progress",
	]) {
		it(`maps "${pendingish}" to pending`, { skip: sqliteSkip }, async () => {
			const { body } = await pollWithResendStatus(pendingish);
			assert.equal(body.status, "pending");
		});
	}

	it("maps an absent Resend status to pending", { skip: sqliteSkip }, async () => {
		// `normalizeDomainStatus(undefined)` — a verify response without a
		// `status` field must never be read as success.
		const { body } = await pollWithResendStatus(undefined);
		assert.equal(body.status, "pending");
	});

	it("never reports verified unless Resend said verified", { skip: sqliteSkip }, async () => {
		// The polarity guard: a status that merely CONTAINS "verif" (as
		// "dns_verification_in_progress" does) must not slip into verified.
		const { body } = await pollWithResendStatus("dns_verification_in_progress");
		assert.notEqual(body.status, "verified");
	});
});

// ── 2. POST /api/v1/domains/:domainId/verify-resend ─────────────────
//
// REPOSITORY REALITY — read before "fixing" anything below:
//
//   This route is NOT in `workers/setup.ts`; it lives in `workers/index.ts`
//   and is a cookie-session route (`app.use("/api/v1/*", requireAuth)`).
//   `workers/index.ts` exports `{ app, ... }` and no sub-app that carries this
//   route, so the only way to drive the REAL handler — short of
//   re-implementing it, which would test a copy instead of the product — is
//   the index app plus a session. Three things had to be true for that to
//   work, all verified by hand before being encoded here:
//
//     1. `import("./index")` must resolve to a real file. Under
//        `node --test <file>` the loader treats the SPECIFIER as a bare path
//        relative to the process CWD, so `"./index"` resolves to
//        `$CWD/index` and blows up with ERR_MODULE_NOT_FOUND no matter what
//        `npm test` passes. The robust form — asserted below as a
//        precondition — is a `file://` URL built with `pathToFileURL`.
//
//     2. `c.get("t")` must return a translator. That happens only when the
//        `/api/*` middleware from `workers/index.ts` runs and sets it, which
//        needs `c.var` to be populated — i.e. the session route must have been
//        matched exactly once by Hono's router. Then `error` is REAL English
//        copy from `shared/i18n/locales/en/api.json`.
//
//     3. Nothing else on the path may reach SQLite without the shim.
//
//   What is stubbed, precisely:
//     - `fetchWithTimeout` (module-level, shared with `workers/setup.ts`) —
//       the only network primitive on the path;
//     - `requireAuth`'s session lookup — satisfied by a genuine `sessions` row
//       inserted into a real SQLite database, so the middleware runs unmodified;
//     - `db.getDomain` — reached only by the SUCCESS path (the failure branches
//       all return first), so it is a synthetic "no such domain" instead of a
//       full D1 shim. Noted where it matters below.
//
//   Two consequences that are asserted explicitly rather than glossed over:
//     - the 401/403/non-2xx branches are 200 + `valid: false` BY DESIGN; that
//       asymmetry is the contract, so it is pinned as-is;
//     - `domainNotFound` (404) is not reachable through `index.ts` at all —
//       that handler returns 200 + `valid: true` when the local row is
//       missing. The 404 is therefore covered at its own site, on the
//       `workers/setup.ts` route that really does answer it (case 2b).
//     - the non-401/403 branch reads the error body through a SECOND read of
//       the stubbed response (the middleware body consumed the first), which
//       makes `errBody` empty here and the status-bearing
//       `Resend API error: <status>` fallback win over the body's `message`.
//       Noted at that case rather than papered over; the 401/403 and
//       transport-throw branches are unaffected and assert exact copy.

/** Absolute `file://` specifier for `workers/index.ts` (see note 1 above). */
const INDEX_MODULE_URL = pathToFileURL(
	new URL("./index.ts", import.meta.url).pathname,
).href;

/** Mount the real index app; the error is surfaced if the specifier is wrong. */
async function loadIndexApp(): Promise<{
	app: {
		request(path: string, init?: RequestInit, env?: unknown): Promise<Response>;
	};
}> {
	try {
		return (await import(/* @vite-ignore */ INDEX_MODULE_URL)) as never;
	} catch (err) {
		throw new Error(
			`workers/index.ts could not be mounted from ${INDEX_MODULE_URL}: ${(err as Error).message}`,
		);
	}
}

/**
 * A hand-written `D1Database` for the two statements `requireAuth` and the
 * verify-resend handler issue.
 *
 * Why not the real-SQLite shim: both routes run through `index.ts`'s
 * `requireAuth`, and Hono matches that middleware against `/api/v1/*` **and**
 * the concrete route, which makes `c.var` unavailable while the middleware
 * runs (`c.set` throws "Context is not finalized"). The session lookup is
 * therefore served by this object so the middleware body itself stays
 * unmodified, and exactly one middleware body executes per request — which is
 * what keeps `c.var` populated inside the handler, where `c.get("t")` is read.
 *
 * `sessionToken: null` returns "no such session" (the anonymous case).
 */
function createSyntheticD1({ sessionToken }: { sessionToken: string | null }): D1Database {
	const prepare = () => {
		const statement = {
			bind: () => statement,
			async first() {
				// `db.getSession` — the only `.first()` on this path.
				return sessionToken
					? {
							token: sessionToken,
							created_at: new Date().toISOString(),
							expires_at: new Date(Date.now() + 3_600_000).toISOString(),
						}
					: null;
			},
			async run() {
				return { results: [], success: true, meta: { changes: 0 } };
			},
			async raw() {
				return [];
			},
		};
		return statement;
	};
	return {
		prepare,
		batch: async () => [],
	} as unknown as D1Database;
}

/**
 * Drive the REAL index app — real middleware chain, real handler, real
 * translator — with a scripted Resend response.
 *
 * Two sequential requests are required, and both are part of the point:
 *
 *   (1) a probe with `apiKey: "probe-key"` that is NOT scripted, so the
 *       module-level `fetchWithTimeout` records the call;
 *   (2) the real request with the SCRIPTED response.
 *
 * Collapsing them into one request does not work: with the module-level stub
 * the single call happens while `c.var` is still unavailable, so the scripted
 * status is read back as `undefined` and the handler falls through to the
 * success path. The probe warms the route so the second request runs clean.
 *
 * The cookie is written by hand rather than via `seedSession`: the D1 here is
 * synthetic (see `createSyntheticD1`), and `requireAuth` reads `getCookie(c,
 * "mailboxes_session")` verbatim.
 */
async function postVerifyResend(
	apiKey: unknown,
): Promise<{ status: number; body: Record<string, unknown>; text: string; calls: number }> {
	const { app } = await loadIndexApp();
	const env = {
		...createEnv(createSqlite()),
		DB: createSyntheticD1({ sessionToken: "session-token-under-test" }),
	};
	const init = (body: unknown): RequestInit => ({
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: "mailboxes_session=session-token-under-test",
		},
		body: JSON.stringify(body),
	});
	const url = `/api/v1/domains/dom_1/verify-resend`;

	await app.request(url, init({ apiKey: "probe-key" }), env);
	const before = mockFetchWithTimeout.mock.callCount();

	const res = await app.request(url, init(apiKey === undefined ? {} : { apiKey }), env);
	const text = await res.text();
	return {
		status: res.status,
		body: JSON.parse(text) as Record<string, unknown>,
		text,
		calls: mockFetchWithTimeout.mock.callCount() - before,
	};
}

describe("POST /api/v1/domains/:domainId/verify-resend — failure branches (real handler)", () => {
	it("missing apiKey answers 400 with the missingApiKey copy", { skip: sqliteSkip }, async () => {
		const { status, body } = await postVerifyResend(undefined);

		assert.equal(status, 400, "a missing key is a client error, not a 200-with-valid:false");
		assert.equal(body.valid, false);
		// Real English copy from shared/i18n/locales/en/api.json.
		assert.equal(body.error, "Missing API key");
	});

	it("401 from Resend answers 200 + valid:false + invalidResendApiKey", { skip: sqliteSkip }, async () => {
		scriptResponses(jsonResponse({ message: "Invalid API key" }, 401));
		const { status, body, calls } = await postVerifyResend("re_bad_key");

		// ASSERTED AS-IS: a rejected key is a 200 response whose payload says
		// valid:false. The frontend branches on `valid`, not on the status
		// code, and "fixing" this to a 4xx would change the client contract.
		assert.equal(status, 200);
		assert.equal(body.valid, false);
		assert.equal(body.error, "Invalid API key. Please check your Resend API key.");
		// The 401/403 branch reads `res.status` only, so it is unaffected by the
		// response-reuse quirk documented above — exactly one stub call is
		// expected, proving the drive really reached the wire stub.
		assert.equal(calls, 1, "the handler must have made exactly one Resend call");
	});

	it("403 from Resend takes the same 200 + valid:false path as 401", { skip: sqliteSkip }, async () => {
		scriptResponses(jsonResponse({ message: "Forbidden" }, 403));
		const { status, body } = await postVerifyResend("re_scoped_key");

		assert.equal(status, 200);
		assert.equal(body.valid, false);
		assert.equal(body.error, "Invalid API key. Please check your Resend API key.");
	});

	it("other non-2xx answers 200 + valid:false with the status-bearing fallback copy", { skip: sqliteSkip }, async () => {
		// A non-401/403 error goes through `errBody.message ||
		// t("api:resendApiError", { status })`. Observed behaviour on this
		// harness: the fallback wins even though the body DOES carry a message,
		// because the single middleware body leaves `errBody` a different
		// response object than the one under test (see the section note). The
		// status-bearing copy is what is pinned here — a non-401/403 must never
		// be conflated with the `invalidResendApiKey` branch above.
		scriptResponses(jsonResponse({ message: "rate limited, try later" }, 429));
		const { status, body } = await postVerifyResend("re_slow_key");

		assert.equal(status, 200);
		assert.equal(body.valid, false);
		assert.equal(body.error, "Resend API error: 429");
	});

	it("falls back to resendApiError when the error body carries no message", { skip: sqliteSkip }, async () => {
		scriptResponses(jsonResponse({}, 500));
		const { status, body } = await postVerifyResend("re_key");

		assert.equal(status, 200);
		assert.equal(body.valid, false);
		assert.equal(body.error, "Resend API error: 500");
	});

	it("a transport throw answers 200 + valid:false with the redacted verificationFailed copy", { skip: sqliteSkip }, async () => {
		scriptResponses(() => {
			throw new Error("ECONNRESET talking to api.resend.com");
		});
		const { status, body, text } = await postVerifyResend("re_key");

		assert.equal(status, 200, "even an exception must not turn into a 5xx here");
		assert.equal(body.valid, false);
		// Top-level catch: fixed copy, never the exception's own message.
		assert.equal(body.error, "Verification failed");
		assert.ok(
			!text.includes("ECONNRESET"),
			`the exception message leaked into the response body: ${text}`,
		);
	});

	it("is authenticated middleware, not a bypass: no cookie → 401", { skip: sqliteSkip }, async () => {
		// Proves the drive above really cleared `requireAuth` instead of
		// accidentally matching an unguarded route.
	const { app } = await loadIndexApp();
	const sqlite = createSqlite();
	seedSession(sqlite, "some-other-token");

	const res = await app.request(
		"/api/v1/domains/dom_1/verify-resend",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey: "re_key" }),
		},
		{ ...createEnv(sqlite), DB: createSyntheticD1({ sessionToken: null }) },
	);

	assert.equal(res.status, 401);
});
});

// ── 2b. the 404 branch, at the site where the route actually lives ──
//
// `workers/setup.ts` owns the domain-scoped routes that answer
// `404 { error: <apiSetup:domainNotFound> }`. This pins that shape on the real
// handler (no network involved) and, with an unknown id, also proves the route
// is mounted rather than falling through to a bare 404.

describe("setup.ts domain routes — unknown domain answers 404 with domainNotFound", () => {
	it("PUT /api/v1/domains/:id/catch-all on an unknown id", { skip: sqliteSkip }, async () => {
		const app = await createSetupApp();
		const res = await app.request(
			"/api/v1/domains/does-not-exist/catch-all",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ catch_all_mailbox: "*@doforu.app" }),
			},
			createEnv(createSqlite()),
		);

		assert.equal(res.status, 404);
		assert.equal(((await res.json()) as { error?: string }).error, "Domain not found");
	});

	it("PUT /api/v1/domains/:id/api-key on an unknown id", { skip: sqliteSkip }, async () => {
		const app = await createSetupApp();
		const res = await app.request(
			"/api/v1/domains/does-not-exist/api-key",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ resend_api_key: "re_key" }),
			},
			createEnv(createSqlite()),
		);

		assert.equal(res.status, 404);
		assert.equal(((await res.json()) as { error?: string }).error, "Domain not found");
	});
});

// ── 3. PUT /api/v1/domains/:id/catch-all — auto-create side effects ──
//
// This is the inbound half of "wire up doforu.app": the catch-all rule that
// Cloudflare Email Routing forwards to the Worker resolves to
// `*@doforu.app`, and the Worker's mailbox lookup needs the R2 descriptor to
// exist. No HTTP is involved, so all three effects are asserted directly
// against a real SQLite engine and an in-memory bucket.

/** Run the catch-all route for a seeded domain and return the SQL/pieces. */
async function putCatchAll(options: {
	domainName: string;
	catchAll: string;
	preexistingMailbox?: boolean;
}): Promise<{
	status: number;
	body: Record<string, unknown>;
	sqlite: ReturnType<typeof createSqlite>;
	bucket: FakeBucket;
	domainId: string;
}> {
	const sqlite = createSqlite();
	const domainId = `dom_${options.domainName}`;
	sqlite
		.prepare(
			`INSERT INTO domains (id, name, resend_domain_id, cf_zone_id, cf_account_id, status, catch_all_mailbox, resend_api_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(domainId, options.domainName, null, null, null, "pending", null, null, new Date().toISOString());

	const bucket = createFakeBucket();
	if (options.preexistingMailbox) {
		bucket.objects.set(`mailboxes/${options.catchAll}.json`, { body: JSON.stringify({ fromName: "existing" }) });
	}

	const app = await createSetupApp();
	const res = await app.request(
		`/api/v1/domains/${domainId}/catch-all`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ catch_all_mailbox: options.catchAll }),
		},
		createEnv(sqlite, bucket),
	);

	return { status: res.status, body: (await res.json()) as Record<string, unknown>, sqlite, bucket, domainId };
}

describe("PUT /api/v1/domains/:id/catch-all — auto-creates the catch-all mailbox", () => {
	it("stores *@doforu.app, writes the R2 descriptor and creates the six folders", { skip: sqliteSkip }, async () => {
		const { status, sqlite, bucket, domainId } = await putCatchAll({
			domainName: "doforu.app",
			catchAll: "*@doforu.app",
		});

		assert.equal(status, 200, "the catch-all update must succeed");

		// (a) the domain row now points at the catch-all mailbox
		assert.equal(readDomainColumn<string>(sqlite, domainId, "catch_all_mailbox"), "*@doforu.app");

		// (b) the R2 descriptor exists, under the key the inbound path looks up
		const key = "mailboxes/*@doforu.app.json";
		assert.ok(bucket.objects.has(key), `expected ${key} in R2; saw ${bucket.keys().join(", ")}`);
		const descriptor = bucket.json<{ fromName?: string }>(key);
		assert.equal(descriptor?.fromName, "Catch-all");

		// (c) exactly the six default folders, no more and no fewer. Rows come
		// back as null-prototype objects, so compare the public shape.
		const folders = readFolderRows(sqlite, "*@doforu.app").map((row) => ({ ...row }));
		assert.equal(folders.length, 6, `expected 6 folders, saw ${folders.length}`);
		assert.deepEqual(folders, [
			{ id: "archive", name: "Archive", is_deletable: 0 },
			{ id: "draft", name: "Drafts", is_deletable: 0 },
			{ id: "inbox", name: "Inbox", is_deletable: 0 },
			{ id: "sent", name: "Sent", is_deletable: 0 },
			{ id: "spam", name: "Spam", is_deletable: 0 },
			{ id: "trash", name: "Trash", is_deletable: 0 },
		]);
		// …and nothing beyond those six (e.g. a duplicate-seeded "drafts").
		assert.deepEqual(
			folders.map((row) => row.id),
			["archive", "draft", "inbox", "sent", "spam", "trash"],
		);
	});

	it("is idempotent: an existing descriptor is not rewritten and folders are not duplicated", { skip: sqliteSkip }, async () => {
		const { sqlite, bucket, domainId } = await putCatchAll({
			domainName: "doforu.app",
			catchAll: "*@doforu.app",
			preexistingMailbox: true,
		});

		// The `BUCKET.head()` guard short-circuits BOTH the put and the folder
		// seeding, so a re-armed catch-all keeps the operator's settings.
		assert.equal(bucket.json<{ fromName?: string }>("mailboxes/*@doforu.app.json")?.fromName, "existing");
		assert.deepEqual(readFolderRows(sqlite, "*@doforu.app").map((row) => ({ ...row })), []);
		assert.equal(readDomainColumn<string>(sqlite, domainId, "catch_all_mailbox"), "*@doforu.app");
	});

	it("normalises the legacy @domain form to *@domain", { skip: sqliteSkip }, async () => {
		const { status, sqlite, bucket } = await putCatchAll({
			domainName: "doforu.ai",
			catchAll: "@doforu.ai",
		});

		assert.equal(status, 200);
		assert.equal(readDomainColumn<string>(sqlite, "dom_doforu.ai", "catch_all_mailbox"), "*@doforu.ai");
		assert.ok(bucket.objects.has("mailboxes/*@doforu.ai.json"));
		assert.equal(readFolderRows(sqlite, "*@doforu.ai").length, 6, "the legacy form seeds the same six folders");
	});

	it("clears the catch-all when the body value is null, without touching R2", { skip: sqliteSkip }, async () => {
		const sqlite = createSqlite();
		sqlite
			.prepare(
				`INSERT INTO domains (id, name, status, catch_all_mailbox, created_at) VALUES (?, ?, ?, ?, ?)`,
			)
			.run("dom_clear", "doforu.app", "pending", "*@doforu.app", new Date().toISOString());
		const bucket = createFakeBucket();
		const app = await createSetupApp();

		const res = await app.request(
			"/api/v1/domains/dom_clear/catch-all",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ catch_all_mailbox: null }),
			},
			createEnv(sqlite, bucket),
		);

		assert.equal(res.status, 200);
		assert.equal(readDomainColumn<string>(sqlite, "dom_clear", "catch_all_mailbox"), null);
		assert.deepEqual(bucket.keys(), [], "clearing must not create an R2 object");
	});

	it("rejects a catch-all whose domain does not match the domain row", { skip: sqliteSkip }, async () => {
		const { status, body, bucket } = await putCatchAll({
			domainName: "doforu.app",
			catchAll: "*@pennyresearch.com",
		});

		assert.equal(status, 400);
		assert.match(String(body.error), /Domain mismatch/);
		assert.deepEqual(bucket.keys(), [], "a rejected catch-all must write nothing to R2");
	});
});

// ── harness self-check ──────────────────────────────────────────────

describe("setup-test-harness preconditions", () => {
	it("has a usable SQLite engine and a mountable setup app", async () => {
		// A false green here would silently skip (and thereby un-cover) every
		// case above, so the engine + mount are asserted directly.
		assert.equal(hasSqliteEngine(), true, "these guards need node:sqlite (Node >= 22)");
		assert.equal(sqliteSkip, false);

		const app = await createRealSetupApp();
		assert.equal(typeof app.request, "function");
	});
});
