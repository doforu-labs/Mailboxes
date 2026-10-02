// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Integration tests that run the REAL migration and aggregation SQL against a
 * real SQLite engine.
 *
 * These guard the things unit tests cannot reach:
 *   1. `migrations/0010_email_sender_name.sql` must not abort on awkward
 *      `raw_headers` blobs. In particular a JSON array containing a *scalar*
 *      element used to raise "malformed JSON" and roll back the whole
 *      migration — note that `json_type(value)` is NOT a valid guard for this,
 *      only json_each's own `type` column is.
 *   2. The backfill must agree with the live receive path: a name containing an
 *      `@` is KEPT (the local-part fallback is a render-time decision), names
 *      are truncated rather than dropped, and the RS/US separators never
 *      survive into `sender_name`.
 *   3. The `participants_meta` aggregation in `workers/db/index.ts` must keep
 *      using the separators that `shared/participants.ts` parses, and must frame
 *      correctly even when the stored values already carry them.
 *
 * Points 2 and 3 are regression guards: an earlier revision of the migration
 * gated on `instr(sender_name,'@') > 0` (discarding "Acme @ Home") and left
 * control characters in place, and the aggregate trusted the write path's
 * sanitising.
 *
 * The engine is `node:sqlite`, stable from Node 22. Where it is missing the
 * SQL-level cases are reported as **skipped** (never as a silent pass), so a CI
 * run on an older Node cannot pretend this coverage happened.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	PARTICIPANT_ENTRY_SEP,
	PARTICIPANT_NAME_SEP,
	parseParticipantLabels,
	sanitizeSenderName,
	stripHeaderChars,
} from "../../shared/participants";

const MIGRATION_SQL = readFileSync(
	new URL("../../migrations/0010_email_sender_name.sql", import.meta.url),
	"utf8",
);
const DB_SOURCE = readFileSync(new URL("../../workers/db/index.ts", import.meta.url), "utf8");

/**
 * The aggregation used by getThreadedEmails in `workers/db/index.ts`, pinned by
 * text so the separators (and the REPLACEs that make the framing independent of
 * stored data) cannot drift away from what shared/participants.ts parses. The
 * SQL itself is executed by the tests below.
 */
const PARTICIPANTS_META_SQL_NAME = "PARTICIPANTS_META_SQL";
const PARTICIPANTS_META_EXPR =
	"GROUP_CONCAT(COALESCE(NULLIF(TRIM(REPLACE(REPLACE(sender_name, CHAR(30), ' '), CHAR(31), ' ')), ''), '') || CHAR(31) || REPLACE(REPLACE(sender, CHAR(30), ' '), CHAR(31), ' '), CHAR(30)) as participants_meta";

/** node:sqlite typings ship with @types/node >= 22, so keep this untyped. */
type Database = {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
};

let DatabaseSyncCtor: (new (path: string) => Database) | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	DatabaseSyncCtor = ((await import("node:sqlite")) as any).DatabaseSync ?? null;
} catch {
	DatabaseSyncCtor = null;
}

/**
 * Node's test runner renders the string as the skip reason, and counts the test
 * as skipped — so missing coverage is visible instead of looking green.
 */
const sqliteSkip: string | false = DatabaseSyncCtor
	? false
	: "node:sqlite is unavailable (needs Node >= 22)";

/** Open an in-memory SQLite database with the given schema. */
function openDb(createTableSql: string): Database {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");
	const db = new Ctor(":memory:");
	db.exec(createTableSql);
	return db;
}

function createEmailsDb(): Database {
	return openDb("CREATE TABLE emails (id TEXT PRIMARY KEY, sender TEXT, raw_headers TEXT)");
}

function seed(db: Database, rows: Array<[string, string | null, string | null]>) {
	const insert = db.prepare("INSERT INTO emails (id, sender, raw_headers) VALUES (?, ?, ?)");
	for (const [id, sender, rawHeaders] of rows) insert.run(id, sender, rawHeaders);
}

function senderNames(db: Database): Record<string, string | null> {
	const rows = db.prepare("SELECT id, sender_name FROM emails ORDER BY id").all() as Array<{
		id: string;
		sender_name: string | null;
	}>;
	return Object.fromEntries(rows.map((r) => [r.id, r.sender_name]));
}

describe("migration 0010_email_sender_name", () => {
	it("backfills the From display name from raw_headers", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			["r1", "noreply@github.com", '[{"key":"from","value":"GitHub <noreply@github.com>"}]'],
			["r2", "onboarding@resend.dev", '[{"key":"from","value":"\\"Acme Inc\\" <onboarding@resend.dev>"}]'],
			["r3", "jane@example.com", '[{"key":"From","value":"Jane Doe <jane@example.com>"}]'],
			["r4", "comma@example.com", '[{"key":"from","value":"\\"Smith, John\\" <comma@example.com>"}]'],
		]);

		db.exec(MIGRATION_SQL);

		assert.deepStrictEqual(senderNames(db), {
			r1: "GitHub",
			r2: "Acme Inc",
			r3: "Jane Doe", // key lookup is case-insensitive
			r4: "Smith, John", // the comma must survive
		});
	});

	it("leaves sender_name NULL for unusable or absent headers", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			["r1", "plain@example.com", '[{"key":"from","value":"plain@example.com"}]'],
			["r2", "noheaders@example.com", null],
			["r3", "badjson@example.com", "not-json-at-all"],
			["r4", "objnotarray@example.com", '{"key":"from","value":"X <x@y.com>"}'],
			["r5", "toonly@example.com", '[{"key":"to","value":"me@x.com"}]'],
		]);

		db.exec(MIGRATION_SQL);

		for (const [id, value] of Object.entries(senderNames(db))) {
			assert.strictEqual(value, null, `${id} should have no sender_name`);
		}
	});

	// Regression test: this used to drop any name containing "@", so a row
	// backfilled this way rendered differently from a freshly-received one.
	it("keeps a name that merely looks like an address", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			[
				"quoted",
				"noreply@github.com",
				JSON.stringify([{ key: "from", value: '"noreply@github.com" <noreply@github.com>' }]),
			],
			[
				"atname",
				"noreply@acme.com",
				JSON.stringify([{ key: "from", value: "Acme @ Home <noreply@acme.com>" }]),
			],
		]);

		db.exec(MIGRATION_SQL);

		// Stored as-is. shared/participants.ts formatSenderLabel() decides the
		// local-part fallback at render time, so backfilled and new mail agree.
		assert.deepStrictEqual(senderNames(db), {
			quoted: "noreply@github.com",
			atname: "Acme @ Home",
		});
	});

	// Mirrors parseFromAddress() in workers/inbound.ts: only a *wrapping* quote pair
	// is the delimiter, so an inner quote stays part of the name.
	it("strips a wrapping quote pair but keeps inner quotes", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			["wrapped", "a@example.com", JSON.stringify([{ key: "from", value: '"Acme Inc" <a@example.com>' }])],
			["inner", "o@b.com", JSON.stringify([{ key: "from", value: 'O"Brien <o@b.com>' }])],
			[
				"both",
				"b@corp.com",
				JSON.stringify([{ key: "from", value: '"Brian "The Boss" Smith" <b@corp.com>' }]),
			],
		]);

		db.exec(MIGRATION_SQL);

		assert.deepStrictEqual(senderNames(db), {
			wrapped: "Acme Inc",
			inner: 'O"Brien',
			both: 'Brian "The Boss" Smith',
		});
	});

	// Regression test: an unsanitised backfill could inject CHAR(30) into a
	// sender_name, which splits one participant into two in participants_meta.
	it("strips the RS/US separators so participants_meta framing survives", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			[
				"r1",
				"evil@example.com",
				JSON.stringify([
					{ key: "from", value: `Evil${PARTICIPANT_ENTRY_SEP}Injected <evil@example.com>` },
				]),
			],
		]);

		db.exec(MIGRATION_SQL);

		const stored = senderNames(db).r1;
		assert.strictEqual(stored, "Evil Injected");
		assert.ok(!stored?.includes(PARTICIPANT_ENTRY_SEP));
		assert.ok(!stored?.includes(PARTICIPANT_NAME_SEP));
	});

	it("truncates an over-long name instead of dropping it", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			[
				"r1",
				"a@example.com",
				JSON.stringify([{ key: "from", value: `${"n".repeat(450)} <a@example.com>` }]),
			],
		]);

		db.exec(MIGRATION_SQL);

		// Matches sanitizeSenderName(), which truncates rather than discards.
		assert.strictEqual(senderNames(db).r1, "n".repeat(400));
	});

	// Regression test: this used to abort the migration with "malformed JSON",
	// which rolled back the whole thing and left the column unbackfilled.
	it("survives a JSON array containing scalar elements", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		seed(db, [
			[
				"r1",
				"guarded@example.com",
				'["scalar-string",42,{"key":"from","value":"Guarded <guarded@example.com>"}]',
			],
			["r2", "onlyscalar@example.com", '["just-a-string"]'],
		]);

		assert.doesNotThrow(() => db.exec(MIGRATION_SQL));
		assert.deepStrictEqual(senderNames(db), {
			r1: "Guarded",
			r2: null,
		});
	});

	it("keeps RFC 2047 encoded-words for render-time decoding", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		const encoded = "=?utf-8?B?QW5ub3VuY2VtZW50cw==?=";
		seed(db, [["r1", "a@example.com", `[{"key":"from","value":"${encoded} <a@example.com>"}]`]]);

		db.exec(MIGRATION_SQL);

		// Stored as-is: shared/participants.ts decodeMimeWords() renders it.
		assert.strictEqual(senderNames(db).r1, encoded);
	});

	it("runs cleanly on an empty table", { skip: sqliteSkip }, () => {
		const db = createEmailsDb();
		assert.doesNotThrow(() => db.exec(MIGRATION_SQL));
		assert.deepStrictEqual(senderNames(db), {});
	});
});

describe("participants_meta aggregation", () => {
	it("wires the aggregation into both branches of getThreadedEmails", () => {
		assert.ok(
			DB_SOURCE.includes(PARTICIPANTS_META_EXPR),
			"the pinned expression must still be the one under test",
		);
		const usageToken = "${" + PARTICIPANTS_META_SQL_NAME + "}";
		const usages = DB_SOURCE.split(usageToken).length - 1;
		assert.strictEqual(
			usages,
			2,
			"both the draft and non-draft branches must use PARTICIPANTS_META_SQL",
		);
	});

	it("joins name/address pairs with CHAR(31) and entries with CHAR(30)", { skip: sqliteSkip }, () => {
		const db = openDb("CREATE TABLE emails (id TEXT PRIMARY KEY, sender TEXT, sender_name TEXT)");
		const insert = db.prepare("INSERT INTO emails (id, sender, sender_name) VALUES (?, ?, ?)");
		insert.run("a", "noreply@github.com", "GitHub");
		insert.run("b", "noreply@github.com", null); // duplicate, unnamed
		insert.run("c", "jane@example.com", "Jane Doe");
		insert.run("d", "plain@example.com", null);

		const row = db.prepare(`SELECT ${PARTICIPANTS_META_EXPR} FROM emails`).get() as {
			participants_meta: string;
		};

		// Separators must be the very characters the parser splits on.
		assert.strictEqual(PARTICIPANT_ENTRY_SEP.charCodeAt(0), 30); // CHAR(30)
		assert.strictEqual(PARTICIPANT_NAME_SEP.charCodeAt(0), 31); // CHAR(31)

		const entries = row.participants_meta.split(PARTICIPANT_ENTRY_SEP);
		assert.strictEqual(entries.length, 4);
		assert.strictEqual(entries[0], `GitHub${PARTICIPANT_NAME_SEP}noreply@github.com`);
		assert.strictEqual(entries[1], `${PARTICIPANT_NAME_SEP}noreply@github.com`);
		assert.strictEqual(entries[2], `Jane Doe${PARTICIPANT_NAME_SEP}jane@example.com`);
		assert.strictEqual(entries[3], `${PARTICIPANT_NAME_SEP}plain@example.com`);
	});

	it("cannot be split by separator characters inside a name or address", { skip: sqliteSkip }, () => {
		const db = openDb("CREATE TABLE emails (id TEXT PRIMARY KEY, sender TEXT, sender_name TEXT)");
		// createEmail sanitises before INSERT; mirror that here so the assertion
		// covers the write path (the migration path is covered separately below).
		const hostileSender = `evil${PARTICIPANT_ENTRY_SEP}injected@example.com`;
		const hostileName = `Bad${PARTICIPANT_NAME_SEP}Name`;
		db.prepare("INSERT INTO emails VALUES (?, ?, ?)").run(
			"a",
			stripHeaderChars(hostileSender),
			sanitizeSenderName(hostileName),
		);

		const row = db.prepare(`SELECT ${PARTICIPANTS_META_EXPR} FROM emails`).get() as {
			participants_meta: string;
		};

		assert.strictEqual(row.participants_meta.split(PARTICIPANT_ENTRY_SEP).length, 1);
		assert.deepStrictEqual(parseParticipantLabels(row.participants_meta), ["Bad Name"]);
	});

	// The write path sanitises, but a legacy row (or one backfilled before
	// migration 0010 cleaned up) can still hold a separator. The aggregate itself
	// must then keep the framing intact — relying on createEmail() alone would
	// have let one sender render as two participants.
	it("frames correctly when stored values already carry the separators", { skip: sqliteSkip }, () => {
		const db = openDb("CREATE TABLE emails (id TEXT PRIMARY KEY, sender TEXT, sender_name TEXT)");
		db.prepare("INSERT INTO emails VALUES (?, ?, ?)").run(
			"a",
			`evil${PARTICIPANT_ENTRY_SEP}injected@example.com`,
			`Bad${PARTICIPANT_NAME_SEP}Name`,
		);

		const row = db.prepare(`SELECT ${PARTICIPANTS_META_EXPR} FROM emails`).get() as {
			participants_meta: string;
		};

		assert.strictEqual(row.participants_meta.split(PARTICIPANT_ENTRY_SEP).length, 1);
		assert.deepStrictEqual(parseParticipantLabels(row.participants_meta), ["Bad Name"]);
	});
});
