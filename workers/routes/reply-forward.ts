// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

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
import { z } from "zod";
import { ReplyBodySchema, ForwardBodySchema } from "../lib/schemas";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import * as dbService from "../db";
// [i18n apiSetup] Both handlers are mounted on the API app in ../index.ts
// (`app.post(".../reply", handleReplyEmail)`), so the locale middleware there
// applies and its `locale` variable is readable from the request context.
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../../shared/i18n/config";
import type { Locale } from "../../shared/i18n/types";
import { getBackendT } from "../../shared/i18n/translate";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Resolve the request locale, preferring the value the API middleware in
 * ../index.ts put on the shared request context and falling back to resolving
 * it from the request itself when this handler is invoked without it.
 */
function requestLocale(c: AppContext): Locale {
	const scoped = c.get("locale" as never) as string | undefined;
	return isLocale(scoped) ? scoped : resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/**
 * Translator scoped to the `apiSetup` namespace for the request's locale.
 *
 * The API middleware in ../index.ts only exposes `t` bound to the default
 * namespace, so we build a namespace-scoped translator here. Built lazily so
 * the happy path allocates nothing extra.
 */
function replyT(c: AppContext) {
	let t: ReturnType<typeof getBackendT> | undefined;
	return ((key: string, options?: Record<string, unknown>) => {
		t ??= getBackendT(requestLocale(c), "apiSetup");
		return t(key, options);
	}) as ReturnType<typeof getBackendT>;
}

export async function handleReplyEmail(c: AppContext) {
	const t = replyT(c);
	try {
		const mailboxId = c.req.param("mailboxId") ?? "";
		const id = c.req.param("id") ?? "";

		let rawBody: any;
		try {
			rawBody = await c.req.json();
		} catch {
			return c.json({ error: t("invalidJsonBody") }, 400);
		}

		const body = ReplyBodySchema.parse(rawBody);
		const { body: bodyContent, html, text, attachments } = body;
		const resolvedHtml = html || bodyContent || text || "";
		const resolvedText = text || undefined;

		const rawOriginal = await dbService.getEmail(c.env.DB, mailboxId, id);

		if (!rawOriginal) {
			return c.json({ error: t("originalEmailNotFound") }, 404);
		}

		// Resolve original email (follow draft -> in_reply_to chain)
		let originalEmail: EmailFull = rawOriginal;
		if (rawOriginal.folder_id === Folders.DRAFT && rawOriginal.in_reply_to) {
			const realOriginal = await dbService.getEmail(c.env.DB, mailboxId, rawOriginal.in_reply_to);
			if (realOriginal) originalEmail = realOriginal;
		}

		// Derive reply fields from the original email
		const to = originalEmail.sender ? [originalEmail.sender] : [];
		const from = mailboxId;
		// Subject prefixes are part of the outgoing RFC 5322 header, read in the
		// recipient's mail client — not UI copy. They stay English ("Re:"/"Fwd:")
		// so threading works across all mail clients and languages.
		const subject = originalEmail.subject
			? `Re: ${originalEmail.subject}`
			: "Re: (no subject)";

		const { originalMsgId, references, threadId: thread_id } = buildReferencesChain(originalEmail);

		let toStr: string, fromEmail: string, fromDomain: string;
		try {
			({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, requestLocale(c)));
		} catch (e) {
			if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
			throw e;
		}

		const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

		const rateLimit = await dbService.checkSendRateLimit(c.env.DB, mailboxId);
		if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
			return c.json({ error: t("hourlySendLimitExceeded", { count: rateLimit.hourlyCount, limit: rateLimit.hourlyLimit }) }, 429);
		}
		if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
			return c.json({ error: t("dailySendLimitExceeded", { count: rateLimit.dailyCount, limit: rateLimit.dailyLimit }) }, 429);
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
				sender_name: null, // replies are sent from the mailbox itself
				recipient: toStr,
				date: new Date().toISOString(),
				body: resolvedHtml,
				in_reply_to: originalMsgId,
				email_references: JSON.stringify(references),
				thread_id: thread_id,
				message_id: outgoingMessageId,
				raw_headers: JSON.stringify([
					{ key: "from", value: from },
					{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
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
				from,
				subject,
				html: resolvedHtml || undefined,
				text: resolvedText,
				attachments: attachments?.map((att) => ({
					content: att.content,
					filename: att.filename,
					// default only when absent (the zod schema allows both to be omitted)
					type: att.type ?? "application/octet-stream",
					disposition: att.disposition ?? "attachment",
				})),
				headers: buildThreadingHeaders(originalMsgId, references),
			}, undefined, c.env.DB, requestLocale(c));
			await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "sent");
			return c.json({ id: messageId, status: "sent" }, 200);
		} catch (e) {
			console.error("Reply delivery failed:", (e as Error).message);
			await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "failed").catch(() => {});
			return c.json({ id: messageId, status: "failed", error: (e as Error).message || t("failedToSendReply") }, 500);
		}
	} catch (error: any) {
		console.error("Reply email error:", error);
		if (error instanceof z.ZodError) {
			return c.json({ error: t("validationFailed"), details: error.errors }, 400);
		}
		return c.json({ error: error.message || t("failedToReply") }, 500);
	}
}

export async function handleForwardEmail(c: AppContext) {
	const t = replyT(c);
	try {
		const mailboxId = c.req.param("mailboxId") ?? "";
		const id = c.req.param("id") ?? "";

		let rawBody: any;
		try {
			rawBody = await c.req.json();
		} catch {
			return c.json({ error: t("invalidJsonBody") }, 400);
		}

		const body = ForwardBodySchema.parse(rawBody);
		const { to: rawTo, body: bodyContent, html, text, attachments } = body;
		const resolvedHtml = html || bodyContent || text || "";
		const resolvedText = text || undefined;

		const rawOriginal = await dbService.getEmail(c.env.DB, mailboxId, id);

		if (!rawOriginal) {
			return c.json({ error: t("originalEmailNotFound") }, 404);
		}

		// Derive forward fields from the original email
		const from = mailboxId;
		// Subject prefixes are part of the outgoing RFC 5322 header, read in the
		// recipient's mail client — not UI copy. They stay English ("Fwd:")
		// so threading works across all mail clients and languages.
		const subject = rawOriginal.subject
			? `Fwd: ${rawOriginal.subject}`
			: "Fwd: (no subject)";

		// Fill to from original email if not provided
		const to: string[] = rawTo
			? (Array.isArray(rawTo) ? rawTo : [rawTo])
			: rawOriginal.sender
				? [rawOriginal.sender]
				: [];

		let toStr: string, fromEmail: string, fromDomain: string;
		try {
			({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, requestLocale(c)));
		} catch (e) {
			if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
			throw e;
		}

		const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

		const rateLimit = await dbService.checkSendRateLimit(c.env.DB, mailboxId);
		if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
			return c.json({ error: t("hourlySendLimitExceeded", { count: rateLimit.hourlyCount, limit: rateLimit.hourlyLimit }) }, 429);
		}
		if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
			return c.json({ error: t("dailySendLimitExceeded", { count: rateLimit.dailyCount, limit: rateLimit.dailyLimit }) }, 429);
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
				sender_name: null, // forwards are sent from the mailbox itself
				recipient: toStr,
				// NOTE: ForwardBodySchema has no cc/bcc, so the old expressions were
				// always `undefined` -> NULL. Kept as explicit NULLs (unchanged runtime).
				cc: null,
				bcc: null,
				date: new Date().toISOString(),
				body: resolvedHtml,
				in_reply_to: null,
				email_references: null,
				thread_id: messageId,
				message_id: outgoingMessageId,
				raw_headers: JSON.stringify([
					{ key: "from", value: from },
					{ key: "to", value: to.join(", ") },
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
				// ForwardBodySchema exposes no cc/bcc; the old shorthand spread
				// `undefined` into the params object (a no-op for sendEmail).
				from,
				subject,
				html: resolvedHtml || undefined,
				text: resolvedText,
				attachments: attachments?.map((att) => ({
					content: att.content,
					filename: att.filename,
					// default only when absent (the zod schema allows both to be omitted)
					type: att.type ?? "application/octet-stream",
					disposition: att.disposition ?? "attachment",
				})),
			}, undefined, c.env.DB, requestLocale(c));
			await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "sent");
			return c.json({ id: messageId, status: "sent" }, 200);
		} catch (e) {
			console.error("Forward delivery failed:", (e as Error).message);
			await dbService.updateEmailSendStatus(c.env.DB, mailboxId, messageId, "failed").catch(() => {});
			return c.json({ id: messageId, status: "failed", error: (e as Error).message || t("failedToForwardEmail") }, 500);
		}
	} catch (error: any) {
		console.error("Forward email error:", error);
		if (error instanceof z.ZodError) {
			return c.json({ error: t("validationFailed"), details: error.errors }, 400);
		}
		return c.json({ error: error.message || t("failedToForward") }, 500);
	}
}
