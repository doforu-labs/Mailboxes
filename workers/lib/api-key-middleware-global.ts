// Copyright (c) 2026 Cloudflare, Inc.
// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to validate API Key Bearer Token authentication
 * WITHOUT requiring a mailboxId URL parameter.
 *
 * Unlike requireApiKey (which needs /mailboxes/:mailboxId in the URL),
 * this middleware looks up the mailbox from the API key itself.
 * Used for /api/v1/send and similar external-facing endpoints.
 */
import { createMiddleware } from "hono/factory";
import { extractBearerToken } from "./api-key-utils";
import { lookupApiKey } from "../db/index";
import type { D1MailboxContext } from "./d1-middleware";

export const requireApiKeyGlobal = createMiddleware<D1MailboxContext>(
	async (c, next) => {
		const authHeader = c.req.header("Authorization");
		if (!authHeader) {
			return c.json({ error: "Missing Authorization header" }, 401);
		}

		const token = extractBearerToken(authHeader);
		if (!token) {
			return c.json({ error: "Invalid Authorization header format. Expected: Bearer mb_..." }, 401);
		}

		const result = await lookupApiKey(c.env.DB, token);
		if (!result.valid) {
			return c.json({ error: "Invalid or expired API key" }, 401);
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
