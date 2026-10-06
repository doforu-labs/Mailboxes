// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression tests for the shared tool bodies in `workers/lib/tools.ts`.
 *
 * These guard the three defects found after the "argument names match the
 * returned field names" refactor, plus the three closed by the second fix
 * round:
 *
 *   1. BLOCKER — `draft_reply` / `send_reply` read `params.originalEmailId`,
 *      but `executeToolCall` renames the legacy key to the canonical `id` and
 *      DELETES the legacy one. The id was therefore `undefined`, the tool
 *      reported `{ error }` for both spellings, and the caller saw
 *      "Tool draft_reply failed" with `params: ,inbox@local`.
 *
 *   2. An unknown `folder` reached a scalar subquery
 *      (`folder_id = (SELECT id FROM folders WHERE …)`) that yielded NULL, so
 *      `list_emails` / `search_emails` answered `[]` — the caller reads that
 *      as "this folder is empty", a WRONG ANSWER, which is worse than failing.
 *
 *   3. A verifier failure was flattened to `""` (or silently swallowed), so the
 *      caller lost the reason and could only report a generic message.
 *
 * Round 2 (each of these was hidden behind a substring-level assertion, an
 * ignored return value, or a stub that never ran production SQL):
 *
 *   4. `draft_reply`'s result carried two opposite meanings of "id": `draftId`
 *      (the new draft) next to `draft.id` (the email being replied to). The
 *      nested field is now `draft.reply_to_id`.
 *
 *   5. `mark_email_read` ignored `updateEmail`'s `null` and answered
 *      `{ status: "updated" }` for an id that does not exist — a false success
 *      for an unknown handle. `move_email`'s `false` had the same problem (it
 *      reported the generic `moveFailed` for a missing email).
 *
 *   6. The Chinese `unknownFolder` case ran against a hand-built stub whose
 *      BOTH folder queries returned `[]` — the "mailbox has no folders" shape,
 *      which correctly selects the list-less variant. The test therefore
 *      asserted a sentence its own scenario could never produce. It now runs
 *      the real engine, with a seeded mailbox, for both branches.
 *
 * Round 3 (the low-severity tail of the same "a result must describe the work
 * that actually happened" family — see the last suite):
 *
 *   7. `mark_email_read` took `params.read` at face value. A missing `read`
 *      made `updateEmail` skip its `UPDATE` entirely and return the untouched
 *      row, so the tool answered `{ status: "updated", id }` — success, with
 *      the `read` key eaten by `JSON.stringify` because its value was
 *      `undefined`. The exact mirror of defect 5: a false success, this time
 *      for a write that was never attempted.
 *
 *   8. `update_draft` accepted `draftId` and returned `newDraftId`, so a
 *      caller continuing from its own result had to rename the value by hand.
 *
 *   9. `list_emails`' `limit` description promised `default 20` while
 *      `getEmails` defaults to `25` — the schema the model reads disagreed
 *      with the code that runs.
 *
 * A note on the shared seeds: `MAILBOX` and the `folders` rows live in
 * `SEED`, but the EMAILS live in {@link EMAIL_SEED}. Several cases below — the
 * `move_email` ones in particular — exist to pin what a tool returns, and the
 * existing row meant they never actually exercised the write: a `false` from
 * the database was being papered over by the old `moveFailed` fallback, so a
 * dead assertion still passed. Keeping the emails separate lets those cases
 * state their own world explicitly instead of inheriting one that made the
 * branch unreachable.
 *
 * The suite deliberately runs the **real tool functions** against a real
 * in-memory SQLite engine (`node:sqlite`, Node >= 22). Asserting on
 * `normalizeToolArguments` output was exactly the gap that let the blocker
 * ship: the normalization was correct while the tool that consumed it was not.
 * With a real engine the inserted row, the resolved folder and the resulting
 * rows are all observable end to end.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";

// `mock.module` (see the last section) needs `--experimental-test-module-mocks`,
// which `npm test` passes. A bare `tsx --test` cannot run this file.
import * as actualAi from "./ai";
import {
	executeToolCall,
	TOOL_DEFINITIONS,
	normalizeToolArguments,
	type AiToolCall,
} from "./tool-dispatch";
import { dispatchExternalTool, EXTERNAL_RESULT_PUBLIC_FIELDS } from "./external-tools";
import {
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDiscardDraft,
	toolGetEmail,
	toolGetThread,
	toolListEmails,
	toolMarkEmailRead,
	toolMoveEmail,
	toolDeleteEmail,
	toolSearchEmails,
	toolSendReply,
	toolSendEmail,
} from "./tools";
import { verifyDraft } from "./ai";
import { checkVerificationSqlError } from "../db/index";

// ── node:sqlite (optional engine) ───────────────────────────────────
//
// Loaded through a variable on purpose: a literal `import("node:sqlite")`
// fails type-checking under this repo's @types/node 20.x even though the
// runtime (Node >= 22) supports it. When the engine is missing the execution
// cases report as **skipped**, never as a silent pass.

const NODE_SQLITE_MODULE = "node:sqlite";

type SqliteRow = Record<string, unknown>;

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): SqliteRow[];
		/**
		 * `run()` reports the affected-row count, which is what a D1 shim has to
		 * surface as `meta.changes` — see `createSqliteD1`'s `run()`.
		 */
		run(...params: unknown[]): { changes?: number | bigint };
	};
};

let DatabaseSyncCtor: DatabaseSyncLike | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	DatabaseSyncCtor = ((await import(NODE_SQLITE_MODULE)) as any).DatabaseSync ?? null;
} catch {
	DatabaseSyncCtor = null;
}

const sqliteSkip: string | false = DatabaseSyncCtor
	? false
	: "node:sqlite is unavailable (needs Node >= 22)";

/** Schema mirroring the columns the tools touch (see workers/db/schema.ts). */
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
		subject TEXT,
		sender TEXT,
		sender_name TEXT,
		recipient TEXT,
		cc TEXT,
		bcc TEXT,
		date TEXT,
		read INTEGER DEFAULT 0,
		starred INTEGER DEFAULT 0,
		body TEXT,
		in_reply_to TEXT,
		email_references TEXT,
		thread_id TEXT,
		message_id TEXT,
		raw_headers TEXT,
		send_status TEXT
	);
	CREATE TABLE attachments (
		id TEXT PRIMARY KEY,
		email_id TEXT NOT NULL,
		mailbox_id TEXT NOT NULL,
		filename TEXT NOT NULL,
		mimetype TEXT NOT NULL,
		size INTEGER NOT NULL,
		content_id TEXT,
		disposition TEXT
	);
`;

const MAILBOX = "owner@example.com";

/**
 * The `D1PreparedStatement.raw()` contract, and why this shim needs
 * `setReturnArrays`.
 *
 * `drizzle-orm/d1` reads query results through the statement's `raw()` method
 * for EVERY `SELECT` — full-table projections included (it is `all()` that it
 * uses for the loose `run`-shaped paths). It then reads the projection
 * POSITIONALLY. `node:sqlite`'s `all()` returns OBJECTS keyed by column name,
 * so handing those straight back gives drizzle `undefined` for position 0 of
 * every row and every query silently returns nothing.
 *
 * That is exactly the hole this suite sat over: the tool bodies used a stale
 * `Object.values(row)` conversion left from an earlier D1 stub — one level
 * BELOW drizzle — and so every `SELECT` had been answering empty. The failure
 * was invisible because it looked like a legitimate result: a mailbox with no
 * rows answers `[]` too.
 *
 * `DatabaseSyncStatement.setReturnArrays(true)` is the engine's own answer:
 * it makes `all()` return arrays in projection order, which is the shape `raw()`
 * is defined to return (same switch as `node:sqlite`'s own `StatementSync`
 * `raw()` support, and the reason this fixture compiles the statement itself
 * instead of asking drizzle to).
 */

/**
 * A `D1Database` backed by a real SQLite engine.
 *
 * Positional `?N` placeholders are passed through verbatim — `node:sqlite`
 * supports the repeated-placeholder form (`(name = ?2 OR id = ?2)`) the folder
 * subqueries rely on. Statements are collected so tests can assert on the SQL
 * that actually ran, while every value is bound for real.
 */
function createSqliteD1(seedSql = "") {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");

	const sqlite = new Ctor(":memory:");
	sqlite.exec(SCHEMA_SQL);
	if (seedSql) sqlite.exec(seedSql);

	const statements: Array<{
		sql: string;
		binds: unknown[];
		rows: SqliteRow[];
		/** Compiled on first `raw()`, with `setReturnArrays(true)` applied. */
		rawStatement?: { all(...params: unknown[]): unknown[] };
	}> = [];

	const db = {
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		prepare: (sql: string) => {
			const entry: {
				sql: string;
				binds: unknown[];
				rows: SqliteRow[];
				rawStatement?: { all(...params: unknown[]): unknown[] };
			} = { sql, binds: [], rows: [] };
			statements.push(entry);

			const run = (): SqliteRow[] => {
				const rows = sqlite.prepare(sql).all(...entry.binds);
				entry.rows = rows;
				return rows;
			};

			/**
			 * @see the `raw()` contract note above `createSqliteD1`: arrays in
			 * projection order, which is what drizzle's D1 driver indexes into.
			 */
			const rawRun = (): SqliteRow[] => {
				if (!entry.rawStatement) {
					const prepared = sqlite.prepare(sql) as unknown as {
						setReturnArrays(v: boolean): void;
					};
					prepared.setReturnArrays(true);
					entry.rawStatement = prepared as unknown as { all(...params: unknown[]): unknown[] };
				}
				const rows = entry.rawStatement.all(...(entry.binds as never[]));
				return rows as SqliteRow[];
			};

			const statement = {
				bind(...values: unknown[]) {
					entry.binds.push(...values);
					return statement;
				},
				async first() {
					return (run()[0] ?? null) as never;
				},
				async all() {
					return { results: run(), success: true, meta: {} } as never;
				},
				async run() {
					// D1's affected-row count lives in `meta.changes`, and drizzle's D1
					// driver reads it from there: `updateEmail`/`moveEmail` gate their
					// result on it (see `workers/db/move-email.test.ts`, which pins
					// exactly this). A flat `meta: {}` leaves `changes` `undefined`,
					// and `undefined !== 0` made EVERY update look successful — which
					// is why two `move_email` cases here passed while the email never
					// moved out of `inbox`. `node:sqlite`'s `run()` reports the same
					// affected-row count D1 does, so mirror it into `meta.changes`.
					const info = sqlite.prepare(sql).run(...(entry.binds as never[])) as {
						changes?: number | bigint;
					};
					return {
						results: [],
						success: true,
						meta: { changes: Number(info.changes ?? 0) },
					} as never;
				},
				async raw() {
					// drizzle's D1 driver terminates SELECTS on `raw()` and reads the
					// column projection POSITIONALLY — see `rawRun`.
					return rawRun() as never;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		batch: async (stmts: D1PreparedStatement[]) => {
			const results = [];
			for (const stmt of stmts) {
				results.push(await (stmt as unknown as { run(): Promise<unknown> }).run());
			}
			return results;
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;

	return { db, sqlite, statements };
}

/** Seed a mailbox with its default folders (the universe every case needs). */
const SEED = `
	INSERT INTO folders (mailbox_id, id, name) VALUES
		('${MAILBOX}', 'inbox', 'Inbox'),
		('${MAILBOX}', 'sent', 'Sent'),
		('${MAILBOX}', 'draft', 'Drafts'),
		('${MAILBOX}', 'archive', 'Archive'),
		('${MAILBOX}', 'trash', 'Trash'),
		('${MAILBOX}', 'spam', 'Spam');
`;

/**
 * The two emails the execution cases read (`orig-1`) and list (`inbox-2`).
 *
 * Kept apart from {@link SEED} because a handful of cases need a mailbox that
 * owns folders but NO emails ("the email does not exist" assertions);
 * `FULL_SEED` is what the cases that act on `orig-1` use.
 */
const EMAIL_SEED = `
	INSERT INTO emails (id, mailbox_id, folder_id, subject, sender, recipient, date, body, thread_id, message_id)
		VALUES ('orig-1', '${MAILBOX}', 'inbox', 'Hello', 'them@example.com', '${MAILBOX}', '2026-01-01T00:00:00.000Z', '<p>original body</p>', 'thread-1', 'orig-msg-1@example.com');
	INSERT INTO emails (id, mailbox_id, folder_id, subject, sender, recipient, date, body, thread_id)
		VALUES ('inbox-2', '${MAILBOX}', 'inbox', 'Second', 'them@example.com', '${MAILBOX}', '2026-01-02T00:00:00.000Z', '<p>another body</p>', 'thread-2');
`;

/** Everything the majority of the cases need: folders + emails. */
const FULL_SEED = SEED + EMAIL_SEED;

function seededMailbox() {
	return createSqliteD1(FULL_SEED);
}

/** Read one email row back out of the engine (proof the write landed). */
function rowFor(sqlite: { prepare(sql: string): { all(...p: unknown[]): SqliteRow[] } }, id: string) {
	return sqlite.prepare("SELECT * FROM emails WHERE id = ?").all(id)[0] ?? null;
}

/** `toolCall` payload in the shape the model / gateway produces. */
function toolCall(name: string, args: unknown): AiToolCall {
	return {
		id: `test-${name}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

const NOOP_AI = {} as unknown as Ai;
const NOOP_BUCKET = {} as unknown as R2Bucket;

/**
 * A mailbox configured to send, with the HTTPS call stubbed at the `fetch`
 * boundary.
 *
 * The SUCCESS half of `send_email` / `send_reply` was previously unreachable
 * here — every existing case either fails the verifier or hands in a bucket
 * with no mailbox config — so the success return body was never observed. This
 * helper makes it reachable without mocking any module: the bucket answers
 * `mailboxes/<id>.json` with a Resend key exactly the way production stores one
 * (see `sendEmailFromMailbox`), the tool's own D1 work runs against the real
 * engine, and only the final `POST https://api.resend.com/emails` is answered
 * locally by {@link stubResendFetch}.
 *
 * Deliberately NOT `mock.module("../email-sender", …)`: that registry
 * registers a module mock, but `./tools`'s OWN static import of
 * `../email-sender` keeps binding to the real function here (verified — the
 * stub is never called), so the tool would still take the failure path. A
 * `fetch` stub has no such problem: it replaces the LAST step of the real
 * chain, so everything upstream is genuinely exercised.
 */
const CONFIGURED_BUCKET = {
	get: async (key: string) =>
		key.startsWith("mailboxes/") && key.endsWith(".json")
			? {
					json: async () => ({ resendApiKey: "re_unit_test_key" }),
				}
			: null,
	head: async () => ({}),
} as unknown as R2Bucket;

/**
 * Replace the global `fetch` for the duration of a send test.
 *
 * `sendEmail` posts to `https://api.resend.com/emails` through
 * `fetchWithTimeout`, which resolves `globalThis.fetch` at call time — so a
 * `mock.method` here intercepts the real send and nothing else. Real network
 * access from a unit test is not an option, and this keeps the assertion on the
 * production path: the URL, the parsed key and the JSON body are all observable.
 *
 * The returned handle restores the original in `t.after`; the caller must call
 * it.
 */
function stubResendFetch(t: { after(fn: () => void): void }) {
	const resendFetch = mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(JSON.stringify({ id: "resend-stub-id" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	t.after(() => resendFetch.mock.restore());
	return resendFetch;
}

/**
 * A seeded mailbox whose sends are answered by {@link stubResendFetch}.
 *
 * Every seed row is real: the tool's folder lookup, the rate-limit query and
 * the Sent row it writes all run against the engine.
 */
function seededMailboxWithWorkingSend() {
	return createSqliteD1(FULL_SEED);
}

/**
 * An `Ai` binding whose `run()` resolves a fixed verifier response.
 * `verifyDraft` only ever calls `run`, so this is a complete stand-in.
 */
function fakeAi(response: string | Error): Ai {
	return {
		run: async () => {
			if (response instanceof Error) throw response;
			return { response };
		},
	} as unknown as Ai;
}

// ── 1. BLOCKER: draft_reply / send_reply actually execute ──────────

describe("draft_reply / send_reply execute end to end (blocker regression)", () => {
	/**
	 * The exit criterion for the blocker: BOTH the canonical `{id}` and the
	 * legacy `{originalEmailId}` argument spellings must reach the tool and
	 * produce a real row. Previously both failed, because the tools read only
	 * `params.originalEmailId` after normalization had moved the value to `id`.
	 */
	it("draft_reply with `{id}` saves a draft linked to the original", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = seededMailbox();

		const result = await toolDraftReply(
			db,
			MAILBOX,
			NOOP_AI,
			{
				id: "orig-1",
				to: "them@example.com",
				subject: "Re: Hello",
				body: "Thanks for the note, replying shortly.",
				isPlainText: true,
			},
		);

		assert.ok(!("error" in result), `must not error: ${JSON.stringify(result)}`);
		assert.strictEqual(result.status, "draft_saved");
		// The new draft's primary key and the id of the email it replies to are
		// two DIFFERENT values, named apart: `draftId` is the draft,
		// `draft.reply_to_id` is the original. The nested field used to be `id`,
		// which made the two keys' meanings opposite (a model reading
		// `draft.id` as "the draft" acted on the original email instead).
		assert.strictEqual(result.draft.reply_to_id, "orig-1");
		assert.ok(!("id" in result.draft), "the ambiguous `draft.id` must be gone");
		assert.ok(
			!("originalEmailId" in result.draft),
			"the legacy `originalEmailId` spelling must not come back",
		);
		// Proof the write really happened with the canonical id as its anchor.
		// The thread the draft was filed under is read back from the ROW (the
		// return body has no thread key for this tool — see the draft_email
		// shape test for the tool that does expose one).
		const row = rowFor(sqlite, result.draftId)!;
		assert.ok(row, "the draft row must exist");
		assert.strictEqual(row.folder_id, "draft");
		assert.strictEqual(row.in_reply_to, "orig-1");
		assert.strictEqual(row.thread_id, "thread-1");
	});

	it("draft_reply with the legacy `{originalEmailId}` still works", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = seededMailbox();

		const result = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			originalEmailId: "orig-1",
			to: "them@example.com",
			subject: "Re: Hello",
			body: "Legacy spelling must keep working.",
			isPlainText: true,
		});

		assert.ok(!("error" in result), `must not error: ${JSON.stringify(result)}`);
		assert.strictEqual(result.status, "draft_saved");
		const row = rowFor(sqlite, result.draftId)!;
		assert.strictEqual(row.in_reply_to, "orig-1");
		assert.strictEqual(row.thread_id, "thread-1");
	});

	it("draft_reply reports a missing id instead of writing a broken row", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const result = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Re: Hello",
			body: "no id at all",
		});
		assert.ok("error" in result);
	});

	/**
	 * The full path the model takes: `executeToolCall` does the schema-level
	 * argument handling (folders are auto-seeded first) before delegating.
	 */
	it("executeToolCall('draft_reply') reaches the tool for both spellings", { skip: sqliteSkip }, async () => {
		for (const args of [
			{ id: "orig-1", to: "them@example.com", subject: "Re: Hello", body: "Canonical id path." },
			{ originalEmailId: "orig-1", to: "them@example.com", subject: "Re: Hello", body: "Legacy id path." },
		]) {
			// `FULL_SEED`, not `SEED`: this case asserts the call reaches the TOOL
			// and writes a draft, and the tool now resolves `orig-1` before it
			// writes anything. Against a mailbox with folders but no emails the
			// only thing it could prove was the argument plumbing — it reported
			// `{ error: "Original email not found" }` and the assertion below
			// caught it. The seeded original is what makes "reached the tool" and
			// "reached the write" the same claim, which is what the case is for.
			const { db, sqlite } = seededMailbox();
			const result = await executeToolCall(
				toolCall("draft_reply", args),
				db,
				MAILBOX,
				NOOP_AI,
				NOOP_BUCKET,
			);
			assert.ok(
				!("error" in result),
				`${JSON.stringify(args)} must not fail: ${JSON.stringify(result)}`,
			);
			assert.strictEqual(result.status, "draft_saved");
			assert.ok(rowFor(sqlite, result.draftId), "the draft must be persisted");
		}
	});

	/**
	 * `executeToolCall` normalizes arguments; this pins that the *tool* reads
	 * the canonical key, which is what normalization produces.
	 */
	it("the normalized bag has no `originalEmailId` — the tool must read `id`", () => {
		const normalized = normalizeToolArguments("draft_reply", { originalEmailId: "orig-1" });
		assert.deepStrictEqual(normalized, { id: "orig-1" });
	});

	it("send_reply with `{id}` puts the reply in Sent", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = seededMailbox();
		// A bucket with no mailbox config makes the Resend lookup fall through
		// to the (empty) domains table, which throws — after the verification
		// and threading work. `toolSendReply` turns that into a localized
		// `{ error }`, so the observable proof is the send attempt itself.
		const bucket = {
			get: async () => null,
			head: async () => null,
		} as unknown as R2Bucket;

		const result = await toolSendReply(
			db,
			MAILBOX,
			NOOP_AI,
			bucket,
			{
				id: "orig-1",
				to: "them@example.com",
				subject: "Re: Hello",
				bodyHtml: "<p>Replying now.</p>",
				skipVerifyDraft: true,
			},
		);

		// Crucially NOT "Original email not found": the id resolved, so the
		// tool got past the lookup and on to the send.
		assert.ok("error" in result, "no Resend key configured → send fails");
		assert.ok(
			!String(result.error).includes("not found"),
			`the original email must have resolved, got: ${result.error}`,
		);
		// No Sent row was written (the send failed), but the SELECTs ran with
		// the canonical id — the rate-limit checks passed and the original row
		// was read from the seeded table.
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'sent'").all()[0]!.n,
			0,
		);
	});

	it("send_reply with a missing id fails with the not-found error", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const bucket = { get: async () => null, head: async () => null } as unknown as R2Bucket;
		const result = await toolSendReply(db, MAILBOX, NOOP_AI, bucket, {
			to: "them@example.com",
			subject: "Re: Hello",
			bodyHtml: "<p>x</p>",
			skipVerifyDraft: true,
		});
		assert.ok("error" in result);
	});

	it("send_reply with an unknown id resolves to the original-email error", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const bucket = { get: async () => null, head: async () => null } as unknown as R2Bucket;
		const result = await toolSendReply(db, MAILBOX, NOOP_AI, bucket, {
			id: "does-not-exist",
			to: "them@example.com",
			subject: "Re: Hello",
			bodyHtml: "<p>x</p>",
			skipVerifyDraft: true,
		});
		assert.ok("error" in result);
		assert.strictEqual(result.error, "Original email not found");
	});
});

// ── 2. Unknown folder must not look like an empty folder ───────────

describe("unknown folder is an error, not an empty result", () => {
	it("list_emails rejects a misspelled folder and names the valid ones", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);

		for (const bogus of ["inbxo", "INBOX", "nowhere"]) {
			const result = await toolListEmails(db, MAILBOX, {
				folder: bogus,
				limit: 20,
				page: 1,
			});
			assert.ok(
				!Array.isArray(result),
				`${bogus} must not be reported as a folder of results: ${JSON.stringify(result)}`,
			);
			const { error } = result as { error: string };
			assert.ok(error.startsWith(`Unknown folder: ${bogus}.`), error);
			// The message tells the caller what it could have asked for.
			assert.ok(error.includes("Inbox"), error);
			assert.ok(error.includes("Archive"), error);
		}
	});

	it("list_emails still lists a folder that exists (id and name)", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();

		for (const folder of ["inbox", "Inbox"]) {
			const result = await toolListEmails(db, MAILBOX, { folder, limit: 20, page: 1 });
			assert.ok(Array.isArray(result), JSON.stringify(result));
			assert.strictEqual(result.length, 2, `folder=${folder}`);
		}

		// A folder that exists but is empty stays an empty array — the
		// invariant that makes the error above meaningful.
		const empty = await toolListEmails(db, MAILBOX, { folder: "trash", limit: 20, page: 1 });
		assert.ok(Array.isArray(empty));
		assert.strictEqual(empty.length, 0);
	});

	it("search_emails rejects an unknown folder but allows it to be omitted", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();

		const bogus = await toolSearchEmails(db, MAILBOX, { query: "body", folder: "inbxo" });
		assert.ok(!Array.isArray(bogus), JSON.stringify(bogus));
		assert.ok((bogus as { error: string }).error.startsWith("Unknown folder: inbxo."));

		// Omitted folder → no validation, the search spans the mailbox.
		const all = await toolSearchEmails(db, MAILBOX, { query: "body" });
		assert.ok(Array.isArray(all));
		assert.strictEqual(all.length, 2);

		// Known folder → unchanged behaviour.
		const inInbox = await toolSearchEmails(db, MAILBOX, { query: "body", folder: "inbox" });
		assert.ok(Array.isArray(inInbox));
		assert.strictEqual(inInbox.length, 2);
	});

	it("resolves the folder with exactly the query's own predicate", { skip: sqliteSkip }, async () => {
		// The check must not be stricter or looser than the query it guards:
		// same columns, same `name = ? OR id = ?` equality, same mailbox scope.
		const { db, statements } = createSqliteD1(SEED);
		await toolListEmails(db, MAILBOX, { folder: "inbox", limit: 20, page: 1 });

		const probe = statements.find((s) =>
			s.sql.includes("FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2)"),
		);
		assert.ok(probe, `no folder-resolution probe ran: ${statements.map((s) => s.sql).join(" | ")}`);
		assert.deepStrictEqual(probe.binds, [MAILBOX, "inbox"]);
	});

	it("a folder belonging to another mailbox is unknown here", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(
			SEED +
				`INSERT INTO folders (mailbox_id, id, name) VALUES ('other@example.com', 'inbox', 'Inbox');`,
		);
		// The mailbox only scopes folders by `mailbox_id`, never by name alone.
		const result = await toolListEmails(db, "empty@example.com", {
			folder: "inbox",
			limit: 20,
			page: 1,
		});
		assert.ok(!Array.isArray(result), JSON.stringify(result));
		assert.ok((result as { error: string }).error.startsWith("Unknown folder: inbox."));
	});

	it("executeToolCall surfaces the folder error instead of an empty list", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const result = await executeToolCall(
			toolCall("list_emails", { folder: "inbxo", limit: 20, page: 1 }),
			db,
			MAILBOX,
			NOOP_AI,
			NOOP_BUCKET,
		);
		assert.ok(result.error, JSON.stringify(result));
		assert.ok(String(result.error).startsWith("Unknown folder: inbxo."), result.error);
	});
});

// ── 3. The verifier's failure reason is no longer swallowed ────────

describe("verifyDraft reports why it failed", () => {
	it("returns a failure reason when the AI binding throws", async () => {
		const result = await verifyDraft(
			fakeAi(new Error("D1_ERROR: no such table: nope")),
			"A perfectly ordinary reply that is long enough to be verified.",
		);
		assert.strictEqual(result.ok, false);
		// A recognized D1 error becomes a neutral sentence, not the raw text.
		assert.strictEqual(result.reason, "the database schema is missing a required table");
		assert.ok(
			!result.reason.includes("nope") && !result.reason.includes("D1_ERROR"),
			"the reason must not echo the raw error",
		);
	});

	it("falls back to a generic reason for an unrecognized error", async () => {
		const result = await verifyDraft(
			fakeAi(new Error("some vendor SDK exploded at line 42")),
			"A perfectly ordinary reply that is long enough to be verified.",
		);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.reason, "the verification model could not be reached");
	});

	it("keeps the original body when the verifier returns something unusable", async () => {
		const body = "A perfectly ordinary reply that is long enough to be verified.";
		// Empty model response → advisory failure, body preserved.
		const empty = await verifyDraft(fakeAi(""), body);
		assert.strictEqual(empty.ok, true);
		assert.strictEqual(empty.body, body);
	});

	it("fails when the model gutted the body (the failure branch is reachable)", async () => {
		const body = "A perfectly ordinary reply that is long enough to be verified.";
		// >50% removed → the verifier refuses its own output. This is a
		// FAILURE, not a silent fall-back: the body that came back from the
		// model is not the body that went in, so it must not be reported ok.
		const gutted = await verifyDraft(fakeAi("Short."), body);
		assert.strictEqual(gutted.ok, false);
		assert.strictEqual(gutted.reason, "the verifier removed most of the body");
	});

	it("passes a cleaned body through, and still marks it ok", async () => {
		const cleaned =
			"This reply had a stray marker and I will keep the rest of the words here.";
		const result = await verifyDraft(fakeAi(cleaned), cleaned);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.body, cleaned);
	});

	it("checkVerificationSqlError only recognizes database errors", () => {
		assert.strictEqual(
			checkVerificationSqlError("D1_ERROR: UNIQUE constraint failed: emails.id"),
			"a conflicting record already exists",
		);
		assert.strictEqual(
			checkVerificationSqlError("SQLITE_ERROR: database is locked"),
			"the database is temporarily unavailable",
		);
		assert.strictEqual(checkVerificationSqlError("random failure"), null);
		assert.strictEqual(checkVerificationSqlError(undefined), null);
	});
});

describe("a verifier failure reaches the caller with its reason", () => {
	it("draft_reply reports the reason instead of a bare 'verification failed'", { skip: sqliteSkip }, async () => {
		// The original has to EXIST for the verifier to be the thing that
		// fails: `draft_reply` now resolves the reply target up front, so a
		// folders-only mailbox would answer "Original email not found" and this
		// case would be asserting the wrong failure. `FULL_SEED` supplies it.
		const { db } = seededMailbox();
		const result = await toolDraftReply(
			db,
			MAILBOX,
			fakeAi(new Error("D1_ERROR: no such table: folders")),
			{
				id: "orig-1",
				to: "them@example.com",
				subject: "Re: Hello",
				body: "A reply body long enough for the verifier to look at it.",
				runVerifyDraft: true,
			},
		);

		assert.ok("error" in result);
		assert.ok(
			result.error.startsWith("Draft verification failed"),
			result.error,
		);
		assert.ok(
			result.error.includes("the database schema is missing a required table"),
			`the reason must be visible, got: ${result.error}`,
		);
	});

	it("send_email reports the reason too", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const bucket = { get: async () => null, head: async () => null } as unknown as R2Bucket;
		const result = await toolSendEmail(db, MAILBOX, fakeAi(new Error("boom")), bucket, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>A body long enough for the verifier to run over it.</p>",
		});
		assert.ok("error" in result);
		assert.ok(
			result.error.includes("the verification model could not be reached"),
			result.error,
		);
	});

	it("never puts an unrecognized raw error message in the tool error", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const result = await toolDraftReply(
			db,
			MAILBOX,
			fakeAi(new Error("SELECT * FROM secret_table WHERE token = 'abc'")),
			{
				id: "orig-1",
				to: "them@example.com",
				subject: "Re: Hello",
				body: "A reply body long enough for the verifier to look at it.",
				runVerifyDraft: true,
			},
		);
		assert.ok("error" in result);
		assert.ok(!result.error.includes("secret_table"), result.error);
		assert.ok(!result.error.includes("SELECT"), result.error);
	});
});

// ── 7. Fix round 2: the regressions this round closed ─────────────
//
// Each section below pins one defect that survived the first pass. They are
// grouped here (rather than next to the earlier suites) so the "what changed
// this round" story stays readable: assertion on the FULL outward text, not on
// a prefix — every one of these bugs was a substring-level leak or a silently
// missing field that a `startsWith` / `"error" in result` check waved through.

describe("unknownFolder: the message is fully interpolated and never duplicated", () => {
	it("renders exactly one folder list, with no leftover placeholder", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);

		const result = await toolListEmails(db, MAILBOX, {
			folder: "inbxo",
			limit: 20,
			page: 1,
		});
		assert.ok(!Array.isArray(result), JSON.stringify(result));
		const { error } = result as { error: string };

		// The exact sentence, end to end. (`resolveUnknownFolder` lists the
		// mailbox's names AND ids in table order, deduped.)
		const VALID =
			"Archive, archive, Drafts, draft, Inbox, inbox, Sent, sent, Spam, spam, Trash, trash";
		assert.strictEqual(
			error,
			`Unknown folder: inbxo. Valid folders: ${VALID}.`,
			error,
		);
		// The blind spot that let the bug ship: a `startsWith` check passes on
		// `... Valid folders: {{folders}}. Valid folders: Inbox, Archive.`
		assert.ok(!error.includes("{{"), `uninterpolated placeholder leaked: ${error}`);
		assert.ok(!error.includes("}}"), `uninterpolated placeholder leaked: ${error}`);
		// And the list is appended ONCE, by the template.
		assert.strictEqual(error.split("Valid folders:").length - 1, 1, error);
	});

	it("still names a valid folder the caller can actually use", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const result = await toolSearchEmails(db, MAILBOX, {
			query: "body",
			folder: "nowhere",
		});
		assert.ok(!Array.isArray(result));
		const { error } = result as { error: string };
		assert.ok(error.includes("inbox"), error);
		assert.ok(error.includes("Archive"), error);
		assert.ok(!error.includes("{{"), error);
	});

	it("interpolates the Chinese template with the same two values", { skip: sqliteSkip }, async () => {
		// Runs against the REAL SQLite engine, not a hand-built stub: the stub
		// this test used to carry answered BOTH of `resolveUnknownFolder`'s
		// queries with `[]`, which is not a mailbox with an unknown folder —
		// it is an *empty* mailbox. `valid` came back `[]`, the production code
		// correctly switched to the `unknownFolderNoList` variant
		// (「未知文件夹：inbxo。」) and the assertion pinned the LIST sentence
		// that this scenario must never produce. The stub was the bug, so it
		// is gone; with the seed below the mailbox really owns folders and the
		// zh list sentence is reachable.
		const { db } = createSqliteD1(SEED);

		const result = await toolListEmails(
			db,
			MAILBOX,
			{ folder: "inbxo", limit: 20, page: 1 },
			"zh",
		);
		const { error } = result as { error: string };

		// The WHOLE outward sentence: both halves come from the zh catalog and
		// the list is `resolveUnknownFolder`'s names-then-ids dump, table order,
		// deduped — the same values the English case in this suite asserts on.
		assert.strictEqual(
			error,
			"未知文件夹：inbxo。可用文件夹：Archive, archive, Drafts, draft, Inbox, inbox, Sent, sent, Spam, spam, Trash, trash。",
			error,
		);
		assert.ok(!error.includes("{{"), error);
		assert.ok(!error.includes("}}"), error);
		// Exactly one list clause — the template's, not one appended by hand.
		assert.strictEqual(error.split("可用文件夹：").length - 1, 1, error);
		// And the no-list variant is NOT what this mailbox should produce.
		assert.ok(!error.includes("未知文件夹：inbxo。未知文件夹"), error);
	});

	it("still uses the list-less zh sentence for a mailbox with no folders", { skip: sqliteSkip }, async () => {
		// The other half of the same branch: `valid` is empty only for a mailbox
		// that has no `folders` rows at all, and there the list clause would
		// render as the dangling 「可用文件夹：。」. The two cases are asserted
		// separately so that "the stub was empty" can never again be mistaken
		// for "the interpolation is broken".
		const { db } = createSqliteD1(`
			INSERT INTO folders (mailbox_id, id, name) VALUES
				('someone-else@example.com', 'inbox', 'Inbox');
		`);

		const result = await toolListEmails(
			db,
			MAILBOX,
			{ folder: "inbxo", limit: 20, page: 1 },
			"zh",
		);
		const { error } = result as { error: string };

		assert.strictEqual(error, "未知文件夹：inbxo。", error);
		assert.ok(!error.includes("可用文件夹"), error);
		assert.ok(!error.includes("{{"), error);
	});
});

describe("get_thread: an unknown thread is an error, not an empty thread", () => {
	it("reports threadNotFound instead of `{ message_count: 0, messages: [] }`", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);

		const result = await toolGetThread(db, MAILBOX, "no-such-thread");
		assert.ok("error" in result, JSON.stringify(result));
		assert.strictEqual((result as { error: string }).error, "Thread not found");
		// The silent-empty shape must be gone entirely.
		assert.ok(!("messages" in result), JSON.stringify(result));
		assert.ok(!("message_count" in result), JSON.stringify(result));
	});

	it("still returns a real thread (and only errors when it is genuinely empty)", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();

		const result = await toolGetThread(db, MAILBOX, "thread-1");
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.thread_id, "thread-1");
		assert.strictEqual(result.message_count, 1);
		assert.strictEqual(result.messages[0].id, "orig-1");
	});

	it("the dispatcher surfaces the same error", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const result = await executeToolCall(
			toolCall("get_thread", { thread_id: "nope" }),
			db,
			MAILBOX,
			NOOP_AI,
			NOOP_BUCKET,
		);
		assert.strictEqual(result.error, "Thread not found");
	});
});

describe("move_email resolves its destination the same way list_emails does", () => {
	it("accepts the folder NAME a search result displayed", { skip: sqliteSkip }, async () => {
		// THIS CASE REALLY MOVES A ROW. It used to run against a mailbox whose
		// `folders` table held only `inbox` (the old shared seed), so `Archive`
		// resolved nowhere, the tool returned `moveFailed`/`unknownFolder`, and
		// the `!("error" in result)` line threw before the `folder_id`
		// assertion was ever reached. With the default folders seeded, `Archive`
		// resolves to the `archive` row and the move is observed on the row.
		const { db, sqlite } = seededMailbox();

		const result = await toolMoveEmail(db, MAILBOX, "orig-1", "Archive");
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.status, "moved");
		assert.strictEqual(rowFor(sqlite, "orig-1")!.folder_id, "archive");
	});

	it("rejects an unknown folder with the full unknownFolder message", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = seededMailbox();

		const result = await toolMoveEmail(db, MAILBOX, "orig-1", "inbxo");
		assert.ok("error" in result, JSON.stringify(result));
		assert.strictEqual(
			(result as { error: string }).error,
			"Unknown folder: inbxo. Valid folders: Archive, archive, Drafts, draft, Inbox, inbox, Sent, sent, Spam, spam, Trash, trash.",
		);
		// The email did not move.
		assert.strictEqual(rowFor(sqlite, "orig-1")!.folder_id, "inbox");
	});
});

describe("send failures are sanitized: fixed `error`, raw cause in `detail`", () => {
	/** A bucket that makes the Resend lookup fail, so the send throws. */
	const failingBucket = {
		get: async () => null,
		head: async () => null,
	} as unknown as R2Bucket;

	it("send_email puts no vendor text in `error` and the cause in `detail`", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolSendEmail(db, MAILBOX, NOOP_AI, failingBucket, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});

		assert.ok("error" in result, JSON.stringify(result));
		// Fixed copy — no interpolation, so no vendor string can ride along.
		assert.strictEqual(result.error, "Failed to send email. Please try again later.");
		assert.ok(!result.error.includes("Resend"), result.error);
		assert.ok(!result.error.includes("API key"), result.error);
		// The diagnosis is still available to the internal agent loop.
		assert.ok("detail" in result, "the real cause must be kept internally");
		assert.ok(String(result.detail).length > 0);
	});

	it("send_reply does the same", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolSendReply(db, MAILBOX, NOOP_AI, failingBucket, {
			id: "orig-1",
			to: "them@example.com",
			subject: "Re: Hello",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});

		assert.ok("error" in result, JSON.stringify(result));
		assert.strictEqual(result.error, "Failed to send reply. Please try again later.");
		assert.ok(!result.error.includes("Resend"), result.error);
		assert.ok("detail" in result);
	});

	it("the external gateway forwards `error` and drops `detail`", { skip: sqliteSkip }, async () => {
		// The only string from a tool that can leave the process is the one
		// `dispatchExternalTool` puts on `outcome.error`; `detail` must not be
		// reachable from it. This is the invariant the split exists for.
		const { db } = createSqliteD1(SEED);
		const result = await toolSendEmail(db, MAILBOX, NOOP_AI, failingBucket, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});
		assert.deepStrictEqual(
			Object.keys(result).sort(),
			["detail", "error"],
			"the tool result carries exactly the public message + the internal detail",
		);
	});
});

describe("write tools report the same primary keys the read tools do", () => {
	it("mark_email_read returns `id`, not `emailId`", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = seededMailbox();
		const result = await toolMarkEmailRead(db, MAILBOX, "orig-1", true);
		assert.deepStrictEqual(result, { status: "updated", id: "orig-1", read: true });
		// The write really landed on the row — the success value is not assumed.
		assert.strictEqual(rowFor(sqlite, "orig-1")!.read, 1);
	});

	it("mark_email_read reports an unknown id instead of a false success", { skip: sqliteSkip }, async () => {
		// `updateEmail` matches zero rows for an id that does not exist and
		// returns `null`. Returning `{ status: "updated" }` anyway told the
		// caller it had changed a message it never touched — the MCP rule for
		// an unknown handle is a tool error, not a silent success.
		const { db } = createSqliteD1(SEED);
		const result = await toolMarkEmailRead(db, MAILBOX, "does-not-exist", true);
		assert.deepStrictEqual(result, { error: "Email not found" });
		assert.ok(!("status" in result), JSON.stringify(result));
	});

	it("mark_email_read refuses an id from another mailbox", { skip: sqliteSkip }, async () => {
		// The existence check is the same `(id, mailbox_id)` pair the UPDATE
		// uses, so a readable id that belongs elsewhere is not silently
		// "updated" here.
		const { db, sqlite } = createSqliteD1(
			SEED +
				`INSERT INTO emails (id, mailbox_id, folder_id, subject, read) VALUES ('other-1', 'other@example.com', 'inbox', 'Theirs', 0);`,
		);
		const result = await toolMarkEmailRead(db, MAILBOX, "other-1", true);
		assert.deepStrictEqual(result, { error: "Email not found" });
		assert.strictEqual(
			sqlite.prepare("SELECT read FROM emails WHERE id = 'other-1'").all()[0]!.read,
			0,
			"another mailbox's row must not be touched",
		);
	});

	it("move_email reports an unknown email, not the generic move failure", { skip: sqliteSkip }, async () => {
		// The destination resolves here, so `moveEmail`'s `false` can only mean
		// "no such email in this mailbox" — the folder branch was already
		// taken out above.
		const { db } = seededMailbox();
		const result = await toolMoveEmail(db, MAILBOX, "does-not-exist", "Archive");
		assert.deepStrictEqual(result, { error: "Email not found" });
	});

	it("move_email returns `{ id, folder }`", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolMoveEmail(db, MAILBOX, "orig-1", "archive");
		assert.deepStrictEqual(result, { status: "moved", id: "orig-1", folder: "archive" });
	});

	it("delete_email returns `id`, not `emailId`", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolDeleteEmail(db, MAILBOX, "orig-1");
		assert.deepStrictEqual(result, { status: "deleted", id: "orig-1" });
	});

	it("draft_reply's nested original is `reply_to_id`, never a bare `id`", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			id: "orig-1",
			to: "them@example.com",
			subject: "Re: Hello",
			body: "Body.",
			isPlainText: true,
		});
		assert.ok(!("error" in result), JSON.stringify(result));

		// `draftId` is the draft; `draft.reply_to_id` is the email replied to.
		// They must not collide on a name, and the returned pair must be
		// consistent with the ROW that was written (`in_reply_to`).
		assert.strictEqual(result.draft.reply_to_id, "orig-1");
		assert.notStrictEqual(result.draftId, result.draft.reply_to_id);
		assert.deepStrictEqual(
			Object.keys(result.draft).sort(),
			["body", "reply_to_id", "subject", "to"],
			"no id-shaped key may share the name `id` here",
		);
		assert.ok(!("originalEmailId" in result.draft));
	});

	it("draft_email's thread is `thread_id`, not camelCase `threadId`", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolDraftEmail(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Hi",
			body: "Body.",
			isPlainText: true,
			thread_id: "thread-9",
		});
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.thread_id, "thread-9");
		assert.ok(!("threadId" in result), "the camelCase spelling must be gone");
	});

	it("the `draftId` family is untouched (those names are load-bearing)", { skip: sqliteSkip }, async () => {
		// `draftId` is BOTH the argument `update_draft` / `discard_draft` take
		// and the field they return, so it does not collide with `id` and must
		// keep its name.
		const { db } = seededMailbox();
		const drafted = await toolDraftEmail(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Hi",
			body: "Body.",
			isPlainText: true,
		});
		assert.ok(!("error" in drafted));
		assert.ok("draftId" in drafted);
	});
});

// ── 8. Fix round 3: an unknown id, or a non-draft, never "succeeds" ─
//
// The one rule all three defects below broke: a write tool may only report
// success for work it can actually name. Each of them resolved an id, got
// NOTHING back, and wrote a row anyway (or deleted one) under a success
// message. `send_reply` already refused these cases, which is why the same
// tools here are the last to be brought in line.
//
// Two of these ran against {@link SEED} alone, without any emails: that is the
// world in which every id is unknown, and it is what makes "no write happened"
// observable as literally "the mailbox is still empty". `rowFor` on a row that
// was never meant to exist is the whole proof.

/**
 * The seeded original for the reply/draft-email cases.
 *
 * `draft-1` is the valid draft `update_draft` must keep accepting, and
 * `orig-1` doubles as the non-draft handle the guard must refuse (its folder
 * is `inbox`). Both are needed for the same file, so they are seeded together
 * rather than being derived from `EMAIL_SEED`: an email in `inbox` is exactly
 * what makes the `update_draft` rejection case reachable.
 */
const DRAFT_SEED =
	SEED +
	EMAIL_SEED +
	`INSERT INTO emails (id, mailbox_id, folder_id, subject, sender, recipient, date, body, thread_id)
		VALUES ('draft-1', '${MAILBOX}', 'draft', 'Draft body', '${MAILBOX}', 'them@example.com', '2026-01-03T00:00:00.000Z', '<p>draft body</p>', 'thread-9');
`;

describe("draft_reply refuses a reply-to id that does not resolve", () => {
	it("returns the original-email error for an id that is present but unknown", { skip: sqliteSkip }, async () => {
		// Before this guard the tool answered `{ status: "draft_saved" }` here.
		// `getEmail` returned null, `threadId` fell back to the caller's id and
		// the row was written with `in_reply_to = thread_id = does-not-exist` —
		// a draft anchored to a message that does not exist, reported as saved.
		const { db } = createSqliteD1(SEED);

		const result = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			id: "does-not-exist",
			to: "them@example.com",
			subject: "Re: Hello",
			body: "Replying to a message that is not there.",
			isPlainText: true,
		});

		// The exact sentence `send_reply` produces for the same mistake.
		assert.deepStrictEqual(result, { error: "Original email not found" });
		assert.ok(!("status" in result), JSON.stringify(result));
		assert.ok(!("draftId" in result), "no draft id may be handed back");
	});

	it("writes NOTHING — the mailbox has no draft afterwards", { skip: sqliteSkip }, async () => {
		// The strongest available form of "did not silently succeed": run it
		// against a mailbox that owns folders but no emails at all, so any row
		// at all is proof of a write.
		const { db, sqlite } = createSqliteD1(SEED);

		const result = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			id: "does-not-exist",
			to: "them@example.com",
			subject: "Re: Hello",
			body: "body.",
			isPlainText: true,
		});
		assert.ok("error" in result, JSON.stringify(result));

		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS n FROM emails").all()[0]!.n,
			0,
			"a rejected draft_reply must not leave a row behind",
		);
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'draft'").all()[0]!.n,
			0,
		);
	});

	it("still saves a draft for a real id, and keeps the up-front argument error", { skip: sqliteSkip }, async () => {
		// Both halves of the boundary: a resolving id is untouched by the new
		// guard, and the pre-existing "no id at all" branch still answers
		// `emailNotFound` (missing is a malformed CALL; unknown is a bad
		// HANDLE — they are different mistakes and say so).
		const { db, sqlite } = createSqliteD1(DRAFT_SEED);

		const saved = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			id: "orig-1",
			to: "them@example.com",
			subject: "Re: Hello",
			body: "A real reply.",
			isPlainText: true,
		});
		assert.ok(!("error" in saved), JSON.stringify(saved));
		assert.strictEqual(saved.status, "draft_saved");
		const row = rowFor(sqlite, saved.draftId)!;
		assert.strictEqual(row.folder_id, "draft");
		assert.strictEqual(row.in_reply_to, "orig-1");
		assert.strictEqual(row.thread_id, "thread-1");

		const missing = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Re: Hello",
			body: "No id.",
		});
		assert.deepStrictEqual(missing, { error: "Email not found" });
	});

	it("never audits an empty id as a resolve failure", { skip: sqliteSkip }, async () => {
		// `""` is falsy, so it takes the argument branch — the guard must not
		// turn a malformed call into an "unknown handle" message.
		const { db } = createSqliteD1(DRAFT_SEED);
		const result = await toolDraftReply(db, MAILBOX, NOOP_AI, {
			id: "",
			to: "them@example.com",
			subject: "Re: Hello",
			body: "Empty id.",
		});
		assert.deepStrictEqual(result, { error: "Email not found" });
	});
});

describe("draft_email refuses an in_reply_to that does not resolve", () => {
	it("errors instead of filing the draft under the bogus id", { skip: sqliteSkip }, async () => {
		// `resolvedThreadId = original?.thread_id || params.in_reply_to` used to
		// put the caller's nonexistent id into `thread_id` AND `in_reply_to`
		// while still answering `draft_saved`.
		const { db, sqlite } = createSqliteD1(SEED);

		const result = await toolDraftEmail(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Hi",
			body: "Body.",
			isPlainText: true,
			in_reply_to: "does-not-exist",
		});

		assert.deepStrictEqual(result, { error: "Original email not found" });
		assert.ok(!("thread_id" in result), "no thread key may be returned");
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS n FROM emails").all()[0]!.n,
			0,
			"nothing may be written for an unresolvable in_reply_to",
		);
	});

	it("omitting in_reply_to is still the ordinary new-draft path", { skip: sqliteSkip }, async () => {
		// The guard is scoped to a `in_reply_to` that was actually GIVEN. A
		// plain new draft has no original to resolve and must be unaffected:
		// its thread is its own id.
		const { db, sqlite } = createSqliteD1(SEED);

		const result = await toolDraftEmail(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Hi",
			body: "Body.",
			isPlainText: true,
		});
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.status, "draft_saved");
		assert.strictEqual(result.thread_id, result.draftId);
		const row = rowFor(sqlite, result.draftId)!;
		assert.strictEqual(row.folder_id, "draft");
		assert.strictEqual(row.in_reply_to, null);
	});

	it("still threads a draft onto a real original", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createSqliteD1(DRAFT_SEED);
		const result = await toolDraftEmail(db, MAILBOX, NOOP_AI, {
			to: "them@example.com",
			subject: "Re: Hello",
			body: "Body.",
			isPlainText: true,
			in_reply_to: "orig-1",
		});
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.thread_id, "thread-1");
		const row = rowFor(sqlite, result.draftId)!;
		assert.strictEqual(row.in_reply_to, "orig-1");
		assert.strictEqual(row.thread_id, "thread-1");
	});
});

describe("update_draft refuses anything that is not a draft", () => {
	it("reports the non-draft error for an inbox id", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(DRAFT_SEED);
		const result = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "orig-1",
			bodyHtml: "<p>rewritten</p>",
			skipVerifyDraft: true,
		});
		assert.deepStrictEqual(result, { error: "Cannot update: email is not a draft" });
		assert.ok(!("status" in result), JSON.stringify(result));
		assert.ok(!("newDraftId" in result));
	});

	it("does NOT delete the original email and does NOT create a draft", { skip: sqliteSkip }, async () => {
		// The defect this pins: `update_draft` is delete-then-insert, so an
		// inbox id used to make the original VANISH and come back as a draft.
		// Asserted on the whole table, not just on the row: "still present and
		// still in the inbox" is the property, and a count keeps a stray
		// replacement draft from passing the check.
		const { db, sqlite } = createSqliteD1(DRAFT_SEED);
		const before = sqlite.prepare("SELECT id, folder_id FROM emails ORDER BY id").all();

		const result = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "orig-1",
			bodyHtml: "<p>rewritten</p>",
			skipVerifyDraft: true,
		});
		assert.ok("error" in result, JSON.stringify(result));

		const after = sqlite.prepare("SELECT id, folder_id FROM emails ORDER BY id").all();
		assert.deepStrictEqual(after, before, "the mailbox must be byte-for-byte unchanged");
		const original = rowFor(sqlite, "orig-1")!;
		assert.ok(original, "the inbox email must still exist");
		assert.strictEqual(original.folder_id, "inbox", "and must not have been re-filed");
		assert.strictEqual(
			sqlite.prepare("SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'draft'").all()[0]!.n,
			1,
			"no replacement draft may have been created",
		);
	});

	it("rejects a sent email too — the guard reads the folder, not the id", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(
			DRAFT_SEED +
				`\tINSERT INTO emails (id, mailbox_id, folder_id, subject) VALUES ('sent-1', '${MAILBOX}', 'sent', 'Sent already');\n`,
		);
		const result = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "sent-1",
			bodyHtml: "<p>rewritten</p>",
			skipVerifyDraft: true,
		});
		assert.deepStrictEqual(result, { error: "Cannot update: email is not a draft" });
	});

	it("an unknown draft id still says draftNotFound, not the folder error", { skip: sqliteSkip }, async () => {
		// Existence is checked first, so the two failures stay distinguishable:
		// there is no folder to inspect for a row that does not exist.
		const { db } = createSqliteD1(DRAFT_SEED);
		const result = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "does-not-exist",
			bodyHtml: "<p>x</p>",
			skipVerifyDraft: true,
		});
		assert.deepStrictEqual(result, { error: "Draft not found" });
	});

	it("still updates a real draft, replacing it in place", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = createSqliteD1(DRAFT_SEED);

		const result = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "draft-1",
			bodyHtml: "<p>a better draft</p>",
			skipVerifyDraft: true,
		});
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.status, "draft_updated");
		assert.strictEqual(result.oldDraftId, "draft-1");

		assert.strictEqual(rowFor(sqlite, "draft-1"), null, "the old draft is replaced");
		const replacement = rowFor(sqlite, result.newDraftId)!;
		assert.strictEqual(replacement.folder_id, "draft");
		assert.strictEqual(replacement.body, "<p>a better draft</p>");
		// The row's own thread anchor survives the replace.
		assert.strictEqual(replacement.thread_id, "thread-9");
	});

	it("and discard_draft keeps its own guard (the pair stays consistent)", { skip: sqliteSkip }, async () => {
		// The two draft tools now check the same thing on the same field. If
		// one of them ever stops, this pair fails together.
		const { db } = createSqliteD1(DRAFT_SEED);
		assert.deepStrictEqual(await toolDiscardDraft(db, MAILBOX, "orig-1"), {
			error: "Cannot discard: email is not a draft",
		});
		assert.deepStrictEqual(await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "orig-1",
			bodyHtml: "<p>x</p>",
			skipVerifyDraft: true,
		}), { error: "Cannot update: email is not a draft" });
	});
});

describe("the new guard is localized like its siblings", () => {
	it("renders the zh sentence for a non-draft update", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(DRAFT_SEED);
		const result = await toolUpdateDraft(
			db,
			MAILBOX,
			NOOP_AI,
			{ draftId: "orig-1", bodyHtml: "<p>x</p>", skipVerifyDraft: true },
			"zh",
		);
		// A whole-sentence assertion, like the zh `unknownFolder` case: it fails
		// if the key is missing (i18next would fall back to the key name) or if
		// the catalog entry drifts.
		assert.deepStrictEqual(result, { error: "无法更新：该邮件不是草稿" });
	});

	it("renders the zh sentence for an unknown reply target", { skip: sqliteSkip }, async () => {
		const { db } = createSqliteD1(SEED);
		const result = await toolDraftReply(
			db,
			MAILBOX,
			NOOP_AI,
			{
				id: "does-not-exist",
				to: "them@example.com",
				subject: "Re: Hello",
				body: "body.",
			},
			"zh",
		);
		assert.deepStrictEqual(result, { error: "未找到原始邮件" });
	});
});

// ── 9. Fix round 3: a result must describe the work that happened ──
//
// The tail of the same family the earlier rounds closed: a caller must be able
// to tell, from the result alone, whether the write it asked for took place and
// what value it now needs. All three defects below made the result say
// something the code had not done — two of them said it with a SUCCESS, which
// is what makes them dangerous rather than merely awkward.

describe("mark_email_read refuses a call that names no read state", () => {
	/**
	 * The defect: `read: undefined` is not a request to change anything.
	 *
	 * `updateEmail` builds its `SET` clause from the fields that are present and
	 * — when none are — returns the existing row WITHOUT ever running an
	 * `UPDATE`. The row it hands back is truthy, so the tool's existence check
	 * passed and the caller got `{ status: "updated", id }`. The absence of the
	 * `read` key from that object is the tell: `JSON.stringify` drops
	 * `undefined`, so the caller could not even see that the state it asked
	 * about was the one thing missing. Every assertion below therefore checks
	 * the ROW, not just the returned object.
	 */
	it("errors on a missing `read` instead of answering `updated`", { skip: sqliteSkip }, async () => {
		const { db, sqlite } = seededMailbox();
		// Seed a READ email so "no write happened" is distinguishable from
		// "the write happened to be a no-op": the guard must leave `read = 1`,
		// not flip it, and definitely not claim an update.
		sqlite.exec("UPDATE emails SET read = 1 WHERE id = 'orig-1'");

		const result = await toolMarkEmailRead(
			db,
			MAILBOX,
			"orig-1",
			undefined as unknown as boolean,
		);
		assert.deepStrictEqual(result, {
			error: "Invalid `read` parameter: expected true or false",
		});
		assert.ok(!("status" in result), JSON.stringify(result));
		assert.ok(
			!("read" in result),
			"`read` must not ride along on a failure result either",
		);
		assert.strictEqual(
			rowFor(sqlite, "orig-1")!.read,
			1,
			"the row must be untouched — no silent flip to unread",
		);
	});

	it("errors on a non-boolean `read` too, whatever its spelling", { skip: sqliteSkip }, async () => {
		// `1`, `"yes"`, `null` and `{}` all describe no read state this tool
		// can act on. `null` in particular is what an explicit JSON `null`
		// arrives as, and it must not be read as "leave it" either.
		for (const bogus of [null, 1, 0, "yes", "", {}, []]) {
			const { db } = seededMailbox();
			const result = await toolMarkEmailRead(
				db,
				MAILBOX,
				"orig-1",
				bogus as unknown as boolean,
			);
			assert.deepStrictEqual(
				result,
				{ error: "Invalid `read` parameter: expected true or false" },
				`read = ${JSON.stringify(bogus)} must be rejected`,
			);
		}
	});

	it("still accepts a real boolean, in both directions", { skip: sqliteSkip }, async () => {
		// The guard must not become the bug: the ordinary calls keep working,
		// and the write still lands on the row.
		const { db, sqlite } = seededMailbox();
		assert.deepStrictEqual(await toolMarkEmailRead(db, MAILBOX, "orig-1", true), {
			status: "updated",
			id: "orig-1",
			read: true,
		});
		assert.strictEqual(rowFor(sqlite, "orig-1")!.read, 1);

		assert.deepStrictEqual(await toolMarkEmailRead(db, MAILBOX, "orig-1", false), {
			status: "updated",
			id: "orig-1",
			read: false,
		});
		assert.strictEqual(rowFor(sqlite, "orig-1")!.read, 0);
	});

	it("accepts the `\"true\"` / `\"false\"` spellings a text model emits", { skip: sqliteSkip }, async () => {
		// JSON-stringified booleans are the one non-boolean form that carries
		// an unambiguous intent, so they are read rather than refused.
		const { db, sqlite } = seededMailbox();
		assert.deepStrictEqual(
			await toolMarkEmailRead(db, MAILBOX, "orig-1", "true" as unknown as boolean),
			{ status: "updated", id: "orig-1", read: true },
		);
		assert.strictEqual(rowFor(sqlite, "orig-1")!.read, 1);
		assert.deepStrictEqual(
			await toolMarkEmailRead(db, MAILBOX, "orig-1", "FALSE" as unknown as boolean),
			{ status: "updated", id: "orig-1", read: false },
		);
		assert.strictEqual(rowFor(sqlite, "orig-1")!.read, 0);

		// And the parsed value is what the result reports, not the raw string.
		const parsed = await toolMarkEmailRead(db, MAILBOX, "orig-1", "true" as unknown as boolean);
		assert.strictEqual(typeof (parsed as { read: unknown }).read, "boolean");
	});

	it("the missing-`read` error is localized like its siblings", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolMarkEmailRead(
			db,
			MAILBOX,
			"orig-1",
			undefined as unknown as boolean,
			"zh",
		);
		// A whole-sentence assertion, like the zh `unknownFolder` case: it fails
		// if the key is missing (i18next falls back to the key NAME) or if the
		// catalog entry drifts.
		assert.deepStrictEqual(result, { error: "参数 read 无效：应为 true 或 false" });
	});

	it("the guard runs BEFORE the write, so an unknown id is not the error reported", { skip: sqliteSkip }, async () => {
		// Ordering matters for the message the caller gets: a call that names
		// neither a usable `read` NOR a real email is malformed in a way the
		// caller can fix without knowing the mailbox, so the argument error is
		// the useful one. It also proves the check is up front rather than a
		// post-hoc repair of a result `updateEmail` already produced.
		const { db, statements } = createSqliteD1(SEED);
		const before = statements.length;
		const result = await toolMarkEmailRead(
			db,
			MAILBOX,
			"does-not-exist",
			undefined as unknown as boolean,
		);
		assert.deepStrictEqual(result, {
			error: "Invalid `read` parameter: expected true or false",
		});
		assert.strictEqual(
			statements.length,
			before,
			"not one statement may have run for a call that was rejected on its arguments",
		);
	});

	it("the external gateway still blocks a missing `read` first (unchanged)", { skip: sqliteSkip }, async () => {
		// `dispatchExternalTool` gates on the schema's `required` list before
		// executing, so an external caller sees its own `missing required
		// parameter` message and never reaches the new guard. This pins that
		// split: the guard closes the internal / direct path only, and the
		// external contract is byte-for-byte what it was.
		const { db, sqlite } = seededMailbox();
		const bucket = { get: async () => null, head: async () => ({}) } as unknown as R2Bucket;
		const result = await dispatchExternalTool(
			{ DB: db, BUCKET: bucket, AI: NOOP_AI },
			{ name: "mark_email_read", arguments: { id: "orig-1" }, mailboxId: MAILBOX },
		);
		assert.deepStrictEqual(result, {
			ok: false,
			error: "missing required parameter: read",
		});
		assert.strictEqual(rowFor(sqlite, "orig-1")!.read, 0, "nothing was written");
	});
});

describe("update_draft echoes the id it was given, under the name it takes", () => {
	it("returns `draftId` alongside `newDraftId` / `oldDraftId`", { skip: sqliteSkip }, async () => {
		// The argument is `draftId`; the result used to name the replacement
		// only `newDraftId`, so a caller chaining a second `update_draft` (or a
		// `discard_draft`) had to know to rename it. `draftId` is now the
		// chaining key, and the old names are kept — additive, not a rename.
		const { db, sqlite } = createSqliteD1(DRAFT_SEED);
		const result = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "draft-1",
			bodyHtml: "<p>a better draft</p>",
			skipVerifyDraft: true,
		});
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.draftId, result.newDraftId);
		assert.strictEqual(result.oldDraftId, "draft-1");
		assert.strictEqual(rowFor(sqlite, "draft-1"), null, "the old draft is replaced");
		assert.ok(
			rowFor(sqlite, result.draftId),
			"`draftId` must name the row that actually exists now",
		);
	});

	it("the echoed `draftId` feeds straight back into the tool", { skip: sqliteSkip }, async () => {
		// The point of the field: no renaming step in between. A second
		// `update_draft` chained on `result.draftId` must succeed and keep the
		// chain intact.
		const { db, sqlite } = createSqliteD1(DRAFT_SEED);
		const first = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "draft-1",
			bodyHtml: "<p>first rewrite</p>",
			skipVerifyDraft: true,
		});
		assert.ok(!("error" in first), JSON.stringify(first));

		const second = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: first.draftId,
			bodyHtml: "<p>second rewrite</p>",
			skipVerifyDraft: true,
		});
		assert.ok(!("error" in second), JSON.stringify(second));
		assert.strictEqual(second.oldDraftId, first.draftId);
		assert.strictEqual(rowFor(sqlite, first.draftId), null, "the middle draft is gone");
		assert.strictEqual(rowFor(sqlite, second.draftId)!.body, "<p>second rewrite</p>");

		// And `discard_draft` — the other half of the pair — takes it as-is.
		assert.deepStrictEqual(await toolDiscardDraft(db, MAILBOX, second.draftId), {
			status: "discarded",
			draftId: second.draftId,
		});
	});

	it("the failure shapes still carry no id at all", { skip: sqliteSkip }, async () => {
		// The extra field must not be bolted onto the error results — a
		// `draftId` there would be the same "success-shaped field on a
		// failure" problem the rest of this file exists to prevent.
		const { db } = createSqliteD1(DRAFT_SEED);
		const notADraft = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "orig-1",
			bodyHtml: "<p>x</p>",
			skipVerifyDraft: true,
		});
		assert.deepStrictEqual(notADraft, { error: "Cannot update: email is not a draft" });

		const unknown = await toolUpdateDraft(db, MAILBOX, NOOP_AI, {
			draftId: "does-not-exist",
			bodyHtml: "<p>x</p>",
			skipVerifyDraft: true,
		});
		assert.deepStrictEqual(unknown, { error: "Draft not found" });
	});
});

describe("search_emails refuses an empty query instead of answering with the mailbox", () => {
	/**
	 * The defect: `query: ""` is not a search.
	 *
	 * `toolSearchEmails` passed the query straight to `db.searchEmails`, and
	 * `buildSearchConditions` emits its `WHERE` clause only when the query is
	 * truthy. An empty one therefore produced a bare `SELECT … LIMIT 25` and
	 * the caller received the first 25 emails of the mailbox as "matches" —
	 * indistinguishable, from the result, from a real search that happened to
	 * match. The internal agent can send this (the schema's `required: ["query"]`
	 * is enforced by the external gateway only), so it is reachable in
	 * production, not just from a test.
	 *
	 * Every case below asserts on the WHOLE result rather than on `"error" in
	 * result`: the failure mode being guarded is a plausible-looking LIST, and
	 * only pinning the exact shape rules that out.
	 */
	it("rejects an empty string and a whitespace-only query", { skip: sqliteSkip }, async () => {
		for (const blank of ["", " ", "   ", "\t", "\n", " \t\n "]) {
			const { db } = seededMailbox();
			const result = await toolSearchEmails(db, MAILBOX, { query: blank });
			assert.deepStrictEqual(
				result,
				{ error: "Search query is required" },
				`query = ${JSON.stringify(blank)} must be refused`,
			);
			assert.ok(
				!Array.isArray(result),
				"a blank query must never come back as a list of emails",
			);
		}
	});

	it("rejects a query that is absent entirely", { skip: sqliteSkip }, async () => {
		// A `undefined` query is the `{}` call — the same missing argument, and
		// the same wrong answer (`buildSearchConditions` skips on falsy), so it
		// is refused identically rather than being a second hole.
		const { db } = seededMailbox();
		const result = await toolSearchEmails(db, MAILBOX, {} as { query: string });
		assert.deepStrictEqual(result, { error: "Search query is required" });
	});

	it("refuses before touching the database", { skip: sqliteSkip }, async () => {
		// The guard is up front, not a post-hoc filter over rows the query
		// already fetched: an empty query must not cost a full-table scan whose
		// result is then thrown away. This also pins the guard's position —
		// ahead of the folder resolution, which would otherwise report an
		// unknown folder for a call that cannot search anyway.
		const { db, statements } = createSqliteD1(SEED);
		const before = statements.length;
		const result = await toolSearchEmails(db, MAILBOX, { query: "  ", folder: "inbxo" });
		assert.deepStrictEqual(result, { error: "Search query is required" });
		assert.strictEqual(
			statements.length,
			before,
			"not one statement may have run for a search with no query",
		);
	});

	it("still searches for a real query", { skip: sqliteSkip }, async () => {
		// The guard must not become the bug. `orig-1` is the only seeded email
		// whose body contains "original"; `inbox-2`'s contains "another".
		const { db } = seededMailbox();
		const hit = await toolSearchEmails(db, MAILBOX, { query: "original" });
		assert.ok(Array.isArray(hit), JSON.stringify(hit));
		assert.deepStrictEqual(
			hit.map((email) => email.id),
			["orig-1"],
			"a real query must still return its real matches",
		);

		// And a padded query keeps working — `trim()` decides "is there a
		// query", it does not become the search term the caller never asked for.
		const padded = await toolSearchEmails(db, MAILBOX, { query: " original " });
		assert.ok(Array.isArray(padded), JSON.stringify(padded));
	});

	it("the empty-query error is localized like its siblings", { skip: sqliteSkip }, async () => {
		const { db } = seededMailbox();
		const result = await toolSearchEmails(db, MAILBOX, { query: "" }, "zh");
		// A whole-sentence assertion, like the zh `unknownFolder` case: it fails
		// if the key is missing (i18next falls back to the key NAME) or if the
		// catalog entry drifts.
		assert.deepStrictEqual(result, { error: "搜索关键词不能为空" });
	});

	it("the external gateway still blocks the missing query first (unchanged)", { skip: sqliteSkip }, async () => {
		// `dispatchExternalTool` gates on the schema's `required` list before
		// executing, so an external caller sees its own message and never reaches
		// the new guard. This pins the split the task asked for: the guard closes
		// the internal / direct path, and the external contract is unchanged.
		//
		// The argument bag is deliberately `{"query": ""}` rather than an empty
		// one: an EMPTY bag is caught by the gateway's own required-parameter
		// pre-check, and this case is about the boundary BETWEEN the two gates —
		// the query is present (so the gateway passes it through) yet blank (so
		// the internal guard refuses it).
		const { db, statements } = createSqliteD1(SEED);
		const before = statements.length;
		const result = await dispatchExternalTool(
			{ DB: db, BUCKET: NOOP_BUCKET, AI: NOOP_AI },
			{ name: "search_emails", arguments: { query: "" }, mailboxId: MAILBOX },
		);
		assert.deepStrictEqual(result, {
			ok: false,
			error: "tool execution failed",
		});
		assert.strictEqual(
			statements.length,
			before,
			"the guard must have refused before any statement ran",
		);
	});

	it("a missing query is refused before the tool runs", { skip: sqliteSkip }, async () => {
		// The other half of the boundary: with no `query` key at all the call
		// fails on the schema's declared requirement rather than on the guard,
		// which is why the internal guard can be a backstop rather than the
		// only defence. The exact string is the dispatcher's own generic
		// failure copy — this case pins that a missing query is still a
		// FAILURE, not that some particular sentence is used.
		const { db } = seededMailbox();
		const result = await dispatchExternalTool(
			{ DB: db, BUCKET: NOOP_BUCKET, AI: NOOP_AI },
			{ name: "search_emails", arguments: {}, mailboxId: MAILBOX },
		);
		assert.deepStrictEqual(result, { ok: false, error: "tool execution failed" });
	});

	it("the guard is documented as internal-only by the schema it backs up", async () => {
		// The guard is a backstop, not a replacement: `query` stays declared and
		// required, so the external callers that rely on the gateway's 400 keep
		// getting one.
		const tool = TOOL_DEFINITIONS.find((entry) => entry.name === "search_emails")!;
		assert.deepStrictEqual(tool.parameters.required, ["query"]);
	});
});

// ── 10. Fix round 4: the send result names its message `id` ────────
//
// `send_email` / `send_reply` answered `{ status: "sent", messageId, message }`
// while EVERY other tool — `get_email`, `list_emails`, `search_emails`,
// `move_email`, `delete_email` — names an email handle `id`, and so does the
// REST surface. A model chaining a send into a follow-up call therefore had to
// know that this one tool renamed the same concept, which is exactly the
// "argument names match the returned field names" contract the rest of this
// file holds the tools to.
//
// Both cases below drive the REAL tool to its SUCCESS return: the bucket serves
// a Resend key out of R2 (as production does) and only the final HTTPS POST is
// answered locally — see `CONFIGURED_BUCKET` / `stubResendFetch`. With the real
// sender unresolvable the call can only ever fail, and a failure body never
// reaches the line this defect is in.

describe("send tools return `id`, not `messageId`", () => {
	it("send_email's success body carries `id` and contains no `messageId`", async (t) => {
		const resendFetch = stubResendFetch(t);
		const { db, sqlite } = seededMailboxWithWorkingSend();

		const result = await toolSendEmail(db, MAILBOX, NOOP_AI, CONFIGURED_BUCKET, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});

		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.status, "sent");
		assert.ok("id" in result, "the send result must name its message `id`");
		assert.ok(
			!("messageId" in result),
			"`messageId` must be gone, not merely accompanied by `id`",
		);
		// The primary key is the row that was written, not a fresh invention:
		// the value `id` carries is the sent email's real handle, which is what
		// the caller needs for a follow-up `get_email`.
		const row = rowFor(sqlite, result.id)!;
		assert.ok(row, "`id` must name the row the tool actually wrote");
		assert.strictEqual(row.folder_id, "sent");
		assert.strictEqual(row.subject, "Hi");
		assert.strictEqual(row.recipient, "them@example.com");
		// Exactly one outbound request — and it went to the real endpoint with
		// the real body, so the success above is production's success path and
		// not a bypassed one.
		assert.strictEqual(resendFetch.mock.callCount(), 1);
		assert.strictEqual(
			String(resendFetch.mock.calls[0]!.arguments[0]),
			"https://api.resend.com/emails",
		);
	});

	it("send_reply's success body carries `id` and contains no `messageId`", async (t) => {
		stubResendFetch(t);
		const { db, sqlite } = seededMailboxWithWorkingSend();

		const result = await toolSendReply(db, MAILBOX, NOOP_AI, CONFIGURED_BUCKET, {
			id: "orig-1",
			to: "them@example.com",
			subject: "Re: Hello",
			bodyHtml: "<p>Replying now.</p>",
			skipVerifyDraft: true,
		});

		assert.ok(!("error" in result), JSON.stringify(result));
		assert.strictEqual(result.status, "sent");
		assert.ok("id" in result);
		assert.ok(!("messageId" in result));
		// The leading assertion in this file is that TWO different ids must never
		// share a name: `id` is the row that was SENT, not the original it
		// replies to.
		assert.notStrictEqual(result.id, "orig-1");
		const row = rowFor(sqlite, result.id)!;
		assert.strictEqual(row.folder_id, "sent");
		assert.strictEqual(row.thread_id, "thread-1");
		// The two id-shaped columns are the ones production writes: the row's own
		// `id` is the value the tool returned, and `message_id` is the outbound
		// RFC 2822 header derived from it (`<uuid>@<domain>`), never the
		// original's. NOTE: `message_id` is NOT the Resend response's id —
		// `sendEmailFromMailbox`'s `{ messageId }` is discarded by the tool, so
		// the outward `id` is the internal row handle and nothing of the vendor's
		// value can leak into it.
		assert.strictEqual(row.id, result.id);
		assert.match(String(row.message_id), /@example\.com$/);
		assert.notStrictEqual(row.message_id, "orig-msg-1@example.com");
		// Threading is anchored on the original's RFC 2822 header, which is what
		// `messageId`/`message_id` and `in_reply_to` hold in this schema — NOT on
		// the row id `result.id`. Pinning it here keeps the two id worlds
		// (`id` = row handle, `message_id` = header) from being confused by the
		// rename this suite exists for.
		assert.strictEqual(row.in_reply_to, "orig-msg-1@example.com");
	});

	it("the success result's key set is exactly `status`, `id`, `message`", async (t) => {
		// A whole-object key assertion, so no legacy alias can ride along
		// unnoticed — a kept `messageId` would defeat the entire point of the
		// rename for a model that reads the first id-shaped key it finds.
		stubResendFetch(t);
		const { db } = seededMailboxWithWorkingSend();
		const result = await toolSendEmail(db, MAILBOX, NOOP_AI, CONFIGURED_BUCKET, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});
		assert.ok(!("error" in result), JSON.stringify(result));
		assert.deepStrictEqual(Object.keys(result).sort(), ["id", "message", "status"]);
	});

	it("the `id` a send returns feeds straight back into the read tools", async (t) => {
		// The point of the rename: no hand-renaming step in between. The value
		// `id` names must resolve through `get_email`, which is the tool the
		// model would reach for next.
		stubResendFetch(t);
		const { db } = seededMailboxWithWorkingSend();
		const sent = await toolSendEmail(db, MAILBOX, NOOP_AI, CONFIGURED_BUCKET, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});
		assert.ok(!("error" in sent), JSON.stringify(sent));

		const fetched = await toolGetEmail(db, MAILBOX, sent.id);
		assert.ok(!("error" in fetched), JSON.stringify(fetched));
		assert.strictEqual(fetched.subject, "Hi");
		// `get_email` resolves the handle it is given. NOTE: it echoes the id
		// the caller PASSED (`toolGetEmail` takes the id positionally and
		// `getFullEmail` spreads the row), so this pins the chaining contract —
		// the value `send_email` returned is accepted, and resolves to the
		// message that was actually sent.
		assert.strictEqual(fetched.id, sent.id);
	});

	it("the failure bodies still carry no id at all", { skip: sqliteSkip }, async () => {
		// The rename must not have bolted an `id` onto the error shapes — a
		// success-shaped field on a failure is the exact problem the rest of
		// this file exists to prevent. No bucket config, so the send really
		// fails and this stays on the unchanged failure path.
		const { db } = seededMailbox();
		const result = await toolSendEmail(db, MAILBOX, NOOP_AI, NOOP_BUCKET, {
			to: "them@example.com",
			subject: "Hi",
			bodyHtml: "<p>Body.</p>",
			skipVerifyDraft: true,
		});
		assert.ok("error" in result, JSON.stringify(result));
		assert.ok(!("id" in result), "no `id` may appear on a failed send");
		assert.ok(!("messageId" in result));
	});

	it("the external gateway's public field list needed no widening", async () => {
		// `dispatchExternalTool` reshapes the tool result for the wire, and the
		// public list is `[ok, result, error]` — the tool's own body travels
		// inside `result`, so the renamed key needs no gateway change at all.
		// This pins that the fix really is confined to the tool's return body.
		assert.deepStrictEqual(
			[...EXTERNAL_RESULT_PUBLIC_FIELDS],
			["ok", "result", "error"],
			"the rename must not have required widening the public field list",
		);
	});
});

describe("the tool schema matches the code that runs it", () => {
	it("`list_emails` documents the limit default `getEmails` actually uses", async () => {
		// The description is part of the schema handed to the model, so a
		// wrong default is a wrong instruction — and 20 vs 25 is exactly the
		// kind of off-by-five a caller cannot detect from a result.
		const listEmails = TOOL_DEFINITIONS.find((tool) => tool.name === "list_emails")!;
		const limit = listEmails.parameters.properties.limit as { description: string };
		assert.strictEqual(limit.description, "Max emails to return (default 25)");
		assert.ok(
			!limit.description.includes("default 20"),
			"the stale default must be gone, not merely appended to",
		);
	});

	it("no tool description promises a `default 20` any more", async () => {
		// A guard over the whole schema, so a future tool cannot reintroduce
		// the same disagreement somewhere else in the surface.
		const offenders = TOOL_DEFINITIONS.flatMap((tool) =>
			Object.entries(tool.parameters.properties as Record<string, { description?: string }>)
				.filter(([, property]) => property.description?.includes("default 20"))
				.map(([key]) => `${tool.name}.${key}`),
		);
		assert.deepStrictEqual(offenders, []);
	});

	it("`mark_email_read` still declares `read` as a required boolean", async () => {
		// The new guard is a backstop for the paths that skip this gate — it
		// must not be an excuse to weaken the declaration external callers
		// rely on (see the gateway case above).
		const tool = TOOL_DEFINITIONS.find((t) => t.name === "mark_email_read")!;
		assert.deepStrictEqual(tool.parameters.required, ["id", "read"]);
		assert.deepStrictEqual(tool.parameters.properties.read, {
			type: "boolean",
			description: "true = mark as read, false = mark as unread",
		});
	});
});
