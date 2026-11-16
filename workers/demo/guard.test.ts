// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * The read-only guard, driven through the REAL app.
 *
 * These cases exist because "the demo is read-only" is the only claim that
 * matters about this feature, and it is a claim about HTTP responses — not
 * about a helper function. So `workers/index.ts` is imported as-is (real
 * routes, real middleware order) and every request goes through
 * `app.request(path, init, env)` with only the bindings swapped.
 *
 * Three things are pinned:
 *
 *   1. DEMO_MODE=1 blocks every write surface in docs/demo-site-plan.md §2.2 —
 *      and blocks the surfaces that do not exist yet, because the policy is
 *      "deny by method", not a route list (the last case in the matrix is a
 *      made-up route).
 *   2. DEMO_MODE unset changes nothing: the same requests reach the same
 *      handlers they always did. The positive control is a real write
 *      (`PUT /api/v1/platform-settings/...`) that lands a row in D1 — it is
 *      refused with 403 in demo mode and succeeds in production, from the same
 *      test, so neither half can pass by accident.
 *   3. Guest sign-in works and cannot be replayed as an admin login: 1-hour
 *      session, and the seeded admin's password is unknowable.
 *
 * To run: npm test
 */
import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
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
import { DEMO_NOINDEX, DEMO_READ_ONLY_CODE, DEMO_READ_ONLY_ERROR } from "./guard";
import {
	DEMO_LOGIN_MAX_ATTEMPTS,
	DEMO_LOGIN_WINDOW_MS,
	DEMO_RATE_LIMIT_CODE,
	demoLoginBucket,
} from "./login";
import { ensureDemoData } from "./reset";

/** `app.request()` needs the real module; a bare `./index` breaks under `node --test`. */
const INDEX_MODULE_URL = pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href;

const { app } = (await import(/* @vite-ignore */ INDEX_MODULE_URL)) as {
	app: {
		request(path: string, init?: RequestInit, env?: unknown): Promise<Response>;
		fetch(
			request: Request,
			env?: unknown,
			executionCtx?: unknown,
		): Promise<Response>;
	};
};

const SESSION_COOKIE = "mailboxes_session";
const DEMO_MAILBOX = "hello@fernhill.studio";
const MAILBOX_PATH = encodeURIComponent(DEMO_MAILBOX);

/**
 * Every write surface from §2.2 of the plan, plus the agent gateway, the
 * credential endpoints and one route that does not exist at all.
 */
const BLOCKED_ROUTES: Array<{ method: string; path: string; why: string }> = [
	{ method: "POST", path: "/api/v1/mailboxes", why: "create a mailbox" },
	{ method: "PUT", path: `/api/v1/mailboxes/${MAILBOX_PATH}`, why: "edit mailbox settings" },
	{ method: "DELETE", path: `/api/v1/mailboxes/${MAILBOX_PATH}`, why: "delete a mailbox" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails`, why: "send email" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/drafts`, why: "write a draft" },
	{ method: "DELETE", path: `/api/v1/mailboxes/${MAILBOX_PATH}/drafts/e1`, why: "delete a draft" },
	{ method: "PUT", path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails/e1`, why: "change read/starred" },
	{ method: "DELETE", path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails/e1`, why: "delete an email" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails/e1/move`, why: "move an email" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails/e1/reply`, why: "reply" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails/e1/forward`, why: "forward" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/threads/t1/read`, why: "mark a thread read" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/folders`, why: "create a folder" },
	{ method: "PUT", path: `/api/v1/mailboxes/${MAILBOX_PATH}/folders/receipts`, why: "rename a folder" },
	{ method: "DELETE", path: `/api/v1/mailboxes/${MAILBOX_PATH}/folders/receipts`, why: "delete a folder" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/ai/chat`, why: "spend Workers AI Neurons" },
	{ method: "DELETE", path: `/api/v1/mailboxes/${MAILBOX_PATH}/ai/chat`, why: "wipe AI history" },
	{ method: "POST", path: `/api/v1/mailboxes/${MAILBOX_PATH}/verify-resend`, why: "call Resend" },
	{ method: "POST", path: "/api/v1/domains/d1/verify-resend", why: "call Resend" },
	{ method: "POST", path: "/api/v1/domains/d1/setup-resend-sending", why: "call Resend" },
	{ method: "POST", path: "/api/v1/domains", why: "add a domain" },
	{ method: "DELETE", path: "/api/v1/domains/d1", why: "delete a domain" },
	{ method: "PUT", path: "/api/v1/domains/d1/catch-all", why: "change catch-all" },
	{ method: "PUT", path: "/api/v1/domains/d1/api-key", why: "write a Resend key" },
	{ method: "PUT", path: "/api/v1/platform-settings/cf_api_token", why: "write a credential" },
	{ method: "POST", path: "/api/v1/agent-api-keys", why: "mint an external key" },
	{ method: "POST", path: "/api/v1/inbound/resend", why: "Resend inbound webhook" },
	{ method: "POST", path: "/api/v1/setup/admin", why: "register an admin" },
	{ method: "POST", path: "/api/v1/setup/verify-domain", why: "call Cloudflare" },
	{ method: "POST", path: "/mcp", why: "agent gateway" },
	{ method: "POST", path: "/tools/call", why: "agent gateway tool call" },
	// Blacklisted for reads too — GETs that leak a credential or call out.
	{ method: "GET", path: "/mcp", why: "agent gateway (read)" },
	{ method: "GET", path: "/tools", why: "agent gateway manifest" },
	{ method: "GET", path: "/api/v1/platform-settings/cf_api_token", why: "reads a credential back" },
	{ method: "GET", path: "/api/v1/setup/admin/status", why: "setup surface" },
	{ method: "GET", path: "/api/v1/setup/status", why: "setup surface" },
	// Never written by anyone — proof that the policy is the method, not a list.
	{ method: "POST", path: "/api/v1/mailboxes/x/route-invented-next-year", why: "unknown write route" },
	{ method: "PATCH", path: "/api/v1/mailboxes", why: "method nobody whitelisted" },
];

/** Reads the demo must keep serving (the whole point of the site). */
const READABLE_ROUTES: Array<{ path: string; why: string }> = [
	{ path: "/api/v1/config", why: "domains + addresses for the shell" },
	{ path: "/api/v1/auth/me", why: "session probe" },
	{ path: "/api/v1/mailboxes", why: "mailbox list" },
	{ path: `/api/v1/mailboxes/${MAILBOX_PATH}`, why: "mailbox settings" },
	{ path: `/api/v1/mailboxes/${MAILBOX_PATH}/folders`, why: "sidebar folders" },
	{ path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails?folder=inbox&limit=5`, why: "inbox list" },
	{ path: `/api/v1/mailboxes/${MAILBOX_PATH}/emails?folder=inbox&threaded=true&limit=5`, why: "threaded inbox" },
	{ path: `/api/v1/mailboxes/${MAILBOX_PATH}/search?query=invoice`, why: "search" },
	{ path: `/api/v1/mailboxes/${MAILBOX_PATH}/ai/chat`, why: "seeded AI transcript (read only)" },
];

type Harness = {
	db: D1Database;
	sqlite: Sqlite;
	bucket: FakeBucket;
	demoEnv: Env;
	prodEnv: Env;
};

async function setup(): Promise<Harness> {
	const { db, sqlite } = createDb();
	const bucket = createBucket();
	const prodEnv = { DB: db, BUCKET: bucket.bucket } as unknown as Env;
	const demoEnv = { DB: db, BUCKET: bucket.bucket, DEMO_MODE: "1" } as unknown as Env;
	// Fill the demo exactly as the Cron would, so the read matrix has data.
	await ensureDemoData(demoEnv, { force: true });
	return { db, sqlite, bucket, demoEnv, prodEnv };
}

/** POST /api/v1/auth/demo-login and return the session cookie to send back. */
async function guestCookie(env: Env): Promise<string> {
	const res = await request(env, "POST", "/api/v1/auth/demo-login", undefined, null);
	assert.strictEqual(res.status, 200, "demo-login must succeed");
	const cookie = res.headers.get("set-cookie");
	assert.ok(cookie, "demo-login must set a cookie");
	return cookie.slice(0, cookie.indexOf(";"));
}

/** Hono needs an ExecutionContext for routes that call `c.executionCtx`. */
const stubExecutionCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(
	env: Env,
	method: string,
	path: string,
	cookie?: string,
	body: string | null = method === "GET" || method === "DELETE" ? null : "{}",
	extraHeaders: Record<string, string> = {},
) {
	// `app.fetch` (not `app.request`) so the ExecutionContext can be supplied:
	// the inbound-webhook route reads `c.executionCtx`, which a bare
	// `app.request()` has no way to provide.
	return app.fetch(
		new Request(`https://demo.test${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				...(cookie ? { Cookie: cookie } : {}),
				...extraHeaders,
			},
			...(body === null ? {} : { body }),
		}),
		env,
		stubExecutionCtx,
	);
}

/**
 * `POST /api/v1/auth/demo-login` as a specific client.
 *
 * `cf-connecting-ip` is what Cloudflare puts on every real request; a test that
 * wants two visitors has to say so explicitly, otherwise both land in the
 * no-address fallback bucket.
 */
function demoLogin(env: Env, client: { ip?: string; ua?: string } = {}) {
	return request(env, "POST", "/api/v1/auth/demo-login", undefined, "{}", {
		...(client.ip ? { "CF-Connecting-IP": client.ip } : {}),
		...(client.ua ? { "User-Agent": client.ua } : {}),
	});
}

describe("demo read-only guard — DEMO_MODE=1", () => {
	it("refuses every write surface with 403 + demo_read_only", { skip: sqliteSkip }, async () => {
		const { demoEnv } = await setup();
		const cookie = await guestCookie(demoEnv);

		for (const route of BLOCKED_ROUTES) {
			const res = await request(demoEnv, route.method, route.path, cookie);
			const body = (await res.json().catch(() => ({}))) as {
				code?: string;
				error?: string;
			};
			assert.strictEqual(
				res.status,
				403,
				`${route.method} ${route.path} (${route.why}) must be 403, got ${res.status}`,
			);
			assert.strictEqual(
				body.code,
				DEMO_READ_ONLY_CODE,
				`${route.method} ${route.path} must carry code=demo_read_only`,
			);
			assert.strictEqual(body.error, DEMO_READ_ONLY_ERROR);
		}
	});

	it("blocks writes even without a session — the refusal is not an auth artefact", { skip: sqliteSkip }, async () => {
		const { demoEnv } = await setup();
		// No cookie at all: a 401 here would mean the guard let the request
		// through to requireAuth, i.e. the write reached the auth layer.
		const res = await request(demoEnv, "POST", `/api/v1/mailboxes/${MAILBOX_PATH}/emails`);
		assert.strictEqual(res.status, 403);
		assert.strictEqual(
			((await res.json()) as { code?: string }).code,
			DEMO_READ_ONLY_CODE,
		);
	});

	it("keeps every read endpoint working, with real seeded data", { skip: sqliteSkip }, async () => {
		const { demoEnv } = await setup();
		const cookie = await guestCookie(demoEnv);

		for (const route of READABLE_ROUTES) {
			const res = await request(demoEnv, "GET", route.path, cookie);
			assert.strictEqual(
				res.status,
				200,
				`GET ${route.path} (${route.why}) must stay readable, got ${res.status}`,
			);
		}

		// The list endpoint has to return the seeded mailboxes, not just 200.
		const mailboxes = (await (
			await request(demoEnv, "GET", "/api/v1/mailboxes", cookie)
		).json()) as Array<{ id: string; unread_count: number }>;
		assert.strictEqual(mailboxes.length, 3, "the demo exposes 3 mailboxes");
		assert.deepStrictEqual(
			mailboxes.map((m) => m.id).sort(),
			["billing@fernhill.studio", "hello@fernhill.studio", "ops@lumen-mail.dev"],
		);

		const inbox = (await (
			await request(
				demoEnv,
				"GET",
				`/api/v1/mailboxes/${MAILBOX_PATH}/emails?folder=inbox&limit=5`,
				cookie,
			)
		).json()) as { emails: unknown[]; totalCount: number };
		assert.strictEqual(inbox.totalCount, 52, "hello@ has 52 inbox emails");
		assert.strictEqual(inbox.emails.length, 5, "the page size is honoured");

		const folders = (await (
			await request(demoEnv, "GET", `/api/v1/mailboxes/${MAILBOX_PATH}/folders`, cookie)
		).json()) as Array<{ id: string; unreadCount: number }>;
		assert.strictEqual(folders.length, 7, "6 system folders + 1 custom");
		const inboxFolder = folders.find((folder) => folder.id === "inbox");
		assert.strictEqual(inboxFolder?.unreadCount, 7, "7 unread in hello@'s inbox");
	});

	it("answers noindex on every response, blocked or not", { skip: sqliteSkip }, async () => {
		const { demoEnv } = await setup();
		const blocked = await request(demoEnv, "POST", "/api/v1/mailboxes");
		assert.strictEqual(blocked.headers.get("x-robots-tag"), DEMO_NOINDEX);
		const readable = await request(demoEnv, "GET", "/api/v1/config");
		assert.strictEqual(readable.headers.get("x-robots-tag"), DEMO_NOINDEX);
	});

	it("flags itself as a demo in GET /api/v1/config only when DEMO_MODE=1", { skip: sqliteSkip }, async () => {
		const { demoEnv, prodEnv, sqlite } = await setup();
		const cookie = await guestCookie(demoEnv);
		insertSession(sqlite, "prod-session", new Date(Date.now() + 3600_000));

		const demo = (await (
			await request(demoEnv, "GET", "/api/v1/config", cookie)
		).json()) as { demo?: boolean };
		assert.strictEqual(demo.demo, true);

		const prod = (await (
			await request(prodEnv, "GET", "/api/v1/config", "mailboxes_session=prod-session")
		).json()) as Record<string, unknown>;
		assert.deepStrictEqual(
			Object.keys(prod).sort(),
			["domains", "emailAddresses"],
			"production must not grow a `demo` key",
		);
	});
});

describe("production is unchanged when DEMO_MODE is unset", () => {
	it("never answers 403 demo_read_only — every write reaches its original handler", { skip: sqliteSkip }, async () => {
		const { prodEnv, sqlite } = await setup();
		insertSession(sqlite, "prod-session", new Date(Date.now() + 3600_000));

		for (const route of BLOCKED_ROUTES) {
			const res = await request(prodEnv, route.method, route.path, "mailboxes_session=prod-session");
			const body = (await res.json().catch(() => ({}))) as { code?: string };
			assert.notStrictEqual(
				res.status,
				403,
				`${route.method} ${route.path} must not be guard-blocked in production`,
			);
			assert.notStrictEqual(
				body.code,
				DEMO_READ_ONLY_CODE,
				`${route.method} ${route.path} must not carry code=demo_read_only in production`,
			);
		}
	});

	it("still answers the same 401 challenge it always did", { skip: sqliteSkip }, async () => {
		const { prodEnv } = await setup();
		const res = await request(prodEnv, "POST", "/api/v1/mailboxes");
		assert.strictEqual(res.status, 401, "unauthenticated write is a 401 in production");
		assert.strictEqual(
			res.headers.get("www-authenticate"),
			'Session realm="mailboxes"',
			"the 401 challenge is untouched",
		);
		assert.strictEqual(res.headers.get("x-robots-tag"), null, "no demo header leaks into production");
	});

	it("lets a real write through in production, and the same write is refused in demo", { skip: sqliteSkip }, async () => {
		const { prodEnv, demoEnv, sqlite } = await setup();
		insertSession(sqlite, "prod-session", new Date(Date.now() + 3600_000));
		const cookie = await guestCookie(demoEnv);

		// Production: the write really lands in D1.
		const prodRes = await request(
			prodEnv,
			"PUT",
			"/api/v1/platform-settings/positive-control",
			"mailboxes_session=prod-session",
			JSON.stringify({ value: "written-by-a-real-request" }),
		);
		assert.strictEqual(prodRes.status, 200, "the platform-settings write must succeed in production");
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM platform_settings"),
			1,
			"the production write is persisted",
		);

		// Demo: the identical request is refused and writes nothing.
		const demoRes = await request(
			demoEnv,
			"PUT",
			"/api/v1/platform-settings/positive-control",
			cookie,
			JSON.stringify({ value: "written-by-a-real-request" }),
		);
		assert.strictEqual(demoRes.status, 403);
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM platform_settings"),
			1,
			"the demo refusal left the table untouched",
		);
	});
});

describe("demo guest sign-in", () => {
	it("issues a 1-hour HttpOnly session per visitor", { skip: sqliteSkip }, async () => {
		const { demoEnv, sqlite } = await setup();

		const res = await app.request("/api/v1/auth/demo-login", { method: "POST" }, demoEnv);
		assert.strictEqual(res.status, 200);
		const body = (await res.json()) as { authenticated?: boolean; demo?: boolean; username?: string };
		assert.strictEqual(body.authenticated, true);
		assert.strictEqual(body.demo, true);

		const cookie = res.headers.get("set-cookie") ?? "";
		assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
		assert.match(cookie, /HttpOnly/i);
		assert.match(cookie, /SameSite=Lax/i);
		assert.match(cookie, /Max-Age=3600/i, "the demo session lives one hour");

		// A second visitor gets a different token — sessions are per visitor.
		const second = await app.request("/api/v1/auth/demo-login", { method: "POST" }, demoEnv);
		const secondCookie = second.headers.get("set-cookie") ?? "";
		assert.notStrictEqual(
			cookie.slice(0, cookie.indexOf(";")),
			secondCookie.slice(0, secondCookie.indexOf(";")),
			"two visitors must not share a session",
		);
		const sessions = count(sqlite, "SELECT COUNT(*) FROM sessions");
		assert.ok(sessions >= 2, "each demo-login writes its own session row");
	});

	it("does not exist on a production deployment", { skip: sqliteSkip }, async () => {
		const { prodEnv } = await setup();
		const res = await app.request("/api/v1/auth/demo-login", { method: "POST" }, prodEnv);
		assert.strictEqual(res.status, 404);
	});

	it("leaves the password login dead: the seeded admin hash has no known plaintext", { skip: sqliteSkip }, async () => {
		const { demoEnv } = await setup();
		for (const body of [
			JSON.stringify({ username: "demo", password: "demo" }),
			JSON.stringify({ username: "admin", password: "admin" }),
			JSON.stringify({ username: "demo", password: "password" }),
		]) {
			const res = await app.request(
				"/api/v1/auth/login",
				{ method: "POST", headers: { "Content-Type": "application/json" }, body },
				demoEnv,
			);
			assert.strictEqual(res.status, 401, `login ${body} must fail on the demo`);
		}
	});
});

/**
 * The guest sign-in is the demo's only writable surface, and before the limiter
 * existed a script could mint sessions as fast as it could send requests. These
 * cases pin the four things that make a limiter a limiter: it refuses, it lets
 * go, it is absent off-demo, and it has a coherent answer when the client
 * address is missing.
 */
describe("demo guest sign-in is rate-limited per IP", () => {
	const IP = "203.0.113.7";

	it("allows 10 in one window, then refuses with 429 + Retry-After and mints no session", { skip: sqliteSkip }, async () => {
		const { demoEnv, sqlite } = await setup();

		for (let attempt = 1; attempt <= DEMO_LOGIN_MAX_ATTEMPTS; attempt += 1) {
			const res = await demoLogin(demoEnv, { ip: IP });
			assert.strictEqual(res.status, 200, `attempt ${attempt} must be allowed`);
		}
		const sessionsBefore = count(sqlite, "SELECT COUNT(*) FROM sessions");
		assert.strictEqual(sessionsBefore, DEMO_LOGIN_MAX_ATTEMPTS, "one session per allowed attempt");

		const blocked = await demoLogin(demoEnv, { ip: IP });
		const body = (await blocked.json()) as { code?: string; error?: string };
		assert.strictEqual(blocked.status, 429, "the 11th attempt in the window is refused");
		assert.strictEqual(body.code, DEMO_RATE_LIMIT_CODE, "the refusal carries a stable code");
		assert.ok(body.error, "and a human-readable message");

		const retryAfter = Number(blocked.headers.get("retry-after"));
		assert.ok(Number.isInteger(retryAfter), "Retry-After is an integer number of seconds");
		assert.ok(retryAfter > 0, `Retry-After must point forwards, got ${retryAfter}`);
		assert.ok(
			retryAfter <= DEMO_LOGIN_WINDOW_MS / 1000,
			`Retry-After cannot exceed the window, got ${retryAfter}`,
		);
		assert.strictEqual(blocked.headers.get("x-robots-tag"), DEMO_NOINDEX, "a refusal is still noindex");

		// A refused attempt must not have written anything.
		assert.strictEqual(blocked.headers.get("set-cookie"), null, "no cookie on a refusal");
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM sessions"),
			sessionsBefore,
			"a refused attempt mints no session",
		);

		// Still refused on the next try — the window does not reset because the
		// client tried again.
		assert.strictEqual((await demoLogin(demoEnv, { ip: IP })).status, 429);

		// ...and the bucket is per address, not global.
		assert.strictEqual(
			(await demoLogin(demoEnv, { ip: "198.51.100.9" })).status,
			200,
			"a second visitor is not affected by the first visitor's bucket",
		);

		// Reads keep working for everybody, refused or not.
		const cookie = await guestCookie(demoEnv);
		assert.strictEqual(
			(await request(demoEnv, "GET", "/api/v1/mailboxes", cookie)).status,
			200,
			"the limiter is scoped to sign-in, not to the app",
		);
	});

	it("lets the same address back in once the window rolls over", { skip: sqliteSkip }, async () => {
		const { demoEnv } = await setup();
		const base = Date.now();
		// Only `Date` is mocked: the limiter's clock is `Date.now()`, and mocking
		// it is the only honest way to watch a 10-minute window expire in a test
		// that has to finish in milliseconds.
		mock.timers.enable({ apis: ["Date"], now: base });
		try {
			for (let attempt = 1; attempt <= DEMO_LOGIN_MAX_ATTEMPTS; attempt += 1) {
				assert.strictEqual((await demoLogin(demoEnv, { ip: IP })).status, 200);
			}
			assert.strictEqual((await demoLogin(demoEnv, { ip: IP })).status, 429);

			// One millisecond into the next window is enough.
			mock.timers.tick(DEMO_LOGIN_WINDOW_MS + 1);

			const recovered = await demoLogin(demoEnv, { ip: IP });
			assert.strictEqual(recovered.status, 200, "the next window starts with a fresh allowance");
			assert.ok(recovered.headers.get("set-cookie"), "and issues a real session again");
		} finally {
			mock.timers.reset();
		}
	});

	it("does not limit anything when DEMO_MODE is unset — and writes no counter rows", { skip: sqliteSkip }, async () => {
		const { prodEnv, sqlite } = await setup();
		// Production has no such endpoint at all, which is the strongest form of
		// "not limited": 40 calls change nothing. The positive assertion is the
		// table staying empty — a limiter that writes off-demo would be a
		// production side effect even if it never refused anyone.
		for (let attempt = 1; attempt <= 40; attempt += 1) {
			const res = await demoLogin(prodEnv, { ip: IP });
			assert.strictEqual(res.status, 404, `call ${attempt} must be a plain 404 in production`);
			assert.notStrictEqual(res.status, 429);
		}
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM demo_login_rate_limit"),
			0,
			"the limiter never runs (and never writes) outside demo mode",
		);
	});

	it("without a client IP it still limits, on a per-user-agent bucket instead of one shared one", { skip: sqliteSkip }, async () => {
		const { demoEnv, sqlite } = await setup();
		const curl = { ua: "curl-demo-script/1.0" };

		// Not a free pass: attempts still count.
		for (let attempt = 1; attempt <= DEMO_LOGIN_MAX_ATTEMPTS; attempt += 1) {
			assert.strictEqual((await demoLogin(demoEnv, curl)).status, 200, `attempt ${attempt}`);
		}
		assert.strictEqual((await demoLogin(demoEnv, curl)).status, 429, "a missing IP is not an exemption");

		// Not one bucket for the whole internet either: other clients go through.
		assert.strictEqual(
			(await demoLogin(demoEnv, { ua: "Mozilla/5.0 (Macintosh) Firefox/128.0" })).status,
			200,
			"another client is not locked out by this one's fallback bucket",
		);
		assert.strictEqual(
			count(sqlite, "SELECT COUNT(*) FROM demo_login_rate_limit"),
			2,
			"two clients, two buckets — nothing is shared",
		);

		// The bucketing itself: address wins, user-agent is the fallback, and the
		// same client always lands in the same bucket.
		assert.strictEqual(
			await demoLoginBucket(new Headers({ "CF-Connecting-IP": IP })),
			`ip:${IP}`,
		);
		assert.strictEqual(
			await demoLoginBucket(new Headers({ "X-Forwarded-For": `${IP}, 10.0.0.1` })),
			`ip:${IP}`,
			"a local proxy's header is the second chance",
		);
		const first = await demoLoginBucket(new Headers({ "User-Agent": "curl-demo-script/1.0" }));
		const again = await demoLoginBucket(new Headers({ "User-Agent": "curl-demo-script/1.0" }));
		const different = await demoLoginBucket(new Headers({ "User-Agent": "curl-demo-script/1.1" }));
		assert.match(first, /^ua:[0-9a-f]{16}$/, "the fallback names the user agent, not the request");
		assert.strictEqual(first, again, "the same client keeps the same bucket");
		assert.notStrictEqual(first, different, "different clients do not collide by default");
	});
});
