// Copyright (c) 2026 Doforu
// Licensed under the AGPL-3.0-only (see LICENSE).

/**
 * External tools gateway.
 *
 * This module is the "outside-facing" kernel for the Agent's 14 tools. It takes
 * the canonical `TOOL_DEFINITIONS` from `tool-dispatch.ts` and exposes them via
 * two wire formats:
 *
 *   1. MCP `tools/list` shape  (`{ name, description, inputSchema }`).
 *   2. OpenAI `functions` shape (`{ type: "function", function: { … } }`).
 *
 * It also provides a single entry point — `dispatchExternalTool` — that external
 * callers (MCP servers, third-party LLMs, API-key requests) use to run a tool
 * by name with an explicit mailboxId, and a pure output-reshaping helper
 * (`reshapeToolOutput`) that strips internal fields and produces an
 * LLM-friendly view for the read-only tools.
 *
 * Nothing here changes internal agent behavior: the actual execution still
 * goes through `executeToolCall` in `tool-dispatch.ts` verbatim.
 */

import {
	TOOL_DEFINITIONS,
	executeToolCall,
	type AiToolCall,
} from "./tool-dispatch";
import { stripHtmlToText } from "./email-helpers";
import { getFolderDisplayName } from "../../shared/folders";
import { DEFAULT_LOCALE } from "../../shared/i18n/config";
import type { Locale } from "../../shared/i18n/types";

// ── Public types ───────────────────────────────────────────────────

export interface ExternalToolCall {
	name: string;
	arguments: Record<string, unknown>;
	mailboxId?: string;
}

export interface ExternalToolResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** Internal-only parameter names that must never leak into a public schema. */
const INTERNAL_PARAMS = new Set([
	"skipVerifyDraft",
	"runVerifyDraft",
	"isPlainText",
]);

/** `list_mailboxes` is the only tool that does not operate on a single mailbox. */
const MAILBOX_OPTIONAL_TOOLS = new Set(["list_mailboxes"]);

/** Maximum characters returned for a body field. */
const BODY_TEXT_MAX = 20000;
/** Maximum characters returned for a list snippet. */
const SNIPPET_MAX = 200;

// ── Schema generation ──────────────────────────────────────────────

type ToolParameters = {
	type: string;
	properties: Record<string, unknown>;
	required: string[];
};

/**
 * Clone a tool's `parameters` object and inject the public `mailboxId`
 * parameter, unless the tool does not operate on a mailbox.
 *
 * The clone is defensive: we never mutate `TOOL_DEFINITIONS` (which is `as
 * const` and shared with the internal agent loop).
 */
function buildParameters(toolName: string, parameters: unknown): ToolParameters {
	const source = (parameters ?? {}) as Partial<ToolParameters>;
	const properties: Record<string, unknown> = { ...(source.properties ?? {}) };
	const required: string[] = [...(source.required ?? [])];

	// Drop any internal-only fields that may have crept into a definition.
	for (const key of Object.keys(properties)) {
		if (INTERNAL_PARAMS.has(key)) delete properties[key];
	}

	if (!MAILBOX_OPTIONAL_TOOLS.has(toolName)) {
		properties.mailboxId = {
			type: "string",
			description: "Target mailbox email address (see list_mailboxes)",
		};
		if (!required.includes("mailboxId")) required.push("mailboxId");
	}

	return {
		type: source.type ?? "object",
		properties,
		required,
	};
}

/**
 * MCP `tools/list` compatible tools array.
 * Each entry carries the (mailboxId-injected) schema on `inputSchema`.
 */
export function listMcpTools(): Array<{
	name: string;
	description: string;
	inputSchema: any;
}> {
	return TOOL_DEFINITIONS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: buildParameters(tool.name, tool.parameters),
	}));
}

/**
 * OpenAI function-calling compatible tools array.
 * Each entry carries the (mailboxId-injected) schema on `function.parameters`.
 */
export function listOpenAiTools(): Array<{
	type: "function";
	function: { name: string; description: string; parameters: any };
}> {
	return TOOL_DEFINITIONS.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: buildParameters(tool.name, tool.parameters),
		},
	}));
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * Execute a single external tool call.
 *
 * Decision path:
 *   1. Unknown tool name                         → `{ ok:false, error:"Unknown tool: <name>" }`
 *   2. Missing mailboxId (non list_mailboxes)     → `{ ok:false, error:"mailboxId is required" }`
 *   3. Mailbox metadata object absent in R2       → `{ ok:false, error:"mailbox not found" }`
 *   4. Delegates to `executeToolCall`; if the result is an object carrying an
 *      `error` key (either a tool-level error branch or the dispatcher's own
 *      swallowed-exception `{ error }`) → `{ ok:false, error:String(result.error) }`
 *   5. Otherwise → `{ ok:true, result: reshapeToolOutput(name, result) }`
 *
 * Any thrown exception is caught and flattened to
 * `{ ok:false, error:"tool execution failed" }`.
 *
 * ── Mailbox authorization (`allowedMailboxes`) ─────────────────────
 * The optional 4th parameter carries the caller's mailbox allow-list, exactly
 * as the API-key middleware parsed it (`ApiKeyInfo.allowedMailboxes`):
 *
 *   • `null` / `undefined` / empty array → the key is unrestricted; behavior
 *     is unchanged (every tool runs, `list_mailboxes` lists everything). The
 *     middleware collapses invalid JSON and empty arrays to `null`, so "empty
 *     means open" is the single rule in both layers.
 *   • non-empty array → the key is restricted to those mailboxes. Any
 *     non-`list_mailboxes` call whose resolved `mailboxId` is outside the list
 *     fails with `forbidden: mailbox not allowed by this key`, checked before
 *     the tool is executed; `list_mailboxes` output is filtered down to the
 *     allow-list.
 *
 * Authorization is enforced here (not in the transport handlers) so every
 * caller — MCP, HTTP gateway, future surfaces — gets the same decision.
 */
export async function dispatchExternalTool(
	env: { DB: D1Database; BUCKET: R2Bucket; AI: Ai },
	call: ExternalToolCall,
	locale: Locale = DEFAULT_LOCALE,
	allowedMailboxes?: string[] | null,
): Promise<ExternalToolResult> {
	try {
		const toolName = call.name;

		// 1) Validate the tool name against the canonical definitions.
		const known = TOOL_DEFINITIONS.some((tool) => tool.name === toolName);
		if (!known) {
			return { ok: false, error: `Unknown tool: ${toolName}` };
		}

		const rawArgs = call.arguments ?? {};

		// 2) Resolve mailboxId (explicit call field wins over the argument bag).
		const mailboxId =
			typeof call.mailboxId === "string" && call.mailboxId.length > 0
				? call.mailboxId
				: typeof rawArgs.mailboxId === "string"
					? (rawArgs.mailboxId as string)
					: undefined;

		// Authorization: a non-empty allow-list restricts which mailbox the key
		// may touch. Enforced before the existence probe and before execution,
		// so a forbidden mailbox never even reaches the dispatcher.
		const scope = normalizeAllowedMailboxes(allowedMailboxes);

		const needsMailbox = !MAILBOX_OPTIONAL_TOOLS.has(toolName);
		if (needsMailbox && !mailboxId) {
			return { ok: false, error: "mailboxId is required" };
		}

		if (scope && needsMailbox && mailboxId && !scope.includes(mailboxId)) {
			return { ok: false, error: FORBIDDEN_MAILBOX_ERROR };
		}

		// 3) Verify the mailbox actually exists (R2 metadata object).
		if (needsMailbox && mailboxId) {
			const head = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
			if (!head) {
				return { ok: false, error: "mailbox not found" };
			}
		}

		// 4) Build the internal toolCall: strip mailboxId (it is positional for
		//    the dispatcher) and force skipVerifyDraft for deterministic output.
		const toolArgs: Record<string, unknown> = { ...rawArgs };
		delete toolArgs.mailboxId;
		toolArgs.skipVerifyDraft = true;

		const toolCall: AiToolCall = {
			id: "external-" + crypto.randomUUID(),
			type: "function",
			function: {
				name: toolName,
				arguments: JSON.stringify(toolArgs),
			},
		};

		// 5) Delegate execution. `mailboxId` defaults to "" for list_mailboxes
		//    (which ignores it) to satisfy the non-optional positioning.
		const result = await executeToolCall(
			toolCall,
			env.DB,
			mailboxId ?? "",
			env.AI,
			env.BUCKET,
			locale,
		);

		// 6) Normalise: any object with an `error` key is a failure.
		if (isErrorResult(result)) {
			return { ok: false, error: String(result.error) };
		}

		// `list_mailboxes` is the only reshaped output affected by the allow-list:
		// it has no `mailboxId` to check up front, so its result is restricted
		// after reshaping. Every other tool was already authorized above.
		const reshaped = reshapeToolOutput(toolName, result);
		return {
			ok: true,
			result:
				toolName === "list_mailboxes" && scope
					? filterMailboxesResult(reshaped, scope)
					: reshaped,
		};
	} catch (e: any) {
		console.error("dispatchExternalTool failed:", e?.message ?? e);
		return { ok: false, error: "tool execution failed" };
	}
}

/**
 * Error returned when a key presents a mailbox outside its `allowedMailboxes`.
 * Stable string: callers assert on it and clients may surface it verbatim.
 */
const FORBIDDEN_MAILBOX_ERROR = "forbidden: mailbox not allowed by this key";

/**
 * Normalize a caller-supplied allow-list into `string[] | null`.
 *
 * Mirrors the middleware's contract: anything that is not a non-empty array of
 * strings — including the empty array that the middleware itself never emits,
 * but a direct caller might — means "unrestricted". Keeping that decision in
 * one place is what makes `null`, `undefined` and `[]` behave identically.
 */
function normalizeAllowedMailboxes(
	allowed: string[] | null | undefined,
): string[] | null {
	if (!Array.isArray(allowed)) return null;
	const list = allowed.filter((v): v is string => typeof v === "string");
	return list.length > 0 ? list : null;
}

/**
 * Filter a reshaped `list_mailboxes` payload down to the allowed addresses.
 *
 * `reshapeToolOutput` already produced `{ mailboxes: [{ email, created_at }],
 * count }`; this re-derives `count` so the two fields can never disagree.
 * Any other shape is passed through untouched (defensive: an allow-list must
 * never turn a working call into a crash).
 */
function filterMailboxesResult(
	reshaped: unknown,
	scope: string[],
): unknown {
	if (
		typeof reshaped !== "object" ||
		reshaped === null ||
		!Array.isArray((reshaped as { mailboxes?: unknown }).mailboxes)
	) {
		return reshaped;
	}

	const source = reshaped as { mailboxes: Array<{ email?: unknown }> };
	const allowed = new Set(scope);
	const mailboxes = source.mailboxes.filter(
		(m) => typeof m?.email === "string" && allowed.has(m.email),
	);
	return { ...reshaped, mailboxes, count: mailboxes.length };
}

/** True when a tool result is an error object carrying an `error` key. */
function isErrorResult(result: unknown): result is { error: unknown } {
	return (
		typeof result === "object" &&
		result !== null &&
		"error" in result &&
		(result as { error?: unknown }).error != null
	);
}

// ── Output reshaping (pure) ────────────────────────────────────────

/**
 * Reshape a raw tool output into an LLM-friendly shape.
 *
 * Only the five read-only tools are reshaped (internal identifiers and raw
 * fields are dropped). Every other tool already returns a small status object
 * and is passed through untouched.
 */
export function reshapeToolOutput(toolName: string, raw: unknown): unknown {
	switch (toolName) {
		case "list_mailboxes":
			return reshapeListMailboxes(raw);
		case "list_emails":
			return reshapeEmailList(raw, false);
		case "search_emails":
			return reshapeEmailList(raw, true);
		case "get_email":
			return reshapeGetEmail(raw);
		case "get_thread":
			return reshapeGetThread(raw);
		default:
			return raw;
	}
}

// ── Small utilities ────────────────────────────────────────────────

/**
 * Format a date value into a readable UTC string. Null-safe: `null`,
 * `undefined` and unparseable input all yield `null`.
 */
function toHumanDate(value: unknown): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) return null;
	// e.g. "2026-01-02 15:04:05 UTC"
	const iso = date.toISOString(); // 2026-01-02T15:04:05.000Z
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** Truncate a string to `max` characters (no ellipsis is appended). */
function clampText(value: unknown, max: number): string {
	const text = typeof value === "string" ? value : value == null ? "" : String(value);
	if (text.length <= max) return text;
	return text.slice(0, max);
}

/** Normalise a raw snippet into plain text, truncated to SNIPPET_MAX. */
function snippetFromHtml(value: unknown): string {
	const text = clampText(stripHtmlToText(String(value ?? "")), SNIPPET_MAX);
	return text;
}

/** Build a `{ name, email }` sender. `name` may be null. */
function buildSender(rawSender: unknown, rawName: unknown): {
	name: string | null;
	email: string;
} {
	return {
		name: rawName == null ? null : String(rawName),
		email: rawSender == null ? "" : String(rawSender),
	};
}

/** Split a comma-separated recipient header into an array of addresses. */
function splitRecipients(value: unknown): string[] {
	if (value == null) return [];
	const text = String(value).trim();
	if (!text) return [];
	return text
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/** Map a folder_id to its display name (uses the shared folder table). */
function folderDisplay(folderId: unknown): string | null {
	if (folderId == null) return null;
	return getFolderDisplayName(String(folderId));
}

/** Project an attachment to its public shape (drops internal ids). */
function publicAttachment(att: any): {
	filename: unknown;
	mimetype: unknown;
	size: unknown;
	disposition: unknown;
} {
	return {
		filename: att?.filename ?? null,
		mimetype: att?.mimetype ?? null,
		size: att?.size ?? null,
		disposition: att?.disposition ?? null,
	};
}

// ── Per-tool reshaping ─────────────────────────────────────────────

function reshapeListMailboxes(raw: unknown): unknown {
	const list = Array.isArray(raw) ? raw : [];
	const mailboxes = list.map((m: any) => ({
		email: m?.email ?? m?.id ?? null,
		created_at: m?.created_at ?? null,
	}));
	return { mailboxes, count: mailboxes.length };
}

/**
 * Shared projection for `list_emails` / `search_emails` summaries.
 * When `withFolder` is true, the `search_emails` `folder_name` is surfaced.
 */
function reshapeEmailList(raw: unknown, withFolder: boolean): unknown {
	const list = Array.isArray(raw) ? raw : [];
	const emails = list.map((e: any) => {
		const base: Record<string, unknown> = {
			id: e?.id ?? null,
			subject: e?.subject ?? null,
			from: buildSender(e?.sender, e?.sender_name),
			to: splitRecipients(e?.recipient),
			cc: splitRecipients(e?.cc),
			date: e?.date ?? null,
			date_human: toHumanDate(e?.date),
			unread: !e?.read,
			starred: !!e?.starred,
			snippet: snippetFromHtml(e?.snippet),
			thread_id: e?.thread_id ?? null,
		};
		if (withFolder) {
			base.folder =
				e?.folder_name != null
					? String(e.folder_name)
					: folderDisplay(e?.folder_id);
		}
		return base;
	});
	return { emails, count: emails.length };
}

/** Project a single full email into the public, LLM-friendly shape. */
function reshapeEmailFull(e: any): Record<string, unknown> {
	const attachments = Array.isArray(e?.attachments) ? e.attachments : [];
	return {
		id: e?.id ?? null,
		subject: e?.subject ?? null,
		from: buildSender(e?.sender, e?.sender_name),
		to: splitRecipients(e?.recipient),
		cc: splitRecipients(e?.cc),
		date: e?.date ?? null,
		date_human: toHumanDate(e?.date),
		unread: !e?.read,
		starred: !!e?.starred,
		folder: folderDisplay(e?.folder_id),
		body_text: clampText(e?.body_text ?? "", BODY_TEXT_MAX),
		has_attachments: attachments.length > 0,
		attachments: attachments.map(publicAttachment),
	};
}

function reshapeGetEmail(raw: unknown): unknown {
	// Not found → the tool returns `{ error }`; pass the error through as-is.
	if (isErrorResult(raw)) {
		return { error: String(raw.error) };
	}
	return reshapeEmailFull(raw);
}

function reshapeGetThread(raw: unknown): unknown {
	if (isErrorResult(raw)) {
		return { error: String(raw.error) };
	}
	const source = (raw ?? {}) as {
		thread_id?: unknown;
		message_count?: unknown;
		messages?: unknown;
	};
	const messages = Array.isArray(source.messages)
		? source.messages.map((m) => reshapeEmailFull(m))
		: [];
	return {
		thread_id: source.thread_id ?? null,
		message_count:
			typeof source.message_count === "number"
				? source.message_count
				: messages.length,
		messages,
	};
}
