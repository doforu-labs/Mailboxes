// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Guest sign-in for the public demo.
 *
 * `POST /api/v1/auth/demo-login` — no body, no password, no username.
 *
 * ── Why there is no demo password ──────────────────────────────────────────
 * The obvious design (print `admin` / `demo` on the login page) publishes an
 * admin credential. Anyone could then try it against other deployments, and a
 * single mis-pointed config would hand over a real backend. Instead the demo's
 * `admins` row holds a PBKDF2 hash of random bytes that were discarded when the
 * seed was generated: `POST /api/v1/auth/login` is therefore dead on the demo
 * (always 401) and this endpoint is the only way in.
 *
 * The consequence is that there is nothing to guess, so rate limiting rather
 * than password strength is what protects this surface (Cloudflare rate-limit
 * rule on the demo hostname, see docs/demo-site-plan.md §4.2).
 *
 * ── Per-visitor session, 1 hour ────────────────────────────────────────────
 * Every call mints a fresh 256-bit token → one `sessions` row per visitor.
 * That is what makes "log out" not log out everyone else. The data itself is
 * shared and read-only, which is exactly why sharing it is safe: no visitor can
 * change what another visitor is looking at, and the unread badges stay at the
 * seeded values for the whole cadence (the reset deletes `sessions`, so nobody
 * keeps a session across a data generation).
 *
 * TTL is 1 hour here, not the production 7 days: an abandoned demo tab should
 * not stay authenticated for a week.
 */
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { AUTH_COOKIE, createSessionToken } from "../lib/auth";
import type { D1MailboxContext } from "../lib/d1-middleware";
import * as db from "../db";
import { ensureDemoData } from "./reset";

/** One hour, in milliseconds. */
export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;

/** Username echoed back to the client; the `admins` row uses the same one. */
export const DEMO_USERNAME = "demo";

/**
 * `POST /api/v1/auth/demo-login`.
 *
 * Returns 404 when the instance is not the demo, so the endpoint does not even
 * exist on a production deployment (matching "the route is only mounted in demo
 * mode" without a second router to keep in sync).
 */
export async function handleDemoLogin(c: Context<D1MailboxContext>) {
	if (c.env.DEMO_MODE !== "1") {
		return c.json({ error: "Not found" }, 404);
	}

	// Lazy reset fallback. A Cron that silently stopped firing would otherwise
	// leave the demo drifting; doing the check here costs one SELECT on a path
	// a visitor takes once per hour at most. If the rebuild throws, the claim
	// has already been rolled back (see reset.ts) so the next login retries —
	// and we still sign the visitor in rather than showing them a 500.
	try {
		const outcome = await ensureDemoData(c.env);
		if (outcome.reset) {
			console.log("[demo-reset] triggered by demo-login");
		}
	} catch (error) {
		console.error("[demo-reset] lazy reset failed:", (error as Error).message);
	}

	const token = createSessionToken();
	const expiresAt = new Date(Date.now() + DEMO_SESSION_TTL_MS).toISOString();
	await db.createSession(c.env.DB, token, expiresAt);

	const isHttps = c.req.url.startsWith("https:");
	setCookie(c, AUTH_COOKIE, token, {
		httpOnly: true,
		secure: isHttps,
		sameSite: "Lax",
		path: "/",
		maxAge: Math.floor(DEMO_SESSION_TTL_MS / 1000),
	});

	return c.json({
		authenticated: true,
		username: DEMO_USERNAME,
		demo: true,
		expiresAt,
	});
}
