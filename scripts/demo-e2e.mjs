#!/usr/bin/env node
// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
//
// ─────────────────────────────────────────────────────────────────────────────
//  Local end-to-end check of the read-only demo (no Cloudflare account needed)
// ─────────────────────────────────────────────────────────────────────────────
//
//   npm run build && node scripts/demo-e2e.mjs
//
// ── Why not `wrangler dev -c wrangler.demo.jsonc` ──────────────────────────
// That command cannot work for this app, and it is not a configuration mistake:
// `workers/app.ts` imports `virtual:react-router/server-build`, a module that
// only exists inside a Vite build. Wrangler's own bundler has no such module and
// fails with "Could not resolve \"virtual:react-router/server-build\"" before a
// single request is served. The SPA is built by `npm run build`, so this script
// runs the BUILT Worker (`build/server/index.js`) in workerd via Miniflare with
// demo bindings — same runtime, same code, no deploy, no credentials.
//
// ── What it proves ─────────────────────────────────────────────────────────
//   seed → guest login → read the lists → every write refused → reset → counts
//   back on the baseline, all through real HTTP requests to the real Worker.
//
// ── What it cannot prove ───────────────────────────────────────────────────
// Miniflare 5 exposes no scheduled-event dispatcher, so the Cron tick itself is
// not fired here. The reset it would run is the SAME function (`ensureDemoData`),
// which this script drives through the lazy demo-login path, and which
// `workers/demo/reset.test.ts` also drives directly.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "build", "server", "index.js");
const MIGRATIONS = resolve(ROOT, "migrations");
const SEED = resolve(ROOT, "workers", "demo", "seed-data.json");

const ORIGIN = "https://demo.local";
const MAILBOX = "hello@fernhill.studio";
const MAILBOX_PATH = encodeURIComponent(MAILBOX);

const seed = JSON.parse(readFileSync(SEED, "utf8"));

const checks = [];
function check(label, ok, detail = "") {
	checks.push({ label, ok, detail });
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Every ES module of the built Worker, entry first. Miniflare needs them all
 * listed because the build is `no_bundle` + `code-splitting`: `index.js`
 * imports `./assets/worker-entry-*.js`, which in turn imports the route chunks
 * (one of which is the seed JSON).
 */
function buildModules(root) {
	const entry = resolve(root, "index.js");
	const rest = readdirSync(resolve(root, "assets"))
		.filter((name) => name.endsWith(".js"))
		.sort()
		.map((name) => resolve(root, "assets", name));
	return [entry, ...rest].map((path) => ({ type: "ESModule", path }));
}

const mf = new Miniflare(
	// Miniflare 5 moved to a `workers: [...]` shape; this helper keeps the
	// familiar single-worker form (bindings / d1Databases).
	convertV4MiniflareOptions({
		modules: buildModules(resolve(ROOT, "build", "server")),
		// Module names in workerd are relative to this root, matching the
		// `import "./assets/worker-entry-*.js"` the Vite build emits. Without it
		// the runtime looks for "build/server/assets/..." and fails to start.
		modulesRoot: resolve(ROOT, "build", "server"),
		compatibilityDate: "2025-11-28",
		compatibilityFlags: ["nodejs_compat"],
		bindings: { DEMO_MODE: "1" },
		d1Databases: { DB: "demo-e2e-db" },
		r2Buckets: { BUCKET: "demo-e2e-bucket" },
		// No `ai` binding, exactly like wrangler.demo.jsonc: nothing to spend.
	}),
);

try {
	const db = await mf.getD1Database("DB");
	const bucket = await mf.getR2Bucket("BUCKET");

	// ── 0. Migrate the throwaway database ───────────────────────────────
	console.log("[e2e] applying migrations");
	// D1's `exec()` is LINE-oriented (it runs each line as its own statement),
	// so a multi-line CREATE TABLE trips it with "incomplete input" and a
	// leading comment block trips it with "did not contain a statement". Split
	// the files into real statements and prepare() each one instead.
	const splitStatements = (sql) => {
		const statements = [];
		let buffer = [];
		for (const raw of sql.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("--")) continue;
			buffer.push(raw);
			if (line.endsWith(";")) {
				statements.push(buffer.join("\n").trim().replace(/;\s*$/, ""));
				buffer = [];
			}
		}
		if (buffer.length > 0) statements.push(buffer.join("\n").trim());
		return statements.filter(Boolean);
	};
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
		for (const statement of splitStatements(readFileSync(resolve(MIGRATIONS, file), "utf8"))) {
			await db.prepare(statement).run();
		}
	}

	const count = async (sql, ...params) => {
		const row = await db.prepare(sql).bind(...params).first();
		return Number(row ? Object.values(row)[0] : 0);
	};

	// ── 1. Guest login (also seeds: the demo has never been reset) ───────
	console.log("[e2e] 1. POST /api/v1/auth/demo-login");
	const login = await mf.dispatchFetch(`${ORIGIN}/api/v1/auth/demo-login`, { method: "POST" });
	const cookieHeader = login.headers.get("set-cookie") ?? "";
	const cookie = cookieHeader.slice(0, cookieHeader.indexOf(";"));
	const loginBody = await login.json();
	check("demo-login answers 200", login.status === 200, `status=${login.status}`);
	check("demo-login flags the session as a demo", loginBody.demo === true);
	check("demo-login sets an HttpOnly, 1-hour cookie", /HttpOnly/i.test(cookieHeader) && /Max-Age=3600/i.test(cookieHeader));
	check(
		"first login seeded the demo (128 emails)",
		(await count("SELECT COUNT(*) FROM emails")) === seed.counts.emails,
		`emails=${await count("SELECT COUNT(*) FROM emails")}`,
	);
	const r2Mailboxes = await bucket.list({ prefix: "mailboxes/" });
	check(
		"mailbox objects exist in R2 (the D1-only trap)",
		r2Mailboxes.objects.length === 3,
		`${r2Mailboxes.objects.length} objects`,
	);

	const withCookie = (path, init = {}) =>
		mf.dispatchFetch(`${ORIGIN}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) },
		});

	// ── 2. Reads ───────────────────────────────────────────────────────
	console.log("[e2e] 2. reading the demo as a visitor");
	const mailboxes = await (await withCookie("/api/v1/mailboxes")).json();
	check("GET /api/v1/mailboxes returns 3 mailboxes", Array.isArray(mailboxes) && mailboxes.length === 3);
	const inbox = await (await withCookie(`/api/v1/mailboxes/${MAILBOX_PATH}/emails?folder=inbox&limit=5`)).json();
	check("inbox list has 52 emails in total", inbox.totalCount === 52, `totalCount=${inbox.totalCount}`);
	const folders = await (await withCookie(`/api/v1/mailboxes/${MAILBOX_PATH}/folders`)).json();
	const inboxFolder = Array.isArray(folders) ? folders.find((f) => f.id === "inbox") : null;
	check("inbox unread is the seeded 7", inboxFolder?.unreadCount === 7, `unread=${inboxFolder?.unreadCount}`);
	const thread = await (await withCookie(`/api/v1/mailboxes/${MAILBOX_PATH}/threads/t1-m1@brightfield.example`)).json();
	check("a seeded conversation comes back threaded", Array.isArray(thread) && thread.length === 7, `${thread.length} messages`);
	const attachment = await withCookie(
		`/api/v1/mailboxes/${MAILBOX_PATH}/emails/demo-hello-sent-invoice/attachments/att-0001`,
	);
	const attachmentBytes = new Uint8Array(await attachment.arrayBuffer());
	check(
		"an attachment downloads as a real PDF",
		attachment.status === 200 && String.fromCharCode(...attachmentBytes.slice(0, 5)) === "%PDF-",
		`status=${attachment.status}, ${attachmentBytes.byteLength} bytes`,
	);

	// ── 3. Writes ──────────────────────────────────────────────────────
	console.log("[e2e] 3. trying to write, one route at a time");
	const writes = [
		["POST", "/api/v1/mailboxes"],
		["PUT", `/api/v1/mailboxes/${MAILBOX_PATH}`],
		["DELETE", `/api/v1/mailboxes/${MAILBOX_PATH}`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/emails`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/drafts`],
		["PUT", `/api/v1/mailboxes/${MAILBOX_PATH}/emails/x`],
		["DELETE", `/api/v1/mailboxes/${MAILBOX_PATH}/emails/x`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/emails/x/move`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/emails/x/reply`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/threads/thread-1/read`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/folders`],
		["POST", `/api/v1/mailboxes/${MAILBOX_PATH}/ai/chat`],
		["DELETE", `/api/v1/mailboxes/${MAILBOX_PATH}/ai/chat`],
		["POST", "/api/v1/domains"],
		["PUT", "/api/v1/platform-settings/cf_api_token"],
		["GET", "/api/v1/platform-settings/cf_api_token"],
		["POST", "/api/v1/setup/admin"],
		["POST", "/api/v1/inbound/resend"],
		["POST", "/mcp"],
		["GET", "/tools"],
		["POST", "/tools/call"],
	];
	let blocked = 0;
	for (const [method, path] of writes) {
		const res = await withCookie(path, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
		const body = await res.json().catch(() => ({}));
		const ok = res.status === 403 && body.code === "demo_read_only";
		if (ok) blocked++;
		check(`${method} ${path} → 403 demo_read_only`, ok, `status=${res.status} code=${body.code ?? "-"}`);
	}
	check(`all ${writes.length} write routes refused`, blocked === writes.length, `${blocked}/${writes.length}`);
	check(
		"nothing was written by any of them",
		(await count("SELECT COUNT(*) FROM emails")) === seed.counts.emails &&
			(await count("SELECT COUNT(*) FROM platform_settings")) === 0,
		`emails=${await count("SELECT COUNT(*) FROM emails")}`,
	);
	const login404 = await mf.dispatchFetch(`${ORIGIN}/api/v1/auth/demo-login`, { method: "POST" });
	check("demo-login is reachable (no 401 wall before it)", login404.status === 200);

	// ── 4. Drift, then reset ───────────────────────────────────────────
	console.log("[e2e] 4. dirtying the data, then triggering a reset");
	await db.prepare("DELETE FROM emails WHERE mailbox_id = ? AND folder_id = 'inbox'").bind("ops@lumen-mail.dev").run();
	await db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES ('cf_api_token','leaked','now')").run();
	await db.prepare("UPDATE demo_meta SET value = '1970-01-01T00:00:00.000Z' WHERE key = 'last_reset_at'").run();
	check("data is dirty before the reset", (await count("SELECT COUNT(*) FROM emails")) < seed.counts.emails);

	const relogin = await mf.dispatchFetch(`${ORIGIN}/api/v1/auth/demo-login`, { method: "POST" });
	check("the next guest login triggers the reset", relogin.status === 200);

	const after = {
		emails: await count("SELECT COUNT(*) FROM emails"),
		folders: await count("SELECT COUNT(*) FROM folders"),
		attachments: await count("SELECT COUNT(*) FROM attachments"),
		ai: await count("SELECT COUNT(*) FROM ai_chat_messages"),
		domains: await count("SELECT COUNT(*) FROM domains"),
		admins: await count("SELECT COUNT(*) FROM admins"),
		settings: await count("SELECT COUNT(*) FROM platform_settings"),
		starred: await count("SELECT COUNT(*) FROM emails WHERE starred = 1"),
	};
	check("emails back to baseline", after.emails === seed.counts.emails, `emails=${after.emails}`);
	check("folders back to baseline", after.folders === seed.counts.folders, `folders=${after.folders}`);
	check("attachments back to baseline", after.attachments === seed.counts.attachments, `attachments=${after.attachments}`);
	check("AI transcript back to baseline", after.ai === seed.counts.ai_messages, `ai=${after.ai}`);
	check("domains back to baseline", after.domains === seed.counts.domains);
	check("exactly one admin (the demo account)", after.admins === 1);
	check("starred back to baseline", after.starred === seed.counts.starred, `starred=${after.starred}`);
	check("the credential written before the reset is gone", after.settings === 0);

	const unread = await db
		.prepare("SELECT mailbox_id, COUNT(*) AS n FROM emails WHERE folder_id='inbox' AND read=0 GROUP BY mailbox_id")
		.all();
	const unreadMap = Object.fromEntries(
		unread.results
			.map((row) => [row.mailbox_id, Number(row.n)])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
	);
	const expectedUnread = Object.fromEntries(
		Object.entries(seed.counts.inbox_unread).sort(([a], [b]) => a.localeCompare(b)),
	);
	check(
		"inbox unread is 7 / 2 / 1 again",
		JSON.stringify(unreadMap) === JSON.stringify(expectedUnread),
		JSON.stringify(unreadMap),
	);
	const r2After = await bucket.list({ prefix: "attachments/" });
	check("attachment objects were rebuilt in R2", r2After.objects.length === seed.counts.attachments, `${r2After.objects.length} objects`);

	// ── 5. The demo login cannot become an admin login ──────────────────
	console.log("[e2e] 5. confirming the password login stays dead");
	for (const [username, password] of [["demo", "demo"], ["admin", "admin"], ["demo", ""]]) {
		const res = await mf.dispatchFetch(`${ORIGIN}/api/v1/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
		});
		check(`POST /api/v1/auth/login ${username}/${password || "∅"} → 401`, res.status === 401, `status=${res.status}`);
	}
} finally {
	await mf.dispose();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n[e2e] ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
	for (const entry of failed) console.error(`  FAILED: ${entry.label} ${entry.detail}`);
	process.exit(1);
}
console.log("[e2e] the demo behaves as a read-only site against the real Worker runtime.");
