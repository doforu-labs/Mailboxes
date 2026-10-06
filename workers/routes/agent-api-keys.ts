// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Admin management endpoints for the *global* agent API keys.
 *
 * These keys let an external LLM call the internal agent tools over HTTP
 * (see `workers/lib/api-key-utils.ts` for minting/verification and
 * `workers/db/index.ts` section 32 for the persistence layer).
 *
 * ── Scope of this module ────────────────────────────────────────────────────
 * It is a mountable Hono sub-app only. Session authentication (admin cookie)
 * is the mounting layer's job (`app.use("/api/v1/*", requireAuth)` in
 * `workers/index.ts`, wired up by the separate mounting task) — deliberately
 * NOT re-implemented here, so there is exactly one place that decides who is
 * an admin.
 *
 * Expiry / revocation checks are likewise NOT here: they belong to the
 * verification path that consumes a presented key (`getAgentApiKeyByHash`),
 * not to key creation.
 *
 * Endpoints (relative to the mount point, presumably `/api/v1/agent-api-keys`):
 *   POST   /      → 201 { id, name, prefix, api_key, message }   (plaintext
 *                   `api_key` is returned exactly once and never persisted)
 *   GET    /      → 200 { api_keys: AgentApiKeyPublic[] }
 *   DELETE /:id   → 200 { ok: true } | 404 { error }
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { TFunction } from "i18next";
import * as db from "../db";
import { generateApiKey } from "../lib/api-key-utils";
import type { D1MailboxContext } from "../lib/d1-middleware";
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../../shared/i18n/config";
import { getBackendT } from "../../shared/i18n/translate";
import type { Locale } from "../../shared/i18n/types";

/**
 * Namespace for the user-visible strings of this module: `apiAgentKey`.
 *
 * RESOLVED (was a T11 follow-up): the catalogs
 * `shared/i18n/locales/{en,zh}/apiAgentKey.json` now exist, so `t()` here
 * resolves to real translations and no longer falls back to the backend
 * catalog. The `getBackendT` call below is unrelated to that: it is the normal
 * way this codebase scopes a namespace, same as `workers/routes/reply-forward.ts`.
 *
 * NOTE: strings resolved here are NEVER persisted — only used for immediate
 * HTTP error responses, so nothing about a request can freeze a language.
 */
const I18N_NAMESPACE = "apiAgentKey";

/** Longest accepted key name; keeps list responses and D1 rows sane. */
const MAX_NAME_LENGTH = 64;

type AppContext = Context<D1MailboxContext>;

/**
 * Locale for the request being handled.
 *
 * The `/api/*` middleware in `../index.ts` resolves the locale and sets it on
 * the shared context, so the common path is a plain context read. The
 * fallbacks keep this module correct when it is exercised through a Hono
 * instance that never mounted that middleware (e.g. a unit test).
 */
function requestLocale(c: AppContext): Locale {
	const scoped = c.get("locale" as never) as string | undefined;
	return isLocale(scoped) ? scoped : resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/** Translator scoped to this module's namespace, built lazily. */
function agentKeyT(c: AppContext): TFunction {
	let t: TFunction | undefined;
	return ((key: string, options?: Record<string, unknown>) => {
		t ??= getBackendT(requestLocale(c), I18N_NAMESPACE);
		return t(key, options);
	}) as TFunction;
}

/** Extract a trimmed `name` from an arbitrary JSON body, or null if absent. */
function readName(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const value = (body as Record<string, unknown>).name;
	return typeof value === "string" ? value.trim() : null;
}

/**
 * POST / — mint a new global API key.
 *
 * Body: `{ name: string }`. The plaintext key is generated here, hashed, and
 * only the hash is handed to D1; the plaintext appears in this response and
 * nowhere else, ever again.
 */
export async function handleCreateAgentApiKey(c: AppContext) {
	const t = agentKeyT(c);
	try {
		const body = await c.req.json().catch(() => null);
		const name = readName(body);

		if (!name) {
			return c.json({ error: t("nameRequired") }, 400);
		}
		if (name.length > MAX_NAME_LENGTH) {
			return c.json({ error: t("nameTooLong", { max: MAX_NAME_LENGTH }) }, 400);
		}

		const id = crypto.randomUUID();
		const { plainText, prefix, hash } = await generateApiKey();

		await db.insertAgentApiKey(c.env.DB, {
			id,
			name,
			keyHash: hash,
			prefix,
			scopes: "all",
		});

		return c.json(
			{
				id,
				name,
				prefix,
				// Shown once. Not stored, not recoverable through any other endpoint.
				api_key: plainText,
				message: t("createdOnce", { prefix }),
			},
			201,
		);
	} catch (error: unknown) {
		console.error(
			"Create agent API key failed:",
			error instanceof Error ? error.message : error,
		);
		return c.json({ error: t("createFailed") }, 500);
	}
}

/**
 * GET / — list every global API key, newest first.
 *
 * `listAgentApiKeys` selects only the public columns, so neither the hash nor
 * any plaintext can leak through this response.
 */
export async function handleListAgentApiKeys(c: AppContext) {
	const t = agentKeyT(c);
	try {
		return c.json({ api_keys: await db.listAgentApiKeys(c.env.DB) });
	} catch (error: unknown) {
		console.error(
			"List agent API keys failed:",
			error instanceof Error ? error.message : error,
		);
		return c.json({ error: t("listFailed") }, 500);
	}
}

/**
 * DELETE /:id — revoke a key.
 *
 * Revocation is a soft delete (`revoked_at`), so the row stays visible in the
 * list for audit purposes. 404 when nothing was revoked — an unknown id, or an
 * already-revoked key (`revokeAgentApiKey` only writes the timestamp once).
 */
export async function handleRevokeAgentApiKey(c: AppContext) {
	const t = agentKeyT(c);
	try {
		const id = c.req.param("id") ?? "";
		if (!id) {
			return c.json({ error: t("idRequired") }, 400);
		}

		const revoked = await db.revokeAgentApiKey(c.env.DB, id);
		if (!revoked) {
			return c.json({ error: t("keyNotFound") }, 404);
		}

		return c.json({ ok: true });
	} catch (error: unknown) {
		console.error(
			"Revoke agent API key failed:",
			error instanceof Error ? error.message : error,
		);
		return c.json({ error: t("revokeFailed") }, 500);
	}
}

/**
 * Mountable sub-app. The mounting layer owns the path prefix (and the auth
 * middleware), so every route below is declared relative to `/`.
 */
export const agentApiKeysRoute = new Hono<D1MailboxContext>();

agentApiKeysRoute.post("/", handleCreateAgentApiKey);
agentApiKeysRoute.get("/", handleListAgentApiKeys);
agentApiKeysRoute.delete("/:id", handleRevokeAgentApiKey);
