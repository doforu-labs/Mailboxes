// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Admin session authentication for the Mailboxes app.
 *
 * Login flow:
 *   1. POST /api/v1/auth/login with { username, password }
 *   2. On success a random session token is stored in D1 (sessions table)
 *      and delivered to the browser as an HttpOnly cookie.
 *   3. Every /api/v1/* request (except exempt paths) is checked by requireAuth.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import * as db from "../db";
import type { D1MailboxContext } from "./d1-middleware";

export const AUTH_COOKIE = "mailboxes_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface AuthCredentials {
	username: string;
	password: string;
}

/** Resolve admin credentials — env vars override built-in defaults. */
export function getCredentials(env: Env): AuthCredentials {
	return {
		username: env.AUTH_USERNAME || "admin",
		password: env.AUTH_PASSWORD || "REDACTED_DEFAULT_PASSWORD",
	};
}

export function createSessionToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Paths that must remain accessible without an admin session:
 *  - login itself
 *  - external email send API (authenticated via its own API key)
 *  - inbound email webhook (Resend)
 *  - initial setup wizard
 */
function isExemptPath(path: string): boolean {
	if (path === "/api/v1/auth/login") return true;
	if (path === "/api/v1/send") return true;
	if (path.startsWith("/api/v1/inbound/")) return true;
	if (path.startsWith("/api/v1/setup/")) return true;
	return false;
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

export async function handleLogin(c: Context<D1MailboxContext>) {
	const body = await c.req.json().catch(() => null);
	const username = (body as { username?: unknown } | null)?.username;
	const password = (body as { password?: unknown } | null)?.password;
	const creds = getCredentials(c.env);

	if (
		typeof username !== "string" ||
		typeof password !== "string" ||
		username !== creds.username ||
		password !== creds.password
	) {
		return c.json({ error: "Invalid username or password" }, 401);
	}

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

	return c.json({ authenticated: true, username: creds.username });
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
	return c.json({ authenticated: true, username: getCredentials(c.env).username });
}
