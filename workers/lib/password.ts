// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Admin password handling.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  PASSWORDS ARE HASHED WITH PBKDF2-SHA256, 100,000 ITERATIONS.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Stored format (single TEXT column, `admins.password`):
 *
 *     pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>
 *
 * The algorithm name travels with the value, so the work factor can be raised
 * later without a schema change and without guessing at the meaning of legacy
 * rows.
 *
 * Iteration count: 100,000 is workerd's hard ceiling for PBKDF2 — a larger
 * value does not buy a larger work factor, so this is the strongest PBKDF2
 * configuration available on Workers. (scrypt is also available via
 * `node:crypto` and measured faster here, but PBKDF2 through WebCrypto avoids
 * pulling in the node compat path for the login hot path.)
 *
 * Cost, measured on a real Workers **Free** deployment (2026) by reading
 * `cpuTime` out of `wrangler tail`:
 *
 *     PBKDF2-SHA256 @ 100,000 iterations   ~21-26 ms
 *     Free-plan CPU ceiling (measured)     ~2,000 ms
 *
 * An earlier revision of this file stored the password in plain text, on the
 * premise that the Free plan allows only 10 ms of CPU per request. That
 * premise did not hold on the account that was measured: a probe Worker
 * burning CPU in a loop completed at 1,894 ms and was killed at 2,020 ms,
 * while a Worker that merely slept 8 s (0 ms CPU) was never killed at all —
 * so roughly 2,000 ms of *CPU* is the real budget, and a 26 ms KDF spends
 * about 1.3% of it. The plain-text approach was therefore reverted.
 *
 * On accounts where the stricter 10 ms limit does apply, this file is the only
 * place that needs to change — see the note under `PBKDF2_ITERATIONS`.
 *
 * `toStoredPassword` and `verifyPassword` are kept as a symmetric pair so that
 * every write and read path goes through this one file.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 512;

/**
 * Work factor. Must stay <= 100,000: workerd clamps PBKDF2 above that, so a
 * larger number silently means the same amount of work.
 *
 * If you deploy somewhere with a much smaller CPU budget, lower this — but
 * note that a low iteration count is worse than useless if it still fails
 * intermittently, and that D1 lookup plus routing already cost a few ms.
 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Random bytes in a plain-ArrayBuffer-backed view.
 *
 * `crypto.getRandomValues(...)` fills in place but its generic signature widens
 * the return type to `ArrayBufferLike`, which WebCrypto's `BufferSource` does
 * not accept — so fill an explicitly constructed array instead.
 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

/** Byte-wise, length-independent, constant-time comparison. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	// Fold the length difference in rather than returning early, so timing
	// does not reveal how many leading bytes matched.
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

function deriveKey(
	password: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
): Promise<Uint8Array> {
	const key = crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	return key
		.then((imported) =>
			crypto.subtle.deriveBits(
				{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
				imported,
				KEY_BYTES * 8,
			),
		)
		.then((bits) => new Uint8Array(bits));
}

/**
 * A syntactically valid hash that no password produces, for use when the
 * requested username does not exist.
 *
 * Without this, an unknown username would skip the KDF and answer ~25 ms
 * sooner than a known one, which is a comfortable margin for enumerating admin
 * usernames over the network. Verify the candidate against this instead.
 */
export const ABSENT_PASSWORD_HASH = [
	PBKDF2_PREFIX,
	String(PBKDF2_ITERATIONS),
	toBase64(new Uint8Array(SALT_BYTES)),
	toBase64(new Uint8Array(KEY_BYTES)),
].join("$");

interface ParsedHash {
	iterations: number;
	// Backed by a plain ArrayBuffer, which is what WebCrypto's BufferSource
	// requires; a bare `Uint8Array` defaults to `ArrayBufferLike` and is not
	// accepted there.
	salt: Uint8Array<ArrayBuffer>;
	hash: Uint8Array;
}

/**
 * Parse a stored value. Returns null for anything that is not a well-formed
 * hash of ours — including the plain-text values written by earlier revisions,
 * so an old row can never be satisfied by submitting its own text.
 */
function parseStored(stored: string): ParsedHash | null {
	const parts = stored.split("$");
	if (parts.length !== 4) return null;

	const [prefix, iterationsText, saltText, hashText] = parts;
	if (prefix !== PBKDF2_PREFIX) return null;

	const iterations = Number(iterationsText);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
		// A crafted row must not be able to ask for unbounded CPU.
		return null;
	}

	try {
		const salt = fromBase64(saltText);
		const hash = fromBase64(hashText);
		if (salt.length === 0 || hash.length === 0) return null;
		return { iterations, salt, hash };
	} catch {
		return null;
	}
}

/**
 * The value to persist for a password: a salted PBKDF2-SHA256 hash in the
 * format documented at the top of this file.
 */
export async function toStoredPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const hash = await deriveKey(password, salt, PBKDF2_ITERATIONS);
	return [
		PBKDF2_PREFIX,
		String(PBKDF2_ITERATIONS),
		toBase64(salt),
		toBase64(hash),
	].join("$");
}

/**
 * Check a candidate password against the stored hash.
 *
 * Returns false for an empty, missing or malformed stored value, so a corrupt
 * row can never be satisfied by submitting an empty password.
 */
export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	if (!stored || typeof stored !== "string") return false;
	if (typeof password !== "string") return false;

	const parsed = parseStored(stored);
	if (!parsed) return false;

	const candidate = await deriveKey(password, parsed.salt, parsed.iterations);
	return timingSafeEqual(candidate, parsed.hash);
}

/** Returns an error message, or null when the password is acceptable. */
export function validatePassword(password: unknown): string | null {
	if (typeof password !== "string") return "Password is required";
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
	}
	return null;
}
