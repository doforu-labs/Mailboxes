// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Admin session authentication for the Mailboxes app.
 *
 * Credentials live in the `admins` table and are created exactly once by the
 * first-run setup wizard (POST /api/v1/setup/admin). Passwords are stored as
 * salted PBKDF2-SHA256 hashes — see ./password.ts.
 * The app is "uninitialised" while that table is empty.
 *
 * Login flow:
 *   1. POST /api/v1/auth/login with { username, password }
 *   2. On success a random session token is stored in D1 (sessions table)
 *      and delivered to the browser as an HttpOnly cookie.
 *   3. Every /api/v1/* request (except the public allowlist below) is
 *      checked by requireAuth.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import * as db from "../db";
import type { D1MailboxContext } from "./d1-middleware";
import {
	ABSENT_PASSWORD_HASH,
	toStoredPassword,
	verifyPassword,
	validatePassword,
} from "./password";

export const AUTH_COOKIE = "mailboxes_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_USERNAME_LENGTH = 64;

/**
 * Routes reachable without an admin session:
 *   - the login endpoint itself
 *   - the external send API (authenticated by its own API key)
 *   - the inbound email webhook (Resend)
 *   - the first-run setup bootstrap, which only works while no admin exists
 *
 * NOTE: the remaining /api/v1/setup/* helpers (domain, DNS and Email Routing
 * setup) are deliberately NOT listed here. They fall back to Cloudflare API
 * tokens stored in the database, so an anonymous caller must never reach
 * them.
 */
const PUBLIC_PATHS = new Set<string>([
	"/api/v1/auth/login",
	"/api/v1/send",
	"/api/v1/setup/admin",
	"/api/v1/setup/admin/status",
]);

function isExemptPath(path: string): boolean {
	if (PUBLIC_PATHS.has(path)) return true;
	if (path.startsWith("/api/v1/inbound/")) return true;
	return false;
}

export function createSessionToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Middleware: require a valid admin session for /api/v1/* (with exemptions). */
export const requireAuth = createMiddleware<D1MailboxContext>(async (c, next) => {
	if (isExemptPath(c.req.path)) {
		return next();
	}
	const token = getCookie(c, AUTH_COOKIE);
	if (!token) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const session = await db.getSession(c.env.DB, token);
	if (!session) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	if (new Date(session.expires_at).getTime() < Date.now()) {
		await db.deleteSession(c.env.DB, token);
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
});

/** Count admin accounts, tolerating a missing table (migrations not run). */
async function countAdmins(env: Env): Promise<number> {
	try {
		return await db.countAdmins(env.DB);
	} catch {
		return 0;
	}
}

/** Create a session for the current visitor and set the auth cookie. */
async function issueSession(c: Context<D1MailboxContext>): Promise<void> {
	const token = createSessionToken();
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
	await db.createSession(c.env.DB, token, expiresAt);
	await db.cleanupExpiredSessions(c.env.DB); // opportunistic

	const isHttps = c.req.url.startsWith("https:");
	setCookie(c, AUTH_COOKIE, token, {
		httpOnly: true,
		secure: isHttps,
		sameSite: "Lax",
		path: "/",
		maxAge: Math.floor(SESSION_TTL_MS / 1000),
	});
}

function readString(body: unknown, key: string): string | null {
	if (typeof body !== "object" || body === null) return null;
	const value = (body as Record<string, unknown>)[key];
	return typeof value === "string" ? value : null;
}

// ── First-run setup (public, self-disabling) ────────────────────────

/**
 * GET /api/v1/setup/admin/status — public.
 * Tells the client whether the app has been initialised yet.
 */
export async function handleAdminStatus(c: Context<D1MailboxContext>) {
	const initialized = (await countAdmins(c.env)) > 0;
	return c.json({ initialized });
}

/**
 * POST /api/v1/setup/admin — public, but only while no admin exists.
 *
 * Creates the single admin account and signs the caller in. The insert is a
 * conditional statement (`WHERE NOT EXISTS`), so two concurrent requests can
 * never both create an account: the loser receives 409.
 */
export async function handleCreateAdmin(c: Context<D1MailboxContext>) {
	const body = await c.req.json().catch(() => null);

	const username = (readString(body, "username") ?? "").trim();
	const password = readString(body, "password") ?? "";

	if (!username) {
		return c.json({ error: "Username is required" }, 400);
	}
	if (username.length > MAX_USERNAME_LENGTH) {
		return c.json(
			{ error: `Username must be at most ${MAX_USERNAME_LENGTH} characters` },
			400,
		);
	}
	if (/[\u0000-\u001f\u007f]/.test(username)) {
		return c.json({ error: "Username contains invalid characters" }, 400);
	}
	const passwordError = validatePassword(password);
	if (passwordError) {
		return c.json({ error: passwordError }, 400);
	}

	if ((await countAdmins(c.env)) > 0) {
		return c.json({ error: "Already initialised", code: "already_initialized" }, 409);
	}

	let created: boolean;
	try {
		created = await db.createFirstAdmin(c.env.DB, {
			id: crypto.randomUUID(),
			username,
			password: await toStoredPassword(password),
		});
	} catch (e: unknown) {
		console.error(
			"createFirstAdmin failed:",
			e instanceof Error ? e.message : e,
		);
		return c.json(
			{ error: "Database not ready — run the D1 migrations, then try again" },
			500,
		);
	}

	if (!created) {
		// Lost the first-run race, or an admin appeared concurrently.
		return c.json({ error: "Already initialised", code: "already_initialized" }, 409);
	}

	await issueSession(c);
	return c.json({ authenticated: true, username });
}

// ── Login / logout / me ─────────────────────────────────────────────

export async function handleLogin(c: Context<D1MailboxContext>) {
	const body = await c.req.json().catch(() => null);
	const username = readString(body, "username");
	const password = readString(body, "password");

	if (username === null || password === null) {
		return c.json({ error: "Invalid username or password" }, 401);
	}

	// No admin account yet — the client should run the setup wizard instead.
	if ((await countAdmins(c.env)) === 0) {
		return c.json({ error: "Setup required", code: "setup_required" }, 409);
	}

	const admin = await db.getAdminByUsername(c.env.DB, username.trim());
	// Always run the KDF — including when the username is unknown, or the row
	// is corrupt — so response timing cannot be used to enumerate usernames.
	const stored = admin?.password ? admin.password : ABSENT_PASSWORD_HASH;
	const ok = await verifyPassword(password, stored);

	if (!admin || !ok) {
		return c.json({ error: "Invalid username or password" }, 401);
	}

	await issueSession(c);
	return c.json({ authenticated: true, username: admin.username });
}

export async function handleLogout(c: Context<D1MailboxContext>) {
	const token = getCookie(c, AUTH_COOKIE);
	if (token) {
		await db.deleteSession(c.env.DB, token);
	}
	const isHttps = c.req.url.startsWith("https:");
	deleteCookie(c, AUTH_COOKIE, { path: "/", secure: isHttps, sameSite: "Lax" });
	return c.json({ success: true });
}

export async function handleMe(c: Context<D1MailboxContext>) {
	const token = getCookie(c, AUTH_COOKIE);
	if (!token) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const session = await db.getSession(c.env.DB, token);
	if (!session || new Date(session.expires_at).getTime() < Date.now()) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const admin = await db.getFirstAdmin(c.env.DB);
	if (!admin) {
		// The admin account was removed — treat the session as invalid.
		return c.json({ error: "Unauthorized" }, 401);
	}
	return c.json({ authenticated: true, username: admin.username });
}
