#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// ─────────────────────────────────────────────────────────────────────────────
//  One-off seed for the DEMO database and bucket (docs/demo-site-plan.md §3.5)
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the first fill of an empty demo instance. After it runs, the demo
// keeps itself in shape through workers/demo/reset.ts (Cron every 6h + the
// lazy reset on demo-login), which reads the SAME `workers/demo/seed-data.json`.
//
//   node scripts/seed-demo.mjs --local      # wrangler dev's local D1 + R2
//   node scripts/seed-demo.mjs --remote     # the real demo database + bucket
//
//   --config <path>    wrangler config to use (default wrangler.demo.jsonc)
//   --bucket <name>    R2 bucket name        (default mailboxes-demo)
//   --persist-to <dir> local state directory (default .wrangler/state)
//   --skip-schema      do not touch the schema before seeding
//
// Why both stores, again: a mailbox IS an R2 object (`mailboxes/<email>.json`).
// `requireMailbox` HEADs that key and answers 404 without it, so a D1-only seed
// produces a demo where the sidebar lists mailboxes and every one of them is
// empty. This script writes D1 *and* R2, then verifies both.
//
// The SQL here is deliberately a second implementation of what reset.ts does at
// runtime (a `.mjs` script cannot import the Worker module). The end-of-run
// self-check compares the live numbers against `seed-data.json`'s own baselines
// with the same assertions the runtime uses, so if the two ever drift, the very
// first seed fails loudly instead of producing a subtly different demo.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "workers", "demo", "seed-data.json");

const args = process.argv.slice(2);
const mode = args.includes("--remote") ? "remote" : args.includes("--local") ? "local" : null;
if (!mode) {
	console.error("usage: node scripts/seed-demo.mjs --local|--remote [--config <path>] [--bucket <name>] [--skip-schema]");
	process.exit(2);
}
const configArg = args.indexOf("--config");
const CONFIG = configArg === -1 ? "wrangler.demo.jsonc" : args[configArg + 1];
const bucketArg = args.indexOf("--bucket");
const BUCKET = bucketArg === -1 ? "mailboxes-demo" : args[bucketArg + 1];
const skipSchema = args.includes("--skip-schema");
const persistArg = args.indexOf("--persist-to");
const PERSIST = persistArg === -1 ? null : args[persistArg + 1];

const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
const workDir = mkdtempSync(join(tmpdir(), "mailboxes-demo-seed-"));

/** Run wrangler with a config, forwarding stdout. */
function wrangler(argv, { capture = false } = {}) {
	const local = mode === "local" && PERSIST ? ["--persist-to", PERSIST] : [];
	const full = ["wrangler", ...argv, "-c", CONFIG, ...local];
	const exec = () =>
		execFileSync("npx", full, {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
	return exec();
}

/** `wrangler d1 execute` with `--json`, parsed. */
function d1(sql) {
	const raw = wrangler(
		["d1", "execute", "DB", `--${mode}`, "--json", "--command", sql],
		{ capture: true },
	);
	// wrangler prints a banner before the JSON payload; take from the first '['.
	const start = raw.indexOf("[");
	if (start === -1) throw new Error(`unexpected wrangler output:\n${raw}`);
	return JSON.parse(raw.slice(start));
}

function scalar(sql) {
	const rows = d1(sql);
	const first = rows[0]?.results?.[0];
	return first ? Number(Object.values(first)[0]) : 0;
}

// ── 1. Schema parity for the demo database only ────────────────────────────
//
// `domains.resend_api_key` exists on the production database but is created by
// nothing in migrations/ (0005 is a no-op that says "applied via other means").
// A demo database built purely from migrations therefore lacks the column, and
// every `SELECT * FROM domains` through drizzle fails. Adding it here — on the
// DEMO database only, guarded by a PRAGMA — keeps the published migrations
// untouched (they run against production too, where the column already exists
// and a duplicate-column ALTER would fail the deploy).
if (!skipSchema) {
	const columns = d1("PRAGMA table_info(domains)")
		.flatMap((result) => result.results ?? [])
		.map((column) => String(column.name));
	if (!columns.includes("resend_api_key")) {
		console.log("[seed] demo schema: adding domains.resend_api_key (demo database only)");
		d1("ALTER TABLE domains ADD COLUMN resend_api_key TEXT");
	} else {
		console.log("[seed] demo schema: domains.resend_api_key already present");
	}
}

// ── 2. D1: wipe, then insert ─────────────────────────────────────────────────
const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const q = (value) => {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return String(value);
	return `'${String(value).replace(/'/g, "''")}'`;
};

const statements = [
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
];

for (const mailbox of seed.mailboxes) {
	for (const folder of mailbox.folders) {
		statements.push(
			`INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES (${q(mailbox.id)}, ${q(folder.id)}, ${q(folder.name)}, ${q(folder.is_deletable)})`,
		);
	}
}

for (const email of seed.emails) {
	const date = iso(email.minutes_ago);
	const rawHeaders = JSON.stringify(
		email.raw_headers.map((header) => ({
			key: header.key,
			value: header.value === "{{date}}" ? date : header.value,
		})),
	);
	statements.push(
		`INSERT INTO emails (id, mailbox_id, folder_id, subject, sender, sender_name, recipient, cc, bcc, date, read, starred, body, in_reply_to, email_references, thread_id, message_id, raw_headers, send_status) VALUES (` +
			[
				q(email.id),
				q(email.mailbox_id),
				q(email.folder_id),
				q(email.subject),
				q(email.sender),
				q(email.sender_name),
				q(email.recipient),
				q(email.cc),
				q(email.bcc),
				q(date),
				q(email.read),
				q(email.starred),
				q(email.body),
				q(email.in_reply_to),
				q(email.email_references),
				q(email.thread_id),
				q(email.message_id),
				q(rawHeaders),
				q(email.send_status),
			].join(", ") +
			")",
	);
}

for (const attachment of seed.attachments) {
	const bytes = Buffer.from(attachment.content_base64, "base64");
	statements.push(
		`INSERT INTO attachments (id, email_id, mailbox_id, filename, mimetype, size, content_id, disposition) VALUES (` +
			[
				q(attachment.id),
				q(attachment.email_id),
				q(attachment.mailbox_id),
				q(attachment.filename),
				q(attachment.mimetype),
				q(bytes.byteLength),
				q(attachment.content_id),
				q(attachment.disposition),
			].join(", ") +
			")",
	);
}

for (const domain of seed.domains) {
	statements.push(
		`INSERT INTO domains (id, name, status, created_at) VALUES (${q(domain.id)}, ${q(domain.name)}, ${q(domain.status)}, ${q(iso(domain.created_minutes_ago))})`,
	);
}

seed.ai_messages.forEach((message, index) => {
	statements.push(
		`INSERT INTO ai_chat_messages (id, mailbox_id, role, content, created_at) VALUES (${q(`demo-ai-message-${index + 1}`)}, ${q(message.mailbox_id)}, ${q(message.role)}, ${q(message.content)}, ${q(iso(message.minutes_ago))})`,
	);
});

const adminCreatedAt = iso(30 * 24 * 60);
statements.push(
	`INSERT INTO admins (id, username, password, created_at, updated_at) VALUES (${q(seed.admin.id)}, ${q(seed.admin.username)}, ${q(seed.admin.password)}, ${q(adminCreatedAt)}, ${q(adminCreatedAt)})`,
);

const sqlPath = join(workDir, "seed.sql");
writeFileSync(sqlPath, `${statements.join(";\n")};\n`, "utf8");
console.log(`[seed] ${statements.length} statements → ${sqlPath}`);
wrangler(["d1", "execute", "DB", `--${mode}`, "--file", sqlPath]);

// ── 3. R2: mailbox objects and attachment blobs ─────────────────────────────
let puts = 0;
for (const mailbox of seed.mailboxes) {
	const settings = {
		...mailbox.settings,
		created_at: iso(mailbox.created_minutes_ago),
	};
	const file = join(workDir, `${mailbox.id}.json`);
	writeFileSync(file, JSON.stringify(settings), "utf8");
	wrangler(["r2", "object", "put", `${BUCKET}/mailboxes/${mailbox.id}.json`, "--file", file, `--${mode}`]);
	puts++;
}

for (const attachment of seed.attachments) {
	const file = join(workDir, attachment.filename);
	writeFileSync(file, Buffer.from(attachment.content_base64, "base64"));
	const key = `attachments/${attachment.email_id}/${attachment.id}/${attachment.filename.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_")}`;
	wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, `--${mode}`]);
	puts++;
}
console.log(`[seed] ${puts} R2 objects uploaded`);

// ── 4. Self-check ───────────────────────────────────────────────────────────
const checks = [];
const expect = (label, actual, expected) => {
	checks.push({ label, actual, expected, ok: actual === expected });
};

expect("emails", scalar("SELECT COUNT(*) AS n FROM emails"), seed.counts.emails);
expect("folders", scalar("SELECT COUNT(*) AS n FROM folders"), seed.counts.folders);
expect("attachments", scalar("SELECT COUNT(*) AS n FROM attachments"), seed.counts.attachments);
expect("ai_chat_messages", scalar("SELECT COUNT(*) AS n FROM ai_chat_messages"), seed.counts.ai_messages);
expect("domains", scalar("SELECT COUNT(*) AS n FROM domains"), seed.counts.domains);
expect("admins", scalar("SELECT COUNT(*) AS n FROM admins"), 1);
expect("starred", scalar("SELECT COUNT(*) AS n FROM emails WHERE starred = 1"), seed.counts.starred);
expect("platform_settings (must be empty)", scalar("SELECT COUNT(*) AS n FROM platform_settings"), 0);
expect("agent_api_keys (must be empty)", scalar("SELECT COUNT(*) AS n FROM agent_api_keys"), 0);

const unread = d1(
	"SELECT mailbox_id, COUNT(*) AS n FROM emails WHERE folder_id = 'inbox' AND read = 0 GROUP BY mailbox_id",
).flatMap((result) => result.results ?? []);
for (const [mailbox, expected] of Object.entries(seed.counts.inbox_unread)) {
	const row = unread.find((entry) => entry.mailbox_id === mailbox);
	expect(`inbox unread ${mailbox}`, Number(row?.n ?? 0), expected);
}

// Attachment rows must point at objects that really exist with that size.
const attachmentRows = d1(
	"SELECT id, email_id, filename, size FROM attachments ORDER BY id",
).flatMap((result) => result.results ?? []);
for (const row of attachmentRows) {
	const seedRow = seed.attachments.find((entry) => entry.id === row.id);
	const realSize = seedRow ? Buffer.from(seedRow.content_base64, "base64").byteLength : -1;
	expect(`size of ${row.filename}`, Number(row.size), realSize);
}

// The credential boundary: nothing in this database can send mail.
const columns = d1("PRAGMA table_info(domains)")
	.flatMap((result) => result.results ?? [])
	.map((column) => String(column.name));
if (columns.includes("resend_api_key")) {
	expect(
		"domains with a resend_api_key",
		scalar("SELECT COUNT(*) AS n FROM domains WHERE resend_api_key IS NOT NULL"),
		0,
	);
}

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
	console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.label}: ${check.actual} (expected ${check.expected})`);
}
if (failed.length > 0) {
	console.error(`[seed] ${failed.length} check(s) failed — the demo database does not match seed-data.json`);
	process.exit(1);
}
console.log(`[seed] self-check passed (${checks.length} checks) on the ${mode} demo instance`);
