// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Shared tool business logic for the Agent.
 *
 * Each function takes a `db: D1Database`, `mailboxId: string`, and optional
 * binding parameters (ai, bucket), performs the business logic (D1 calls,
 * data fetching, formatting), and returns a plain object. The Agent wraps
 * these results in its own response format.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import type { EmailSummary } from "../db";
import {
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft, VERIFIER_REASON_MODEL_UNREACHABLE, VERIFIER_REASON_REMOVED_MOST } from "./ai";
import { sendEmailFromMailbox } from "../email-sender";
import { Folders } from "../../shared/folders";
// Sent as the second element of an `{ error, detail }` result. The internal
// agent loop stringifies the whole tool result back into the model's context
// (so it can self-correct), while `dispatchExternalTool` — the only path a
// string from here takes to leave the process — forwards `error` alone and
// drops `detail`. That split is what lets the raw cause stay diagnosable
// without it ever being echoed to an external client.
import { normalizeSendError } from "./send-errors";
import * as dbService from "../db";
import { checkVerificationSqlError } from "../db/index";
import type { Env } from "../types";
import { getBackendT, createI18nInstance } from "../../shared/i18n/translate";
import { DEFAULT_LOCALE } from "../../shared/i18n/config";
import type { Locale } from "../../shared/i18n/types";

/**
 * Resolve a `t` function for the `apiTool` namespace.
 *
 * These functions are plain libraries (not Hono handlers), so there is no
 * `c.get("t")`. Callers pass the request locale; when omitted we fall back to
 * `DEFAULT_LOCALE` ("en") so existing call sites stay backward compatible.
 */
function apiToolT(locale: Locale = DEFAULT_LOCALE) {
	return getBackendT(locale, "apiTool");
}
/**
 * The request-scoped `t` for the `apiTool` namespace.
 *
 * Each call builds a fresh, locale-pinned i18next instance. Two reasons:
 *
 *   • no module-level singleton — Workers reuse one isolate across concurrent
 *     requests, so a shared instance would leak one request's language into
 *     another mid-flight (see shared/i18n/translate.ts);
 *   • `getFixedT(locale, ns)` cannot emit a resolver fallback, which is what
 *     lets a message below carry a literal, deterministic remainder even if a
 *     catalog ever stops defining the key.
 */
function i18n(locale: Locale = DEFAULT_LOCALE) {
	return createI18nInstance(locale).getFixedT(locale, "apiTool");
}

// ── Draft-verification failures ────────────────────────────────────

/**
 * Build the "unknown folder" error.
 *
 * The message names the rejected value and then the mailbox's actual folder
 * names, so the caller can correct the call instead of guessing.
 *
 * BOTH halves come from the `apiTool` catalog, which owns the sentence: the
 * English template is `Unknown folder: {{folder}}. Valid folders: {{folders}}.`,
 * so the folder list is passed as `folders` — the exact value the template
 * interpolates. Spelling the list a second time in TypeScript is what produced
 * the original bug: the call site only passed the placeholder *name* and never
 * its value, so the literal `{{folders}}` leaked into the message, next to a
 * duplicate hand-built list. The regression test asserts the whole string
 * (including "no `{{` anywhere") so that class of bug cannot come back.
 *
 * `t` comes from a locale-pinned instance (see `i18n`), so a catalog that
 * stopped defining `unknownFolder` still yields a deterministic English
 * sentence through the resolver fallback.
 *
 * ── The empty-mailbox edge case ─────────────────────────────────────────────
 * `valid` is empty only when the mailbox has no `folders` rows at all (an
 * unseeded mailbox). The list template would then render the dangling
 * `Valid folders: .` — a sentence that reads like a rendering bug and tells
 * the caller nothing. That case uses `unknownFolderNoList`, the same first
 * sentence without the list clause, so both locales stay in the catalog and no
 * locale-specific string surgery happens in code (the Chinese layout frames
 * the clause as 「可用文件夹：」, which splitting on the English words would
 * miss).
 */
function unknownFolderError(
	t: ReturnType<typeof i18n>,
	folder: string,
	valid: string[],
): string {
	if (valid.length === 0) return t("unknownFolderNoList", { folder });
	return t("unknownFolder", { folder, folders: valid.join(", ") });
}

/**
 * Build the `error` string for a failed draft verification.
 *
 * The body used to collapse every failure into the same sentence, so a model
 * that hit `draft_reply` with the verifier switched on could not tell
 * "the AI removed too much" from "the AI binding threw". The reason is
 * appended to the localized message so the caller can act on it.
 *
 * Sanitisation happens here, not at the boundary: only reasons produced by
 * this module (see `verifyDraft`, which re-writes database errors into stable
 * English sentences) are forwarded. Exceptions that bypassed that mapping fall
 * back to `checkVerificationSqlError`, and anything else is reduced to the
 * bare localized message — raw stack traces, SQL and internal ids never reach
 * this string, which is the only part an external client sees.
 *
 * The append happens in TypeScript rather than through i18next interpolation
 * on purpose: the message templates have no `{{reason}}` placeholder, so
 * interpolating into them is a silent no-op that would drop the reason again —
 * the exact failure mode being fixed here.
 */
function verificationError(message: string, reason: string | undefined, locale?: Locale): string {
	void locale;
	const detail = sanitizeVerificationReason(reason);
	return detail ? `${message} (${detail})` : message;
}

/**
 * Reduce a verification failure reason to a safe, single-line detail.
 *
 * Returns `undefined` when nothing safe can be said. A reason survives only if
 * it is a recognizable database error that `checkVerificationSqlError` turns
 * into a neutral sentence, or one of the fixed sentences produced by
 * `verifyDraft` itself. Multi-line text (stack traces), overly long messages
 * and anything unrecognized are dropped.
 */
function sanitizeVerificationReason(reason: string | undefined): string | undefined {
	if (typeof reason !== "string") return undefined;
	const trimmed = reason.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
	if (trimmed.length > 300) return undefined;
	// Recognize through the NORMALIZED sentence, not the raw one: for anything
	// that is not already a `D1_ERROR`/`SQLITE_` string, `checkVerificationSqlError`
	// returns null while still telling us the phrase is one of its own mappings
	// (e.g. "the database schema is missing a required table"). Passing the raw
	// text would silently drop that detail from the outward `error`.
	return (
		checkVerificationSqlError(trimmed) ??
		VERIFIER_REASONS.get(trimmed) ??
		VERIFIER_SQL_SENTENCES.get(trimmed)
	);
}

/**
 * Every neutral sentence `checkVerificationSqlError` can produce, mapped to
 * itself.
 *
 * The helper both normalizes (recognized `D1_ERROR` / `SQLITE_` input →
 * sentence) and recognizes (a sentence handed back to it → `null`, "not a
 * database error"), so the two directions have to be composed here. Deriving
 * the set by asking the helper rather than by listing its sentences again
 * means a new mapping over there is picked up automatically, and a sentence
 * that is NOT one of its mappings (e.g. `verifyDraft`'s fixed reasons) is
 * still rejected.
 */
const VERIFIER_SQL_SENTENCES: Map<string, string> = new Map(
	[
		"D1_ERROR: no such table: x",
		"D1_ERROR: no such column: x",
		"D1_ERROR: UNIQUE constraint failed: x",
		"SQLITE_ERROR: database is is locked",
		"D1_ERROR: unrecognised failure",
	]
		.map((probe) => checkVerificationSqlError(probe))
		.filter((sentence): sentence is string => typeof sentence === "string")
		.map((sentence) => [sentence, sentence]),
);

/**
 * The complete allow-list of raw reasons `verifyDraft` is allowed to produce,
 * mapped to the shorter phrasing shown to the caller. Anything not in here (or
 * recognizable as a D1 error) is dropped, so the outward-facing `error` string
 * can only ever contain copy reviewed here.
 *
 * Keyed by the exported `VERIFIER_REASON_*` constants rather than by literals
 * copied a second time: a reason can only be in the map if `verifyDraft`
 * actually emits it, so a reworded reason cannot silently lose its detail.
 */
const VERIFIER_REASONS = new Map<string, string>([
	[VERIFIER_REASON_REMOVED_MOST, "the verifier removed most of the body"],
	[VERIFIER_REASON_MODEL_UNREACHABLE, "the verification model could not be reached"],
]);

// ── Folder resolution ──────────────────────────────────────────────

/**
 * Report a folder reference that does not resolve to a row in `folders`.
 *
 * Returns `null` when the folder is known (or when no folder was given), so
 * callers can read it as "nothing to complain about". When it returns a value,
 * the caller MUST NOT run the query: the folder is genuinely absent and the
 * result would otherwise be an empty list that reads as "this folder is
 * empty".
 *
 * Matching semantics are copied verbatim from the queries these tools use
 * (`getEmails` / `searchEmails` / `countEmails`): a folder is identified by
 * `name = <value> OR id = <value>`, scoped to the mailbox, first match wins —
 * the same equality on the same columns, so case-sensitivity and aliasing
 * behave identically. Resolution deliberately does NOT normalise case or trim:
 * a looser match here would make a query that finds nothing look "valid",
 * which is exactly the silent-empty bug being prevented.
 *
 * The returned `valid` list is the mailbox's own folder names (plus their
 * ids), so the error message can tell the caller what it could have asked
 * for instead of leaving it to guess.
 */
async function resolveUnknownFolder(
	db: D1Database,
	mailboxId: string,
	folder: string | undefined,
): Promise<{ folder: string; valid: string[] } | null> {
	if (folder === undefined || folder === null) return null;
	const folderRef = typeof folder === "string" ? folder : String(folder);
	if (folderRef.length === 0) return null;

	const rows = await db
		.prepare(
			"SELECT name, id FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2) LIMIT 1",
		)
		.bind(mailboxId, folderRef)
		.all<{ name: string; id: string }>();

	if (rows.results && rows.results.length > 0) return null;

	const all = await db
		.prepare("SELECT name, id FROM folders WHERE mailbox_id = ?1")
		.bind(mailboxId)
		.all<{ name: string; id: string }>();

	const valid: string[] = [];
	for (const row of all.results ?? []) {
		if (row.name && !valid.includes(row.name)) valid.push(row.name);
		if (row.id && !valid.includes(row.id)) valid.push(row.id);
	}

	return { folder: folderRef, valid };
}

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	db: D1Database,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
	locale?: Locale,
): Promise<EmailSummary[] | { error: string }> {
	// An unknown folder must be an error, never an empty list. The folder
	// filter resolves the folder through a scalar subquery
	// (`folder_id = (SELECT id FROM folders WHERE mailbox_id = ? AND …)`); when
	// no such row exists the subquery yields NULL, `folder_id = NULL` is never
	// true, and the caller receives `[]`. Reporting "this folder is empty" for
	// a folder that does not exist is a WRONG ANSWER, which is worse than a
	// loud failure — the caller cannot tell the two apart.
	const unknownFolder = await resolveUnknownFolder(db, mailboxId, params.folder);
	if (unknownFolder) {
		return {
			error: unknownFolderError(i18n(locale), unknownFolder.folder, unknownFolder.valid),
		};
	}

	return dbService.getEmails(db, mailboxId, {
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	db: D1Database,
	mailboxId: string,
	emailId: string,
	locale?: Locale,
) {
	const email = await getFullEmail(db, mailboxId, emailId);
	if (!email) return { error: apiToolT(locale)("emailNotFound") };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

/**
 * Fetch every message of a thread.
 *
 * A thread that yields no rows is reported as an ERROR, not as an empty
 * thread. The two are indistinguishable from the tool result otherwise: a
 * caller that mistyped or invented a `thread_id` would be told
 * `{ thread_id, message_count: 0, messages: [] }`, read that as "this
 * conversation is empty", and have no way to tell it apart from a real
 * conversation with no messages.
 *
 * Rows only ever exist in `emails`, and every email row is written with a
 * non-null `thread_id` (see `createEmail`): a thread therefore exists exactly
 * while at least one message references it. There is no "existing but empty"
 * thread in this data model, so treating zero rows as "unknown thread" cannot
 * mislabel a legitimate empty conversation.
 */
export async function toolGetThread(
	db: D1Database,
	mailboxId: string,
	threadId: string,
	locale?: Locale,
) {
	const thread = await getFullThread(db, mailboxId, threadId);
	if (thread.message_count === 0) {
		return { error: apiToolT(locale)("threadNotFound") };
	}
	return thread;
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	db: D1Database,
	mailboxId: string,
	params: { query: string; folder?: string },
	locale?: Locale,
): Promise<EmailSummary[] | { error: string }> {
	// `folder` is optional here: when it is omitted the search spans the whole
	// mailbox and there is nothing to resolve. When it IS given, the same rule
	// as `list_emails` applies — an unknown folder must fail loudly instead of
	// being reported as "no matches".
	if (params.folder) {
		const unknownFolder = await resolveUnknownFolder(db, mailboxId, params.folder);
		if (unknownFolder) {
			return {
			error: unknownFolderError(i18n(locale), unknownFolder.folder, unknownFolder.valid),
		};
		}
	}

	return dbService.searchEmails(db, mailboxId, {
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent does this on plain text.
 */
export async function toolDraftReply(
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	params: {
		/**
		 * The email being replied to. The canonical name is `id` — it matches the
		 * field `list_emails` / `search_emails` RETURN, so a model can copy the
		 * value straight from one result into the next call. `originalEmailId` is
		 * the historical spelling, kept as a fallback for callers that reach this
		 * function directly (the dispatcher already renames it to `id` and drops
		 * the legacy key, so `params.originalEmailId` is normally absent).
		 */
		id?: string;
		originalEmailId?: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
	locale?: Locale,
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const t = apiToolT(locale);
	// Canonical first. Reading only the legacy key here is the regression that
	// made every draft_reply call fail with an empty id: normalization moves the
	// value to `id` and deletes `originalEmailId`.
	const replyToEmailId = params.id ?? params.originalEmailId;
	if (!replyToEmailId) {
		return { error: t("emailNotFound") };
	}

	// The id must RESOLVE, not merely be present. Before this guard the lookup
	// below was allowed to fail: `getEmail` returned `null`, `threadId` fell
	// back to `original?.thread_id || replyToEmailId`, and the call still wrote
	// a draft — carrying the caller's nonexistent id as BOTH `in_reply_to` and
	// `thread_id`. The result was `{ status: "draft_saved" }` for a reply to a
	// message that does not exist: a silent false success, plus a row that
	// `get_thread` can never resolve and that no mailbox will ever thread.
	// `send_reply` has always refused exactly this (see `originalEmailNotFound`
	// there); a draft is no different — it is the same reply, just not sent
	// yet. Read the row ONCE and reuse it for the threading fields below.
	const original = await dbService.getEmail(db, mailboxId, replyToEmailId);
	if (!original) {
		return { error: t("originalEmailNotFound") };
	}

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const verification = await verifyDraft(ai, processedBody);
		if (!verification.ok) {
			return {
				error: verificationError(
					i18n(locale)("draftVerificationFailedBody"),
					verification.reason,
					locale,
				),
			};
		}
		processedBody = verification.body;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// `original` was fetched and proven to exist above. The `|| replyToEmailId`
	// fallback is kept only for a row whose `thread_id` is null: a mailbox row
	// with a real id is a usable thread anchor either way, and neither branch
	// can reach a value that is not in `emails`.
	const threadId = original.thread_id || replyToEmailId;

	// Append quoted original message
	const quotedBlock = buildQuotedReplyBlock({
		date: original.date ?? undefined,
		sender: (original.sender || params.to) ?? undefined,
		body: original.body ?? undefined,
	});
	const bodyHtml = processedBody + quotedBlock;

	await dbService.createEmail(
		db,
		mailboxId,
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: replyToEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: t("draftSaved"),
		draft: {
			// NOT `id`. This result carries TWO different identifiers:
			//
			//   • `draftId` (sibling field) — the primary key of the draft that
			//     was just INSERTED;
			//   • this field — the id of the email being REPLIED TO, the
			//     `in_reply_to` anchor of that new draft.
			//
			// Spelling the anchor `id` put two opposite meanings behind the same
			// key (the nested `draft.id` was the OLD email while `draftId` was the
			// NEW one), so a model that copied `result.draft.id` into
			// `get_email`/`mark_email_read`/`discard_draft` acted on the wrong
			// message. `reply_to_id` says exactly which one it is. It is the
			// `id` argument of `draft_reply` echoed back — the counterpart of
			// `in_reply_to` on the stored row — and NOT an id any read tool
			// reports, so `draftId` stays the only draft primary key here.
			reply_to_id: replyToEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
	locale?: Locale,
): Promise<
	| { status: string; draftId: string; thread_id?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const t = apiToolT(locale);
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const verification = await verifyDraft(ai, processedBody);
		if (!verification.ok) {
			return {
				error: verificationError(
					i18n(locale)("draftVerificationFailedBody"),
					verification.reason,
					locale,
				),
			};
		}
		processedBody = verification.body;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID.
	//
	// A `in_reply_to` that does not resolve is an ERROR, not something to
	// file the draft under. The old code did `original?.thread_id ||
	// params.in_reply_to`, so the caller's bogus id became the draft's
	// `thread_id` and `in_reply_to` and the tool still answered
	// `draft_saved`: the same silent false success `draft_reply` had, on the
	// same reasoning. `in_reply_to` is an OPTIONAL argument — omitting it is
	// the ordinary new-draft path (the draft becomes its own thread) — but
	// providing one that resolves to nothing is a caller mistake, and the
	// mailbox would otherwise gain a draft anchored to a message that does not
	// exist. Same wording as `draft_reply` / `send_reply`.
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = await dbService.getEmail(db, mailboxId, params.in_reply_to);
		if (!original) {
			return { error: t("originalEmailNotFound") };
		}
		resolvedThreadId = original.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await dbService.createEmail(
		db,
		mailboxId,
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		// The thread key, spelled exactly like `thread_id` in every read result
		// (list_emails / search_emails / get_thread), so it can be passed
		// straight back to `get_thread`. Was camelCase `threadId`, which no
		// other field in the tool surface uses.
		thread_id: resolvedThreadId,
		message: t("draftSaved"),
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
		skipVerifyDraft?: boolean;
	},
	locale?: Locale,
): Promise<
	| {
			status: string;
			/**
			 * The replacement draft's own id, spelled `draftId` so it matches the
			 * argument this tool takes — the caller can feed the value straight
			 * back into another `update_draft` / `discard_draft` call without
			 * renaming it. Same name-for-the-same-thing rule as `id` on
			 * `mark_email_read` / `move_email` / `delete_email`, and the same one
			 * `draft_reply` already follows.
			 */
			draftId: string;
			/** The id the caller passed in, i.e. the draft that was replaced. */
			oldDraftId: string;
			/**
			 * The same value as `draftId`, kept under its original name. The
			 * delete-then-insert rewrite means this is a NEW row, and callers
			 * written against the old shape read the new id from here — so the
			 * field stays instead of being renamed.
			 */
			newDraftId: string;
			message: string;
		}
	| { error: string }
> {
	const t = apiToolT(locale);
	const oldDraft = await dbService.getEmail(db, mailboxId, params.draftId);
	if (!oldDraft) {
		return { error: t("draftNotFound") };
	}

	// ...and it must BE a draft. "Update" is implemented as delete-then-insert
	// (the replacement below re-`createEmail`s under `Folders.DRAFT`), so
	// pointing this tool at an inbox/sent/archive message did not update a
	// draft at all: it DELETED the caller's real email and replaced it with a
	// draft, then answered `{ status: "draft_updated" }`. That is data loss
	// behind a success message, and the caller has no way to tell.
	// `discard_draft` already refuses a non-draft (`cannotDiscardNotDraft`) on
	// exactly this check — the same check, on the same field, is used here so
	// "is a draft" means one thing across the draft tools. It runs BEFORE the
	// verifier and before any write, so a rejected call touches nothing.
	if (oldDraft.folder_id !== Folders.DRAFT) {
		return { error: t("cannotUpdateNotDraft") };
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";

	let verifiedBody = rawBody;
	// Skip AI verification when explicitly requested (external LLM callers
	// prefer deterministic output and don't want the body rewritten).
	if (!params.skipVerifyDraft) {
		const verification = await verifyDraft(ai, rawBody);
		if (!verification.ok) {
			return {
				error: verificationError(
					i18n(locale)("draftVerificationFailedKeeping"),
					verification.reason,
					locale,
				),
			};
		}
		verifiedBody = verification.body;
	}

	await dbService.deleteEmail(db, mailboxId, params.draftId);
	await dbService.createEmail(
		db,
		mailboxId,
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject ?? "",
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient ?? "").toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		// `draftId` is the canonical key — it is what the tool takes as an
		// argument and what `draft_reply` / `discard_draft` report back — so it
		// leads. `newDraftId` carries the identical value under the name this
		// tool used to return alone; it is additive, not a rename, so callers
		// built against the old shape keep working.
		draftId: newDraftId,
		newDraftId,
		oldDraftId: params.draftId,
		message: t("draftUpdated"),
	};
}

/**
 * Read a `true` / `false` token out of a value that is not already a boolean.
 *
 * A text-based model routinely sends a boolean as a string (`"true"`), so
 * refusing that spelling outright would turn a working call into an error. Any
 * other value — a missing one (`undefined`, `null`), an empty string, `"yes"`,
 * `1`, an object — returns `null`, which callers read as "this parameter was
 * not given a usable value" and report as an invalid parameter. Matching is
 * case-insensitive for the same reason: `"True"` is the same intent.
 *
 * Returning `null` rather than a default is the point. "Absent" and "false"
 * must not collapse into the same value, or the guard this feeds would silently
 * convert a missing `read` into an explicit `unread`.
 */
function tokenWord(value: unknown): boolean | null {
	if (typeof value === "string") {
		const token = value.trim().toLowerCase();
		if (token === "true") return true;
		if (token === "false") return false;
	}
	return null;
}

// ── mark_email_read ────────────────────────────────────────────────

/**
 * The `mark_email_read` result.
 *
 * `id` is the same primary-key spelling every read tool returns, so the value
 * a caller just acted on can be fed straight into another `id`-taking tool
 * without a naming translation.
 */
export interface MarkEmailReadResult {
	status: "updated";
	id: string;
	read: boolean;
}

/**
 * Mark an email read/unread.
 *
 * The row must EXIST, or the call is an error. `dbService.updateEmail` returns
 * `null` when its `WHERE id = ? AND mailbox_id = ?` matches nothing, and this
 * function used to discard that value and answer `{ status: "updated", id,
 * read }` unconditionally — a silent false success for an id that was typo'd,
 * invented or belonging to another mailbox. The caller cannot tell that apart
 * from a real update, so it believes it changed a message it never touched.
 *
 * Reporting the miss is the same rule the sibling write tools follow:
 * `delete_email` and `discard_draft` both read the row first and answer
 * `emailNotFound` / `draftNotFound`. `updateEmail` already does that read for
 * us (it re-`SELECT`s after the `UPDATE`), so the existing `null` is the
 * existence signal — no extra round trip.
 *
 * The OTHER half of the same rule is the `read` argument, which used to be
 * taken at face value (see the guard in the body): a missing one asked for no
 * update at all, yet still answered `{ status: "updated" }`. Both defects are
 * one class — a tool may only report success for work it can actually
 * describe — and both are closed here.
 */
export async function toolMarkEmailRead(
	db: D1Database,
	mailboxId: string,
	emailId: string,
	read: boolean,
	locale?: Locale,
): Promise<MarkEmailReadResult | { error: string }> {
	const t = apiToolT(locale);

	// ── The missing-`read` guard ────────────────────────────────────────────
	// `read` is the ONLY field this tool writes, and `updateEmail` treats an
	// `undefined` one as "nothing to update": it skips the `UPDATE` entirely
	// and just re-`SELECT`s the existing row (see `workers/db/index.ts`,
	// `Object.keys(updateData).length === 0`). A truthy row comes back, the
	// existence check below passes, and the caller is told
	// `{ status: "updated", id }` — with the `read` key silently dropped from
	// the JSON because its value was `undefined`. So a call that changed
	// NOTHING reported success, for a message whose read state never moved.
	//
	// This is reachable on every path that does not go through the external
	// gateway's required-parameter gate — the internal agent loop and direct
	// calls like `executeToolCall(db, mailboxId, args.id, args.read)`, where a
	// model that omitted `read` (or spelled it `isRead` / `unread`, which the
	// alias table does not map) hands us `undefined` verbatim.
	//
	// The value is validated, not merely defaulted: a default would invent an
	// intent the caller never expressed (marking it read is as wrong as
	// marking it unread), while `tokenWord` accepts the two spellings a
	// text-based model produces — `"true"` / `"false"` — and refuses anything
	// else. That is the same "perform the write, or return an error naming the
	// parameter" rule the other write tools follow, and it is the mirror of
	// the `!emailId` guard (`emailNotFound`) the sibling write tools already
	// carry: a missing argument is the caller's to fix and must be reported as
	// such, never as a success and never as "not found" for an id that was
	// actually fine.
	if (typeof read !== "boolean") {
		const parsed = tokenWord(read);
		if (parsed === null) {
			return { error: t("invalidReadParameter") };
		}
		read = parsed;
	}

	const updated = await dbService.updateEmail(db, mailboxId, emailId, { read });
	// `null` ⇒ no row carried that (id, mailbox_id) pair. A genuine update may
	// still return `null` in theory — but only if the row vanished between the
	// `UPDATE` and the follow-up `SELECT`, in which case "not found" is the
	// honest answer anyway.
	if (!updated) {
		return { error: apiToolT(locale)("emailNotFound") };
	}
	return { status: "updated", id: emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

/**
 * The `move_email` result. `id` is the moved email, `folder` the folder it
 * now lives in — both named after the fields `list_emails` / `search_emails`
 * return for them.
 */
export interface MoveEmailResult {
	status: "moved";
	id: string;
	folder: string;
}

/**
 * Move an email into a folder.
 *
 * @param folder - The destination, as a folder **name** (`Archive`) or a
 *   folder **id** (`archive`) — the same two forms the `folder` argument of
 *   `list_emails` / `search_emails` accepts, and the same two forms the
 *   `folder` field of their results can hold. The parameter is therefore named
 *   `folder`, not `folderId`: it is not an id.
 *
 * The destination is pre-checked with {@link resolveUnknownFolder} before the
 * write is attempted. Without it, a folder that does not resolve silently
 * *fails* the move (the update matches no row) and the caller learns only the
 * generic `moveFailed`, with no hint about which folder names exist. The
 * pre-check is the same `name = ? OR id = ?` predicate the list tools use, so
 * "this folder resolves" means the same thing everywhere.
 *
 * That pre-check also determines what a `false` from `dbService.moveEmail`
 * MEANS. Its only two failure returns are "the folder reference did not
 * resolve" and "no email carried that (id, mailbox_id) pair" (the `UPDATE`
 * still reports success when it matches zero rows) — the first is already
 * excluded above, so a `false` here is an unknown email, and the caller is
 * told exactly that instead of the generic `moveFailed`. The one caveat: a
 * failure to *write* (a D1 error) surfaces as a thrown exception, not as
 * `false`, so it cannot be mistaken for a missing email — it reaches the
 * error sanitising path in the dispatcher instead.
 */
export async function toolMoveEmail(
	db: D1Database,
	mailboxId: string,
	emailId: string,
	folder: string,
	locale?: Locale,
): Promise<MoveEmailResult | { error: string }> {
	const unknownFolder = await resolveUnknownFolder(db, mailboxId, folder);
	if (unknownFolder) {
		return {
			error: unknownFolderError(i18n(locale), unknownFolder.folder, unknownFolder.valid),
		};
	}

	const success = await dbService.moveEmail(db, mailboxId, emailId, folder);
	if (success) {
		return { status: "moved", id: emailId, folder };
	}
	// The folder resolved one line ago, so the miss is the email — see the
	// doc comment. Same wording as `delete_email`'s miss, for the same reason.
	return { error: apiToolT(locale)("emailNotFound") };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	db: D1Database,
	mailboxId: string,
	draftId: string,
	locale?: Locale,
) {
	const t = apiToolT(locale);
	const email = await dbService.getEmail(db, mailboxId, draftId);
	if (!email) {
		return { error: t("draftNotFound") };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: t("cannotDiscardNotDraft") };
	}
	await dbService.deleteEmail(db, mailboxId, draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	db: D1Database,
	mailboxId: string,
	emailId: string,
	locale?: Locale,
): Promise<{ status: "deleted"; id: string } | { error: string }> {
	const result = await dbService.deleteEmail(db, mailboxId, emailId);
	if (result === null) {
		return { error: apiToolT(locale)("emailNotFound") };
	}
	return { status: "deleted", id: emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	bucket: R2Bucket,
	params: {
		/**
		 * The email being replied to. Canonical `id` matches the field
		 * `list_emails` / `search_emails` return; `originalEmailId` stays as a
		 * direct-call fallback (the dispatcher already renames it to `id`).
		 */
		id?: string;
		originalEmailId?: string;
		to: string;
		subject: string;
		bodyHtml: string;
		skipVerifyDraft?: boolean;
	},
	locale?: Locale,
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const t = apiToolT(locale);
	// Canonical first — see toolDraftReply. Without this the id is `undefined`
	// and the call fails before any work happens.
	const replyToEmailId = params.id ?? params.originalEmailId;
	if (!replyToEmailId) {
		return { error: t("originalEmailNotFound") };
	}

	// Check send rate limit
	const rateLimit = await dbService.checkSendRateLimit(db, mailboxId);
	if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
		return { error: t("hourlySendLimitExceeded", { count: rateLimit.hourlyCount, limit: rateLimit.hourlyLimit }) };
	}
	if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
		return { error: t("dailySendLimitExceeded", { count: rateLimit.dailyCount, limit: rateLimit.dailyLimit }) };
	}

	const originalEmail = await dbService.getEmail(db, mailboxId, replyToEmailId);
	if (!originalEmail) {
		return { error: t("originalEmailNotFound") };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error(t("invalidMailboxAddress"));
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Verify and append quoted original message (skipped when requested by external callers)
	let sanitizedBody = params.bodyHtml;
	if (!params.skipVerifyDraft) {
		const verification = await verifyDraft(ai, params.bodyHtml);
		if (!verification.ok) {
			return {
				error: verificationError(
					i18n(locale)("draftVerificationFailedSend"),
					verification.reason,
					locale,
				),
			};
		}
		sanitizedBody = verification.body;
	}
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date ?? undefined,
		sender: (originalEmail.sender || params.to) ?? undefined,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;

	try {
		await sendEmailFromMailbox(bucket, mailboxId, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildThreadingHeaders(originalMsgId, references),
		}, undefined, db);
	} catch (e) {
		// The vendor's own message is NOT echoed to the caller — see
		// `normalizeSendError`. `error` is fixed copy; the real cause travels in
		// `detail`, which the external gateway drops.
		console.error("Reply send failed:", e);
		return normalizeSendError(t("sendReplyFailed"), e);
	}

	await dbService.createEmail(
		db,
		mailboxId,
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references:
				references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: t("replySent", { to: params.to }) };
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	db: D1Database,
	mailboxId: string,
	ai: Ai,
	bucket: R2Bucket,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		skipVerifyDraft?: boolean;
	},
	locale?: Locale,
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const t = apiToolT(locale);
	// Check send rate limit
	const rateLimit = await dbService.checkSendRateLimit(db, mailboxId);
	if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
		return { error: t("hourlySendLimitExceeded", { count: rateLimit.hourlyCount, limit: rateLimit.hourlyLimit }) };
	}
	if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
		return { error: t("dailySendLimitExceeded", { count: rateLimit.dailyCount, limit: rateLimit.dailyLimit }) };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error(t("invalidMailboxAddress"));
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Verify the body (skipped when requested by external callers)
	let sanitizedBody = params.bodyHtml;
	if (!params.skipVerifyDraft) {
		const verification = await verifyDraft(ai, params.bodyHtml);
		if (!verification.ok) {
			return {
				error: verificationError(
					i18n(locale)("draftVerificationFailedSend"),
					verification.reason,
					locale,
				),
			};
		}
		sanitizedBody = verification.body;
	}

	try {
		await sendEmailFromMailbox(bucket, mailboxId, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
		}, undefined, db);
	} catch (e) {
		// Same rule as `toolSendReply`: fixed public message, raw cause in
		// `detail` only.
		console.error("Email send failed:", e);
		return normalizeSendError(t("sendEmailFailed"), e);
	}

	await dbService.createEmail(
		db,
		mailboxId,
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: t("emailSent", { to: params.to }) };
}
