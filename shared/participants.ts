// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Rendering helpers for the sender / participant label shown in the email list.
 *
 * Why this exists
 * ---------------
 * A message's `sender` column holds only the *address* (`noreply@github.com`).
 * Rendering `sender.split("@")[0]` therefore turns every automated sender into
 * a near-identical "noreply" / "no-reply" row. Mail clients such as Gmail
 * instead show the **display name** from the `From` header ("GitHub") and only
 * fall back to the local-part when no display name is present.
 *
 * The backend persists that display name in `emails.sender_name`. For
 * conversation rows it also aggregates participants into a compact string that
 * keeps each display name paired with its address:
 *
 *     list  := entry (ENTRY_SEP entry)*
 *     entry := name? NAME_SEP address
 *
 * The separators are ASCII control characters (RS / US). They are used instead
 * of "," because a display name may legally contain a comma ("Smith, John"),
 * which would otherwise split one participant into two.
 *
 * NOTE: the separators below must stay in sync with the `CHAR(30)` / `CHAR(31)`
 * literals used by `getThreadedEmails` in `workers/db/index.ts`.
 * `workers/db/sender-name-migration.test.ts` pins both the values and the SQL.
 *
 * Every value that reaches the UI is untrusted (it comes from a mail header),
 * so `sanitize*()` strips control characters — which would otherwise corrupt
 * the separator protocol above — as well as invisible/bidi characters that
 * could be used for display spoofing.
 */

/** Record separator between two participant entries. Mirrors `CHAR(30)`. */
export const PARTICIPANT_ENTRY_SEP = "\u001e";

/** Unit separator between a participant's display name and its address. Mirrors `CHAR(31)`. */
export const PARTICIPANT_NAME_SEP = "\u001f";

/**
 * Matches an RFC 2047 encoded-word: `=?charset?B?base64?=` or `=?charset?Q?qp?=`.
 * Non-ASCII display names are transmitted this way in raw headers, so a value
 * backfilled from `raw_headers` can still be encoded.
 */
const MIME_WORD_RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/** Whitespace between two adjacent encoded-words is not part of the text (RFC 2047 §6.2). */
const ADJACENT_MIME_WORDS_RE = /\?=\s+=\?/g;

/**
 * C0/C1 control characters (including the RS/US separators used above).
 * Replaced with a space so words do not run together: `"Bad\u001eName"` -> `"Bad Name"`.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Zero-width and bidirectional formatting characters. These are invisible (or
 * reorder surrounding text) and would let a sender spoof what the row looks
 * like, so they are dropped outright.
 *
 * Covers: ZWSP/ZWNJ/ZWJ/LRM/RLM (U+200B-U+200F), ALM (U+061C), bidi
 * embeddings/overrides (U+202A-U+202E), bidi isolates (U+2066-U+2069),
 * word joiner (U+2060), BOM/ZWNBSP (U+FEFF) and soft hyphen (U+00AD).
 */
const INVISIBLE_CHARS_RE = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Common charset aliases that TextDecoder does not recognise by name. */
const CHARSET_ALIASES: Record<string, string> = {
	"us-ascii": "utf-8",
	ascii: "utf-8",
	"ansi_x3.4-1968": "utf-8",
	utf8: "utf-8",
	latin1: "iso-8859-1",
	"cp1252": "windows-1252",
	"gb2312": "gbk",
	chinese: "gbk",
};

/** Collapse an untrusted string down to something safe to render. */
function stripDangerous(value: string): string {
	return value.replace(CONTROL_CHARS_RE, " ").replace(INVISIBLE_CHARS_RE, "");
}

function decodeQuotedPrintable(text: string): Uint8Array {
	// In an encoded-word, "_" represents the space character.
	const normalised = text.replace(/_/g, " ");
	const bytes: number[] = [];
	for (let i = 0; i < normalised.length; i++) {
		const char = normalised[i]!;
		if (char === "=" && i + 2 < normalised.length) {
			const hex = normalised.slice(i + 1, i + 3);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				bytes.push(Number.parseInt(hex, 16));
				i += 2;
				continue;
			}
		}
		bytes.push(char.charCodeAt(0) & 0xff);
	}
	return Uint8Array.from(bytes);
}

function decodeBase64(text: string): Uint8Array {
	// Some clients omit the padding; atob() would otherwise mis-decode or throw.
	const unpadded = text.replace(/\s+/g, "");
	const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
	// RFC 2231 language tags ("utf-8*en") are not charsets.
	const label = CHARSET_ALIASES[charset.toLowerCase().trim()] ?? charset.trim().split("*")[0]!;
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		// Unknown/unsupported charset — the bytes are most often UTF-8 anyway.
		return new TextDecoder().decode(bytes);
	}
}

/**
 * Decode any RFC 2047 encoded-words inside a display name.
 *
 * Values freshly parsed by the inbound handlers are already decoded; this is a
 * safety net for names backfilled from raw `From` headers. Unparseable
 * encoded-words are left untouched rather than throwing, and the decoded text
 * is stripped of control/invisible characters so a hostile `From` header
 * cannot smuggle NULs or bidi overrides through.
 */
export function decodeMimeWords(input: string | null | undefined): string {
	if (!input || !input.includes("=?")) return input || "";

	return input
		.replace(ADJACENT_MIME_WORDS_RE, "?==?")
		.replace(
			MIME_WORD_RE,
			(match: string, charset: string, encoding: string, text: string) => {
				try {
					const bytes =
						encoding.toUpperCase() === "B"
							? decodeBase64(text)
							: decodeQuotedPrintable(text);
					return stripDangerous(decodeBytes(bytes, charset));
				} catch {
					return match;
				}
			},
		);
}

/**
 * Normalise an untrusted label for display: decode encoded-words, drop control
 * and invisible characters (which would otherwise corrupt `participants_meta`
 * parsing or spoof the rendering), and collapse whitespace.
 */
export function sanitizeLabel(value: string | null | undefined): string {
	return stripDangerous(decodeMimeWords(value)).replace(/\s+/g, " ").trim();
}

/**
 * Strip control/invisible characters from a header value that is stored as-is
 * (e.g. the `sender` address column). Unlike `sanitizeSenderName` this never
 * returns null — the column is NOT NULL — but it removes the RS/US characters
 * that would otherwise split a participant entry in `participants_meta`.
 */
export function stripHeaderChars(value: string): string {
	return stripDangerous(value);
}

/**
 * Normalise a display name before it is persisted. Keeps `participants_meta`
 * free of the RS/US separators and bounds the stored length.
 *
 * Truncation is code-point aware so a cap never splits a surrogate pair.
 */
export function sanitizeSenderName(value: string | null | undefined): string | null {
	const cleaned = stripDangerous(value ?? "").replace(/\s+/g, " ").trim();
	if (!cleaned) return null;
	return Array.from(cleaned).slice(0, 400).join("");
}

/**
 * A display name that is itself an address — the shape produced by a header like
 * `"noreply@github.com" <noreply@github.com>` — says nothing the `sender` column
 * does not already say, so it is treated as absent and the caller falls back.
 *
 * The test is structural (a single `@`, a dot in the domain, no whitespace)
 * rather than a bare `includes("@")`, so a genuine display name may still
 * contain one: "Acme @ Home", "Support via @help".
 */
const ADDRESS_LIKE_NAME_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

/** A usable display name, or `""` when the value is missing or merely an address. */
function usableDisplayName(name: string | null | undefined): string {
	const cleaned = sanitizeLabel(name);
	return ADDRESS_LIKE_NAME_RE.test(cleaned) ? "" : cleaned;
}

/**
 * Label for list rows: the display name, or the address local-part when there
 * is no usable name (mirrors Gmail).
 *
 * This is the single place the "name is really just an address" fallback is
 * applied, so it holds for freshly-received mail and for rows backfilled by
 * migration 0010 alike.
 */
export function formatSenderLabel(
	name: string | null | undefined,
	address: string | null | undefined,
): string {
	return usableDisplayName(name) || sanitizeLabel(address).split("@")[0];
}

/**
 * Label for detail/thread views: the display name, or the full address when
 * there is no usable name (more useful than a bare local-part in a header).
 */
export function formatSenderFull(
	name: string | null | undefined,
	address: string | null | undefined,
): string {
	return usableDisplayName(name) || sanitizeLabel(address);
}

/**
 * Label for machine-facing context (AI prompts, logs): the display name with the
 * address in angle brackets, or just the address when there is no name. Unlike
 * `formatSenderFull` this keeps the address visible next to the name, since a
 * consumer that may have to act on the message needs both.
 */
export function formatSenderWithAddress(
	name: string | null | undefined,
	address: string | null | undefined,
): string {
	const label = usableDisplayName(name);
	const addr = sanitizeLabel(address);
	if (label && addr) return `${label} <${addr}>`;
	return label || addr;
}

interface Participant {
	name: string;
	address: string;
}

/**
 * Parse the aggregated `participants_meta` string into de-duplicated labels.
 *
 * The same address can legitimately appear twice (once with a display name,
 * once without), so entries are merged per address, preferring a real name.
 */
export function parseParticipantLabels(
	participantsMeta: string | null | undefined,
): string[] {
	if (!participantsMeta) return [];

	const byKey = new Map<string, Participant>();

	for (const entry of participantsMeta.split(PARTICIPANT_ENTRY_SEP)) {
		if (!entry) continue;

		const sepIndex = entry.indexOf(PARTICIPANT_NAME_SEP);
		// A well-formed entry is always "name? NAME_SEP address". A separator-less
		// entry is malformed: treat it as a display name rather than lower-casing
		// it as if it were an address.
		const isMalformed = sepIndex === -1;
		const name = (isMalformed ? entry : entry.slice(0, sepIndex)).trim();
		const address = isMalformed
			? ""
			: entry.slice(sepIndex + 1).trim().toLowerCase();

		// Address is the identity; fall back to the name for name-only entries.
		const key = address || name;
		if (!key) continue;

		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, { name, address });
		} else if (!existing.name && name) {
			byKey.set(key, { name, address });
		}
	}

	const labels: string[] = [];
	const seen = new Set<string>();
	for (const participant of byKey.values()) {
		const label = formatSenderLabel(participant.name, participant.address);
		if (!label || seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	return labels;
}

/** How many participants to list in full before collapsing into a "+N" suffix. */
const DEFAULT_MAX_SHOWN = 3;

/**
 * Build the label for a conversation row: either the aggregated participant
 * names, or the single sender when no aggregate is available.
 *
 * Mirrors Gmail's behaviour of preferring display names, while keeping the
 * existing "first two + +N" collapse for busy threads.
 */
export function formatParticipantLabel(
	participantsMeta: string | null | undefined,
	fallback: { name?: string | null; address?: string | null } = {},
	maxShown: number = DEFAULT_MAX_SHOWN,
): string {
	const labels = parseParticipantLabels(participantsMeta);
	if (labels.length === 0) {
		return formatSenderLabel(fallback.name, fallback.address);
	}
	if (labels.length <= maxShown) return labels.join(", ");
	return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}
