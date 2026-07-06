// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resend Inbound Webhook handler.
 *
 * Processes incoming emails forwarded by Resend for domains NOT on
 * Cloudflare DNS (e.g., Vercel). The flow is:
 *   1. Resend sends a webhook POST with metadata (email_id, from, to, etc.)
 *   2. We call Resend's GET /emails/receiving/{email_id} for full content
 *   3. We download attachments from Resend
 *   4. We store everything (metadata + attachments) exactly like receiveEmail()
 */

import type { Env } from "./types";
import { Folders } from "../shared/folders";
import type { StoredAttachment } from "./lib/attachments";
import * as dbService from "./db";

// ── Types ──────────────────────────────────────────────────────────

interface ResendAttachment {
	id: string;
	filename: string;
	content_type: string;
	content_disposition: string | null;
	content_id: string | null;
}

export interface ResendInboundPayload {
	type: "email.received";
	created_at: string;
	data: {
		email_id: string;
		created_at: string;
		from: string;
		to: string[];
		bcc: string[];
		cc: string[];
		received_for: string[];
		message_id: string;
		subject: string;
		attachments: ResendAttachment[];
	};
}

interface ResendFullEmail {
	email_id: string;
	created_at: string;
	from: string;
	to: string[];
	bcc: string[];
	cc: string[];
	received_for: string[];
	message_id: string;
	subject: string;
	html: string | null;
	text: string | null;
	headers: Array<{ key: string; value: string }>;
	attachments: Array<ResendAttachment & { size: number }>;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Parse a from-address that may include a display name.
 * Examples: "Acme <onboarding@resend.dev>" → "onboarding@resend.dev"
 *           "user@example.com" → "user@example.com"
 */
function parseFromAddress(from: string): { name: string | null; address: string } {
	const match = from.match(/^"?(.+?)"?\s*<([^>]+)>$/);
	if (match) {
		return { name: match[1].trim(), address: match[2].trim().toLowerCase() };
	}
	return { name: null, address: from.trim().toLowerCase() };
}

/**
 * Extract a raw message-id value by stripping angle brackets and
 * whitespace. Falls back to the first whitespace-delimited token.
 */
function extractMsgId(s: string): string {
	const m = s.match(/<([^>]+)>/);
	return m ? m[1] : s.trim().split(/\s+/)[0];
}

/**
 * Find a specific header value from an array of { key, value } headers
 * (case-insensitive key lookup).
 */
function findHeader(
	headers: Array<{ key: string; value: string }>,
	name: string,
): string | null {
	const lower = name.toLowerCase();
	for (const h of headers) {
		if (h.key.toLowerCase() === lower) return h.value;
	}
	return null;
}

/**
 * Get the Resend API key, checking mailbox-specific settings first,
 * then falling back to the global env variable.
 */
async function getResendApiKey(
	env: Env,
	mailboxId: string,
): Promise<string | null> {
	// Check mailbox-specific settings
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			if (typeof settings.resendApiKey === "string" && settings.resendApiKey) {
				return settings.resendApiKey;
			}
		}
	} catch {
		// Ignore read errors — fall through to env var
	}

	// Fall back to global env variable
	return env.RESEND_API_KEY ?? null;
}

// ── Main Handler ───────────────────────────────────────────────────

export async function handleResendInbound(
	payload: ResendInboundPayload,
	env: Env,
	ctx: ExecutionContext,
): Promise<{ ok: boolean }> {
	const { data } = payload;

	// ── 1. Determine mailboxId from received_for or to addresses ──

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map(
		(a) => a.toLowerCase(),
	);

	// Prefer received_for (the original recipient address) over `to`
	const candidateAddresses = [
		...data.received_for.map((a) => a.toLowerCase()),
		...data.to.map((a) => a.toLowerCase()),
	];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = candidateAddresses.find((addr) =>
			allowedAddresses.includes(addr),
		);
		if (!mailboxId) {
			console.log(
				`Ignoring Resend inbound: no recipient matches EMAIL_ADDRESSES. Received: ${candidateAddresses.join(", ")}`,
			);
			return { ok: true }; // Silently ignore — not for us
		}
	} else {
		mailboxId = candidateAddresses[0];
	}

	if (!mailboxId) {
		throw new Error("Resend inbound email has no valid recipient address");
	}

	// ── 2. Check mailbox exists ──

	const mailboxKey = `mailboxes/${mailboxId}.json`;
	if (!(await env.BUCKET.head(mailboxKey))) {
		console.log(
			`Ignoring Resend inbound for ${mailboxId}: mailbox does not exist`,
		);
		return { ok: true };
	}

	// ── 3. Get Resend API key ──

	const apiKey = await getResendApiKey(env, mailboxId);
	if (!apiKey) {
		console.error(
			`Cannot process Resend inbound for ${mailboxId}: no RESEND_API_KEY configured`,
		);
		return { ok: false };
	}

	const baseUrl = "https://api.resend.com";

	// ── 4. Fetch full email content from Resend API ──

	const emailResponse = await fetch(
		`${baseUrl}/emails/receiving/${data.email_id}`,
		{
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		},
	);

	if (!emailResponse.ok) {
		throw new Error(
			`Resend API error fetching email ${data.email_id}: ${emailResponse.status} ${emailResponse.statusText}`,
		);
	}

	const fullEmail: ResendFullEmail = await emailResponse.json();

	// ── 5. Parse sender / recipients ──

	const { address: senderAddress } = parseFromAddress(fullEmail.from);
	const sender = senderAddress.toLowerCase();

	const allRecipients = fullEmail.to
		.map((a) => a.toLowerCase())
		.filter(Boolean);
	const ccRecipients = (fullEmail.cc || [])
		.map((a) => a.toLowerCase())
		.filter(Boolean);
	const bccRecipients = (fullEmail.bcc || [])
		.map((a) => a.toLowerCase())
		.filter(Boolean);

	// ── 6. Download & store attachments in R2 ──

	const messageId = crypto.randomUUID();
	const attachmentData: StoredAttachment[] = [];

	if (fullEmail.attachments && fullEmail.attachments.length > 0) {
		for (const att of fullEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(
				/[\/\\:*?"<>|\x00-\x1f]/g,
				"_",
			);

			// Download attachment binary from Resend
			const attResponse = await fetch(
				`${baseUrl}/emails/receiving/${data.email_id}/attachments/${att.id}/download`,
				{
					headers: {
						Authorization: `Bearer ${apiKey}`,
					},
				},
			);

			if (!attResponse.ok) {
				console.error(
					`Failed to download attachment ${att.id} (${att.filename}): ${attResponse.status}`,
				);
				// Skip this attachment but continue processing
				continue;
			}

			const attBuffer = await attResponse.arrayBuffer();
			await env.BUCKET.put(
				`attachments/${messageId}/${attId}/${filename}`,
				attBuffer,
			);

			attachmentData.push({
				id: attId,
				email_id: messageId,
				filename,
				mimetype: att.content_type,
				size: attBuffer.byteLength,
				content_id: att.content_id || null,
				disposition: att.content_disposition || "attachment",
			});
		}
	}

	// ── 7. Extract threading info ──

	const headers = fullEmail.headers || [];

	const inReplyToRaw = findHeader(headers, "in-reply-to");
	const inReplyTo = inReplyToRaw ? extractMsgId(inReplyToRaw) : null;

	const referencesRaw = findHeader(headers, "references");
	const emailReferences = referencesRaw
		? referencesRaw
				.split(/\s+/)
				.filter(Boolean)
				.map(extractMsgId)
		: [];

	const originalMessageId = data.message_id
		? extractMsgId(data.message_id)
		: null;

	// ── 8. Determine threadId ──

	const db = env.DB as unknown as D1Database;
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		// Fallback: try matching by subject
		try {
			const subjectThread = await dbService.findThreadBySubject(
				db,
				mailboxId,
				fullEmail.subject || "",
				sender || undefined,
			);
			if (subjectThread) threadId = subjectThread;
		} catch {
			// If findThreadBySubject fails, keep the default threadId
		}
	}

	// ── 9. Build raw_headers from the Resend headers array ──

	const rawHeaders = JSON.stringify(
		headers.length > 0
			? headers
			: [
					{ key: "from", value: fullEmail.from },
					{ key: "to", value: fullEmail.to.join(", ") },
					...(fullEmail.cc?.length
						? [{ key: "cc", value: fullEmail.cc.join(", ") }]
						: []),
					{ key: "subject", value: fullEmail.subject },
					{ key: "date", value: fullEmail.created_at },
					{ key: "message-id", value: `<${data.message_id}>` },
				],
	);

	// ── 10. Create email in D1 ──

	await dbService.createEmail(
		db,
		mailboxId,
		Folders.INBOX,
		{
			id: messageId,
			subject: fullEmail.subject || "",
			sender,
			recipient: allRecipients.join(", "),
			cc: ccRecipients.join(", ") || null,
			bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(),
			body: fullEmail.html || fullEmail.text || "",
			in_reply_to: inReplyTo,
			email_references:
				emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: threadId,
			message_id: originalMessageId,
			raw_headers: rawHeaders,
		},
		attachmentData,
	);

	return { ok: true };
}
