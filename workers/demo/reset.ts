// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Demo data reset: wipe the demo database + bucket and rebuild both from
 * `seed-data.json`.
 *
 * ── Two triggers, one function ─────────────────────────────────────────────
 *   Cron (`workers/app.ts` → `handleDemoScheduled`)   every 6 hours
 *   Lazy fallback (`workers/demo/login.ts`)           on every demo-login
 *
 * The lazy path exists because a Cron that stops firing (deploy without the
 * trigger, a broken `scheduled` export) would otherwise leave the demo
 * drifting from its baseline for days with nobody noticing, while the demo
 * itself keeps looking fine.
 *
 * ── Concurrency: one row, one atomic claim ─────────────────────────────────
 * Both triggers run `ensureDemoData`, which cannot afford two visitors
 * resetting at the same time (double writes, and one of them deleting rows the
 * other just inserted). The claim is a compare-and-swap on
 * `demo_meta('last_reset_at')`:
 *
 *     UPDATE demo_meta SET value = <now> WHERE key = 'last_reset_at' AND value = <read>
 *
 * `changes === 0` means somebody else moved the value between our read and our
 * write — they own the reset, so this caller returns immediately and lets them
 * finish. There is no window between "check" and "write" to lose.
 *
 * ── Both stores, or the demo is empty ─────────────────────────────────────
 * A mailbox is an R2 object, not a D1 row (`workers/lib/d1-middleware.ts`
 * HEADs `mailboxes/<email>.json` and 404s when it is missing). Seeding only D1
 * produces a demo where every mailbox is a 404 even though
 * `SELECT COUNT(*) FROM emails` says 128 — so the rebuild writes D1 *and* R2
 * and then verifies both.
 *
 * ── Failure handling ──────────────────────────────────────────────────────
 * Reads are cheap and the write is batched 40 statements at a time (D1 allows
 * 1000 per batch / 1 MB; 40 leaves a wide margin). If anything throws — a
 * missing table, a bucket hiccup, a baseline mismatch — the claim is rolled
 * back to the previous timestamp so the very next trigger retries, instead of
 * leaving a half-deleted demo behind a 6-hour quiet period.
 */
import type { Env } from "../types";
import {
	isoFromNow,
	loadDemoSeed,
	materialiseRawHeaders,
	type DemoSeed,
} from "./seed";

/** Reset cadence. The Cron fires hourly; most ticks return at `isDue`. */
export const DEMO_RESET_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The single `demo_meta` row this module owns. */
export const DEMO_META_KEY = "last_reset_at";

/** Value written by `migrations/0014_demo_meta.sql` for a never-reset demo. */
export const DEMO_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** D1's per-batch ceiling is 1000 statements / 1 MB; 40 keeps both far away. */
const STATEMENTS_PER_BATCH = 40;

/** Where the demo's mailbox objects and attachment blobs live. */
const R2_MAILBOX_PREFIX = "mailboxes/";
const R2_ATTACHMENT_PREFIX = "attachments/";

export interface DemoResetResult {
	/** True only for the caller that actually rebuilt the data. */
	reset: boolean;
	/** Why not, or `"done"`. */
	reason: "done" | "not_demo" | "fresh" | "claimed";
	/** `last_reset_at` this call wrote (the moment the rebuild started). */
	reset_at?: string;
	/** Counts read back from D1/R2 after the rebuild. */
	counts?: DemoCounts;
	duration_ms?: number;
}

export interface DemoCounts {
	mailboxes: number;
	attachment_objects: number;
	domains: number;
	admins: number;
	folders: number;
	emails: number;
	attachments: number;
	ai_messages: number;
	sessions: number;
	platform_settings: number;
	agent_api_keys: number;
	inbox_unread: Record<string, number>;
	starred: number;
}

// ── demo_meta: read / claim / roll back ─────────────────────────────

/** Current `last_reset_at`, or null when the row was never created. */
export async function readLastResetAt(db: D1Database): Promise<string | null> {
	const row = await db
		.prepare("SELECT value FROM demo_meta WHERE key = ?")
		.bind(DEMO_META_KEY)
		.first<{ value: string }>();
	return row?.value ?? null;
}

/**
 * Take ownership of the reset.
 *
 * The row is created on the very first call (nothing has seeded it yet), then
 * the CAS decides the winner. Returns true only for the winner.
 */
async function claimReset(
	db: D1Database,
	nowIso: string,
	previous: string | null,
): Promise<boolean> {
	if (previous === null) {
		await db
			.prepare("INSERT OR IGNORE INTO demo_meta (key, value) VALUES (?, ?)")
			.bind(DEMO_META_KEY, DEMO_EPOCH_ISO)
			.run();
	}
	const result = await db
		.prepare("UPDATE demo_meta SET value = ? WHERE key = ? AND value = ?")
		.bind(nowIso, DEMO_META_KEY, previous ?? DEMO_EPOCH_ISO)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Give the claim back so the next trigger retries. */
async function releaseReset(db: D1Database, previous: string | null): Promise<void> {
	await db
		.prepare("UPDATE demo_meta SET value = ? WHERE key = ?")
		.bind(previous ?? DEMO_EPOCH_ISO, DEMO_META_KEY)
		.run();
}

/** True when the last completed reset is older than the cadence. */
export function isResetDue(
	lastResetAt: string | null,
	now: Date,
	intervalMs = DEMO_RESET_INTERVAL_MS,
): boolean {
	if (!lastResetAt) return true;
	const last = Date.parse(lastResetAt);
	if (Number.isNaN(last)) return true; // corrupt value: reset rather than stall
	return now.getTime() - last >= intervalMs;
}

// ── Counting ────────────────────────────────────────────────────────

async function countRows(db: D1Database, table: string): Promise<number> {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** Read every number the acceptance list pins, straight from the stores. */
export async function readDemoCounts(env: Env): Promise<DemoCounts> {
	const db = env.DB;
	const unread = await db
		.prepare(
			"SELECT mailbox_id, COUNT(*) AS n FROM emails WHERE folder_id = 'inbox' AND read = 0 GROUP BY mailbox_id",
		)
		.all<{ mailbox_id: string; n: number }>();
	const inbox_unread: Record<string, number> = {};
	for (const row of unread.results ?? []) {
		inbox_unread[row.mailbox_id] = Number(row.n);
	}

	const starred = await db
		.prepare("SELECT COUNT(*) AS n FROM emails WHERE starred = 1")
		.first<{ n: number }>();

	const mailboxes = await env.BUCKET.list({ prefix: R2_MAILBOX_PREFIX });
	const attachments = await env.BUCKET.list({ prefix: R2_ATTACHMENT_PREFIX });

	return {
		mailboxes: mailboxes.objects.length,
		attachment_objects: attachments.objects.length,
		domains: await countRows(db, "domains"),
		admins: await countRows(db, "admins"),
		folders: await countRows(db, "folders"),
		emails: await countRows(db, "emails"),
		attachments: await countRows(db, "attachments"),
		ai_messages: await countRows(db, "ai_chat_messages"),
		sessions: await countRows(db, "sessions"),
		platform_settings: await countRows(db, "platform_settings"),
		agent_api_keys: await countRows(db, "agent_api_keys"),
		inbox_unread,
		starred: Number(starred?.n ?? 0),
	};
}

/**
 * Compare live counts against the seed's declared baselines.
 *
 * Deliberately returns the mismatch list instead of a boolean: a failing reset
 * must say WHICH number drifted, or the next person spends an hour
 * re-deriving the baseline by hand.
 */
export function diffDemoCounts(
	expected: DemoSeed["counts"],
	actual: DemoCounts,
): string[] {
	const problems: string[] = [];
	const simple: Array<[keyof DemoSeed["counts"], number]> = [
		["domains", actual.domains],
		["folders", actual.folders],
		["emails", actual.emails],
		["attachments", actual.attachments],
		["ai_messages", actual.ai_messages],
	];
	for (const [key, value] of simple) {
		const want = expected[key] as number;
		if (want !== value) problems.push(`${String(key)}: expected ${want}, found ${value}`);
	}
	if (expected.mailboxes !== actual.mailboxes) {
		problems.push(`R2 mailbox objects: expected ${expected.mailboxes}, found ${actual.mailboxes}`);
	}
	if (expected.attachments !== actual.attachment_objects) {
		problems.push(
			`R2 attachment objects: expected ${expected.attachments}, found ${actual.attachment_objects}`,
		);
	}
	if (expected.starred !== actual.starred) {
		problems.push(`starred: expected ${expected.starred}, found ${actual.starred}`);
	}
	for (const [mailbox, want] of Object.entries(expected.inbox_unread)) {
		const found = actual.inbox_unread[mailbox] ?? 0;
		if (want !== found) {
			problems.push(`inbox unread for ${mailbox}: expected ${want}, found ${found}`);
		}
	}
	// Anything counted that the baseline does not mention is stray data.
	if (actual.platform_settings !== 0) {
		problems.push(`platform_settings must stay empty, found ${actual.platform_settings} rows`);
	}
	if (actual.agent_api_keys !== 0) {
		problems.push(`agent_api_keys must stay empty, found ${actual.agent_api_keys} rows`);
	}
	if (actual.admins !== 1) {
		problems.push(`admins must be exactly 1 (the demo account), found ${actual.admins}`);
	}
	return problems;
}

// ── Rebuild ─────────────────────────────────────────────────────────

/** `attachments/<email_id>/<attachment_id>/<filename>` — one definition. */
export function attachmentKey(
	emailId: string,
	attachmentId: string,
	filename: string,
): string {
	return `${R2_ATTACHMENT_PREFIX}${emailId}/${attachmentId}/${sanitizeFilename(filename)}`;
}

/**
 * Same normalisation as `workers/lib/attachments.ts:44`.
 *
 * It has to be, byte for byte: the R2 key is built from the sanitised name
 * while `attachments.filename` is written to D1. Any disagreement between the
 * two and a download 404s while the row looks perfectly normal.
 */
export function sanitizeFilename(filename: string): string {
	return (filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function runBatched(
	db: D1Database,
	statements: D1PreparedStatement[],
): Promise<void> {
	for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
		await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
	}
}

/** Delete every object under the two demo prefixes (paginated: list caps at 1000). */
async function clearBucket(bucket: R2Bucket): Promise<void> {
	for (const prefix of [R2_MAILBOX_PREFIX, R2_ATTACHMENT_PREFIX]) {
		let cursor: string | undefined;
		do {
			const page = await bucket.list({ prefix, cursor });
			const keys = page.objects.map((object) => object.key);
			if (keys.length > 0) await bucket.delete(keys);
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
}

/**
 * Wipe both stores and write the seed back. Callers must hold the claim.
 *
 * Order is fixed and load-bearing: children before parents on delete
 * (`attachments` → `emails` → `folders`), parents before children on insert
 * (`folders` → `emails` → `attachments`), because `emails.folder_id` and
 * `attachments.email_id` are foreign keys.
 */
async function rebuildDemoData(
	env: Env,
	seed: DemoSeed,
	now: Date,
): Promise<DemoCounts> {
	const db = env.DB;

	// 1. Empty D1. `platform_settings` and `agent_api_keys` are never written by
	//    anything reachable in demo mode; deleting them is how the "no
	//    credentials in the demo database" invariant is enforced rather than
	//    merely assumed.
	const deletes = [
		"DELETE FROM attachments",
		"DELETE FROM emails",
		"DELETE FROM folders",
		"DELETE FROM ai_chat_messages",
		"DELETE FROM domains",
		"DELETE FROM admins",
		"DELETE FROM sessions",
		"DELETE FROM platform_settings",
		"DELETE FROM agent_api_keys",
		"DELETE FROM agent_api_key_audit",
	].map((sql) => db.prepare(sql));
	await runBatched(db, deletes);

	// 2. Empty R2 (mailbox objects + attachment blobs).
	await clearBucket(env.BUCKET);

	// 3. Mailbox settings objects. `resendApiKey` is deliberately absent: the
	//    demo must not be able to send, and `sendEmailFromMailbox` reads this
	//    file before it ever reaches Resend.
	for (const mailbox of seed.mailboxes) {
		const settings = {
			...mailbox.settings,
			created_at: isoFromNow(now, mailbox.created_minutes_ago),
		};
		await env.BUCKET.put(
			`${R2_MAILBOX_PREFIX}${mailbox.id}.json`,
			JSON.stringify(settings),
		);
	}

	// 4. Folders.
	const folderStatements = seed.mailboxes.flatMap((mailbox) =>
		mailbox.folders.map((folder) =>
			db
				.prepare(
					"INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES (?, ?, ?, ?)",
				)
				.bind(mailbox.id, folder.id, folder.name, folder.is_deletable),
		),
	);
	await runBatched(db, folderStatements);

	// 5. Emails.
	const emailStatements = seed.emails.map((email) => {
		const date = isoFromNow(now, email.minutes_ago);
		return db
			.prepare(
				`INSERT INTO emails (
					id, mailbox_id, folder_id, subject, sender, sender_name, recipient,
					cc, bcc, date, read, starred, body, in_reply_to, email_references,
					thread_id, message_id, raw_headers, send_status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				email.id,
				email.mailbox_id,
				email.folder_id,
				email.subject,
				email.sender,
				email.sender_name,
				email.recipient,
				email.cc,
				email.bcc,
				date,
				email.read,
				email.starred,
				email.body,
				email.in_reply_to,
				email.email_references,
				email.thread_id,
				email.message_id,
				materialiseRawHeaders(email.raw_headers, date),
				email.send_status,
			);
	});
	await runBatched(db, emailStatements);

	// 6. Attachment blobs (R2) + rows (D1). `size` is the decoded length, i.e.
	//    the real byte count of the object the download link will serve.
	const attachmentStatements: D1PreparedStatement[] = [];
	for (const attachment of seed.attachments) {
		const bytes = base64ToBytes(attachment.content_base64);
		const filename = sanitizeFilename(attachment.filename);
		await env.BUCKET.put(
			attachmentKey(attachment.email_id, attachment.id, filename),
			bytes,
		);
		attachmentStatements.push(
			db
				.prepare(
					`INSERT INTO attachments (
						id, email_id, mailbox_id, filename, mimetype, size, content_id, disposition
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					attachment.id,
					attachment.email_id,
					attachment.mailbox_id,
					filename,
					attachment.mimetype,
					bytes.byteLength,
					attachment.content_id,
					attachment.disposition,
				),
		);
	}
	await runBatched(db, attachmentStatements);

	// 7. Domains — status only; no Resend/Cloudflare ids, no API keys.
	const domainStatements = seed.domains.map((domain) =>
		db
			.prepare("INSERT INTO domains (id, name, status, created_at) VALUES (?, ?, ?, ?)")
			.bind(domain.id, domain.name, domain.status, isoFromNow(now, domain.created_minutes_ago)),
	);
	await runBatched(db, domainStatements);

	// 8. Pre-baked AI conversation history (read-only: POST .../ai/chat is 403).
	//    Ids are derived, not random: two resets of the same seed must produce
	//    the same rows, and `datetime('now')` ordering is replaced by the seed
	//    offsets so the conversation stays in order.
	const aiStatements = seed.ai_messages.map((message, index) =>
		db
			.prepare(
				"INSERT INTO ai_chat_messages (id, mailbox_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(
				`demo-ai-message-${index + 1}`,
				message.mailbox_id,
				message.role,
				message.content,
				isoFromNow(now, message.minutes_ago),
			),
	);
	await runBatched(db, aiStatements);

	// 9. The demo admin. The stored value is a hash of random bytes that were
	//    thrown away at build time, so no password exists that could log in
	//    through /api/v1/auth/login.
	const createdAt = isoFromNow(now, 30 * 24 * 60);
	await db
		.prepare(
			"INSERT INTO admins (id, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(seed.admin.id, seed.admin.username, seed.admin.password, createdAt, createdAt)
		.run();

	return readDemoCounts(env);
}

// ── Entry points ────────────────────────────────────────────────────

/**
 * Reset the demo if it is due, unless another caller already claimed it.
 *
 * `force` skips the 6-hour check but NOT the claim — a forced reset still
 * cannot interleave with a concurrent one.
 */
export async function ensureDemoData(
	env: Env,
	options: { force?: boolean; now?: Date } = {},
): Promise<DemoResetResult> {
	if (env.DEMO_MODE !== "1") return { reset: false, reason: "not_demo" };

	const now = options.now ?? new Date();
	const nowIso = now.toISOString();
	const previous = await readLastResetAt(env.DB);

	if (!options.force && !isResetDue(previous, now)) {
		return { reset: false, reason: "fresh" };
	}

	if (!(await claimReset(env.DB, nowIso, previous))) {
		return { reset: false, reason: "claimed" };
	}

	try {
		const seed = await loadDemoSeed();
		const counts = await rebuildDemoData(env, seed, now);
		const problems = diffDemoCounts(seed.counts, counts);
		if (problems.length > 0) {
			throw new Error(
				`demo reset produced data that does not match seed-data.json: ${problems.join("; ")}`,
			);
		}
		return { reset: true, reason: "done", reset_at: nowIso, counts };
	} catch (error) {
		// Hand the claim back: the next trigger (or the next visitor's login)
		// retries instead of waiting out a full cadence on a broken demo.
		await releaseReset(env.DB, previous).catch(() => {});
		throw error;
	}
}

/**
 * Cron entry point (`workers/app.ts` → `scheduled`).
 *
 * Never throws: a Cron failure must not look like a failed deployment in the
 * dashboard, and the lazy demo-login path is the designed backup. One line per
 * run, which is what the ops note asks for.
 */
export async function handleDemoScheduled(
	env: Env,
	controller?: { cron?: string },
): Promise<DemoResetResult | { reset: false; reason: "error" }> {
	try {
		const result = await ensureDemoData(env);
		console.log(
			`[demo-reset] cron=${controller?.cron ?? "?"} reset=${result.reset} reason=${result.reason}` +
				(result.counts
					? ` emails=${result.counts.emails} folders=${result.counts.folders} attachments=${result.counts.attachments}`
					: ""),
		);
		return result;
	} catch (error) {
		console.error("[demo-reset] failed:", (error as Error).message);
		return { reset: false, reason: "error" };
	}
}
