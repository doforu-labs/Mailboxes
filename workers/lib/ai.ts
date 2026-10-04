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
 * Falls back to returning the original body if the AI call fails.
 */
export async function verifyDraft(ai: Ai, body: string): Promise<string> {
	if (!body || !body.trim()) return body;

	// Separate the quoted reply block so the AI only reviews the user's text
	const isHtml = /<[a-z][\s\S]*>/i.test(body);
	const { reply: replyHtml, quoted: quotedBlock } = isHtml
		? splitQuotedBlock(body)
		: { reply: body, quoted: "" };

	// Extract plain text of just the reply portion
	const replyText = isHtml ? stripHtmlToText(replyHtml) : replyHtml;

	// Skip very short replies — nothing to verify
	if (replyText.trim().length < 20) return body;

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
			// AI returned empty — fall back to original
			return body;
		}

		const cleanedTrimmed = cleaned.trim();

		// If the AI returned something substantially similar, keep original formatting
		if (normalizeWhitespace(cleanedTrimmed) === normalizeWhitespace(replyText)) {
			return body;
		}

		// Safety check: if the AI removed more than 50% of the content,
		// it's probably being too aggressive — fall back to original.
		// This threshold balances between catching real artifacts and
		// preventing the verifier from gutting legitimate emails.
		if (cleanedTrimmed.length < replyText.trim().length * 0.5) {
			console.warn(
				"Draft verifier removed >50% of content, falling back to original.",
				`Original: ${replyText.trim().length} chars, Cleaned: ${cleanedTrimmed.length} chars`,
			);
			return body;
		}

		// The AI cleaned something — rebuild in the original format
		if (isHtml) {
			return `${textToHtml(cleanedTrimmed)}${quotedBlock}`;
		}

		// Plain text: reattach quoted block if any
		return quotedBlock
			? `${cleanedTrimmed}\n\n${quotedBlock}`
			: cleanedTrimmed;
	} catch (e) {
				console.error("AI failed — returns empty body, callers may save blank draft:", (e as Error).message);
		return "";
	}
}

function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}
