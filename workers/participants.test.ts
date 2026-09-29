// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the email-list sender / participant label helpers.
 *
 * To run: npm test  (npx tsx --test 'workers/**\/*.test.ts')
 *
 * Regression guard for the "everything looks like noreply" bug: the list must
 * prefer the From display name and only fall back to the address local-part.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	PARTICIPANT_ENTRY_SEP,
	PARTICIPANT_NAME_SEP,
	decodeMimeWords,
	formatParticipantLabel,
	formatSenderFull,
	formatSenderLabel,
	formatSenderWithAddress,
	parseParticipantLabels,
	sanitizeSenderName,
	stripHeaderChars,
} from "../shared/participants";

/** Build a participants_meta string the same way the SQL aggregate does. */
function meta(...pairs: Array<[string | null, string]>): string {
	return pairs
		.map(([name, address]) => `${name ?? ""}${PARTICIPANT_NAME_SEP}${address}`)
		.join(PARTICIPANT_ENTRY_SEP);
}

/** Base64-encode UTF-8 text without relying on Node's Buffer. */
function toBase64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Build an RFC 2047 encoded-word the way a mail client would. */
function encodedWord(text: string, charset = "utf-8"): string {
	return `=?${charset}?B?${toBase64(text)}?=`;
}

describe("formatSenderLabel", () => {
	it("prefers the display name over the address", () => {
		assert.strictEqual(
			formatSenderLabel("GitHub", "noreply@github.com"),
			"GitHub",
		);
	});

	it("falls back to the local-part when there is no display name", () => {
		assert.strictEqual(formatSenderLabel(null, "noreply@github.com"), "noreply");
		assert.strictEqual(formatSenderLabel("", "jane@example.com"), "jane");
		assert.strictEqual(formatSenderLabel("   ", "jane@example.com"), "jane");
	});

	it("returns an empty string when neither is present", () => {
		assert.strictEqual(formatSenderLabel(null, null), "");
		assert.strictEqual(formatSenderLabel(undefined, undefined), "");
	});

	it("treats a name that is itself an address as absent", () => {
		// Shape produced by `"noreply@github.com" <noreply@github.com>`.
		assert.strictEqual(formatSenderLabel("noreply@github.com", "noreply@github.com"), "noreply");
		assert.strictEqual(formatSenderLabel("jane@example.com", "jane@example.com"), "jane");
		// A bare "@" that is not an address is NOT enough to discard the name.
		assert.strictEqual(formatSenderLabel("Support via @help", "a@b.com"), "Support via @help");
		assert.strictEqual(formatSenderLabel("Acme@Home", "a@b.com"), "Acme@Home");
	});

	it("keeps a legitimate display name that contains an '@'", () => {
		// Regression: the backfill used to drop any name containing "@", so these
		// rendered as the local-part on old rows but as the name on new ones.
		assert.strictEqual(formatSenderLabel("Acme @ Home", "noreply@acme.com"), "Acme @ Home");
		assert.strictEqual(formatSenderLabel("Alice <@alice>", "alice@x.com"), "Alice <@alice>");
		assert.strictEqual(formatSenderLabel("Ann Smith, @ACME", "ann@acme.com"), "Ann Smith, @ACME");
	});
});

describe("formatSenderWithAddress", () => {
	it("keeps the name and the address visible to machine consumers", () => {
		assert.strictEqual(
			formatSenderWithAddress("GitHub", "noreply@github.com"),
			"GitHub <noreply@github.com>",
		);
	});

	it("falls back to the bare address when there is no name", () => {
		assert.strictEqual(formatSenderWithAddress(null, "noreply@github.com"), "noreply@github.com");
		assert.strictEqual(formatSenderWithAddress("noreply@github.com", "noreply@github.com"), "noreply@github.com");
	});

	it("returns an empty string when neither is present", () => {
		assert.strictEqual(formatSenderWithAddress(null, undefined), "");
	});
});

describe("parseParticipantLabels", () => {
	it("keeps display names paired with their address", () => {
		assert.deepStrictEqual(
			parseParticipantLabels(meta(["GitHub", "noreply@github.com"], ["Jane Doe", "jane@example.com"])),
			["GitHub", "Jane Doe"],
		);
	});

	it("preserves a comma inside a display name", () => {
		// A "," separator would have split this into two participants.
		assert.deepStrictEqual(
			parseParticipantLabels(meta(["Smith, John", "comma@example.com"])),
			["Smith, John"],
		);
	});

	it("merges duplicate addresses, preferring the named entry", () => {
		// Same address appears once with a name and once without (older message).
		assert.deepStrictEqual(
			parseParticipantLabels(meta([null, "noreply@github.com"], ["GitHub", "noreply@github.com"])),
			["GitHub"],
		);
		// ...and the other way round.
		assert.deepStrictEqual(
			parseParticipantLabels(meta(["GitHub", "noreply@github.com"], [null, "noreply@github.com"])),
			["GitHub"],
		);
	});

	it("falls back to the local-part for name-less entries", () => {
		assert.deepStrictEqual(
			parseParticipantLabels(meta([null, "plain@example.com"])),
			["plain"],
		);
	});

	it("returns an empty array for missing or empty input", () => {
		assert.deepStrictEqual(parseParticipantLabels(null), []);
		assert.deepStrictEqual(parseParticipantLabels(undefined), []);
		assert.deepStrictEqual(parseParticipantLabels(""), []);
	});
});

describe("formatParticipantLabel", () => {
	it("shows the display name for a single-sender conversation", () => {
		assert.strictEqual(
			formatParticipantLabel(meta(["GitHub", "noreply@github.com"])),
			"GitHub",
		);
	});

	it("joins up to three participants", () => {
		assert.strictEqual(
			formatParticipantLabel(
				meta(
					["GitHub", "noreply@github.com"],
					["Jane Doe", "jane@example.com"],
					["Bob", "bob@example.com"],
				),
			),
			"GitHub, Jane Doe, Bob",
		);
	});

	it("collapses busy threads to 'first two +N'", () => {
		assert.strictEqual(
			formatParticipantLabel(
				meta(
					["GitHub", "noreply@github.com"],
					["Jane Doe", "jane@example.com"],
					["Bob", "bob@example.com"],
					["Amy", "amy@example.com"],
				),
			),
			"GitHub, Jane Doe +2",
		);
	});

	it("falls back to the single sender when there is no aggregate", () => {
		// Non-threaded requests (no folder) return no participants_meta.
		assert.strictEqual(
			formatParticipantLabel(null, {
				name: "GitHub",
				address: "noreply@github.com",
			}),
			"GitHub",
		);
		assert.strictEqual(
			formatParticipantLabel(undefined, {
				name: null,
				address: "noreply@github.com",
			}),
			"noreply",
		);
	});

	it("regression: never renders a bare 'noreply' when a name exists", () => {
		const label = formatParticipantLabel(meta(["GitHub", "noreply@github.com"]), {
			name: null,
			address: "noreply@github.com",
		});
		assert.notStrictEqual(label, "noreply");
		assert.strictEqual(label, "GitHub");
	});
});

describe("decodeMimeWords (RFC 2047)", () => {
	it("decodes a base64 encoded-word", () => {
		assert.strictEqual(decodeMimeWords(encodedWord("Announcements")), "Announcements");
		assert.strictEqual(decodeMimeWords(encodedWord("会议通知")), "会议通知");
	});

	it("decodes a quoted-printable encoded-word", () => {
		assert.strictEqual(decodeMimeWords("=?utf-8?Q?M=C3=BCller?="), "Müller");
		// "_" stands for a space inside an encoded-word.
		assert.strictEqual(decodeMimeWords("=?utf-8?Q?Hello_World?="), "Hello World");
	});

	it("decodes encoded-words mixed with plain text", () => {
		assert.strictEqual(
			decodeMimeWords(`${encodedWord("Announcements")} Team`),
			"Announcements Team",
		);
	});

	it("passes plain values through untouched", () => {
		assert.strictEqual(decodeMimeWords("GitHub"), "GitHub");
		assert.strictEqual(decodeMimeWords("Smith, John"), "Smith, John");
		assert.strictEqual(decodeMimeWords(null), "");
		assert.strictEqual(decodeMimeWords(undefined), "");
	});

	it("leaves a malformed encoded-word intact instead of throwing", () => {
		assert.strictEqual(
			decodeMimeWords("=?utf-8?B?!!!not-base64!!!?="),
			"=?utf-8?B?!!!not-base64!!!?=",
		);
		assert.strictEqual(decodeMimeWords("=?broken"), "=?broken");
	});

	it("falls back to utf-8 for an unknown charset", () => {
		assert.strictEqual(decodeMimeWords(encodedWord("Test", "x-unknown-charset")), "Test");
	});
});

describe("sanitizeSenderName", () => {
	it("strips control characters that would corrupt participants_meta", () => {
		assert.strictEqual(sanitizeSenderName(`Bad${PARTICIPANT_ENTRY_SEP}Name`), "Bad Name");
		assert.strictEqual(sanitizeSenderName(`Bad${PARTICIPANT_NAME_SEP}Name`), "Bad Name");
		assert.strictEqual(sanitizeSenderName("a\u0000b\u007fc"), "a b c");
	});

	it("collapses whitespace and trims", () => {
		assert.strictEqual(sanitizeSenderName("  Jane   Doe  "), "Jane Doe");
	});

	it("returns null for empty or whitespace-only values", () => {
		assert.strictEqual(sanitizeSenderName(null), null);
		assert.strictEqual(sanitizeSenderName(undefined), null);
		assert.strictEqual(sanitizeSenderName("   "), null);
	});

	it("caps the stored length", () => {
		assert.strictEqual(sanitizeSenderName("x".repeat(500))?.length, 400);
	});
});

describe("display labels with messy input", () => {
	it("decodes encoded-words when rendering the label", () => {
		assert.strictEqual(
			formatSenderLabel(encodedWord("会议通知"), "noreply@example.com"),
			"会议通知",
		);
	});

	it("never leaks control characters into the label", () => {
		const label = formatSenderLabel(`Evil${PARTICIPANT_ENTRY_SEP}Corp`, "e@example.com");
		assert.ok(!label.includes(PARTICIPANT_ENTRY_SEP));
		assert.strictEqual(label, "Evil Corp");
	});

	it("formatSenderFull prefers the name and falls back to the full address", () => {
		assert.strictEqual(formatSenderFull("GitHub", "noreply@github.com"), "GitHub");
		assert.strictEqual(formatSenderFull(null, "noreply@github.com"), "noreply@github.com");
	});
});

describe("display spoofing defences", () => {
	it("strips bidi overrides that could reorder the rendered label", () => {
		assert.strictEqual(formatSenderLabel("Acme\u202Egnixalgm", "a@b.com"), "Acmegnixalgm");
		assert.strictEqual(formatSenderLabel("\u202Bevil\u202C", "a@b.com"), "evil");
		assert.strictEqual(formatSenderLabel("a\u2066b\u2069", "a@b.com"), "ab");
	});

	it("strips zero-width characters", () => {
		assert.strictEqual(formatSenderLabel("Ad\u200Bmin", "a@b.com"), "Admin");
		assert.strictEqual(formatSenderLabel("\uFEFFGitHub", "a@b.com"), "GitHub");
		assert.strictEqual(formatSenderLabel("so\u00ADft", "a@b.com"), "soft");
	});

	it("treats an all-invisible name as absent", () => {
		assert.strictEqual(sanitizeSenderName("\u200B"), null);
		assert.strictEqual(sanitizeSenderName("\u200B\u202E\uFEFF"), null);
		assert.strictEqual(formatSenderLabel("\u200B", "noreply@github.com"), "noreply");
	});

	it("strips NUL bytes smuggled through base64", () => {
		// "AB" is not valid padded base64; atob() silently yields a NUL.
		assert.ok(!decodeMimeWords("=?utf-8?B?AB?=").includes("\u0000"));
		assert.ok(!decodeMimeWords("=?utf-8?Q?A=00B?=").includes("\u0000"));
	});
});

describe("sanitizeSenderName truncation", () => {
	it("never splits a surrogate pair", () => {
		const capped = sanitizeSenderName("b".repeat(399) + "😀😀");
		assert.ok(capped, "a 401-code-point name must survive the 400 cap");
		if (!capped) throw new Error("unreachable: assert.ok above guarantees non-null");
		const last = capped.charCodeAt(capped.length - 1);
		assert.ok(
			!(last >= 0xd800 && last <= 0xdbff),
			"must not end with a lone high surrogate",
		);
		assert.strictEqual(Array.from(capped).length, 399 + 1); // 399 b's + one emoji
	});
});

describe("participants_meta parsing edge cases", () => {
	it("treats a separator-less entry as a name, not a lower-cased address", () => {
		assert.deepStrictEqual(parseParticipantLabels("GitHub"), ["GitHub"]);
		assert.deepStrictEqual(parseParticipantLabels("Jane Doe"), ["Jane Doe"]);
	});

	it("handles entries with an empty name", () => {
		assert.deepStrictEqual(
			parseParticipantLabels(`${PARTICIPANT_NAME_SEP}noreply@github.com`),
			["noreply"],
		);
	});
});

describe("stripHeaderChars", () => {
	it("removes the separator characters without lower-casing or trimming", () => {
		assert.strictEqual(
			stripHeaderChars(`evil${PARTICIPANT_ENTRY_SEP}injected@example.com`),
			"evil injected@example.com",
		);
		assert.strictEqual(
			stripHeaderChars(`Bad${PARTICIPANT_NAME_SEP}Name`),
			"Bad Name",
		);
		assert.strictEqual(stripHeaderChars("User@Example.com"), "User@Example.com");
	});
});

describe("adjacent encoded-words", () => {
	it("ignores the whitespace between two encoded-words (RFC 2047 6.2)", () => {
		assert.strictEqual(
			decodeMimeWords("=?utf-8?B?SGVs?= =?utf-8?B?bG8=?="),
			"Hello",
		);
	});
});
