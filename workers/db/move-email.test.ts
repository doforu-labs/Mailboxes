// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression tests for `moveEmail` in `workers/db/index.ts`.
 *
 * The bug these guard:
 *
 *   moveEmail resolved its destination folder with
 *   `eq(schema.folders.id, folderId)` alone, while every sibling folder
 *   lookup in the same file — `getEmails` (L248), `createEmail` (L363),
 *   `countEmails` (L301) and `buildSearchConditions` (L1079) — resolves
 *   `name = ref OR id = ref`.
 *
 * `search_emails` / `list_emails` return BOTH `folder_id` and `folder_name`,
 * and `folder_name` is the human-facing display name ("Archive", "Inbox",
 * …) whose lowercased id ("archive") is a different string. A caller that
 * round-trips the display name into `move_email` therefore resolved to no
 * folder row, hit the early `return false`, and the email silently never
 * moved — no error, no write.
 *
 * Two complementary guards are provided:
 *
 *   1. A structural SQL/parameter assertion (no engine required): the
 *      generated lookup must select from `folders` filtered on the mailbox
 *      AND on `name = ? OR id = ?` with the reference bound to BOTH
 *      placeholders; and the following UPDATE must write the *resolved id*,
 *      never the caller's raw reference.
 *   2. Execution tests on a real in-memory SQLite engine (`node:sqlite`,
 *      stable from Node 22) that run the statements `moveEmail` produces
 *      against the real `folders`/`emails` schema from
 *      `migrations/0000_initial.sql`. These fail loudly on the id-only
 *      version when the folder is addressed by name.
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
import { moveEmail } from "./index";

// ── node:sqlite (optional engine) ───────────────────────────────────

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
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

// ── D1Database shim backed by a real SQLite engine ──────────────────

/**
 * A `D1Database` whose prepared statements run for real in `node:sqlite`,
 * with positional `?` binding. Three D1 driver details matter here:
 *
 *   - `raw()` feeds drizzle's D1 session directly, and that session maps a
 *     row positionally (`mapResultRow(fields, row)`), i.e. it expects an
 *     **array of values per row**. `node:sqlite`'s `.all()` yields objects
 *     (`{ id: 'archive' }`), so each row is converted with
 *     `Object.values()` — the same shape conversion D1 performs internally
 *     (`d1ToRawMapping`). Returning the objects verbatim makes every selected
 *     column read back as `undefined`, which surfaces much later as a
 *     confusing `No values to set` from drizzle's update builder.
 *   - drizzle's `.set()` payload slots are "parameter" objects
 *     (`{ value, encoder }`) rather than bare primitives, so bound values are
 *     unwrapped to their `.value` (the D1 driver does the same).
 *   - `first()`/`all()`/`run()` are the non-`raw` shapes.
 */
function createRealSqliteD1(createSchemaSql: string): D1Database {
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
			/** Run the statement with the bound values, as value-arrays. */
			const runRaw = () =>
				sqlite
					.prepare(sql)
					.all(...(values as never[]))
					.map((row) => Object.values(row as Record<string, unknown>));
			const statement = {
				bind(...args: unknown[]) {
					values.push(...args.map(unwrapDriverValue));
					return statement;
				},
				async raw() {
					return runRaw() as never;
				},
				async first() {
					return (runRaw()[0] ?? null) as never;
				},
				async all() {
					return { results: runRaw(), success: true, meta: {} } as never;
				},
				async run() {
					// `changes` mirrors D1's `meta.changes`: `moveEmail` gates its
					// boolean on it, so a shim that reported a constant would make
					// the not-found cases below indistinguishable from a real move.
					// `node:sqlite`'s `run()` reports the affected-row count the
					// same way D1 does.
					const info = sqlite.prepare(sql).run(...(values as never[])) as {
						changes?: number | bigint;
					};
					return {
						results: [],
						success: true,
						meta: { changes: Number(info.changes ?? 0) },
					} as never;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		// Not exercised by moveEmail; present so the cast to D1Database holds.
		batch: async () => [],
	};

	return shim as unknown as D1Database;
}

/** Drizzle "parameter" objects carry their value under `.value`. */
function unwrapDriverValue(arg: unknown): unknown {
	if (arg !== null && typeof arg === "object" && "value" in (arg as object)) {
		return (arg as { value: unknown }).value;
	}
	return arg;
}

/**
 * The real production shape, copied from `migrations/0000_initial.sql`:
 * `folders` is keyed `(mailbox_id, id)` and carries a human-readable `name`.
 */
const SCHEMA_SQL = `
	CREATE TABLE folders (
		mailbox_id TEXT NOT NULL,
		id TEXT NOT NULL,
		name TEXT NOT NULL,
		is_deletable INTEGER NOT NULL DEFAULT 1,
		PRIMARY KEY (mailbox_id, id)
	);
	CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		mailbox_id TEXT NOT NULL,
		folder_id TEXT NOT NULL,
		date TEXT
	);
`;

/** Seed one mailbox whose system folders carry the display-name casing. */
function seedMailbox(db: D1Database) {
	db.exec(`INSERT INTO folders (mailbox_id, id, name) VALUES
		('owner@example.com', 'inbox',   'Inbox'),
		('owner@example.com', 'archive', 'Archive'),
		('owner@example.com', 'sent',    'Sent'),
		('other@example.com', 'archive', 'Archive');`);
	db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, date) VALUES
		('e1', 'owner@example.com', 'inbox', '2026-01-01T00:00:00Z'),
		('e2', 'owner@example.com', 'inbox', '2026-01-02T00:00:00Z'),
		('e3', 'other@example.com', 'inbox', '2026-01-03T00:00:00Z');`);
}

/**
 * Read the `folder_id` stored on an email, through the same shim handle.
 *
 * D1's driver hands `raw()` rows to drizzle positionally, so the shim must
 * too; `node:sqlite` returns objects. Mirrors drizzle's own
 * `d1ToRawMapping(results)`.
 */
async function folderIdOf(db: D1Database, emailId: string): Promise<string | undefined> {
	const res = (await db
		.prepare(`SELECT folder_id FROM emails WHERE id = ?`)
		.bind(emailId)
		.all()) as { results: unknown[][] };
	return res.results[0]?.[0] as string | undefined;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("moveEmail folder resolution (regression: name-or-id)", () => {
	it("resolves the destination folder by name OR id within the mailbox", async () => {
		// Structural guard, engine-free: capture the exact SQL + bound values
		// that moveEmail hands to the database.
		const captured: { sql: string; args: unknown[] }[] = [];
		const captureDb = {
			prepare(sql: string) {
				const args: unknown[] = [];
				captured.push({ sql, args });
				const stmt = {
					bind(...a: unknown[]) {
						args.push(...a);
						return stmt;
					},
					async raw() {
						return [];
					},
					async first() {
						return null;
					},
					async all() {
						return { results: [], success: true, meta: {} };
					},
					async run() {
						return { results: [], success: true, meta: {} };
					},
				};
				return stmt as unknown as D1PreparedStatement;
			},
			batch: async () => [],
		} as unknown as D1Database;

		// Only the lookup runs: `raw()` returns no rows, so moveEmail takes the
		// not-found branch and never reaches the UPDATE.
		const result = await moveEmail(captureDb, "owner@example.com", "e1", "Archive");

		assert.strictEqual(result, false, "no folder row → false (unchanged contract)");
		assert.strictEqual(captured.length, 1, "the lookup is the only statement issued");

		const { sql, args } = captured[0]!;
		const normalized = sql.replace(/["`]/g, "").replace(/\s+/g, " ").trim();		assert.ok(
			normalized.includes("from folders"),
			`destination must be resolved against folders, got: ${sql}`,
		);
		// THE regression: id-only. Both `name` and `id` must be considered.
		assert.ok(
			normalized.includes("folders.name = ?"),
			`folder display names must resolve, got: ${sql}`,
		);
		assert.ok(
			normalized.includes("folders.id = ?"),
			`folder ids must keep working, got: ${sql}`,
		);
		assert.ok(
			normalized.includes("folders.mailbox_id = ?"),
			`resolution must stay scoped to the mailbox, got: ${sql}`,
		);
		// The reference is bound to name AND id, so a name in the argument
		// position still matches the name column.
		assert.deepStrictEqual(
			args,
			["owner@example.com", "Archive", "Archive", 1],
			`mailbox + reference (x2) must be bound, got: ${JSON.stringify(args)}`,
		);
	});

	it("writes the resolved folder id, not the caller's raw reference", async () => {
		const captured: { sql: string; args: unknown[] }[] = [];
		const captureDb = {
			prepare(sql: string) {
				const args: unknown[] = [];
				captured.push({ sql, args });
				const stmt = {
					bind(...a: unknown[]) {
						args.push(...a);
						return stmt;
					},
					async raw() {
						// The lookup row: the display name "Archive" resolves to
						// the canonical id "archive".
						return captured.length === 1 ? [["archive"]] : [];
					},
					async first() {
						return null;
					},
					async all() {
						return { results: [], success: true, meta: {} };
					},
					async run() {
						// One row affected — this scenario models a *real* move, so the
						// affected-row count must be non-zero for `moveEmail` to report
						// success (it now gates on `meta.changes`).
						return { results: [], success: true, meta: { changes: 1 } };
					},
				};
				return stmt as unknown as D1PreparedStatement;
			},
			batch: async () => [],
		} as unknown as D1Database;

		const result = await moveEmail(captureDb, "owner@example.com", "e1", "Archive");

		assert.strictEqual(result, true, "a resolved folder → true (unchanged contract)");
		assert.strictEqual(captured.length, 2, "lookup + update");

		const update = captured[1]!;
		assert.ok(
			/^update\s+emails/i.test(update.sql.replace(/["`]/g, "").trim()),
			`second statement must be the UPDATE, got: ${update.sql}`,
		);
		assert.strictEqual(
			update.args[0],
			"archive",
			"folder_id must store the resolved id; storing the display name would orphan the row",
		);
		assert.ok(
			!update.args.includes("Archive"),
			`the raw reference must not be persisted: ${JSON.stringify(update.args)}`,
		);
	});

	it("refuses a folder that belongs to another mailbox", async () => {
		const captured: { sql: string; args: unknown[] }[] = [];
		const captureDb = {
			prepare(sql: string) {
				const args: unknown[] = [];
				captured.push({ sql, args });
				const stmt = {
					bind(...a: unknown[]) {
						args.push(...a);
						return stmt;
					},
					async raw() {
						return [];
					},
					async first() {
						return null;
					},
					async all() {
						return { results: [], success: true, meta: {} };
					},
					async run() {
						return { results: [], success: true, meta: {} };
					},
				};
				return stmt as unknown as D1PreparedStatement;
			},
			batch: async () => [],
		} as unknown as D1Database;

		const result = await moveEmail(captureDb, "owner@example.com", "e1", "Archive");
		assert.strictEqual(result, false);
		assert.strictEqual(captured.length, 1, "no UPDATE is attempted without a folder row");
	});

	it("moves an email addressed by folder display name", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		const ok = await moveEmail(db, "owner@example.com", "e1", "Archive");
		assert.strictEqual(ok, true, "'Archive' must resolve (this is the reported bug)");

		assert.strictEqual(await folderIdOf(db, "e1"), "archive");

		// The sibling email in the same folder is untouched.
		assert.strictEqual(await folderIdOf(db, "e2"), "inbox");

		// A decoy email in another mailbox in a folder with the same name must
		// not be touched — the UPDATE is mailbox-scoped.
		assert.strictEqual(await folderIdOf(db, "e3"), "inbox");
	});

	it("still accepts a folder addressed by its canonical id", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		// Lower-case id — matched by `id = ?`. This is what the internal REST
		// route (`workers/index.ts`) and the frontend toolbar send.
		const lower = await moveEmail(db, "owner@example.com", "e2", "archive");
		assert.strictEqual(lower, true);
		assert.strictEqual(await folderIdOf(db, "e2"), "archive");
	});

	it("upper-cases the legacy 'ARCHIVE'-style id without throwing", { skip: sqliteSkip }, async () => {
		// `workers/db/db.test.ts` calls moveEmail with "ARCHIVE", and that
		// pre-existing call must keep neither throwing nor changing an email:
		// "ARCHIVE" matches neither `id = 'archive'` nor `name = 'Archive'`.
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		const ok = await moveEmail(db, "owner@example.com", "e2", "ARCHIVE");
		assert.strictEqual(ok, false);
		assert.strictEqual(await folderIdOf(db, "e2"), "inbox", "no write on failure");
	});

	it("returns false for an unknown folder and leaves the email alone", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		const ok = await moveEmail(db, "owner@example.com", "e1", "Nope");
		assert.strictEqual(ok, false);

		assert.strictEqual(await folderIdOf(db, "e1"), "inbox", "no write on failure");
	});

	it("does not resolve a folder name belonging to a different mailbox", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);
		// A mailbox that has no 'Archive' folder of its own.
		await db
			.prepare(`INSERT INTO folders (mailbox_id, id, name) VALUES (?, ?, ?)`)
			.bind("nofolders@example.com", "inbox", "Inbox")
			.run();

		const ok = await moveEmail(db, "nofolders@example.com", "e3", "Archive");
		assert.strictEqual(ok, false, "folder lookup must stay mailbox-scoped");
	});
});

// ── Email existence (regression: unconditional `return true`) ──────

/**
 * The second bug these guard:
 *
 *   `moveEmail` resolved its destination folder, ran the UPDATE
 *   `emails SET folder_id = ? WHERE id = ? AND mailbox_id = ?`, and then
 *   returned `true` **unconditionally** — it never looked at how many rows
 *   the UPDATE had actually touched. A folder that resolves while the email
 *   does not exist (a stale id, a typo, an id belonging to another mailbox)
 *   therefore matched zero rows and *still* answered `true`: the caller — and,
 *   through it, the `move_email` tool — was told the email had been moved
 *   when nothing was written.
 *
 *   The fix reads `result.meta.changes` (the D1 affected-row count, the same
 *   signal the sibling `tryInsertDomain` / `createFirstAdmin` /
 *   `updateAdminPassword` helpers in `workers/db/index.ts` already gate on)
 *   and returns `true` only when it is `> 0`.
 *
 * Both halves are pinned: an engine-free structural guard that drives the
 * `meta.changes` values directly, and execution tests on real SQLite for the
 * true/false split against genuinely present / absent rows.
 */
describe("moveEmail email existence (regression: 0 rows must be false)", () => {
	/**
	 * A db whose folder lookup always resolves (so execution reaches the
	 * UPDATE) and whose UPDATE reports a caller-chosen `meta.changes`.
	 */
	function dbWithUpdateChanges(changes: number | undefined, captured: string[] = []): D1Database {
		return {
			prepare(sql: string) {
				captured.push(sql);
				const stmt = {
					bind: () => stmt,
					// The folder lookup: one row, id 'archive'.
					async raw() {
						return [["archive"]] as never;
					},
					async first() {
						return null;
					},
					async all() {
						return { results: [], success: true, meta: {} };
					},
					async run() {
						return {
							results: [],
							success: true,
							meta: changes === undefined ? {} : { changes },
						} as never;
					},
				};
				return stmt as unknown as D1PreparedStatement;
			},
			batch: async () => [],
		} as unknown as D1Database;
	}

	it("returns false when the UPDATE matched zero rows", async () => {
		const captured: string[] = [];
		// The folder resolves, but the email does not exist → 0 rows changed.
		const result = await moveEmail(
			dbWithUpdateChanges(0, captured),
			"owner@example.com",
			"no-such-email",
			"Archive",
		);

		assert.strictEqual(result, false, "0 changed rows must NOT report a successful move");
		// The UPDATE is still *issued* (the folder resolved) — it simply matched
		// nothing. Only its effect count decides the result.
		assert.strictEqual(captured.length, 2, "lookup + update were both issued");
	});

	it("returns true when the UPDATE matched exactly one row", async () => {
		const result = await moveEmail(
			dbWithUpdateChanges(1),
			"owner@example.com",
			"e1",
			"Archive",
		);
		assert.strictEqual(result, true, "a real move must keep reporting true");
	});

	it("returns true when the UPDATE matched several rows", async () => {
		const result = await moveEmail(
			dbWithUpdateChanges(3),
			"owner@example.com",
			"e1",
			"Archive",
		);
		assert.strictEqual(result, true);
	});

	it("fails closed when the driver reports no change count at all", async () => {
		// Defensive: an absent `meta` must not be read as a phantom success.
		const result = await moveEmail(
			dbWithUpdateChanges(undefined),
			"owner@example.com",
			"e1",
			"Archive",
		);
		assert.strictEqual(result, false);
	});

	it("returns false for an email that does not exist, and writes nothing", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		// The folder resolves fine — only the email is unknown.
		const ok = await moveEmail(db, "owner@example.com", "ghost", "Archive");
		assert.strictEqual(ok, false, "a non-existent email must not report a move");

		// Nothing anywhere was touched.
		assert.strictEqual(await folderIdOf(db, "e1"), "inbox");
		assert.strictEqual(await folderIdOf(db, "e2"), "inbox");
		assert.strictEqual(await folderIdOf(db, "e3"), "inbox");
	});

	it("returns false for an email belonging to a different mailbox", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		// `e3` exists, but lives in `other@example.com`. The UPDATE is
		// mailbox-scoped, so it matches zero rows for this caller.
		const ok = await moveEmail(db, "owner@example.com", "e3", "Archive");
		assert.strictEqual(ok, false, "the email is not in this mailbox — no move happened");
		assert.strictEqual(await folderIdOf(db, "e3"), "inbox", "the other mailbox's row is untouched");
	});

	it("returns true for an email that does exist, and really moves it", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		seedMailbox(db);

		const ok = await moveEmail(db, "owner@example.com", "e1", "Archive");
		assert.strictEqual(ok, true, "an existing email must report true");
		assert.strictEqual(await folderIdOf(db, "e1"), "archive", "and the row must really have moved");
	});
});
