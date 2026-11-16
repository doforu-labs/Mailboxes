// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Test harness for the demo-instance modules (`workers/demo/*`).
 *
 * Nothing here is stubbed at the module level: the demo code runs against a
 * real SQLite engine (`node:sqlite`) holding a real migrated schema, and a real
 * in-memory object store behind the R2 binding shape. That matters for this
 * feature in particular —
 *
 *   · `reset.ts` talks to D1 in batches and reads back `meta.changes` to claim
 *     `demo_meta`; a promise stub cannot show whether the claim actually
 *     behaves as a compare-and-swap.
 *   · the "a mailbox is an R2 object" trap (`requireMailbox` HEADs
 *     `mailboxes/<email>.json`) only reproduces against a bucket that has
 *     objects.
 *
 * The schema is not hand-copied: every file in `migrations/` is applied in
 * order, so `0014_demo_meta.sql` is exercised exactly as the demo database
 * will see it (and a schema drift breaks these tests instead of production).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "migrations");

type SqliteRow = Record<string, unknown>;

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): SqliteRow[];
		run(...params: unknown[]): { changes?: number | bigint };
	};
};

/** Late-bound so `tsc` under @types/node 20 does not choke on the specifier. */
const NODE_SQLITE_MODULE = "node:sqlite";

let DatabaseSyncCtor: DatabaseSyncLike | null = null;
try {
	DatabaseSyncCtor = ((await import(NODE_SQLITE_MODULE)) as never as {
		DatabaseSync?: DatabaseSyncLike;
	}).DatabaseSync ?? null;
} catch {
	DatabaseSyncCtor = null;
}

/**
 * `node:sqlite` is present at runtime but untyped here. When it is missing every
 * execution case reports as SKIPPED — never as a silent pass.
 */
export const sqliteSkip: string | false = DatabaseSyncCtor
	? false
	: "node:sqlite is unavailable (needs Node >= 22)";

export type Sqlite = InstanceType<DatabaseSyncLike>;

/** Every migration, in filename order (0000 … 0014). */
export function migrationSql(): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"));
}

/** A `D1Database` over a real SQLite engine, schema fully migrated. */
export function createDb(): { db: D1Database; sqlite: Sqlite } {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");
	const sqlite = new Ctor(":memory:");
	for (const sql of migrationSql()) sqlite.exec(sql);

	type Statement = D1PreparedStatement & {
		readonly sql: string;
		readonly values: unknown[];
	};

	const makeStatement = (sql: string): Statement => {
		let values: unknown[] = [];
		const statement = {
			bind(...args: unknown[]) {
				values = args.map(unwrapDriverValue);
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
		// drizzle reads `sql` and `values` off the statement object rather than
		// closing over them, so they have to be real accessors.
		Object.defineProperty(statement, "sql", { get: () => sql });
		Object.defineProperty(statement, "values", { get: () => values });
		return statement as unknown as Statement;
	};

	const shim = {
		prepare: (sql: string) => makeStatement(sql),
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		// D1 batches run every statement and report the affected-row count per
		// statement. `reset.ts` relies on nothing else here, but drizzle's own
		// `db.batch()` path does read the per-statement results.
		batch: async (statements: Statement[]) =>
			statements.map((statement) => {
				const rows = sqlite.prepare(statement.sql).all(...(statement.values as never[]));
				return { results: rows, success: true, meta: { changes: rows.length } };
			}),
	};

	return { db: shim as unknown as D1Database, sqlite };
}

/** Drizzle / the D1 driver wrap bound values in `{ value }` objects. */
function unwrapDriverValue(arg: unknown): unknown {
	if (arg !== null && typeof arg === "object" && "value" in (arg as object)) {
		return (arg as { value: unknown }).value;
	}
	return arg;
}

export type FakeBucket = {
	bucket: R2Bucket;
	/** key → bytes, so tests can assert on what a download would serve. */
	objects: Map<string, Uint8Array>;
};

/** An in-memory R2 bucket: `head` / `get` / `put` / `delete` / `list`. */
export function createBucket(): FakeBucket {
	const objects = new Map<string, Uint8Array>();
	const decoder = new TextDecoder();

	const bucket = {
		async head(key: string) {
			const value = objects.get(key);
			return value ? { key, size: value.byteLength } : null;
		},
		async get(key: string) {
			const value = objects.get(key);
			if (!value) return null;
			return {
				key,
				size: value.byteLength,
				async text() {
					return decoder.decode(value);
				},
				async json() {
					return JSON.parse(decoder.decode(value));
				},
				async arrayBuffer() {
					return value.buffer.slice(
						value.byteOffset,
						value.byteOffset + value.byteLength,
					);
				},
			};
		},
		async put(key: string, value: string | Uint8Array | ArrayBuffer) {
			const bytes =
				typeof value === "string"
					? new TextEncoder().encode(value)
					: value instanceof Uint8Array
						? value
						: new Uint8Array(value);
			objects.set(key, bytes);
			return { key, size: bytes.byteLength };
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
		async list(options: { prefix?: string; cursor?: string } = {}) {
			const prefix = options.prefix ?? "";
			const matched = [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.sort()
				.map((key) => ({ key, uploaded: new Date(0), size: objects.get(key)!.byteLength }));
			return { objects: matched, truncated: false, cursor: undefined };
		},
	};

	return { bucket: bucket as unknown as R2Bucket, objects };
}

/** A live `sessions` row, so requests can be made as a signed-in visitor. */
export function insertSession(sqlite: Sqlite, token: string, expiresAt: Date): void {
	sqlite
		.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)")
		.run(token, new Date().toISOString(), expiresAt.toISOString());
}

/** Read a single number out of the real engine. */
export function count(sqlite: Sqlite, sql: string, ...params: unknown[]): number {
	const rows = sqlite.prepare(sql).all(...(params as never[]));
	const row = rows[0] ?? {};
	return Number(Object.values(row)[0] ?? 0);
}
