// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Distributed here as part of a work licensed under the AGPL-3.0-only (see LICENSE).

import type { Locale } from "./i18n/types";

/**
 * Canonical folder ID constants.
 *
 * Every part of the stack — API routes, agent, frontend sidebar —
 * references folder IDs. This module is the single source of truth so we
 * don't scatter magic strings everywhere.
 */

export const Folders = {
	INBOX: "inbox",
	SENT: "sent",
	DRAFT: "draft",
	ARCHIVE: "archive",
	TRASH: "trash",
	SPAM: "spam",
} as const;

export type FolderId = (typeof Folders)[keyof typeof Folders];

/**
 * System folder IDs that appear in the sidebar (excludes spam).
 * Order here matches the sidebar display order.
 */
export const SYSTEM_FOLDER_IDS: readonly FolderId[] = [
	Folders.INBOX,
	Folders.SENT,
	Folders.DRAFT,
	Folders.ARCHIVE,
	Folders.TRASH,
];

/**
 * Human-readable display names for folder IDs (English / default).
 * Used in the sidebar, search result badges, and tool descriptions.
 *
 * [i18n-foundation] Kept as the English fallback. Locale-aware lookups go
 * through `getFolderDisplayName(id, locale)`; the `zh` table below backs it.
 */
export const FOLDER_DISPLAY_NAMES: Record<string, string> = {
	[Folders.INBOX]: "Inbox",
	[Folders.SENT]: "Sent",
	[Folders.DRAFT]: "Drafts",
	[Folders.ARCHIVE]: "Archive",
	[Folders.TRASH]: "Trash",
	[Folders.SPAM]: "Spam",
};

/** [i18n-foundation] Simplified-Chinese folder display names. */
export const FOLDER_DISPLAY_NAMES_ZH: Record<string, string> = {
	[Folders.INBOX]: "收件箱",
	[Folders.SENT]: "已发送",
	[Folders.DRAFT]: "草稿",
	[Folders.ARCHIVE]: "归档",
	[Folders.TRASH]: "已删除",
	[Folders.SPAM]: "垃圾邮件",
};

/** Locale-keyed display-name tables. */
const FOLDER_DISPLAY_NAMES_BY_LOCALE: Record<Locale, Record<string, string>> = {
	en: FOLDER_DISPLAY_NAMES,
	zh: FOLDER_DISPLAY_NAMES_ZH,
};

/**
 * Look up a display name for a folder ID, falling back to the raw ID
 * with a capitalised first letter.
 *
 * [i18n-foundation] The optional `locale` argument is backward compatible: no
 * locale → English (previous behaviour). Callers migrate to passing a locale
 * as they become locale-aware.
 */
export function getFolderDisplayName(folderId: string, locale?: Locale): string {
	const table = locale
		? FOLDER_DISPLAY_NAMES_BY_LOCALE[locale]
		: FOLDER_DISPLAY_NAMES;
	return (
		table[folderId.toLowerCase()] ||
		folderId.charAt(0).toUpperCase() + folderId.slice(1)
	);
}
