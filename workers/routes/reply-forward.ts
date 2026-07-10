// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmailFromMailbox } from "../email-sender";
import { storeAttachments } from "../lib/attachments";
import type { EmailFull } from "../db";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "../lib/email-helpers";
import { SendEmailRequestSchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import * as dbService from "../db";

type AppContext = Context<{ Bindings: Env }>;

export async function handleReplyEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const rawOriginal = await dbService.getEmail(c.env.DB, mailboxId, id);

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	// Resolve original email (follow draft -> in_reply_to chain)
	let originalEmail: EmailFull = rawOriginal;
	if (rawOriginal.folder_id === Folders.DRAFT && rawOriginal.in_reply_to) {
		const realOriginal = await dbService.getEmail(c.env.DB, mailboxId, rawOriginal.in_reply_to);
		if (realOriginal) originalEmail = realOriginal;
	}

	const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimit = await dbService.checkSendRateLimit(c.env.DB, mailboxId);
	if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
		return c.json({ error: `Hourly send limit exceeded (${rateLimit.hourlyCount}/${rateLimit.hourlyLimit}). Please try again later.` }, 429);
	}
	if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
		return c.json({ error: `Daily send limit exceeded (${rateLimit.dailyCount}/${rateLimit.dailyLimit}). Please try again later.` }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await dbService.createEmail(
		c.env.DB,
		mailboxId,
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id: thread_id,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
				...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
				...(references.length > 0 ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
			]),
			send_status: "sending",
		},
		attachmentData,
	);

	await dbService.markThreadRead(c.env.DB, mailboxId, thread_id);

	try {
		await sendEmailFromMailbox(c.env.BUCKET, mailboxId, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: buildThreadingHeaders(originalMsgId, references),
		}, c.env.RESEND_API_KEY, c.env.DB);
		await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "sent");
		return c.json({ id: messageId, status: "sent" }, 200);
	} catch (e) {
		console.error("Reply delivery failed:", (e as Error).message);
		await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "failed").catch(() => {});
		return c.json({ id: messageId, status: "failed", error: (e as Error).message || "Failed to send reply." }, 500);
	}
}

export async function handleForwardEmail(c: AppContext) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	const rawOriginal = await dbService.getEmail(c.env.DB, mailboxId, id);

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rateLimit = await dbService.checkSendRateLimit(c.env.DB, mailboxId);
	if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
		return c.json({ error: `Hourly send limit exceeded (${rateLimit.hourlyCount}/${rateLimit.hourlyLimit}). Please try again later.` }, 429);
	}
	if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
		return c.json({ error: `Daily send limit exceeded (${rateLimit.dailyCount}/${rateLimit.dailyLimit}). Please try again later.` }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await dbService.createEmail(
		c.env.DB,
		mailboxId,
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(),
			body: html || text || "",
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
			send_status: "sending",
		},
		attachmentData,
	);

	try {
		await sendEmailFromMailbox(c.env.BUCKET, mailboxId, {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
		}, c.env.RESEND_API_KEY, c.env.DB);
		await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "sent");
		return c.json({ id: messageId, status: "sent" }, 200);
	} catch (e) {
		console.error("Forward delivery failed:", (e as Error).message);
		await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "failed").catch(() => {});
		return c.json({ id: messageId, status: "failed", error: (e as Error).message || "Failed to forward email." }, 500);
	}
}
