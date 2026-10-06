// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Tests for the login path — `handleLogin` in `workers/lib/auth.ts`.
 *
 * This closes a coverage blind spot: `workers/lib/password.test.ts` pins the
 * *cryptographic* half of login (the KDF, `ABSENT_PASSWORD_HASH`'s work
 * factor, the constant-cost miss), but nothing exercised the HTTP handler
 * itself — the request-body parsing, the admin count, the username lookup and
 * the session cookie it hands back. The cases below drive the real
 * `handleLogin` through a real Hono router against a real in-memory SQLite
 * engine (`node:sqlite`, Node >= 22), so the row that comes back, the `sessions`
 * row that gets written and the `Set-Cookie` header are all observable end to
 * end.
 *
 * Behaviour these cases pin (all read off `workers/lib/auth.ts`, not guessed):
 *
 *   - valid username + password  → 200 `{ authenticated: true, username }`
 *                                  and a `mailboxes_session` cookie that is
 *                                  `HttpOnly`.
 *   - wrong password             → 401 `{ error: invalidCredentials }`, and NO
 *                                  session row / cookie is handed back.
 *   - unknown username           → 401 `{ error: invalidCredentials }` — the
 *                                  same status and body as a wrong password,
 *                                  so the two are indistinguishable to a
 *                                  client (the `ABSENT_PASSWORD_HASH` branch).
 *   - missing `username` OR
 *     missing `password`         → 401 (NOT 400). `handleLogin` gates on
 *                                  `readString(...) === null` and answers the
 *                                  *same* `invalidCredentials`/401 as a bad
 *                                  credential; there is no distinct 400 for a
 *                                  malformed body. Asserted explicitly below.
 *   - no admin account yet       → 409 `{ error: setupRequired, code:
 *                                  setup_required }` (this is *not* a
 *                                  credential failure — it tells the client to
 *                                  run the setup wizard).
 *   - a login session cookie is accepted by `requireAuth` on a protected path
 *     (proves the issued cookie is a working session, not merely well-shaped).
 *
 * `node:sqlite` is available at runtime but its typings are absent from this
 * repo's @types/node (20.x), so the module is imported through a variable and
 * the execution cases are reported as **skipped** — never as a silent pass —
 * when the engine is missing.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Env } from "../types";
import type { D1MailboxContext } from "./d1-middleware";
import { AUTH_COOKIE, handleLogin, requireAuth } from "./auth";
import { toStoredPassword } from "./password";

// ── node:sqlite (optional engine) ───────────────────────────────────

type SqliteRow = Record<string, unknown>;

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): SqliteRow[];
		/** D1 surfaces the affected-row count as `meta.changes`. */
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

/** The two tables `handleLogin` + `issueSession` touch, verbatim from the
 * migrations that create them. */
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

/**
 * A `D1Database` whose prepared statements run for real in `node:sqlite`.
 *
 * `handleLogin` and `getSession` both go through `.first()` (they are plain
 * string SQL, not drizzle), so the shim only has to make `first()`, `all()` and
 * `run()` behave the way D1 documents them — including `meta.changes` on
 * `run()`, which `createFirstAdmin` gates on.
 */
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

/**
 * Seed an admin whose stored password is a real PBKDF2-SHA256 hash of
 * `password`, written through the same `toStoredPassword` the setup wizard
 * uses — so the KDF is genuinely exercised, not stubbed.
 */
async function seedAdmin(
	sqlite: InstanceType<DatabaseSyncLike>,
	username: string,
	password: string,
): Promise<void> {
	const stored = await toStoredPassword(password);
	sqlite
		.prepare(
			"INSERT INTO admins (id, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			crypto.randomUUID(),
			username,
			stored,
			new Date().toISOString(),
			new Date().toISOString(),
		);
}

/**
 * A Hono app with `handleLogin` mounted at `/login`, plus a `requireAuth`-
 * protected `/protected` path for the session-cookie round-trip case.
 *
 * `app.request(input, init, env)` takes the bindings as its THIRD argument —
 * that is how the env reaches `c.env` for a `Context<D1MailboxContext>`
 * handler without running the Cloudflare runtime.
 */
function createApp(db: D1Database) {
	const app = new Hono<D1MailboxContext>();
	app.post("/login", handleLogin);
	app.get("/protected", requireAuth, (c) => c.json({ ok: true }));
	return { app, env: { DB: db } as unknown as Env };
}

/** POST /login with a JSON body, returning the Response. */
async function login(
	app: Hono<D1MailboxContext>,
	env: Env,
	body: BodyInit | null,
): Promise<Response> {
	return app.request(
		"/login",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		},
		env,
	);
}

/** The `Set-Cookie` header value, if any. */
function setCookieOf(res: Response): string | null {
	return res.headers.get("set-cookie");
}

// ── Tests ───────────────────────────────────────────────────────────

describe("handleLogin (POST /login)", () => {
	it("signs in with the right username and password, and sets an HttpOnly session cookie", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const res = await login(
			app,
			env,
			JSON.stringify({ username: "owner@example.com", password: "correct-horse-battery" }),
		);

		assert.strictEqual(res.status, 200, "valid credentials must log in");

		const body = (await res.json()) as { authenticated?: boolean; username?: string };
		assert.strictEqual(body.authenticated, true);
		assert.strictEqual(body.username, "owner@example.com");

		// The session cookie is the whole point of a successful login.
		const cookie = setCookieOf(res);
		assert.ok(cookie, "a successful login must set a cookie");
		assert.match(cookie, new RegExp(`^${AUTH_COOKIE}=`), "the auth cookie name is used");
		assert.match(cookie, /HttpOnly/i, "the session cookie must be HttpOnly");
		assert.match(cookie, /Path=\//i);
		assert.match(cookie, /SameSite=Lax/i);

		// And the session really landed in the `sessions` table — a cookie
		// whose token was never persisted would authenticate nobody.
		const token = cookie.match(new RegExp(`^${AUTH_COOKIE}=([^;]+)`))?.[1];
		assert.ok(token, "the cookie carries a token");
		const row = sqlite
			.prepare("SELECT token, expires_at FROM sessions WHERE token = ?")
			.all(token);
		assert.strictEqual(row.length, 1, "the session row must be persisted");
	});

	it("rejects a wrong password with 401 and issues no session", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const res = await login(
			app,
			env,
			JSON.stringify({ username: "owner@example.com", password: "wrong-password" }),
		);

		assert.strictEqual(res.status, 401, "a bad password is unauthorized");
		const body = (await res.json()) as { error?: string };
		assert.strictEqual(body.error, "Invalid username or password");

		// No usable session: neither a cookie nor a row.
		assert.strictEqual(setCookieOf(res), null, "a failed login must not set a cookie");
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS cnt FROM sessions").all()[0]!.cnt,
			0,
			"a failed login must not write a session row",
		);
	});

	it("rejects an unknown username with 401 (ABSENT_PASSWORD_HASH branch)", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		// An admin DOES exist (so this is not the `setup_required` branch) —
		// the username simply resolves to no row, which must still run the KDF.
		const res = await login(
			app,
			env,
			JSON.stringify({ username: "nobody@example.com", password: "correct-horse-battery" }),
		);

		assert.strictEqual(res.status, 401);
		const body = (await res.json()) as { error?: string };
		assert.strictEqual(
			body.error,
			"Invalid username or password",
			"the miss and the failed comparison must be indistinguishable",
		);
		assert.strictEqual(setCookieOf(res), null);
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS cnt FROM sessions").all()[0]!.cnt,
			0,
		);
	});

	it("answers 401 — NOT 400 — when username or password is missing", { skip: sqliteSkip }, async () => {
		// Read off the implementation: `handleLogin` treats a missing or
		// non-string field via `readString(...) === null` and returns the
		// *same* `invalidCredentials` / 401 as a bad credential. There is no
		// dedicated validation error (unlike `handleCreateAdmin`, which does
		// answer 400 for a malformed body). Pinned here so a future change to
		// 400 is a deliberate, visible decision.
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const missingPassword = await login(
			app,
			env,
			JSON.stringify({ username: "owner@example.com" }),
		);
		assert.strictEqual(missingPassword.status, 401, "missing password → 401");
		assert.strictEqual(
			((await missingPassword.json()) as { error?: string }).error,
			"Invalid username or password",
		);

		const missingUsername = await login(
			app,
			env,
			JSON.stringify({ password: "correct-horse-battery" }),
		);
		assert.strictEqual(missingUsername.status, 401, "missing username → 401");

		const emptyBody = await login(app, env, JSON.stringify({}));
		assert.strictEqual(emptyBody.status, 401, "empty object → 401");

		// A body that is not JSON at all is caught by `.catch(() => null)` and
		// lands on the same branch.
		const malformed = await login(app, env, "not json");
		assert.strictEqual(malformed.status, 401, "unparseable body → 401");

		// No session is ever created on these paths.
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS cnt FROM sessions").all()[0]!.cnt,
			0,
		);
	});

	it("asks for setup (409) when no admin account exists yet", { skip: sqliteSkip }, async () => {
		// The app is "uninitialised" while `admins` is empty; this is a
		// distinct signal from a credential failure, so it is 409 with a code.
		const { db } = createRealSqliteD1(SCHEMA_SQL);
		const { app, env } = createApp(db);

		const res = await login(
			app,
			env,
			JSON.stringify({ username: "owner@example.com", password: "correct-horse-battery" }),
		);

		assert.strictEqual(res.status, 409);
		const body = (await res.json()) as { error?: string; code?: string };
		assert.strictEqual(body.code, "setup_required");
		assert.strictEqual(body.error, "Setup required");
	});

	it("issues a cookie that requireAuth then accepts on a protected path", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		// An anonymous request is turned away.
		const anonymous = await app.request("/protected", { method: "GET" }, env);
		assert.strictEqual(anonymous.status, 401, "no cookie → requireAuth rejects");

		const res = await login(
			app,
			env,
			JSON.stringify({ username: "owner@example.com", password: "correct-horse-battery" }),
		);
		assert.strictEqual(res.status, 200);
		const cookie = setCookieOf(res)!;
		// Forward only the `name=value` pair, as a browser would.
		const pair = cookie.split(";")[0]!;

		const protectedRes = await app.request(
			"/protected",
			{ method: "GET", headers: { Cookie: pair } },
			env,
		);
		assert.strictEqual(protectedRes.status, 200, "the login cookie must authenticate");
		assert.deepStrictEqual(await protectedRes.json(), { ok: true });
	});

	it("matches a username case-sensitively, exactly as stored", { skip: sqliteSkip }, async () => {
		// `getAdminByUsername` looks the row up with `WHERE username = ?` on a
		// TEXT column, so this is an exact match (the only normalisation on the
		// login path is `username.trim()`). Pinned so the behaviour is explicit.
		const { db, sqlite } = createRealSqliteD1(SCHEMA_SQL);
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const { app, env } = createApp(db);

		const upper = await login(
			app,
			env,
			JSON.stringify({ username: "OWNER@EXAMPLE.COM", password: "correct-horse-battery" }),
		);
		assert.strictEqual(upper.status, 401, "username lookup is exact, not case-folding");

		// Surrounding whitespace IS trimmed before the lookup.
		const padded = await login(
			app,
			env,
			JSON.stringify({ username: "  owner@example.com  ", password: "correct-horse-battery" }),
		);
		assert.strictEqual(padded.status, 200, "the login path trims the username");
	});
});
