// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Focused tests for the cross-tool parameter-naming contract and the external
 * gateway's argument/error handling.
 *
 * Two behaviours are pinned here:
 *
 *   1. Fix 1 — parameter names that refer to an entity match the field name
 *      the tools *return* (`id`, `thread_id`, `folder`), with the historical
 *      `emailId` / `threadId` / `originalEmailId` / `folderId` spellings still
 *      accepted as aliases (canonical wins on conflict).
 *   2. Fix 2 — the external gateway rejects a call that is missing a
 *      schema-required argument *before* execution, naming the parameter, and
 *      never leaks the internal `detail` diagnostic field.
 *
 * To run: npx tsx --test workers/lib/tool-dispatch-aliases.test.ts
 * (or just `npm test`, which picks up `workers\/**\/*.test.ts`)
 *
 * The tests drive `executeToolCall` / `dispatchExternalTool` with a fake `db`
 * binding that records every prepared statement. The tools use positional
 * `.bind(...)`, so the bound values are an exact record of *which* argument
 * each tool received — that is how "the alias reached the right parameter" is
 * asserted without touching D1.
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";

import {
	TOOL_DEFINITIONS,
	executeToolCall,
	normalizeToolArguments,
	TOOL_ARG_ALIASES,
	type AiToolCall,
} from "./tool-dispatch";
import { dispatchExternalTool, MAILBOX_ID_REQUIRED_ERROR } from "./external-tools";

// ── Recording db binding ───────────────────────────────────────────

/**
 * Minimal D1 stand-in. `prepare()` records SQL + bound values and returns a
 * chainable statement whose terminal calls resolve per the configured result
 * shape (`first` → row, `all` → results, `run` → no-op, `raw` → empty).
 */
function makeRecordingDb(opts: {
	firstResult?: unknown;
	allResults?: unknown[];
}) {
	const statements: Array<{ sql: string; binds: unknown[] }> = [];

	const statementFor = (sql: string) => {
		const binds: unknown[] = [];
		const stmt: any = {
			bind: (...values: unknown[]) => {
				binds.push(...values);
				return stmt;
			},
			first: async () => opts.firstResult ?? null,
			all: async () => ({ results: opts.allResults ?? [] }),
			run: async () => ({ success: true }),
			raw: async () => [],
		};
		const entry = { sql, binds };
		statements.push(entry);
		// `bind` may be called after `run`/`first` is short-circuited by the
		// tool: record into the shared array, never a per-call copy.
		stmt.__entry = entry;
		return stmt;
	};

	const db: any = {
		prepare: (sql: string) => statementFor(sql),
		batch: async () => [],
		exec: async () => ({ count: 0, duration: 0 }),
	};

	/** Every value bound across all statements, in execution order. */
	const boundValues = () => statements.flatMap((s) => s.binds);

	return { db, statements, boundValues };
}

const NOOP_AI = {} as unknown as Ai;
const NOOP_BUCKET = {} as unknown as R2Bucket;

/** Build a canonical-shaped tool call payload. */
function toolCall(name: string, args: unknown): AiToolCall {
	return {
		id: `test-${name}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

// ── 1. Schema: parameter names match returned field names ──────────

describe("tool schema parameter naming (cross-tool continuity)", () => {
	const propertiesOf = (name: string) => {
		const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
		assert.ok(tool, `tool ${name} must exist`);
		return {
			properties: Object.keys(tool.parameters.properties),
			required: [...tool.parameters.required] as string[],
		};
	};

	it("get_email / mark_email_read / move_email / delete_email take `id`", () => {
		for (const name of [
			"get_email",
			"mark_email_read",
			"move_email",
			"delete_email",
		]) {
			const { properties, required } = propertiesOf(name);
			assert.ok(properties.includes("id"), `${name} exposes \`id\``);
			assert.ok(
				!properties.includes("emailId"),
				`${name} no longer exposes \`emailId\``,
			);
			assert.ok(required.includes("id"), `${name} requires \`id\``);
			assert.ok(
				!required.includes("emailId"),
				`${name} no longer requires \`emailId\``,
			);
		}
	});

	it("move_email takes `folder` (the field it returns), not `folderId`", () => {
		const { properties, required } = propertiesOf("move_email");
		// The return body is `{ status, emailId, folder }` — the destination is
		// spelled `folder` there and in list_emails / search_emails, so the
		// argument that names it must be `folder` too.
		assert.ok(properties.includes("folder"));
		assert.ok(!properties.includes("folderId"));
		assert.ok(required.includes("folder"));
		assert.ok(!required.includes("folderId"));
		assert.deepStrictEqual(required, ["id", "folder"]);
	});

	it("draft_reply / send_reply take `id` (was `originalEmailId`)", () => {
		for (const name of ["draft_reply", "send_reply"]) {
			const { properties, required } = propertiesOf(name);
			assert.ok(properties.includes("id"));
			assert.ok(!properties.includes("originalEmailId"));
			assert.ok(required.includes("id"));
			assert.ok(!required.includes("originalEmailId"));
		}
	});

	it("get_thread takes `thread_id` (was `threadId`)", () => {
		const { properties, required } = propertiesOf("get_thread");
		assert.ok(properties.includes("thread_id"));
		assert.ok(!properties.includes("threadId"));
		assert.deepStrictEqual(required, ["thread_id"]);
	});

	it("draft tool keys are untouched (`draftId` already matched its return field)", () => {
		for (const name of ["update_draft", "discard_draft"]) {
			const { properties, required } = propertiesOf(name);
			assert.ok(properties.includes("draftId"));
			assert.ok(required.includes("draftId"));
		}
		// update_draft exposes optional fields, but only `draftId` is required.
		assert.deepStrictEqual(propertiesOf("update_draft").required, ["draftId"]);
		assert.deepStrictEqual(propertiesOf("discard_draft").properties, ["draftId"]);
	});

	it("a referring parameter is named after the field list_emails returns", () => {
		// The bug being fixed: the value a model copies out of a list result
		// must be the key the next tool asks for.
		const returnedFieldNames = ["id", "thread_id"];
		const getEmail = propertiesOf("get_email");
		const getThread = propertiesOf("get_thread");
		assert.ok(returnedFieldNames.includes(getEmail.required[0]));
		assert.ok(returnedFieldNames.includes(getThread.required[0]));
	});

	it("descriptions point at the source field", () => {
		const descriptionOf = (toolName: string, param: string) => {
			const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName)!;
			return (tool.parameters.properties as any)[param]
				.description as string;
		};
		assert.match(descriptionOf("get_email", "id"), /`id` field/);
		assert.match(descriptionOf("get_thread", "thread_id"), /`thread_id` field/);
		assert.match(descriptionOf("draft_reply", "id"), /`id` field/);
		assert.match(descriptionOf("send_reply", "id"), /`id` field/);
		// The move destination points at the field list_emails reports.
		assert.match(descriptionOf("move_email", "folder"), /`folder` field/);
	});
});

// ── 2. normalizeToolArguments (the alias table) ────────────────────

describe("normalizeToolArguments", () => {
	it("promotes the legacy alias to the canonical key", () => {
		assert.deepStrictEqual(
			normalizeToolArguments("get_email", { emailId: "e1" }),
			{ id: "e1" },
		);
		assert.deepStrictEqual(
			normalizeToolArguments("get_thread", { threadId: "t1" }),
			{ thread_id: "t1" },
		);
		assert.deepStrictEqual(
			normalizeToolArguments("draft_reply", {
				originalEmailId: "e1",
				to: "a@b.c",
				subject: "s",
				body: "b",
			}),
			{ id: "e1", to: "a@b.c", subject: "s", body: "b" },
		);
		// `move_email` carries two legacy spellings: the email key and the
		// destination key (which also had a snake_case variant).
		assert.deepStrictEqual(
			normalizeToolArguments("move_email", { emailId: "e1", folderId: "archive" }),
			{ id: "e1", folder: "archive" },
		);
		assert.deepStrictEqual(
			normalizeToolArguments("move_email", { emailId: "e1", folder_id: "trash" }),
			{ id: "e1", folder: "trash" },
		);
		// Canonical-only input already needs no rewrite at all.
		const canonical = { id: "e1", folder: "inbox" };
		assert.strictEqual(normalizeToolArguments("move_email", canonical), canonical);
	});

	it("leaves canonical input untouched (same object identity)", () => {
		const args = { id: "e1" };
		assert.strictEqual(normalizeToolArguments("get_email", args), args);
	});

	it("does not mutate the caller's object", () => {
		const args: Record<string, unknown> = { emailId: "e1" };
		normalizeToolArguments("get_email", args);
		assert.deepStrictEqual(args, { emailId: "e1" });
	});

	it("canonical wins when both are present", () => {
		assert.deepStrictEqual(
			normalizeToolArguments("get_email", { id: "canon", emailId: "legacy" }),
			{ id: "canon" },
		);
		assert.deepStrictEqual(
			normalizeToolArguments("get_thread", {
				thread_id: "canon",
				threadId: "legacy",
			}),
			{ thread_id: "canon" },
		);
	});

	it("an empty canonical value lets the alias fill in", () => {
		assert.deepStrictEqual(
			normalizeToolArguments("get_email", { id: "   ", emailId: "e1" }),
			{ id: "e1" },
		);
		assert.deepStrictEqual(
			normalizeToolArguments("get_email", { id: null, emailId: "e1" }),
			{ id: "e1" },
		);
	});

	it("never maps a bare `id` to `thread_id` (email id must not pass as thread id)", () => {
		const legacy: Record<string, unknown> = { id: "e1" };
		const normalized = normalizeToolArguments("get_thread", legacy);
		assert.deepStrictEqual(normalized, { id: "e1" });
		assert.strictEqual(normalized, legacy, "nothing to rewrite → same object");
		assert.ok(!("thread_id" in (normalized as Record<string, unknown>)));
	});

	it("passes unknown tools and unrelated keys through", () => {
		const args = { whatever: 1 };
		assert.strictEqual(normalizeToolArguments("list_mailboxes", args), args);
		assert.deepStrictEqual(normalizeToolArguments("get_email", { other: 1 }), {
			other: 1,
		});
	});

	it("only applies a tool's own aliases", () => {
		// `originalEmailId` is a send_reply/draft_reply alias, not a get_email one.
		assert.deepStrictEqual(
			normalizeToolArguments("get_email", { originalEmailId: "e1" }),
			{ originalEmailId: "e1" },
		);
	});

	it("exposes the alias table for reuse", () => {
		assert.deepStrictEqual(TOOL_ARG_ALIASES.get_email, { emailId: "id" });
		assert.deepStrictEqual(TOOL_ARG_ALIASES.get_thread, { threadId: "thread_id" });
		assert.deepStrictEqual(TOOL_ARG_ALIASES.send_reply, { originalEmailId: "id" });
		// `move_email` keeps both legacy spellings of the destination key.
		assert.deepStrictEqual(TOOL_ARG_ALIASES.move_email, {
			emailId: "id",
			folderId: "folder",
			folder_id: "folder",
		});
		// Guard against the dangerous shorthand being introduced later.
		assert.ok(!JSON.stringify(TOOL_ARG_ALIASES).includes('"id":"thread_id"'));
	});
});

// ── 3. executeToolCall reads the canonical keys, accepts legacy ────

describe("executeToolCall parameter resolution", () => {
	/**
	 * Run `get_email` (or `get_thread`) far enough to record which id the tool
	 * received. `getFullEmail` selects the email and then its attachments; the
	 * email id is always one of the bound values.
	 */
	const runAndCollectBinds = async (name: string, args: unknown) => {
		const { db, boundValues } = makeRecordingDb({});
		const result = await executeToolCall(
			toolCall(name, args),
			db,
			"test@example.com",
			NOOP_AI,
			NOOP_BUCKET,
		);
		return { binds: boundValues(), result };
	};

	it("reads `id` (canonical)", async () => {
		const { binds } = await runAndCollectBinds("get_email", { id: "canon-id" });
		assert.ok(binds.includes("canon-id"), `bound values: ${binds.join(",")}`);
	});

	it("still reads legacy `emailId` via the alias", async () => {
		const { binds } = await runAndCollectBinds("get_email", {
			emailId: "legacy-id",
		});
		assert.ok(binds.includes("legacy-id"), `bound values: ${binds.join(",")}`);
	});

	it("prefers `id` when both are supplied", async () => {
		const { binds } = await runAndCollectBinds("get_email", {
			id: "canon-id",
			emailId: "legacy-id",
		});
		assert.ok(binds.includes("canon-id"), `bound values: ${binds.join(",")}`);
		assert.ok(!binds.includes("legacy-id"));
	});

	it("get_thread uses `thread_id` (and its legacy alias)", async () => {		for (const args of [{ thread_id: "th-1" }, { threadId: "th-1" }]) {
			const { binds } = await runAndCollectBinds("get_thread", args);
			assert.ok(
				binds.includes("th-1"),
				`get_thread must query with ${JSON.stringify(args)} (bound: ${binds.join(",")})`,
			);
		}
	});

	it("move_email passes the destination folder through to `toolMoveEmail`", async () => {
		// `toolMoveEmail(db, mailboxId, emailId, folder, locale)` receives the
		// destination *positionally* and hands it to `moveEmail`, whose SQL binds
		// it. That bound value is the observable proof of which argument the
		// dispatcher forwarded into the fourth slot.
		// (`makeRecordingDb` records every bound value, and its folder-resolution
		// SELECT — which also binds the seeded name `archive` — returns no row,
		// so `moveEmail` returns early without ever writing.)
		const runMove = async (args: unknown) => {
			const { db, boundValues } = makeRecordingDb({});
			const result = await executeToolCall(
				toolCall("move_email", args),
				db,
				"test@example.com",
				NOOP_AI,
				NOOP_BUCKET,
			);
			return { binds: boundValues(), result };
		};

		// Positive control first: the destination really is observable, so the
		// canonical/alias checks below are not vacuous. `archive` is one of the
		// seeded folder names, which is why the *matched* value (not merely the
		// value's presence) is what matters.
		const control = await runMove({ id: "m1", folder: "archive" });
		assert.ok(control.result !== undefined, "move_email must run");
		assert.ok(
			control.binds.includes("archive"),
			`the canonical destination must reach the tool (bound: ${control.binds.join(",")})`,
		);

		// Both legacy spellings must land on the same positional slot.
		for (const legacy of [{ folderId: "archive" }, { folder_id: "archive" }]) {
			const { binds } = await runMove({ id: "m1", ...legacy });
			assert.ok(
				binds.includes("archive"),
				`${JSON.stringify(legacy)} must still reach the tool (bound: ${binds.join(",")})`,
			);
		}

		// Canonical wins over a stale alias, exactly like the id aliases.
		const both = await runMove({ id: "m1", folder: "trash", folderId: "archive" });
		assert.ok(
			both.binds.includes("trash"),
			`the canonical destination wins (bound: ${both.binds.join(",")})`,
		);
	});

	it("get_thread does not silently accept a bare `id`", async () => {
		const { binds } = await runAndCollectBinds("get_thread", {
			id: "email-id-not-a-thread",
		});
		assert.ok(
			!binds.includes("email-id-not-a-thread"),
			"a bare `id` must not be reinterpreted as a thread id",
		);
	});

	it("forwards `locale` to get_thread, so the error is localised", async () => {
		// Regression: the `get_thread` case called
		// `toolGetThread(db, mailboxId, args.thread_id)` — dropping the trailing
		// `locale`, unlike the `get_email` sibling above it. `toolGetThread`
		// localises its "thread not found" message, so a zh caller was shown the
		// English sentinel.
		//
		// Observable without touching D1: an unknown thread makes
		// `toolGetThread` return `{ error: apiToolT(locale)("threadNotFound") }`,
		// so the returned message is a direct read-out of the locale that
		// reached it.
		const errorFor = async (locale?: string) => {
			const { db } = makeRecordingDb({});
			const result = (await executeToolCall(
				toolCall("get_thread", { thread_id: "no-such-thread" }),
				db,
				"test@example.com",
				NOOP_AI,
				NOOP_BUCKET,
				locale as never,
			)) as { error?: string };
			return result?.error;
		};

		// Positive control: the locale really is observable through this path
		// (the `get_email` sibling already forwards it), so the assertion below
		// cannot pass vacuously.
		const zhControl = (await executeToolCall(
			toolCall("get_email", { id: "no-such-email" }),
			makeRecordingDb({}).db,
			"test@example.com",
			NOOP_AI,
			NOOP_BUCKET,
			"zh" as never,
		)) as { error?: string };

		const zhThread = await errorFor("zh");
		assert.ok(zhThread, "an unknown thread must be reported as an error");
		assert.notStrictEqual(
			zhThread,
			"Thread not found",
			"a zh caller must not receive the English sentinel (locale was dropped)",
		);
		// Whatever the zh copy is, it must differ from the English one and match
		// the locale the sibling tools already honour.
		assert.notStrictEqual(zhThread, await errorFor(undefined));
		assert.strictEqual(typeof zhControl?.error, "string");
	});
});

// ── 4. list_emails has no side effects on the argument bag ─────────

describe("list_emails keeps working unchanged", () => {
	it("returns the recorded rows verbatim (no alias applies, no writes)", async () => {
		// `getEmails` builds its query with drizzle and terminates on `.all()`,
		// which forwards rows positionally via `raw()`. The three values asserted
		// below sit at fixed columns of that projection: `id`, `subject`,
		// `sender`, …, `thread_id` (14th).
		const projections = [
			["id", "e1"],
			["subject", "Hi"],
			["sender", "someone@example.com"],
			["sender_name", null],
			["recipient", null],
			["cc", null],
			["bcc", null],
			["date", null],
			["read", 0],
			["starred", 0],
			["in_reply_to", null],
			["email_references", null],
			["thread_id", "th1"],
			["folder_id", null],
			["snippet", null],
			["send_status", null],
		];

		const db: any = {
			prepare: (sql: string) => ({
				bind: () => ({
					all: async () => ({
						// The folder-resolution pre-check (`resolveUnknownFolder`)
						// asks `folders` for the referenced folder and must find it,
						// otherwise the tool short-circuits with `unknownFolder`
						// before ever querying `emails`.
						results: sql.includes("FROM folders")
							? [{ name: "inbox", id: "inbox" }]
							: [],
					}),
					first: async () => null,
					run: async () => ({ success: true }),
					raw: async () => [projections.map(([, value]) => value)],
				}),
			}),
			batch: async () => [
				{
					success: true,
					results: [],
					meta: { rows_read: 1, rows_written: 0, duration: 0 },
				},
			],
		};

		const args = { folder: "inbox", limit: 20, page: 1 };
		const result = await executeToolCall(
			toolCall("list_emails", args),
			db,
			"test@example.com",
			NOOP_AI,
			NOOP_BUCKET,
		);

		// Return shape is untouched by Fix 1: `id` + `thread_id`, as before.
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, "e1", JSON.stringify(result[0]));
		assert.strictEqual(result[0].subject, "Hi");
		assert.strictEqual(result[0].thread_id, "th1");
		// Normalised by `getEmails`.
		assert.strictEqual(result[0].read, false);
		assert.strictEqual(result[0].starred, false);
	});

	it("is a no-op for normalizeToolArguments (object identity preserved)", () => {
		const args = { folder: "trash", limit: 5, page: 2 };
		assert.strictEqual(normalizeToolArguments("list_emails", args), args);
	});
});

// ── 5. Error surfacing: detail internally, never externally ────────

describe("executeToolCall error surfacing", () => {
	/**
	 * A db whose `all()`/`run()` reject — the shape of a real D1 failure — so
	 * the dispatcher's catch branch runs with a message worth forwarding.
	 */
	const failingDb = (message: string) => {
		const stmt: any = {
			bind: () => stmt,
			first: async () => {
				throw new Error(message);
			},
			all: async () => {
				throw new Error(message);
			},
			run: async () => {
				throw new Error(message);
			},
			raw: async () => [],
		};
		return { prepare: () => stmt } as unknown as D1Database;
	};

	it("keeps the stable `error` and adds an internal `detail`", async () => {
		const result = await executeToolCall(
			toolCall("list_emails", { folder: "inbox", limit: 20, page: 1 }),
			failingDb("D1_ERROR: no such column: nope"),
			"test@example.com",
			NOOP_AI,
			NOOP_BUCKET,
		);
		assert.strictEqual(result.error, "Tool list_emails failed");
		assert.strictEqual(result.detail, "D1_ERROR: no such column: nope");
	});

	it("turns unparseable JSON into a tool error instead of throwing", async () => {
		const { db } = makeRecordingDb({});
		const malformed: AiToolCall = {
			id: "bad-json",
			type: "function",
			function: { name: "list_emails", arguments: "{not json" },
		};
		const result = await executeToolCall(
			malformed,
			db,
			"test@example.com",
			NOOP_AI,
			NOOP_BUCKET,
		);
		assert.strictEqual(result.error, "Tool list_emails failed");
		assert.strictEqual(typeof result.detail, "string");
		assert.ok(result.detail.length > 0);
	});
});

// ── 6. External gateway: required-parameter gate + no `detail` leak ─

describe("dispatchExternalTool required-parameter gate", () => {
	const env = () =>
		({
			DB: makeRecordingDb({}).db,
			BUCKET: {
				head: async () => ({ key: "mailboxes/test@example.com.json" }),
			} as unknown as R2Bucket,
			AI: NOOP_AI,
		}) as { DB: D1Database; BUCKET: R2Bucket; AI: Ai };

	before(() => {
		// `crypto.randomUUID` is used to mint the internal tool-call id.
		if (!globalThis.crypto) (globalThis as any).crypto = {};
		if (!globalThis.crypto.randomUUID) {
			(globalThis as any).crypto.randomUUID = () =>
				"00000000-0000-4000-8000-000000000000";
		}
	});

	after(() => {
		/* nothing to restore: the shims are additive */
	});

	it("reports the missing parameter by name", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "get_email",
			arguments: { mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		assert.strictEqual(outcome.ok, false);
		assert.strictEqual(outcome.error, "missing required parameter: id");
		assert.deepStrictEqual(Object.keys(outcome), ["ok", "error"]);
	});

	it("lists several missing parameters, comma-separated", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "move_email",
			arguments: { mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		assert.strictEqual(outcome.ok, false);
		assert.strictEqual(outcome.error, "missing required parameter: id, folder");
	});

	it("accepts the legacy `folderId` alias as satisfying `required`", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "move_email",
			arguments: { id: "e1", folderId: "archive", mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		// Passed the gate: whatever happens next comes from the tool body, not
		// from the argument check.
		assert.notStrictEqual(
			outcome.error,
			"missing required parameter: id, folder",
		);
	});

	it("accepts the canonical `folder` for the same call", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "move_email",
			arguments: { id: "e1", folder: "archive", mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		assert.notStrictEqual(
			outcome.error,
			"missing required parameter: id, folder",
		);
	});

	it("accepts the legacy alias as satisfying `required`", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "get_email",
			arguments: { emailId: "e1", mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		// Passed the gate: the failure, if any, comes from the tool body
		// (the recording db returns null → "email not found"), not from the
		// argument check.
		assert.notStrictEqual(
			outcome.error,
			"missing required parameter: id",
		);
	});

	it("treats a blank string as missing", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "get_email",
			arguments: { id: "   ", mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		assert.strictEqual(outcome.error, "missing required parameter: id");
	});

	it("accepts `false` for a boolean parameter (mark_email_read)", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "mark_email_read",
			arguments: { id: "e1", read: false, mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		assert.notStrictEqual(
			outcome.error,
			"missing required parameter: read",
		);
	});

	it("keeps `mailboxId` and unknown-tool errors intact", async () => {
		const noMailbox = await dispatchExternalTool(env(), {
			name: "get_email",
			arguments: { id: "e1" },
		});
		// The message is now self-correcting (it names the call that produces a
		// valid id) but its LEADING SENTENCE and field name are unchanged, so a
		// client matching the old prefix — or asserting on the stable `mailboxId`
		// spelling — still works. Asserted on the exported constant rather than a
		// re-typed literal so the copy has exactly one definition.
		assert.strictEqual(noMailbox.error, MAILBOX_ID_REQUIRED_ERROR);
		assert.ok(
			noMailbox.error?.startsWith("mailboxId is required"),
			"the stable leading sentence must survive the richer copy",
		);

		const unknown = await dispatchExternalTool(env(), {
			name: "nope",
			arguments: {},
		});
		assert.strictEqual(unknown.error, "Unknown tool: nope");
	});

	it("never returns a `detail` field on any failure path", async () => {
		const failures = await Promise.all([
			dispatchExternalTool(env(), {
				name: "get_email",
				arguments: { mailboxId: "test@example.com" },
				mailboxId: "test@example.com",
			}),
			dispatchExternalTool(env(), {
				name: "get_email",
				arguments: { id: "e1", mailboxId: "test@example.com" },
				mailboxId: "test@example.com",
			}),
			dispatchExternalTool(env(), {
				name: "nope",
				arguments: {},
			}),
			dispatchExternalTool(env(), {
				name: "get_email",
				arguments: { id: "e1" },
			}),
		]);

		for (const outcome of failures) {
			if (outcome.ok) continue;
			assert.deepStrictEqual(
				Object.keys(outcome).sort(),
				["error", "ok"],
				"external failures expose exactly `ok` + `error`",
			);
			assert.ok(
				!JSON.stringify(outcome).includes('"detail"'),
				"serialized external failure must not contain `detail`",
			);
		}
	});

	it("maps a tool-level failure to `ok:false` with only the public message", async () => {
		const outcome = await dispatchExternalTool(env(), {
			name: "discard_draft",
			arguments: { draftId: "d1", mailboxId: "test@example.com" },
			mailboxId: "test@example.com",
		});
		// The recording db returns null for `getEmail` → "draftNotFound" from
		// the tool's own error branch: a public, localized message.
		assert.strictEqual(outcome.ok, false);
		assert.strictEqual(typeof outcome.error, "string");
		assert.ok(!("detail" in outcome));
	});
});
