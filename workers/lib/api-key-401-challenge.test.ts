// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression tests for the agent gateway's *self-describing* 401.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * The global API key middleware used to answer every rejection with a bare
 * `401 { error: "Unauthorized" }` — no `WWW-Authenticate` header at all. That
 * is a spec violation: RFC 7235 §4.1 says *"A server generating a 401
 * (Unauthorized) response MUST send a WWW-Authenticate header field"*. It is
 * also a dead end for the audience this endpoint exists for: an external agent
 * that guesses `/mcp` or `/tools` had no way to learn from the response how to
 * authenticate.
 *
 * ── What these cases pin ───────────────────────────────────────────────────
 * The fix is two shapes of challenge, chosen per RFC 6750 §3.1:
 *
 *   1. **No credentials presented** (neither `Authorization` nor `X-API-Key`)
 *      → `WWW-Authenticate: Bearer realm="mailboxes"`, with NO `error`
 *      parameter (the RFC says a challenge for a request that carried no
 *      credentials SHOULD NOT include one; its own example is
 *      `Bearer realm="example"`).
 *
 *   2. **Credentials presented but not valid** (malformed, unknown, revoked, or
 *      expired) → `WWW-Authenticate: Bearer realm="mailboxes",
 *      error="invalid_token"` — the §3.1 code whose meaning is exactly
 *      "expired, revoked, malformed, or invalid for other reasons".
 *
 * Both shapes also carry `Cache-Control: no-store` (a challenge must not be
 * replayed to another caller by an intermediary) and a JSON body of
 * `{ error, hint }`, where `error` is unchanged and `hint` is the new,
 * machine-readable "how do I authenticate" line.
 *
 * Deliberately NOT pinned here, because it is deliberately not implemented: no
 * `resource_metadata` parameter, no OAuth discovery document. This is a static
 * API key, not an OAuth resource server.
 *
 * ── How the app is driven ──────────────────────────────────────────────────
 * The middleware is mounted on a throwaway Hono app rather than the real
 * `agentApiRoute`: these cases are about the gateway's rejection envelope, and
 * mounting it directly keeps the file from depending on any particular
 * downstream handler. `env.DB` is a fake whose `prepare()` returns the row a
 * real lookup would, keyed off the SQL it is handed.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Env } from "../types";
import type { ApiKeyVariables } from "./api-key-middleware";
import { requireGlobalApiKey } from "./api-key-middleware";
import { generateApiKey, hashApiKey } from "./api-key-utils";

// ── The two challenges, spelled out ────────────────────────────────
//
// Written as literals rather than imported from the module under test: a test
// that reads its expectation out of the same constant it is checking proves
// nothing about the bytes on the wire.

/** RFC 6750 §3.1: no credentials → bare realm, no `error` parameter. */
const CHALLENGE_NO_CREDENTIALS = 'Bearer realm="mailboxes"';

/** RFC 6750 §3.1: credentials presented, verification failed. */
const CHALLENGE_INVALID_TOKEN =
	'Bearer realm="mailboxes", error="invalid_token"';

const HINT =
	"Send `Authorization: Bearer agk_<64 hex>` (or `X-API-Key`). List tools at GET /tools.";

// ── Fake D1 ────────────────────────────────────────────────────────

/**
 * The subset of `AgentApiKeyPublic`-ish row the lookup returns. Only the
 * columns `getAgentApiKeyByHash` selects are ever read back.
 */
interface FakeKeyRow {
	id: string;
	name: string;
	scopes: string;
	allowed_mailboxes: string | null;
	expires_at: string | null;
	revoked_at: string | null;
}

/**
 * A D1 stand-in that answers `getAgentApiKeyByHash` (a `.prepare().bind().first()`
 * chain) from a hash → row map, and no-ops the writes on the success path.
 *
 * `lookups` records every digest that was actually queried, so a case can
 * assert that a malformed key never reached the database — the shape check in
 * `extractBearerToken` is supposed to stop it before the query.
 */
function makeFakeDb(rowsByHash: Map<string, FakeKeyRow>) {
	const lookups: string[] = [];

	const db = {
		prepare(sql: string) {
			const stmt = {
				bind(...values: unknown[]) {
					return {
						async first() {
							if (sql.includes("FROM agent_api_keys")) {
								const hash = values[0] as string;
								lookups.push(hash);
								return rowsByHash.get(hash) ?? null;
							}
							return null;
						},
						async run() {
							// touchAgentApiKeyLastUsed / insertAgentApiKeyAudit
							return { meta: { changes: 1 } };
						},
						async all() {
							return { results: [] };
						},
					};
				},
			};
			return stmt as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;

	return { db, lookups };
}

/**
 * Build a fresh app that runs {@link requireGlobalApiKey} on `GET /tools` —
 * a real published gateway path — and answers 200 on success. The success
 * route proves that a valid key still flows through untouched.
 */
function createApp(db: D1Database) {
	const app = new Hono<{ Bindings: Env; Variables: ApiKeyVariables }>();
	app.use("/tools", requireGlobalApiKey);
	app.get("/tools", (c) => c.json({ tools: [], key: c.get("apiKeyInfo").name }, 200));
	const env = { DB: db } as unknown as Env;
	return { app, env };
}

/** Headers we care about, lower-cased, as a plain record. */
async function req(
	app: Hono<{ Bindings: Env; Variables: ApiKeyVariables }>,
	env: Env,
	headers: Record<string, string>,
) {
	const res = await app.request("/tools", { method: "GET", headers }, env);
	return res;
}

// ── Case 1: no credentials at all ──────────────────────────────────

describe("401 challenge — no credentials presented", () => {
	it("sends a bare Bearer challenge with no error parameter", async () => {
		const { db, lookups } = makeFakeDb(new Map());
		const { app, env } = createApp(db);

		const res = await req(app, env, {});

		assert.strictEqual(res.status, 401, "still 401 — the status is not part of the fix");
		assert.strictEqual(
			res.headers.get("WWW-Authenticate"),
			CHALLENGE_NO_CREDENTIALS,
			"RFC 7235 §4.1 requires WWW-Authenticate; RFC 6750 §3.1 excludes `error` when nothing was presented",
		);
		assert.ok(
			!/error=/.test(res.headers.get("WWW-Authenticate") ?? ""),
			"the no-credentials challenge must not carry an error parameter (RFC 6750 §3.1)",
		);
		assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
		assert.strictEqual(lookups.length, 0, "no credential value means no database lookup");

		assert.deepStrictEqual(await res.json(), {
			error: "Unauthorized",
			hint: HINT,
		});
	});

	it("treats an empty Authorization header as no credentials", async () => {
		const { db } = makeFakeDb(new Map());
		const { app, env } = createApp(db);

		const res = await req(app, env, { Authorization: "" });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE_NO_CREDENTIALS);
	});
});

// ── Case 2: a malformed token (presented, but fails the shape check) ─

describe("401 challenge — malformed token", () => {
	it("reports invalid_token for a wrong-family / truncated key", async () => {
		const { db, lookups } = makeFakeDb(new Map());
		const { app, env } = createApp(db);

		const res = await req(app, env, { Authorization: "Bearer not-a-real-key" });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(
			res.headers.get("WWW-Authenticate"),
			CHALLENGE_INVALID_TOKEN,
			"a presented-but-unusable token → RFC 6750 §3.1 invalid_token",
		);
		assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
		assert.strictEqual(
			lookups.length,
			0,
			"the shape check must reject a malformed key before it reaches the database",
		);

		assert.deepStrictEqual(await res.json(), {
			error: "Unauthorized",
			hint: HINT,
		});
	});

	it("reports invalid_token for a wrong-family X-API-Key", async () => {
		const { db } = makeFakeDb(new Map());
		const { app, env } = createApp(db);

		const res = await req(app, env, { "X-API-Key": "mb_0123456789abcdef" });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE_INVALID_TOKEN);
	});

	it("reports invalid_token for a correctly-prefixed but wrong-length key", async () => {
		const { db } = makeFakeDb(new Map());
		const { app, env } = createApp(db);

		const res = await req(app, env, { Authorization: "Bearer agk_deadbeef" });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE_INVALID_TOKEN);
	});
});

// ── Case 3: a well-shaped but unknown key ──────────────────────────

describe("401 challenge — unknown key", () => {
	it("reports invalid_token and does look the key up", async () => {
		const { db, lookups } = makeFakeDb(new Map()); // empty: nothing matches
		const { app, env } = createApp(db);

		const unknown = "agk_" + "0".repeat(64);
		const res = await req(app, env, { Authorization: `Bearer ${unknown}` });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE_INVALID_TOKEN);
		assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
		assert.strictEqual(lookups.length, 1, "a well-shaped key IS looked up");
		assert.strictEqual(lookups[0], await hashApiKey(unknown), "the digest, never the plaintext");

		assert.deepStrictEqual(await res.json(), {
			error: "Unauthorized",
			hint: HINT,
		});
	});
});

// ── Case 4: revoked and expired keys ───────────────────────────────

describe("401 challenge — revoked / expired key", () => {
	it("reports invalid_token for a revoked key", async () => {
		const { plainText, hash } = await generateApiKey();
		const rows = new Map<string, FakeKeyRow>([
			[
				hash,
				{
					id: "key-revoked",
					name: "revoked key",
					scopes: "all",
					allowed_mailboxes: null,
					expires_at: null,
					revoked_at: "2020-01-01T00:00:00.000Z",
				},
			],
		]);
		const { db } = makeFakeDb(rows);
		const { app, env } = createApp(db);

		const res = await req(app, env, { Authorization: `Bearer ${plainText}` });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE_INVALID_TOKEN);
		assert.strictEqual(res.headers.get("Cache-Control"), "no-store");
		assert.deepStrictEqual(await res.json(), {
			error: "Unauthorized",
			hint: HINT,
		});
	});

	it("reports invalid_token for an expired key", async () => {
		const { plainText, hash } = await generateApiKey();
		const rows = new Map<string, FakeKeyRow>([
			[
				hash,
				{
					id: "key-expired",
					name: "expired key",
					scopes: "all",
					allowed_mailboxes: null,
					expires_at: "2000-01-01T00:00:00.000Z",
					revoked_at: null,
				},
			],
		]);
		const { db } = makeFakeDb(rows);
		const { app, env } = createApp(db);

		const res = await req(app, env, { Authorization: `Bearer ${plainText}` });

		assert.strictEqual(res.status, 401);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), CHALLENGE_INVALID_TOKEN);
		assert.deepStrictEqual(await res.json(), {
			error: "Unauthorized",
			hint: HINT,
		});
	});
});

// ── Contrast: the success path is unchanged ────────────────────────

describe("success path is untouched", () => {
	it("lets a valid key through and sets apiKeyInfo", async () => {
		const { plainText, hash } = await generateApiKey();
		const rows = new Map<string, FakeKeyRow>([
			[
				hash,
				{
					id: "key-good",
					name: "working key",
					scopes: "all",
					allowed_mailboxes: null,
					expires_at: null,
					revoked_at: null,
				},
			],
		]);
		const { db } = makeFakeDb(rows);
		const { app, env } = createApp(db);

		const res = await req(app, env, { Authorization: `Bearer ${plainText}` });

		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), null, "no challenge on success");
		assert.deepStrictEqual(await res.json(), { tools: [], key: "working key" });
	});

	it("accepts a bare key in X-API-Key", async () => {
		const { plainText, hash } = await generateApiKey();
		const rows = new Map<string, FakeKeyRow>([
			[
				hash,
				{
					id: "key-good",
					name: "working key",
					scopes: "all",
					allowed_mailboxes: null,
					expires_at: null,
					revoked_at: null,
				},
			],
		]);
		const { db } = makeFakeDb(rows);
		const { app, env } = createApp(db);

		const res = await req(app, env, { "X-API-Key": plainText });

		assert.strictEqual(res.status, 200);
	});
});
