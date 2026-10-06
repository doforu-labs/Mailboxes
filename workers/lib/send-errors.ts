// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Normalize an outbound-send failure into the `{ error, detail }` split the
 * tool layer already uses everywhere else.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `send_reply` / `send_email` used to interpolate the caught exception's
 * `message` straight into the **outward** `error` string:
 *
 *     return { error: t("sendReplyFailed", { message: (e as Error).message }) };
 *
 * That string is what a client sees. For a failed send it carries the sending
 * vendor's own text — `"Resend API key not configured for this mailbox. Go to
 * Settings > Account to add one, or set a domain-level API key in Domain
 * Settings."`, HTTP status bodies, internal account/host names — i.e. the same
 * class of internals `executeToolCall` deliberately keeps in `detail` and
 * `dispatchExternalTool` strips before anything leaves the process.
 *
 * ── The contract (mirrors `executeToolCall`) ────────────────────────────────
 *   • `error`  — a FIXED, caller-supplied value (the localized
 *                `apiTool:sendReplyFailed` / `sendEmailFailed` copy). Carries
 *                no exception text at all, so it is always safe to forward.
 *   • `detail` — the real cause, for the in-process agent loop: the exception
 *                message when there is one, otherwise its `String()`
 *                serialization.
 *
 * The split is not cosmetic: `dispatchExternalTool` (the external gateway)
 * reads `error` and drops `detail`, while the internal agent loop stringifies
 * the whole result into the model's context so it can self-correct. Both
 * halves stay useful, and no terminal/vendor text is ever forwarded outward.
 */
export interface SendFailure {
	/** Fixed, safe, localized message — the only part an external client sees. */
	error: string;
	/** Internal diagnostic: the raw cause. Never forwarded by the gateway. */
	detail: string;
}

/**
 * Build the `{ error, detail }` result for a failed send.
 *
 * @param publicMessage - Localized, exception-free copy (e.g. `t("sendEmailFailed")`).
 * @param cause - The caught value. Non-`Error` throwables are stringified
 *   rather than dropped, so `detail` is never empty.
 */
export function normalizeSendError(
	publicMessage: string,
	cause: unknown,
): SendFailure {
	return {
		error: publicMessage,
		detail: cause instanceof Error ? cause.message : String(cause),
	};
}
