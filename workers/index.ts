// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import setup from "./setup";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmailFromMailbox } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type D1MailboxContext } from "./lib/d1-middleware";
import { handleResendInbound } from "./inbound";
import * as db from "./db";
import type { SearchFilterOptions, EmailFull } from "./db";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolMarkEmailRead,
	toolMoveEmail,
	toolDiscardDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
} from "./lib/tools";

type AppContext = Context<D1MailboxContext>;

// Local type for AI text generation output (available in CF Workers runtime)
export interface AiToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface AiTextGenerationOutput {
	response?: string;
	choices?: {
		message?: {
			content?: string | null;
			tool_calls?: AiToolCall[];
		};
	}[];
	tool_calls?: Array<{
		name: string;
		arguments: Record<string, unknown>;
	}>;
}

export interface AiChatMessage {
	role: string;
	content: string | null;
	tool_calls?: AiToolCall[];
}

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().regex(/^[a-z0-9*][a-z0-9.*_-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i, "Invalid email address"),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<D1MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// ── Setup routes (exempt from JWT — mounted before auth checks) ──
app.route("/", setup);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	// Derive domains dynamically from existing mailboxes in R2
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const domainSet = new Set<string>();
	for (const m of allMailboxes) {
		const domain = m.id.split("@")[1];
		if (domain) domainSet.add(domain);
	}
	return c.json({ domains: Array.from(domainSet), emailAddresses: allMailboxes.map(m => m.id) });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings, created_at: new Date().toISOString() };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	await db.initMailboxFolders(c.env.DB, email);
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

// ── Resend API Key verification ────────────────────────────────

interface ResendDomainRecord {
	id: string;
	name: string;
	status: string;
	records: Array<{
		record: string;
		name: string;
		type: string;
		ttl: string;
		status: string;
		value: string;
		priority?: number;
	}>;
}

app.post("/api/v1/mailboxes/:mailboxId/verify-resend", async (c: AppContext) => {
	try {
		const { apiKey } = (await c.req.json()) as { apiKey?: string };
		if (!apiKey) {
			return c.json({ valid: false, error: "Missing API key" }, 400);
		}

		// Call Resend GET /domains to verify the key is valid
		const res = await fetch("https://api.resend.com/domains", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (res.status === 401 || res.status === 403) {
			return c.json({ valid: false, error: "Invalid API key. Please check your Resend API key." }, 200);
		}

		if (!res.ok) {
			const errBody = await res.json().catch(() => ({})) as { message?: string };
			return c.json({ valid: false, error: errBody.message || `Resend API error: ${res.status}` }, 200);
		}

		const data = (await res.json()) as { data: ResendDomainRecord[] };
		const domains = data.data ?? [];

		// Extract the mailbox's email domain
		const mailboxId = c.var.mailboxId;
		const atIdx = mailboxId.indexOf("@");
		const emailDomain = atIdx !== -1 ? mailboxId.substring(atIdx + 1).toLowerCase() : "";

		// Find matching domain and its status
		const matchingDomain = domains.find((d) => d.name.toLowerCase() === emailDomain);

		return c.json({
			valid: true,
			domains: domains.map((d) => ({
				id: d.id,
				domain: d.name,
				status: d.status,
			})),
			matchingDomain: matchingDomain
				? { domain: matchingDomain.name, status: matchingDomain.status }
				: null,
			sendingReady: !!matchingDomain && (matchingDomain.status === "valid" || matchingDomain.status === "verified"),
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ valid: false, error: `Verification failed: ${msg}` }, 200);
	}
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete D1 data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as string | undefined;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const dbClient = c.var.db;
	const mailboxId = c.var.mailboxId;

	if (threaded && folder) {
		const emails = await db.getThreadedEmails(dbClient, mailboxId, { folder, page, limit });
		const totalCount = await db.countThreadedEmails(dbClient, mailboxId, folder);
		return c.json({ emails, totalCount });
	}
	const emails = await db.getEmails(dbClient, mailboxId, { folder, threadId: thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await db.countEmails(dbClient, mailboxId, folder, thread_id);
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const dbClient = c.var.db;

	const rateLimit = await db.checkSendRateLimit(dbClient, mailboxId);
	if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
		return c.json({ error: `Hourly rate limit exceeded (${rateLimit.hourlyCount}/${rateLimit.hourlyLimit})` }, 429);
	}
	if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
		return c.json({ error: `Daily rate limit exceeded (${rateLimit.dailyCount}/${rateLimit.dailyLimit})` }, 429);
	}

	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await db.createEmail(dbClient, mailboxId, Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
		send_status: "sending",
	}, attachmentData);

	try {
		await sendEmailFromMailbox(c.env.BUCKET, mailboxId, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		});
		await db.updateEmailSendStatus(c.var.db, mailboxId, messageId, "sent");
		return c.json({ id: messageId, status: "sent" }, 200);
	} catch (e) {
		console.error("Email delivery failed:", (e as Error).message);
		await db.updateEmailSendStatus(c.var.db, mailboxId, messageId, "failed").catch(() => {});
		return c.json({ id: messageId, status: "failed", error: (e as Error).message || "Failed to send email." }, 500);
	}
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const dbClient = c.var.db;
	if (draft_id) await db.deleteEmail(dbClient, mailboxId, draft_id);
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await db.createEmail(dbClient, mailboxId, Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.delete("/api/v1/mailboxes/:mailboxId/drafts/:emailId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachments = await db.deleteEmail(c.var.db, c.var.mailboxId, emailId);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att: { id: string; filename: string }) => `attachments/${emailId}/${att.id}/${att.filename}`));
	}
	return c.body(null, 204);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await db.getEmail(c.var.db, c.var.mailboxId, c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await db.updateEmail(c.var.db, c.var.mailboxId, c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await db.deleteEmail(c.var.db, c.var.mailboxId, id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att: { id: string; filename: string }) => `attachments/${id}/${att.id}/${att.filename}`));
	}
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await db.moveEmail(c.var.db, c.var.mailboxId, c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await db.getThreadEmails(c.var.db, c.var.mailboxId, c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await db.markThreadRead(c.var.db, c.var.mailboxId, c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Inbound Webhooks ---------------------------------------------

app.post("/api/v1/inbound/resend", async (c) => {
	const payload = await c.req.json();
	await handleResendInbound(payload, c.env, c.executionCtx as unknown as ExecutionContext);
	return c.json({ ok: true });
});

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await db.getFolders(c.var.db, c.var.mailboxId)));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await db.createFolder(c.var.db, c.var.mailboxId, slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await db.updateFolder(c.var.db, c.var.mailboxId, c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await db.deleteFolder(c.var.db, c.var.mailboxId, c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: SearchFilterOptions = {
		query: c.req.query("query") || "", folder: c.req.query("folder") ?? undefined, from: c.req.query("from") ?? undefined,
		to: c.req.query("to") ?? undefined, subject: c.req.query("subject") ?? undefined,
		date_start: c.req.query("date_start") ?? undefined,
		date_end: c.req.query("date_end") ?? undefined, is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const dbClient = c.var.db;
	const mailboxId = c.var.mailboxId;
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const emails = await db.searchEmails(dbClient, mailboxId, { ...searchOpts, page, limit });
	const totalCount = await db.countSearchResults(dbClient, mailboxId, searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await db.getAttachment(c.var.db, c.var.mailboxId, attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- AI Chat (SSE streaming) -----------------------------------------

function buildAiMessages(history: any[], emailContext?: any, email?: any, thread?: any[]): { role: string; content: string }[] {
	const systemPrompt = `You are an email assistant integrated with the user's mailbox.

## Capabilities
You can search emails, read messages, manage folders, draft and send replies using the tools available to you. When the user asks about their emails, use the appropriate tools to look up real data.

## Tool Use Guidelines
- ONLY call tools when the user asks about their specific emails or wants to perform an action
- For general questions like "what can you do" or "hello", answer directly WITHOUT calling any tools
- When you get empty results from a tool (no emails found), tell the user what happened and suggest next steps - do NOT call the same tool again
- Use search_emails when the user asks about specific content or keywords
- Use list_emails to browse folders
- Use get_email to read a specific email in full
- Use draft_reply to compose a reply (saves to Drafts for user review)
- Use send_reply / send_email only when the user explicitly says to send
- If you don't know something, use tools to look it up before guessing
- Always provide a helpful text response along with any tool actions

Keep responses concise and helpful.`;

	const msgs: { role: string; content: string }[] = [
		{ role: "system", content: systemPrompt },
		...history.map((m: any) => ({ role: m.role, content: m.content })),
	];

	if (email) {
		msgs.push({
			role: "system",
			content: `The user is currently viewing this email:\nFrom: ${email.sender}\nSubject: ${email.subject}\nDate: ${email.date}\nBody: ${email.body?.substring(0, 2000)}`,
		});
	}
	if (thread && thread.length > 0) {
		const threadSummary = thread
			.map((e: any) => `[${e.sender}] ${e.subject}: ${e.body?.substring(0, 200)}`)
			.join("\n---\n");
		msgs.push({
			role: "system",
			content: `Full thread context:\n${threadSummary.substring(0, 3000)}`,
		});
	}

	return msgs;
}

// ── Tool Definitions (OpenAI-compatible format) ──────────────────────

const TOOL_DEFINITIONS = [
	{
		name: "list_mailboxes",
		description: "List all available mailboxes/email accounts",
		parameters: { type: "object", properties: {}, required: [] },
	},
	{
		name: "list_emails",
		description: "List emails in a folder. Use this to browse the user's inbox, sent, drafts, archive, or trash.",
		parameters: {
			type: "object",
			properties: {
				folder: { type: "string", description: "Folder to list: inbox, sent, draft, archive, trash" },
				limit: { type: "number", description: "Max emails to return (default 20)" },
				page: { type: "number", description: "Page number (default 1)" },
			},
			required: ["folder"],
		},
	},
	{
		name: "search_emails",
		description: "Search emails across all folders by keyword, sender, subject, etc.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query keywords" },
				folder: { type: "string", description: "Optional folder to narrow search" },
			},
			required: ["query"],
		},
	},
	{
		name: "get_email",
		description: "Get the full details and body of a single email by its ID",
		parameters: {
			type: "object",
			properties: {
				emailId: { type: "string", description: "The email ID" },
			},
			required: ["emailId"],
		},
	},
	{
		name: "get_thread",
		description: "Get all emails in a conversation thread by thread ID",
		parameters: {
			type: "object",
			properties: {
				threadId: { type: "string", description: "The thread ID" },
			},
			required: ["threadId"],
		},
	},
	{
		name: "draft_reply",
		description: "Draft a reply to an email (saves to Drafts folder without sending). The user must review and confirm before sending.",
		parameters: {
			type: "object",
			properties: {
				originalEmailId: { type: "string", description: "ID of the email being replied to" },
				to: { type: "string", description: "Recipient email address" },
				subject: { type: "string", description: "Reply subject line" },
				body: { type: "string", description: "Reply body text (plain text, will be converted to HTML)" },
			},
			required: ["originalEmailId", "to", "subject", "body"],
		},
	},
	{
		name: "draft_email",
		description: "Draft a new email (saves to Drafts folder without sending). The user must review and confirm before sending.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Recipient email address" },
				subject: { type: "string", description: "Email subject" },
				body: { type: "string", description: "Email body text (plain text, will be converted to HTML)" },
			},
			required: ["to", "subject", "body"],
		},
	},
	{
		name: "update_draft",
		description: "Update an existing draft in the Drafts folder with new content",
		parameters: {
			type: "object",
			properties: {
				draftId: { type: "string", description: "ID of the draft to update" },
				to: { type: "string", description: "Updated recipient email address" },
				subject: { type: "string", description: "Updated subject" },
				bodyHtml: { type: "string", description: "Updated body as HTML" },
			},
			required: ["draftId"],
		},
	},
	{
		name: "mark_email_read",
		description: "Mark an email as read or unread",
		parameters: {
			type: "object",
			properties: {
				emailId: { type: "string", description: "The email ID" },
				read: { type: "boolean", description: "true = mark as read, false = mark as unread" },
			},
			required: ["emailId", "read"],
		},
	},
	{
		name: "move_email",
		description: "Move an email to a different folder (e.g., archive, trash)",
		parameters: {
			type: "object",
			properties: {
				emailId: { type: "string", description: "The email ID" },
				folderId: { type: "string", description: "Target folder: inbox, sent, draft, archive, trash" },
			},
			required: ["emailId", "folderId"],
		},
	},
	{
		name: "delete_email",
		description: "Permanently delete an email",
		parameters: {
			type: "object",
			properties: {
				emailId: { type: "string", description: "The email ID to delete" },
			},
			required: ["emailId"],
		},
	},
	{
		name: "discard_draft",
		description: "Discard (delete) a draft from the Drafts folder",
		parameters: {
			type: "object",
			properties: {
				draftId: { type: "string", description: "The draft ID to discard" },
			},
			required: ["draftId"],
		},
	},
	{
		name: "send_reply",
		description: "Send a reply to an email immediately. This will deliver the email to the recipient. Use this only when the user explicitly asks to send.",
		parameters: {
			type: "object",
			properties: {
				originalEmailId: { type: "string", description: "ID of the email being replied to" },
				to: { type: "string", description: "Recipient email address" },
				subject: { type: "string", description: "Reply subject line" },
				bodyHtml: { type: "string", description: "Reply body as HTML" },
			},
			required: ["originalEmailId", "to", "subject", "bodyHtml"],
		},
	},
	{
		name: "send_email",
		description: "Send a new email immediately. This will deliver the email to the recipient. Use only when the user explicitly asks to send.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Recipient email address" },
				subject: { type: "string", description: "Email subject" },
				bodyHtml: { type: "string", description: "Email body as HTML" },
			},
			required: ["to", "subject", "bodyHtml"],
		},
	},
] as const;

// ── Tool Execution Dispatch ────────────────────────────────────────

/** Ensure default folders exist for a mailbox (safe to call repeatedly) */
async function ensureFoldersExist(database: D1Database, mailboxId: string): Promise<void> {
	const existing = await database
		.prepare("SELECT COUNT(*) as cnt FROM folders WHERE mailbox_id = ?")
		.bind(mailboxId)
		.first<{ cnt: number }>();
	if (existing && existing.cnt > 0) return;
	await db.initMailboxFolders(database, mailboxId);
}

async function executeToolCall(
	toolCall: AiToolCall,
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	bucket: R2Bucket,
): Promise<any> {
	const { name, arguments: argsStr } = toolCall.function;
	const args = JSON.parse(argsStr);

	// Auto-seed folders for mailbox-dependent tools
	const mailboxTools = new Set(["search_emails", "list_emails", "get_email", "get_thread", "draft_reply", "draft_email", "update_draft", "mark_email_read", "move_email", "delete_email", "discard_draft", "send_reply", "send_email"]);
	if (mailboxTools.has(name)) {
		await ensureFoldersExist(db, mailboxId);
	}

	try {
		switch (name) {
			case "search_emails":
				return await toolSearchEmails(db, mailboxId, args);
			case "list_emails":
				return await toolListEmails(db, mailboxId, args);
			case "get_email":
				return await toolGetEmail(db, mailboxId, args.emailId);
			case "get_thread":
				return await toolGetThread(db, mailboxId, args.threadId);
			case "draft_reply":
				return await toolDraftReply(db, mailboxId, ai, args);
			case "draft_email":
				return await toolDraftEmail(db, mailboxId, ai, args);
			case "update_draft":
				return await toolUpdateDraft(db, mailboxId, ai, args);
			case "mark_email_read":
				return await toolMarkEmailRead(db, mailboxId, args.emailId, args.read);
			case "move_email":
				return await toolMoveEmail(db, mailboxId, args.emailId, args.folderId);
			case "delete_email":
				return await toolDeleteEmail(db, mailboxId, args.emailId);
			case "discard_draft":
				return await toolDiscardDraft(db, mailboxId, args.draftId);
			case "send_reply":
				return await toolSendReply(db, mailboxId, ai, bucket, args);
			case "send_email":
				return await toolSendEmail(db, mailboxId, ai, bucket, args);
			case "list_mailboxes":
				return await toolListMailboxes({ BUCKET: bucket, DB: db } as any);
			default:
				return { error: `Unknown tool: ${name}` };
		}
	} catch (e: any) {
		return { error: `Tool ${name} failed: ${e.message}` };
	}
}

// ── AI Provider Helpers ───────────────────────────────────────────

interface AiProviderCfg {
	provider: "cloudflare" | "openai-compatible";
	baseUrl?: string;
	modelName?: string;
	apiKey?: string;
}

/** Load AI provider settings from R2 mailbox config */
async function loadAiProvider(bucket: R2Bucket, mailboxId: string): Promise<AiProviderCfg | null> {
	try {
		const obj = await bucket.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return null;
		const settings: any = await obj.json();
		const cfg = settings?.aiProvider as AiProviderCfg | undefined;
		return cfg?.provider === "openai-compatible" && cfg?.baseUrl ? cfg : null;
	} catch {
		return null;
	}
}

/** Unified AI call — either Cloudflare Workers AI or OpenAI-compatible API */
async function callAi(
	ai: Ai,
	bucket: R2Bucket,
	mailboxId: string,
	messages: any[],
	model: string,
	fallback: string,
	withTools: boolean,
): Promise<AiTextGenerationOutput | null> {
	const providerCfg = await loadAiProvider(bucket, mailboxId);

	if (providerCfg?.apiKey) {
		// ── OpenAI-compatible provider (falls back to CF on failure) ──
		const body: Record<string, any> = {
			model: providerCfg.modelName || model,
			messages,
			stream: false,
		};
		if (withTools) {
			body.tools = TOOL_DEFINITIONS;
		}
		try {
			const res = await fetch(`${providerCfg.baseUrl!.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${providerCfg.apiKey}`,
				},
				body: JSON.stringify(body),
			});
			if (res.ok) {
				return (await res.json()) as unknown as AiTextGenerationOutput;
			}
			const errText = await res.text().catch(() => "");
			console.error(`[AI Provider] ${res.status} from ${providerCfg.baseUrl}: ${errText} — falling back to Cloudflare`);
		} catch (e) {
			console.error(`[AI Provider] fetch failed:`, e, "— falling back to Cloudflare");
		}
	}

	// ── Cloudflare Workers AI (fallback) ──
	try {
		const params: any = { messages };
		if (withTools) params.tools = TOOL_DEFINITIONS;
		return (await ai.run(model, params)) as unknown as AiTextGenerationOutput;
	} catch {
		try {
			const params: any = { messages };
			if (withTools) params.tools = TOOL_DEFINITIONS;
			return (await ai.run(fallback, params)) as unknown as AiTextGenerationOutput;
		} catch {
			return null;
		}
	}
}

app.post("/api/v1/mailboxes/:mailboxId/ai/chat", async (c: AppContext) => {
	const { message, emailContext } = await c.req.json<{ message: string; emailContext?: { emailId?: string; threadId?: string } }>();
	const mailboxId = c.var.mailboxId;
	const d1 = c.var.db;
	const ai = c.env.AI;
	const bucket = c.env.BUCKET;

	if (!message || typeof message !== "string") {
		return c.json({ error: "message is required" }, 400);
	}

	if (message.length > 10000) {
		return c.json({ error: "message too long" }, 400);
	}

	// Save user message
	await db.saveAiMessage(d1, mailboxId, 'user', message);

	// Get chat history
	const history = await db.getAiChatHistory(d1, mailboxId, 30);

	// Build messages
	let email: EmailFull | null | undefined = undefined;
	let thread: EmailFull[] | undefined = undefined;
	if (emailContext?.emailId) {
		email = await db.getEmail(d1, mailboxId, emailContext.emailId);
	}
	if (emailContext?.threadId) {
		thread = await db.getThreadEmails(d1, mailboxId, emailContext.threadId);
	}
	const msgs = buildAiMessages(history, emailContext, email, thread);

	// Check if client wants SSE
	const accept = c.req.header("Accept") || "";
	const isStream = accept.includes("text/event-stream") || c.req.query("stream") === "true";

	if (isStream) {
		// SSE streaming with tool calling support
		const encoder = new TextEncoder();
		const sseStream = new ReadableStream({
			async start(controller) {
				let fullReply = "";
				const MODEL = "@cf/moonshotai/kimi-k2.6" as string;
				const FALLBACK = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as string;

				async function streamTokens(text: string) {
					const words = text.split(/(?<=\s)/);
					const chunkSize = Math.max(1, Math.floor(words.length / 20));
					for (let i = 0; i < words.length; i += chunkSize) {
						const chunk = words.slice(i, i + chunkSize).join("");
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: chunk })}\n\n`));
						await new Promise(r => setTimeout(r, 15));
					}
				}

				// Step 1: First AI call with tools enabled
				let output = await callAi(ai, bucket, mailboxId, msgs, MODEL, FALLBACK, true).catch(() => null);
				if (!output) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "AI temporarily unavailable" })}\n\n`));
					controller.close();
					return;
				}

				// Parse tool_calls from response
				const msg = output.choices?.[0]?.message;
				let content = msg?.content || output.response || "";
				let toolCalls: AiToolCall[] = msg?.tool_calls || [];

				// Handle Llama native format
				if (toolCalls.length === 0 && (output as any).tool_calls?.length) {
					toolCalls = (output as any).tool_calls.map((tc: any) => ({
						id: tc.name || `call_${Math.random().toString(36).slice(2)}`,
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
						},
					}));
				}

				if (toolCalls.length > 0) {
					// Execute tools and notify frontend
					const toolNames = toolCalls.map((tc) => tc.function.name).join(", ");
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: `[Using tool: ${toolNames}]`, type: "tool_call" })}\n\n`));

					const toolResults = await Promise.allSettled(
						toolCalls.map((tc) =>
							executeToolCall(tc, d1, mailboxId, ai, c.env.BUCKET).then((result) => ({
								role: "tool" as const,
								tool_call_id: tc.id,
								name: tc.function.name,
								content: JSON.stringify(result),
							})),
						),
					);

					const toolResultsSafe = toolResults.map((r) => {
						if (r.status === "rejected") {
							return { role: "tool" as const, tool_call_id: "error", name: "error", content: JSON.stringify({ error: r.reason?.message || "Tool failed" }) };
						}
						return r.value;
					});

					// Step 2: Second AI call with tool results, force text-only
					const messagesWithResults = [
						...msgs,
						{ role: "assistant", content, tool_calls: toolCalls } as AiChatMessage,
						...toolResultsSafe,
						{ role: "user", content: "Based on the tool results above, please provide a helpful response to the user." },
					];

					const finalOutput = await callAi(ai, bucket, mailboxId, messagesWithResults, MODEL, FALLBACK, false).catch(() => null);
					if (finalOutput) {
						const finalText = (finalOutput as any).choices?.[0]?.message?.content || (finalOutput as any).response || "";
						if (finalText) {
							fullReply = finalText;
							await streamTokens(finalText);
						}
					}
				} else if (content) {
					// AI responded directly without tools - stream it
					fullReply = content;
					await streamTokens(content);
				}

				if (!fullReply) {
					fullReply = "I checked your mailbox but couldn't find relevant information. Feel free to ask me to search for something specific!";
					await streamTokens(fullReply);
				}

				const saved = await db.saveAiMessage(d1, mailboxId, 'assistant', fullReply);
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, id: saved.id })}\n\n`));
				controller.close();
			},
		});

		return new Response(sseStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
			},
		});
	} else {
		// Non-streaming JSON with tool calling
		let fullReply = "";
		const MODEL = "@cf/moonshotai/kimi-k2.6" as string;
		const FALLBACK = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as string;

		// Step 1: first call with tools
		const output = await callAi(ai, bucket, mailboxId, msgs, MODEL, FALLBACK, true).catch(() => null);
		if (!output) return c.json({ error: "AI temporarily unavailable" }, 503);

		const msg0 = output.choices?.[0]?.message;
		let content = msg0?.content || output.response || "";
		let toolCalls: AiToolCall[] = msg0?.tool_calls || [];

		if (toolCalls.length === 0 && (output as any).tool_calls?.length) {
			toolCalls = (output as any).tool_calls.map((tc: any) => ({
				id: tc.name || `call_${Math.random().toString(36).slice(2)}`,
				type: "function" as const,
				function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) },
			}));
		}

		if (toolCalls.length > 0) {
			// Execute tools
			const toolResults = await Promise.allSettled(toolCalls.map((tc) =>
				executeToolCall(tc, d1, mailboxId, ai, c.env.BUCKET).then((r) => ({
					role: "tool" as const, tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(r),
				}))
			));

			const toolResultsSafe = toolResults.map((r) =>
				r.status === "rejected"
					? { role: "tool" as const, tool_call_id: "error", name: "error", content: JSON.stringify({ error: r.reason?.message || "Tool failed" }) }
					: r.value
			);

			// Step 2: call without tools
			const msgs2 = [
				...msgs,
				{ role: "assistant", content, tool_calls: toolCalls } as AiChatMessage,
				...toolResultsSafe,
				{ role: "user", content: "Based on the tool results above, please provide a helpful response to the user." },
			];
			const o2 = await callAi(ai, bucket, mailboxId, msgs2, MODEL, FALLBACK, false).catch(() => null);
			if (o2) {
				fullReply = (o2 as any).choices?.[0]?.message?.content || (o2 as any).response || "";
			}
		} else if (content) {
			fullReply = content;
		}
		if (!fullReply) {
			fullReply = "I checked your mailbox but couldn't find relevant information. Feel free to ask me to search for something specific!";
		}

		const saved = await db.saveAiMessage(d1, mailboxId, 'assistant', fullReply);
		return c.json({ reply: fullReply, id: saved.id });
	}
});

app.get("/api/v1/mailboxes/:mailboxId/ai/chat", async (c: AppContext) => {
	const d1 = c.var.db;
	const mailboxId = c.var.mailboxId;
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
	const messages = await db.getAiChatHistory(d1, mailboxId, limit);
	return c.json({ messages });
});

app.delete("/api/v1/mailboxes/:mailboxId/ai/chat", async (c: AppContext) => {
	const d1 = c.var.db;
	const mailboxId = c.var.mailboxId;
	await db.clearAiChatHistory(d1, mailboxId);
	return c.body(null, 204);
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	mailboxId = allRecipients[0];
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		const domain = mailboxId.split("@")[1];
		const domainRecord = await db.getDomainByName(env.DB, domain);
		if (domainRecord?.catch_all_mailbox) {
			mailboxId = domainRecord.catch_all_mailbox;
			console.log(`No exact match for original recipient, routing to catch-all: ${mailboxId}`);
		} else {
			console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`);
			return;
		}
	}

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await db.findThreadBySubject(env.DB, mailboxId, parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await db.createEmail(env.DB, mailboxId, Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	// NOTE: EMAIL_AGENT auto-draft trigger removed — agent will be invoked via D1 change detection instead
}

export { app, receiveEmail };
