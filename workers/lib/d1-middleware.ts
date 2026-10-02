// Copyright (c) 2026 Cloudflare, Inc.
// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to inject D1 database binding and mailboxId into context.
 * Replaces the DO-stub-based middleware in mailbox.ts.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

export type D1MailboxVariables = {
	db: D1Database;
	mailboxId: string;
	domainId?: string;
	apiKeyInfo?: {
		keyId: string;
		scopes: string;
		domainId: string;
	};
};

export type D1MailboxContext = {
	Bindings: Env;
	Variables: D1MailboxVariables;
};

export const requireMailbox = createMiddleware<D1MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists in R2
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	c.set("db", c.env.DB);
	c.set("mailboxId", mailboxId);

	await next();
});
