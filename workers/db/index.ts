// Copyright (c) 2026 Cloudflare, Inc.
// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { drizzle } from "drizzle-orm/d1";
import { eq, and, or, asc, desc, sql, ne, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema";
import { Folders } from "../../shared/folders";
import { sanitizeSenderName, stripHeaderChars } from "../../shared/participants";
import { generateApiKey, generateKeyId, extractPrefix, verifyApiKey } from "../lib/api-key-utils";

// ── Types ─────────────────────────────────────────────────────────

export interface GetEmailsOptions {
	folder?: string;
	threadId?: string;
	page?: number;
	limit?: number;
	sortColumn?: string;
	sortDirection?: "ASC" | "DESC";
}

export interface EmailData {
	id: string;
	subject: string;
	sender: string;
	sender_name?: string | null;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	send_status?: string | null;
}

export interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

export interface RateLimitResult {
	hourlyCount: number;
	dailyCount: number;
	hourlyLimit: number;
	dailyLimit: number;
}

export interface FolderResult {
	id: string;
	name: string;
	isDeletable: number;
	unreadCount: number;
}

export interface EmailFull {
	id: string;
	mailbox_id: string;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	body: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	message_id: string | null;
	raw_headers: string | null;
	send_status: string | null;
	attachments: AttachmentData[];
}

export interface EmailSummary {
	id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	folder_id: string | null;
	snippet: string | null;
	send_status: string | null;
}

export interface ThreadedEmail {
	id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	thread_id: string | null;
	folder_id: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	snippet: string | null;
	thread_count: number;
	thread_unread_count: number;
	participants: string | null;
	participants_meta: string | null;
	needs_reply?: boolean;
	has_draft?: boolean;
	send_status?: string | null;
}

export interface AttachmentRow {
	id: string;
	email_id: string;
	mailbox_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}

// ── Constants ─────────────────────────────────────────────────────

const ALLOWED_SORT_COLUMNS = [
	"id", "subject", "sender", "recipient", "date", "read", "starred",
] as const;

const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
};

const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const HOURLY_LIMIT = 20;
const DAILY_LIMIT = 100;

// ── Helper ────────────────────────────────────────────────────────

function buildFolderCondition(
	folder: string,
	paramIdx: () => number,
): { clause: string; params: string[] } {
	const idx1 = paramIdx();
	const idx2 = paramIdx();
	return {
		clause: `folder_id = (SELECT id FROM folders WHERE mailbox_id = ?${idx1} AND (name = ?${idx2} OR id = ?${idx2}) LIMIT 1)`,
		params: [folder, folder],
	};
}

// ── 1. getEmails ─────────────────────────────────────────────────

export async function getEmails(
	db: D1Database,
	mailboxId: string,
	options: GetEmailsOptions = {},
): Promise<EmailSummary[]> {
	const { folder, threadId, page = 1, limit: rawLimit = 25, sortColumn: rawSortColumn = "date", sortDirection = "DESC" } = options;
	const capLimit = Math.min(Math.max(rawLimit, 1), 100);
	const sortCol = (ALLOWED_SORT_COLUMNS as readonly string[]).includes(rawSortColumn ?? "") ? rawSortColumn : "date";
	const offset = (page - 1) * capLimit;

	const orm = drizzle(db, { schema });
	const conditions: SQL[] = [eq(schema.emails.mailbox_id, mailboxId)];

	if (folder) {
		conditions.push(sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE mailbox_id = ${mailboxId} AND (name = ${folder} OR id = ${folder}) LIMIT 1)`);
	}
	if (threadId) {
		conditions.push(eq(schema.emails.thread_id, threadId));
	}

	const orderCol = SORT_COLUMN_MAP[sortCol as keyof typeof SORT_COLUMN_MAP]!;
	const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

	const result = await orm
		.select({
			id: schema.emails.id,
			subject: schema.emails.subject,
			sender: schema.emails.sender,
			sender_name: schema.emails.sender_name,
			recipient: schema.emails.recipient,
			cc: schema.emails.cc,
			bcc: schema.emails.bcc,
			date: schema.emails.date,
			read: schema.emails.read,
			starred: schema.emails.starred,
			in_reply_to: schema.emails.in_reply_to,
			email_references: schema.emails.email_references,
			thread_id: schema.emails.thread_id,
			folder_id: schema.emails.folder_id,
			snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			send_status: schema.emails.send_status,
		})
		.from(schema.emails)
		.where(and(...conditions))
		.orderBy(orderDir)
		.limit(capLimit)
		.offset(offset)
		.all();

	return result.map((email) => ({
		...email,
		read: !!email.read,
		starred: !!email.starred,
	}));
}

// ── 2. countEmails ───────────────────────────────────────────────

export async function countEmails(
	db: D1Database,
	mailboxId: string,
	folder?: string,
	threadId?: string,
): Promise<number> {
	const conditions: string[] = ["mailbox_id = ?1"];
	const params: (string | number)[] = [mailboxId];
	let paramIdx = 2;

	if (folder) {
		conditions.push(`folder_id = (SELECT id FROM folders WHERE mailbox_id = ?${paramIdx} AND (name = ?${paramIdx} OR id = ?${paramIdx}) LIMIT 1)`);
		params.push(folder);
		paramIdx++;
	}
	if (threadId) {
		conditions.push(`thread_id = ?${paramIdx}`);
		params.push(threadId);
	}

	const where = `WHERE ${conditions.join(" AND ")}`;
	const result = await db.prepare(`SELECT COUNT(*) as total FROM emails ${where}`).bind(...params).first() as { total: number } | undefined;
	return result?.total ?? 0;
}

// ── 3. getEmail ──────────────────────────────────────────────────

export async function getEmail(
	db: D1Database,
	mailboxId: string,
	id: string,
): Promise<EmailFull | null> {
	const orm = drizzle(db, { schema });

	const email = await orm
		.select()
		.from(schema.emails)
		.where(and(eq(schema.emails.id, id), eq(schema.emails.mailbox_id, mailboxId)))
		.get();

	if (!email) return null;

	const emailAttachments = await orm
		.select()
		.from(schema.attachments)
		.where(eq(schema.attachments.email_id, id))
		.all();

	return {
		...email,
		read: !!email.read,
		starred: !!email.starred,
		attachments: emailAttachments,
	};
}

// ── 4. createEmail ───────────────────────────────────────────────

export async function createEmail(
	db: D1Database,
	mailboxId: string,
	folder: string,
	emailData: EmailData,
	attachments: AttachmentData[],
): Promise<void> {
	// Resolve folder name or ID to the actual folder ID
	const orm = drizzle(db, { schema });
	const folderRow = await orm
		.select({ id: schema.folders.id })
		.from(schema.folders)
		.where(
			and(
				eq(schema.folders.mailbox_id, mailboxId),
				or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)),
			),
		)
		.limit(1)
		.get();

	if (!folderRow) {
		throw new Error(
			`createEmail: folder "${folder}" not found for mailbox "${mailboxId}". ` +
				"Ensure the folder exists before inserting an email.",
		);
	}

	const folderId = folderRow.id;
	const isSent = folderId === Folders.SENT;

	// Batch: insert email + attachments atomically
	const stmts: D1PreparedStatement[] = [];

	stmts.push(
		db.prepare(
			`INSERT INTO emails (id, mailbox_id, folder_id, subject, sender, sender_name, recipient, cc, bcc, date, read, starred, body, in_reply_to, email_references, thread_id, message_id, raw_headers, send_status)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
		).bind(
			emailData.id,
			mailboxId,
			folderId,
			emailData.subject,
			// Strip control/invisible characters: `sender` and `sender_name` are
			// concatenated into participants_meta, which uses RS/US as separators.
			stripHeaderChars(emailData.sender),
			sanitizeSenderName(emailData.sender_name),
			emailData.recipient,
			emailData.cc ?? null,
			emailData.bcc ?? null,
			emailData.date,
			isSent ? 1 : (emailData.read ? 1 : 0),
			emailData.starred ? 1 : 0,
			emailData.body,
			emailData.in_reply_to ?? null,
			emailData.email_references ?? null,
			emailData.thread_id ?? null,
			emailData.message_id ?? null,
			emailData.raw_headers ?? null,
			emailData.send_status ?? null,
		),
	);

	for (const att of attachments) {
		stmts.push(
			db.prepare(
				`INSERT INTO attachments (id, email_id, mailbox_id, filename, mimetype, size, content_id, disposition)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			).bind(
				att.id,
				att.email_id,
				mailboxId,
				att.filename,
				att.mimetype,
				att.size,
				att.content_id ?? null,
				att.disposition ?? null,
			),
		);
	}

	await db.batch(stmts);
}

// ── 4b. updateEmailSendStatus ────────────────────────────────────

export async function updateEmailSendStatus(
	db: D1Database,
	mailboxId: string,
	emailId: string,
	sendStatus: "sending" | "sent" | "failed",
): Promise<void> {
	await db
		.prepare("UPDATE emails SET send_status = ?1 WHERE id = ?2 AND mailbox_id = ?3")
		.bind(sendStatus, emailId, mailboxId)
		.run();
}

// ── 5. updateEmail ───────────────────────────────────────────────

export async function updateEmail(
	db: D1Database,
	mailboxId: string,
	id: string,
	data: { read?: boolean; starred?: boolean },
): Promise<EmailFull | null> {
	const updateData: { read?: number; starred?: number } = {};
	if (data.read !== undefined) updateData.read = data.read ? 1 : 0;
	if (data.starred !== undefined) updateData.starred = data.starred ? 1 : 0;

	if (Object.keys(updateData).length === 0) {
		return getEmail(db, mailboxId, id);
	}

	const orm = drizzle(db, { schema });
	await orm
		.update(schema.emails)
		.set(updateData)
		.where(and(eq(schema.emails.id, id), eq(schema.emails.mailbox_id, mailboxId)))
		.run();

	return getEmail(db, mailboxId, id);
}

// ── 6. deleteEmail ───────────────────────────────────────────────

export async function deleteEmail(
	db: D1Database,
	mailboxId: string,
	id: string,
): Promise<{ id: string; filename: string }[] | null> {
	const orm = drizzle(db, { schema });

	const email = await orm
		.select({ id: schema.emails.id })
		.from(schema.emails)
		.where(and(eq(schema.emails.id, id), eq(schema.emails.mailbox_id, mailboxId)))
		.get();

	if (!email) return null;

	const emailAttachments = await orm
		.select({ id: schema.attachments.id, filename: schema.attachments.filename })
		.from(schema.attachments)
		.where(eq(schema.attachments.email_id, id))
		.all();

	await orm
		.delete(schema.emails)
		.where(and(eq(schema.emails.id, id), eq(schema.emails.mailbox_id, mailboxId)))
		.run();

	return emailAttachments;
}

// ── 7. getAttachment ─────────────────────────────────────────────

export async function getAttachment(
	db: D1Database,
	mailboxId: string,
	attachmentId: string,
): Promise<AttachmentRow | null> {
	const orm = drizzle(db, { schema });
	const result = await orm
		.select()
		.from(schema.attachments)
		.where(and(
			eq(schema.attachments.id, attachmentId),
			eq(schema.attachments.mailbox_id, mailboxId),
		))
		.get();
	return result ?? null;
}

// ── 8. getThreadEmails ───────────────────────────────────────────

export async function getThreadEmails(
	db: D1Database,
	mailboxId: string,
	threadId: string,
): Promise<EmailFull[]> {
	const emailRows = await db.prepare(
		`SELECT * FROM emails WHERE mailbox_id = ?1 AND thread_id = ?2 ORDER BY date ASC`,
	).bind(mailboxId, threadId).all() as any;

	const emails = emailRows.results || [];
	if (emails.length === 0) return [];

	const emailIds = emails.map((e: any) => e.id as string);

	// Batch-fetch all attachments for the thread in a single query
	const placeholders = emailIds.map((_: any, i: number) => `?${i + 1}`).join(",");
	const attachmentRows = await db.prepare(
		`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
	).bind(...emailIds).all() as any;

	const attachmentsByEmail = new Map<string, any[]>();
	for (const att of (attachmentRows.results || [])) {
		const list = attachmentsByEmail.get(att.email_id) || [];
		list.push(att);
		attachmentsByEmail.set(att.email_id, list);
	}

	return emails.map((email: any) => ({
		...email,
		read: !!email.read,
		starred: !!email.starred,
		attachments: attachmentsByEmail.get(email.id) || [],
	}));
}

// ── 9. markThreadRead ────────────────────────────────────────────

export async function markThreadRead(
	db: D1Database,
	mailboxId: string,
	threadId: string,
): Promise<{ threadId: string; markedRead: boolean }> {
	await db.prepare(
		`UPDATE emails SET read = 1 WHERE mailbox_id = ?1 AND thread_id = ?2 AND read = 0`,
	).bind(mailboxId, threadId).run();
	return { threadId, markedRead: true };
}

// ── 10. getThreadedEmails ────────────────────────────────────────

/**
 * SQL fragment producing `participants_meta`: the participant list of a
 * conversation, consumed by formatParticipantLabel() in shared/participants.ts.
 *
 * Layout: `name? CHAR(31) address` per participant, entries joined by CHAR(30).
 *
 * Both fields are stripped of the two separators here. createEmail() already
 * sanitises whatever it writes, but rows inserted before that guard existed —
 * and rows backfilled by migration 0010 — can still carry them, and a stray
 * CHAR(30) inside a name would split one sender into two participants. Stripping
 * inside the aggregate makes the framing of the result independent of what is
 * already stored, and matches the replacement character used by the sanitizers
 * (a space, so words do not run together).
 */
const PARTICIPANTS_META_SQL =
	"GROUP_CONCAT(COALESCE(NULLIF(TRIM(REPLACE(REPLACE(sender_name, CHAR(30), ' '), CHAR(31), ' ')), ''), '') || CHAR(31) || REPLACE(REPLACE(sender, CHAR(30), ' '), CHAR(31), ' '), CHAR(30)) as participants_meta";

export async function getThreadedEmails(
	db: D1Database,
	mailboxId: string,
	options: GetEmailsOptions = {},
): Promise<ThreadedEmail[]> {
	const { folder, page = 1, limit: rawLimit = 25 } = options;
	const capLimit = Math.min(Math.max(rawLimit, 1), 100);

	if (!folder) {
		return getEmails(db, mailboxId, options) as unknown as Promise<ThreadedEmail[]>;
	}

	const offset = (page - 1) * capLimit;
	const isDraftFolder = folder === Folders.DRAFT;

	if (isDraftFolder) {
		const result = await db.prepare(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(in_reply_to, id) as draft_group_key
				FROM emails
				WHERE mailbox_id = ?1
				  AND folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2) LIMIT 1)
			),
			draft_stats AS (
				SELECT
					draft_group_key,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					${PARTICIPANTS_META_SQL}
				FROM folder_emails
				GROUP BY draft_group_key
			),
			latest_per_group AS (
				SELECT
					fe.*,
					ROW_NUMBER() OVER (
						PARTITION BY fe.draft_group_key
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
			)
			SELECT
				lp.id, lp.subject, lp.sender, lp.sender_name, lp.recipient, lp.date,
				lp.read, lp.starred, lp.thread_id, lp.folder_id,
				lp.in_reply_to, lp.email_references, lp.send_status,
				SUBSTR(lp.body, 1, 300) as snippet,
				ds.thread_count, ds.thread_unread_count, ds.participants,
				ds.participants_meta
			FROM latest_per_group lp
			JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
			WHERE lp.rn = 1
			ORDER BY lp.date DESC
			LIMIT ?3 OFFSET ?4`,
		).bind(mailboxId, folder, capLimit, offset).all() as any;

		const rows = result.results || [];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			participants_meta: row.participants_meta || null,
		}));
	}

	// Non-draft folders: full threading logic
	const result = await db.prepare(
		`WITH
		folder_emails AS (
			SELECT *,
				COALESCE(thread_id, id) as raw_thread_id,
				${NORMALIZED_SUBJECT_SQL} as normalized_subject
			FROM emails
			WHERE mailbox_id = ?1
			  AND folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2) LIMIT 1)
		),
		thread_to_conversation AS (
			SELECT
				raw_thread_id,
				normalized_subject,
				CASE
					WHEN thread_id IS NOT NULL THEN raw_thread_id
					ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
				END as conversation_id
			FROM folder_emails
			GROUP BY raw_thread_id, normalized_subject, thread_id
		),
		all_emails_with_conversation AS (
			SELECT
				e.*,
				COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
			FROM emails e
			LEFT JOIN thread_to_conversation tc
				ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			WHERE e.mailbox_id = ?1
		),
		conversation_stats AS (
			SELECT
				conversation_id,
				COUNT(*) as thread_count,
				SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
				SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
				GROUP_CONCAT(DISTINCT sender) as participants,
				${PARTICIPANTS_META_SQL},
				SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
			FROM all_emails_with_conversation
			WHERE conversation_id IN (
				SELECT DISTINCT conversation_id FROM all_emails_with_conversation
				WHERE folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2) LIMIT 1)
			)
			GROUP BY conversation_id
		),
		latest_message_per_conversation AS (
			SELECT
				conversation_id,
				folder_id,
				ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
			FROM all_emails_with_conversation
		),
		latest_in_folder AS (
			SELECT
				fe.*,
				COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
				ROW_NUMBER() OVER (
					PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
					ORDER BY fe.date DESC
				) as rn
			FROM folder_emails fe
			LEFT JOIN thread_to_conversation tc
				ON fe.raw_thread_id = tc.raw_thread_id
		)
		SELECT
			lif.id, lif.subject, lif.sender, lif.sender_name, lif.recipient, lif.date,
			lif.read, lif.starred, lif.thread_id, lif.folder_id,
			lif.in_reply_to, lif.email_references, lif.send_status,
			SUBSTR(lif.body, 1, 300) as snippet,
			cs.thread_count, cs.thread_unread_count, cs.participants,
			cs.participants_meta,
			CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE mailbox_id = ?1 AND name = 'sent' LIMIT 1)
				AND lmc.folder_id != (SELECT id FROM folders WHERE mailbox_id = ?1 AND name = 'draft' LIMIT 1)
				AND cs.thread_read_count > 0
				THEN 1 ELSE 0 END as needs_reply,
			CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
		FROM latest_in_folder lif
		JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
		LEFT JOIN latest_message_per_conversation lmc
			ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
		WHERE lif.rn = 1
		ORDER BY lif.date DESC
		LIMIT ?3 OFFSET ?4`,
	).bind(mailboxId, folder, capLimit, offset).all() as any;

	const rows = result.results || [];
	return rows.map((row: any) => ({
		...row,
		read: !!row.read,
		starred: !!row.starred,
		thread_count: row.thread_count || 1,
		thread_unread_count: row.thread_unread_count || 0,
		participants: row.participants || row.sender,
		participants_meta: row.participants_meta || null,
		needs_reply: !!row.needs_reply,
		has_draft: !!row.has_draft,
	}));
}

// ── 11. countThreadedEmails ──────────────────────────────────────

export async function countThreadedEmails(
	db: D1Database,
	mailboxId: string,
	folder: string,
): Promise<number> {
	const isDraftFolder = folder === Folders.DRAFT;

	if (isDraftFolder) {
		const result = await db.prepare(
			`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
			 FROM emails
			 WHERE mailbox_id = ?1
			   AND folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2) LIMIT 1)`,
		).bind(mailboxId, folder).first() as { total: number } | undefined;
		return result?.total ?? 0;
	}

	const result = await db.prepare(
		`WITH
		folder_emails AS (
			SELECT
				COALESCE(thread_id, id) as raw_thread_id,
				thread_id,
				${NORMALIZED_SUBJECT_SQL} as normalized_subject
			FROM emails
			WHERE mailbox_id = ?1
			  AND folder_id = (SELECT id FROM folders WHERE mailbox_id = ?1 AND (name = ?2 OR id = ?2) LIMIT 1)
		),
		thread_to_conversation AS (
			SELECT
				raw_thread_id,
				CASE
					WHEN thread_id IS NOT NULL THEN raw_thread_id
					WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					ELSE raw_thread_id
				END as conversation_id
			FROM folder_emails
			GROUP BY raw_thread_id, normalized_subject, thread_id
		)
		SELECT COUNT(DISTINCT conversation_id) as total
		FROM thread_to_conversation`,
	).bind(mailboxId, folder).first() as { total: number } | undefined;
	return result?.total ?? 0;
}

// ── 12. findThreadBySubject ──────────────────────────────────────

export async function findThreadBySubject(
	db: D1Database,
	mailboxId: string,
	subject: string,
	senderAddress?: string,
): Promise<string | null> {
	const normalized = subject
		.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
		.trim()
		.toLowerCase();

	if (!normalized) return null;

	const result = await db.prepare(
		`SELECT thread_id, subject,
		        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
		        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
		 FROM emails
		 WHERE mailbox_id = ?1
		   AND thread_id IS NOT NULL
		   AND thread_id != id
		   AND date >= datetime('now', '-7 days')
		 GROUP BY thread_id
		 ORDER BY MAX(date) DESC
		 LIMIT 50`,
	).bind(mailboxId).all() as any;

	const normalizedSender = senderAddress?.toLowerCase().trim();
	const rows = result.results || [];

	for (const row of rows) {
		const rowSubject = String(row.subject || "")
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();
		if (rowSubject !== normalized) continue;

		if (normalizedSender) {
			const threadSenders = String(row.senders || "");
			const threadRecipients = String(row.recipients || "");
			const allParticipants = `${threadSenders},${threadRecipients}`;
			if (!allParticipants.includes(normalizedSender)) {
				continue;
			}
		}

		return String(row.thread_id);
	}
	return null;
}



// ── 13. getFolders ───────────────────────────────────────────────

export async function getFolders(
	db: D1Database,
	mailboxId: string,
): Promise<FolderResult[]> {
	const orm = drizzle(db, { schema });
	const result = await orm
		.select({
			id: schema.folders.id,
			name: schema.folders.name,
			isDeletable: schema.folders.is_deletable,
			unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
		})
		.from(schema.folders)
		.leftJoin(
			schema.emails,
			and(
				eq(schema.emails.folder_id, schema.folders.id),
				eq(schema.emails.mailbox_id, mailboxId),
			),
		)
		.where(eq(schema.folders.mailbox_id, mailboxId))
		.groupBy(schema.folders.id, schema.folders.name)
		.all();

	return result.map((f) => ({
		id: f.id,
		name: f.name,
		isDeletable: f.isDeletable,
		unreadCount: f.unreadCount,
	}));
}

// ── 14. createFolder ─────────────────────────────────────────────

export async function createFolder(
	db: D1Database,
	mailboxId: string,
	id: string,
	name: string,
	isDeletable: number = 1,
): Promise<FolderResult | null> {
	try {
		const orm = drizzle(db, { schema });
		const result = await orm
			.insert(schema.folders)
			.values({ mailbox_id: mailboxId, id, name, is_deletable: isDeletable })
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return { ...result, isDeletable, unreadCount: 0 };
	} catch (e: unknown) {
		if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
			return null;
		}
		throw e;
	}
}

// ── 15. updateFolder ─────────────────────────────────────────────

export async function updateFolder(
	db: D1Database,
	mailboxId: string,
	id: string,
	name: string,
): Promise<{ id: string; name: string } | null> {
	const orm = drizzle(db, { schema });
	const result = await orm
		.update(schema.folders)
		.set({ name })
		.where(and(eq(schema.folders.mailbox_id, mailboxId), eq(schema.folders.id, id)))
		.returning({ id: schema.folders.id, name: schema.folders.name })
		.get();
	return result ?? null;
}

// ── 16. deleteFolder ─────────────────────────────────────────────

export async function deleteFolder(
	db: D1Database,
	mailboxId: string,
	id: string,
): Promise<boolean> {
	const orm = drizzle(db, { schema });

	const folder = await orm
		.select({ is_deletable: schema.folders.is_deletable })
		.from(schema.folders)
		.where(and(eq(schema.folders.mailbox_id, mailboxId), eq(schema.folders.id, id)))
		.get();

	if (!folder || folder.is_deletable === 0) {
		return false;
	}

	await orm
		.delete(schema.folders)
		.where(and(eq(schema.folders.mailbox_id, mailboxId), eq(schema.folders.id, id)))
		.run();

	return true;
}

// ── 17. moveEmail ────────────────────────────────────────────────

export async function moveEmail(
	db: D1Database,
	mailboxId: string,
	id: string,
	folderId: string,
): Promise<boolean> {
	const orm = drizzle(db, { schema });

	const folder = await orm
		.select({ id: schema.folders.id })
		.from(schema.folders)
		.where(and(eq(schema.folders.mailbox_id, mailboxId), eq(schema.folders.id, folderId)))
		.get();

	if (!folder) return false;

	await orm
		.update(schema.emails)
		.set({ folder_id: folderId })
		.where(and(eq(schema.emails.id, id), eq(schema.emails.mailbox_id, mailboxId)))
		.run();

	return true;
}

// ── 18. searchEmails ─────────────────────────────────────────────

export async function searchEmails(
	db: D1Database,
	mailboxId: string,
	options: SearchFilterOptions & { page?: number; limit?: number },
): Promise<EmailSummary[]> {
	const { page = 1, limit: rawLimit = 25 } = options;
	const capLimit = Math.min(Math.max(rawLimit, 1), 100);
	const { conditions, params } = buildSearchConditions(mailboxId, options, "e");

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const offset = (page - 1) * capLimit;

	const query = `
		SELECT e.id, e.subject, e.sender, e.sender_name, e.recipient, e.cc, e.bcc, e.date,
			e.read, e.starred, e.in_reply_to, e.email_references,
			e.thread_id, e.folder_id,
			SUBSTR(e.body, 1, 300) as snippet,
			f.name as folder_name
		FROM emails e
		LEFT JOIN folders f ON e.folder_id = f.id AND f.mailbox_id = ?1
		${where}
		ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;

	const allParams = [...params, capLimit, offset];
	const result = await db.prepare(query).bind(...allParams).all() as any;

	const rows = result.results || [];
	return rows.map((row: any) => ({
		...row,
		read: !!row.read,
		starred: !!row.starred,
	}));
}

// ── 19. countSearchResults ───────────────────────────────────────

export async function countSearchResults(
	db: D1Database,
	mailboxId: string,
	options: SearchFilterOptions,
): Promise<number> {
	const { conditions, params } = buildSearchConditions(mailboxId, options, "");

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const query = `SELECT COUNT(*) as total FROM emails ${where}`;

	const result = await db.prepare(query).bind(...params).first() as { total: number } | undefined;
	return result?.total ?? 0;
}

// ── Search condition builder (shared between searchEmails & countSearchResults) ──

function buildSearchConditions(
	mailboxId: string,
	options: SearchFilterOptions,
	tableAlias = "",
): { conditions: string[]; params: (string | number)[] } {
	const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
	const prefix = tableAlias ? `${tableAlias}.` : "";
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	let paramIdx = 0;

	const addParam = (value: string | number) => {
		paramIdx++;
		params.push(value);
		return `?${paramIdx}`;
	};

	// Always filter by mailbox_id
	const mbParam = addParam(mailboxId);
	conditions.push(`${prefix}mailbox_id = ${mbParam}`);

	if (query) {
		const p1 = addParam(`%${query}%`);
		const p2 = addParam(`%${query}%`);
		const p3 = addParam(`%${query}%`);
		const p4 = addParam(`%${query}%`);
		conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
	}
	if (folder) {
		const p = addParam(folder);
		conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE mailbox_id = ${mbParam} AND (name = ${p} OR id = ${p}) LIMIT 1)`);
	}
	if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
	if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
	if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
	if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
	if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
	if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
	if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
	if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments WHERE mailbox_id = ${mbParam})`); }

	return { conditions, params };
}

// ── 20. checkSendRateLimit ───────────────────────────────────────

export async function checkSendRateLimit(
	db: D1Database,
	mailboxId: string,
): Promise<RateLimitResult> {
	const hourResult = await db.prepare(
		`SELECT COUNT(*) as cnt FROM emails
		 WHERE mailbox_id = ?1
		   AND folder_id = ?2
		   AND date >= datetime('now', '-1 hour')`,
	).bind(mailboxId, Folders.SENT).first() as { cnt: number } | undefined;

	const dayResult = await db.prepare(
		`SELECT COUNT(*) as cnt FROM emails
		 WHERE mailbox_id = ?1
		   AND folder_id = ?2
		   AND date >= datetime('now', '-1 day')`,
	).bind(mailboxId, Folders.SENT).first() as { cnt: number } | undefined;

	return {
		hourlyCount: hourResult?.cnt ?? 0,
		dailyCount: dayResult?.cnt ?? 0,
		hourlyLimit: HOURLY_LIMIT,
		dailyLimit: DAILY_LIMIT,
	};
}

// ── 21. initMailboxFolders ───────────────────────────────────────

export async function initMailboxFolders(
	db: D1Database,
	mailboxId: string,
): Promise<void> {
	const defaultFolders = [
		{ id: "inbox", name: "Inbox", isDeletable: 0 },
		{ id: "sent", name: "Sent", isDeletable: 0 },
		{ id: "draft", name: "Drafts", isDeletable: 0 },
		{ id: "archive", name: "Archive", isDeletable: 0 },
		{ id: "trash", name: "Trash", isDeletable: 0 },
		{ id: "spam", name: "Spam", isDeletable: 0 },
	];

	const stmts = defaultFolders.map((f) =>
		db.prepare(
			`INSERT OR IGNORE INTO folders (mailbox_id, id, name, is_deletable) VALUES (?1, ?2, ?3, ?4)`,
		).bind(mailboxId, f.id, f.name, f.isDeletable),
	);

	await db.batch(stmts);
}

// ── 22. saveAiMessage ────────────────────────────────────────────

export async function saveAiMessage(
	db: D1Database,
	mailboxId: string,
	role: string,
	content: string,
): Promise<{ id: string }> {
	const id = crypto.randomUUID();
	await db.prepare(
		`INSERT INTO ai_chat_messages (id, mailbox_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
	).bind(id, mailboxId, role, content).run();
	return { id };
}

// ── 23. getAiChatHistory ─────────────────────────────────────────

export async function getAiChatHistory(
	db: D1Database,
	mailboxId: string,
	limit: number = 20,
): Promise<{ id: string; role: string; content: string; created_at: string }[]> {
	const result = await db.prepare(
		`SELECT id, role, content, created_at FROM ai_chat_messages WHERE mailbox_id = ? ORDER BY created_at ASC LIMIT ?`,
	).bind(mailboxId, limit).all() as any;
	return (result.results || []) as { id: string; role: string; content: string; created_at: string }[];
}

// ── 24. clearAiChatHistory ───────────────────────────────────────

export async function clearAiChatHistory(
	db: D1Database,
	mailboxId: string,
): Promise<void> {
	await db.prepare(
		`DELETE FROM ai_chat_messages WHERE mailbox_id = ?`,
	).bind(mailboxId).run();
}

// ── 25. Domain CRUD ─────────────────────────────────────────────

export interface DomainData {
	id: string;
	name: string;
	resend_domain_id?: string | null;
	cf_zone_id?: string | null;
	cf_account_id?: string | null;
	status: "pending" | "verified" | "failed";
	catch_all_mailbox?: string | null;
	resend_api_key?: string | null;
	created_at: string;
}

export interface DomainUpdate {
	resend_domain_id?: string | null;
	cf_zone_id?: string | null;
	cf_account_id?: string | null;
	status?: "pending" | "verified" | "failed";
	catch_all_mailbox?: string | null;
	resend_api_key?: string | null;
}

export async function createDomain(
	db: D1Database,
	data: DomainData,
): Promise<boolean> {
	const result = await db.prepare(
		`INSERT OR IGNORE INTO domains (id, name, resend_domain_id, cf_zone_id, cf_account_id, status, resend_api_key, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
	).bind(
		data.id,
		data.name,
		data.resend_domain_id ?? null,
		data.cf_zone_id ?? null,
		data.cf_account_id ?? null,
		data.status,
		data.resend_api_key ?? null,
		data.created_at,
	).run();
	return result.meta.changes > 0;
}

export async function getDomain(
	db: D1Database,
	id: string,
): Promise<DomainData | null> {
	const orm = drizzle(db, { schema });
	const result = await orm
		.select()
		.from(schema.domains)
		.where(eq(schema.domains.id, id))
		.get();
	return result ?? null;
}

export async function getDomainByName(
	db: D1Database,
	name: string,
): Promise<DomainData | null> {
	const orm = drizzle(db, { schema });
	const result = await orm
		.select()
		.from(schema.domains)
		.where(eq(schema.domains.name, name))
		.get();
	return result ?? null;
}

export async function listDomains(
	db: D1Database,
): Promise<DomainData[]> {
	const orm = drizzle(db, { schema });
	const results = await orm
		.select()
		.from(schema.domains)
		.orderBy(desc(schema.domains.created_at))
		.all();
	return results;
}

export async function updateDomain(
	db: D1Database,
	id: string,
	updates: DomainUpdate,
): Promise<DomainData | null> {
	const orm = drizzle(db, { schema });
	const setClause: Record<string, string | null> = {};
	if (updates.resend_domain_id !== undefined) setClause.resend_domain_id = updates.resend_domain_id ?? null;
	if (updates.cf_zone_id !== undefined) setClause.cf_zone_id = updates.cf_zone_id ?? null;
	if (updates.cf_account_id !== undefined) setClause.cf_account_id = updates.cf_account_id ?? null;
	if (updates.status !== undefined) setClause.status = updates.status;
	if (updates.catch_all_mailbox !== undefined) setClause.catch_all_mailbox = updates.catch_all_mailbox ?? null;
	if (updates.resend_api_key !== undefined) setClause.resend_api_key = updates.resend_api_key ?? null;

	if (Object.keys(setClause).length === 0) {
		return getDomain(db, id);
	}

	await orm
		.update(schema.domains)
		.set(setClause)
		.where(eq(schema.domains.id, id))
		.run();

	return getDomain(db, id);
}

export async function deleteDomain(
	db: D1Database,
	id: string,
): Promise<boolean> {
	const orm = drizzle(db, { schema });
	const result = await orm
		.delete(schema.domains)
		.where(eq(schema.domains.id, id))
		.run();
	return true;
}

/** Extract domain from a mailbox email address and look it up in the domains table. */
export async function getMailboxDomain(
	db: D1Database,
	mailboxId: string,
): Promise<DomainData | null> {
	const atIdx = mailboxId.indexOf("@");
	if (atIdx === -1) return null;
	const domainName = mailboxId.substring(atIdx + 1).toLowerCase();
	return getDomainByName(db, domainName);
}

// ── 26. Domain-aware Resend API key resolution ───────────────────

/**
 * Resolve the Resend API key for a given mailbox.
 * Priority: 1) per-mailbox R2 settings, 2) per-domain resend_api_key
 */
// ── 27. deleteMailbox ─────────────────────────────────────────

export async function deleteMailbox(
	db: D1Database,
	mailboxId: string,
): Promise<{ id: string; email_id: string; filename: string }[]> {
	const orm = drizzle(db, { schema });

	// Query all attachments for this mailbox (needed for R2 blob cleanup)
	const allAttachments = await orm
		.select({ id: schema.attachments.id, email_id: schema.attachments.email_id, filename: schema.attachments.filename })
		.from(schema.attachments)
		.where(eq(schema.attachments.mailbox_id, mailboxId))
		.all();

	// Delete all D1 data in a single batch
	const stmts: D1PreparedStatement[] = [];
	stmts.push(db.prepare(`DELETE FROM emails WHERE mailbox_id = ?`).bind(mailboxId));
	stmts.push(db.prepare(`DELETE FROM attachments WHERE mailbox_id = ?`).bind(mailboxId));
	stmts.push(db.prepare(`DELETE FROM folders WHERE mailbox_id = ?`).bind(mailboxId));
	stmts.push(db.prepare(`DELETE FROM ai_chat_messages WHERE mailbox_id = ?`).bind(mailboxId));
	await db.batch(stmts);

	return allAttachments;
}

// ── 28. Mailbox list summary (unread count + latest email) ────

export async function getMailboxUnreadCounts(
	db: D1Database,
	mailboxIds: string[],
): Promise<Map<string, number>> {
	if (mailboxIds.length === 0) return new Map();

	const orm = drizzle(db, { schema });
	const results = await orm
		.select({
			mailboxId: schema.emails.mailbox_id,
			count: sql<number>`COUNT(*)`.mapWith(Number),
		})
		.from(schema.emails)
		.where(
			and(
				eq(schema.emails.folder_id, 'inbox'),
				eq(schema.emails.read, 0),
				inArray(schema.emails.mailbox_id, mailboxIds),
			),
		)
		.groupBy(schema.emails.mailbox_id)
		.all();

	const map = new Map<string, number>();
	for (const row of results) {
		map.set(row.mailboxId, row.count);
	}
	return map;
}

export async function getMailboxLatestEmails(
	db: D1Database,
	mailboxIds: string[],
): Promise<Map<string, { subject: string | null; sender: string | null; sender_name: string | null; date: string | null; snippet: string | null }>> {
	if (mailboxIds.length === 0) return new Map();

	const orm = drizzle(db, { schema });

	// Use a subquery: for each mailbox_id, find the row with MAX(date)
	const idLiterals = mailboxIds.map((id) => sql`${id}`);
	const inList = sql.join(idLiterals, sql`, `);

	const results = await orm
		.select({
			mailboxId: schema.emails.mailbox_id,
			subject: schema.emails.subject,
			sender: schema.emails.sender,
			sender_name: schema.emails.sender_name,
			date: schema.emails.date,
			snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 150)`,
		})
		.from(schema.emails)
		.where(
			sql`(${schema.emails.mailbox_id}, ${schema.emails.date}) IN (
				SELECT mailbox_id, MAX(date)
				FROM emails
				WHERE mailbox_id IN (${inList})
				GROUP BY mailbox_id
			)`,
		)
		.all();

	const map = new Map<string, { subject: string | null; sender: string | null; sender_name: string | null; date: string | null; snippet: string | null }>();
	for (const row of results) {
		// If two rows share the same timestamp, keep the first (any is fine)
		if (!map.has(row.mailboxId)) {
			map.set(row.mailboxId, {
				subject: row.subject,
				sender: row.sender,
				sender_name: row.sender_name,
				date: row.date,
				snippet: row.snippet,
			});
		}
	}
	return map;
}

// ── 29. Platform Settings (key-value) ─────────────────────────

export async function getSetting(
	db: D1Database,
	key: string,
): Promise<string | null> {
	const result = await db
		.prepare("SELECT value FROM platform_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return result?.value ?? null;
}

export async function setSetting(
	db: D1Database,
	key: string,
	value: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO platform_settings (key, value, updated_at)
			 VALUES (?1, ?2, datetime('now'))
			 ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`,
		)
		.bind(key, value)
		.run();
}

export async function resolveResendApiKey(
	env: { DB: D1Database; BUCKET: R2Bucket },
	mailboxId: string,
): Promise<string | null> {
	// 1. Check per-mailbox R2 settings
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			if (typeof settings.resendApiKey === "string" && settings.resendApiKey) {
				return settings.resendApiKey;
			}
		}
	} catch {
		// Ignore read errors
	}

	// 2. Fallback: per-domain resend_api_key from domains table
	try {
		const domain = await getMailboxDomain(env.DB, mailboxId);
		if (domain?.resend_api_key) {
			return domain.resend_api_key;
		}
	} catch {
		// Ignore read errors
	}

	return null;
}

// ── 30. createApiKey ───────────────────────────────────────────

interface CreateApiKeyResult {
	id: string;
	plainText: string;
	prefix: string;
}

export async function createApiKey(
	db: D1Database,
	domainId: string,
	name: string,
	scopes?: string,
): Promise<CreateApiKeyResult> {
	const id = generateKeyId();
	const { plainText, prefix, hash } = await generateApiKey();
	const createdAt = new Date().toISOString();

	await db.prepare(
		`INSERT INTO api_keys (id, domain_id, name, key_hash, prefix, scopes, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
	).bind(
		id,
		domainId,
		name,
		hash,
		prefix,
		scopes ?? "send",
		createdAt,
	).run();

	return { id, plainText, prefix };
}

// ── 31. validateApiKey ─────────────────────────────────────────

export async function validateApiKey(
	db: D1Database,
	domainId: string,
	apiKey: string,
): Promise<{ valid: boolean; scopes: string | null; keyId: string | null }> {
	const prefix = extractPrefix(apiKey);

	const row = await db.prepare(
		`SELECT * FROM api_keys WHERE prefix = ?1 AND domain_id = ?2`,
	).bind(prefix, domainId).first() as {
		id: string;
		key_hash: string;
		scopes: string;
	} | undefined;

	if (!row) {
		return { valid: false, scopes: null, keyId: null };
	}

	const matches = await verifyApiKey(apiKey, row.key_hash);

	if (matches) {
		await updateApiKeyLastUsed(db, row.id);
		return { valid: true, scopes: row.scopes, keyId: row.id };
	}

	return { valid: false, scopes: null, keyId: null };
}

// ── 32. listApiKeys ────────────────────────────────────────────

export async function listApiKeys(
	db: D1Database,
	domainId: string,
): Promise<{ id: string; name: string; prefix: string; scopes: string; created_at: string; last_used_at: string | null; expires_at: string | null }[]> {
	const result = await db.prepare(
		`SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at
		 FROM api_keys
		 WHERE domain_id = ?1
		 ORDER BY created_at DESC`,
	).bind(domainId).all() as any;

	return (result.results || []) as {
		id: string;
		name: string;
		prefix: string;
		scopes: string;
		created_at: string;
		last_used_at: string | null;
		expires_at: string | null;
	}[];
}

// ── 33. revokeApiKey ───────────────────────────────────────────

export async function revokeApiKey(
	db: D1Database,
	domainId: string,
	keyId: string,
): Promise<boolean> {
	const result = await db.prepare(
		`DELETE FROM api_keys WHERE id = ?1 AND domain_id = ?2`,
	).bind(keyId, domainId).run();

	return result.meta.changes > 0;
}

// ── 34. updateApiKeyLastUsed (internal) ────────────────────────

async function updateApiKeyLastUsed(
	db: D1Database,
	keyId: string,
): Promise<void> {
	await db.prepare(
		`UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2`,
	).bind(new Date().toISOString(), keyId).run();
}

// ── 35. lookupApiKey ────────────────────────────────────────────

/**
 * 仅凭 API Key 查找对应的邮箱和权限（无需预先知道 domainId）
 * 用于 /api/v1/send 等无法从 URL 获取 domainId 的场景
 */
export async function lookupApiKey(
	db: D1Database,
	apiKey: string,
): Promise<{ valid: boolean; scopes: string | null; keyId: string | null; domainId: string | null }> {
	const prefix = extractPrefix(apiKey);
	const result = await db.prepare(
		"SELECT id, domain_id, key_hash, scopes FROM api_keys WHERE prefix = ?"
	).bind(prefix).all() as any;
	const rows: { id: string; domain_id: string; key_hash: string; scopes: string }[] = result.results || [];

	if (!rows || rows.length === 0) {
		return { valid: false, scopes: null, keyId: null, domainId: null };
	}

	for (const row of rows) {
		const match = await verifyApiKey(apiKey, row.key_hash);
		if (match) {
			// 更新 last_used_at
			await updateApiKeyLastUsed(db, row.id);
			return { valid: true, scopes: row.scopes, keyId: row.id, domainId: row.domain_id };
		}
	}

	return { valid: false, scopes: null, keyId: null, domainId: null };
}

// ── 30. Admin Sessions (login) ────────────────────────────────

export interface Session {
	token: string;
	created_at: string;
	expires_at: string;
}

export async function createSession(
	db: D1Database,
	token: string,
	expiresAt: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO sessions (token, created_at, expires_at)
			 VALUES (?1, datetime('now'), ?2)`,
		)
		.bind(token, expiresAt)
		.run();
}

export async function getSession(
	db: D1Database,
	token: string,
): Promise<Session | null> {
	const result = await db
		.prepare("SELECT token, created_at, expires_at FROM sessions WHERE token = ?")
		.bind(token)
		.first<Session>();
	return result ?? null;
}

export async function deleteSession(
	db: D1Database,
	token: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM sessions WHERE token = ?")
		.bind(token)
		.run();
}

// Best-effort cleanup of expired sessions; failures are non-fatal.
export async function cleanupExpiredSessions(
	db: D1Database,
): Promise<void> {
	try {
		await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
	} catch {
		// ignore — cleanup is opportunistic
	}
}

/** Invalidate every session — used when admin credentials change. */
export async function deleteAllSessions(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM sessions").run();
}

// ── 31. Admin Accounts (first-run setup) ──────────────────────

export interface Admin {
	id: string;
	username: string;
	/** Salted PBKDF2-SHA256 hash — see workers/lib/password.ts. */
	password: string;
	created_at: string;
	updated_at: string;
}

const ADMIN_COLUMNS = "id, username, password, created_at, updated_at";

/**
 * Number of admin accounts. The app is "uninitialised" while this is 0 and
 * sends every visitor to the setup wizard.
 */
export async function countAdmins(db: D1Database): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS cnt FROM admins")
		.first<{ cnt: number }>();
	return row?.cnt ?? 0;
}

export async function getAdminByUsername(
	db: D1Database,
	username: string,
): Promise<Admin | null> {
	const row = await db
		.prepare(`SELECT ${ADMIN_COLUMNS} FROM admins WHERE username = ?`)
		.bind(username)
		.first<Admin>();
	return row ?? null;
}

/** The single admin account (this app is single-admin by design). */
export async function getFirstAdmin(db: D1Database): Promise<Admin | null> {
	const row = await db
		.prepare(`SELECT ${ADMIN_COLUMNS} FROM admins ORDER BY created_at LIMIT 1`)
		.first<Admin>();
	return row ?? null;
}

/**
 * Create the first admin account.
 *
 * The conditional INSERT means concurrent first-run requests cannot both
 * succeed — exactly one caller gets `true`, the rest get `false`.
 */
export async function createFirstAdmin(
	db: D1Database,
	admin: { id: string; username: string; password: string },
): Promise<boolean> {
	const now = new Date().toISOString();
	const result = await db
		.prepare(
			`INSERT INTO admins (id, username, password, created_at, updated_at)
			 SELECT ?1, ?2, ?3, ?4, ?4
			 WHERE NOT EXISTS (SELECT 1 FROM admins)`,
		)
		.bind(admin.id, admin.username, admin.password, now)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function updateAdminPassword(
	db: D1Database,
	id: string,
	password: string,
): Promise<void> {
	await db
		.prepare("UPDATE admins SET password = ?, updated_at = ? WHERE id = ?")
		.bind(password, new Date().toISOString(), id)
		.run();
}
