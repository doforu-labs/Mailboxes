// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Global API key authentication middleware.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  What this guards
 * ─────────────────────────────────────────────────────────────────────
 * A *global* (non-mailbox-scoped) `agk_…` key lets an external LLM call the
 * internal agent tools without an admin browser session. It is the machine
 * counterpart to `requireAuth` (see ./auth.ts), which guards the same routes
 * for humans via an HttpOnly session cookie.
 *
 * The two are deliberately independent: a request authenticated here is NOT
 * implicitly an admin session, and `apiKeyInfo` is the only thing this
 * middleware puts on the context. Downstream handlers decide what the key's
 * `scopes` / `allowedMailboxes` permit.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Key handling
 * ─────────────────────────────────────────────────────────────────────
 * The plaintext key never leaves this function. It is hashed with
 * `hashApiKey` (SHA-256 hex — no salt/stretching, which is safe *only*
 * because the key is 256 bits of CSPRNG output, see ./api-key-utils.ts) and
 * only the digest is handed to the database. The row lookup therefore cannot
 * be used to recover a key, and neither can the response.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  Failure policy
 * ─────────────────────────────────────────────────────────────────────
 * Every rejection — malformed header, unknown key, expired key, revoked key
 * — returns the *same* `401 { error: t("unauthorized") }`. Distinguishing
 * "no such key" from "revoked key" would confirm to an attacker that a guess
 * once named a real key, so the cases are collapsed. The distinction is still
 * available internally (the DB layer returns expired/revoked rows rather than
 * filtering them out) for callers that want richer diagnostics later.
 *
 * Auditing is best-effort and MUST NOT be able to reject a request that was
 * otherwise valid: `touchAgentApiKeyLastUsed` swallows its own errors, and
 * the audit insert is wrapped in try/catch here. A D1 hiccup while recording
 * usage must never turn a working call into a 401.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { TFunction } from "i18next";
import type { Env } from "../types";
import * as db from "../db";
import { extractBearerToken, hashApiKey } from "./api-key-utils";
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../../shared/i18n/config";
import { getBackendT } from "../../shared/i18n/translate";

/**
 * Header fallback for clients that cannot set `Authorization` (some LLM
 * tool-calling runtimes restrict outbound headers, and `X-API-Key` is the
 * de-facto convention for them).
 */
const API_KEY_HEADER = "X-API-Key";

/** The authenticated key, as seen by downstream handlers. */
export interface ApiKeyInfo {
	id: string;
	name: string;
	/** Raw scope string from the row, e.g. `"all"` or `"mail:read,mail:send"`. */
	scopes: string;
	/** Parsed `allowed_mailboxes`, or null when the key is unrestricted. */
	allowedMailboxes: string[] | null;
}

/** Context variables contributed by {@link requireGlobalApiKey}. */
export interface ApiKeyVariables {
	apiKeyInfo: ApiKeyInfo;
}

/**
 * Context type for routes guarded by this middleware.
 *
 * `Bindings` binds the Cloudflare `Env` so `c.env.DB` type-checks without any
 * router-side wiring; `Variables` declares `apiKeyInfo` so both `c.set(...)`
 * inside this file and `c.get("apiKeyInfo")` at the call site are typed.
 *
 * Callers that also carry other variables (e.g. `D1MailboxContext` with `db`
 * and `mailboxId`) should intersect the two maps at their mount point:
 *
 *     type Ctx = { Bindings: Env; Variables: D1MailboxVariables & ApiKeyVariables }
 *     app.use("/api/v1/agent/*", requireGlobalApiKey)
 *
 * Hono's middleware generics are invariant, so declaring only the variables
 * this module owns is the honest description of what it guarantees.
 */
type ApiKeyContext = { Bindings: Env; Variables: ApiKeyVariables };

/**
 * Locale for the request, mirroring ./auth.ts and ./d1-middleware.ts:
 * prefer the value the `/api/*` middleware in ../index.ts put on the shared
 * request context, and fall back to resolving it from the raw request so the
 * 401 message stays legible under a Hono instance that never ran that
 * middleware (or in tests).
 */
function requestLocale(c: Context<ApiKeyContext>): string {
	const scoped = c.get("locale" as never) as string | undefined;
	if (isLocale(scoped)) return scoped;
	return resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/** Translator scoped to the `apiAuth` namespace, matching `requireAuth`. */
function apiKeyT(c: Context<ApiKeyContext>): TFunction {
	return getBackendT(requestLocale(c) as Parameters<typeof getBackendT>[0], "apiAuth");
}

/**
 * Pull the plaintext key out of the request.
 *
 * Order is significant: `Authorization: Bearer <key>` wins, and `X-API-Key`
 * is consulted only when that yields nothing. Both go through
 * `extractBearerToken`, which accepts a bare `agk_…` value as well as a
 * `Bearer `-prefixed one (case-insensitive scheme), so a client that sends
 * `X-API-Key: Bearer agk_…` for whatever reason still authenticates.
 *
 * `extractBearerToken` also shape-checks the value (`agk_` + 64 hex), so a
 * key of the wrong family or an obviously malformed token is rejected here
 * without touching the database.
 */
function readApiKey(c: Context<ApiKeyContext>): string | null {
	const fromAuthorization = extractBearerToken(c.req.header("Authorization"));
	if (fromAuthorization) return fromAuthorization;
	return extractBearerToken(c.req.header(API_KEY_HEADER));
}

/**
 * Parse `allowed_mailboxes`, which the DB stores as a JSON string or NULL.
 *
 * Tolerant by design: a NULL column, invalid JSON, a bare string, or an array
 * containing non-strings all degrade to a well-formed `string[] | null`
 * rather than throwing. A corrupt column must not 500 the request, and the
 * safest reading of "I cannot tell what this key is restricted to" is the
 * value the *scopes* check already covers — an empty list is deliberately not
 * produced, because `[]` would silently mean "no mailbox at all" to a
 * downstream `includes()` check.
 */
function parseAllowedMailboxes(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const list = parsed.filter((v): v is string => typeof v === "string");
		return list.length > 0 ? list : null;
	} catch {
		return null;
	}
}

/** `true` when the key has an `expires_at` in the past. */
function isExpired(expiresAt: string | null): boolean {
	if (!expiresAt) return false;
	const ts = new Date(expiresAt).getTime();
	// Unparseable timestamp: fail closed rather than trusting the key.
	if (Number.isNaN(ts)) return true;
	return ts < Date.now();
}

/**
 * Middleware: require a valid global `agk_…` API key.
 *
 * On success sets `c.get("apiKeyInfo")` to `{ id, name, scopes,
 * allowedMailboxes }` and calls `next()`. On any failure returns
 * `401 { error }`.
 */
export const requireGlobalApiKey = createMiddleware<ApiKeyContext>(
	async (c, next) => {
		const t = apiKeyT(c);

		const key = readApiKey(c);
		if (!key) {
			return c.json({ error: t("unauthorized") }, 401);
		}

		// Hash first, then look up by digest: the plaintext stops here.
		const hash = await hashApiKey(key);
		const row = await db.getAgentApiKeyByHash(c.env.DB, hash);

		if (!row) {
			return c.json({ error: t("unauthorized") }, 401);
		}
		// Revoked and expired collapse into the same response as "unknown" —
		// see the failure policy in the file header.
		if (row.revoked_at) {
			return c.json({ error: t("unauthorized") }, 401);
		}
		if (isExpired(row.expires_at)) {
			return c.json({ error: t("unauthorized") }, 401);
		}

		c.set("apiKeyInfo", {
			id: row.id,
			name: row.name,
			scopes: row.scopes,
			allowedMailboxes: parseAllowedMailboxes(row.allowed_mailboxes),
		});

		// Best-effort usage tracking. Both calls are already non-throwing
		// (or wrapped here) so an audit failure cannot reject a valid request.
		await db.touchAgentApiKeyLastUsed(c.env.DB, row.id);
		try {
			await db.insertAgentApiKeyAudit(c.env.DB, {
				id: crypto.randomUUID(),
				keyId: row.id,
				action: "request",
				detail: `${c.req.method} ${c.req.path}`,
			});
		} catch {
			// ignore — audit is observability, not authorization
		}

		await next();
	},
);
