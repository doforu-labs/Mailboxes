// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * AI-powered draft verifier.
 * Reviews draft email bodies and removes agent/system artifacts that
 * leaked into the text.
 */

import { escapeHtml, stripHtmlToText, textToHtml } from "./email-helpers";
// Verification failures are reported in human-readable form upstream, so a
// failed Workers-AI call is mapped through the shared database-error helper:
// a recognized database error becomes a neutral sentence, anything else keeps
// a fixed fallback. Nothing from the raw exception is echoed outward.
//
// Note the explicit extension-less relative path: a `../db` specifier is
// resolved by i18next as namespace "db", which it silently drops, so every
// translation key came back verbatim as its own name.
import { checkVerificationSqlError } from "../db/index";

// ── Draft Verifier ─────────────────────────────────────────────────

/**
 * AI-powered draft verifier.
 *
 * Reviews draft email bodies and removes agent/system artifacts that
 * leaked into the text. Uses a capable model with a precise prompt
 * that explains what the email IS so it knows what to preserve.
 *
 * Key design: the quoted reply block (<blockquote>) is stripped BEFORE
 * sending to the AI and reattached AFTER, so the verifier only sees
 * the user's own reply text.
 *
 * AI-facing: the verifier prompt and this logic stay English-localized —
 * they steer model behaviour, not user-visible text.
 */

// AI-facing: keep English — this is a model instruction, not user-facing copy.
const VERIFIER_PROMPT = `You are a proofreader for outgoing business emails. You will receive the text of an email draft that was composed by an AI assistant on behalf of a human.

This is a REAL email being sent to a REAL person. It contains legitimate business content: URLs, links, questions, technical details, pricing info, Discord invites, docs references, etc. ALL of that is intentional and MUST be preserved exactly.

Your job: check if the AI assistant accidentally included any of its own internal commentary or system artifacts in the email text. These are things the AI said ABOUT the drafting process, not things meant for the recipient.

Examples of system artifacts to REMOVE (if present):
- "Drafted via draft_reply to email f17c9a14-..."
- "Draft saved." / "Draft created."  
- "The operator can review and send from the UI."
- "I've drafted a reply for you to review."
- "Called get_email to fetch the thread."
- "[Auto-triggered]"
- Lines containing tool function names like "draft_reply", "get_email" used as references to actions taken

Examples of legitimate email content to KEEP (never remove these):
- URLs and links (docs, Discord, API references, any https:// link)
- Questions about the recipient's use case, volume, preferences
- Pricing information, beta access details, technical caveats
- Sign-off lines (the sender's name)
- Literally everything that reads like a person talking to another person

RULES:
1. If the email has NO system artifacts, return it EXACTLY as-is, character for character. Do not rephrase, reformat, or "improve" anything.
2. If you find artifacts, remove ONLY those specific lines. Keep everything else identical.
3. When in doubt, KEEP the content. False positives (removing real content) are far worse than false negatives (leaving an artifact).
4. Return ONLY the email text. No explanations, no "Here is the cleaned version:", no wrapper text.`;

/**
 * Split an HTML body into the reply portion and the quoted block.
 */
function splitQuotedBlock(html: string): { reply: string; quoted: string } {
	const match = html.match(
		/(\s*(?:<br\s*\/?>)\s*)?(<blockquote[\s\S]*<\/blockquote>)\s*$/i,
	);
	if (match) {
		const quoted = match[0];
		const reply = html.slice(0, html.length - quoted.length);
		return { reply, quoted };
	}
	return { reply: html, quoted: "" };
}

/**
 * Verify and clean a draft email body using AI.
 *
 * Returns a discriminated result instead of a bare string so a caller can tell
 * "the verifier ran and returned the body" apart from "the verifier could not
 * run". Collapsing both into `""` is what made the tool layer report a
 * generic "draft verification failed": the real cause (a Workers-AI error, an
 * unusable model response) was logged and then discarded.
 *
 *   • `{ ok: true,  body }` — the body to use, verified whenever the verifier
 *     could actually run. The verifier is advisory for *unusable model
 *     output*: an empty response or a response that is merely whitespace-
 *     different from the input both return the caller's original body
 *     unchanged (a no-op verdict is not a failure).
 *   • `{ ok: false, reason }` — the verifier genuinely could not validate the
 *     body, so the caller MUST treat the draft/send as failed:
 *       – the Workers-AI call threw; or
 *       – the model removed more than half of the reply, i.e. it was about to
 *         gut a legitimate email and we refuse to use its output.
 *     `reason` is a short, single-line, English, machine-safe sentence built
 *     from the fixed allow-list below; it never contains SQL, ids, stack
 *     traces or vendor text.
 */
export type VerifyDraftResult =
	| { ok: true; body: string }
	| { ok: false; reason: string };

/**
 * Reason emitted when the model's output removed most of the reply.
 * Exported so the tool layer's allow-list can be pinned to this exact string
 * instead of a second hand-copied literal (a typo there silently drops the
 * detail from the outward `error`).
 */
export const VERIFIER_REASON_REMOVED_MOST =
	"the verifier removed most of the body";

/**
 * Reason emitted when the Workers-AI binding itself failed and no recognized
 * D1 error could be mapped — deliberately generic, no exception text.
 * Exported for the same reason as {@link VERIFIER_REASON_REMOVED_MOST}.
 */
export const VERIFIER_REASON_MODEL_UNREACHABLE =
	"the verification model could not be reached";

/**
 * Build the failure reason for a Workers-AI error.
 *
 * `checkVerificationSqlError` (workers/db) maps recognized database error
 * codes to neutral sentences; an unrecognized message falls back to a fixed
 * sentence so nothing vendor-shaped can be echoed outward.
 */
function verificationFailureReason(e: unknown): string {
	return checkVerificationSqlError(e) ?? VERIFIER_REASON_MODEL_UNREACHABLE;
}

export async function verifyDraft(ai: Ai, body: string): Promise<VerifyDraftResult> {
	if (!body || !body.trim()) return { ok: true, body };

	// Separate the quoted reply block so the AI only reviews the user's text
	const isHtml = /<[a-z][\s\S]*>/i.test(body);
	const { reply: replyHtml, quoted: quotedBlock } = isHtml
		? splitQuotedBlock(body)
		: { reply: body, quoted: "" };

	// Extract plain text of just the reply portion
	const replyText = isHtml ? stripHtmlToText(replyHtml) : replyHtml;

	// Skip very short replies — nothing to verify
	if (replyText.trim().length < 20) return { ok: true, body };

	try {
		const response = (await ai.run(
			"@cf/meta/llama-4-scout-17b-16e-instruct",
			{
				messages: [
					{ role: "system", content: VERIFIER_PROMPT },
					{ role: "user", content: replyText },
				],
				max_tokens: 4096,
				temperature: 0,
			},
		)) as { response?: string };

		const cleaned = response?.response ?? null;

		if (!cleaned || !cleaned.trim()) {
			// AI returned empty. The verifier is advisory: treat this as "the
			// verifier could not run" and keep the body the caller supplied.
			console.warn(
				"Draft verifier returned an empty response — keeping the original body.",
			);
			return { ok: true, body };
		}

		const cleanedTrimmed = cleaned.trim();

		// If the AI returned something substantially similar, keep original formatting
		if (normalizeWhitespace(cleanedTrimmed) === normalizeWhitespace(replyText)) {
			return { ok: true, body };
		}

		// Safety check: if the AI removed more than 50% of the content,
		// it's probably being too aggressive. This is a FAILURE, not a
		// fall-back: the body the caller asked us to verify did not survive
		// verification, and reporting it as `ok` would let an unverified (here,
		// gutted-by-the-model) body out of the draft/send tools.
		// The threshold balances between catching real artifacts and
		// preventing the verifier from flagging legitimate emails.
		if (cleanedTrimmed.length < replyText.trim().length * 0.5) {
			console.warn(
				"Draft verifier removed >50% of content — refusing the result.",
				`Original: ${replyText.trim().length} chars, Cleaned: ${cleanedTrimmed.length} chars`,
			);
			return { ok: false, reason: VERIFIER_REASON_REMOVED_MOST };
		}

		// The AI cleaned something — rebuild in the original format
		if (isHtml) {
			return { ok: true, body: `${textToHtml(cleanedTrimmed)}${quotedBlock}` };
		}

		// Plain text: reattach quoted block if any
		return {
			ok: true,
			body: quotedBlock
				? `${cleanedTrimmed}\n\n${quotedBlock}`
				: cleanedTrimmed,
		};
	} catch (e) {
		// The AI call itself failed: we could NOT verify the body, so this is a
		// genuine failure rather than a silent pass-through. Replacing the raw
		// message with a fixed sentence keeps the reason safe to surface in a
		// tool error (no SQL, ids or vendor text).
		const reason = verificationFailureReason(e);
		console.error("AI draft verification failed. Reason:", reason, e);
		return { ok: false, reason };
	}
}

function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
