// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * External agent gateway — the HTTP surface an outside LLM talks to.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  What this module is
 * ─────────────────────────────────────────────────────────────────────
 * A mountable Hono sub-app exposing the internal agent tools (see
 * `../lib/external-tools.ts`) through two wire formats:
 *
 *   1. **MCP** (`POST /mcp`) — a minimal, hand-written, *stateless*
 *      implementation of the Model Context Protocol JSON-RPC 2.0 subset a
 *      client needs to list and call tools. No SSE, no session ids.
 *   2. **HTTP tool gateway** (`GET /tools`, `POST /tools/call`) — the same
 *      tools in OpenAI `functions` shape, for callers that do not speak MCP.
 *
 * Every route is authenticated by a *global* `agk_…` API key via
 * `requireGlobalApiKey` (`../lib/api-key-middleware.ts`). There is no admin
 * session, no cookie and no gateway-side re-implementation of authorization:
 * the key is the identity, and `apiKeyInfo` is the only thing the middleware
 * puts on the context. Tool execution itself is delegated verbatim to
 * `dispatchExternalTool` — this module adds transport, never policy.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Why the CORS is wide open
 * ─────────────────────────────────────────────────────────────────────
 * `hono/cors` is mounted with `origin: "*"` on each of this gateway's three
 * paths (see the guard block below), which looks alarming next to the
 * deliberately strict CORS the app applies to `/api/*` in `../index.ts`. The
 * reasoning is:
 *
 *   • These endpoints authenticate with a **Bearer API key** (or `X-API-Key`),
 *     never with a cookie. Nothing here is ambient authority, so a
 *     cross-origin request carries no more privilege than the key it
 *     presents — there is no CSRF surface to protect.
 *   • They are **not** under `/api/*`, so the app's global, origin-pinning
 *     CORS middleware does not cover them at all. Without a local policy
 *     they would be unusable from a browser-based MCP client or playground,
 *     which is a real and intended caller.
 *   • A hostile page still cannot forge a key: it would have to *know* it,
 *     and a key that leaked into a hostile page was already compromised
 *     regardless of CORS.
 *
 * Exposure is therefore bounded by the key, not by the origin allow-list.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Statelessness (MCP)
 * ─────────────────────────────────────────────────────────────────────
 * `initialize` issues **no** session id and echoes none back. If a client
 * nonetheless sends `Mcp-Session-Id`, it is ignored — never read, never
 * trusted, never forwarded. The server holds per-request state only, so any
 * instance can serve any request and a restart is invisible to clients.
 * (The one exception an MCP client may rely on is that `notifications/*`
 * are answered with 204 and carry no body by construction.)
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Mounting
 * ─────────────────────────────────────────────────────────────────────
 * This module declares NO absolute path and no prefix of its own — the
 * mounting layer (`../index.ts`) owns the prefix, and mounts it at the root:
 *
 *     app.route("/", agentApiRoute)
 *
 * Endpoints below are therefore written relative to `/`, and map to:
 *   POST /mcp · GET /tools · POST /tools/call
 *
 * ⚠️ `app.route()` FLATTENS: the parent copies in this sub-app's routes *and*
 * middleware, re-prefixed. That is why the guards below name the three
 * concrete paths and the two sub-path wildcards (`/mcp/*`, `/tools/*`) rather
 * than `"*"` — a root wildcard would become `ALL /*` in the parent and swallow
 * both the sibling routes registered after the mount and the React Router SPA
 * fallback (see `../app.ts`).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { DEFAULT_LOCALE } from "../../shared/i18n/config";
import type { Locale } from "../../shared/i18n/types";
import {
	requireGlobalApiKey,
	type ApiKeyVariables,
} from "../lib/api-key-middleware";
import {
	listMcpTools,
	listOpenAiTools,
	dispatchExternalTool,
	type ExternalToolResult,
} from "../lib/external-tools";
import type { Env } from "../types";

/**
 * Context for this sub-app.
 *
 * `Variables` is exactly what `requireGlobalApiKey` guarantees (`apiKeyInfo`),
 * matching the contract its header documents. We deliberately do NOT widen it
 * to `D1MailboxContext`: Hono's middleware generics are invariant, so
 * declaring variables this sub-app never uses would only invite a mismatch at
 * the mount point for no benefit.
 */
type Ctx = { Bindings: Env; Variables: ApiKeyVariables };
type AppContext = Context<Ctx>;

/**
 * Locale handed to the tools. This gateway has no locale middleware (the
 * `/api/*` one in `../index.ts` does not cover these paths and we do not want
 * to drag the mailbox middleware in just for this). The tools' `locale`
 * argument only affects immediate human-readable strings, so the default is
 * the honest choice.
 */
const TOOL_LOCALE: Locale = DEFAULT_LOCALE;

/**
 * Fallback MCP protocol revision, used when the client does not state one.
 * `2025-06-18` is the newest revision this server's surface is shaped for.
 */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Identity reported to MCP clients during `initialize`. */
const SERVER_INFO = { name: "mailboxes", version: "1.0.0" } as const;

/** JSON-RPC 2.0 error codes used by this module (spec §5.1). */
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

// ── JSON-RPC helpers ───────────────────────────────────────────────

/**
 * A parsed JSON-RPC 2.0 request. `id` is deliberately `unknown` (any JSON
 * scalar is legal, and a request may omit it to signal a notification).
 */
interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted body into a {@link JsonRpcRequest}.
 *
 * Returns `null` when the value is not a JSON-RPC 2.0 request object. Batch
 * arrays are rejected too: this server advertises no batching support, and
 * silently treating `[req]` as `req` would hide that.
 */
function parseJsonRpcRequest(body: unknown): JsonRpcRequest | null {
	if (!isPlainObject(body)) return null;
	if (body.jsonrpc !== "2.0") return null;
	if (typeof body.method !== "string" || body.method.length === 0) return null;

	const id = body.id;
	// `id` is optional; when present it must be a scalar (`null` is legal and
	// means "a response is expected but the client tracks it by null").
	if (
		id !== undefined &&
		id !== null &&
		typeof id !== "string" &&
		typeof id !== "number"
	) {
		return null;
	}

	return { jsonrpc: "2.0", id: id ?? null, method: body.method, params: body.params };
}

/**
 * Build a JSON-RPC error response body.
 *
 * `id` is `null` when the request was so malformed that no id could be
 * recovered — exactly what the spec asks for in the parse/invalid-request
 * cases.
 */
function rpcError(
	id: string | number | null,
	code: number,
	message: string,
): Record<string, unknown> {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Build a JSON-RPC success response body. */
function rpcResult(
	id: string | number | null,
	result: unknown,
): Record<string, unknown> {
	return { jsonrpc: "2.0", id, result };
}

/** Build an MCP success response body (single `result` object). */
function rpcOk(c: AppContext, id: string | number | null, result: unknown) {
	return c.json(rpcResult(id, result), 200);
}

/**
 * Build an MCP error response body.
 *
 * Note the HTTP status: JSON-RPC errors travel in the body and the transport
 * still succeeded, so these are `200`. Only a body that could not be read as
 * JSON at all gets a non-200 (see the parse-error branch of `POST /mcp`).
 */
function rpcFail(
	c: AppContext,
	id: string | number | null,
	code: number,
	message: string,
) {
	return c.json(rpcError(id, code, message), 200);
}

/**
 * Wrap a tool result into MCP's `tools/call` content envelope.
 *
 * The payload is JSON-stringified into a single `text` block — the tools
 * return structured data, and `text` is the only content type every client is
 * required to understand. A tool-level failure flips `isError` to `true`
 * while keeping HTTP 200: from the protocol's point of view the *tool* failed,
 * not the request.
 */
function toolContent(outcome: ExternalToolResult): {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
} {
	if (outcome.ok) {
		return {
			content: [{ type: "text", text: JSON.stringify(outcome.result ?? null) }],
			isError: false,
		};
	}
	return {
		content: [{ type: "text", text: JSON.stringify({ error: outcome.error }) }],
		isError: true,
	};
}

/** Read the mailbox scope for a tool call from the argument bag. */
function readMailboxId(args: Record<string, unknown>): string | undefined {
	const value = args.mailboxId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── Sub-app ────────────────────────────────────────────────────────

export const agentApiRoute = new Hono<Ctx>();

/**
 * Every path this gateway guards against unauthenticated access.
 *
 * Hono `use()` pattern semantics (verified against hono 4.12.28):
 *
 *   • A BARE path is an EXACT match — it does NOT cover its subtree.
 *     `use("/mcp")` matches only `/mcp`, never `/mcp/<x>` (and never
 *     `/mcpfoo`); `use("/tools")` matches only `/tools`, never
 *     `/tools/call`. That is exactly why a bare `/mcp` is listed here: it is
 *     the only entry that covers `/mcp` itself.
 *   • A `/*` WILDCARD DOES cover the bare path as well as every descendant.
 *     `use("/mcp/*")` matches `/mcp` AND `/mcp/<x>`; `use("/tools/*")`
 *     matches `/tools` AND `/tools/call` (and any future `/tools/<x>`).
 *
 * The list therefore contains both the bare paths and their subtree wildcards:
 *
 *   • `/mcp`     + `/mcp/*`     — the endpoint and any future `/mcp/<x>`.
 *   • `/tools`   + `/tools/*`   — the OpenAI-style gateway and any child.
 *   • `/tools/call`             — a sibling of `/tools`, not a child, so it
 *                                 needs its own entry (`/tools/*` also covers
 *                                 it; the explicit entry documents the
 *                                 endpoint and keeps the guard correct if the
 *                                 wildcard is ever narrowed).
 *
 * Given the above, the bare entries are redundant — where a `/*` wildcard is
 * present it already covers the bare path — but they are harmless and are
 * kept deliberately: they are explicit, they keep each gated path readable on
 * its own, and they stay correct if a wildcard is ever narrowed or dropped.
 * Conversely, `/mcp` alone does not cover `/mcp/<x>`: listing only the bare
 * paths was the earlier bug — an unlisted future sub-path such as
 * `GET /mcp/extra` fell through to the SPA. Keep them paired when adding a
 * path.
 *
 * None of these patterns widens to the application root, so no route of
 * `../index.ts` outside this gateway is touched. That is the whole point of
 * the explicit list: a root-level `"*"` guard in this sub-app — mounted at
 * `app.route("/", …)` — is flattened into the parent as `ALL /*`, which
 * matches every otherwise-unmatched path (`/`, `/settings`, …) and would
 * swallow both the SPA fallback and the `/api/v1/*` handlers.
 */
const GATED_PATHS = [
	"/mcp",
	"/mcp/*",
	"/tools",
	"/tools/*",
	"/tools/call",
] as const;

/**
 * Wide-open CORS — see the module header for the full rationale (Bearer-key
 * auth, no cookies ⇒ no CSRF surface; these paths are outside the `/api/*`
 * policy in `../index.ts`).
 *
 * `allowHeaders` mirrors everything an MCP or OpenAI-style client may send:
 * `Authorization` / `X-API-Key` for the key, `Content-Type` for the JSON-RPC
 * body, and the two MCP transport headers. They are accepted-and-ignored
 * server-side (the implementation is stateless) but must be advertised so a
 * browser preflight does not fail.
 */
const corsMw = cors({
	origin: "*",
	allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
	allowHeaders: [
		"Authorization",
		"Content-Type",
		"X-API-Key",
		"Mcp-Session-Id",
		"Mcp-Protocol-Version",
	],
});

// ── Guards: path-scoped, never `"*"` ───────────────────────────────
//
// These MUST be scoped to concrete paths and their subtrees, never to `"*"`.
// `app.route(path, subApp)` does not nest this sub-app behind a router of its
// own — it COPIES each of its routes AND each of its middleware into the
// parent, re-prefixed. A `"*"` guard would therefore land in `../index.ts` as
// `ALL /*` and take over every path of the application:
//
//   • every route registered after the mount (e.g. the `/api/v1/…/ai/chat`
//     handlers) would run through it first and be rejected with
//     `401 { error: "Unauthorized" }`; and
//   • it matches every otherwise-unmatched path (`/`, `/settings`, …), so the
//     React Router SPA fallback in `../app.ts` would never be reached and the
//     whole UI would answer 401.
//
// Listing `/mcp`, `/mcp/*`, `/tools`, `/tools/*` and `/tools/call` produces the
// matching `ALL …` entries in the parent, which match only those paths and
// their descendants and leak nothing at the root.
//
// Pattern semantics (see `GATED_PATHS`): `use()` applies to every method, so
// the explicit `POST`/`GET`/`DELETE` handlers further down — including the 405
// ones — are all guarded. The two wildcards are what make a future `/mcp/…`
// or `/tools/…` child authenticated by default instead of silently falling
// through to the SPA; the bare paths stay because a wildcard does not match
// the path itself.
//
// CORS is registered BEFORE `requireGlobalApiKey` within the same `use()`:
// middleware run in argument order, and the CORS middleware answers the
// `OPTIONS` preflight itself (204 + `Access-Control-Allow-Origin`) without
// calling `next()`. A preflight carries no `Authorization` header, so an
// authentication-first order would answer every browser preflight with 401.
for (const path of GATED_PATHS) {
	agentApiRoute.use(path, corsMw, requireGlobalApiKey);
}

// ── MCP: POST /mcp ─────────────────────────────────────────────────

/**
 * Minimal stateless MCP endpoint.
 *
 * Supported methods:
 *   `initialize`                → capabilities + serverInfo (no session id)
 *   `notifications/*`           → 204, no body
 *   `ping`                      → `{}`
 *   `tools/list`                → MCP tools array
 *   `tools/call`                → tool execution, wrapped as `content`
 *
 * Everything else → `-32601 Method not found`.
 */
async function handleMcp(c: AppContext) {
	// Read the body as text first: a JSON syntax error must be reported as
	// `-32700 Parse error`, which is distinguishable from a syntactically
	// valid body that is not a JSON-RPC request (`-32600`). `c.req.json()`
	// collapses both into one exception.
	const rawBody = await c.req.text();

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return c.json(rpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"), 200);
	}

	const request = parseJsonRpcRequest(parsed);
	if (!request) {
		return c.json(
			rpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
			200,
		);
	}

	// Notifications carry no `id` and MUST NOT be answered with a result.
	// MCP's `notifications/initialized` lives here; any other notification is
	// acknowledged the same way, because there is nothing to report back.
	if (request.id === undefined || request.id === null) {
		if (request.method.startsWith("notifications/")) {
			return c.body(null, 204);
		}
	}

	switch (request.method) {
		case "initialize": {
			// Stateless by design: no session id is minted and any inbound
			// `Mcp-Session-Id` header is ignored (never read).
			const params = isPlainObject(request.params) ? request.params : {};
			const requested = params.protocolVersion;
			return rpcOk(c, request.id ?? null, {
				protocolVersion:
					typeof requested === "string" && requested.length > 0
						? requested
						: DEFAULT_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});
		}

		case "notifications/initialized":
			// Reached only when a client sent an `id` alongside a notification
			// method (unusual, but harmless) — still nothing to say.
			return c.body(null, 204);

		case "ping":
			return rpcOk(c, request.id ?? null, {});

		case "tools/list":
			return rpcOk(c, request.id ?? null, { tools: listMcpTools() });

		case "tools/call": {
			const params = isPlainObject(request.params) ? request.params : {};
			const name = params.name;
			if (typeof name !== "string" || name.length === 0) {
				return rpcFail(
					c,
					request.id ?? null,
					JSON_RPC_INVALID_PARAMS,
					"Invalid params: name is required",
				);
			}

			// An unknown tool is a *protocol* error (`-32602`), not a tool
			// failure: the client asked for something this server does not
			// expose, so it never reaches the executor.
			const known = listMcpTools().some((tool) => tool.name === name);
			if (!known) {
				return rpcFail(
					c,
					request.id ?? null,
					JSON_RPC_INVALID_PARAMS,
					`Unknown tool: ${name}`,
				);
			}

			const args = isPlainObject(params.arguments) ? params.arguments : {};
			const outcome = await dispatchExternalTool(
				{ DB: c.env.DB, BUCKET: c.env.BUCKET, AI: c.env.AI },
				{ name, arguments: args, mailboxId: readMailboxId(args) },
				TOOL_LOCALE,
				c.var.apiKeyInfo.allowedMailboxes,
			);

			// Tool-level failure → 200 with `isError: true` content; success →
			// 200 with the tool's payload. Both are plain JSON-RPC results:
			// `toolContent` sets `isError` from `outcome.ok`, so the two cases
			// differ only inside the content envelope, not in the response
			// shape. One `return` covers both.
			return rpcOk(c, request.id ?? null, toolContent(outcome));
		}

		default:
			return rpcFail(
				c,
				request.id ?? null,
				JSON_RPC_METHOD_NOT_FOUND,
				`Method not found: ${request.method}`,
			);
	}
}

agentApiRoute.post("/mcp", handleMcp);

/**
 * MCP's streamable-HTTP transport also defines GET (server→client stream) and
 * DELETE (session teardown). Both are unsupported here: the server is
 * stateless and JSON-only, so there is no stream to open and no session to
 * close. Answering 405 says so explicitly instead of hanging or 404-ing.
 */
agentApiRoute.get("/mcp", (c) => c.json({ error: "Method Not Allowed" }, 405));
agentApiRoute.delete("/mcp", (c) =>
	c.json({ error: "Method Not Allowed" }, 405),
);

// ── HTTP tool gateway ──────────────────────────────────────────────

/**
 * `GET /tools` → `200 { tools: OpenAiTool[] }`
 *
 * The OpenAI `functions` shape (with `mailboxId` already injected into each
 * schema), ready to drop into a `tools` array. This is the discovery call for
 * callers that want function-calling rather than MCP.
 */
agentApiRoute.get("/tools", (c) => c.json({ tools: listOpenAiTools() }, 200));

/**
 * `POST /tools/call` → run one tool.
 *
 * Request body: `{ name: string, arguments?: object, mailboxId?: string }`
 *
 * Responses:
 *   `200 { ok:true,  result }`   tool ran
 *   `200 { ok:false, error }`    tool ran and failed (unknown mailbox, tool
 *                                error, …) — the round trip was fine
 *   `400 { error }`              malformed request (no `name`)
 *   `404 { error }`              `name` is not one of the exposed tools
 *
 * The 400/404 split is intentional: a missing name is a client bug in *this*
 * endpoint's contract, while an unrecognised name is a request for a tool that
 * does not exist. Both are distinguishable from a tool that existed and then
 * failed (200 + `ok:false`), which is the distinction a caller needs to decide
 * whether to retry or to fix its request.
 */
agentApiRoute.post("/tools/call", async (c) => {
	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	if (!isPlainObject(rawBody)) {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const name = rawBody.name;
	if (typeof name !== "string" || name.trim().length === 0) {
		return c.json({ error: "Tool name is required" }, 400);
	}

	const args = isPlainObject(rawBody.arguments) ? rawBody.arguments : {};

	// Unknown tool → 404, before any execution is attempted. Checked against
	// the canonical list so the MCP and HTTP surfaces can never disagree.
	const known = listOpenAiTools().some((tool) => tool.function.name === name);
	if (!known) {
		return c.json({ error: `Unknown tool: ${name}` }, 404);
	}

	const explicitMailboxId =
		typeof rawBody.mailboxId === "string" && rawBody.mailboxId.length > 0
			? rawBody.mailboxId
			: undefined;

	const outcome = await dispatchExternalTool(
		{ DB: c.env.DB, BUCKET: c.env.BUCKET, AI: c.env.AI },
		{
			name,
			arguments: args,
			mailboxId: explicitMailboxId ?? readMailboxId(args),
		},
		TOOL_LOCALE,
		c.var.apiKeyInfo.allowedMailboxes,
	);

	if (!outcome.ok) {
		return c.json({ ok: false, error: outcome.error ?? "tool execution failed" }, 200);
	}
	return c.json({ ok: true, result: outcome.result }, 200);
});

// Policy note: authorization lives in `dispatchExternalTool`, not here. This
// module adds transport only — both handlers forward
// `c.var.apiKeyInfo.allowedMailboxes` (the middleware's parsed allow-list) as
// the 4th argument, and the dispatcher enforces it identically for the MCP
// and HTTP surfaces.
