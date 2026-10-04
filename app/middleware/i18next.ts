// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * React Router v7 middleware that attaches a per-request i18next instance to
 * the request context.
 *
 * ── Why per-request? ────────────────────────────────────────────────────────
 * The Worker isolate is shared across concurrent requests, so a module-scoped
 * i18next singleton would let one request's language leak into another. We
 * build a fresh instance per request (resources are shared references, so this
 * is cheap) and store it on the Router context.
 *
 * ── Consuming it ────────────────────────────────────────────────────────────
 *   - Server loaders/actions/middleware: `context.get(i18nextContext)`
 *   - `app/root.tsx`: reads it in its `loader` and exposes `locale` as loader
 *     data; the `<html lang>` is set from it there.
 *   - `app/entry.server.tsx`: reads it from the `loadContext` argument and
 *     wraps `<ServerRouter>` in `<I18nextProvider>` so SSR output matches the
 *     detected language (no hydration mismatch).
 */

import {
	createContext,
	type MiddlewareFunction,
	type RouterContextProvider,
} from "react-router";
import { createInstance } from "i18next";
import { DEFAULT_LOCALE, resolveLocale } from "shared/i18n/config";
import { resources } from "shared/i18n/resources";
import type { Locale } from "shared/i18n/types";
import { initReactI18next } from "react-i18next";

/**
 * Context key holding the per-request i18next instance. The instance is a
 * plain (non-serializable) object; it never crosses the network — it lives
 * only in the in-memory Router context for the duration of a request.
 */
export const i18nextContext = createContext<ReturnType<typeof createInstance>>(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	undefined as any,
);

/**
 * Context key holding the resolved [`Locale`]. Handy when a loader only needs
 * the language tag (e.g. for `Intl` formatting) rather than a `t` function.
 */
export const localeContext = createContext<Locale>(DEFAULT_LOCALE);

/**
 * Build a fresh i18next instance preset to `locale` with the bundled catalogs.
 * Synchronous (`initImmediate: false`) because there is no async backend.
 */
export function createI18nInstance(locale: Locale) {
	const instance = createInstance();
	// i18next v26 dropped `initImmediate`; `initAsync: false` gives the same
	// synchronous, backend-free initialization we need on the server.
	instance.use(initReactI18next).init({
		lng: locale,
		fallbackLng: DEFAULT_LOCALE,
		supportedLngs: ["en", "zh"],
		resources,
		defaultNS: "common",
		ns: Object.keys(resources.en),
		initAsync: false,
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	return instance;
}

/**
 * Server middleware: detect locale from the request (cookie → query →
 * `Accept-Language` → default), build an i18next instance, and expose both on
 * the context. Mount it on `app/root.tsx` so every route (including the `*`
 * not-found route) runs through it.
 */
export const i18nextMiddleware: MiddlewareFunction<Response> = async (
	{ request, context },
	next,
) => {
	const locale = resolveLocale(request);
	const i18n = createI18nInstance(locale);

	context.set(i18nextContext, i18n);
	context.set(localeContext, locale);

	return next();
};

/**
 * Read the per-request i18next instance from a Router context.
 * Throws if the middleware did not run — that would be a wiring bug, and a
 * loud failure beats silently rendering English.
 */
export function getInstance(context: Readonly<RouterContextProvider>) {
	const instance = context.get(i18nextContext);
	if (!instance) {
		throw new Error(
			"i18next instance missing from context — is `i18nextMiddleware` exported as `middleware` from app/root.tsx?",
		);
	}
	return instance;
}

/** Read the resolved locale from a Router context (falls back to `en`). */
export function getLocale(context: Readonly<RouterContextProvider>): Locale {
	const locale = context.get(localeContext);
	return locale ?? DEFAULT_LOCALE;
}
