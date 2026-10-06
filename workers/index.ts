// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { type Context, Hono } from "hono";
import setup from "./setup";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmailFromMailbox } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import { resolveLocale, DEFAULT_LOCALE } from "../shared/i18n/config";
import { getBackendT } from "../shared/i18n/translate";
import type { Locale } from "../shared/i18n/types";
// [i18n-foundation] Stable sentinel persisted to D1 instead of the localized
// fallback text — see the module docstring in shared/ai-fallback.ts.
import { AI_FALLBACK_SENTINEL } from "../shared/ai-fallback";
import { formatSenderWithAddress } from "../shared/participants";
import type { Env } from "./types";
import { requireMailbox, type D1MailboxContext } from "./lib/d1-middleware";
import { requireAuth, handleLogin, handleLogout, handleMe, handleAdminStatus, handleCreateAdmin } from "./lib/auth";
import { handleResendInbound } from "./inbound";
import { fetchWithTimeout } from "./lib/fetch-with-timeout";
import * as db from "./db";
import type { SearchFilterOptions, EmailFull } from "./db";
import { TOOL_DEFINITIONS, executeToolCall } from "./lib/tool-dispatch";
// Agent surface: admin management endpoints for the global agent API keys
// (cookie/session auth), mounted under /api/v1/* below, plus the external
// agent gateway itself (`./routes/agent-api`, exposing POST /mcp, GET /tools
// and POST /tools/call), which is mounted at the ROOT so it stays outside the
// cookie-based `requireAuth` that covers `/api/v1/*`.
import { agentApiKeysRoute } from "./routes/agent-api-keys";
import { agentApiRoute } from "./routes/agent-api";
type AppContext = Context<D1MailboxContext>;

// Local type for AI text generation output (available in CF Workers runtime)
export interface AiToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface AiTextGenerationOutput {
	response?: string;
	choices?: {
		message?: {
			content?: string | null;
			tool_calls?: AiToolCall[];
		};
	}[];
	tool_calls?: Array<{
		name: string;
		arguments: Record<string, unknown>;
	}>;
}

export interface AiChatMessage {
	role: string;
	content: string | null;
	tool_calls?: AiToolCall[];
}

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	// NOTE: the schema is built once at module scope (no request-scoped `t`),
	// so this message stays English as a last-resort fallback. The handler
	// localizes the surfaced error via `api:validationFailed` instead.
	email: z.string().regex(/^[a-z0-9*][a-z0-9.*_-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i, "Invalid email address"),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

const normalizeDomainStatus = (status: string | undefined): "pending" | "verified" | "failed" => {
	if (status === "verified") return "verified";
	if (status === "failed" || status === "temporary_failure") return "failed";
	return "pending";
};

// -- App & middleware -----------------------------------------------

const app = new Hono<D1MailboxContext>();

// [i18n-foundation] Resolve the request locale once and expose it on the
// context, so API handlers can localize their responses via `getBackendT`.
//
// ⚠️  Localization applies to RESPONSE strings only. Anything persisted to D1
// (notably AI chat messages via `saveAiMessage`) MUST store stable data — user
// input, enum values, ids — never pre-translated text. AI history is replayed
// across sessions, so a stored translation would freeze the language it was
// generated in and read as mixed-language after a switch. See
// `shared/i18n/translate.ts` for the full note.
app.use("/api/*", async (c, next) => {
	const locale = resolveLocale(c.req.raw);
	c.set("locale", locale);
	c.set("t", getBackendT(locale));
	await next();
});

app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));

// ====== Admin Authentication (login / logout / me) ======

app.post("/api/v1/auth/login", handleLogin);
app.post("/api/v1/auth/logout", handleLogout);
app.get("/api/v1/auth/me", handleMe);

// First-run admin setup. Public by design, but only usable while no admin
// account exists yet: the insert is guarded by `WHERE NOT EXISTS`, and every
// later call returns 409.
app.get("/api/v1/setup/admin/status", handleAdminStatus);
app.post("/api/v1/setup/admin", handleCreateAdmin);

// Protect all remaining /api/v1/* endpoints (login, inbound webhook and the
// first-run setup bootstrap are exempted inside requireAuth).
app.use("/api/v1/*", requireAuth);

// Every /api/v1/mailboxes/:mailboxId/* route needs the R2 mailbox check, which
// also populates c.var.db and c.var.mailboxId for the handlers below.
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// ====== 单个域名详情 ======
app.get("/api/v1/domains/:domainId", async (c) => {
	try {
		const db = c.env.DB;
		const domainId = c.req.param("domainId")!;
		const t = c.get("t");
		const { getDomain } = await import("./db/index");
		const domain = await getDomain(db, domainId);
		if (!domain) {
			return c.json({ error: t("api:domainNotFound") }, 404);
		}
		return c.json(domain, 200);
	} catch (error: any) {
		// [error-redaction] Never echo `error.message` to the client: a D1/drizzle
		// failure carries the failing SQL, bound parameters and column names.
		// Answer with the stable i18n copy and keep the exception server-side.
		console.error("Failed to get domain:", error);
		return c.json({ error: c.get("t")("api:failedToGetDomain") }, 500);
	}
});

// ── Setup routes (mounted here so they sit behind the admin session) ──
// The /api/v1/setup/* helpers below talk to Resend and the Cloudflare API
// using credentials stored in the database, so they require a session. Only
// the first-run bootstrap endpoints in ./lib/auth are public.
app.route("/", setup);

// -- Platform Settings ------------------------------------------------

app.get("/api/v1/platform-settings/:key", async (c) => {
	const key = c.req.param("key")!;
	const value = await db.getSetting(c.env.DB, key);
	return c.json({ key, value });
});

app.put("/api/v1/platform-settings/:key", async (c) => {
	const key = c.req.param("key")!;
	const { value } = (await c.req.json()) as { value: string };
	if (typeof value !== "string") {
		return c.json({ error: c.get("t")("api:valueMustBeString") }, 400);
	}
	await db.setSetting(c.env.DB, key, value);
	return c.json({ key, value });
});

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	// Derive domains dynamically from existing mailboxes in R2
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const domainSet = new Set<string>();
	for (const m of allMailboxes) {
		const domain = m.id.split("@")[1];
		if (domain) domainSet.add(domain);
	}
	return c.json({ domains: Array.from(domainSet), emailAddresses: allMailboxes.map(m => m.id) });
});

// -- Mailboxes ------------------------------------------------------

/**
 * Turn a raw email body into a short, tag-free snippet for the dashboard.
 *
 * Order matters: `<script>` / `<style>` blocks are removed *with their
 * contents* first, so CSS/JS text can't leak into the snippet, and only then
 * are the remaining tags stripped. The 100-char cut backs off to the last `&`
 * when it would slice an HTML entity (`&amp;`, `&#39;`, …) in half.
 */
function stripHtmlForSnippet(raw: string): string {
	const withoutBlocks = raw
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
	const text = withoutBlocks.replace(/<[^>]*>/g, "").trim();
	if (text.length <= 100) return text;
	const cut = text.substring(0, 100);
	// An unterminated entity at the tail (`&…;`) would render literally; drop
	// from the last `&` onward in that case.
	const lastAmp = cut.lastIndexOf("&");
	return lastAmp !== -1 && !cut.slice(lastAmp).includes(";")
		? cut.substring(0, lastAmp)
		: cut;
}

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const mailboxIds = allMailboxes.map((m) => m.id);

	// Query unread counts and latest emails from D1 in parallel
	const [unreadMap, latestMap] = await Promise.all([
		db.getMailboxUnreadCounts(c.env.DB, mailboxIds),
		db.getMailboxLatestEmails(c.env.DB, mailboxIds),
	]);

	const result = allMailboxes.map((m) => {
		const latest = latestMap.get(m.id);
		const rawSnippet = latest?.snippet;
		return {
			...m,
			name: m.id,
			unread_count: unreadMap.get(m.id) ?? 0,
			latest_subject: latest?.subject ?? null,
			latest_sender: latest?.sender ?? null,
			latest_sender_name: latest?.sender_name ?? null,
			latest_date: latest?.date ?? null,
			latest_read: latest ? latest.read === 1 : null,
			latest_snippet: rawSnippet ? stripHtmlForSnippet(rawSnippet) : null,
		};
	});

	return c.json(result);
});

app.post("/api/v1/mailboxes", async (c) => {
	const t = c.get("t");
	let parsed: z.infer<typeof CreateMailboxBody>;
	try {
		parsed = CreateMailboxBody.parse(await c.req.json());
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({ error: t("api:validationFailed"), details: error.errors }, 400);
		}
		throw error;
	}
	const { name, settings, email: rawEmail } = parsed;
	const email = rawEmail.toLowerCase();
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: t("api:mailboxAlreadyExists") }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" } };
	const finalSettings = { ...defaultSettings, ...settings, created_at: new Date().toISOString() };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	await db.initMailboxFolders(c.env.DB, email);
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: c.get("t")("api:notFound") }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

// ── Resend API Key verification ────────────────────────────────

interface ResendDomainRecord {
	id: string;
	name: string;
	status: string;
	records: Array<{
		record: string;
		name: string;
		type: string;
		ttl: string;
		status: string;
		value: string;
		priority?: number;
	}>;
}

app.post("/api/v1/mailboxes/:mailboxId/verify-resend", async (c: AppContext) => {
	try {
		const { apiKey } = (await c.req.json()) as { apiKey?: string };
		const t = c.get("t");
		if (!apiKey) {
			return c.json({ valid: false, error: t("api:missingApiKey") }, 400);
		}

		// Call Resend GET /domains to verify the key is valid
		const res = await fetchWithTimeout("https://api.resend.com/domains", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (res.status === 401 || res.status === 403) {
			return c.json({ valid: false, error: t("api:invalidResendApiKey") }, 200);
		}

		if (!res.ok) {
			const errBody = await res.json().catch(() => ({})) as { message?: string };
			return c.json({ valid: false, error: errBody.message || t("api:resendApiError", { status: res.status }) }, 200);
		}

		const data = (await res.json()) as { data: ResendDomainRecord[] };
		const domains = data.data ?? [];

		// Extract the mailbox's email domain
		const mailboxId = c.var.mailboxId;
		const atIdx = mailboxId.indexOf("@");
		const emailDomain = atIdx !== -1 ? mailboxId.substring(atIdx + 1).toLowerCase() : "";

		// Find matching domain and its status
		const matchingDomain = domains.find((d) => d.name.toLowerCase() === emailDomain);

		// Sync Resend domain status to local DB if it has changed.
		// This route is mailbox-scoped, so resolve the local domain row from the
		// mailbox's own domain before writing back.
		const localDomain = emailDomain ? await db.getDomainByName(c.env.DB, emailDomain) : null;
		if (matchingDomain && localDomain) {
			const newStatus = normalizeDomainStatus(matchingDomain.status);
			if (newStatus !== localDomain.status) {
				await db.updateDomain(c.env.DB, localDomain.id, { status: newStatus });
				// Update local object for response consistency
				localDomain.status = newStatus;
			}
		}

		return c.json({
			valid: true,
			domains: domains.map((d) => ({
				id: d.id,
				domain: d.name,
				status: d.status,
			})),
			matchingDomain: matchingDomain
				? { domain: matchingDomain.name, status: matchingDomain.status }
				: null,
			sendingReady: !!matchingDomain && (matchingDomain.status === "valid" || matchingDomain.status === "verified"),
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("verify-resend (mailbox) failed:", msg);
		return c.json({ valid: false, error: c.get("t")("api:verificationFailed") }, 200);
	}
});

// POST /api/v1/domains/:domainId/verify-resend — verify a Resend API key for a domain (no mailbox required)
app.post("/api/v1/domains/:domainId/verify-resend", async (c: AppContext) => {
	try {
		const { apiKey } = (await c.req.json()) as { apiKey?: string };
		const t = c.get("t");
		if (!apiKey) {
			return c.json({ valid: false, error: t("api:missingApiKey") }, 400);
		}

		// Call Resend GET /domains to verify the key is valid
		const res = await fetchWithTimeout("https://api.resend.com/domains", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (res.status === 401 || res.status === 403) {
			return c.json({ valid: false, error: t("api:invalidResendApiKey") }, 200);
		}

		if (!res.ok) {
			const errBody = await res.json().catch(() => ({})) as { message?: string };
			return c.json({ valid: false, error: errBody.message || t("api:resendApiError", { status: res.status }) }, 200);
		}

		const data = (await res.json()) as { data: ResendDomainRecord[] };
		const domains = data.data ?? [];

		// Get domain from database to match against Resend domains
		const domainId = c.req.param("domainId")!;
		const domain = await db.getDomain(c.env.DB, domainId);

		if (!domain) {
			// Domain not found locally — still return valid=true but no matchingDomain
			return c.json({
				valid: true,
				domains: domains.map((d) => ({
					id: d.id,
					domain: d.name,
					status: d.status,
				})),
				matchingDomain: null,
				sendingReady: false,
			});
		}

		const emailDomain = domain.name.toLowerCase();
		const matchingDomain = domains.find((d) => d.name.toLowerCase() === emailDomain);

		// Sync Resend domain status to local DB if it has changed
		if (matchingDomain && domain) {
			const newStatus = normalizeDomainStatus(matchingDomain.status);
			if (newStatus !== domain.status) {
				await db.updateDomain(c.env.DB, domainId, { status: newStatus });
				// Update local object for response consistency
				domain.status = newStatus;
			}
		}

		return c.json({
			valid: true,
			domains: domains.map((d) => ({
				id: d.id,
				domain: d.name,
				status: d.status,
			})),
			matchingDomain: matchingDomain
				? { domain: matchingDomain.name, status: matchingDomain.status }
				: null,
			sendingReady: !!matchingDomain && (matchingDomain.status === "valid" || matchingDomain.status === "verified"),
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("verify-resend failed:", msg);
		return c.json({ valid: false, error: c.get("t")("api:verificationFailed") }, 200);
	}
});

// POST /api/v1/domains/:domainId/setup-resend-sending — create Resend domain + optionally add DNS records
app.post("/api/v1/domains/:domainId/setup-resend-sending", async (c: AppContext) => {
	try {
		const body = await c.req.json() as { 
			apiKey: string; 
			cfApiToken?: string; 
		};

		const { apiKey } = body;
		let cfApiToken = body.cfApiToken;
		const t = c.get("t");

		if (!apiKey) {
			return c.json({ success: false, error: t("api:missingApiKey") }, 400);
		}

		// 1. Get domain from DB
		const domainId = c.req.param("domainId")!;
		const domain = await db.getDomain(c.env.DB, domainId);

		// If no cfApiToken provided, try to read from platform settings
		if (!cfApiToken && domain?.cf_zone_id) {
			const savedToken = await db.getSetting(c.env.DB, "cf_api_token");
			if (savedToken) {
				cfApiToken = savedToken;
			}
		}

		if (!domain) {
			return c.json({ success: false, error: t("api:domainNotFound") }, 404);
		}

		// 2. Create Resend domain
		const resendRes = await fetchWithTimeout("https://api.resend.com/domains", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: domain.name, region: "us-east-1" }),
		});

		if (!resendRes.ok) {
			const errBody = await resendRes.json().catch(() => ({})) as { message?: string };
			return c.json({ 
				success: false, 
				error: t("api:failedToCreateResendDomain", { message: errBody.message || `HTTP ${resendRes.status}` }) 
			}, 200);
		}

		const resendData = await resendRes.json() as {
			id: string;
			name: string;
			status: string;
			records: Array<{
				record: string;
				name: string;
				type: string;
				ttl: string;
				status: string;
				value: string;
				priority?: number;
			}>;
		};

		// 3. Optionally add DNS records to Cloudflare if cfApiToken provided
		const dnsResults: Array<{ name: string; type: string; status: string; value: string }> = [];
		const zoneId = domain.cf_zone_id;

		if (cfApiToken && zoneId) {
			for (const record of resendData.records) {
				const dnsBody: Record<string, string | number> = {
					type: record.type,
					name: record.name,
					content: record.value,
					ttl: record.ttl ? Number(record.ttl) : 1,
				};
				if (record.priority !== undefined) {
					dnsBody.priority = record.priority;
				}

				const dnsRes = await fetchWithTimeout(
					`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${cfApiToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ ...dnsBody, proxied: false }),
					},
				);

				if (!dnsRes.ok) {
					const errBody = await dnsRes.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
					dnsResults.push({
						name: record.name,
						type: record.type,
						status: t("api:dnsRecordError", { message: errBody?.errors?.[0]?.message || t("api:dnsRecordUnknownError") }),
						value: record.value || "",
					});
				} else {
					dnsResults.push({
						name: record.name,
						type: record.type,
						status: t("api:dnsRecordCreated"),
						value: record.value || "",
					});
				}
			}
		}

		// 4. Wait 2s then trigger Resend verify
		await new Promise((r) => setTimeout(r, 2000));

		const verifyRes = await fetchWithTimeout(
			`https://api.resend.com/domains/${resendData.id}/verify`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
			},
		);
		const verifyData = await verifyRes.json() as { status: string };

		// 5. Update DB
		await db.updateDomain(c.env.DB, domainId, {
			resend_domain_id: resendData.id,
			status: normalizeDomainStatus(verifyData.status),
		});

		// 6. Re-fetch Resend domain list to get up-to-date verification result
		const listRes = await fetchWithTimeout("https://api.resend.com/domains", {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		const listData = await listRes.json() as { data: Array<{ id: string; name: string; status: string }> };
		const domainsList = listData.data ?? [];
		const emailDomain = domain.name.toLowerCase();
		const matchingDomain = domainsList.find((d) => d.name.toLowerCase() === emailDomain);

		return c.json({
			success: true,
			resendDomainId: resendData.id,
			resendDomainStatus: normalizeDomainStatus(verifyData.status),
			dnsResults,
			verification: {
				valid: true,
				domains: domainsList.map((d) => ({ id: d.id, domain: d.name, status: d.status })),
				matchingDomain: matchingDomain
					? { domain: matchingDomain.name, status: matchingDomain.status }
					: null,
				sendingReady: !!matchingDomain && (matchingDomain.status === "valid" || matchingDomain.status === "verified"),
			},
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("setup-resend-sending failed:", msg);
		return c.json({ success: false, error: c.get("t")("api:setupFailed") }, 200);
	}
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: c.get("t")("api:notFound") }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;

	// Delete all D1 data (emails, attachments, folders, AI chat) and get attachment list
	// Always attempt D1 cleanup even if R2 config is missing (orphaned mailbox case)
	const attachments = await db.deleteMailbox(c.env.DB, mailboxId);

	// Delete R2 config JSON (may not exist if domain was deleted first)
	try {
		await c.env.BUCKET.delete(key);
	} catch {
		// R2 config may already be gone — not fatal
	}

	// Delete R2 attachment blobs (continue on failure)
	if (attachments.length > 0) {
		try {
			await c.env.BUCKET.delete(
				attachments.map((att) => `attachments/${att.email_id}/${att.id}/${att.filename}`),
			);
		} catch {
			// Attachment deletion failure should not break the flow
		}
	}

	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as string | undefined;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const dbClient = c.var.db;
	const mailboxId = c.var.mailboxId;

	if (threaded && folder) {
		const emails = await db.getThreadedEmails(dbClient, mailboxId, { folder, page, limit });
		const totalCount = await db.countThreadedEmails(dbClient, mailboxId, folder);
		return c.json({ emails, totalCount });
	}
	const emails = await db.getEmails(dbClient, mailboxId, { folder, threadId: thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await db.countEmails(dbClient, mailboxId, folder, thread_id);
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	try {
		const body = SendEmailRequestSchema.parse(await c.req.json());
		const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

		let toStr: string, fromEmail: string, fromDomain: string;
		try {
			({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId, c.get("locale")));
		} catch (e) {
			if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
			throw e;
		}

		const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
		const dbClient = c.var.db;

		const rateLimit = await db.checkSendRateLimit(dbClient, mailboxId);
		if (rateLimit.hourlyCount >= rateLimit.hourlyLimit) {
			return c.json({ error: c.get("t")("api:hourlyRateLimitExceeded", { count: rateLimit.hourlyCount, limit: rateLimit.hourlyLimit }) }, 429);
		}
		if (rateLimit.dailyCount >= rateLimit.dailyLimit) {
			return c.json({ error: c.get("t")("api:dailyRateLimitExceeded", { count: rateLimit.dailyCount, limit: rateLimit.dailyLimit }) }, 429);
		}

		const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

		await db.createEmail(dbClient, mailboxId, Folders.SENT, {
			id: messageId, subject, sender: fromEmail,
			sender_name: typeof from === "string" ? null : (from.name || null),
			recipient: toStr,
			cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
			bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
			date: new Date().toISOString(), body: html || text || "",
			in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
			thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
				{ key: "message-id", value: `<${outgoingMessageId}>` },
			]),
			send_status: "sending",
		}, attachmentData);

		try {
			await sendEmailFromMailbox(c.env.BUCKET, mailboxId, {
				to, cc, bcc, from, subject, html, text,
				attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
				...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
			}, undefined, c.env.DB, c.get("locale"));
			await db.updateEmailSendStatus(c.var.db, mailboxId, messageId, "sent");
			return c.json({ id: messageId, status: "sent" }, 200);
		} catch (e) {
			console.error("Email delivery failed:", (e as Error).message);
			await db.updateEmailSendStatus(c.var.db, mailboxId, messageId, "failed").catch(() => {});
			return c.json({ id: messageId, status: "failed", error: c.get("t")("api:failedToSendEmail") }, 500);
		}
	} catch (error: any) {
		if (error instanceof z.ZodError) {
			return c.json({ error: c.get("t")("api:validationFailed"), details: error.errors }, 400);
		}
		// [error-redaction] Fixed i18n copy only — the raw exception stays in the
		// server log (with its stack), never in the response body.
		console.error("Failed to send email:", error);
		return c.json({ error: c.get("t")("api:failedToSendEmail") }, 500);
	}
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	try {
		const mailboxId = c.req.param("mailboxId")!;
		const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
		const dbClient = c.var.db;
		if (draft_id) await db.deleteEmail(dbClient, mailboxId, draft_id);
		const messageId = crypto.randomUUID();
		const now = new Date().toISOString();
		await db.createEmail(dbClient, mailboxId, Folders.DRAFT, {
			id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
			sender_name: null,
			recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
			date: now, body, in_reply_to: in_reply_to || null, email_references: null,
			thread_id: thread_id || in_reply_to || messageId,
		}, []);
		return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
	} catch (error: any) {
		if (error instanceof z.ZodError) {
			return c.json({ error: c.get("t")("api:validationFailed"), details: error.errors }, 400);
		}
		// [error-redaction] Fixed i18n copy only — see the note on the send route.
		console.error("Failed to save draft:", error);
		return c.json({ error: c.get("t")("api:failedToSaveDraft") }, 500);
	}
});

app.delete("/api/v1/mailboxes/:mailboxId/drafts/:emailId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachments = await db.deleteEmail(c.var.db, c.var.mailboxId, emailId);
	if (attachments === null) return c.json({ error: c.get("t")("api:notFound") }, 404);
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att: { id: string; filename: string }) => `attachments/${emailId}/${att.id}/${att.filename}`));
	}
	return c.body(null, 204);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await db.getEmail(c.var.db, c.var.mailboxId, c.req.param("id")!);
	if (!email) return c.json({ error: c.get("t")("api:emailNotFound") }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await db.updateEmail(c.var.db, c.var.mailboxId, c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: c.get("t")("api:emailNotFound") }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await db.deleteEmail(c.var.db, c.var.mailboxId, id);
	if (attachments === null) return c.json({ error: c.get("t")("api:notFound") }, 404);
	if (attachments.length > 0) {
		await c.env.BUCKET.delete(attachments.map((att: { id: string; filename: string }) => `attachments/${id}/${att.id}/${att.filename}`));
	}
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await db.moveEmail(c.var.db, c.var.mailboxId, c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: c.get("t")("api:folderNotFound") }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await db.getThreadEmails(c.var.db, c.var.mailboxId, c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await db.markThreadRead(c.var.db, c.var.mailboxId, c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Agent API (external gateway + key management) ------------------

// ── Admin key management (cookie auth) ──
// POST /, GET /, DELETE /:id of the global agent API keys. Admin-only, so
// these live under /api/v1/* and are protected by the existing `requireAuth`
// cookie middleware above — that is exactly the intended auth surface.
app.route("/api/v1/agent-api-keys", agentApiKeysRoute);

// ── External gateway (global-API-key auth) ──
// POST /mcp, GET /tools, POST /tools/call are mounted at the ROOT on purpose:
// under `/api/v1/*` the cookie-based `requireAuth` above would reject the
// key-only callers this gateway exists for.
//
// `app.route()` flattens the sub-app's routes AND middleware into this one,
// so `agent-api.ts` guards each of its published paths explicitly
// (`use("/mcp", …)`, `use("/tools", …)`, `use("/tools/call", …)`) rather than
// with a `"*"` pattern. A wildcard would land here as `ALL /*`, run ahead of
// every route registered below (e.g. the ai/chat handlers) and of the React
// Router SPA fallback in `./app.ts`, turning the whole app into a 401.
//
// `/mcp` and `/tools` are claimed by no other route in this file. They are
// registered BEFORE the remaining `/api/v1/*` routes below; that ordering is
// irrelevant to correctness (none of those paths collide) and is kept only so
// the agent surface stays in one contiguous block.
app.route("/", agentApiRoute);

// -- Inbound Webhooks ---------------------------------------------

app.post("/api/v1/inbound/resend", async (c) => {
	const payload = await c.req.json();
	await handleResendInbound(payload, c.env, c.executionCtx as unknown as ExecutionContext);
	return c.json({ ok: true });
});

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await db.getFolders(c.var.db, c.var.mailboxId)));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: c.get("t")("api:folderNameMustBeAlphanumeric") }, 400);
	const f = await db.createFolder(c.var.db, c.var.mailboxId, slug, name);
	return f ? c.json(f, 201) : c.json({ error: c.get("t")("api:folderAlreadyExists") }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await db.updateFolder(c.var.db, c.var.mailboxId, c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: c.get("t")("api:folderNotFound") }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await db.deleteFolder(c.var.db, c.var.mailboxId, c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: c.get("t")("api:folderNotFoundOrCannotDelete") }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: SearchFilterOptions = {
		query: c.req.query("query") || "", folder: c.req.query("folder") ?? undefined, from: c.req.query("from") ?? undefined,
		to: c.req.query("to") ?? undefined, subject: c.req.query("subject") ?? undefined,
		date_start: c.req.query("date_start") ?? undefined,
		date_end: c.req.query("date_end") ?? undefined, is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const dbClient = c.var.db;
	const mailboxId = c.var.mailboxId;
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const emails = await db.searchEmails(dbClient, mailboxId, { ...searchOpts, page, limit });
	const totalCount = await db.countSearchResults(dbClient, mailboxId, searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await db.getAttachment(c.var.db, c.var.mailboxId, attachmentId);
	if (!attachment) return c.json({ error: c.get("t")("api:attachmentNotFound") }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: c.get("t")("api:attachmentFileNotFound") }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- AI Chat (SSE streaming) -----------------------------------------

function buildAiMessages(history: any[], emailContext?: any, email?: any, thread?: any[]): { role: string; content: string }[] {
	// AI-facing: keep English. This prompt and the message templates below are
	// instructions/context fed to the model, never rendered to the user, so they
	// stay in English for consistent model behaviour regardless of UI locale.
	const systemPrompt = `You are an email assistant integrated with the user's mailbox.

## Capabilities
You can search emails, read messages, manage folders, draft and send replies using the tools available to you. When the user asks about their emails, use the appropriate tools to look up real data.

## Tool Use Guidelines
- ONLY call tools when the user asks about their specific emails or wants to perform an action
- For general questions like "what can you do" or "hello", answer directly WITHOUT calling any tools
- When you get empty results from a tool (no emails found), tell the user what happened and suggest next steps - do NOT call the same tool again
- Use search_emails when the user asks about specific content or keywords
- Use list_emails to browse folders
- Use get_email to read a specific email in full
- Use draft_reply to compose a reply (saves to Drafts for user review)
- Use send_reply / send_email only when the user explicitly says to send
- If you don't know something, use tools to look it up before guessing
- Always provide a helpful text response along with any tool actions

Keep responses concise and helpful.`;

	const msgs: { role: string; content: string }[] = [
		{ role: "system", content: systemPrompt },
		...history.map((m: any) => ({ role: m.role, content: m.content })),
	];

	if (email) {
		msgs.push({
			role: "system",
			content: `The user is currently viewing this email:\nFrom: ${formatSenderWithAddress(email.sender_name, email.sender)}\nSubject: ${email.subject}\nDate: ${email.date}\nBody: ${email.body?.substring(0, 2000)}`,
		});
	}
	if (thread && thread.length > 0) {
		const threadSummary = thread
			.map((e: any) => `[${formatSenderWithAddress(e.sender_name, e.sender)}] ${e.subject}: ${e.body?.substring(0, 200)}`)
			.join("\n---\n");
		msgs.push({
			role: "system",
			content: `Full thread context:\n${threadSummary.substring(0, 3000)}`,
		});
	}

	return msgs;
}

// ── AI Provider Helpers ───────────────────────────────────────────

interface AiProviderCfg {
	provider: "cloudflare" | "openai-compatible";
	baseUrl?: string;
	modelName?: string;
	apiKey?: string;
}

/** Load AI provider settings from R2 mailbox config */
async function loadAiProvider(bucket: R2Bucket, mailboxId: string): Promise<AiProviderCfg | null> {
	try {
		const obj = await bucket.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return null;
		const settings: any = await obj.json();
		const cfg = settings?.aiProvider as AiProviderCfg | undefined;
		return cfg?.provider === "openai-compatible" && cfg?.baseUrl ? cfg : null;
	} catch {
		return null;
	}
}

/** Unified AI call — either Cloudflare Workers AI or OpenAI-compatible API */
async function callAi(
	ai: Ai,
	bucket: R2Bucket,
	mailboxId: string,
	messages: any[],
	model: string,
	fallback: string,
	withTools: boolean,
): Promise<AiTextGenerationOutput | null> {
	const providerCfg = await loadAiProvider(bucket, mailboxId);

	if (providerCfg?.apiKey) {
		// ── OpenAI-compatible provider (falls back to CF on failure) ──
		const body: Record<string, any> = {
			model: providerCfg.modelName || model,
			messages,
			stream: false,
		};
		if (withTools) {
			body.tools = TOOL_DEFINITIONS;
		}
		try {
			const res = await fetchWithTimeout(`${providerCfg.baseUrl!.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${providerCfg.apiKey}`,
				},
				body: JSON.stringify(body),
			});
			if (res.ok) {
				return (await res.json()) as unknown as AiTextGenerationOutput;
			}
			const errText = await res.text().catch(() => "");
			console.error(`[AI Provider] ${res.status} from ${providerCfg.baseUrl}: ${errText} — falling back to Cloudflare`);
		} catch (e) {
			console.error(`[AI Provider] fetch failed:`, e, "— falling back to Cloudflare");
		}
	}

	// ── Cloudflare Workers AI (fallback) ──
	try {
		const params: any = { messages };
		if (withTools) params.tools = TOOL_DEFINITIONS;
		return (await ai.run(model, params)) as unknown as AiTextGenerationOutput;
	} catch {
		try {
			const params: any = { messages };
			if (withTools) params.tools = TOOL_DEFINITIONS;
			return (await ai.run(fallback, params)) as unknown as AiTextGenerationOutput;
		} catch {
			return null;
		}
	}
}

app.post("/api/v1/mailboxes/:mailboxId/ai/chat", async (c: AppContext) => {
	const { message, emailContext } = await c.req.json<{ message: string; emailContext?: { emailId?: string; threadId?: string } }>();
	const mailboxId = c.var.mailboxId;
	const d1 = c.var.db;
	const ai = c.env.AI;
	const bucket = c.env.BUCKET;

	if (!message || typeof message !== "string") {
		return c.json({ error: c.get("t")("api:messageRequired") }, 400);
	}

	if (message.length > 10000) {
		return c.json({ error: c.get("t")("api:messageTooLong") }, 400);
	}

	// Save user message
	await db.saveAiMessage(d1, mailboxId, 'user', message);

	// Get chat history
	const history = await db.getAiChatHistory(d1, mailboxId, 30);

	// Build messages
	let email: EmailFull | null | undefined = undefined;
	let thread: EmailFull[] | undefined = undefined;
	if (emailContext?.emailId) {
		email = await db.getEmail(d1, mailboxId, emailContext.emailId);
	}
	if (emailContext?.threadId) {
		thread = await db.getThreadEmails(d1, mailboxId, emailContext.threadId);
	}
	const msgs = buildAiMessages(history, emailContext, email, thread);

	// Check if client wants SSE
	const accept = c.req.header("Accept") || "";
	const isStream = accept.includes("text/event-stream") || c.req.query("stream") === "true";

	if (isStream) {
		// SSE streaming with tool calling support
		const encoder = new TextEncoder();
		const sseStream = new ReadableStream({
			async start(controller) {
				let fullReply = "";
				const MODEL = "@cf/moonshotai/kimi-k2.6" as string;
				const FALLBACK = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as string;

				async function streamTokens(text: string) {
					const words = text.split(/(?<=\s)/);
					const chunkSize = Math.max(1, Math.floor(words.length / 20));
					for (let i = 0; i < words.length; i += chunkSize) {
						const chunk = words.slice(i, i + chunkSize).join("");
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: chunk })}\n\n`));
						await new Promise(r => setTimeout(r, 15));
					}
				}

				// Step 1: First AI call with tools enabled
				let output = await callAi(ai, bucket, mailboxId, msgs, MODEL, FALLBACK, true).catch(() => null);
				if (!output) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: c.get("t")("api:aiTemporarilyUnavailable") })}\n\n`));
					controller.close();
					return;
				}

				// Parse tool_calls from response
				const msg = output.choices?.[0]?.message;
				let content = msg?.content || output.response || "";
				let toolCalls: AiToolCall[] = msg?.tool_calls || [];

				// Handle Llama native format
				if (toolCalls.length === 0 && (output as any).tool_calls?.length) {
					toolCalls = (output as any).tool_calls.map((tc: any) => ({
						id: tc.name || `call_${Math.random().toString(36).slice(2)}`,
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
						},
					}));
				}

				if (toolCalls.length > 0) {
					// Execute tools and notify frontend
					const toolNames = toolCalls.map((tc) => tc.function.name).join(", ");
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: c.get("t")("api:usingTool", { tools: toolNames }), type: "tool_call" })}\n\n`));

					const toolResults = await Promise.allSettled(
						toolCalls.map((tc) =>
							executeToolCall(tc, d1, mailboxId, ai, c.env.BUCKET, c.var.locale).then((result) => ({
								role: "tool" as const,
								tool_call_id: tc.id,
								name: tc.function.name,
								content: JSON.stringify(result),
							})),
						),
					);

					const toolResultsSafe = toolResults.map((r) => {
						if (r.status === "rejected") {
							return { role: "tool" as const, tool_call_id: "error", name: "error", content: JSON.stringify({ error: r.reason?.message || "Tool failed" }) };
						}
						return r.value;
					});

					// Step 2: Second AI call with tool results, force text-only
					const messagesWithResults = [
						...msgs,
						{ role: "assistant", content, tool_calls: toolCalls } as AiChatMessage,
						...toolResultsSafe,
						{ role: "user", content: "Based on the tool results above, please provide a helpful response to the user." },
					];

					const finalOutput = await callAi(ai, bucket, mailboxId, messagesWithResults, MODEL, FALLBACK, false).catch(() => null);
					if (finalOutput) {
						const finalText = (finalOutput as any).choices?.[0]?.message?.content || (finalOutput as any).response || "";
						if (finalText) {
							fullReply = finalText;
							await streamTokens(finalText);
						}
					}
				} else if (content) {
					// AI responded directly without tools - stream it
					fullReply = content;
					await streamTokens(content);
				}

				if (!fullReply) {
					// Immediate response keeps the localized text (current UX)…
					await streamTokens(c.get("t")("api:aiNoRelevantInfo"));
					// …but what we PERSIST is the stable sentinel, so replaying this
					// message later renders it in whatever language is active then.
					fullReply = AI_FALLBACK_SENTINEL;
				}

				const saved = await db.saveAiMessage(d1, mailboxId, 'assistant', fullReply);
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, id: saved.id })}\n\n`));
				controller.close();
			},
		});

		return new Response(sseStream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
			},
		});
	} else {
		// Non-streaming JSON with tool calling
		let fullReply = "";
		const MODEL = "@cf/moonshotai/kimi-k2.6" as string;
		const FALLBACK = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as string;

		// Step 1: first call with tools
		const output = await callAi(ai, bucket, mailboxId, msgs, MODEL, FALLBACK, true).catch(() => null);
		if (!output) return c.json({ error: c.get("t")("api:aiTemporarilyUnavailable") }, 503);

		const msg0 = output.choices?.[0]?.message;
		let content = msg0?.content || output.response || "";
		let toolCalls: AiToolCall[] = msg0?.tool_calls || [];

		if (toolCalls.length === 0 && (output as any).tool_calls?.length) {
			toolCalls = (output as any).tool_calls.map((tc: any) => ({
				id: tc.name || `call_${Math.random().toString(36).slice(2)}`,
				type: "function" as const,
				function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) },
			}));
		}

		if (toolCalls.length > 0) {
			// Execute tools
			const toolResults = await Promise.allSettled(toolCalls.map((tc) =>
				executeToolCall(tc, d1, mailboxId, ai, c.env.BUCKET, c.var.locale).then((r) => ({
					role: "tool" as const, tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(r),
				}))
			));

			const toolResultsSafe = toolResults.map((r) =>
				r.status === "rejected"
					? { role: "tool" as const, tool_call_id: "error", name: "error", content: JSON.stringify({ error: r.reason?.message || "Tool failed" }) }
					: r.value
			);

			// Step 2: call without tools
			const msgs2 = [
				...msgs,
				{ role: "assistant", content, tool_calls: toolCalls } as AiChatMessage,
				...toolResultsSafe,
				{ role: "user", content: "Based on the tool results above, please provide a helpful response to the user." },
			];
			const o2 = await callAi(ai, bucket, mailboxId, msgs2, MODEL, FALLBACK, false).catch(() => null);
			if (o2) {
				fullReply = (o2 as any).choices?.[0]?.message?.content || (o2 as any).response || "";
			}
		} else if (content) {
			fullReply = content;
		}
		if (!fullReply) {
			// Immediate JSON response stays localized; D1 stores the sentinel
			// (see the SSE branch above and shared/ai-fallback.ts).
			fullReply = AI_FALLBACK_SENTINEL;
		}

		const saved = await db.saveAiMessage(d1, mailboxId, 'assistant', fullReply);
		return c.json({ reply: fullReply === AI_FALLBACK_SENTINEL ? c.get("t")("api:aiNoRelevantInfo") : fullReply, id: saved.id });
	}
});

app.get("/api/v1/mailboxes/:mailboxId/ai/chat", async (c: AppContext) => {
	const d1 = c.var.db;
	const mailboxId = c.var.mailboxId;
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
	const messages = await db.getAiChatHistory(d1, mailboxId, limit);
	return c.json({ messages });
});

app.delete("/api/v1/mailboxes/:mailboxId/ai/chat", async (c: AppContext) => {
	const d1 = c.var.db;
	const mailboxId = c.var.mailboxId;
	await db.clearAiChatHistory(d1, mailboxId);
	return c.body(null, 204);
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	mailboxId = allRecipients[0];
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		const domain = mailboxId.split("@")[1];
		const domainRecord = await db.getDomainByName(env.DB, domain);
		if (domainRecord?.catch_all_mailbox) {
			// Normalize: if stored as @domain (legacy), convert to *@domain
			mailboxId = domainRecord.catch_all_mailbox.startsWith("@") && !domainRecord.catch_all_mailbox.startsWith("*@")
				? `*${domainRecord.catch_all_mailbox}`
				: domainRecord.catch_all_mailbox;
			console.log(`No exact match for original recipient, routing to catch-all: ${mailboxId}`);
		} else {
			console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`);
			return;
		}
	}

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await db.findThreadBySubject(env.DB, mailboxId, parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await db.createEmail(env.DB, mailboxId, Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(),
		sender_name: parsedEmail.from?.name?.trim() || null,
		recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	// NOTE: EMAIL_AGENT auto-draft trigger removed — agent will be invoked via D1 change detection instead
}

export { app, receiveEmail };
