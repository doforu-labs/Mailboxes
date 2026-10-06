// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Route-level regression guard: admin `/api/*` handlers must NOT echo the
 * original exception message back to the caller.
 *
 * Why it matters: a D1/drizzle failure message carries the failing SQL, bound
 * parameters and column names — an information leak through a response body
 * that any authenticated admin session (or a stolen cookie) can read. The fix
 * is to answer with the stable i18n copy and keep the exception server-side
 * (`console.error`).
 *
 * ── This test drives the REAL production code ───────────────────────────────
 * The previous revision of this file was a FALSE GREEN: it declared a fresh
 * `new Hono()` and inlined a *copy* of the handler body, so it exercised
 * nothing that shipped — reverting the production fix left it passing. This
 * version imports `../index` and hits the real mounted app:
 *
 *   import { app } from "../index";
 *   await app.request("/api/v1/auth/login", init, env);        // real login
 *   await app.request("/api/v1/domains/:id", {                 // real route
 *     headers: { Cookie: <session> },
 *   }, env);
 *
 * Everything on that path is production code: the `/api/*` locale middleware,
 * `requireAuth` reading the `sessions` table, the drizzle-backed `getDomain`,
 * and the handler's own `catch`. Only the *database* is faked (below), so the
 * 500 is a genuine failure raised inside `getDomain`'s SQL layer.
 *
 * ── Reverse verification (the proof it is not fake) ─────────────────────────
 * Flipping the handler at `index.ts` back to
 *   `return c.json({ error: error.message || c.get("t")("api:failedToGetDomain") }, 500);`
 * makes the `real GET /api/v1/domains/:id` case FAIL — the body then reads
 *   {"error":"SQLITE_ERROR: no such column: domains.internal_secret_column"}
 * and both the `parsed.error` equality and the `!body.includes(secret)` guard
 * trip. Verified by hand against this exact file; the assertion that carries
 * the weight is the substring one, which no amount of field renaming hides.
 *
 * ── The database ───────────────────────────────────────────────────────────
 * A real SQLite engine (`node:sqlite`, Node >= 22) backs the shim, so
 * `sessions`/`admins`/`domains` are genuinely queried: by `getSession` (plain
 * `SELECT`, via `.first()`), by the login path, and by `getDomain` (drizzle,
 * via `.all()`). `node:sqlite` typings are missing from this repo's
 * @types/node (20.x), so the module is imported through a variable and every
 * case is reported **skipped** — never a silent pass — when the engine is
 * absent.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { app } from "../index";
import type { Env } from "../types";
import { toStoredPassword } from "../lib/password";

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

// ── Schema (mirrors migrations 0002/0003/0009/0011) ─────────────────

/** The three tables the login + `GET /api/v1/domains/:id` path touches. */
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
	CREATE TABLE IF NOT EXISTS domains (
		id               TEXT PRIMARY KEY,
		name             TEXT NOT NULL UNIQUE,
		resend_domain_id TEXT,
		cf_zone_id       TEXT,
		cf_account_id    TEXT,
		status           TEXT NOT NULL DEFAULT 'pending',
		catch_all_mailbox TEXT,
		resend_api_key   TEXT,
		created_at       TEXT NOT NULL
	);
`;

// ── D1Database shim over a real SQLite engine ───────────────────────

/**
 * The exact fragment `getDomain` emits for its drizzle `SELECT`. Used to make
 * only THAT statement fail, so every other query on the request path (auth,
 * session lookup) still runs for real.
 */
const DOMAIN_SELECT = /FROM\s+"?domains"?/i;

/**
 * A `D1Database` whose prepared statements run for real in `node:sqlite`.
 *
 * `failOn` (when given) makes `prepare()` throw for a matching statement —
 * the D1 SDK builds the statement eagerly, so the throw surfaces inside
 * `getDomain`, lands in the handler's `catch`, and nothing downstream runs.
 * The message is deliberately shaped like a driver error: it names the
 * internal SQL and a column that must never reach a client.
 */
function createEnv(
	sqlite: InstanceType<DatabaseSyncLike>,
	failOn: RegExp | null = null,
): Env {
	const shim = {
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		prepare: (sql: string) => {
			if (failOn && failOn.test(sql)) {
				throw new Error(
					"SQLITE_ERROR: no such column: domains.internal_secret_column",
				);
			}
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
	return { DB: shim } as unknown as Env;
}

/** Drizzle / the D1 driver wrap bound values in `{ value }` parameter objects. */
function unwrapDriverValue(arg: unknown): unknown {
	if (arg !== null && typeof arg === "object" && "value" in (arg as object)) {
		return (arg as { value: unknown }).value;
	}
	return arg;
}

/** Create a fresh in-memory database carrying the three tables above. */
function createSqlite(): InstanceType<DatabaseSyncLike> {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");
	const sqlite = new Ctor(":memory:");
	sqlite.exec(SCHEMA_SQL);
	return sqlite as InstanceType<DatabaseSyncLike>;
}

/**
 * Seed an admin whose stored password is a real PBKDF2-SHA256 hash of
 * `password`, written through the same `toStoredPassword` the setup wizard
 * uses — so the login this test performs is genuine, not stubbed.
 */
async function seedAdmin(
	sqlite: InstanceType<DatabaseSyncLike>,
	username: string,
	password: string,
): Promise<void> {
	sqlite
		.prepare(
			"INSERT INTO admins (id, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			crypto.randomUUID(),
			username,
			await toStoredPassword(password),
			new Date().toISOString(),
			new Date().toISOString(),
		);
}

/** Drive the real `POST /api/v1/auth/login` and return the session cookie pair. */
async function loginForCookie(
	sqlite: InstanceType<DatabaseSyncLike>,
): Promise<string> {
	const env = createEnv(sqlite);
	const res = await app.request(
		"/api/v1/auth/login",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: "owner@example.com",
				password: "correct-horse-battery",
			}),
		},
		env,
	);
	assert.strictEqual(res.status, 200, "the real login must succeed for the drive to be valid");
	const cookie = res.headers.get("set-cookie");
	assert.ok(cookie, "a successful login must set a session cookie");
	return cookie.split(";")[0]!;
}

/** Capture `console.error` for the duration of `fn`, returning its calls. */
async function captureConsoleError<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; logs: unknown[][] }> {
	const original = console.error;
	const logs: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		logs.push(args);
	};
	try {
		return { result: await fn(), logs };
	} finally {
		console.error = original;
	}
}

/** Every value in `logs`, flattened to one string for substring checks. */
function flattenLogs(logs: unknown[][]): string {
	return logs
		.flat()
		.map((value) =>
			value instanceof Error
				? `${value.message} ${value.stack ?? ""}`
				: String(value),
		)
		.join(" ");
}

// ── Tests ───────────────────────────────────────────────────────────

describe("admin /api/* error redaction (real routes)", () => {
	it("GET /api/v1/domains/:id answers 500 without echoing the exception message", { skip: sqliteSkip }, async () => {
		const sqlite = createSqlite();
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const cookie = await loginForCookie(sqlite);

		// Same database, but the `domains` SELECT now blows up inside drizzle.
		const env = createEnv(sqlite, DOMAIN_SELECT);

		const { result: res, logs } = await captureConsoleError(async () =>
			await app.request(
				"/api/v1/domains/example.com",
				{ method: "GET", headers: { Cookie: cookie } },
				env,
			),
		);

		assert.strictEqual(
			res.status,
			500,
			"unexpected non-500 path — status code must not change",
		);

		const body = await res.text();
		const parsed = JSON.parse(body) as { error?: string };

		// 1. Stable i18n copy (en — the default locale when no cookie/Accept-Language is sent).
		assert.strictEqual(parsed.error, "Failed to get domain");

		// 2. The regression itself: no fragment of the internal message leaks out.
		assert.ok(
			!body.includes("no such column"),
			`exception message leaked into the response body: ${body}`,
		);
		assert.ok(
			!body.includes("SQLITE_ERROR"),
			`internal driver detail leaked into the response body: ${body}`,
		);

		// 3. The original error is still observable server-side, WITH its stack.
		assert.ok(logs.length > 0, "the exception must still be logged via console.error");
		const flat = flattenLogs(logs);
		assert.ok(
			flat.includes("no such column"),
			"the logged error must retain the original message for debugging",
		);
		assert.ok(
			flat.includes("getDomain"),
			"the logged error must retain the stack (it must name the failing frame)",
		);
	});

	it("reaches the handler, not a middleware 401 — the drive is authenticated", { skip: sqliteSkip }, async () => {
		// Guard against the test silently degrading into an auth check: with the
		// session cookie the request must clear `requireAuth`, and only then does
		// the `domains` failure produce the redacted body asserted above.
		const sqlite = createSqlite();
		await seedAdmin(sqlite, "owner@example.com", "correct-horse-battery");
		const cookie = await loginForCookie(sqlite);

		// Anonymous → 401 long before the handler (documents why a cookie is required).
		const anonymous = await app.request(
			"/api/v1/domains/example.com",
			{ method: "GET" },
			createEnv(sqlite, DOMAIN_SELECT),
		);
		assert.strictEqual(anonymous.status, 401, "no cookie → requireAuth rejects first");

		// With the cookie but a HEALTHY database, the handler completes on the 404
		// branch (`getDomain` returns null) — proving the session really works.
		const healthy = await app.request(
			"/api/v1/domains/example.com",
			{ method: "GET", headers: { Cookie: cookie } },
			createEnv(sqlite),
		);
		assert.strictEqual(healthy.status, 404, "authenticated + healthy DB → handler 404");
		assert.strictEqual(
			((await healthy.json()) as { error?: string }).error,
			"Domain not found",
		);
	});
});
