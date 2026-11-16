// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Read-only guard for the public demo instance.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * The demo runs the SAME code as production (see wrangler.demo.jsonc), so the
 * only thing standing between a public visitor and a working mail client is
 * this middleware. It is mounted as `app.use("*", demoGuard)` in
 * ../index.ts — ahead of every route, including the agent gateway at
 * `/mcp` and `/tools` (which is why it is not mounted on `/api/*` alone: two
 * of the blacklisted paths are not under `/api`).
 *
 * ── Policy: deny by default, decided on the METHOD ─────────────────────────
 * Whitelist-by-method, not blacklist-by-route:
 *
 *   GET / HEAD / OPTIONS   → allowed (it is a read)
 *   POST                   → only the three auth endpoints below
 *   anything else          → 403 { code: "demo_read_only" }
 *
 * This is deliberate. A route list has to be updated for every new write route
 * and a forgotten row is a silent hole nobody notices; inverting the default
 * means `POST /api/v1/mailboxes/:id/tags` added next year is blocked without
 * anyone remembering to add it here.
 *
 * ── The blacklist: GETs that must not be public either ─────────────────────
 * A handful of paths issue an outbound request or hand back a stored
 * credential, so they are refused for every method:
 *
 *   /api/v1/setup/            talks to Cloudflare + Resend with DB-stored tokens
 *   /api/v1/platform-settings reads back `cf_api_token` in plaintext
 *   /api/v1/inbound/          Resend's inbound webhook
 *   /api/v1/agent-api-keys    key management for the external gateway
 *   /mcp, /tools              agent gateway (13 tools, incl. send_email)
 *
 * A side effect worth keeping: `POST /api/v1/setup/admin` answering 403 (not
 * 409) means a probe cannot even learn whether this instance has an admin yet.
 *
 * ── Production is untouched ────────────────────────────────────────────────
 * The first statement returns `next()` unless `env.DEMO_MODE === "1"`. The
 * production Worker has no such binding (wrangler.jsonc deliberately carries no
 * `vars`), so every request takes that branch: no header is written, no path is
 * inspected, and the 401 challenge / CORS / i18n middleware order is exactly
 * what it was. workers/demo/guard.test.ts asserts that from both directions.
 */
import { createMiddleware } from "hono/factory";
import type { D1MailboxContext } from "../lib/d1-middleware";
import type { Env } from "../types";

/** Body copy + code for every refusal. Clients key off `code`. */
export const DEMO_READ_ONLY_ERROR = "This demo is read-only.";
export const DEMO_READ_ONLY_CODE = "demo_read_only";

/** Never let a search engine index the demo, and never let it be framed. */
export const DEMO_NOINDEX = "noindex, nofollow";

/**
 * Paths refused for EVERY method, GET included.
 *
 * Matching is "exact or prefix": `/api/v1/setup/` must also catch
 * `/api/v1/setup/verify-domain/abc`, and `/tools` must catch `/tools/call`.
 * Prefix matching is intentionally greedy — a false refusal on an unknown
 * sub-path of a blacklisted surface is the safe direction.
 */
export const DEMO_DENY_PREFIXES: readonly string[] = [
	"/api/v1/setup/",
	"/api/v1/platform-settings/",
	"/api/v1/inbound/",
	"/api/v1/agent-api-keys",
	"/mcp",
	"/tools",
];

/** The only POSTs a visitor may make: sign in, enter as guest, sign out. */
export const DEMO_ALLOWED_POST: ReadonlySet<string> = new Set([
	"/api/v1/auth/login",
	"/api/v1/auth/demo-login",
	"/api/v1/auth/logout",
]);

/** Methods that cannot write anything, hence always allowed. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when this deployment is the public demo. `"1"`, not truthiness. */
export function isDemoMode(env: Partial<Env> | undefined | null): boolean {
	return env?.DEMO_MODE === "1";
}

/** True when `path` is one of the blacklisted surfaces (any method). */
export function isDeniedPath(path: string): boolean {
	return DEMO_DENY_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(prefix),
	);
}

/**
 * The whole policy in one pure function, so the tests can drive it directly
 * and the middleware stays a thin shell around it.
 */
export function isBlockedInDemo(method: string, path: string): boolean {
	if (isDeniedPath(path)) return true;
	const upper = method.toUpperCase();
	if (READ_METHODS.has(upper)) return false;
	if (upper === "POST") return !DEMO_ALLOWED_POST.has(path);
	return true;
}

/**
 * Mount as `app.use("*", demoGuard)`.
 *
 * NOTE on the mount point: `/api/*` would be enough for the route table, but
 * `/mcp` and `/tools` live at the root (see the comment above
 * `app.route("/", agentApiRoute)`), so the guard has to cover the whole app.
 * SPA requests are GETs and fall straight through.
 */
export const demoGuard = createMiddleware<D1MailboxContext>(async (c, next) => {
	// ── Production fast path. Nothing below this line ever runs off-demo. ──
	if (!isDemoMode(c.env)) return next();

	if (isBlockedInDemo(c.req.method, c.req.path)) {
		return c.json(
			{ error: DEMO_READ_ONLY_ERROR, code: DEMO_READ_ONLY_CODE },
			403,
			{
				"X-Robots-Tag": DEMO_NOINDEX,
				"Cache-Control": "no-store",
			},
		);
	}

	await next();

	// Every other demo response carries noindex too — including the SPA
	// document and attachment downloads, which are built as their own
	// `Response` objects and so cannot inherit a header set earlier.
	try {
		c.res.headers.set("X-Robots-Tag", DEMO_NOINDEX);
	} catch {
		// Immutable response headers (e.g. a 101/redirect edge case) — the
		// demo is still read-only, so this is not worth failing a request over.
	}
});
