// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression guards for `POST /api/v1/mailboxes` — address normalisation.
 *
 * ── The incident these cases pin ─────────────────────────────────────────
 *
 * "Create mailbox" answered `400 {"error":"Validation failed"}` for input the
 * user could see nothing wrong with: a local part COPIED from somewhere else
 * frequently carries a leading or trailing space, the dashboard pasted it into
 * `` `${localPart}@${domain}` `` verbatim, and the resulting
 * `" privacy@doforu.ai"` — an address no DNS-name regex can match — was
 * rejected by the handler's schema.
 *
 * Two layers were wrong, and both are guarded here:
 *
 *   1. the request-body schema normalised NOTHING, so whitespace survived all
 *      the way into the regex;
 *   2. the response named no field. The payload does carry `details[0].path`,
 *      but the form dropped it and showed one generic string, so the operator
 *      could not tell WHAT failed.
 *
 * The fix normalises the address (`z.string().trim().toLowerCase().regex(…)`)
 * and the handler stores/returns the normalised value — which is the same value
 * the mailbox id, the R2 object key and the D1 folder rows derive from.
 *
 * ── What is REAL here ────────────────────────────────────────────────────
 *
 * This is NOT a re-implementation of the schema. The app is imported from
 * `./index.ts` (via a `file://` URL — see `INDEX_MODULE_URL`) and driven through
 * `app.request()`, so each case runs the production middleware chain
 * (`/api/*` locale + cors, then `requireAuth`), the production route
 * registration and the production zod schema. Expectations are hard-coded
 * literals (`"privacy@doforu.ai"`, `"Validation failed"`, `["email"]`) rather
 * than anything re-derived from the module, so the file cannot agree with the
 * bug it is meant to catch.
 *
 * ── What is stubbed, and why that is still honest ────────────────────────
 *
 *   - `fetchWithTimeout` (via `mock.module`) — the only network primitive
 *     reachable from `index.ts`. The stub THROWS rather than answering: the
 *     create-mailbox path is supposed to be offline, so this doubles as a
 *     tripwire against a future refactor that starts calling out.
 *   - `env.BUCKET` — an in-memory R2 stand-in that RECORDS every `put`/`head`
 *     key, which is what the storage assertions are about.
 *   - `env.DB` — a hand-written D1 shim. Drizzle issues the session lookup
 *     through `db.prepare(...).bind(...).first()` and `initMailboxFolders`
 *     through `db.batch([...])`; the TEXT-protocol shim shared with
 *     `./setup-test-harness` does not model drizzle's query builder, so the
 *     statements are served here instead. What makes that acceptable is that
 *     the shim is VALIDATED, not trusted: the "session shim" block near the end
 *     proves the guarded path is only reached with a live session row AND the
 *     right cookie, that an expired row is refused, and that every rejected
 *     path leaves storage untouched.
 *
 * `node:sqlite` is REQUIRED (see the precondition block): its job is to
 * actually EXECUTE the folder batch, so the `folders` rows are asserted as real
 * SQL effects keyed by the normalised address rather than as a call count.
 * Without the engine every case is skipped via `sqliteSkip` — never a silent
 * pass.
 *
 * To run: npm test
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import { createSqlite, hasSqliteEngine, sqliteSkip } from "./setup-test-harness";

// ── Network stub (registered BEFORE ./index is imported) ────────────

const mockFetchWithTimeout = mock.fn(
	async (_url: string | URL, _options: RequestInit = {}): Promise<Response> => {
		throw new Error(
			"POST /api/v1/mailboxes must not perform a network call; this stub is a tripwire",
		);
	},
);

mock.module("./lib/fetch-with-timeout", {
	namedExports: { fetchWithTimeout: mockFetchWithTimeout },
});

/**
 * `workers/index.ts` exports `{ app, receiveEmail }` and no sub-app carrying
 * `POST /api/v1/mailboxes`, so the app plus a session cookie is the only way to
 * drive the real handler.
 *
 * The `file://` URL matters: under `node --test <file>` a bare `"./index"`
 * specifier resolves against the process CWD and dies with
 * ERR_MODULE_NOT_FOUND. `pathToFileURL` keeps it anchored to THIS file however
 * the runner was invoked.
 */
const INDEX_MODULE_URL = pathToFileURL(new URL("./index.ts", import.meta.url).pathname).href;

/** The REAL Hono app — real routes, real middleware, real zod schema. */
const { app } = (await import(/* @vite-ignore */ INDEX_MODULE_URL)) as {
	app: {
		request(path: string, init?: RequestInit, env?: unknown): Promise<Response>;
		fetch(request: Request, env?: unknown): Promise<Response>;
	};
};

// ── Constants ───────────────────────────────────────────────────────

/** The identity every accepted input must collapse to. */
const NORMALISED_ID = "privacy@doforu.ai";
/** The normalised R2 key: `mailboxes/${email}.json`, per the route. */
const NORMALISED_KEY = `mailboxes/${NORMALISED_ID}.json`;
/** `requireAuth` reads exactly this cookie (workers/lib/auth.ts, AUTH_COOKIE). */
const SESSION_COOKIE = "mailboxes_session";
const SESSION_TOKEN = "session-token-under-test";
/** English copy from shared/i18n/locales/en/api.json. */
const VALIDATION_FAILED = "Validation failed";
/** The six folders the route seeds, as written to D1. */
const EXPECTED_FOLDERS = ["archive", "draft", "inbox", "sent", "spam", "trash"];

// ── Bindings ────────────────────────────────────────────────────────

type SessionRow = { token: string; created_at: string; expires_at: string } | null;

type Recorded = {
	/** Every R2 key seen by `head`/`put`, in call order. */
	keys: string[];
	/** Every `put` key, in call order. */
	putKeys: string[];
	/** `mailbox_id` bound by the folder batch, or `null` if none ran. */
	folderMailboxId: string | null;
	/** Folder rows actually EXECUTED against the real engine (0 or 6). */
	folderRowsWritten: number;
	/** How many times the session store was consulted. */
	sessionLookups: number;
};

type Harness = {
	env: { DB: unknown; BUCKET: unknown };
	recorded: Recorded;
};

/**
 * A `D1PreparedStatement`-shaped object.
 *
 * `sql` and `values` are exposed as GETTERS, which is the load-bearing detail:
 * drizzle's `db.batch()` reads precisely those two properties off each
 * statement (`node_modules/drizzle-orm/d1/session.js`), and it only uses
 * `prepare(...).bind(...)` when the bound parameter list is non-empty — which
 * holds for `initMailboxFolders`. Add them as data properties and drizzle takes
 * a different branch, `batch()` receives six statements with no readable SQL,
 * and the folder assertions quietly degrade to no-ops.
 */
function makeStatement(sql: string, onQuery: () => SessionRow) {
	const statement = {
		_sql: sql,
		_values: [] as unknown[],
		bind(...args: unknown[]) {
			statement._values = args;
			return statement;
		},
		async first() {
			// `db.getSession` — the only `.first()` on this path.
			if (/FROM sessions/.test(sql)) return onQuery();
			return null;
		},
		async all() {
			return { results: [], success: true, meta: {} };
		},
		async run() {
			return { results: [], success: true, meta: { changes: 1 } };
		},
		async raw() {
			return [];
		},
	};
	Object.defineProperty(statement, "sql", { get: () => statement._sql });
	Object.defineProperty(statement, "values", { get: () => statement._values });
	return statement;
}

/** Insert a live `sessions` row through the harness's real SQLite helper. */
function insertSession(
	sqlite: ReturnType<typeof createSqlite>,
	token: string,
	expiresAt: Date,
): SessionRow {
	sqlite
		.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)")
		.run(token, new Date().toISOString(), expiresAt.toISOString());
	const row = sqlite
		.prepare("SELECT token, created_at, expires_at FROM sessions WHERE token = ?")
		.all(token)[0];
	return row ? (row as unknown as SessionRow) : null;
}

/**
 * Build the bindings for one request.
 *
 * Both modes answer the session lookup the same way; they differ in whether the
 * folder batch is EXECUTED:
 *
 *   - `{ sessionRow }` — lookup answered from a plain object, batch counted but
 *     not run. Used where the case is about R2 keys or validation.
 *   - `{ sqlite, token }` — lookup read back out of the real engine and the six
 *     folder rows executed for real, so the ids in `folders` are the product of
 *     genuine SQL. Used by the two cases that assert D1 contents.
 *
 * `sessionRow: null` means "this token is not in the store" — the negative
 * control that keeps the whole file from passing on a bypassed guard.
 */
function createHarness(
	options: { sessionRow: SessionRow } | { sqlite: ReturnType<typeof createSqlite>; token: string },
): Harness {
	const recorded: Recorded = {
		keys: [],
		putKeys: [],
		folderMailboxId: null,
		folderRowsWritten: 0,
		sessionLookups: 0,
	};

	const sqlite = "sqlite" in options ? options.sqlite : undefined;
	const sessionRow =
		"sessionRow" in options
			? options.sessionRow
			: insertSession(options.sqlite, options.token, new Date(Date.now() + 3_600_000));

	const db = {
		prepare: (sql: string) => makeStatement(sql, () => {
			recorded.sessionLookups += 1;
			return sessionRow;
		}),
		async batch(statements: Array<{ sql?: string; values?: unknown[] }>) {
			// `db.batch()` consumes the SAME prepared statements this shim handed
			// out, reading `sql` / `values` off each one. Note that the statements
			// reached this point through `db.insert(folders).values(…)
			// .onConflictDoNothing()` — i.e. a real drizzle query built against the
			// production `schema.ts` — so the SQL/parameters inspected below are
			// generated by drizzle, not by this file.
			for (const statement of statements) {
				const sql = String(statement.sql ?? "");
				const bound = statement.values ?? [];
				if (!/folders/.test(sql)) continue;
				if (recorded.folderMailboxId === null) {
					recorded.folderMailboxId = String(bound[0]);
				}
				if (sqlite) {
					// D1 numbers its placeholders (`?1`…`?4`); node:sqlite does not.
					sqlite
						.prepare(sql.replace(/\?\d/g, "?"))
						.run(...(bound as never[]));
					recorded.folderRowsWritten += 1;
				}
			}
			return statements.map(() => ({ results: [], success: true, meta: { changes: 1 } }));
		},
		async exec() {
			return { count: 0, duration: 0 };
		},
	};

	const bucket = {
		async head(key: string) {
			recorded.keys.push(key);
			return null;
		},
		async put(key: string, _value: unknown) {
			recorded.keys.push(key);
			recorded.putKeys.push(key);
			return { key };
		},
		async get() {
			return null;
		},
		async delete() {},
		async list() {
			return { objects: [], truncated: false };
		},
	};

	return { env: { DB: db, BUCKET: bucket }, recorded };
}

/** A harness whose session store holds one live row for `SESSION_TOKEN`. */
function authedHarness(): Harness {
	return createHarness({
		sessionRow: {
			token: SESSION_TOKEN,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		},
	});
}

// ── Request driver ──────────────────────────────────────────────────

type CreateResult = {
	status: number;
	body: Record<string, unknown>;
	text: string;
	recorded: Recorded;
};

/**
 * POST a body to the REAL handler and report what the bindings saw.
 *
 * The cookie is written by name because `requireAuth` reads
 * `getCookie(c, "mailboxes_session")` verbatim — that is the contract being
 * honoured, not an implementation detail being sidestepped.
 */
async function postCreateMailbox(
	harness: Harness,
	body: unknown,
	options: { cookie?: string | null } = {},
): Promise<CreateResult> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (options.cookie !== null) {
		headers.Cookie = options.cookie ?? `${SESSION_COOKIE}=${SESSION_TOKEN}`;
	}

	const res = await app.request(
		"/api/v1/mailboxes",
		{ method: "POST", headers, body: JSON.stringify(body) },
		harness.env,
	);
	const text = await res.text();
	return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text, recorded: harness.recorded };
}

/** `details[].path` values, in order — the field names the dashboard reads. */
function detailsPaths(body: Record<string, unknown>): unknown[] {
	const details = body.details;
	if (!Array.isArray(details)) {
		assert.fail(`expected a \`details\` array in ${JSON.stringify(body)}`);
	}
	return (details as Array<{ path?: unknown }>).map((detail) => detail.path);
}

/** The 201 contract every accepted address must satisfy. */
function assertCreated(result: CreateResult): void {
	assert.equal(
		result.status,
		201,
		`expected the mailbox to be created, got ${result.status}: ${result.text}`,
	);
	assert.equal(result.body.id, NORMALISED_ID, "the response id must be the normalised address");
	assert.equal(result.body.email, NORMALISED_ID, "the response email must be normalised too");
}

// ── 1-4. Every accepted form collapses to one identity ──────────────

describe("POST /api/v1/mailboxes — whitespace/case normalisation (real handler)", () => {
	it("accepts a canonical address unchanged, answering 201", { skip: sqliteSkip }, async () => {
		// The control case: normalisation must be a NO-OP for input that is
		// already clean, so a "fix" that rewrote clean addresses fails here.
		const result = await postCreateMailbox(authedHarness(), {
			email: "privacy@doforu.ai",
			name: "Info",
		});

		assertCreated(result);
		assert.equal(result.body.name, "Info");
	});

	it("accepts a LEADING space and stores the trimmed id", { skip: sqliteSkip }, async () => {
		// THE regression case. Before the fix this was `400 Validation failed`:
		// the schema matched the regex against the raw `" privacy@doforu.ai"`,
		// which no anchored pattern can accept.
		const result = await postCreateMailbox(authedHarness(), {
			email: " privacy@doforu.ai",
			name: "Info",
		});

		assertCreated(result);
	});

	it("accepts a TRAILING space and stores the trimmed id", { skip: sqliteSkip }, async () => {
		const result = await postCreateMailbox(authedHarness(), {
			email: "privacy@doforu.ai ",
			name: "Info",
		});

		assertCreated(result);
	});

	it("accepts surrounding space PLUS mixed case and normalises both", { skip: sqliteSkip }, async () => {
		// Both normalisations at once — the shape a paste out of a mail client
		// or a spreadsheet actually produces.
		const result = await postCreateMailbox(authedHarness(), {
			email: " Privacy@Doforu.AI ",
			name: "Info",
		});

		assertCreated(result);
	});
});

// ── 5. The `+` limitation is documented, not silently accepted ──────

describe("POST /api/v1/mailboxes — addresses the schema still rejects", () => {
	it("still rejects a plus-tagged address, with details[0].path === ['email']", { skip: sqliteSkip }, async () => {
		// KNOWN LIMITATION — pre-existing, and NOT the target of the
		// normalisation fix. The character class is `[a-z0-9.*_-]`, which has no
		// room for `+`, so `privacy+tag@…` is refused even though sub-addressing
		// is legal in the wild.
		//
		// What this case pins is the DIAGNOSTIC, not the rejection: the body
		// must keep naming the offending field, because that is what the
		// dashboard reads to surface `errorInvalidEmail` instead of the bare
		// "Validation failed" that started the incident. Widening the character
		// class is a separate decision with its own UX and data consequences,
		// and doing it here would be a behaviour change dressed up as a test fix.
		const result = await postCreateMailbox(authedHarness(), {
			email: "privacy+tag@doforu.ai",
			name: "Info",
		});

		assert.equal(result.status, 400);
		assert.equal(result.body.error, VALIDATION_FAILED);
		assert.deepEqual(detailsPaths(result.body), [["email"]]);
	});
});

// ── 6. Storage and D1 receive the normalised identity ───────────────

describe("POST /api/v1/mailboxes — the normalised identity is what gets stored", () => {
	it("writes exactly mailboxes/privacy@doforu.ai.json, and no key contains whitespace", { skip: sqliteSkip }, async () => {
		// The other half of the incident: a normalised RESPONSE with a
		// whitespace-bearing KEY would leave the mailbox unreachable, since the
		// inbound path looks it up by the address rather than by what was typed.
		const result = await postCreateMailbox(authedHarness(), {
			email: " privacy@doforu.ai ",
			name: "Info",
		});

		assertCreated(result);
		assert.deepEqual(result.recorded.putKeys, [NORMALISED_KEY]);

		// Belt and braces: EVERY key the handler touched (`head` included) must
		// be whitespace-free, so a "head with the raw value, put with the
		// trimmed one" split personality cannot slip through.
		for (const key of result.recorded.keys) {
			assert.doesNotMatch(
				key,
				/\s/,
				`a whitespace-bearing R2 key reached the bucket: ${JSON.stringify(key)}`,
			);
		}
	});

	it("keys the six default folders by the NORMALISED mailbox id", { skip: sqliteSkip }, async () => {
		// The folder rows are the durable copy of the mailbox id. They go
		// through drizzle's `db.batch()` into a real SQLite engine here, so this
		// is an actual SQL effect rather than a call count.
		const sqlite = createSqlite();
		const harness = createHarness({ sqlite, token: SESSION_TOKEN });
		const result = await postCreateMailbox(harness, {
			email: " Privacy@Doforu.AI ",
			name: "Info",
		});

		assertCreated(result);
		assert.equal(
			result.recorded.folderMailboxId,
			NORMALISED_ID,
			"the folder batch must be keyed by the trimmed, lower-cased address",
		);
		assert.equal(
			result.recorded.folderRowsWritten,
			6,
			"all six default folders must have been executed against the engine",
		);

		const folders = sqlite
			.prepare("SELECT id FROM folders WHERE mailbox_id = ? ORDER BY id")
			.all(NORMALISED_ID) as Array<{ id: string }>;
		assert.deepEqual(
			folders.map((row) => row.id),
			EXPECTED_FOLDERS,
			"the rows must be found under the normalised address and nowhere else",
		);

		// …and the raw, whitespace-bearing address seeded nothing.
		const rawRows = sqlite
			.prepare("SELECT id FROM folders WHERE mailbox_id = ?")
			.all(" Privacy@Doforu.AI ") as Array<{ id: string }>;
		assert.deepEqual(rawRows, []);
	});
});

// ── 7. Normalising `email` did not loosen anything else ─────────────

describe("POST /api/v1/mailboxes — the rest of the body is still validated", () => {
	it("still requires a name, with details[0].path === ['name']", { skip: sqliteSkip }, async () => {
		// `name` has no default and no fallback in the schema. Trimming must not
		// have turned into "make everything optional": `email` is the only field
		// that gained a normaliser.
		const result = await postCreateMailbox(authedHarness(), { email: "privacy@doforu.ai" });

		assert.equal(result.status, 400);
		assert.equal(result.body.error, VALIDATION_FAILED);
		assert.deepEqual(detailsPaths(result.body), [["name"]]);
	});

	it("still rejects an empty name, with details[0].path === ['name']", { skip: sqliteSkip }, async () => {
		const result = await postCreateMailbox(authedHarness(), {
			email: "privacy@doforu.ai",
			name: "",
		});

		assert.equal(result.status, 400);
		assert.deepEqual(detailsPaths(result.body), [["name"]]);
	});

	it("still rejects an address with an INTERNAL space, with details[0].path === ['email']", { skip: sqliteSkip }, async () => {
		// `trim()` removes surrounding whitespace only. A space inside the
		// address stays invalid — normalisation must not be mistaken for a
		// sanitiser that silently repairs genuinely malformed input.
		const result = await postCreateMailbox(authedHarness(), {
			email: "pri vacy@doforu.ai",
			name: "Info",
		});

		assert.equal(result.status, 400);
		assert.deepEqual(detailsPaths(result.body), [["email"]]);
	});
});

// ── The session shim is a guard, not a bypass ───────────────────────

describe("POST /api/v1/mailboxes — the session shim behaves like the real guard", () => {
	it("rejects a request with NO cookie, without consulting the session store", { skip: sqliteSkip }, async () => {
		const result = await postCreateMailbox(
			authedHarness(),
			{ email: NORMALISED_ID, name: "Info" },
			{ cookie: null },
		);

		assert.equal(result.status, 401);
		assert.equal(
			result.recorded.sessionLookups,
			0,
			"an anonymous request must not be looked up in the session store",
		);
		assert.deepEqual(result.recorded.putKeys, [], "a rejected request must write nothing to R2");
	});

	it("rejects a token that is not in the store", { skip: sqliteSkip }, async () => {
		// The shim answers "no such session" here, which is what proves the
		// green cases above are not green because the guard was bypassed.
		const harness = createHarness({ sessionRow: null });
		const result = await postCreateMailbox(harness, { email: NORMALISED_ID, name: "Info" });

		assert.equal(result.status, 401);
		assert.equal(result.recorded.sessionLookups, 1, "the presented token must be looked up");
		assert.deepEqual(result.recorded.putKeys, []);
	});

	it("rejects an EXPIRED session row (written and read back through SQLite)", { skip: sqliteSkip }, async () => {
		const sqlite = createSqlite();
		const row = insertSession(sqlite, SESSION_TOKEN, new Date(Date.now() - 60_000));
		assert.ok(row, "the expired row must exist for the case to be meaningful");

		const harness = createHarness({ sessionRow: row });
		const result = await postCreateMailbox(harness, { email: NORMALISED_ID, name: "Info" });

		assert.equal(result.status, 401);
		assert.deepEqual(result.recorded.putKeys, [], "an expired session must not create a mailbox");
		assert.equal(result.recorded.folderMailboxId, null, "and must not seed folders");
		assert.equal(result.recorded.folderRowsWritten, 0);
	});
});

// ── Preconditions ───────────────────────────────────────────────────
//
// A false green here would mean the cases above silently stopped covering
// something, so the engine, the mount and the recording are asserted directly
// instead of being inferred from the suite passing.

describe("create-mailbox normalisation preconditions", () => {
	it("has a usable SQLite engine (no silent skip)", async () => {
		assert.equal(hasSqliteEngine(), true, "these guards need node:sqlite (Node >= 22)");
		assert.equal(sqliteSkip, false);
	});

	it("mounted the real index app, not a copy", () => {
		assert.equal(typeof app.request, "function");
		assert.equal(typeof app.fetch, "function");
	});

	it("is offline: the create path makes no outbound request", { skip: sqliteSkip }, async () => {
		// `mockFetchWithTimeout` throws on ANY use, so reaching 201 proves the
		// route stayed offline end to end.
		const before = mockFetchWithTimeout.mock.callCount();
		const result = await postCreateMailbox(authedHarness(), {
			email: NORMALISED_ID,
			name: "Info",
		});

		assertCreated(result);
		assert.equal(mockFetchWithTimeout.mock.callCount(), before, "no outbound request may be made");
	});

	it("records R2 keys, so the storage assertions cannot be vacuous", { skip: sqliteSkip }, async () => {
		// If `put` ever stopped recording, "no key contains whitespace" would
		// iterate an empty list and pass while proving nothing.
		const result = await postCreateMailbox(authedHarness(), {
			email: NORMALISED_ID,
			name: "Info",
		});

		assertCreated(result);
		assert.deepEqual(result.recorded.keys, [NORMALISED_KEY, NORMALISED_KEY], "head then put");
	});

	it("sees the folder batch, so the id assertions cannot be vacuous", { skip: sqliteSkip }, async () => {
		// Mirrors the case above for the SQL side: an empty/renamed batch would
		// make `folderMailboxId` null rather than silently right.
		const sqlite = createSqlite();
		const result = await postCreateMailbox(createHarness({ sqlite, token: SESSION_TOKEN }), {
			email: NORMALISED_ID,
			name: "Info",
		});

		assertCreated(result);
		assert.equal(result.recorded.folderMailboxId, NORMALISED_ID);
		assert.equal(result.recorded.folderRowsWritten, 6);
	});
});
