// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Shape of `seed-data.json` — the single source of demo content.
 *
 * Two consumers read it and they must produce byte-identical results:
 *
 *   1. `workers/demo/reset.ts` (runtime: Cron tick + lazy fallback on
 *      demo-login), so the demo looks the same after every reset;
 *   2. `scripts/seed-demo.mjs` (one-off: first fill of a fresh demo database,
 *      and its end-of-run self-check).
 *
 * The JSON is ~300 KB and is loaded with a dynamic `import()`, so it lands in
 * its own chunk and is only fetched on a reset path — production never pulls
 * it in (`workers/demo/*` is unreachable when DEMO_MODE is unset).
 *
 * ── Why `minutes_ago` instead of absolute dates ────────────────────────────
 * Absolute timestamps baked into the file would make the demo "21 days old"
 * forever from the day it was generated, which reads as abandoned. Every
 * timestamp is therefore stored as an offset and materialised at reset time
 * (`isoFromNow(now, minutesAgo)`), so the inbox is always "the last three
 * weeks". Counts — the thing the acceptance list pins — do not depend on the
 * clock at all.
 *
 * ── Why the admin hash is baked in ─────────────────────────────────────────
 * `admin.password` is a real PBKDF2-SHA256 hash of 32 random bytes that were
 * discarded at build time. Nobody — including whoever generated this file —
 * knows the plaintext, so `POST /api/v1/auth/login` cannot be used on the demo
 * by anyone, while `GET /api/v1/auth/me` still works for a demo session (it
 * only needs an `admins` row to exist).
 */

/** R2 `mailboxes/<email>.json` body. Never carries `resendApiKey`. */
export interface SeedMailboxSettings {
	fromName: string;
	forwarding: { enabled: boolean; email: string };
	signature: { enabled: boolean; text: string };
}

export interface SeedMailbox {
	id: string;
	/** Minutes before "now" the mailbox was created. */
	created_minutes_ago: number;
	settings: SeedMailboxSettings;
	folders: SeedFolder[];
}

export interface SeedFolder {
	/** Folder row id, e.g. `inbox` or `receipts`. */
	id: string;
	name: string;
	is_deletable: 0 | 1;
}

export interface SeedEmail {
	id: string;
	mailbox_id: string;
	folder_id: string;
	subject: string;
	sender: string;
	sender_name: string | null;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	/** Minutes before "now" — see the module docstring. */
	minutes_ago: number;
	read: 0 | 1;
	starred: 0 | 1;
	body: string;
	in_reply_to: string | null;
	/** Already a JSON string, matching what the write paths store. */
	email_references: string | null;
	thread_id: string | null;
	message_id: string;
	/**
	 * `[{ key, value }]`, exactly what `workers/inbound.ts` stores — except the
	 * `date` entry, whose value is the token `{{date}}`. The timestamp is
	 * materialised at reset time (see `materialiseRawHeaders`), because the row
	 * `date` is derived from `minutes_ago` and the two must not drift apart.
	 */
	raw_headers: Array<{ key: string; value: string }>;
	send_status: "sent" | "failed" | null;
}

export interface SeedAttachment {
	/** Deterministic id — it is part of the R2 key. */
	id: string;
	email_id: string;
	mailbox_id: string;
	filename: string;
	mimetype: string;
	/** Real bytes, base64. `size` is this decoded length, never stored twice. */
	content_base64: string;
	content_id: string | null;
	disposition: string;
}

export interface SeedAiMessage {
	mailbox_id: string;
	role: "user" | "assistant";
	content: string;
	minutes_ago: number;
}

export interface SeedDomain {
	id: string;
	name: string;
	status: "verified" | "failed" | "pending";
	created_minutes_ago: number;
}

export interface SeedAdmin {
	id: string;
	username: string;
	/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` — plaintext discarded. */
	password: string;
}

/** Baselines the reset must reproduce exactly; asserted after every rebuild. */
export interface SeedCounts {
	mailboxes: number;
	domains: number;
	folders: number;
	emails: number;
	attachments: number;
	ai_messages: number;
	/** Per mailbox: unread rows in `inbox`. */
	inbox_unread: Record<string, number>;
	/** Starred rows across every folder of every mailbox. */
	starred: number;
}

export interface DemoSeed {
	version: number;
	/** Provenance line, printed by the seed script. */
	generated_by: string;
	admin: SeedAdmin;
	mailboxes: SeedMailbox[];
	domains: SeedDomain[];
	emails: SeedEmail[];
	attachments: SeedAttachment[];
	ai_messages: SeedAiMessage[];
	counts: SeedCounts;
}

/** Placeholder the seed uses for the header timestamp. */
export const SEED_DATE_TOKEN = "{{date}}";

/**
 * Turn the seed's header list into the JSON string the `raw_headers` column
 * holds, substituting the row's timestamp for `{{date}}`.
 */
export function materialiseRawHeaders(
	headers: Array<{ key: string; value: string }>,
	date: string,
): string {
	return JSON.stringify(
		headers.map((header) => ({
			key: header.key,
			value: header.value === SEED_DATE_TOKEN ? date : header.value,
		})),
	);
}

/**
 * Load the seed. Kept behind an `await import()` on purpose: this is the only
 * reference to the 300 KB JSON in the bundle, and it is reachable only from
 * `reset.ts`, which is reachable only when `DEMO_MODE === "1"`.
 */
export async function loadDemoSeed(): Promise<DemoSeed> {
	const mod = (await import("./seed-data.json")) as unknown as
		| { default: DemoSeed }
		| DemoSeed;
	return "default" in mod ? mod.default : (mod as DemoSeed);
}

/**
 * Materialise a seed offset as an ISO timestamp.
 *
 * `minutesAgo` is minutes BEFORE `now`; the returned string sorts correctly as
 * a string, which is how every `date` column in this app is used.
 */
export function isoFromNow(now: Date, minutesAgo: number): string {
	return new Date(now.getTime() - minutesAgo * 60_000).toISOString();
}
