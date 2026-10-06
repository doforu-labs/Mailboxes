// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression tests for `getMailboxLatestEmails` in `workers/db/index.ts`.
 *
 * The bug these guard:
 *
 *   The dashboard route (`app/routes/home.tsx`) renders, under every mailbox
 *   row, a "latest email" line (subject + snippet) fed by
 *   `GET /api/v1/mailboxes` → `getMailboxLatestEmails`. That query picked the
 *   newest email per mailbox across **every folder** — no `folder_id` filter —
 *   so a newer draft / sent / trash / archive email hijacked the line. The
 *   sibling `getMailboxUnreadCounts` (L1388) has always filtered
 *   `folder_id = 'inbox'`; this query simply forgot to.
 *
 *   Empirically reproduced on the local D1: mailbox `inbox@demo.local`
 *   rendered the DRAFT titled `s` instead of the latest inbox email.
 *
 *   The second half of the pick was non-deterministic too: the old
 *   `(mailbox_id, date) IN (SELECT mailbox_id, MAX(date) …)` form returns
 *   *several* rows when two emails share a `date` (and several more across
 *   mailboxes), and the map-building loop kept an arbitrary one. The fix keeps
 *   `date IS NOT NULL` inbox rows for which no strictly newer inbox row exists
 *   (`newer.date > date`, or `newer.date = date AND newer.id > id`), so exactly
 *   one row per mailbox wins, `id` breaks date ties, and undated rows never win.
 *
 * Execution tests run the real statements `getMailboxLatestEmails` produces on
 * an in-memory SQLite engine (`node:sqlite`, stable from Node 22); they fail
 * loudly on the folder-blind or non-deterministic versions and pass on the
 * fix.
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
import { getMailboxLatestEmails } from "./index";

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
 * A `D1Database` whose prepared statements run for real in `node:sqlite`.
 * `getMailboxLatestEmails` goes through drizzle's D1 session, which reads rows
 * via `raw()` and maps them **positionally** (`mapResultRow(fields, row)`) —
 * it expects an array of values per row. `node:sqlite`'s `.all()` yields
 * objects (`{ subject: '…' }`), so each row is converted with
 * `Object.values()` — the same shape conversion D1 performs internally
 * (`d1ToRawMapping`). Returning the objects verbatim makes every selected
 * column read back as `undefined`.
 */
function createRealSqliteD1(createSchemaSql: string): D1Database {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");

	const sqlite = new Ctor(":memory:");
	sqlite.exec(createSchemaSql);

	/** Expose `exec` so tests can seed rows without another handle. */
	(sqlite as unknown as { __exec: (sql: string) => void }).__exec = (sql: string) =>
		sqlite.exec(sql);

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
					return { results: [], success: true, meta: {} } as never;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		// Not exercised by getMailboxLatestEmails; present so the cast holds.
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
 * The columns `getMailboxLatestEmails` touches, copied from the real
 * `emails` table (`migrations/0000_initial.sql`).
 */
const SCHEMA_SQL = `
	CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		mailbox_id TEXT NOT NULL,
		folder_id TEXT NOT NULL,
		subject TEXT,
		sender TEXT,
		sender_name TEXT,
		date TEXT,
		read INTEGER DEFAULT 0,
		body TEXT
	);
`;

// ── Tests ───────────────────────────────────────────────────────────

describe("getMailboxLatestEmails (regression: inbox-only + deterministic)", () => {
	it("picks the latest INBOX email, never a newer draft", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, sender, date, read, body) VALUES
			('draft',  'owner@example.com', 'draft', 's',                                  'me@example.com',    '2026-10-06T10:00:00Z', 0, 'draft body'),
			('inbox1', 'owner@example.com', 'inbox', 'Welcome to your new mailbox',         'welcome@example.com', '2026-02-10T09:00:00Z', 1, 'welcome body'),
			('inbox0', 'owner@example.com', 'inbox', 'Older inbox email',                    'friend@example.com',  '2026-01-01T09:00:00Z', 1, 'older body');`);

		const map = await getMailboxLatestEmails(db, ["owner@example.com"]);
		const latest = map.get("owner@example.com");

		// THE regression: the newer draft must not win.
		assert.strictEqual(
			latest?.subject,
			"Welcome to your new mailbox",
			"the latest *inbox* email must win, not the newer draft",
		);
		assert.strictEqual(latest?.folder_id, "inbox");
		assert.strictEqual(latest?.sender, "welcome@example.com");
		// `read` is surfaced along with the picked row.
		assert.strictEqual(latest?.read, 1);
	});

	it("returns read = 0 for an unread latest inbox email", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, date, read, body) VALUES
			('e-read',   'owner@example.com', 'inbox', 'Already read',   '2026-01-01T00:00:00Z', 1, 'a'),
			('e-unread', 'owner@example.com', 'inbox', 'Fresh and unread','2026-01-02T00:00:00Z', 0, 'b');`);

		const map = await getMailboxLatestEmails(db, ["owner@example.com"]);
		const latest = map.get("owner@example.com");

		assert.strictEqual(latest?.subject, "Fresh and unread");
		assert.strictEqual(latest?.read, 0, "an unread latest email must report read = 0");
	});

	it("is deterministic when two inbox emails share a date", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		// Same date, different ids — `id DESC` must break the tie every run.
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, date, read, body) VALUES
			('aaa', 'owner@example.com', 'inbox', 'Tie A', '2026-03-01T12:00:00Z', 0, 'a'),
			('zzz', 'owner@example.com', 'inbox', 'Tie Z', '2026-03-01T12:00:00Z', 0, 'z');`);

		const map = await getMailboxLatestEmails(db, ["owner@example.com"]);
		// A single, stable call — repeated calls must agree.
		const again = await getMailboxLatestEmails(db, ["owner@example.com"]);

		assert.strictEqual(map.size, 1, "exactly one row per mailbox");
		assert.strictEqual(
			map.get("owner@example.com")?.subject,
			"Tie Z",
			"`id DESC` breaks the date tie deterministically",
		);
		assert.strictEqual(
			again.get("owner@example.com")?.subject,
			map.get("owner@example.com")?.subject,
			"the pick must not change between runs",
		);
	});

	it("never lets a NULL-date inbox row win", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, date, read, body) VALUES
			('undated', 'owner@example.com', 'inbox', 'No date',      NULL, 0, 'a'),
			('dated',   'owner@example.com', 'inbox', 'Has a date',   '2026-01-01T00:00:00Z', 0, 'b');`);

		const map = await getMailboxLatestEmails(db, ["owner@example.com"]);
		const latest = map.get("owner@example.com");

		assert.notStrictEqual(latest, undefined, "the dated row still wins");
		assert.strictEqual(latest?.subject, "Has a date");
		assert.notStrictEqual(latest?.date, null, "a NULL-date row must never be picked");
	});

	it("yields no entry when the only inbox emails are undated", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, date, read, body) VALUES
			('undated', 'owner@example.com', 'inbox', 'No date', NULL, 0, 'a');`);

		const map = await getMailboxLatestEmails(db, ["owner@example.com"]);
		assert.strictEqual(map.has("owner@example.com"), false);
	});

	it("resolves the latest inbox email per mailbox in one call", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, date, read, body) VALUES
			('a-old', 'a@example.com', 'inbox', 'A old', '2026-01-01T00:00:00Z', 1, 'a'),
			('a-new', 'a@example.com', 'inbox', 'A new', '2026-02-01T00:00:00Z', 0, 'a'),
			('b-old', 'b@example.com', 'inbox', 'B old', '2026-01-01T00:00:00Z', 1, 'b'),
			('b-draft','b@example.com','draft', 'B draft','2026-03-01T00:00:00Z', 0, 'b');`);

		const map = await getMailboxLatestEmails(db, ["a@example.com", "b@example.com"]);

		assert.strictEqual(map.get("a@example.com")?.subject, "A new");
		assert.strictEqual(map.get("a@example.com")?.read, 0);
		// The newer draft in mailbox b must not win.
		assert.strictEqual(map.get("b@example.com")?.subject, "B old");
		assert.strictEqual(map.get("b@example.com")?.read, 1);
	});

	it("returns no entry for a mailbox whose only emails are drafts", { skip: sqliteSkip }, async () => {
		const db = createRealSqliteD1(SCHEMA_SQL);
		await db.exec(`INSERT INTO emails (id, mailbox_id, folder_id, subject, date, read, body) VALUES
			('d1', 'drafts@example.com', 'draft', 'A draft', '2026-05-01T00:00:00Z', 0, 'd'),
			('d2', 'drafts@example.com', 'sent',  'A sent',  '2026-06-01T00:00:00Z', 0, 'd');`);

		const map = await getMailboxLatestEmails(db, ["drafts@example.com"]);

		assert.strictEqual(
			map.has("drafts@example.com"),
			false,
			"a mailbox with no inbox email must yield no entry (the homepage renders nothing)",
		);
		assert.strictEqual(map.size, 0);
	});

	it("returns an empty map without querying when given no mailbox ids", async () => {
		const db = {
			prepare() {
				throw new Error("must not query for an empty mailbox list");
			},
		} as unknown as D1Database;

		const map = await getMailboxLatestEmails(db, []);
		assert.strictEqual(map.size, 0);
	});
});
