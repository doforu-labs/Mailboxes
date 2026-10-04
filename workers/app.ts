// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Hono } from "hono";
import {
	createContext,
	createRequestHandler,
	RouterContextProvider,
} from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import type { Env } from "./types";

/**
 * Context key for the Cloudflare bindings, exposed to React Router loaders
 * and middleware via `context.get(cloudflareContext)`.
 *
 * With `future.v8_middleware` enabled, the request context is a
 * `RouterContextProvider` (not a plain object), and `createRequestHandler`
 * rejects any other shape — so the bindings now travel as a typed context
 * entry instead of a plain `AppLoadContext` object.
 */
export const cloudflareContext = createContext<{
	env: Env;
	ctx: ExecutionContext;
}>();

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Mount the API routes
app.route("/", apiApp);

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	// With middleware enabled the load context must be a `RouterContextProvider`.
	// Route middleware (e.g. i18n) extends this same object for the request.
	const context = new RouterContextProvider();
	context.set(cloudflareContext, {
		env: c.env,
		ctx: c.executionCtx as ExecutionContext,
	});
	return requestHandler(c.req.raw, context);
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
