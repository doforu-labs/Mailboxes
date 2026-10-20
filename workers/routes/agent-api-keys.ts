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
import {
	API_KEY_SCOPES,
	DEFAULT_API_KEY_SCOPE,
	generateApiKey,
	isApiKeyScope,
	type ApiKeyScope,
} from "../lib/api-key-utils";
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

/** Longest mailbox address accepted in an allow-list (RFC 5321 path limit). */
const MAX_MAILBOX_ID_LENGTH = 254;

/**
 * How many mailboxes one key may be restricted to.
 *
 * A key restricted to every mailbox is the same thing as an unrestricted key,
 * so a huge list is always a mistake — it just makes the row unreadable in the
 * UI while granting as much as `null` would. Twenty is comfortably more than
 * a real deployment's mailbox count (the free tier's realistic ceiling) and
 * small enough to render.
 */
const MAX_ALLOWED_MAILBOXES = 20;

/** `true` for a JSON object (arrays and null are not). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A parse that either yields a value or a ready-to-return 400 message. */
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Read the optional `scopes` field.
 *
 * Absent → the default (`all`, matching every key minted before scopes were
 * enforced). Present but unknown → **400**, not a silent downgrade: this is an
 * operator typing a value, not a stored row, so the right answer is to tell
 * them the two legal values rather than quietly hand them a read-only key that
 * then refuses to send mail.
 */
function readScope(body: unknown, t: TFunction): Parsed<ApiKeyScope> {
	const raw = isRecord(body) ? body.scopes : undefined;
	if (raw === undefined || raw === null || raw === "") {
		return { ok: true, value: DEFAULT_API_KEY_SCOPE };
	}
	if (!isApiKeyScope(raw)) {
		return {
			ok: false,
			error: t("scopeInvalid", { allowed: API_KEY_SCOPES.join(", ") }),
		};
	}
	return { ok: true, value: raw };
}

/**
 * Read the optional `allowedMailboxes` field.
 *
 * Absent / null → unrestricted. Everything else is validated strictly:
 *
 *   • `[]` is a **400**, not "unrestricted". The two readings of an empty list
 *     are "no mailbox at all" (a key that can do nothing) and "no restriction"
 *     (a key that can do everything); neither is what an operator meant, and
 *     the second is a privilege escalation hiding in an empty array. Making it
 *     invalid forces the caller to say which.
 *   • Addresses are trimmed and lower-cased here, because the dispatcher
 *     compares them to the `mailboxId` a client got from `list_mailboxes`,
 *     which is the normalized address. A mixed-case entry would otherwise sit
 *     in the list looking correct while matching nothing.
 *   • Duplicates are collapsed, so the stored row is exactly what is enforced.
 */
function readAllowedMailboxes(
	body: unknown,
	t: TFunction,
): Parsed<string[] | null> {
	const raw = isRecord(body) ? body.allowedMailboxes : undefined;
	if (raw === undefined || raw === null) return { ok: true, value: null };

	if (!Array.isArray(raw)) {
		return { ok: false, error: t("mailboxesInvalid") };
	}
	if (raw.length === 0) {
		return { ok: false, error: t("mailboxesEmpty") };
	}
	if (raw.length > MAX_ALLOWED_MAILBOXES) {
		return {
			ok: false,
			error: t("mailboxesTooMany", { max: MAX_ALLOWED_MAILBOXES }),
		};
	}

	const list: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			return { ok: false, error: t("mailboxesInvalid") };
		}
		const normalized = entry.trim().toLowerCase();
		if (!normalized || normalized.length > MAX_MAILBOX_ID_LENGTH) {
			return { ok: false, error: t("mailboxesInvalid") };
		}
		if (!list.includes(normalized)) list.push(normalized);
	}

	return { ok: true, value: list };
}

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
 * Body: `{ name: string, scopes?: "read" | "all", allowedMailboxes?: string[] }`.
 * The plaintext key is generated here, hashed, and only the hash is handed to
 * D1; the plaintext appears in this response and nowhere else, ever again.
 *
 * The two optional fields are what make a key safe to hand to an agent that is
 * not fully trusted: `scopes: "read"` makes the gateway advertise and accept
 * only the five read-only tools, and `allowedMailboxes` pins the key to a
 * subset of mailboxes. Both are enforced in `dispatchExternalTool` (the
 * executor) and reflected in the advertised tool list (the transport), so the
 * model never even sees a capability it does not have.
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

		const scope = readScope(body, t);
		if (!scope.ok) {
			return c.json({ error: scope.error }, 400);
		}
		const mailboxes = readAllowedMailboxes(body, t);
		if (!mailboxes.ok) {
			return c.json({ error: mailboxes.error }, 400);
		}

		const id = crypto.randomUUID();
		const { plainText, prefix, hash } = await generateApiKey();

		await db.insertAgentApiKey(c.env.DB, {
			id,
			name,
			keyHash: hash,
			prefix,
			scopes: scope.value,
			allowedMailboxes: mailboxes.value
				? JSON.stringify(mailboxes.value)
				: null,
		});

		return c.json(
			{
				id,
				name,
				prefix,
				scopes: scope.value,
				allowed_mailboxes: mailboxes.value,
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
