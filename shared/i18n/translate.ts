// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Backend (Workers) translation helper.
 *
 * ── Why not a module-level singleton? ───────────────────────────────────────
 * Cloudflare Workers reuse a single JS isolate across concurrent requests.
 * A shared `i18next` singleton would let request A's `changeLanguage("zh")`
 * leak into request B that is mid-flight, producing mixed-language responses.
 * So we create a fresh instance per request (cheap — resources are shared
 * references, not copies) and cache it on the request-scoped context, never
 * at module scope.
 *
 * The browser counterpart lives in `app/middleware/i18next.ts`.
 */

import i18next, { type i18n as I18nInstance, type TFunction } from "i18next";
import { DEFAULT_LOCALE } from "./config";
import { resources } from "./resources";
import type { Locale } from "./types";

/**
 * Create a standalone i18next instance initialised for a single locale.
 * Synchronous because all catalogs are bundled (no HTTP backend loader).
 */
export function createI18nInstance(locale: Locale): I18nInstance {
	const instance = i18next.createInstance();
	// `initAsync: false` loads the bundled resources synchronously, so `t` is
	// usable immediately after `init` (i18next v26 dropped `initImmediate`).
	instance.init({
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
 * Convenience factory for API handlers: returns the `t` function bound to
 * `locale`, optionally scoped to a default namespace.
 *
 * @example
 * // workers/index.ts — inside a Hono handler
 * const t = getBackendT(c.get("locale"), "api");
 * return c.json({ error: t("notFound") }, 404);
 */
export function getBackendT(locale: Locale, namespace = "common"): TFunction {
	return createI18nInstance(locale).getFixedT(locale, namespace);
}

/**
 * One-shot translate helper for cases where you don't need a reusable `t`.
 *
 * @example
 * const message = translate(locale, "api:notFound");
 */
export function translate(
	locale: Locale,
	key: string,
	options?: Record<string, unknown>,
): string {
	const ns = key.includes(":") ? key.split(":")[0] : "common";
	return createI18nInstance(locale).getFixedT(locale, ns)(key, options) as string;
}
