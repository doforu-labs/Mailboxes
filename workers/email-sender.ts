// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Resend API.
 *
 * Uses the Resend REST API (https://api.resend.com/emails) to send emails.
 * Works on Workers Free plan — no need for Workers Paid's send_email binding.
 *
 * API key resolution: per-mailbox R2 settings → per-domain DB record → error.
 *
 * See: https://resend.com/docs/api-reference/emails/send-email
 */

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

import { fetchWithTimeout } from "./lib/fetch-with-timeout";

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Format a `from` / `replyTo` field value into the "Name <email>" string
 * that the Resend API expects.
 */
function formatAddress(field: string | { email: string; name?: string }): string {
	if (typeof field === "string") return field;
	return field.name ? `${field.name} <${field.email}>` : field.email;
}

/**
 * Send an email using the Resend API.
 *
 * @param apiKey - Resend API key
 * @param params - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On API errors (HTTP non-2xx)
 */
export async function sendEmail(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const body: Record<string, unknown> = {
		from: formatAddress(params.from),
		to: Array.isArray(params.to) ? params.to : [params.to],
		subject: params.subject,
	};

	if (params.html) body.html = params.html;
	if (params.text) body.text = params.text;
	if (params.cc) body.cc = Array.isArray(params.cc) ? params.cc : [params.cc];
	if (params.bcc) body.bcc = Array.isArray(params.bcc) ? params.bcc : [params.bcc];
	if (params.replyTo) body.reply_to = formatAddress(params.replyTo);
	if (params.headers && Object.keys(params.headers).length > 0) {
		body.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		body.attachments = params.attachments.map((att) => ({
			filename: att.filename,
			content: att.content,
			content_type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const response = await fetchWithTimeout(RESEND_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => null)) as {
			message?: string;
		} | null;
		throw new Error(err?.message || `Resend API error: ${response.status}`);
	}

	let data: { id?: string } = {};
	try {
		data = (await response.json()) as { id?: string };
	} catch {
		console.warn("Failed to parse Resend response JSON, using fallback");
	}
	return { messageId: data?.id || "" };
}

/**
 * Read the Resend API key from mailbox settings (stored in R2).
 * Each mailbox must have its own API key configured via Settings.
 *
 * @param bucket      - R2 bucket (c.env.BUCKET)
 * @param mailboxId   - Mailbox email address (used as the R2 key)
 * @param params      - Email parameters
 * @param db          - Optional D1 database (unused, kept for API compatibility)
 * @returns The send result with messageId
 */
export async function sendEmailFromMailbox(
	bucket: R2Bucket,
	mailboxId: string,
	params: SendEmailParams,
	_fallbackKey?: string,
	db?: D1Database,
): Promise<{ messageId: string }> {
	// 1. Read API key from mailbox settings in R2 (per-mailbox, highest priority)
	const obj = await bucket.get(`mailboxes/${mailboxId}.json`);
	if (obj) {
		let settings: { resendApiKey?: string } = {};
		try {
			settings = (await obj.json()) as { resendApiKey?: string };
		} catch {
			console.warn(`Failed to parse mailbox config for ${mailboxId}, falling back to D1`);
		}
		if (settings.resendApiKey) {
			return sendEmail(settings.resendApiKey, params);
		}
	}

	// 2. Fallback: per-domain resend_api_key from domains table
	if (db) {
		try {
			const atIdx = mailboxId.indexOf("@");
			if (atIdx !== -1) {
				const domainName = mailboxId.substring(atIdx + 1).toLowerCase();
				const result = await db
					.prepare("SELECT resend_api_key FROM domains WHERE name = ?")
					.bind(domainName)
					.first<{ resend_api_key?: string | null }>();
				if (result?.resend_api_key) {
					return sendEmail(result.resend_api_key, params);
				}
			}
		} catch {
			// Ignore domain lookup errors
		}
	}

	throw new Error(
		"Resend API key not configured for this mailbox. Go to Settings > Account to add one,\nor set a domain-level API key in Domain Settings.",
	);
}
