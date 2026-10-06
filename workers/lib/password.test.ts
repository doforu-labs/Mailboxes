// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Tests for admin password handling.
 *
 * To run: npm test
 *
 * These pin the storage format. An earlier revision stored passwords in plain
 * text; the "rejects plain-text rows" cases below exist so that a regression
 * to that behaviour is caught here rather than in production.
 *
 * One case here used to assert on the wall clock (`placeholder >= real / 2`).
 * That is not merely a tight threshold — a single `Date.now()` measurement of a
 * ~10 ms KDF swings by an order of magnitude when `node --test` runs these
 * files in parallel. Measured on this machine:
 *
 *     alone               real 9.5-11.9 ms   placeholder 9.2-10.0 ms   ratio 0.78
 *     full parallel suite real 13.4-97.9 ms  placeholder 16.1-97.4 ms  ratio 0.17
 *
 * so the ratio crosses any threshold that has any teeth (the CI reports were
 * "placeholder verify (33 ms) far faster than real (76 ms)"), while a threshold
 * loose enough to survive the noise no longer detects a short-circuit. The
 * timing assertion is therefore gone, and the same property — "the unknown-user
 * path performs the same expensive KDF, so it cannot be told apart by response
 * time" — is asserted on the KDF parameters, which do not jitter at all.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ABSENT_PASSWORD_HASH,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	toStoredPassword,
	validatePassword,
	verifyPassword,
} from "./password";

const PASSWORD = "s3cret-passphrase";
const UNICODE_PASSWORD = "пароль-密码-🔐";

/** The documented work factor (see the header of ./password.ts). */
const EXPECTED_KDF_ITERATIONS = 100_000;

function partsOf(stored: string): string[] {
	return stored.split("$");
}

describe("validatePassword", () => {
	it("rejects non-strings", () => {
		assert.ok(validatePassword(undefined));
		assert.ok(validatePassword(null));
		assert.ok(validatePassword(12345678));
		assert.ok(validatePassword({}));
	});

	it("rejects passwords shorter than the minimum", () => {
		assert.ok(validatePassword(""));
		assert.ok(validatePassword("a".repeat(MIN_PASSWORD_LENGTH - 1)));
	});

	it("accepts a password of exactly the minimum length", () => {
		assert.strictEqual(validatePassword("a".repeat(MIN_PASSWORD_LENGTH)), null);
	});

	it("rejects absurdly long passwords", () => {
		assert.ok(validatePassword("a".repeat(MAX_PASSWORD_LENGTH + 1)));
	});
});

describe("toStoredPassword", () => {
	it("produces a tagged pbkdf2 sha256 hash", async () => {
		const stored = await toStoredPassword(PASSWORD);
		assert.match(
			stored,
			/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/,
		);
	});

	it("never contains the password", async () => {
		const stored = await toStoredPassword(PASSWORD);
		assert.ok(!stored.includes(PASSWORD));
	});

	it("salts every hash, so equal passwords do not collide", async () => {
		const [a, b] = await Promise.all([
			toStoredPassword(PASSWORD),
			toStoredPassword(PASSWORD),
		]);
		assert.notStrictEqual(a, b);
		// Different salt, different digest — but both verify.
		assert.strictEqual(await verifyPassword(PASSWORD, a), true);
		assert.strictEqual(await verifyPassword(PASSWORD, b), true);
	});
});

describe("verifyPassword", () => {
	it("accepts the correct password", async () => {
		const stored = await toStoredPassword(PASSWORD);
		assert.strictEqual(await verifyPassword(PASSWORD, stored), true);
	});

	it("rejects a wrong password", async () => {
		const stored = await toStoredPassword(PASSWORD);
		assert.strictEqual(await verifyPassword("s3cret-passphras", stored), false);
		assert.strictEqual(await verifyPassword("s3cret-passphraseX", stored), false);
		assert.strictEqual(await verifyPassword("S3CRET-PASSPHRASE", stored), false);
		assert.strictEqual(await verifyPassword("", stored), false);
	});

	it("rejects prefixes and suffixes", async () => {
		const stored = await toStoredPassword("passphrase");
		assert.strictEqual(await verifyPassword("pass", stored), false);
		assert.strictEqual(await verifyPassword("passphrase!", stored), false);
	});

	it("round-trips multi-byte passwords", async () => {
		const stored = await toStoredPassword(UNICODE_PASSWORD);
		assert.strictEqual(await verifyPassword(UNICODE_PASSWORD, stored), true);
		// Same byte length, different content — must not pass.
		assert.strictEqual(await verifyPassword("пароль-密码-🔓", stored), false);
	});

	it("never accepts an empty or missing stored value", async () => {
		assert.strictEqual(await verifyPassword("", ""), false);
		assert.strictEqual(await verifyPassword("anything", ""), false);
		assert.strictEqual(await verifyPassword("", null as unknown as string), false);
		assert.strictEqual(
			await verifyPassword("anything", undefined as unknown as string),
			false,
		);
	});

	it("rejects plain-text rows written by an earlier revision", async () => {
		// Regression guard: the pre-KDF format stored the password verbatim.
		// Such a row must not be usable to log in.
		assert.strictEqual(await verifyPassword(PASSWORD, PASSWORD), false);
		assert.strictEqual(await verifyPassword(UNICODE_PASSWORD, UNICODE_PASSWORD), false);
	});

	it("rejects malformed stored values", async () => {
		const stored = await toStoredPassword(PASSWORD);
		const [, iterations, salt, hash] = partsOf(stored);
		const cases = [
			"",
			"not-a-hash",
			"pbkdf2-sha256$100000$onlythree",
			`bcrypt$100000$${salt}$${hash}`, // unknown algorithm
			`pbkdf2-sha256$0$${salt}$${hash}`, // no work at all
			`pbkdf2-sha256$-1$${salt}$${hash}`,
			`pbkdf2-sha256$999999999$${salt}$${hash}`, // would demand unbounded CPU
			`pbkdf2-sha256$${iterations}$!!!not-base64!!!$${hash}`,
			`pbkdf2-sha256$${iterations}$${salt}$`,
		];
		for (const bad of cases) {
			assert.strictEqual(await verifyPassword(PASSWORD, bad), false, bad);
		}
	});

	it("rejects a tampered digest", async () => {
		const stored = await toStoredPassword(PASSWORD);
		const [prefix, iterations, salt, hash] = partsOf(stored);

		// Flip one bit of one byte in the middle of the digest instead of
		// editing the base64 text. The final character of a 32-byte digest
		// carries only four significant bits, so a textual edit can decode
		// to the very same bytes — which made this assertion depend on the
		// random salt (it failed roughly once every 16 runs).
		const digest = Buffer.from(hash, "base64");
		digest.writeUInt8(digest.readUInt8(16) ^ 0x01, 16);
		const tampered = digest.toString("base64");
		assert.notStrictEqual(tampered, hash);

		assert.strictEqual(
			await verifyPassword(PASSWORD, [prefix, iterations, salt, tampered].join("$")),
			false,
		);
	});

	it("does not authenticate against the absent-user placeholder", async () => {
		assert.strictEqual(await verifyPassword(PASSWORD, ABSENT_PASSWORD_HASH), false);
		assert.strictEqual(await verifyPassword("", ABSENT_PASSWORD_HASH), false);
	});

	it("runs the placeholder through the same KDF as a real stored hash", async () => {
		// ── The security property this file exists to protect ─────────────
		//
		// handleLogin (./auth.ts) substitutes ABSENT_PASSWORD_HASH when the
		// username resolves to no row, and verifies the candidate against it
		// instead of answering early. That is the only reason an unknown
		// username costs the same as a known one, and the reason usernames
		// cannot be enumerated by response time.
		//
		// The property has exactly two failure modes, and both are checked
		// below without a single clock reading:
		//
		//   1. the placeholder stops parsing as one of our hashes, so
		//      verifyPassword bails out before deriving; or
		//   2. it parses, but with a cheaper work factor.
		//
		// Its *response* gives nothing away either way — an unparseable stored
		// value returns false just as a losing comparison does — so the return
		// value alone cannot carry this test. The work factor is what has to be
		// asserted, and the work factor is right there in the value:
		// `deriveBits` is given `iterations` from the parsed hash, so the
		// iteration count in the placeholder *is* the cost of using it.
		const placeholderParts = partsOf(ABSENT_PASSWORD_HASH);
		const realParts = partsOf(await toStoredPassword(PASSWORD));

		// (1) It is a well-formed value of ours. `parseStored` requires the
		// exact prefix, four segments, integer iterations within range, and
		// non-empty base64 salt + digest — so this is the same gate that
		// decides whether the placeholder is used at all.
		assert.strictEqual(
			placeholderParts.length,
			4,
			"the placeholder must parse; a value with the wrong number of segments is rejected before any hashing",
		);
		const [placeholderPrefix, placeholderIterationsText, placeholderSalt, placeholderDigest] =
			placeholderParts;
		assert.strictEqual(placeholderPrefix, "pbkdf2-sha256");
		assert.match(placeholderIterationsText, /^\d+$/);

		// (2) At the documented cost: the same iterations as a real hash, not
		// merely "some" iterations. A placeholder with 1 or 1,000 iterations
		// would still return false and still be minutes faster to crack.
		const iterations = Number(placeholderIterationsText);
		assert.strictEqual(
			iterations,
			EXPECTED_KDF_ITERATIONS,
			`the placeholder must run the full ${EXPECTED_KDF_ITERATIONS}-iteration KDF`,
		);
		assert.strictEqual(
			placeholderIterationsText,
			realParts[1],
			"the placeholder must cost the same as a real stored hash",
		);

		// (3) The salt and digest are non-empty and properly sized, so
		// `timingSafeEqual` walks the full 32 bytes — a zero-length digest
		// would leave the comparison with nothing to fold while still
		// returning false. `ABSENT_PASSWORD_HASH` is built by base64-encoding
		// fixed-length zero buffers, so these are exact.
		assert.strictEqual(Buffer.from(placeholderSalt, "base64").length, 16);
		assert.strictEqual(Buffer.from(placeholderDigest, "base64").length, 32);

		// (4) Finally, the same property stated the other way round: a value
		// that cannot be one of our hashes must NOT reach the KDF, while the
		// placeholder must. Counted through WebCrypto, the platform primitive
		// `deriveKey` uses — not through a module seam, and never through
		// `Date.now()`.
		const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
		const derived: unknown[] = [];
		(crypto.subtle as unknown as { deriveBits: unknown }).deriveBits = (
			...args: unknown[]
		) => {
			derived.push(args[0]);
			return deriveBits(...(args as Parameters<typeof deriveBits>));
		};
		try {
			assert.strictEqual(await verifyPassword(PASSWORD, ABSENT_PASSWORD_HASH), false);
			assert.strictEqual(
				derived.length,
				1,
				"the placeholder must reach the KDF; an early return would make an unknown username measurably faster",
			);
			const { iterations: usedIterations } = derived[0] as Pbkdf2Params;
			assert.strictEqual(usedIterations, EXPECTED_KDF_ITERATIONS);

			derived.length = 0;
			assert.strictEqual(await verifyPassword(PASSWORD, "not-a-hash"), false);
			assert.strictEqual(await verifyPassword(PASSWORD, PASSWORD), false);
			assert.strictEqual(
				derived.length,
				0,
				"only well-formed rows may skip the KDF, and only because there is nothing to compare against",
			);
		} finally {
			(crypto.subtle as unknown as { deriveBits: unknown }).deriveBits = deriveBits;
		}

		// (5) And a loose liveness check on the direction of (2), which is the
		// one thing the parameters above cannot show. Two things are read off
		// one sample and they move together under load (see the header table),
		// so this cannot cross on scheduling noise — while an implementation
		// that derived nothing at all for the placeholder would sit at ~0 ms
		// against the real hash's millisecond-scale floor, which is a gap of
		// several orders of magnitude, not a jitter.
		const sample = async (stored: string) => {
			const started = Date.now();
			await verifyPassword(PASSWORD, stored);
			return Date.now() - started;
		};
		const realMs = await sample(realParts.join("$"));
		const placeholderMs = await sample(ABSENT_PASSWORD_HASH);
		assert.ok(
			placeholderMs * 10 >= realMs,
			`the placeholder must do comparable work: placeholder ${placeholderMs} ms vs real ${realMs} ms`,
		);
	});
});

// ── Which shape the placeholder takes ───────────────────────────────
//
// `ABSENT_PASSWORD_HASH` is built from module-private constants, so the case
// above is most of its contract; these two keep the rest of it pinned.
describe("ABSENT_PASSWORD_HASH", () => {
	it("stays in lockstep with the work factor real hashes are written with", async () => {
		// Reading it off a freshly written hash, rather than repeating the
		// number, is what makes this a lockstep check instead of a literal.
		const realIterations = Number(partsOf(await toStoredPassword(PASSWORD))[1]);
		assert.strictEqual(Number(partsOf(ABSENT_PASSWORD_HASH)[1]), realIterations);
	});

	it("keeps the lookup miss and the failed comparison indistinguishable", async () => {
		// The observable side of the equalisation. Both branches of handleLogin
		// end in the same literal, so whatever the client sees for one it sees
		// for the other: identical status, identical body.
		const stored = await toStoredPassword(PASSWORD);
		const wrongPassword = await verifyPassword("not-the-password", stored);
		const unknownUsername = await verifyPassword(PASSWORD, ABSENT_PASSWORD_HASH);
		assert.strictEqual(wrongPassword, unknownUsername);
		assert.strictEqual(wrongPassword, false);
	});
});
