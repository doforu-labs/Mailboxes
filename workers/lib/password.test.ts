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
		const [, iterations, salt, hash] = stored.split("$");
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
		const [prefix, iterations, salt, hash] = stored.split("$");
		const flipped =
			hash.slice(0, -2) + (hash.endsWith("A=") ? "B=" : "A=");
		assert.strictEqual(
			await verifyPassword(PASSWORD, [prefix, iterations, salt, flipped].join("$")),
			false,
		);
	});

	it("does not authenticate against the absent-user placeholder", async () => {
		assert.strictEqual(await verifyPassword(PASSWORD, ABSENT_PASSWORD_HASH), false);
		assert.strictEqual(await verifyPassword("", ABSENT_PASSWORD_HASH), false);
	});

	it("spends comparable time on a known and an unknown username", async () => {
		// Guards the timing equalisation in auth.ts: verifying against the
		// placeholder must still perform the KDF, not short-circuit.
		const stored = await toStoredPassword(PASSWORD);

		const time = async (value: string) => {
			const started = Date.now();
			await verifyPassword(PASSWORD, value);
			return Date.now() - started;
		};

		const known = await time(stored);
		const unknown = await time(ABSENT_PASSWORD_HASH);
		const malformed = await time("not-a-hash");

		// The real hash and the placeholder must both do full work; the
		// malformed value is allowed to bail out early.
		assert.ok(
			unknown >= known / 2,
			`placeholder verify (${unknown} ms) far faster than real (${known} ms)`,
		);
		assert.ok(
			malformed < known,
			`malformed verify (${malformed} ms) should short-circuit`,
		);
	});
});
