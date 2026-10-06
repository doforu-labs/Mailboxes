// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Global API key primitives — pure functions, no I/O, no DB, no framework.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  KEY FORMAT:  agk_ + 64 lowercase hex characters (32 random bytes)
 * ─────────────────────────────────────────────────────────────────────
 *
 *     agk_<64 hex>            full key, shown to the operator exactly once
 *     agk_<8 hex>             `prefix`, 12 chars, stored for lookup + UI
 *     sha256(full key) hex    `hash`, the only value worth persisting
 *
 * An earlier revision of this file minted `mb_` keys with 24 random bytes
 * (192 bits of entropy) and compared hashes with `===`. Both were retired in
 * commit ecd1413 and are deliberately NOT accepted here:
 *
 *   - The `agk_` prefix keeps the new key family distinguishable from `mb_`
 *     rows in logs, secret scanners and `Authorization` headers, so a leaked
 *     legacy key can be identified (and revoked) without ambiguity.
 *   - 32 bytes (256 bits) matches the SHA-256 digest width, so the key is
 *     never the weak link in the chain.
 *   - String `===` over the hash would leak, byte by byte, how many leading
 *     characters a guess got right. The `timingSafeEqualHex` primitive below
 *     exposes that constant-time comparison for callers that compare digests
 *     in-process; the production verification path does not need it, because
 *     it never compares two strings in JS — it hands the freshly computed
 *     digest to `getAgentApiKeyByHash`, which matches it with a SQL `=`.
 *
 * Things this module intentionally does NOT do: touch the database, import
 * Hono, read env, log, or generate IDs. It is arithmetic over bytes, and
 * everything stateful lives at the call site.
 */

/** Marks the `agk_` key family. Changing it orphans every issued key. */
const KEY_PREFIX = "agk_";

/** Bytes of CSPRNG output per key. 32 bytes = 256 bits = the SHA-256 width. */
const KEY_BYTES = 32;

/**
 * Hex characters kept in `prefix`, i.e. 8 (4 bytes).
 *
 * 32 bits is far more than needed to make prefix collisions improbable — a
 * table of a million keys still collides with probability ~10⁻² — while being
 * short enough to render in a UI list without truncation. The prefix is an
 * *index and a label*, never a credential: verification always re-hashes the
 * full key and compares digests.
 */
const PREFIX_HEX_CHARS = 8;

/** Full prefix length in characters: "agk_" + 8. */
const PREFIX_LENGTH = KEY_PREFIX.length + PREFIX_HEX_CHARS;

/** `agk_` followed by exactly 64 lowercase hex characters. */
const KEY_PATTERN = /^agk_[0-9a-f]{64}$/;

/**
 * Lowercase hex encoding.
 *
 * Manual instead of `Array.from(...).map()` so the hot path allocates one
 * string rather than a 32-element intermediate array; this runs on every
 * authenticated request.
 */
function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

/** Matches a whole string of hex digits; rejects any non-hex character. */
const HEX_PATTERN = /^[0-9a-f]*$/;

/**
 * Decode a hex string to bytes, or null if it is not well-formed hex.
 *
 * Length must be even and every character must be `[0-9a-f]` (case
 * insensitive on input — `timingSafeEqualHex` normalizes before it gets
 * here). Returns null rather than throwing so callers can treat a malformed
 * digest as a failed comparison instead of a 500.
 *
 * Validation is done up front by regex rather than by inspecting the result of
 * `parseInt`. `parseInt` is *not* a validator: it stops at the first character
 * it cannot use and returns what it has, so `parseInt("0g", 16) === 0` and an
 * `isNaN` check accepts `"0g"` as a perfectly good byte. That would let a
 * non-hex string compare equal to another identical non-hex string, which is
 * the opposite of what a comparison primitive should do.
 */
function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0) return null;
	if (!HEX_PATTERN.test(hex)) return null;

	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * SHA-256 of the plaintext key, as lowercase hex.
 *
 * The plaintext is what gets hashed, with no salt and no stretching. That is
 * correct *only* because the input is 256 bits of CSPRNG output: there is no
 * dictionary to enumerate, so KDF stretching would buy nothing and cost CPU on
 * every request. It would be wrong for a user-chosen secret — see
 * `password.ts`, which uses PBKDF2 for exactly that reason.
 *
 * Hashes are NOT compared with `===` anywhere; see `timingSafeEqualHex` for
 * the in-process primitive and the note on why the production path does not
 * call it.
 */
export async function hashApiKey(plainText: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(plainText),
	);
	return bytesToHex(new Uint8Array(digest));
}

/**
 * Mint a fresh API key.
 *
 * Returns the plaintext (persist only the hash; the plaintext is unrecoverable
 * afterwards and must be shown to the operator exactly once), the display /
 * lookup prefix, and the hash.
 */
export async function generateApiKey(): Promise<{
	plainText: string;
	prefix: string;
	hash: string;
}> {
	const bytes = new Uint8Array(KEY_BYTES);
	// Construct then fill rather than `crypto.getRandomValues(new Uint8Array(n))`:
	// the latter's generic signature widens the type to `ArrayBufferLike`,
	// which WebCrypto's `BufferSource` rejects as a digest input.
	crypto.getRandomValues(bytes);

	const plainText = KEY_PREFIX + bytesToHex(bytes);

	return {
		plainText,
		prefix: plainText.slice(0, PREFIX_LENGTH),
		hash: await hashApiKey(plainText),
	};
}

/**
 * Pull the key out of an `Authorization` header value.
 *
 * Accepts a `Bearer <key>` pair or a bare key, and returns null for anything
 * else — a wrong scheme, a missing header, a non-`agk_` key family, or a value
 * that does not have the exact shape of a key we issue.
 *
 * `Bearer` is matched case-insensitively per RFC 7235 (auth-scheme is
 * case-insensitive), which also covers the `bearer`/`BEARER` variants some
 * HTTP clients emit. The original implementation used
 * `startsWith("Bearer ")` and so rejected those; this does not.
 *
 * Shape validation is a cheap pre-filter, not authentication: a value that
 * fails the pattern never reaches the database. A value that passes still
 * needs its hash looked up and compared.
 */
export function extractBearerToken(
	header: string | null | undefined,
): string | null {
	if (!header || typeof header !== "string") return null;

	const trimmed = header.trim();

	// Bare key: "agk_..."
	if (!trimmed.includes(" ")) {
		return KEY_PATTERN.test(trimmed) ? trimmed : null;
	}

	// Scheme + credentials: "Bearer agk_..."
	// Split on the first space only; the credentials part cannot contain one,
	// but this keeps the parse honest about where the scheme ends.
	const separator = trimmed.indexOf(" ");
	const scheme = trimmed.slice(0, separator);
	const credentials = trimmed.slice(separator + 1).trim();

	if (scheme.toLowerCase() !== "bearer") return null;
	return KEY_PATTERN.test(credentials) ? credentials : null;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * ── Status: available primitive, NOT on the production verification path ──
 * Nothing in `workers/` calls this today, and that is deliberate rather than
 * an oversight. Verification (`requireGlobalApiKey`) re-hashes the presented
 * key and looks the digest up with `getAgentApiKeyByHash`, i.e. a SQL `=`
 * against an indexed column. The compared value is the SHA-256 of 256 bits of
 * CSPRNG output, so the digest is uniform and unattributable to any candidate
 * plaintext an attacker could feed the comparison; a remote timing signal
 * across a D1 query cannot leak it either. A JS-side constant-time compare
 * would therefore buy nothing here. Should a future caller ever compare two
 * digests *in process* (e.g. a cached hash), this is the function to use —
 * and until then it is keep-it-small surface, not a hidden security control.
 *
 * Both sides are decoded to bytes and folded together with XOR. Everything the
 * comparison touches — the loop count, the accumulator, the branch — depends
 * only on the *lengths* of the inputs, which are public (a SHA-256 digest is
 * always 64 hex characters). No early exit on the first differing byte, so
 * timing cannot be used to recover the digest one character at a time.
 *
 * Length mismatch is the one early return, and it is safe for the same reason:
 * digest length is not a secret. This is what makes the function usable for a
 * caller comparing a freshly computed hash against an arbitrary stored value.
 *
 * Not the same primitive as `timingSafeEqual` in `password.ts`: that one
 * tolerates unequal-length input by zero-padding, which is what a variable
 * length PBKDF2 output needs. Here the contract is "equal-length hex or
 * false", because in this module unequal lengths can only mean a malformed
 * digest.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length) return false;
	if (a.length === 0) return false;

	// Normalize case before decoding so a digest stored as uppercase hex still
	// compares equal; the comparison itself stays byte-wise.
	const left = hexToBytes(a.toLowerCase());
	const right = hexToBytes(b.toLowerCase());

	// Non-hex input cannot correspond to any digest, so this can only be false
	// — including when *both* sides are the same non-hex string, which must not
	// read as a match. Returning here is not a timing oracle: the cost of
	// `hexToBytes` is a function of the length, which the caller already knows.
	if (left === null || right === null) return false;

	let diff = 0;
	for (let i = 0; i < left.length; i++) {
		diff |= (left[i] as number) ^ (right[i] as number);
	}
	return diff === 0;
}
