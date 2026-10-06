// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Shared support module for exercising the REAL `workers/setup.ts` Hono app
 * outside the Workers runtime.
 *
 * NOT a test file: the name deliberately does not end in `.test.ts`, so
 * `npm test` ('workers/**&#47;*.test.ts') never collects it. Two consumers use it:
 *
 *   1. `workers/setup-domain-state.test.ts` — deterministic, fully offline
 *      route tests (every network call stubbed).
 *   2. `scripts/verify-domain-live.mjs` — the LIVE run against real domains,
 *      where the same app is mounted but `fetch` is NOT stubbed, so the DoH
 *      lookups genuinely leave the machine.
 *
 * ── The insight this module encodes ────────────────────────────────────────
 * `setup.ts` mounts its routes on a bare `new Hono<{ Bindings: Env }>()`, i.e.
 * WITHOUT the `/api/*` locale middleware and the `requireAuth` guard that
 * `workers/index.ts` layers on top. So mounting the sub-app on a fresh Hono
 * instance exercises the production handlers while bypassing the cookie
 * session — no login, no network, no `index.ts`.
 *
 * `verify-mx` needs no bindings at all; `POST /api/v1/domains/:id/verify-resend`
 * resolves its translator through `index.ts`'s namespace, so it is mounted
 * through a faithful copy of exactly two lines of that middleware chain
 * (locale + cors — no auth). Every other route here only needs `env.DB` /
 * `env.BUCKET`.
 *
 * ── Why a real SQLite engine ───────────────────────────────────────────────
 * `domains` reads go through drizzle (`db.getDomain`) and `initMailboxFolders`
 * issues a `db.batch()` of INSERTs. A hand-rolled "return an object" fake would
 * silently exercise nothing. `node:sqlite` (Node >= 22) runs the statements for
 * real, so the assertions are about actual SQL effects — e.g. exactly six
 * `folders` rows written by the catch-all path.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getBackendT } from "../shared/i18n/translate";
import { resolveLocale } from "../shared/i18n/config";
import type { Env } from "./types";

// ── node:sqlite (optional engine) ───────────────────────────────────

type SqliteRow = Record<string, unknown>;

type SqliteStatement = {
	all(...params: unknown[]): SqliteRow[];
	run(...params: unknown[]): { changes?: number | bigint };
};

type SqliteDatabase = {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
};

type DatabaseSyncLike = new (path: string) => SqliteDatabase;

/**
 * Late-bound specifier: a literal `import("node:sqlite")` fails type-checking
 * under this repo's @types/node (20.x) even though Node >= 22 has the module.
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

/**
 * `false` when the SQLite engine is available, otherwise a skip reason. Tests
 * pass it straight to `it(..., { skip })` so a missing engine reports SKIPPED
 * — never a silent pass, which would be a false green.
 */
export const sqliteSkip: string | false = DatabaseSyncCtor
	? false
	: "node:sqlite is unavailable (needs Node >= 22)";

/** Whether the real SQLite engine is usable in this process. */
export function hasSqliteEngine(): boolean {
	return DatabaseSyncCtor !== null;
}

// ── Schema (mirrors migrations 0000/0002/0003/0005/0009) ────────────

/** Every table the routes under test touch. */
export const SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS folders (
		mailbox_id   TEXT NOT NULL,
		id           TEXT NOT NULL,
		name         TEXT NOT NULL,
		is_deletable INTEGER NOT NULL DEFAULT 1,
		PRIMARY KEY (mailbox_id, id)
	);
	CREATE TABLE IF NOT EXISTS domains (
		id                TEXT PRIMARY KEY,
		name              TEXT NOT NULL UNIQUE,
		resend_domain_id  TEXT,
		cf_zone_id        TEXT,
		cf_account_id     TEXT,
		status            TEXT NOT NULL DEFAULT 'pending',
		catch_all_mailbox TEXT,
		resend_api_key    TEXT,
		created_at        TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS sessions (
		token      TEXT PRIMARY KEY,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
`;

/** Fresh in-memory database carrying the tables above. */
export function createSqlite(): SqliteDatabase {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite is unavailable (needs Node >= 22)");
	const sqlite = new Ctor(":memory:");
	sqlite.exec(SCHEMA_SQL);
	return sqlite;
}

// ── D1Database shim over the real SQLite engine ─────────────────────

/** Drizzle / the D1 driver wrap bound values in `{ value }` parameter objects. */
function unwrapDriverValue(arg: unknown): unknown {
	if (arg !== null && typeof arg === "object" && "value" in (arg as object)) {
		return (arg as { value: unknown }).value;
	}
	return arg;
}

/**
 * Minimal `D1PreparedStatement` that executes for real against `node:sqlite`.
 *
 * `head()`-driven code paths (`R2Bucket`) are unaffected; what matters is that
 * `first()` (plain SELECTs, drizzle `.get()`) and `run()`/`batch()` (drizzle
 * writes, `initMailboxFolders`) round-trip through a genuine engine.
 */
function createShim(sqlite: SqliteDatabase): D1Database {
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
					const info = sqlite.prepare(sql).run(...(values as never[]));
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
		// `initMailboxFolders` writes through `db.batch()`; each statement is a
		// prepared `D1PreparedStatement`, so delegate to its `run()`.
		batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
			const results: unknown[] = [];
			for (const statement of statements) results.push(await statement.run());
			return results as never;
		},
	};
	return shim as unknown as D1Database;
}

// ── Fake R2 bucket (in-memory) ──────────────────────────────────────

export type FakeBucket = {
	objects: Map<string, { body: string; contentType?: string }>;
	head: (key: string) => Promise<unknown>;
	get: (key: string) => Promise<unknown>;
	put: (key: string, value: unknown, options?: FakeBucketPutOptions) => Promise<unknown>;
	delete: (keys: string | string[]) => Promise<void>;
	list: () => Promise<unknown>;
	/** Raw object bodies, in insertion order. */
	keys(): string[];
	/** Parsed JSON body of `key`, or `undefined` when absent. */
	json<T = unknown>(key: string): T | undefined;
};

export type FakeBucketPutOptions = { httpMetadata?: { contentType?: string } };

/** An in-memory stand-in for the `BUCKET` R2 binding. */
export function createFakeBucket(): FakeBucket {
	const objects = new Map<string, { body: string; contentType?: string }>();
	const asArrayBuffer = (value: unknown): ArrayBuffer => {
		if (typeof value === "string") {
			const encoded = new TextEncoder().encode(value);
			return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
		}
		if (value instanceof ArrayBuffer) return value;
		if (value instanceof Uint8Array) {
			return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
		}
		const encoded = new TextEncoder().encode(String(value));
		return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
	};

	const bucket = {
		objects,
		async head(key: string) {
			const obj = objects.get(key);
			return obj ? { key, size: obj.body.length } : null;
		},
		async get(key: string) {
			const obj = objects.get(key);
			if (!obj) return null;
			return {
				key,
				size: obj.body.length,
				async text() {
					return obj.body;
				},
				async json() {
					return JSON.parse(obj.body);
				},
				async arrayBuffer() {
					return asArrayBuffer(obj.body);
				},
			};
		},
		async put(
			key: string,
			value: unknown,
			options?: FakeBucketPutOptions,
		) {
			objects.set(key, {
				body: typeof value === "string" ? value : String(value),
				contentType: options?.httpMetadata?.contentType,
			});
			return { key };
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
		async list() {
			return {
				objects: [...objects.keys()].map((key) => ({ key, size: objects.get(key)!.body.length })),
				truncated: false,
			};
		},
		keys() {
			return [...objects.keys()];
		},
		json<T = unknown>(key: string): T | undefined {
			const obj = objects.get(key);
			return obj ? (JSON.parse(obj.body) as T) : undefined;
		},
	};
	return bucket;
}

// ── env + app construction ──────────────────────────────────────────

export type TestEnv = Env & { BUCKET: R2Bucket };
export type TestEnvOverrides = Partial<Record<keyof TestEnv, unknown>>;

/** Build an `Env` with a real-SQLite `DB` and an in-memory `BUCKET`. */
export function createEnv(
	sqlite: SqliteDatabase,
	bucket: FakeBucket = createFakeBucket(),
	overrides: TestEnvOverrides = {},
): TestEnv {
	return {
		...overrides,
		DB: ("DB" in overrides ? overrides.DB : createShim(sqlite)) as D1Database,
		BUCKET: ("BUCKET" in overrides ? overrides.BUCKET : bucket) as R2Bucket,
	} as unknown as TestEnv;
}

type SetupApp = {
	/** `request(path, init, env)` — `env` may be the env itself or `{ env }`. */
	request(path: string, init?: RequestInit, env?: unknown): Promise<Response>;
};

/**
 * Extract an env object out of either a duck-typed env or the execute options
 * bag Hono accepts as `app.request(path, init, third)`.
 *
 * Hono's `request` third parameter accepts EITHER an `Env` / bindings object
 * directly OR an options bag `{ env }`. Both call styles are used across this
 * repo's tests, so normalize here instead of forcing callers to remember.
 */
function resolveEnv(third: unknown): unknown {
	if (third && typeof third === "object" && "env" in (third as object)) {
		return (third as { env: unknown }).env;
	}
	return third;
}

/**
 * Mount the real `setup.ts` sub-app the way `index.ts` does, minus the
 * session guard.
 *
 * `bypassAuth` additionally reproduces the two NON-auth middlewares index.ts
 * runs on `/api/*`:
 *
 *   - the locale middleware (`c.set("locale")` / `c.set("t")`) — required by
 *     `POST /api/v1/domains/:id/verify-resend`, which reads `c.get("t")`
 *     (the `api` namespace) and always runs for cookie-session callers;
 *   - `cors()`, which is inert for server-side `app.request()` drives.
 *
 * No `requireAuth` is involved: the sub-app is mounted directly, which is the
 * documented way these handlers are exercised outside the Workers runtime.
 */
export async function createSetupApp(options: { bypassAuth?: boolean } = {}): Promise<SetupApp> {
	const app = new Hono();
	const { default: setup } = await import("./setup");
	if (options.bypassAuth) {
		app.use("/api/*", async (c, next) => {
			const locale = resolveLocale(c.req.raw);
			c.set("locale" as never, locale);
			c.set("t" as never, getBackendT(locale));
			await next();
		});
		app.use("/api/*", cors());
	}
	app.route("/", setup as never);

	// Normalize the third argument to `request()` (see `resolveEnv`). Wrapping
	// the RAW Hono instance keeps its own `request` bound to it.
	const raw = app as unknown as SetupApp;
	return {
		request: (path, init, env) => raw.request(path, init, resolveEnv(env)),
	};
}

// ── Small assertion helpers ─────────────────────────────────────────

/** Seed a `domains` row and return its id. */
export function seedDomain(
	sqlite: SqliteDatabase,
	row: {
		id?: string;
		name: string;
		status?: string;
		catch_all_mailbox?: string | null;
		resend_domain_id?: string | null;
		resend_api_key?: string | null;
		cf_zone_id?: string | null;
		cf_account_id?: string | null;
	},
): string {
	const id = row.id ?? `dom_${row.name}`;
	sqlite
		.prepare(
			`INSERT INTO domains (id, name, resend_domain_id, cf_zone_id, cf_account_id, status, catch_all_mailbox, resend_api_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			row.name,
			row.resend_domain_id ?? null,
			row.cf_zone_id ?? null,
			row.cf_account_id ?? null,
			row.status ?? "pending",
			row.catch_all_mailbox ?? null,
			row.resend_api_key ?? null,
			new Date().toISOString(),
		);
	return id;
}

/** Read one column of a `domains` row. */
export function readDomainColumn<T = unknown>(
	sqlite: SqliteDatabase,
	id: string,
	column: string,
): T | undefined {
	const row = sqlite.prepare(`SELECT ${column} AS value FROM domains WHERE id = ?`).all(id)[0];
	return row ? (row.value as T) : undefined;
}

/** Every `folders` row for a mailbox, ordered deterministically. */
export function readFolderRows(
	sqlite: SqliteDatabase,
	mailboxId: string,
): Array<{ id: string; name: string; is_deletable: number }> {
	return sqlite
		.prepare("SELECT id, name, is_deletable FROM folders WHERE mailbox_id = ? ORDER BY id")
		.all(mailboxId) as Array<{ id: string; name: string; is_deletable: number }>;
}

/** Seed a live admin session so `requireAuth` accepts a cookie. */
export function seedSession(sqlite: SqliteDatabase, token: string): string {
	const now = new Date();
	sqlite
		.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)")
		.run(token, now.toISOString(), new Date(now.getTime() + 3_600_000).toISOString());
	return token;
}
