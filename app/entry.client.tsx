// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Client entry — mirrors the custom `entry.server.tsx` so that:
 *   - the browser i18next instance is created the same way the server does,
 *   - detection order matches the server (`<html lang>` → cookie → navigator),
 *   - hydration sees the exact same language the server rendered.
 *
 * Detection order rationale:
 *   1. `htmlTag` — the server already resolved the locale and wrote
 *      `<html lang="…">`; trusting it first guarantees identical output.
 *   2. `cookie`  — persists the user's explicit choice between visits.
 *   3. `navigator` — first-visit fallback from the browser's language.
 */

import { createInstance } from "i18next";
import I18nextBrowserLanguageDetector from "i18next-browser-languagedetector";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { HydratedRouter } from "react-router/dom";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "shared/i18n/config";
import { resources } from "shared/i18n/resources";

async function hydrate() {
	const i18n = createInstance();
	await i18n
		.use(initReactI18next)
		.use(I18nextBrowserLanguageDetector)
		.init({
			lng: undefined,
			fallbackLng: DEFAULT_LOCALE,
			supportedLngs: ["en", "zh"],
			resources,
			defaultNS: "common",
			ns: Object.keys(resources.en),
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
			detection: {
				order: ["htmlTag", "cookie", "navigator"],
				caches: ["cookie"],
				cookieOptions: {
					path: "/",
					sameSite: "lax",
					// `document.cookie` cannot set HttpOnly — that's expected.
					// This cookie only carries a language preference.
				},
				lookupCookie: LOCALE_COOKIE,
			},
		});

	startTransition(() => {
		hydrateRoot(
			document,
			<I18nextProvider i18n={i18n}>
				<StrictMode>
					<HydratedRouter />
				</StrictMode>
			</I18nextProvider>,
		);
	});
}

hydrate().catch((error) => {
	console.error("Hydration failed:", error);
});
