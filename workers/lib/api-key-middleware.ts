// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Hono middleware to validate API Key Bearer Token authentication.
 * Replaces or complements requireMailbox for API-key-authenticated routes.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { extractBearerToken } from "./api-key-utils";
import { validateApiKey } from "../db/index";
import type { D1MailboxVariables } from "./d1-middleware";

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

export const requireApiKey = createMiddleware<ApiKeyMiddlewareContext>(
	async (c, next) => {
		// 1. Extract Bearer token from Authorization header
		const authHeader = c.req.header("Authorization");
		// extractBearerToken accepts `string | null`; `c.req.header()` yields
		// `undefined` when the header is absent, so normalise it to null first
		// (semantically identical for that helper).
		const token = extractBearerToken(authHeader ?? null);

		if (!token) {
			return c.json({ error: "Missing Authorization header" }, 401);
		}

		// 2. Extract domainId from route params
		const rawId = c.req.param("domainId");
		if (!rawId) {
			return c.json({ error: "Domain ID required" }, 400);
		}
		const decodedDomainId = decodeURIComponent(rawId);

		// 3. Validate the API key
		const result = await validateApiKey(c.env.DB, decodedDomainId, token);

		if (!result.valid) {
			return c.json({ error: "Invalid or expired API key" }, 401);
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
