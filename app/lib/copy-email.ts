// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * "Copy the whole email" helpers.
 *
 * Why this exists
 * ---------------
 * The message body is rendered inside a sandboxed iframe without
 * `allow-same-origin` (see `app/components/EmailIframe.tsx`), so the body lives
 * in its own opaque-origin document. Browser selection and Ctrl+A are
 * per-document, which means:
 *
 *   - with focus inside the body, Ctrl+A selects the *iframe* document only —
 *     the user gets the message text but never the subject / sender / date;
 *   - with focus outside the body, Ctrl+A selects the parent page but the
 *     iframe's content cannot be reached at all, because a cross-origin
 *     document's DOM is unreadable from the parent.
 *
 * There is no keyboard gesture that can span two documents, so "select all the
 * visible text" is simply not expressible. Instead we assemble the same content
 * as plain text from the data we already hold and hand it to the clipboard.
 *
 * Everything here is client-only (`htmlToPlainText` parses HTML through the
 * DOM), and the produced text is plain text — never HTML — so pasting it into
 * another message cannot re-inject markup.
 */

import { formatSenderWithAddress } from "shared/participants";
import type { Locale } from "shared/i18n/types";
import { formatDetailDate, htmlToPlainText } from "~/lib/utils";
import type { Email } from "~/types";

/** Localized field labels for the header block, supplied by the caller (i18n). */
export interface CopyEmailLabels {
	subject: string;
	from: string;
	to: string;
	cc: string;
	date: string;
}

/** Separator drawn between messages when more than one is copied. */
const MESSAGE_DIVIDER = "----------------------------------------";

/**
 * Render one message as a `Label: value` header block followed by its body.
 *
 * Header values are inserted verbatim (not escaped): the result is plain text
 * destined for the clipboard, so there is no markup context to escape for. The
 * body goes through `htmlToPlainText`, which both sanitises and flattens it.
 */
function formatMessage(email: Email, labels: CopyEmailLabels, locale?: Locale): string {
	const lines = [
		`${labels.subject}: ${email.subject || ""}`,
		`${labels.from}: ${formatSenderWithAddress(email.sender_name, email.sender)}`,
	];

	const recipient = email.recipient?.trim();
	if (recipient) lines.push(`${labels.to}: ${recipient}`);

	const cc = email.cc?.trim();
	if (cc) lines.push(`${labels.cc}: ${cc}`);

	if (email.date) lines.push(`${labels.date}: ${formatDetailDate(email.date, locale)}`);

	const body = email.body ? htmlToPlainText(email.body) : "";
	return body ? `${lines.join("\n")}\n\n${body}` : lines.join("\n");
}

/**
 * Build the clipboard payload for a conversation.
 *
 * `emails` must already be in display order (newest first in the panel); the
 * order is preserved as-is so the copied text matches what is on screen.
 * Returns an empty string when there is nothing to copy.
 */
export function buildEmailClipboardText(
	emails: Email[],
	labels: CopyEmailLabels,
	locale?: Locale,
): string {
	const blocks = emails
		.filter(Boolean)
		.map((email) => formatMessage(email, labels, locale))
		.filter((block) => block.trim().length > 0);

	return blocks.join(`\n\n${MESSAGE_DIVIDER}\n\n`);
}

/**
 * Write text to the clipboard, with a fallback for contexts where the async
 * Clipboard API is unavailable (insecure origin, older browser, denied
 * permission).
 *
 * The fallback uses a hidden, off-screen `<textarea>` plus the deprecated
 * `document.execCommand("copy")`, which still works while the call is attached
 * to a user gesture — which it always is here, since it runs from a click.
 *
 * @returns `true` when the text reached the clipboard.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (!text) return false;

	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Permission denied or non-secure context — fall through to the legacy path.
	}

	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.setAttribute("readonly", "");
		// Keep it out of the layout and out of the scroll position; `opacity: 0`
		// alone would still let the browser scroll the page on focus.
		textarea.style.position = "fixed";
		textarea.style.top = "-1000px";
		textarea.style.left = "-1000px";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(textarea);
		return ok;
	} catch {
		return false;
	}
}
