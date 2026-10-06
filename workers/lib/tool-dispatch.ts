// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Tool dispatch kernel for the Agent.
 *
 * Extracted verbatim from `workers/index.ts` so the agent API routes can
 * reuse the tool definitions and the execution dispatcher. The logic here is
 * intentionally unchanged — internal agent behavior must stay identical.
 */

import * as db from "../db";
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
} from "./tools";
import { DEFAULT_LOCALE } from "../../shared/i18n/config";
import type { Locale } from "../../shared/i18n/types";

// Local type for AI text generation output (available in CF Workers runtime)
// Mirrors the exported `AiToolCall` in `workers/index.ts` (kept in sync
// deliberately: this module must not import from `index.ts` to avoid a
// circular dependency).
export interface AiToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

// ── Tool Definitions (OpenAI-compatible format) ──────────────────────
// AI-facing: keep English. Every `description` here is part of the tool
// schema handed to the model, not user-facing copy.

export const TOOL_DEFINITIONS = [
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
export async function ensureFoldersExist(database: D1Database, mailboxId: string): Promise<void> {
	const existing = await database
		.prepare("SELECT COUNT(*) as cnt FROM folders WHERE mailbox_id = ?")
		.bind(mailboxId)
		.first<{ cnt: number }>();
	if (existing && existing.cnt > 0) return;
	await db.initMailboxFolders(database, mailboxId);
}

export async function executeToolCall(
	toolCall: AiToolCall,
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	bucket: R2Bucket,
	locale: Locale = DEFAULT_LOCALE,
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
				return await toolGetEmail(db, mailboxId, args.emailId, locale);
			case "get_thread":
				return await toolGetThread(db, mailboxId, args.threadId);
			case "draft_reply":
				return await toolDraftReply(db, mailboxId, ai, args, locale);
			case "draft_email":
				return await toolDraftEmail(db, mailboxId, ai, args, locale);
			case "update_draft":
				return await toolUpdateDraft(db, mailboxId, ai, args, locale);
			case "mark_email_read":
				return await toolMarkEmailRead(db, mailboxId, args.emailId, args.read);
			case "move_email":
				return await toolMoveEmail(db, mailboxId, args.emailId, args.folderId, locale);
			case "delete_email":
				return await toolDeleteEmail(db, mailboxId, args.emailId, locale);
			case "discard_draft":
				return await toolDiscardDraft(db, mailboxId, args.draftId, locale);
			case "send_reply":
				return await toolSendReply(db, mailboxId, ai, bucket, args, locale);
			case "send_email":
				return await toolSendEmail(db, mailboxId, ai, bucket, args, locale);
			case "list_mailboxes":
				return await toolListMailboxes({ BUCKET: bucket, DB: db } as any);
			default:
				return { error: `Unknown tool: ${name}` };
		}
	} catch (e: any) {
		console.error(`Tool ${name} failed:`, e.message);
		return { error: `Tool ${name} failed` };
	}
}
