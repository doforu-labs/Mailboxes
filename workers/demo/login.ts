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
 * than password strength is what protects this surface. There is no dashboard
 * rule to rely on (the Worker is reachable directly, and a rule that lives
 * outside the code cannot be tested with the rest of it), so the limit is
 * enforced here, against D1 — see `consumeDemoLoginAttempt` below.
 *
 * ── The limit: 10 attempts per IP per 10 minutes ───────────────────────────
 * The two scenarios the numbers have to separate:
 *
 *   A person      clicks "Enter as guest" once, and /login does not call this
 *                 endpoint on page load — a reload of the login page costs
 *                 nothing. Re-entering after a log-out, or from a second tab,
 *                 is 1–3 attempts in ten minutes. 10 leaves that untouched
 *                 with a wide margin, and the worst case for a confused
 *                 visitor who clicks the button four times is still 200s.
 *
 *   A script      used to be unlimited: 12 calls in a row all answered 200 and
 *                 wrote 12 session rows. Now the same script gets 10, then 429
 *                 with `Retry-After`. A single address is capped at ~1,440
 *                 sessions a day instead of an unbounded number per second.
 *
 * Fixed windows, not sliding: a client can land 10 attempts at the end of one
 * window and 10 at the start of the next, a 20-attempt burst across the
 * boundary. That is accepted — the goal is "a script cannot keep going", not
 * a perfectly smooth rate, and a fixed window is one UPSERT with no state to
 * expire.
 *
 * ── When there is no client IP ─────────────────────────────────────────────
 * Cloudflare sets `cf-connecting-ip` on every request that reaches the Worker,
 * so on the public demo this branch does not run. It exists for the two cases
 * where the header can genuinely be absent — `vite preview` locally, and an
 * edge or tunnel that strips it — and both of the obvious ways out are wrong:
 *
 *   "let it through"         makes the limiter removable by the attacker who
 *                            can arrange for a missing header, i.e. it is not
 *                            a limiter.
 *   "one shared bucket"      is a denial of service on real visitors: the
 *                            eleventh legitimate sign-in of the day would be
 *                            refused for everybody.
 *
 * So the bucket becomes `ua:<sha256(user-agent) truncated>`. Different clients
 * hash differently, which keeps one visitor's browsing from locking out
 * another's; identical clients share an allowance, which is coarse but still a
 * limit (10 sign-ins per ten minutes per client software, not 10 for the whole
 * internet). The bucketing decision is one function, `demoLoginBucket`, so the
 * tests can pin both halves.
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
import { DEMO_NOINDEX } from "./guard";
import { ensureDemoData } from "./reset";

/** One hour, in milliseconds. */
export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;

/** Username echoed back to the client; the `admins` row uses the same one. */
export const DEMO_USERNAME = "demo";

// ── Rate limit ─────────────────────────────────────────────────────────────

/** Fixed window length. Long enough to hurt a script, short enough that being
 *  refused is a coffee break, not a lockout. */
export const DEMO_LOGIN_WINDOW_MS = 10 * 60 * 1000;

/** Attempts allowed per bucket per window. See the header comment for why 10. */
export const DEMO_LOGIN_MAX_ATTEMPTS = 10;

/** Stable code a client can key off; the body copy may change, this must not. */
export const DEMO_RATE_LIMIT_CODE = "demo_rate_limited";
export const DEMO_RATE_LIMIT_ERROR =
	"Too many guest sign-in attempts from this address. Try again in a few minutes.";

/** Rows survive one extra window so a live window is never swept. */
const RATE_LIMIT_RETENTION_MS = 2 * DEMO_LOGIN_WINDOW_MS;

/** Bucket strings are stored in D1; a junk header must not blow up a row. */
const MAX_BUCKET_LENGTH = 64;

/**
 * The client address Cloudflare attaches to every request, or null.
 *
 * `x-forwarded-for` is a second chance only: it is client-controlled when
 * nothing in front of the Worker sets it, which is why the Cloudflare header
 * wins and this one is read at all only for a local proxy.
 */
export function clientIpFrom(headers: Headers): string | null {
	const direct = headers.get("cf-connecting-ip")?.trim();
	if (direct) return direct;
	const forwarded = headers.get("x-forwarded-for");
	const first = forwarded?.split(",")[0]?.trim();
	return first ? first : null;
}

/**
 * `ip:<address>`, or `ua:<hash>` when there is no address at all.
 *
 * The fallback is a coarse bucket, never a shared one and never a free pass —
 * see "When there is no client IP" in the header comment.
 */
export async function demoLoginBucket(headers: Headers): Promise<string> {
	const ip = clientIpFrom(headers);
	if (ip) return `ip:${ip.slice(0, MAX_BUCKET_LENGTH)}`;
	const agent = headers.get("user-agent")?.trim() ?? "";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(agent || "no-user-agent"),
	);
	const hex = [...new Uint8Array(digest).slice(0, 8)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `ua:${hex}`;
}

export interface DemoLoginLimit {
	/** True when this attempt is over the window's allowance. */
	limited: boolean;
	/** Seconds until the window rolls over; what `Retry-After` carries. */
	retryAfterSeconds: number;
	/** Post-increment count for this bucket + window, for logs and tests. */
	hits: number;
}

/**
 * Count one attempt against `bucket` and say whether it is allowed.
 *
 * The count and the decision are one statement: an oversized attempt is still
 * counted (fail-closed), and there is no read-modify-write window for two
 * concurrent requests to slip through. The first attempt of a fresh window also
 * sweeps rows whose `expires_at` has passed, which keeps the table bounded
 * without a Cron or a second binding.
 *
 * Callers must treat a thrown error as "keep going": the demo staying up
 * matters more than one unmetered request (see `handleDemoLogin`).
 */
export async function consumeDemoLoginAttempt(
	db: D1Database,
	bucket: string,
	nowMs: number = Date.now(),
): Promise<DemoLoginLimit> {
	const windowStart = Math.floor(nowMs / DEMO_LOGIN_WINDOW_MS) * DEMO_LOGIN_WINDOW_MS;
	const retryAfterSeconds = Math.max(
		1,
		Math.ceil((windowStart + DEMO_LOGIN_WINDOW_MS - nowMs) / 1000),
	);

	const row = await db
		.prepare(
			`INSERT INTO demo_login_rate_limit (bucket, window_start, hits, expires_at)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1
			 RETURNING hits`,
		)
		.bind(bucket, windowStart, windowStart + RATE_LIMIT_RETENTION_MS)
		.first<{ hits: number }>();

	const hits = Number(row?.hits ?? 1);
	if (hits === 1) {
		// Only the first attempt of a window sweeps, so the cleanup costs at
		// most one extra write per bucket per ten minutes. Failing to sweep is
		// not worth failing a sign-in over.
		await db
			.prepare("DELETE FROM demo_login_rate_limit WHERE expires_at < ?")
			.bind(nowMs)
			.run()
			.catch(() => {});
	}

	return { limited: hits > DEMO_LOGIN_MAX_ATTEMPTS, retryAfterSeconds, hits };
}

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

	// ── Rate limit, ahead of everything that writes ────────────────────────
	// A refused attempt must not mint a session, must not trigger the lazy
	// reset, and must not touch R2. If the limiter itself fails (a missing
	// migration on a half-deployed demo, a D1 hiccup) the sign-in proceeds:
	// the demo is public and read-only, so an unmetered login is a smaller
	// problem than a demo nobody can enter.
	try {
		const bucket = await demoLoginBucket(c.req.raw.headers);
		const limit = await consumeDemoLoginAttempt(c.env.DB, bucket);
		if (limit.limited) {
			console.warn(`[demo-rate-limit] ${bucket} refused (${limit.hits} attempts this window)`);
			return c.json(
				{ error: DEMO_RATE_LIMIT_ERROR, code: DEMO_RATE_LIMIT_CODE },
				429,
				{
					"Retry-After": String(limit.retryAfterSeconds),
					"X-Robots-Tag": DEMO_NOINDEX,
					"Cache-Control": "no-store",
				},
			);
		}
	} catch (error) {
		console.error("[demo-rate-limit] check failed, allowing the sign-in:", (error as Error).message);
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
