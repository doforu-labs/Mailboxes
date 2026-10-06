// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Route-level guard for the tool gateway's discovery surface:
 * MCP `initialize` (`instructions`) and `GET /tools` (top-level `info`).
 *
 * ── Why these facts need a route test ───────────────────────────────────────
 * Both additions are JSON that a client reads ONCE, before it knows anything
 * else about the server, and neither is exercised by the tool-body suites:
 *
 *   • `initialize.instructions` is the only server-level self-description MCP
 *     has. Dropping it is silent — clients simply start calling tools with a
 *     guessed `mailboxId`, which is the exact failure the text exists to
 *     prevent.
 *   • `info` is a NEW top-level key sitting next to `tools`. The risk is not
 *     that it disappears (a caller would notice immediately) but that it is
 *     added by rewriting the `tools` array — a shape change to the payload
 *     every existing OpenAI-style caller already parses.
 *
 * The assertions below therefore pin BOTH halves: the new keys are present AND
 * the pre-existing shapes are untouched (`tools` still an array of
 * `{ type: "function", function: { name, description, parameters } }`, with no
 * MCP-only `annotations` on it).
 *
 * ── Real routes, real auth ──────────────────────────────────────────────────
 * The sub-app is mounted exactly as `../index.ts` mounts it
 * (`new Hono().route("/", agentApiRoute)`) and driven through `app.request()`.
 * Authentication is real too: the request carries an actual `agk_…` key whose
 * SHA-256 hash is present in a SQLite-backed `api_keys` table, so
 * `requireGlobalApiKey` runs its production lookup and the handlers run because
 * the key resolved — not because the middleware was bypassed.
 *
 * To run: npm test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { agentApiRoute } from "./agent-api";
import type { Env } from "../types";

// ── node:sqlite (optional engine) ───────────────────────────────────
//
// Loaded through a variable on purpose: a literal `import("node:sqlite")`
// fails type-checking under this repo's @types/node 20.x even though the
// runtime (Node >= 22) supports it. When the engine is missing these cases
// report as **skipped**, never as a silent pass.

const NODE_SQLITE_MODULE = "node:sqlite";

type SqliteRow = Record<string, unknown>;

type DatabaseSyncLike = new (path: string) => {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): SqliteRow[];
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

/**
 * Just the two tables `requireGlobalApiKey` touches: the key lookup it
 * authenticates with, and the audit row it writes afterwards (best-effort — a
 * failure there is swallowed, but a MISSING table would make every request log
 * an ignored error, so it is created for a clean run).
 *
 * The key itself is only ever checked by digest, so the seeded row carries the
 * SHA-256 hex and never the plaintext.
 */
const SCHEMA_SQL = `
	CREATE TABLE agent_api_keys (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		key_hash TEXT NOT NULL,
		prefix TEXT NOT NULL,
		scopes TEXT NOT NULL DEFAULT 'all',
		allowed_mailboxes TEXT,
		created_at TEXT NOT NULL,
		last_used_at TEXT,
		expires_at TEXT,
		revoked_at TEXT
	);
	CREATE TABLE agent_api_key_audit (
		id TEXT PRIMARY KEY,
		key_id TEXT NOT NULL,
		action TEXT NOT NULL,
		detail TEXT,
		created_at TEXT NOT NULL
	);
`;

/**
 * The plaintext key the request presents.
 *
 * Shaped exactly like a production key (`agk_` + 64 lowercase hex) because
 * `extractBearerToken` shape-checks the value BEFORE any lookup: a key of the
 * wrong family is rejected without touching the database, so a fixture with a
 * short key would make every case here fail at the parser and prove nothing
 * about the routes under test.
 */
const API_KEY = `agk_${"7f3c".repeat(16)}`;

/** SHA-256 hex, computed the way `api-key-utils` does. */
async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Drizzle / the D1 driver wrap bound values in `{ value }` parameter objects. */
function unwrapDriverValue(arg: unknown): unknown {
	if (arg !== null && typeof arg === "object" && "value" in (arg as object)) {
		return (arg as { value: unknown }).value;
	}
	return arg;
}

/**
 * A `D1Database` backed by a real SQLite engine, plus an `Env` carrying a key
 * row that matches {@link API_KEY}.
 */
async function createEnv(): Promise<{ env: Env; sqlite: InstanceType<DatabaseSyncLike> }> {
	const Ctor = DatabaseSyncCtor;
	if (!Ctor) throw new Error("node:sqlite unavailable");

	const sqlite = new Ctor(":memory:");
	sqlite.exec(SCHEMA_SQL);
	sqlite
		.prepare(
			"INSERT INTO agent_api_keys (id, name, key_hash, prefix, scopes, allowed_mailboxes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"key-1",
			"route test key",
			await sha256Hex(API_KEY),
			API_KEY.slice(0, 12),
			"all",
			// `null` = unrestricted, which is what most cases want.
			null,
			new Date().toISOString(),
		);

	const db = {
		prepare: (sql: string) => {
			const binds: unknown[] = [];
			const statement = {
				bind(...args: unknown[]) {
					binds.push(...args.map(unwrapDriverValue));
					return statement;
				},
				async first() {
					return (sqlite.prepare(sql).all(...(binds as never[]))[0] ?? null) as never;
				},
				async all() {
					return {
						results: sqlite.prepare(sql).all(...(binds as never[])),
						success: true,
						meta: {},
					} as never;
				},
				async run() {
					const info = sqlite.prepare(sql).run(...(binds as never[])) as {
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
						.all(...(binds as never[]))
						.map((row) => Object.values(row)) as never;
				},
			};
			return statement as unknown as D1PreparedStatement;
		},
		batch: async () => [],
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;

	const env = {
		DB: db,
		BUCKET: {} as R2Bucket,
		AI: {} as Ai,
	} as unknown as Env;

	return { env, sqlite };
}

/**
 * The sub-app mounted the way `../index.ts` mounts it, so the paths under test
 * are the real ones (`/mcp`, `/tools`) and the path-scoped guards apply.
 */
function createApp() {
	return new Hono().route("/", agentApiRoute);
}

/** POST a JSON-RPC request to `/mcp` with a real API key. */
async function mcpRequest(body: unknown, env: Env) {
	return await createApp().request(
		"/mcp",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			body: JSON.stringify(body),
		},
		env,
	);
}

/** GET a gateway path with a real API key. */
async function gatewayGet(path: string, env: Env) {
	return await createApp().request(
		path,
		{ method: "GET", headers: { Authorization: `Bearer ${API_KEY}` } },
		env,
	);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("gateway discovery surface (real routes)", () => {
	it("the API key is genuinely accepted (not a bypassed middleware)", { skip: sqliteSkip }, async () => {
		// Every case below depends on this: if the key were rejected every
		// handler would be unreachable and the assertions would be vacuous.
		const { env } = await createEnv();
		assert.strictEqual((await gatewayGet("/tools", env)).status, 200);

		// ...and an anonymous request really is refused, so the 200 above is
		// the middleware's decision rather than a missing guard.
		const anonymous = await createApp().request("/tools", { method: "GET" }, env);
		assert.strictEqual(anonymous.status, 401);
	});

	// ── C3: MCP `initialize` instructions ─────────────────────────

	it("initialize answers instructions alongside its existing fields", { skip: sqliteSkip }, async () => {
		const { env } = await createEnv();
		const res = await mcpRequest(
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
			env,
		);
		assert.strictEqual(res.status, 200);
		const body = (await res.json()) as {
			result?: Record<string, unknown>;
		};
		const result = body.result!;

		// The pre-existing keys are unchanged — instructions is ADDITIVE, so
		// no client needs a protocolVersion bump to keep working.
		assert.strictEqual(result.protocolVersion, "2025-06-18");
		assert.deepStrictEqual(result.capabilities, { tools: {} });
		assert.deepStrictEqual(result.serverInfo, { name: "mailboxes", version: "1.0.0" });

		assert.strictEqual(typeof result.instructions, "string");
		const instructions = result.instructions as string;
		// The three facts the text exists to carry: what the server is, the
		// prerequisite call, and the destructive-tool warning.
		assert.ok(
			instructions.includes("Mailboxes tool gateway"),
			`instructions must name this server: ${instructions}`,
		);
		assert.ok(
			instructions.includes("list_mailboxes"),
			"instructions must name the tool that yields a mailboxId",
		);
		assert.ok(
			instructions.includes("mailboxId"),
			"instructions must name the parameter it is warning about",
		);
		assert.ok(
			instructions.includes("delete_email") &&
				instructions.includes("discard_draft") &&
				instructions.includes("update_draft"),
			"instructions must name the destructive tools",
		);
		assert.ok(
			instructions.includes("send_email") && instructions.includes("send_reply"),
			"instructions must warn about the outbound-send tools",
		);
		// The tool COUNT is interpolated from the list it describes, so it
		// cannot drift when a tool is added or removed.
		assert.ok(
			instructions.includes("14 tools"),
			`instructions must state the live tool count: ${instructions}`,
		);
	});

	it("initialize does not mint a session id", { skip: sqliteSkip }, async () => {
		// The statelessness contract the module header documents: the new
		// `instructions` field must not have smuggled in per-request state.
		const { env } = await createEnv();
		const res = await mcpRequest(
			{ jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
			env,
		);
		const body = (await res.json()) as { result?: Record<string, unknown> };
		assert.ok(!("sessionId" in (body.result ?? {})));
		assert.strictEqual(res.headers.get("mcp-session-id"), null);
		// No stated version → the documented fallback.
		assert.strictEqual(body.result!.protocolVersion, "2025-06-18");
	});

	// ── C2: annotations over MCP, never over /tools ───────────────

	it("tools/list carries annotations, and /tools does not", { skip: sqliteSkip }, async () => {
		const { env } = await createEnv();

		const mcpRes = await mcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }, env);
		const mcpBody = (await mcpRes.json()) as {
			result?: { tools: Array<Record<string, unknown>> };
		};
		const mcpTools = mcpBody.result!.tools;
		assert.ok(mcpTools.length > 0);
		for (const tool of mcpTools) {
			assert.ok(
				typeof tool.annotations === "object" && tool.annotations !== null,
				`${String(tool.name)} must carry annotations over MCP`,
			);
			assert.deepStrictEqual(
				Object.keys(tool.annotations as object).sort(),
				["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
			);
			// MCP's own shape: `inputSchema`, not `parameters`.
			assert.ok("inputSchema" in tool);
		}

		const openAiRes = await gatewayGet("/tools", env);
		const openAiBody = (await openAiRes.json()) as {
			tools: Array<Record<string, unknown>>;
		};
		for (const tool of openAiBody.tools) {
			assert.ok(
				!("annotations" in tool),
				`${String((tool.function as { name: string }).name)} must NOT carry annotations on /tools`,
			);
			assert.ok(
				!("annotations" in (tool.function as object)),
				"nor nested inside `function`",
			);
			assert.deepStrictEqual(Object.keys(tool).sort(), ["function", "type"]);
		}
	});

	// ── C1: the enum survives serialization ──────────────────────

	it("/tools publishes the folder enum on every folder-taking tool", { skip: sqliteSkip }, async () => {
		const { env } = await createEnv();
		const res = await gatewayGet("/tools", env);
		const body = (await res.json()) as {
			tools: Array<{
				function: {
					name: string;
					parameters: {
						properties: Record<string, { type?: string; enum?: string[] }>;
					};
				};
			}>;
		};

		const folderTools = body.tools.filter((t) => "folder" in t.function.parameters.properties);
		assert.deepStrictEqual(
			folderTools.map((t) => t.function.name).sort(),
			["list_emails", "move_email", "search_emails"],
		);
		for (const tool of folderTools) {
			const folder = tool.function.parameters.properties.folder!;
			assert.strictEqual(folder.type, "string");
			assert.deepStrictEqual(folder.enum, [
				"inbox",
				"sent",
				"draft",
				"archive",
				"trash",
				"spam",
			]);
		}
	});

	// ── C4: top-level info ───────────────────────────────────────

	it("/tools answers a top-level info block beside the unchanged tools array", { skip: sqliteSkip }, async () => {
		const { env } = await createEnv();
		const res = await gatewayGet("/tools", env);
		assert.strictEqual(res.status, 200);
		const body = (await res.json()) as {
			info?: Record<string, unknown>;
			tools?: Array<Record<string, unknown>>;
		};

		assert.ok(body.info, "`info` must be present at the top level");
		assert.ok(Array.isArray(body.tools), "`tools` must still be an array");
		// Exactly these two top-level keys — no third place for a client to
		// look, and no key removed.
		assert.deepStrictEqual(Object.keys(body).sort(), ["info", "tools"]);

		assert.strictEqual(body.info!.name, "mailboxes-tool-gateway");
		assert.strictEqual(body.info!.version, "0.2.0");
		// Anti-regression: the key set is EXACTLY these three. A `docs` field
		// pointing at `/.well-known/api-catalog` used to sit here, but that
		// route is not implemented (the request hits the SPA fallback and
		// returns HTML), so the field was removed rather than left as a
		// pointer to a 404. Asserting the key set — not just the presence of
		// the known keys — is what makes a silent reintroduction fail.
		assert.deepStrictEqual(Object.keys(body.info!).sort(), [
			"auth",
			"name",
			"version",
		]);
		assert.deepStrictEqual(body.info!.auth, {
			scheme: "bearer",
			header: "Authorization",
			alternativeHeader: "X-API-Key",
			prefix: "agk_",
		});

		// The advertised version is the deployable's own — pinned against
		// `package.json` so the two cannot drift apart silently. Read from disk
		// rather than imported: `import … with { type: "json" }` needs a newer
		// `--module` target than this repo's tsconfig sets, and the file is the
		// point (a constant could simply be restated).
		const { readFileSync } = await import("node:fs");
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { version?: string };
		assert.strictEqual(body.info!.version, pkg.version);
	});

	it("the tools array keeps the OpenAI function shape", { skip: sqliteSkip }, async () => {
		// `info` had to be ADDITIVE: the array below is what an
		// OpenAI-compatible caller already parses, and it must look untouched.
		const { env } = await createEnv();
		const body = (await (await gatewayGet("/tools", env)).json()) as {
			tools: Array<{
				type?: string;
				function?: { name?: string; description?: string; parameters?: unknown };
			}>;
		};
		assert.strictEqual(body.tools!.length, 14, "the gateway exposes 14 tools");
		for (const tool of body.tools!) {
			assert.strictEqual(tool.type, "function");
			assert.strictEqual(typeof tool.function?.name, "string");
			assert.strictEqual(typeof tool.function?.description, "string");
			assert.ok(tool.function?.parameters, "each tool keeps its `parameters` schema");
		}
	});

	// ── C5: the mailboxId hint reaches the wire ──────────────────

	it("a tool call without mailboxId answers the self-correcting error", { skip: sqliteSkip }, async () => {
		const { env } = await createEnv();
		const res = await createApp().request(
			"/tools/call",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${API_KEY}`,
				},
				body: JSON.stringify({ name: "get_email", arguments: { id: "e1" } }),
			},
			env,
		);
		assert.strictEqual(res.status, 200, "a tool-level failure is still HTTP 200");
		const body = (await res.json()) as { ok?: boolean; error?: string };
		assert.strictEqual(body.ok, false);
		assert.strictEqual(
			body.error,
			"mailboxId is required. Call list_mailboxes first to get a valid mailboxId (e.g. 'hello@doforu.ai'), then retry.",
		);
	});
});
