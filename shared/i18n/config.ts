// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import type { Locale } from "./types";

/**
 * Locales the app ships translations for. Order matters only for UI listing.
 */
export const SUPPORTED_LOCALES = ["en", "zh"] as const;

/**
 * Locale used when nothing else can be detected, and the fallback catalog
 * every namespace resolves against.
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Name of the (non-HttpOnly, same-origin) cookie that persists the user's
 * language choice. Read by `resolveLocale` on the server, and read/written by
 * the client-side `<LanguageSwitcher>`.
 */
export const LOCALE_COOKIE = "lang";

/** Type guard: narrows an arbitrary string to a supported `Locale`. */
export function isLocale(value: string | undefined | null): value is Locale {
	return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Extract a supported base language from a BCP-47 tag such as `zh-CN`,
 * `zh-Hans-CN` or `en-US`. Returns `null` when the tag maps to no supported
 * locale.
 */
function matchBaseLanguage(tag: string): Locale | null {
	const base = tag.trim().toLowerCase().split("-")[0];
	return isLocale(base) ? base : null;
}

/**
 * Read the optional `?lng=`/`?lang=` query param. This is the highest-priority
 * source after an explicit body/query override, and lets shareable links pin a
 * language (e.g. `/login?lang=zh`).
 */
function resolveFromQuery(url: URL): Locale | null {
	const raw = url.searchParams.get("lng") ?? url.searchParams.get("lang");
	if (!raw) return null;
	const base = matchBaseLanguage(raw);
	return base;
}

/**
 * Parse the `lang` cookie out of a raw `Cookie` header value.
 * Deliberately dependency-free so it works in Workers, the browser and tests.
 */
function resolveFromCookie(request: Request): Locale | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const name = part.slice(0, eq).trim();
		if (name !== LOCALE_COOKIE) continue;
		const value = decodeURIComponent(part.slice(eq + 1).trim());
		return matchBaseLanguage(value);
	}
	return null;
}

/**
 * Pick the best supported locale from an `Accept-Language` header, honouring
 * the advertised quality weights (`zh-CN,zh;q=0.9,en;q=0.8`).
 */
function resolveFromAcceptLanguage(request: Request): Locale | null {
	const header = request.headers.get("accept-language");
	if (!header) return null;

	const candidates = header
		.split(",")
		.map((entry) => {
			const [tag, ...params] = entry.trim().split(";");
			let q = 1;
			for (const param of params) {
				const [key, value] = param.split("=").map((s) => s.trim());
				if (key === "q") {
					const parsed = Number.parseFloat(value);
					if (!Number.isNaN(parsed)) q = parsed;
				}
			}
			return { tag: tag.trim(), q };
		})
		.filter((entry) => entry.tag.length > 0)
		.sort((a, b) => b.q - a.q);

	for (const { tag } of candidates) {
		// `*` means "any" — let the next source (or default) handle it.
		if (tag === "*") continue;
		const base = matchBaseLanguage(tag);
		if (base) return base;
	}
	return null;
}

/**
 * Resolve the locale for an incoming request.
 *
 * Priority (highest first):
 *   1. `lang` cookie         — explicit user choice, persisted by the switcher
 *   2. `?lng=`/`?lang=` query — allows a shareable link to pin a language
 *   3. `Accept-Language` header — first supported, highest-quality match
 *   4. `DEFAULT_LOCALE` ("en")
 *
 * Pure function: only reads `request.headers` and `request.url`, so it is safe
 * to call from both the Workers runtime and the browser.
 */
export function resolveLocale(request: Request): Locale {
	return (
		resolveFromCookie(request) ??
		resolveFromQuery(new URL(request.url)) ??
		resolveFromAcceptLanguage(request) ??
		DEFAULT_LOCALE
	);
}
