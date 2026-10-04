// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * [i18n-foundation] Compact English / 中文 language toggle.
 *
 * Switching does two things:
 *   1. `i18n.changeLanguage(locale)` — re-renders the tree via context.
 *   2. Persists the choice in the `lang` cookie so the NEXT server render
 *      (full reload / SSR) already starts in the right language.
 *
 * The cookie is intentionally non-HttpOnly: the client reads and writes it
 * directly, and it carries nothing sensitive — just a language preference.
 */

import { useTranslation } from "react-i18next";
import { LOCALE_COOKIE, SUPPORTED_LOCALES } from "shared/i18n/config";
import type { Locale } from "shared/i18n/types";

/** Short endonym shown in the toggle. */
const LOCALE_LABELS: Record<Locale, string> = {
	en: "EN",
	zh: "中文",
};

/** Full name for the accessible `aria-label`/`title`. */
const LOCALE_NAMES: Record<Locale, string> = {
	en: "English",
	zh: "中文",
};

function setLocaleCookie(locale: Locale) {
	// One year, site-wide, sent on same-origin navigations (and API calls).
	document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)};path=/;max-age=31536000;samesite=lax`;
}

export default function LanguageSwitcher() {
	const { t, i18n } = useTranslation("layout");
	const current = (i18n.resolvedLanguage ?? i18n.language ?? "en").split(
		"-",
	)[0] as Locale;

	const change = (locale: Locale) => {
		if (locale === current) return;
		setLocaleCookie(locale);
		void i18n.changeLanguage(locale);
	};

	return (
		<div
			role="group"
			aria-label={t("languageAria")}
			className="flex items-center rounded-md border border-kumo-line overflow-hidden shrink-0"
		>
			{SUPPORTED_LOCALES.map((locale) => {
				const active = locale === current;
				return (
					<button
						key={locale}
						type="button"
						onClick={() => change(locale)}
						aria-pressed={active}
						aria-label={LOCALE_NAMES[locale]}
						title={LOCALE_NAMES[locale]}
						className={`px-2 py-1 text-xs transition-colors ${
							active
								? "bg-kumo-tint text-kumo-default"
								: "text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
						}`}
					>
						{LOCALE_LABELS[locale]}
					</button>
				);
			})}
		</div>
	);
}
