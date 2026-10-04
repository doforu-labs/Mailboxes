// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Hono middleware to validate API Key Bearer Token authentication
 * WITHOUT requiring a mailboxId URL parameter.
 *
 * Unlike requireApiKey (which needs /mailboxes/:mailboxId in the URL),
 * this middleware looks up the mailbox from the API key itself.
 * Used for /api/v1/send and similar external-facing endpoints.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { extractBearerToken } from "./api-key-utils";
import { lookupApiKey } from "../db/index";
import type { D1MailboxContext } from "./d1-middleware";
// [i18n apiAuth] Error responses are localized. See the note in ./auth.ts.
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../../shared/i18n/config";
import { getBackendT } from "../../shared/i18n/translate";

/** Locale for the request; prefers the context value set by ../index.ts. */
function requestLocale(c: Context<D1MailboxContext>) {
	const scoped = c.get("locale" as never) as string | undefined;
	return isLocale(scoped) ? scoped : resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/** Translator scoped to `apiAuth` for the request's locale. */
function apiKeyT(c: Context<D1MailboxContext>) {
	return getBackendT(requestLocale(c), "apiAuth");
}

export const requireApiKeyGlobal = createMiddleware<D1MailboxContext>(
	async (c, next) => {
		const t = apiKeyT(c);
		const authHeader = c.req.header("Authorization");
		if (!authHeader) {
			return c.json({ error: t("missingAuthorizationHeader") }, 401);
		}

		const token = extractBearerToken(authHeader);
		if (!token) {
			return c.json({ error: t("invalidAuthorizationHeaderFormat") }, 401);
		}

		const result = await lookupApiKey(c.env.DB, token);
		if (!result.valid) {
			return c.json({ error: t("invalidApiKey") }, 401);
		}

		c.set("db", c.env.DB);
		c.set("domainId", result.domainId!);
		c.set("apiKeyInfo", {
			keyId: result.keyId!,
			scopes: result.scopes!,
			domainId: result.domainId!,
		});

		await next();
	},
);
