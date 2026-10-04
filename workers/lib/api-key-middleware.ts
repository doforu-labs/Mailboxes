// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Hono middleware to validate API Key Bearer Token authentication.
 * Replaces or complements requireMailbox for API-key-authenticated routes.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../types";
import { extractBearerToken } from "./api-key-utils";
import { validateApiKey } from "../db/index";
import type { D1MailboxVariables } from "./d1-middleware";
// [i18n apiAuth] Error responses are localized. See the note in ./auth.ts —
// `locale` is read off the request context set by the `/api/*` middleware in
// ../index.ts, with a resolve-from-request fallback.
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../../shared/i18n/config";
import { getBackendT } from "../../shared/i18n/translate";

export type ApiKeyMiddlewareVariables = D1MailboxVariables & {
	apiKeyInfo: {
		keyId: string;
		scopes: string;
		domainId: string;
	};
};

export type ApiKeyMiddlewareContext = {
	Bindings: Env;
	Variables: ApiKeyMiddlewareVariables;
};

/** Locale for the request; prefers the context value set by ../index.ts. */
function requestLocale(c: Context<ApiKeyMiddlewareContext>) {
	const scoped = c.get("locale" as never) as string | undefined;
	return isLocale(scoped) ? scoped : resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/** Translator scoped to `apiAuth` for the request's locale. */
function apiKeyT(c: Context<ApiKeyMiddlewareContext>) {
	return getBackendT(requestLocale(c), "apiAuth");
}

export const requireApiKey = createMiddleware<ApiKeyMiddlewareContext>(
	async (c, next) => {
		const t = apiKeyT(c);
		// 1. Extract Bearer token from Authorization header
		const authHeader = c.req.header("Authorization");
		// extractBearerToken accepts `string | null`; `c.req.header()` yields
		// `undefined` when the header is absent, so normalise it to null first
		// (semantically identical for that helper).
		const token = extractBearerToken(authHeader ?? null);

		if (!token) {
			return c.json({ error: t("missingAuthorizationHeader") }, 401);
		}

		// 2. Extract domainId from route params
		const rawId = c.req.param("domainId");
		if (!rawId) {
			return c.json({ error: t("domainIdRequired") }, 400);
		}
		const decodedDomainId = decodeURIComponent(rawId);

		// 3. Validate the API key
		const result = await validateApiKey(c.env.DB, decodedDomainId, token);

		if (!result.valid) {
			return c.json({ error: t("invalidApiKey") }, 401);
		}

		// 4. Set context variables on success
		c.set("db", c.env.DB);
		c.set("domainId", decodedDomainId);
		c.set("apiKeyInfo", {
			keyId: result.keyId!,
			scopes: result.scopes ?? "",
			domainId: decodedDomainId,
		});

		await next();
	},
);
