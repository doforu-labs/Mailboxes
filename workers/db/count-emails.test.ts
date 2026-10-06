// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression tests for `countEmails` in `workers/db/index.ts`.
 *
 * The bug these guard (present since 0538d529, the D1 query refactor):
 *
 *   conditions.push(
 *     `folder_id = (SELECT id FROM folders WHERE mailbox_id = ?${paramIdx} AND (name = ?${paramIdx} OR id = ?${paramIdx}) LIMIT 1)`
 *   );
 *
 * `paramIdx` is 2 here, but only ONE value is pushed for the folder (`params
 * = [mailboxId, folder]`). So the subquery bound the *folder name* to the
 * `mailbox_id` column: `mailbox_id = ?2` compared an address against a folder
 * slug, matched nothing, the scalar subquery yielded NULL, `folder_id = NULL`
 * is never true, and the outer `SELECT COUNT(*)` returned 0 for every folder.
 *
 * Every sibling subquery in the same file (L582/L638/L672/L744/L758) has the
 * correct `mailbox_id = ?1 AND (name = ?2 OR id = ?2)`, and the equivalent
 * drizzle/kysely builders (L193/L214/L1047) also reuse the SAME placeholder for
 * the mailbox — L269 was the sole deviation.
 *
 * Why the existing tests could not catch it: `workers/db/db.test.ts`'s
 * `MockStatement.bind()` throws the bound values away and looks rows up by the
 * SQL *string*, so a wrong parameter *number* inside an otherwise identical
 * string is invisible. These tests therefore go one level deeper.
 *
 * Two complementary guards are provided:
 *
 *   1. A structural SQL assertion (no engine required): the generated `WHERE`
 *      clause with a folder must bind the mailbox as `?1`, and must NOT contain
 *      the swapped `mailbox_id = ?2 ...` shape.
 *   2. An execution test on a real in-memory SQLite engine (`node:sqlite`,
 *      stable from Node 22) that runs the actual statement `countEmails`
 *      produces against a `folders`/`emails` schema. This is the one that fails
 *      loudly on the buggy version (0 instead of N) and passes on the fix.
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
import { countEmails } from "./index";

// ── node:sqlite (optional engine) ───────────────────────────────────

/** Minimal structural type; keeps this test free of engine typings. */
type SqliteStatement = {
	bind(...params: unknown[]): SqliteStatement;
	/** Run the statement with positional `?N` binding and return the rows. */
	all(...params: unknown[]): unknown[];
};

type SqliteDatabase = {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
};

/**
 * Late-bound module specifier: a literal `import("node:sqlite")` would fail
 * type-checking under @types/node 20.x even though the runtime supports it.
 * On Node < 22.5 the import throws and the execution cases skip.
 */
const NODE_SQLITE_MODULE = "node:sqlite";

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
};

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

// ── D1Database shim backed by a real SQLite engine ──────────────────

/**
 * A `D1Database` whose prepared statements are executed for real by
 * `node:sqlite`, including positional `?N` binding. `countEmails` only uses
 * `prepare().bind().first()`, which is all this needs to translate:
 *
 *   - `bind(...)` stores the values (mirroring D1's chainable statement);
 *   - `first()` runs the statement with the stored values and returns row 0.
 *     node:sqlite supports the positional `?N` form natively — including a
 *     placeholder referenced more than once (`(name = ?2 OR id = ?2)`) — so the
 *     SQL is passed through verbatim.
 *
 * This is the crux of the test: it makes the *parameter numbers* matter. A
 * statement with a swapped `?N` executes with the wrong value in the wrong
 * column and returns the wrong count.
 */
function createRealSqliteD1(createSchemaSql: string): D1Database {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");

	const sqlite = new Ctor(":memory:");
	sqlite.exec(createSchemaSql);

	/** Expose `exec` so tests can seed rows without another handle. */
	(sqlite as unknown as { __exec: (sql: string) => void }).__exec = (sql: string) =>
		sqlite.exec(sql);

	return {
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		prepare: (sql: string) => {
			const values: unknown[] = [];

			const run = () => {
				// node:sqlite supports the positional `?N` form natively, including
				// a placeholder referenced more than once
				// (`(name = ?2 OR id = ?2)`) — pass it through verbatim.
				const stmt = sqlite.prepare(sql);
				return stmt.all(...values) as Array<Record<string, unknown>>;
			};

			const statement = {
				bind(...args: unknown[]) {
					values.push(...args);
					return statement;
				},
				async first() {
					const rows = run();
					return (rows[0] ?? null) as never;
				},
				async all() {
					const rows = run();
					return { results: rows, success: true, meta: {} } as never;
				},
				async run() {
					const rows = run();
					return { results: rows, success: true, meta: {} } as never;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		// Not exercised by countEmails; present so the cast to D1Database holds.
		batch: async () => [],
	} as unknown as D1Database;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("countEmails folder filter (regression: parameter index)", () => {
	it("cannot regress to `mailbox_id = ?2 ...` in the folder subquery", () => {
		// Plan-A style structural guard, engine-free: capture the exact SQL that
		// countEmails hands to the database and assert on the placeholder
		// numbers. The buggy version produced `WHERE mailbox_id = ?1 AND
		// folder_id = (SELECT id FROM folders WHERE mailbox_id = ?2 AND ...)`,
		// which binds the folder value to the mailbox column.
		const captured: string[] = [];
		const captureDb = {
			prepare(sql: string) {
				captured.push(sql);
				return {
					bind() {
						return this;
					},
					async first() {
						return { total: 0 };
					},
				} as unknown as D1PreparedStatement;
			},
		} as unknown as D1Database;

		return countEmails(captureDb, "owner@example.com", "inbox").then(() => {
			assert.strictEqual(captured.length, 1);
			const sql = captured[0]!;

			// The subquery must reference the mailbox with the SAME placeholder
			// as the outer query (?1), not the folder's placeholder.
			assert.ok(
				sql.includes("WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2)"),
				`folder subquery must bind the mailbox as ?1, got: ${sql}`,
			);
			// And the swapped shape must be gone for good.
			assert.ok(
				!sql.includes("WHERE mailbox_id = ?2"),
				`mailbox must never be bound to the folder parameter, got: ${sql}`,
			);
		});
	});

	it("counts the emails actually in the requested folder", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(
			`CREATE TABLE folders (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, name TEXT NOT NULL);
			 CREATE TABLE emails (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, folder_id TEXT, thread_id TEXT);`,
		);

		// One mailbox with an inbox holding 3 emails, plus decoys in other
		// folders/mailboxes that a misfiltering query could wrongly include.
		db.exec(`INSERT INTO folders (id, mailbox_id, name) VALUES
			('f-inbox', 'owner@example.com', 'inbox'),
			('f-archive', 'owner@example.com', 'archive'),
			('f-other-inbox', 'other@example.com', 'inbox');`);
		db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, thread_id) VALUES
			('e1', 'owner@example.com', 'f-inbox', 't1'),
			('e2', 'owner@example.com', 'f-inbox', 't1'),
			('e3', 'owner@example.com', 'f-inbox', 't2'),
			('e4', 'owner@example.com', 'f-archive', 't3'),
			('e5', 'other@example.com', 'f-other-inbox', 't4');`);

		// Buggy version: the subquery bound the folder name to mailbox_id, so
		// `folder_id = NULL` and this returned 0.
		const inboxCount = await countEmails(db, "owner@example.com", "inbox");
		assert.strictEqual(inboxCount, 3, "inbox must count its 3 emails, not 0");

		// Resolving the folder by its id must behave identically (the subquery
		// matches `name = ?2 OR id = ?2`).
		const byId = await countEmails(db, "owner@example.com", "f-inbox");
		assert.strictEqual(byId, 3, "folder id and folder name must agree");

		// A decoy folder in another mailbox must not leak into the count.
		const archiveCount = await countEmails(db, "owner@example.com", "archive");
		assert.strictEqual(archiveCount, 1);
	});

	it("still honours the threadId filter together with the folder", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(
			`CREATE TABLE folders (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, name TEXT NOT NULL);
			 CREATE TABLE emails (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, folder_id TEXT, thread_id TEXT);`,
		);
		db.exec(`INSERT INTO folders (id, mailbox_id, name) VALUES ('f-inbox', 'owner@example.com', 'inbox');`);
		db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, thread_id) VALUES
			('e1', 'owner@example.com', 'f-inbox', 't1'),
			('e2', 'owner@example.com', 'f-inbox', 't1'),
			('e3', 'owner@example.com', 'f-inbox', 't2');`);

		// threadId is ?3 here — correct in both versions; this pins that the
		// fix did not shift the folder/thread placeholders.
		const count = await countEmails(db, "owner@example.com", "inbox", "t1");
		assert.strictEqual(count, 2);
	});

	it("counts every email in the mailbox when no folder is given", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(
			`CREATE TABLE folders (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, name TEXT NOT NULL);
			 CREATE TABLE emails (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, folder_id TEXT, thread_id TEXT);`,
		);
		db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, thread_id) VALUES
			('e1', 'owner@example.com', 'f-inbox', 't1'),
			('e2', 'owner@example.com', 'f-archive', 't2'),
			('e3', 'other@example.com', 'f-inbox', 't3');`);

		const count = await countEmails(db, "owner@example.com");
		assert.strictEqual(count, 2);
	});
});
