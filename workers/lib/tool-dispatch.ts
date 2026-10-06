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
import { Folders } from "../../shared/folders";

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

/**
 * The canonical `folder` values, i.e. the system folder IDs every mailbox is
 * seeded with.
 *
 * NOT a guess and NOT derived from the display-name table: this is exactly the
 * set of `folders.id` rows existence is guaranteed for. `initMailboxFolders`
 * (`workers/db/index.ts`) is the only place system folders are created, and it
 * inserts `inbox` / `sent` / `draft` / `archive` / `trash` / `spam` — the same
 * six `Folders.*` constants from `shared/folders.ts` that `toolDraftReply`,
 * `toolDraftEmail`, `toolUpdateDraft`, `toolSendReply` and `toolSendEmail`
 * write through. The constants are reused rather than re-spelled as literals so
 * a renamed id cannot leave the schema advertising a folder that no longer
 * exists (and vice versa).
 *
 * The display names (`Inbox`, `Drafts`, …) are deliberately NOT listed: they
 * are presentation, not stable identifiers, and `FOLDER_DISPLAY_NAMES` is an
 * open `Record<string, string>` — not a closed set — so it cannot anchor an
 * `enum`.
 *
 * Serialized inline (a `[...]` spread of a frozen array, not the `Folders`
 * object itself) so each definition stays a JSON literal fit for `as const`.
 * An `enum` is emitted as the FIRST key of every `folder` property — see
 * {@link folderSchema}.
 */
export const FOLDER_ENUM_VALUES = [
	Folders.INBOX,
	Folders.SENT,
	Folders.DRAFT,
	Folders.ARCHIVE,
	Folders.TRASH,
	Folders.SPAM,
] as const;

/**
 * Build a `folder` property: the canonical id set as a JSON-Schema `enum`,
 * plus the `type` / `description` the model reads.
 *
 * `enum` is emitted FIRST on purpose. In a copied object literal TypeScript
 * only re-checks a NON-final property against its contextual type when that
 * property is an `enum`; a property whose type is not the last member of the
 * literal before optional members widens by one — here to
 * `"string" | undefined` — which makes the whole `TOOL_DEFINITIONS` literal
 * stop matching its own inferred shape. Leading with `enum` is what keeps the
 * `as const` tree intact (and what fixes the key order for a reviewer).
 *
 * A `type`-only `list_emails.folder` still serializes identically to the old
 * shape (`{ type: "string", description }`), so the description keeps saying
 * what the enum already says in machine-readable form rather than repeating
 * the value list as prose — the exact redundancy this change removes.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function folderSchema(description: string) {
	return { enum: [...FOLDER_ENUM_VALUES], type: "string", description } as const;
}

export const TOOL_DEFINITIONS = [
	{
		name: "list_mailboxes",
		description:
			"List all available mailboxes/email accounts. Call this first to obtain a valid `mailboxId` before calling any other tool that requires it.",
		parameters: { type: "object", properties: {}, required: [] },
	},
	{
		name: "list_emails",
		description: "List emails in a folder. Use this to browse the user's inbox, sent, drafts, archive, or trash.",
		parameters: {
			type: "object",
			properties: {
				folder: {
					// `enum` leads for the reason spelled out in `folderSchema`:
					// TypeScript only re-checks a non-final property against its
					// contextual type when it is an `enum`, so a `type`-first
					// object here widens to `"string" | undefined` and the whole
					// `TOOL_DEFINITIONS` literal stops matching.
					enum: [...FOLDER_ENUM_VALUES],
					type: "string",
					description: "Folder to list. One of the mailbox's folders (see `enum`).",
				},
				limit: { type: "number", description: "Max emails to return (default 25)" },
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
				folder: folderSchema("Optional folder to narrow the search (see `enum`); omit to search every folder"),
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
				id: {
					type: "string",
					description:
						"The email's unique id, exactly as returned in the `id` field of a list_emails / search_emails / get_thread result.",
				},
			},
			required: ["id"],
		},
	},
	{
		name: "get_thread",
		description: "Get all emails in a conversation thread by thread ID",
		parameters: {
			type: "object",
			properties: {
				thread_id: {
					type: "string",
					description:
						"The thread id, as returned in the `thread_id` field of list_emails / search_emails.",
				},
			},
			required: ["thread_id"],
		},
	},
	{
		name: "draft_reply",
		description: "Draft a reply to an email (saves to Drafts folder without sending). The user must review and confirm before sending.",
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description:
						"The id of the email being replied to (the `id` field from list_emails / search_emails).",
				},
				to: { type: "string", description: "Recipient email address" },
				subject: { type: "string", description: "Reply subject line" },
				body: { type: "string", description: "Reply body text (plain text, will be converted to HTML)" },
			},
			required: ["id", "to", "subject", "body"],
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
				id: {
					type: "string",
					description:
						"The email's unique id, exactly as returned in the `id` field of a list_emails / search_emails / get_thread result.",
				},
				read: { type: "boolean", description: "true = mark as read, false = mark as unread" },
			},
			required: ["id", "read"],
		},
	},
	{
		name: "move_email",
		description: "Move an email to a different folder (e.g., archive, trash)",
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description:
						"The email's unique id, exactly as returned in the `id` field of a list_emails / search_emails / get_thread result.",
				},
				folder: folderSchema(
					"Target folder, as returned in the `folder` field of list_emails / search_emails. One of the mailbox's folders (see `enum`).",
				),
			},
			required: ["id", "folder"],
		},
	},
	{
		name: "delete_email",
		description: "Permanently delete an email",
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description:
						"The email's unique id, exactly as returned in the `id` field of a list_emails / search_emails / get_thread result.",
				},
			},
			required: ["id"],
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
				id: {
					type: "string",
					description:
						"The id of the email being replied to (the `id` field from list_emails / search_emails).",
				},
				to: { type: "string", description: "Recipient email address" },
				subject: { type: "string", description: "Reply subject line" },
				bodyHtml: { type: "string", description: "Reply body as HTML" },
			},
			required: ["id", "to", "subject", "bodyHtml"],
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

// ── Parameter aliases (cross-tool naming continuity) ──────────────
//
// Historical wart this table exists to fix: the tools that *return* an email
// report its primary key as `id` (and the thread key as `thread_id`), while
// the tools that *refer to* an entity used to demand `emailId` / `threadId` /
// `originalEmailId`. A model that copied the value straight out of a
// `list_emails` result therefore missed the required key entirely.
//
// The canonical key is now the one that matches the **returned field name**
// (`id`, `thread_id`). The legacy names below are still *accepted* so that
// prompts, cached tool calls and third-party clients built against the old
// schema keep working; canonical always wins when both are present.
//
// The same rule covers the *destination* of a move: `move_email` reports the
// folder it landed in as `folder` (like `list_emails` / `search_emails`), so
// the argument that names that folder is spelled `folder` too, not `folderId`.
//
// Deliberately absent: a bare `id` → `thread_id` mapping. Redirecting a plain
// `id` into `thread_id` would silently reinterpret an email id as a thread id
// — a wrong answer instead of a missing-parameter error. `get_thread` only
// accepts `thread_id` (plus the explicit legacy `threadId`).
export const TOOL_ARG_ALIASES: Record<string, Record<string, string>> = {
	get_email: { emailId: "id" },
	mark_email_read: { emailId: "id" },
	move_email: { emailId: "id", folderId: "folder", folder_id: "folder" },
	delete_email: { emailId: "id" },
	get_thread: { threadId: "thread_id" },
	draft_reply: { originalEmailId: "id" },
	send_reply: { originalEmailId: "id" },
};

/**
 * Rename legacy parameter keys to their canonical counterparts.
 *
 * Rules:
 *   • only the tool's own alias table applies — keys are never rewritten
 *     across tools;
 *   • the canonical key takes precedence: an alias only fills in when the
 *     canonical key is absent or empty (`undefined` / `null` / trailing
 *     whitespace-only string), so an explicit canonical value is never
 *     clobbered by a stale alias;
 *   • the alias key is not deleted when the canonical value comes from the
 *     canonical key itself (harmless passthrough), but it is deleted when it
 *     was consumed, keeping the argument bag free of duplicates;
 *   • unknown tools and unknown keys are returned untouched (same object
 *     identity when nothing changed), so this can wrap every call for free.
 */
export function normalizeToolArguments<TArgs extends Record<string, any>>(
	toolName: string,
	args: TArgs,
): TArgs {
	const aliases = TOOL_ARG_ALIASES[toolName];
	if (!aliases || !args || typeof args !== "object") return args;

	let normalized: Record<string, any> | null = null;
	for (const [aliasKey, canonicalKey] of Object.entries(aliases)) {
		if (!(aliasKey in args)) continue;
		normalized ??= { ...args };
		const aliasValue = (normalized as Record<string, any>)[aliasKey];
		if (!hasValue((normalized as Record<string, any>)[canonicalKey])) {
			if (hasValue(aliasValue)) {
				(normalized as Record<string, any>)[canonicalKey] = aliasValue;
			}
		}
		delete (normalized as Record<string, any>)[aliasKey];
	}

	return (normalized ?? args) as TArgs;
}

/**
 * True when a parameter carries a usable value.
 *
 * Used by alias normalization only: an empty string, `null` or `undefined`
 * canonical key still allows a legacy key to supply the value, while any real
 * value (including `false` and `0`) counts as "present" and wins.
 */
function hasValue(value: unknown): boolean {
	if (value == null) return false;
	if (typeof value === "string") return value.trim().length > 0;
	return true;
}

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

	// Everything from the parse onward runs inside `try`: a malformed JSON
	// payload from a model must surface as a tool error the caller can see,
	// not as an exception escaping into the outer request handler.
	let args: any;
	try {
		args = normalizeToolArguments(name, JSON.parse(argsStr));

		// Auto-seed folders for mailbox-dependent tools
		const mailboxTools = new Set(["search_emails", "list_emails", "get_email", "get_thread", "draft_reply", "draft_email", "update_draft", "mark_email_read", "move_email", "delete_email", "discard_draft", "send_reply", "send_email"]);
		if (mailboxTools.has(name)) {
			await ensureFoldersExist(db, mailboxId);
		}

		switch (name) {
			case "search_emails":
				return await toolSearchEmails(db, mailboxId, args, locale);
			case "list_emails":
				return await toolListEmails(db, mailboxId, args, locale);
			case "get_email":
				return await toolGetEmail(db, mailboxId, args.id, locale);
			case "get_thread":
				// `locale` must be forwarded like the `get_email` sibling above:
				// `toolGetThread` localises its "thread not found" error, and
				// omitting it fell back to the English message for callers that
				// asked for another language.
				return await toolGetThread(db, mailboxId, args.thread_id, locale);
			case "draft_reply":
				return await toolDraftReply(db, mailboxId, ai, args, locale);
			case "draft_email":
				return await toolDraftEmail(db, mailboxId, ai, args, locale);
			case "update_draft":
				return await toolUpdateDraft(db, mailboxId, ai, args, locale);
			case "mark_email_read":
				return await toolMarkEmailRead(db, mailboxId, args.id, args.read);
			case "move_email":
				return await toolMoveEmail(db, mailboxId, args.id, args.folder, locale);
			case "delete_email":
				return await toolDeleteEmail(db, mailboxId, args.id, locale);
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
		console.error(`Tool ${name} failed:`, e?.message ?? e);
		// `error` is the stable, public one-liner. `detail` carries the real
		// cause for the internal agent loop (which stringifies the whole result
		// back into the model's context so it can self-correct). The external
		// gateway strips `detail` before anything leaves the process — see
		// `dispatchExternalTool`.
		return { error: `Tool ${name} failed`, detail: e?.message ?? String(e) };
	}
}
