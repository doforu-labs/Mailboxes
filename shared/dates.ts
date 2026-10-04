// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Distributed here as part of a work licensed under the AGPL-3.0-only (see LICENSE).

/**
 * Consolidated date formatting utilities.
 *
 * Previously spread across several modules on the frontend and backend.
 * Now one canonical set imported by both the frontend and backend.
 *
 * [i18n-foundation] Every formatter takes an OPTIONAL `locale` as its last
 * argument. Omitting it preserves the previous behaviour (browser/runtime
 * default locale, deterministic `en-US` for quoted dates) so existing call
 * sites and tests are unaffected. Pass a `Locale` ("en" | "zh") once a call
 * site is locale-aware.
 */

import type { Locale } from "./i18n/types";

/** Map an app `Locale` to the BCP-47 tag `Intl` expects. */
function toIntlLocale(locale?: Locale): string | undefined {
	if (!locale) return undefined;
	return locale === "zh" ? "zh-CN" : "en-US";
}

/** Parse safely — returns null on invalid dates instead of NaN-date. */
function safeParse(dateStr: string | undefined | null): Date | null {
	if (!dateStr) return null;
	try {
		const d = new Date(dateStr);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

/**
 * Email list rows.
 * - Today: "3:42 PM"
 * - This year: "Apr 15"
 * - Older: "Apr 15, 2024"
 */
export function formatListDate(dateStr: string, locale?: Locale): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const intl = toIntlLocale(locale);
	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString(intl, {
			hour: "numeric",
			minute: "2-digit",
		});
	}
	if (date.getFullYear() === now.getFullYear()) {
		return date.toLocaleDateString(intl, {
			month: "short",
			day: "numeric",
		});
	}
	return date.toLocaleDateString(intl, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Email detail header.
 * "Tue, Apr 15, 3:42 PM"
 */
export function formatDetailDate(dateStr: string, locale?: Locale): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleDateString(toIntlLocale(locale), {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Thread message headers — time only.
 * "3:42 PM"
 */
export function formatShortDate(dateStr: string, locale?: Locale): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleTimeString(toIntlLocale(locale), {
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Compose quoted replies & backend quoted blocks.
 * "Tue, Apr 15, 2026, 3:42 PM"
 *
 * Previously hard-coded to "en-US" for deterministic output on both browser
 * and Cloudflare Workers. Passing `locale` overrides that; omitting it keeps
 * the original `en-US` behaviour.
 */
export function formatQuotedDate(
	dateStr: string | undefined,
	locale?: Locale,
): string {
	if (!dateStr) return "";
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleString(toIntlLocale(locale) ?? "en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}
