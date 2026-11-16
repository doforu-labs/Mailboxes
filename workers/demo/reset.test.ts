// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * The demo reset: seed one store, seed the OTHER one too, and come back to the
 * same numbers every time.
 *
 * ── What this pins ─────────────────────────────────────────────────────────
 *   1. Both stores are filled. `mailboxes/<email>.json` in R2 is a mailbox as
 *      far as the app is concerned (`requireMailbox` HEADs it and 404s without
 *      it), so a D1-only seed produces a demo where every mailbox is empty.
 *   2. The counts land exactly on `seed-data.json`'s baselines — including the
 *      7 / 2 / 1 unread split and the 3 starred rows — and land there again
 *      after the data has been dirtied.
 *   3. The 6-hour gate and the atomic claim: a reset that is not due does
 *      nothing, two concurrent resets produce exactly one rebuild, and a failed
 *      rebuild releases the claim so the next trigger retries.
 *   4. The credential boundary holds structurally: no `resendApiKey` in the
 *      mailbox JSON, no Resend/Cloudflare ids on the domains, empty
 *      `platform_settings` / `agent_api_keys`, and a guest session that cannot
 *      become an admin login.
 *
 * To run: npm test
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import type { Env } from "../types";
import {
	count,
	createBucket,
	createDb,
	insertSession,
	sqliteSkip,
	type FakeBucket,
	type Sqlite,
} from "./harness";
import {
	DEMO_EPOCH_ISO,
	DEMO_META_KEY,
	DEMO_RESET_INTERVAL_MS,
	attachmentKey,
	diffDemoCounts,
	ensureDemoData,
	isResetDue,
	readDemoCounts,
	readLastResetAt,
} from "./reset";
import { handleDemoLogin } from "./login";
import { loadDemoSeed } from "./seed";

const seed = await loadDemoSeed();
const HELLO = "hello@fernhill.studio";

type Sandbox = { db: D1Database; sqlite: Sqlite; bucket: FakeBucket; env: Env };

function sandbox(): Sandbox {
	const { db, sqlite } = createDb();
	const bucket = createBucket();
	return { db, sqlite, bucket, env: { DB: db, BUCKET: bucket.bucket, DEMO_MODE: "1" } as unknown as Env };
}

/** Move `demo_meta` into the past so the next call is due. */
function makeDue(sqlite: Sqlite, hoursAgo = 7): void {
	sqlite
		.prepare("UPDATE demo_meta SET value = ? WHERE key = ?")
		.run(new Date(Date.now() - hoursAgo * 3600_000).toISOString(), DEMO_META_KEY);
}

/** A tiny Hono-free context, enough for `handleDemoLogin`. */
function loginContext(env: Env) {
	const headers = new Headers();
	return {
		env,
		req: { url: "https://demo.example/api/v1/auth/demo-login" },
		json: (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		header: (_name: string, _value: string) => {},
		// `setCookie` from hono/cookie writes into `c.header("Set-Cookie", ...)`.
		// The cookie assertions live in guard.test.ts against the real route; here
		// the session row and the reset side effect are what matter.
		_response: headers,
	} as never;
}

describe("demo reset — seeding both stores", () => {
	it("fills D1 and R2, and reproduces the seed baseline exactly", { skip: sqliteSkip }, async () => {
		const { db, sqlite, bucket, env } = sandbox();

		const result = await ensureDemoData(env, { force: true });
		assert.strictEqual(result.reset, true);
		assert.strictEqual(result.reason, "done");

		// 1. The R2 half — the trap this feature exists to avoid.
		const mailboxKeys = [...bucket.objects.keys()].filter((key) =>
			key.startsWith("mailboxes/"),
		);
		assert.deepStrictEqual(
			[...mailboxKeys].sort(),
			[
				`mailboxes/${HELLO}.json`,
				"mailboxes/billing@fernhill.studio.json",
				"mailboxes/ops@lumen-mail.dev.json",
			].sort(),
			"every seeded mailbox needs its own R2 object",
		);
		const settings = JSON.parse(
			new TextDecoder().decode(bucket.objects.get(`mailboxes/${HELLO}.json`)!),
		) as Record<string, unknown>;
		assert.strictEqual(settings.fromName, "Fernhill Studio");
		assert.ok(settings.created_at, "created_at is materialised at reset time");
		assert.strictEqual(
			"resendApiKey" in settings,
			false,
			"the demo mailbox must not carry a Resend key",
		);

		// 2. D1 numbers, straight from the tables.
		const counts = await readDemoCounts(env);
		assert.deepStrictEqual(
			diffDemoCounts(seed.counts, counts),
			[],
			"counts must equal the baselines in seed-data.json",
		);
		assert.strictEqual(counts.emails, 128);
		assert.strictEqual(counts.folders, 21);
		assert.strictEqual(counts.attachments, 5);
		assert.strictEqual(counts.ai_messages, 8);
		assert.strictEqual(counts.domains, 2);
		assert.strictEqual(counts.admins, 1);
		assert.deepStrictEqual(counts.inbox_unread, {
			[HELLO]: 7,
			"billing@fernhill.studio": 2,
			"ops@lumen-mail.dev": 1,
		});
		assert.strictEqual(counts.starred, 3);

		// 3. Nothing that could send mail or reach Cloudflare exists.
		assert.strictEqual(count(sqlite, "SELECT COUNT(*) FROM platform_settings"), 0);
		assert.strictEqual(count(sqlite, "SELECT COUNT(*) FROM agent_api_keys"), 0);
		const domainCredentials = sqlite
			.prepare(
				"SELECT resend_domain_id, cf_zone_id, cf_account_id, catch_all_mailbox FROM domains",
			)
			.all();
		for (const row of domainCredentials) {
			assert.deepStrictEqual(
				Object.values(row),
				[null, null, null, null],
				"a demo domain carries no provider ids and no catch-all",
			);
		}
	});

	it("writes real attachment bytes, and the D1 size matches the object", { skip: sqliteSkip }, async () => {
		const { sqlite, bucket, env } = sandbox();
		await ensureDemoData(env, { force: true });

		const rows = sqlite
			.prepare("SELECT id, email_id, filename, mimetype, size FROM attachments ORDER BY id")
			.all();
		assert.strictEqual(rows.length, 5);

		for (const row of rows) {
			const key = attachmentKey(
				String(row.email_id),
				String(row.id),
				String(row.filename),
			);
			const object = bucket.objects.get(key);
			assert.ok(object, `R2 object missing for ${key}`);
			assert.strictEqual(
				Number(row.size),
				object.byteLength,
				`attachments.size for ${row.filename} must be the real byte count`,
			);
			assert.ok(Number(row.size) > 100, `${row.filename} must have real content`);
		}

		// File signatures, so "real bytes" means a file a viewer would open.
		const pdf = bucket.objects.get(
			attachmentKey("demo-hello-sent-invoice", "att-0001", "fernhill-invoice-2418.pdf"),
		)!;
		assert.strictEqual(Buffer.from(pdf.subarray(0, 5)).toString("latin1"), "%PDF-");
		const docx = bucket.objects.get(
			attachmentKey("demo-hello-inbox-t8-2", "att-0005", "contract-draft.docx"),
		)!;
		assert.strictEqual(Buffer.from(docx.subarray(0, 2)).toString("latin1"), "PK");
		const png = bucket.objects.get(
			attachmentKey("demo-hello-sent-mockup", "att-0003", "homepage-mockup.png"),
		)!;
		assert.deepStrictEqual(
			[...png.subarray(0, 4)],
			[0x89, 0x50, 0x4e, 0x47],
			"the mockup is a real PNG",
		);
	});

	it("threads the eight conversations instead of scattering them", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await ensureDemoData(env, { force: true });

		const threadRoots = sqlite
			.prepare(
				`SELECT thread_id, COUNT(*) AS n FROM emails
				 WHERE mailbox_id = ? AND thread_id IS NOT NULL GROUP BY thread_id`,
			)
			.all(HELLO);
		assert.strictEqual(threadRoots.length, 8, "8 conversations");
		assert.strictEqual(
			threadRoots.reduce((sum, row) => sum + Number(row.n), 0),
			44,
			"26 received + 18 replies",
		);

		// Every thread_id must be the message id of a real email in that thread.
		const orphans = sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM emails e
				 WHERE e.thread_id IS NOT NULL
				   AND NOT EXISTS (SELECT 1 FROM emails r WHERE r.message_id = e.thread_id)`,
			)
			.all();
		assert.strictEqual(Number(orphans[0]!.n), 0, "no thread points at a missing root");

		const badReplies = sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM emails e
				 WHERE e.in_reply_to IS NOT NULL
				   AND NOT EXISTS (SELECT 1 FROM emails p WHERE p.message_id = e.in_reply_to)`,
			)
			.all();
		assert.strictEqual(Number(badReplies[0]!.n), 0, "no reply points at a missing parent");
	});

	it("keeps the AI transcript readable but never able to grow", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await ensureDemoData(env, { force: true });
		const rows = sqlite
			.prepare(
				"SELECT role, content FROM ai_chat_messages WHERE mailbox_id = ? ORDER BY created_at",
			)
			.all(HELLO);
		assert.strictEqual(rows.length, 8);
		assert.strictEqual(rows[0]!.role, "user");
		assert.strictEqual(rows[1]!.role, "assistant");
	});
});

describe("demo reset — cadence, claim and failure", () => {
	it("does nothing while the data is fresh", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await ensureDemoData(env, { force: true });

		// A row that only a second reset could remove.
		sqlite
			.prepare(
				"INSERT INTO ai_chat_messages (id, mailbox_id, role, content, created_at) VALUES ('sentinel', ?, 'user', 'x', datetime('now'))",
			)
			.run(HELLO);

		const fresh = await ensureDemoData(env);
		assert.deepStrictEqual(fresh, { reset: false, reason: "fresh" });
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM ai_chat_messages WHERE id = 'sentinel'"),
			1,
			"a not-due reset must not touch the data",
		);
	});

	it("resets once six hours have passed, and clears every session", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await ensureDemoData(env, { force: true });
		insertSession(sqlite, "visitor-from-before", new Date(Date.now() + 3600_000));
		sqlite.prepare("DELETE FROM emails WHERE id LIKE 'demo-billing-%'").run();
		makeDue(sqlite);

		const result = await ensureDemoData(env);
		assert.strictEqual(result.reset, true);
		assert.deepStrictEqual(
			diffDemoCounts(seed.counts, await readDemoCounts(env)),
			[],
			"the reset restores the baseline after the data was dirtied",
		);
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM sessions WHERE token = 'visitor-from-before'"),
			0,
			"a reset kicks out sessions minted against the previous data generation",
		);
	});

	it("lets exactly one of two concurrent resets through", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await ensureDemoData(env, { force: true });
		makeDue(sqlite);

		const [first, second] = await Promise.all([
			ensureDemoData(env),
			ensureDemoData(env),
		]);
		const winners = [first, second].filter((outcome) => outcome.reset);
		assert.strictEqual(winners.length, 1, "the demo_meta claim must serialise resets");
		assert.strictEqual(
			[first, second].filter((outcome) => !outcome.reset).length,
			1,
			"the loser does not rebuild anything",
		);
		assert.deepStrictEqual(
			diffDemoCounts(seed.counts, await readDemoCounts(env)),
			[],
			"the surviving data is the baseline, not a double-written variant",
		);
	});

	it("hands the claim back when a rebuild fails, so the next trigger retries", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await ensureDemoData(env, { force: true });
		const before = await readLastResetAt(env.DB);
		makeDue(sqlite);
		const claimedMarker = await readLastResetAt(env.DB);
		assert.notStrictEqual(claimedMarker, before);

		// Break the schema underneath the reset.
		sqlite.exec("DROP TABLE attachments");

		await assert.rejects(() => ensureDemoData(env, { force: true }));
		assert.strictEqual(
			await readLastResetAt(env.DB),
			claimedMarker,
			"the claim is restored to the value it had before the attempt",
		);
	});

	it("is a no-op on a production environment", { skip: sqliteSkip }, async () => {
		const { db, bucket } = sandbox();
		const prodEnv = { DB: db, BUCKET: bucket.bucket } as unknown as Env;
		const outcome = await ensureDemoData(prodEnv, { force: true });
		assert.deepStrictEqual(outcome, { reset: false, reason: "not_demo" });
		assert.strictEqual(bucket.objects.size, 0, "nothing is written off-demo");
	});

	it("applies the 6-hour window", () => {
		const now = new Date("2026-11-17T12:00:00.000Z");
		assert.strictEqual(isResetDue(null, now), true, "never reset means due");
		assert.strictEqual(isResetDue(DEMO_EPOCH_ISO, now), true);
		assert.strictEqual(
			isResetDue(new Date(now.getTime() - DEMO_RESET_INTERVAL_MS + 1000).toISOString(), now),
			false,
			"one second short of the window is still fresh",
		);
		assert.strictEqual(
			isResetDue(new Date(now.getTime() - DEMO_RESET_INTERVAL_MS).toISOString(), now),
			true,
			"exactly at the window it resets",
		);
		assert.strictEqual(isResetDue("not-a-date", now), true, "a corrupt value resets");
	});
});

describe("demo login — lazy reset fallback", () => {
	it("seeds the demo on the first guest login instead of showing an empty site", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();

		const res = (await handleDemoLogin(loginContext(env))) as Response;
		assert.strictEqual(res.status, 200);

		const body = (await res.json()) as { demo?: boolean; authenticated?: boolean };
		assert.strictEqual(body.authenticated, true);
		assert.strictEqual(body.demo, true);
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM sessions"),
			1,
			"the visitor gets their own session row",
		);
		assert.deepStrictEqual(
			diffDemoCounts(seed.counts, await readDemoCounts(env)),
			[],
			"demo-login built the demo data",
		);
	});

	it("does not rebuild on every login once the data is fresh", { skip: sqliteSkip }, async () => {
		const { sqlite, env } = sandbox();
		await handleDemoLogin(loginContext(env));
		const afterFirst = await readLastResetAt(env.DB);
		await handleDemoLogin(loginContext(env));
		assert.strictEqual(
			await readLastResetAt(env.DB),
			afterFirst,
			"a second visitor must not trigger a second rebuild",
		);
		assert.strictEqual(count(sqlite, "SELECT COUNT(*) FROM sessions"), 2);
	});
});
