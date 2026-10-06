// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Hono middleware to inject D1 database binding and mailboxId into context.
 * Replaces the DO-stub-based middleware in mailbox.ts.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { TFunction } from "i18next";
import type { Env } from "../types";
import type { Locale } from "../../shared/i18n/types";
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../../shared/i18n/config";
import { getBackendT } from "../../shared/i18n/translate";

export type D1MailboxVariables = {
	db: D1Database;
	mailboxId: string;
	domainId?: string;
	/** [i18n-foundation] Locale resolved from the request (cookie/header). */
	locale: Locale;
	/** [i18n-foundation] Backend translator bound to `locale` (default ns). */
	t: TFunction;
};

export type D1MailboxContext = {
	Bindings: Env;
	Variables: D1MailboxVariables;
};

/**
 * [i18n apiAuth] Locale for the request being handled.
 *
 * The `/api/*` middleware in ../index.ts already resolved and set this, so the
 * common path is a plain context read. The fallbacks (resolve from the raw
 * request, then English) keep this middleware correct when it runs under a
 * Hono instance that never mounted that middleware — and, crucially, on the
 * ERROR paths below, which must still produce a legible message.
 */
function requestLocale(c: Context<D1MailboxContext>): Locale {
	const scoped = c.get("locale" as never) as string | undefined;
	return isLocale(scoped) ? scoped : resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/** Translator scoped to `apiAuth` for the request's locale. */
function middlewareT(c: Context<D1MailboxContext>): TFunction {
	return getBackendT(requestLocale(c), "apiAuth");
}

export const requireMailbox = createMiddleware<D1MailboxContext>(async (c, next) => {
	const t = middlewareT(c);
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: t("mailboxIdRequired") }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists in R2
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: t("notFound") }, 404);
	}

	c.set("db", c.env.DB);
	c.set("mailboxId", mailboxId);

	await next();
});
