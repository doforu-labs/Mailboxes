// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression tests for the *cookie-session* surface's 401 responses.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * `workers/lib/auth.ts` answered all eight of its auth failures with a bare
 * `401 { error }` — no `WWW-Authenticate`, no `Cache-Control`, no guidance for
 * the caller. RFC 9110 §15.5.2 / §11.6.1 are unambiguous: *"A server generating
 * a 401 (Unauthorized) response MUST send a WWW-Authenticate header field"*,
 * carrying at least one challenge.
 *
 * ── Why the challenge is `Session`, not `Bearer` ───────────────────────────
 * `Bearer` (RFC 6750) is the wrong scheme here: it tells the client to go and
 * fetch an OAuth 2.0 access token, which is not how this surface works — it
 * wants a browser session cookie minted by `POST /api/v1/auth/login`.
 *
 * There is no standard challenge for cookie sessions: RFC 6265 defines state
 * management only and no scheme, and the single draft that tried
 * (`draft-broyer-http-cookie-auth-00`, scheme `Cookie`) expired in 2009 and was
 * never revived — so citing `Cookie` would be citing dead text. RFC 9110 §11.1
 * defines `auth-scheme = token` and only says a scheme *ought* to be registered
 * (not MUST), so a syntactically valid unregistered scheme is legal. `Session`
 * is therefore the semantically honest choice: it names the credential the
 * server actually wants.
 *
 * Because no `error=` parameter is defined for a non-Bearer scheme (RFC 6750's
 * `error="invalid_token"` is Bearer-specific), the challenge carries none — and
 * the same challenge is used for "no cookie at all" and "cookie present but no
 * longer valid", since there is no standard code to distinguish them.
 *
 * ── What these cases pin ───────────────────────────────────────────────────
 *   1. Every one of the eight 401 paths carries
 *      `WWW-Authenticate: Session realm="mailboxes"` (asserted as a literal,
 *      not read back from the module's own constant).
 *   2. Every one carries `Cache-Control: no-store`, so no intermediary replays
 *      one caller's challenge to another.
 *   3. The `error` body field is byte-for-byte what it was before the change
 *      (`Unauthorized` / `Invalid username or password`) — the front end reads
 *      exactly that key — and the new `hint` is a non-empty string. The shape
 *      stays additive, matching the agent-gateway 401's `{ error, hint }`.
 *   4. The credential surface's two failures are still indistinguishable (no
 *      username enumeration) — same status, same `error`, same challenge.
 *   5. The `en` and `zh` `apiAuth` bundles define the same key set.
 *   6. The success path is untouched: a valid session produces no challenge and
 *      no `hint`.
 *
 * ── Why this surface uses its OWN hint keys ────────────────────────────────
 * The `apiAuth` namespace is shared with the agent gateway
 * (`workers/lib/api-key-middleware.ts` reads `unauthorized` + `unauthorizedHint`
 * from it). A single `unauthorizedHint` key therefore cannot describe both
 * surfaces: whoever writes it last wins, and the other surface's copy is
 * silently clobbered. The session surface thus pins `sessionRequiredHint` /
 * `invalidCredentialsHint`, and Case 3 below carries a *guard* asserting the
 * gateway's `unauthorizedHint` is still the gateway text — so a future edit
 * cannot re-hijack it without a red test.
 *
 * ── How the app is driven ──────────────────────────────────────────────────
 * `requireAuth` is exercised through a real Hono router over a real in-memory
 * SQLite engine (`node:sqlite`, Node >= 22) using the same shim shape as
 * `auth.test.ts`; `handleLogin` / `handleMe` are mounted at their real route
 * paths under `/api/v1/auth/` so the paths in the failure list below are the
 * genuine ones. When `node:sqlite` is missing the execution cases report as
 * **skipped**, never as a silent pass.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../types";
import type { D1MailboxContext } from "./d1-middleware";
import {
	AUTH_COOKIE,
	handleLogin,
	handleMe,
	requireAuth,
} from "./auth";
import { toStoredPassword } from "./password";

// ── The challenge, spelled out ─────────────────────────────────────
//
// Written as a literal rather than imported from `AUTH_CHALLENGE`: a test that
// reads its expectation out of the same constant it is checking proves nothing
// about the bytes on the wire.

/** RFC 9110 §11.1: `Session` is a valid token; §15.5.2 requires a challenge. */
const CHALLENGE = 'Session realm="mailboxes"';

/** The eight 401 sites, as `path` + which surface (i.e. which `error` value). */
const SESSION_PATHS = [
	"/api/v1/mailboxes", // requireAuth: no cookie
	"/api/v1/mailboxes", // requireAuth: session row missing
	"/api/v1/mailboxes", // requireAuth: session expired
	"/api/v1/auth/me", // handleMe: no cookie
	"/api/v1/auth/me", // handleMe: session missing/expired
	"/api/v1/auth/me", // handleMe: admin row gone
] as const;
const CREDENTIAL_PATHS = [
	"/api/v1/auth/login", // handleLogin: username/password missing
	"/api/v1/auth/login", // handleLogin: unknown user or bad password
] as const;

// ── The session surface's hint keys, spelled out ───────────────────
//
// The `apiAuth` namespace is shared with the agent gateway, whose
// `unauthorizedHint` is a *different* sentence (it describes the API-key
// surface). These literals are that surface's own copy; asserting them here
// pins the split, and the guard in Case 3 pins the gateway's key against
// re-hijacking.

/** The `sessionRequiredHint` value, `en` bundle. */
const SESSION_REQUIRED_HINT =
	"Sign in at /login in your browser and send the session cookie with the request, or call POST /api/v1/auth/login to obtain one.";

/** The `invalidCredentialsHint` value, `en` bundle. */
const INVALID_CREDENTIALS_HINT =
	"Check the username and password, then retry POST /api/v1/auth/login.";

// ── node:sqlite (optional engine) ───────────────────────────────────

type SqliteRow = Record<string, unknown>;

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): SqliteRow[];
		run(...params: unknown[]): { changes?: number | bigint };
	};
};

/**
 * Late-bound module specifier: a literal `import("node:sqlite")` would fail
 * type-checking under @types/node 20.x even though the runtime supports it.
 */
const NODE_SQLITE_MODULE = "node:sqlite";

let DatabaseSyncCtor: DatabaseSyncLike | null = null;
try {
	DatabaseSyncCtor =
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		((await import(NODE_SQLITE_MODULE)) as any).DatabaseSync ?? null;
} catch {
	DatabaseSyncCtor = null;
}

const sqliteSkip: string | false = DatabaseSyncCtor
	? false
	: "node:sqlite is unavailable (needs Node >= 22)";

// ── Schema (mirrors migrations 0009_sessions.sql + 0011_admins.sql) ──

const SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS sessions (
		token      TEXT PRIMARY KEY,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS admins (
		id         TEXT PRIMARY KEY,
		username   TEXT NOT NULL UNIQUE,
		password   TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
`;

// ── D1Database shim backed by a real SQLite engine ──────────────────

function createRealSqliteD1(createSchemaSql: string): {
	db: D1Database;
	sqlite: InstanceType<DatabaseSyncLike>;
} {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");

	const sqlite = new Ctor(":memory:");
	sqlite.exec(createSchemaSql);

	const shim = {
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		prepare: (sql: string) => {
			const values: unknown[] = [];
			const statement = {
				bind(...args: unknown[]) {
					values.push(...args.map(unwrapDriverValue));
					return statement;
				},
				async first() {
					return (sqlite.prepare(sql).all(...(values as never[]))[0] ?? null) as never;
				},
				async all() {
					return {
						results: sqlite.prepare(sql).all(...(values as never[])),
						success: true,
						meta: {},
					} as never;
				},
				async run() {
					const info = sqlite.prepare(sql).run(...(values as never[])) as {
						changes?: number | bigint;
					};
					return {
						results: [],
						success: true,
						meta: { changes: Number(info.changes ?? 0) },
					} as never;
				},
				async raw() {
					return sqlite
						.prepare(sql)
						.all(...(values as never[]))
						.map((row) => Object.values(row)) as never;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		batch: async () => [],
	};

	return {
		db: shim as unknown as D1Database,
		sqlite: sqlite as InstanceType<DatabaseSyncLike>,
	};
}

/** Drizzle / the D1 driver wrap bound values in `{ value }` parameter objects. */
function unwrapDriverValue(arg: unknown): unknown {
	if (arg !== null && typeof arg === "object" && "value" in (arg as object)) {
		return (arg as { value: unknown }).value;
	}
	return arg;
}

async function seedAdmin(
	sqlite: InstanceType<DatabaseSyncLike>,
	username: string,
	password: string,
): Promise<void> {
	const stored = await toStoredPassword(password);
	const now = new Date().toISOString();
	sqlite
		.prepare(
			"INSERT INTO admins (id, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(crypto.randomUUID(), username, stored, now, now);
}

/** Insert a session row with an explicit expiry (so "expired" is deterministic). */
function seedSession(
	sqlite: InstanceType<DatabaseSyncLike>,
	token: string,
	expiresAt: string,
): void {
	sqlite
		.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)")
		.run(token, new Date().toISOString(), expiresAt);
}

/**
 * A Hono app carrying all three handlers at their real mount points. The
 * `requireAuth`-protected path is a real published route shape (`/api/v1/*`).
 * `app.request(input, init, env)` passes the bindings as its THIRD argument.
 */
function createApp(db: D1Database) {
	const app = new Hono<D1MailboxContext>();
	app.post("/api/v1/auth/login", handleLogin);
	app.get("/api/v1/auth/me", handleMe);
	app.use("/api/v1/*", requireAuth);
	app.get("/api/v1/mailboxes", (c) => c.json({ mailboxes: [] }));
	return { app, env: { DB: db } as unknown as Env };
}

/** Assert the shared 401 envelope: literal challenge, no-store, `{ error, hint }`. */
async function assert401Envelope(
	res: Response,
	expectedError: string,
	label: string,
	expectedHint: string,
) {
	assert.strictEqual(res.status, 401, `${label}: the status must stay 401`);

	const challenge = res.headers.get("WWW-Authenticate");
	assert.strictEqual(
		challenge,
		CHALLENGE,
		`${label}: RFC 9110 §15.5.2 requires a WWW-Authenticate challenge`,
	);
	assert.ok(
		!(challenge ?? "").includes("Bearer"),
		`${label}: Bearer would tell the client to fetch an OAuth token — wrong surface`,
	);
	assert.ok(
		!/error=/.test(challenge ?? ""),
		`${label}: RFC 6750's error= parameter is Bearer-only; a non-Bearer scheme defines none`,
	);

	assert.strictEqual(
		res.headers.get("Cache-Control"),
		"no-store",
		`${label}: a challenge must not be replayed to another caller by an intermediary`,
	);

	const body = (await res.json()) as { error?: unknown; hint?: unknown };
	assert.strictEqual(
		body.error,
		expectedError,
		`${label}: the error string is an existing contract — it must not change`,
	);
	assert.strictEqual(
		body.hint,
		expectedHint,
		`${label}: the hint must be this surface's own copy — it must not be the gateway's`,
	);
	return body;
}

// ── Case 1: the eight 401 sites ────────────────────────────────────

describe("cookie-session 401 — challenge, caching and body", () => {
	it("requireAuth: no cookie → Session challenge, no-store, { error, hint }", { skip: sqliteSkip }, async () => {
		const { db } = createRealSqliteD1(SCHEMA_SQL);
		const { app, env } = createApp(db);

		const res = await app.request("/api/v1/mailboxes", { method: "GET" }, env);
		await assert401Envelope(res, "Unauthorized", "requireAuth/no-cookie", SESSION_REQUIRED_HINT);
	});

	it("requireAuth: unknown session token → Session challenge", { skip: sqliteSkip }, async () => {
		const { db } = createRealSqliteD1(SCHEMA_SQL);
		const { app, env } = createApp(db);

		const res = await app.request(
			"/api/v1/mailboxes",
			{ method: "GET", headers: { Cookie: `${AUTH_COOKIE}=never-issued` } },
			env,
		);
		await assert401Envelope(res, "Unauthorized", "requireAuth/session-missing", SESSION_REQUIRED_HINT);
	});

	it("requireAuth: expired session → challenge, and the row is swept", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		seedSession(sqlite, "expired-token", "2000-01-01T00:00:00.000Z");
		const { app, env } = createApp(db);

		const res = await app.request(
			"/api/v1/mailboxes",
			{ method: "GET", headers: { Cookie: `${AUTH_COOKIE}=expired-token` } },
			env,
		);
		await assert401Envelope(res, "Unauthorized", "requireAuth/session-expired", SESSION_REQUIRED_HINT);

		// `deleteSession` on the expiry branch is pre-existing behaviour and
		// must survive the change.
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS cnt FROM sessions").all()[0]!.cnt,
			0,
			"the expired session row is still deleted",
		);
	});

	it("handleMe: no cookie → Session challenge", { skip: sqliteSkip }, async () => {
		const { db } = createRealSqliteD1(SCHEMA_SQL);
		const { app, env } = createApp(db);

		const res = await app.request("/api/v1/auth/me", { method: "GET" }, env);
		await assert401Envelope(res, "Unauthorized", "handleMe/no-cookie", SESSION_REQUIRED_HINT);
	});

	it("handleMe: unknown or expired session → Session challenge", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		seedSession(sqlite, "stale-token", "2000-01-01T00:00:00.000Z");
		const { app, env } = createApp(db);

		const unknown = await app.request(
			"/api/v1/auth/me",
			{ method: "GET", headers: { Cookie: `${AUTH_COOKIE}=never-issued` } },
			env,
		);
		await assert401Envelope(unknown, "Unauthorized", "handleMe/session-missing", SESSION_REQUIRED_HINT);

		const expired = await app.request(
			"/api/v1/auth/me",
			{ method: "GET", headers: { Cookie: `${AUTH_COOKIE}=stale-token` } },
			env,
		);
		await assert401Envelope(expired, "Unauthorized", "handleMe/session-expired", SESSION_REQUIRED_HINT);
	});

	it("handleMe: admin account removed → Session challenge", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		// A *valid, unexpired* session exists, but no admin row does — the
		// session is treated as invalid (see `handleMe`).
		seedSession(sqlite, "live-token", new Date(Date.now() + 3_600_000).toISOString());
		const { app, env } = createApp(db);

		const res = await app.request(
			"/api/v1/auth/me",
			{ method: "GET", headers: { Cookie: `${AUTH_COOKIE}=live-token` } },
			env,
		);
		await assert401Envelope(res, "Unauthorized", "handleMe/admin-gone", SESSION_REQUIRED_HINT);
	});

	it("handleLogin: missing / non-string credentials → challenge on the credential surface", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const cases: Array<[string, BodyInit | null]> = [
			["missing password", JSON.stringify({ username: "owner@example.com" })],
			["missing username", JSON.stringify({ password: "correct-horse-battery" })],
			["empty object", JSON.stringify({})],
			["non-string password", JSON.stringify({ username: "owner@example.com", password: 42 })],
			["unparseable body", "not json"],
		];
		for (const [label, body] of cases) {
			const res = await app.request(
				"/api/v1/auth/login",
				{ method: "POST", headers: { "Content-Type": "application/json" }, body },
				env,
			);
			await assert401Envelope(
				res,
				"Invalid username or password",
				`handleLogin/${label}`,
				INVALID_CREDENTIALS_HINT,
			);
		}
	});

	it("handleLogin: unknown user and wrong password are indistinguishable", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const wrongPassword = await app.request(
			"/api/v1/auth/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "owner@example.com", password: "wrong-password" }),
			},
			env,
		);
		const wrongBody = await assert401Envelope(
			wrongPassword,
			"Invalid username or password",
			"handleLogin/wrong-password",
			INVALID_CREDENTIALS_HINT,
		);

		const unknownUser = await app.request(
			"/api/v1/auth/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "nobody@example.com", password: "correct-horse-battery" }),
			},
			env,
		);
		const unknownBody = await assert401Envelope(
			unknownUser,
			"Invalid username or password",
			"handleLogin/unknown-user",
			INVALID_CREDENTIALS_HINT,
		);

		assert.deepStrictEqual(
			unknownBody,
			wrongBody,
			"the response bodies must be identical — no username enumeration",
		);
		assert.strictEqual(
			unknownUser.headers.get("WWW-Authenticate"),
			wrongPassword.headers.get("WWW-Authenticate"),
			"and so must the challenges",
		);
	});

	it("covers all eight sites, session and credential surfaces alike", () => {
		assert.strictEqual(SESSION_PATHS.length, 6, "six session-surface 401 sites");
		assert.strictEqual(CREDENTIAL_PATHS.length, 2, "two credential-surface 401 sites");
	});
});

// ── Case 2: hint copy is actionable, and says nothing it shouldn't ──

describe("hint copy", () => {
	it("session surfaces point at the login flow", { skip: sqliteSkip }, async () => {
		const { db } = createRealSqliteD1(SCHEMA_SQL);
		const { app, env } = createApp(db);

		const res = await app.request("/api/v1/auth/me", { method: "GET" }, env);
		const { hint } = (await res.json()) as { hint: string };

		assert.ok(hint.includes("/login"), "tells the browser where to sign in");
		assert.ok(
			hint.includes("POST /api/v1/auth/login"),
			"and names the endpoint that mints a session",
		);
	});

	it("credential surface tells you to re-check both fields", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const res = await app.request(
			"/api/v1/auth/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "owner@example.com", password: "nope" }),
			},
			env,
		);
		const { hint } = (await res.json()) as { hint: string };

		assert.ok(/username/i.test(hint) && /password/i.test(hint), "names both fields");
		assert.ok(hint.includes("POST /api/v1/auth/login"), "and the endpoint to retry");
		assert.ok(
			!/does not exist|not found|no such user|unknown user/i.test(hint),
			"the hint must not hint at *which* half was wrong — that is the enumeration defence",
		);
	});
});

// ── Case 3: the i18n bundles stay in lockstep ──────────────────────

describe("apiAuth locale bundles", () => {
	const load = (locale: string) =>
		JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL(`../../shared/i18n/locales/${locale}/apiAuth.json`, import.meta.url),
				),
				"utf8",
			),
		) as Record<string, string>;

	it("define exactly the same key set in en and zh", () => {
		const en = load("en");
		const zh = load("zh");
		assert.deepStrictEqual(
			Object.keys(zh).sort(),
			Object.keys(en).sort(),
			"a key present in only one bundle falls back or breaks — the sets must match",
		);
	});

	it("define both session-surface hints as non-empty strings", () => {
		for (const locale of ["en", "zh"]) {
			const bundle = load(locale);
			for (const key of ["sessionRequiredHint", "invalidCredentialsHint"]) {
				assert.ok(
					typeof bundle[key] === "string" && bundle[key].length > 0,
					`${locale}: ${key} must be a non-empty string`,
				);
			}
		}
	});

	// ── The anti-hijack guard ──────────────────────────────────────────
	//
	// `unauthorizedHint` belongs to the *agent gateway*: it is what
	// `api-key-middleware.ts` reads through this same `apiAuth` namespace, and
	// `workers/lib/api-key-401-challenge.test.ts` pins its text. The session
	// surface used to write its copy into the same key, which silently broke
	// the gateway's 401. If someone ever points the session surface back at
	// `unauthorizedHint`, this case fails and names the collision.
	it("keeps unauthorizedHint as the gateway's copy — not the session's", () => {
		const en = load("en");
		const zh = load("zh");

		assert.strictEqual(
			en.unauthorizedHint,
			"Send `Authorization: Bearer agk_<64 hex>` (or `X-API-Key`). List tools at GET /tools.",
			"unauthorizedHint is the agent-gateway hint; the session surface must not overwrite it",
		);
		assert.ok(
			/^Send `Authorization: Bearer agk_/.test(en.unauthorizedHint),
			"and it must still read as an API-key instruction",
		);
		assert.ok(
			!/\/login/.test(en.unauthorizedHint),
			"a session hint leaking into the gateway's key is the exact bug this guards",
		);

		assert.strictEqual(
			zh.unauthorizedHint,
			"请发送 `Authorization: Bearer agk_<64 位 hex>`（或 `X-API-Key`）。可用工具列表见 GET /tools。",
			"the zh bundle must not be overwritten either",
		);
	});

	it("gives the two surfaces genuinely different hint text", () => {
		for (const locale of ["en", "zh"]) {
			const bundle = load(locale);
			assert.notStrictEqual(
				bundle.sessionRequiredHint,
				bundle.unauthorizedHint,
				`${locale}: the session and gateway hints must not collapse back into one string`,
			);
		}
	});

	it("leaves the pre-existing error strings untouched", () => {
		assert.strictEqual(load("en").unauthorized, "Unauthorized");
		assert.strictEqual(load("en").invalidCredentials, "Invalid username or password");
		assert.strictEqual(load("zh").unauthorized, "未授权");
		assert.strictEqual(load("zh").invalidCredentials, "用户名或密码不正确");
	});
});

// ── Case 4: the success path is untouched ──────────────────────────

describe("success path is untouched", () => {
	it("a valid session gets no challenge and no hint", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");

		const { app, env } = createApp(db);
		const login = await app.request(
			"/api/v1/auth/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "owner@example.com", password: "correct-horse-battery" }),
			},
			env,
		);
		assert.strictEqual(login.status, 200);
		const pair = login.headers.get("set-cookie")!.split(";")[0]!;

		const me = await app.request(
			"/api/v1/auth/me",
			{ method: "GET", headers: { Cookie: pair } },
			env,
		);
		assert.strictEqual(me.status, 200);
		assert.strictEqual(me.headers.get("WWW-Authenticate"), null, "no challenge on success");
		assert.strictEqual(me.headers.get("Cache-Control"), null, "and no no-store either");
		assert.deepStrictEqual(await me.json(), {
			authenticated: true,
			username: "owner@example.com",
		});

		const protectedRes = await app.request(
			"/api/v1/mailboxes",
			{ method: "GET", headers: { Cookie: pair } },
			env,
		);
		assert.strictEqual(protectedRes.status, 200);
		assert.strictEqual(protectedRes.headers.get("WWW-Authenticate"), null);
		assert.deepStrictEqual(await protectedRes.json(), { mailboxes: [] });
	});

	it("the public / exempt paths still bypass requireAuth entirely", { skip: sqliteSkip }, async () => {
		const { db } = createRealSqliteD1(SCHEMA_SQL);
		const app = new Hono<D1MailboxContext>();
		app.use("/api/v1/*", requireAuth);
		app.post("/api/v1/auth/login", (c) => c.json({ reached: true }));
		const env = { DB: db } as unknown as Env;

		// `/api/v1/auth/login` is in PUBLIC_PATHS — it reaches the handler
		// rather than the middleware's 401, so nothing about the challenge
		// leaks onto (or blocks) the unauthenticated surface.
		const res = await app.request("/api/v1/auth/login", { method: "POST" }, env);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get("WWW-Authenticate"), null);
	});
});
