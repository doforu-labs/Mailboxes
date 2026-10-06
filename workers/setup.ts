// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

import { Hono } from "hono";
import type { Context } from "hono";
import dns from "node:dns";
// NOTE: dns.promises.resolveMx is kept for detect-dns-provider;
// verify-mx uses DoH directly to avoid Workers polyfill issues.
import { listMailboxes } from "./lib/email-helpers";
import type { Env } from "./types";
import { fetchWithTimeout } from "./lib/fetch-with-timeout";
import * as dbService from "./db";
// [i18n apiSetup] Every `[API]` error string returned to the frontend is
// localized via the `apiSetup` namespace. The locale middleware lives in
// ./index.ts, mounted on the SAME Hono app (`index.ts` does `app.route("/",
// setup)`), so `c.get("locale")` is available here. See `setupT` below for the
// scoped translator factory and its fallback when the middleware did not run.
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "../shared/i18n/config";
import type { Locale } from "../shared/i18n/types";
import { getBackendT } from "../shared/i18n/translate";

/**
 * Resolve the request locale, preferring the value the API middleware in
 * ./index.ts put on the shared request context and falling back to resolving
 * it from the request itself (unit tests, direct `setup.fetch()` calls, or a
 * future mount on a separate Hono instance).
 */
function requestLocale(c: Context): Locale {
	const scoped = c.get("locale" as never) as string | undefined;
	return isLocale(scoped) ? scoped : resolveLocale(c.req.raw) ?? DEFAULT_LOCALE;
}

/**
 * Translator scoped to the `apiSetup` namespace for the request's locale,
 * built lazily so the success path allocates nothing extra.
 */
function setupT(c: Context) {
	let t: ReturnType<typeof getBackendT> | undefined;
	return ((key: string, options?: Record<string, unknown>) => {
		t ??= getBackendT(requestLocale(c), "apiSetup");
		return t(key, options);
	}) as ReturnType<typeof getBackendT>;
}

// Normalize Resend domain status to our standard values.
// Resend may return statuses like "not_started", "dns_verification_in_progress",
// "temporary_failure", etc. — map them all to "pending".
// Returns `string` (not a literal union) so that a stored value read back
// from the DB can be passed straight through (see `originalStatus` below).
function normalizeDomainStatus(status: string | undefined): string {
	if (status === "verified") return "verified";
	if (status === "failed") return "failed";
	if (status === "temporary_failure") return "failed";
	return "pending";
}

const setup = new Hono<{ Bindings: Env }>();

// ── POST /api/v1/setup/detect-cf-domains ───────────────────────────
// Given a CF API Token + Account ID, return all zones in the account.
setup.post("/api/v1/setup/detect-cf-domains", async (c) => {
	const t = setupT(c);
	try {
		const body = await c.req.json<{
			cfApiToken: string;
			cfAccountId: string;
		}>();

		let { cfApiToken, cfAccountId } = body;

		// Fall back to platform settings if CF credentials not provided
		if (!cfApiToken) {
			const saved = await dbService.getSetting(c.env.DB, "cf_api_token");
			if (saved) cfApiToken = saved;
		}
		if (!cfAccountId) {
			const saved = await dbService.getSetting(c.env.DB, "cf_account_id");
			if (saved) cfAccountId = saved;
		}
		if (!cfAccountId) {
			const saved = await dbService.getSetting(c.env.DB, "cf_account_id");
			if (saved) cfAccountId = saved;
		}

		if (!cfApiToken || !cfAccountId) {
			return c.json(
				{ error: t("missingCfCredentials") },
				400,
			);
		}

		// Fetch all zones for the account (paginated, up to 5 pages = 500 zones)
		const zones: Array<{ id: string; name: string; status: string }> = [];
		let page = 1;
		let hasMore = true;
		let accountName = "";

		while (hasMore && page <= 5) {
			const url = new URL(
				`https://api.cloudflare.com/client/v4/zones?account.id=${cfAccountId}&page=${page}&per_page=100`,
			);
			const res = await fetchWithTimeout(url.toString(), {
				method: "GET",
				headers: {
					Authorization: `Bearer ${cfApiToken}`,
					"Content-Type": "application/json",
				},
			});

			if (!res.ok) {
				const errBody = await res.json().catch(() => ({}));
				const msg =
					(errBody as any)?.errors?.[0]?.message ||
					t("cfApiError", { status: res.status });
				return c.json({ error: msg }, 400);
			}

			const data = (await res.json()) as {
				success: boolean;
				errors: Array<{ message: string }>;
				result: Array<{ id: string; name: string; status: string; account?: { id: string; name: string } }>;
				result_info: { total_pages: number };
			};

			if (!data.success) {
				const msg = data.errors?.[0]?.message || t("cfApiGenericError");
				return c.json({ error: msg }, 400);
			}

			for (const zone of data.result) {
				zones.push({ id: zone.id, name: zone.name, status: zone.status });
			}

			// Extract account name from the first zone's account object
			if (!accountName) accountName = data.result[0]?.account?.name || "";

			hasMore = page < data.result_info.total_pages;
			page++;
		}

		return c.json({ zones, accountName });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("detectCfDomains failed:", msg);
		return c.json({ error: t("failedToDetectCfDomains") }, 500);
	}
});

// ── Verify MX Records ────────────────────────────────────────────
//
// Inbound MX targets this fork accepts as "the domain is wired up correctly".
//
// Why a SET and not the single literal this used to be: the original handler
// compared every domain's MX against the upstream agentic-inbox deployment
// host (`mailboxes.pages.dev`). That is the wrong expectation for this fork for
// two reasons:
//
//   1. This fork does not deploy on pages.dev (it runs on
//      `mailboxes.<account>.workers.dev`), so the old literal could never match.
//   2. Inbound mail for a real domain here is delivered through Cloudflare
//      Email Routing, whose MX records are ALWAYS the three cloudflare.net
//      hosts below (priorities 2 / 68 / 70). Deploying elsewhere does not
//      change what a correctly-configured zone looks like.
//
// Consequence of the old literal: every correctly configured domain — e.g.
// `doforu.app` and `doforu.ai`, whose MX are exactly route1/2/3.mx.cloudflare.net
// — was reported as `verified: false`, i.e. the check failed 100% of the time.
//
// `mailboxes.pages.dev` is kept for backward compatibility: a zone that still
// points at the upstream deployment must not regress from pass to fail.
// Add future inbound targets here (a single named list keeps the set easy to
// extend and to audit); comparison ignores case and a trailing root dot.
const ACCEPTED_INBOUND_MX_TARGETS: readonly string[] = [
	// Cloudflare Email Routing (the real inbound path for this deployment).
	// https://developers.cloudflare.com/email-routing/
	"route1.mx.cloudflare.net",
	"route2.mx.cloudflare.net",
	"route3.mx.cloudflare.net",
	// Legacy upstream agentic-inbox deployment host — compatibility only.
	"mailboxes.pages.dev",
];

/**
 * Normalize an MX exchange for comparison: lower-case and drop the trailing
 * root dot the DoH JSON answer carries (`route1.mx.cloudflare.net.`).
 */
function normalizeMxTarget(value: string): string {
	return value.toLowerCase().replace(/\.$/, "");
}

setup.post("/api/v1/setup/verify-mx", async (c) => {
	const t = setupT(c);
	const { domain } = await c.req.json<{ domain: string }>();
	if (!domain) {
		return c.json({ error: t("domainRequired") }, 400);
	}

	try {
		// Use Cloudflare DoH API directly instead of dns.promises.resolveMx
		// to avoid node:dns polyfill compatibility issues in Workers runtime
		const dohRes = await fetchWithTimeout(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
			{ headers: { Accept: "application/dns-json" } },
		);
		const dnsJson = (await dohRes.json()) as {
			Answer?: Array<{ type: number; data: string; TTL: number }>;
			Status?: number;
		};

		const mxRecords = (dnsJson.Answer || [])
			.filter((a) => a.type === 15) // MX record type = 15
			.map((a) => {
				const [priority, ...exchangeParts] = a.data.split(" ");
				return {
					priority: parseInt(priority, 10),
					exchange: exchangeParts.join("").replace(/\.$/, ""), // remove trailing dot
				};
		});

		const matched = mxRecords.find((r) =>
			ACCEPTED_INBOUND_MX_TARGETS.includes(normalizeMxTarget(r.exchange)),
		);

		return c.json({
			verified: !!matched,
			records: mxRecords,
			matched: matched || null,
		});
	} catch (e: unknown) {
		// DNS query failed — domain may not have MX records yet
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("verifyMx failed:", msg);
		return c.json({ verified: false, error: t("dnsLookupFailed"), records: [] });
	}
});

// ── DNS Provider Detection ───────────────────────────────────────
// Ordered table: the FIRST pattern that matches any nameserver wins, so put
// broader / higher-priority providers first. `detectProviderFromNameservers`
// tests each pattern UNANCHORED (`RegExp.test` = substring match), which is
// load-bearing for the Cloudflare row: `ns\d*\.cloudflare\.com` has `\d*`
// (zero-or-more), so it matches the letter-prefixed hosts Cloudflare actually
// hands out — `walt.ns.cloudflare.com` / `ziggy.ns.cloudflare.com` — on the
// `ns.cloudflare.com` substring, while still matching `ns1.cloudflare.com`.
// Verified against those samples; do NOT “tighten” this to `ns\d+\.` or anchor
// it with `^`, which would silently regress the common case to "Other".
const DNS_PROVIDERS: Array<{ pattern: RegExp; name: string }> = [
	{ pattern: /ns\d*\.cloudflare\.com/i, name: "Cloudflare" },
	{ pattern: /awsdns-\d+\.(com|net|org|co\.uk)$/i, name: "AWS Route 53" },
	{ pattern: /googledomains\.com/i, name: "Google Cloud DNS" },
	{ pattern: /ns\d*\.google\.com/i, name: "Google Cloud DNS" },
	{ pattern: /domaincontrol\.com/i, name: "GoDaddy" },
	{ pattern: /godaddy\.com/i, name: "GoDaddy" },
	{ pattern: /registrar-servers\.com/i, name: "Namecheap" },
	{ pattern: /dnsmadeeasy\.com/i, name: "DNS Made Easy" },
	{ pattern: /squarespace\.com/i, name: "Squarespace" },
	{ pattern: /dynadot\.com/i, name: "Dynadot" },
	{ pattern: /ultradns\.(com|net)/i, name: "UltraDNS" },
	{ pattern: /easydns\.com/i, name: "easyDNS" },
	{ pattern: /hover\.com/i, name: "Hover" },
	{ pattern: /dreamhost\.com/i, name: "DreamHost" },
	{ pattern: /ionos\.(com|dev)/i, name: "IONOS" },
	{ pattern: /hostgator\.com/i, name: "HostGator" },
	{ pattern: /bluehost\.com/i, name: "Bluehost" },
	{ pattern: /namesilo\.com/i, name: "NameSilo" },
	{ pattern: /tucows\.com/i, name: "Tucows" },
];

function detectProviderFromNameservers(nameservers: string[]): string {
	for (const ns of nameservers) {
		for (const { pattern, name } of DNS_PROVIDERS) {
			if (pattern.test(ns)) return name;
		}
	}
	return "Other";
}

// ── POST /api/v1/setup/detect-dns-provider ────────────────────────
// Query NS records for a domain and detect the DNS provider.
setup.post("/api/v1/setup/detect-dns-provider", async (c) => {
	const t = setupT(c);
	try {
		const body = await c.req.json<{ domain: string }>();
		const { domain } = body;

		if (!domain) {
			return c.json({ error: t("missingDomainField") }, 400);
		}

		let nameservers: string[] = [];
		try {
			nameservers = await dns.promises.resolveNs(domain);
		} catch {
			// DNS lookup failed (NXDOMAIN, timeout, etc.) — return Other
		}

		const provider = detectProviderFromNameservers(nameservers);

		return c.json({ provider, nameservers });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("detectDnsProvider failed:", msg);
		return c.json({ error: t("dnsProviderDetectionFailed") }, 500);
	}
});

// ── GET /api/v1/setup/status ───────────────────────────────────────
// Check whether the application has been configured.
setup.get("/api/v1/setup/status", async (c) => {
	const bucket = c.env.BUCKET;
	const db = c.env.DB;

	// 1. Check R2 for existing mailboxes
	const mailboxes = await listMailboxes(bucket);
	const mailboxCount = mailboxes.length;

	// 2. Check D1 for email data
	let hasEmails = false;
	if (mailboxCount > 0) {
		try {
			const row = await db
				.prepare("SELECT COUNT(*) as cnt FROM emails LIMIT 1")
				.first<{ cnt: number }>();
			hasEmails = (row?.cnt ?? 0) > 0;
		} catch {
			// Table might not exist yet
			hasEmails = false;
		}
	}

	return c.json({
		configured: mailboxCount > 0,
		mailboxCount,
		hasEmails,
	});
});

// ── POST /api/v1/setup/verify-domain ───────────────────────────────
// Create a Resend domain, add DNS records via CF API, and verify.
setup.post("/api/v1/setup/verify-domain", async (c) => {
	const t = setupT(c);
	try {
		const body = await c.req.json<{
			domain: string;
			resendApiKey: string;
			cfApiToken: string;
			cfAccountId: string;
		}>();

		let { domain, resendApiKey, cfApiToken, cfAccountId } = body;

		// Fall back to platform settings if CF credentials not provided
		if (!cfApiToken) {
			const saved = await dbService.getSetting(c.env.DB, "cf_api_token");
			if (saved) cfApiToken = saved;
		}
		if (!cfAccountId) {
			const saved = await dbService.getSetting(c.env.DB, "cf_account_id");
			if (saved) cfAccountId = saved;
		}

		if (!domain || !resendApiKey || !cfApiToken || !cfAccountId) {
			return c.json(
				{ error: t("missingVerifyDomainCredentials") },
				400,
			);
		}

		// 1. Create domain via Resend API
		const resendRes = await fetchWithTimeout("https://api.resend.com/domains", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${resendApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: domain, region: "us-east-1" }),
		});

		if (!resendRes.ok) {
			const errBody = await resendRes.json().catch(() => ({}));
			const msg =
				(errBody as any).message ||
				t("resendApiError", { status: resendRes.status });
			return c.json({ error: t("failedToCreateResendDomainReason", { reason: msg }) }, 400);
		}

		const resendData = (await resendRes.json()) as {
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

		const domainId = resendData.id;

		// 2. Get Cloudflare zone ID — try exact match, then parent zones for subdomains
		let zoneId: string | undefined;

		// Try exact match first
		const zonesUrl = new URL(
			`https://api.cloudflare.com/client/v4/zones?name=${domain}&status=active`,
		);
		const zonesRes = await fetchWithTimeout(zonesUrl.toString(), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${cfApiToken}`,
				"Content-Type": "application/json",
			},
		});

		if (zonesRes.ok) {
			const zonesData = (await zonesRes.json()) as {
				success: boolean;
				errors: Array<{ message: string }>;
				result: Array<{ id: string }>;
			};
			if (zonesData.success && zonesData.result?.length) {
				zoneId = zonesData.result[0].id;
			}
		}

		// If not found, try parent zones for subdomains (e.g. a.example.com → example.com)
		if (!zoneId) {
			const parts = domain.split(".");
			for (let i = 1; i < parts.length - 1; i++) {
				const parentZone = parts.slice(i).join(".");
				const parentRes = await fetchWithTimeout(
					`https://api.cloudflare.com/client/v4/zones?name=${parentZone}&status=active`,
					{
						method: "GET",
						headers: {
							Authorization: `Bearer ${cfApiToken}`,
							"Content-Type": "application/json",
						},
					},
				);
				if (parentRes.ok) {
					const parentData = (await parentRes.json()) as {
						success: boolean;
						result: Array<{ id: string }>;
				};
					if (parentData.success && parentData.result?.length) {
						zoneId = parentData.result[0].id;
						break;
					}
				}
			}
		}

		if (!zoneId) {
			return c.json(
				{
					error: t("zoneNotFoundVerify", { domain }),
				},
				400,
			);
		}

		// 3. Add DNS records from Resend verification records
		const dnsResults: Array<{ name: string; type: string; status: string; value: string }> = [];

		for (const record of resendData.records) {
			const dnsBody: Record<string, string | number> = {
				type: record.type,
				name: record.name,
				content: record.value,
				ttl: record.ttl ? Number(record.ttl) : 1,
			};

			// MX records require priority
			if (record.priority !== undefined) {
				dnsBody.priority = record.priority;
			}

			// CAA and TXT records need proxied=false
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
				const errBody = await dnsRes.json().catch(() => ({}));
				const errMsg =
					(errBody as any)?.errors?.[0]?.message ||
					t("dnsRecordCreationFailed", { status: dnsRes.status });
				dnsResults.push({
					name: record.name,
					type: record.type,
					status: t("dnsRecordStatusError", { message: errMsg }),
					value: record.value || "",
				});
			} else {
				dnsResults.push({
					name: record.name,
					type: record.type,
					status: t("dnsRecordStatusCreated"),
					value: record.value || "",
				});
			}
		}

		// 4. Wait 2s then verify domain via Resend
		await new Promise((r) => setTimeout(r, 2000));

		const verifyRes = await fetchWithTimeout(
			`https://api.resend.com/domains/${domainId}/verify`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${resendApiKey}`,
					"Content-Type": "application/json",
				},
			},
		);

		const verifyData = (await verifyRes.json()) as {
			id: string;
			status: string;
		};

		// 5. Persist domain to the domains table
		try {
			const existingDomain = await dbService.getDomainByName(c.env.DB, domain.toLowerCase());
			if (existingDomain) {
				await dbService.updateDomain(c.env.DB, existingDomain.id, {
					resend_domain_id: domainId,
					status: normalizeDomainStatus(verifyData.status),
					resend_api_key: resendApiKey,
				});
			} else {
				await dbService.createDomain(c.env.DB, {
					id: crypto.randomUUID(),
					name: domain.toLowerCase(),
					resend_domain_id: domainId,
					status: normalizeDomainStatus(verifyData.status),
					resend_api_key: resendApiKey,
					created_at: new Date().toISOString(),
				});
			}
		} catch (dbErr) {
			console.error("Failed to persist domain to DB:", dbErr);
			return c.json({ error: t("failedToSaveDomainConfig") }, 500);
		}

		return c.json({
			domainId,
			status: normalizeDomainStatus(verifyData.status),
			dnsRecords: dnsResults,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("verifyDomain failed:", msg);
		return c.json({ error: t("domainVerificationSetupFailed") }, 500);
	}
});

// ── POST /api/v1/setup/email-routing ───────────────────────────────
// Enable Cloudflare Email Routing with a catch-all rule pointing to
// the "mailboxes" Worker.
setup.post("/api/v1/setup/email-routing", async (c) => {
	const t = setupT(c);
	try {
		const body = await c.req.json<{
			domain: string;
			cfApiToken: string;
			cfAccountId: string;
		}>();

		let { domain, cfApiToken, cfAccountId } = body;

		// Fall back to platform settings if CF credentials not provided
		if (!cfApiToken) {
			const saved = await dbService.getSetting(c.env.DB, "cf_api_token");
			if (saved) cfApiToken = saved;
		}
		if (!cfAccountId) {
			const saved = await dbService.getSetting(c.env.DB, "cf_account_id");
			if (saved) cfAccountId = saved;
		}

		if (!domain || !cfApiToken) {
			return c.json(
				{ error: t("missingEmailRoutingFields") },
				400,
			);
		}

		// 1. Get zone ID — try exact match first, then parent zone for subdomains
		let zoneId: string | null = null;
		
		// Try exact match (accept any status — zone may still be pending after creation)
		let zonesUrl = new URL(
			`https://api.cloudflare.com/client/v4/zones?name=${domain}`,
		);
		let zonesRes = await fetchWithTimeout(zonesUrl.toString(), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${cfApiToken}`,
				"Content-Type": "application/json",
			},
		});

		if (zonesRes.ok) {
			const zonesData = (await zonesRes.json()) as {
				success: boolean;
				errors: Array<{ message: string }>;
				result: Array<{ id: string }>;
			};
			if (zonesData.success && zonesData.result?.length) {
				zoneId = zonesData.result[0].id;
			}
		}

		// If not found, try parent zones for subdomains
		if (!zoneId) {
			const parts = domain.split(".");
			for (let i = 1; i < parts.length - 1; i++) {
				const parentZone = parts.slice(i).join(".");
				zonesUrl = new URL(
					`https://api.cloudflare.com/client/v4/zones?name=${parentZone}`,
				);
				zonesRes = await fetchWithTimeout(zonesUrl.toString(), {
					method: "GET",
					headers: {
						Authorization: `Bearer ${cfApiToken}`,
						"Content-Type": "application/json",
					},
				});

				if (zonesRes.ok) {
					const zonesData = (await zonesRes.json()) as {
						success: boolean;
						errors: Array<{ message: string }>;
						result: Array<{ id: string }>;
					};
					if (zonesData.success && zonesData.result?.length) {
						zoneId = zonesData.result[0].id;
						break;
					}
				}
			}
		}

		if (!zoneId) {
			return c.json(
				{ error: t("zoneNotFoundRouting", { domain }) },
				400,
			);
		}

		// 2. Enable Email Routing
		const enableRes = await fetchWithTimeout(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/enable`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${cfApiToken}`,
					"Content-Type": "application/json",
				},
			},
		);

		if (!enableRes.ok) {
			const errBody = await enableRes.json().catch(() => ({}));
			const msg =
				(errBody as any)?.errors?.[0]?.message ||
				t("failedToEnableEmailRouting", { status: enableRes.status });
			return c.json({ error: msg }, 400);
		}

		// 3. Set up catch-all rule → forward to Worker "mailboxes"
		const catchAllRes = await fetchWithTimeout(
			`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/catch_all`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${cfApiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					name: "Catch-all to Worker",
					actions: [
						{
							type: "worker",
							value: ["mailboxes"],
						},
					],
					matchers: [
						{
							type: "all",
						},
					],
					enabled: true,
				}),
			},
		);

		if (!catchAllRes.ok) {
			const errBody = await catchAllRes.json().catch(() => ({}));
			const msg =
				(errBody as any)?.errors?.[0]?.message ||
				t("failedToSetCatchAll", { status: catchAllRes.status });
			return c.json({ error: msg }, 400);
		}

		// 4. Save cf_zone_id and cf_account_id to domains table
		try {
			const existingDomain = await dbService.getDomainByName(c.env.DB, domain.toLowerCase());
			if (existingDomain) {
				await dbService.updateDomain(c.env.DB, existingDomain.id, {
					cf_zone_id: zoneId,
					cf_account_id: cfAccountId,
				});
			} else {
				await dbService.createDomain(c.env.DB, {
					id: crypto.randomUUID(),
					name: domain.toLowerCase(),
					cf_zone_id: zoneId,
					cf_account_id: cfAccountId,
					status: "pending",
					created_at: new Date().toISOString(),
				});
			}
		} catch (dbErr) {
			console.error("Failed to persist domain routing info to DB:", dbErr);
			// Non-fatal — email routing is still configured
		}

		return c.json({ success: true });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("emailRouting failed:", msg);
		return c.json({ error: t("failedToSetupEmailRouting") }, 500);
	}
});

// ── Domain management routes ───────────────────────────────────

// GET /api/v1/domains — list all domains
setup.get("/api/v1/domains", async (c) => {
	const t = setupT(c);
	try {
		const domains = await dbService.listDomains(c.env.DB);
		return c.json(domains);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("listDomains failed:", msg);
		return c.json({ error: t("failedToListDomains") }, 500);
	}
});

// POST /api/v1/domains — add a new domain (triggers Resend + CF DNS setup)
setup.post("/api/v1/domains", async (c) => {
	const t = setupT(c);
	try {
		const body = await c.req.json<{
			domain: string;
			cfZoneId?: string;
			resendApiKey?: string;
			cfApiToken?: string;
			cfAccountId?: string;
		}>();

		let { domain, resendApiKey, cfApiToken, cfAccountId, cfZoneId } = body;

		// Fall back to platform settings if CF credentials not provided
		if (!cfApiToken) {
			const saved = await dbService.getSetting(c.env.DB, "cf_api_token");
			if (saved) cfApiToken = saved;
		}
		if (!cfAccountId) {
			const saved = await dbService.getSetting(c.env.DB, "cf_account_id");
			if (saved) cfAccountId = saved;
		}

		if (!domain) {
			return c.json({ error: t("missingDomainField") }, 400);
		}

		// Check if domain already exists
		const existingDomain = await dbService.getDomainByName(c.env.DB, domain.toLowerCase());

		let domainId: string;
		let domainWasReused = false;
		let originalStatus: string | undefined;
		let resendDomainId: string | undefined;
		const dnsResults: Array<{ name: string; type: string; status: string; value: string }> = [];
		const warnings: string[] = [];

		if (existingDomain) {
			// If domain already has sending configured via Resend, it's a real duplicate
			if (existingDomain.resend_domain_id) {
				return c.json({ error: t("domainAlreadyExists"), domain: existingDomain }, 409);
			}
			// Domain was created by the receiving step (email-routing) — reuse it
			// and upgrade with sending configuration
			domainId = existingDomain.id;
			domainWasReused = true;
			originalStatus = existingDomain.status;
			await dbService.updateDomain(c.env.DB, domainId, {
				status: "pending",
				resend_api_key: resendApiKey || null,
			});
		} else {
			// Create new domain record
			domainId = crypto.randomUUID();
			const now = new Date().toISOString();
			await dbService.createDomain(c.env.DB, {
				id: domainId,
				name: domain.toLowerCase(),
				status: "pending",
				resend_api_key: resendApiKey || null,
				cf_zone_id: cfZoneId || null,
				cf_account_id: cfAccountId || null,
				created_at: now,
			});
		}

		// If no Resend API key provided (send-only skipped), mark domain as
		// verified immediately so the UI shows the correct status for receive-only
		// setups.  The full DNS verification path below only runs when all three
		// credentials (resendApiKey + cfApiToken + cfAccountId) are present.
		if (!resendApiKey) {
			await dbService.updateDomain(c.env.DB, domainId, {
				status: "verified",
			});
			// If we reused an existing record (from receiving), return the updated domain
			const updatedDomain = await dbService.getDomain(c.env.DB, domainId);
			return c.json({ domain: updatedDomain, dnsRecords: dnsResults, warnings }, 200);
		}

		// If API keys provided, perform DNS setup automatically
		if (resendApiKey && cfApiToken && cfAccountId) {
			// 1. Create Resend domain
			const resendRes = await fetchWithTimeout("https://api.resend.com/domains", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${resendApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: domain, region: "us-east-1" }),
			});

			if (resendRes.ok) {
				const resendData = (await resendRes.json()) as {
					id: string;
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

				resendDomainId = resendData.id;

				// 2. Get Cloudflare zone ID — try exact match, then parent zones for subdomains
				let zoneId: string | undefined;

				// Try exact match first
				const zonesRes = await fetchWithTimeout(
					`https://api.cloudflare.com/client/v4/zones?name=${domain}&status=active`,
					{
						method: "GET",
						headers: {
							Authorization: `Bearer ${cfApiToken}`,
							"Content-Type": "application/json",
						},
					},
				);

				if (zonesRes.ok) {
					const zonesData = (await zonesRes.json()) as {
						success: boolean;
						result: Array<{ id: string }>;
					};
					if (zonesData.success && zonesData.result?.length) {
						zoneId = zonesData.result[0].id;
					}
				}

				// If not found, try parent zones for subdomains (e.g. a.example.com → example.com)
				if (!zoneId) {
					const parts = domain.split(".");
					for (let i = 1; i < parts.length - 1; i++) {
						const parentZone = parts.slice(i).join(".");
						const parentRes = await fetchWithTimeout(
							`https://api.cloudflare.com/client/v4/zones?name=${parentZone}&status=active`,
							{
								method: "GET",
								headers: {
									Authorization: `Bearer ${cfApiToken}`,
									"Content-Type": "application/json",
								},
							},
						);
						if (parentRes.ok) {
							const parentData = (await parentRes.json()) as {
								success: boolean;
								result: Array<{ id: string }>;
							};
							if (parentData.success && parentData.result?.length) {
								zoneId = parentData.result[0].id;
								break;
							}
						}
					}
				}

				if (!zoneId) {
					warnings.push(t("warningNoCloudflareZone"));
				}

				// 3. Add DNS records
				if (zoneId) {
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
							const errBody = await dnsRes.json().catch(() => ({}));
							dnsResults.push({
								name: record.name,
								type: record.type,
								status: t("dnsRecordStatusError", {
									message: (errBody as any)?.errors?.[0]?.message || t("dnsRecordStatusUnknown"),
								}),
								value: record.value || "",
							});
						} else {
							dnsResults.push({ name: record.name, type: record.type, status: t("dnsRecordStatusCreated"), value: record.value || "" });
						}
					}

					// 4. Enable Email Routing and set catch-all
					const emailRoutingRes = await fetchWithTimeout(
						`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/enable`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${cfApiToken}`,
								"Content-Type": "application/json",
							},
						},
					);

					if (!emailRoutingRes.ok) {
						warnings.push(t("warningEmailRoutingSetupFailed"));
					}

					const catchAllRes = await fetchWithTimeout(
						`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/catch_all`,
						{
							method: "PUT",
							headers: {
								Authorization: `Bearer ${cfApiToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								name: "Catch-all to Worker",
								actions: [{ type: "worker", value: ["mailboxes"] }],
								matchers: [{ type: "all" }],
								enabled: true,
							}),
						},
					);

					if (!catchAllRes.ok) {
						warnings.push(t("warningCatchAllSetupFailed"));
					}

					// Update domain with CF info
					await dbService.updateDomain(c.env.DB, domainId, {
						cf_zone_id: zoneId,
						cf_account_id: cfAccountId,
					});
				}

				// 5. Verify Resend domain
				await new Promise((r) => setTimeout(r, 2000));
				const verifyRes = await fetchWithTimeout(
					`https://api.resend.com/domains/${resendDomainId}/verify`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${resendApiKey}`,
							"Content-Type": "application/json",
						},
					},
				);

				const verifyData = (await verifyRes.json()) as { status: string };

				// Update domain with final status
				await dbService.updateDomain(c.env.DB, domainId, {
					resend_domain_id: resendDomainId,
					status: normalizeDomainStatus(verifyData.status),
				});
			} else {
				const errBody = await resendRes.json().catch(() => ({}));
				// Resend API failed — roll back the D1 record or revert to original status
				if (domainWasReused) {
					await dbService.updateDomain(c.env.DB, domainId, {
						status: originalStatus ?? "pending",
						resend_api_key: null,
					});
				} else {
					await dbService.deleteDomain(c.env.DB, domainId);
				}
				return c.json({
					error: t("failedToCreateDomainOnResend", {
						reason: (errBody as any)?.message || resendRes.statusText || resendRes.status,
					}),
				}, 400);
			}
	} else if (resendApiKey) {
		// Resend-only mode: create Resend domain, return DNS records for user to add manually
		const resendRes = await fetchWithTimeout("https://api.resend.com/domains", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${resendApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: domain, region: "us-east-1" }),
		});

		if (resendRes.ok) {
			const resendData = (await resendRes.json()) as {
				id: string;
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

			resendDomainId = resendData.id;

			// Collect DNS records for the user to add manually
			for (const record of resendData.records) {
				dnsResults.push({
					name: record.name,
					type: record.type,
					status: record.status || "pending",
					value: record.value || "",
				});
			}

			// Update domain with Resend info (no provider auto-setup)
			await dbService.updateDomain(c.env.DB, domainId, {
				resend_domain_id: resendDomainId,
				status: "pending",
				resend_api_key: resendApiKey,
			});
		} else {
			const errBody = await resendRes.json().catch(() => ({}));
			const msg = (errBody as any).message || t("resendApiError", { status: resendRes.status });
			// Resend API failed — roll back the D1 record or revert to original status
			if (domainWasReused) {
				await dbService.updateDomain(c.env.DB, domainId, {
					status: originalStatus ?? "pending",
					resend_api_key: null,
				});
			} else {
				await dbService.deleteDomain(c.env.DB, domainId);
			}
			return c.json({ error: t("failedToCreateResendDomainReason", { reason: msg }) }, 400);
		}
	}

	const updatedDomain = await dbService.getDomain(c.env.DB, domainId);
		return c.json({ domain: updatedDomain, dnsRecords: dnsResults, warnings }, 201);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("addDomain failed:", msg);
		return c.json({ error: t("failedToAddDomain") }, 500);
	}
});

// DELETE /api/v1/domains/:id — remove a domain and clean up all resources
setup.delete("/api/v1/domains/:id", async (c) => {
	const t = setupT(c);
	try {
		const id = c.req.param("id");
		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: t("domainNotFound") }, 404);
		}

		const errors: string[] = [];

		// ── 1. Clean up all mailboxes under this domain (D1 + R2) ──
		const allMailboxes = await listMailboxes(c.env.BUCKET);
		const domainMailboxes = allMailboxes.filter((m) => {
			const atIdx = m.id.indexOf("@");
			return atIdx !== -1 && m.id.substring(atIdx + 1) === domain.name;
		});

		for (const mailbox of domainMailboxes) {
			try {
				// Delete D1 data (emails, attachments, folders, AI chat) and get attachment list
				const attachments = await dbService.deleteMailbox(c.env.DB, mailbox.id);

				// Delete R2 config JSON
				await c.env.BUCKET.delete(`mailboxes/${mailbox.id}.json`);

				// Delete R2 attachment blobs
				if (attachments.length > 0) {
					try {
						await c.env.BUCKET.delete(
							attachments.map((a) => `attachments/${a.email_id}/${a.id}/${a.filename}`),
						);
					} catch {
						// Attachment deletion failure is non-fatal
					}
				}
			} catch (e) {
				const mailboxMsg = e instanceof Error ? e.message : "unknown";
				console.error(`Failed to delete mailbox ${mailbox.id}:`, mailboxMsg);
				errors.push(t("failedToDeleteMailbox", { mailbox: mailbox.id }));
			}
		}

		// ── 2. Delete Resend domain ──
		if (domain.resend_domain_id && domain.resend_api_key) {
			try {
				const resendRes = await fetchWithTimeout(
					`https://api.resend.com/domains/${domain.resend_domain_id}`,
					{
						method: "DELETE",
						headers: {
							Authorization: `Bearer ${domain.resend_api_key}`,
						},
					},
				);
				if (!resendRes.ok) {
					errors.push(t("resendDomainDeleteFailed", { status: resendRes.status }));
				}
			} catch (e) {
				const resendMsg = e instanceof Error ? e.message : "unknown";
				console.error("Resend cleanup failed:", resendMsg);
				errors.push(t("resendCleanupFailed"));
			}
		}

		// ── 3. Disable Cloudflare Email Routing (best-effort) ──
		// Note: CF API token is not stored server-side; we use the catch-all rule
		// deletion which requires zone-level access. If we have cf_zone_id and
		// cf_account_id, we attempt to remove the catch-all rule.
		if (domain.cf_zone_id && domain.cf_account_id) {
			// We cannot call CF API without a token. Log for manual cleanup.
			errors.push(t("cfEmailRoutingManualDisable", { zoneId: domain.cf_zone_id }));
		}

		// ── 4. Delete domain record from D1 ──
		await dbService.deleteDomain(c.env.DB, id);

		return c.json({
			deleted: true,
			mailboxesRemoved: domainMailboxes.length,
			warnings: errors.length > 0 ? errors : undefined,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("deleteDomain failed:", msg);
		return c.json({ error: t("failedToDeleteDomain") }, 500);
	}
});

// PUT /api/v1/domains/:id/catch-all — set or clear the catch-all mailbox
setup.put("/api/v1/domains/:id/catch-all", async (c) => {
	const t = setupT(c);
	try {
		const id = c.req.param("id");
		const body = await c.req.json<{ catch_all_mailbox: string | null }>();

		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: t("domainNotFound") }, 404);
		}

		const { catch_all_mailbox } = body;

		if (catch_all_mailbox) {
			let resolvedMailbox: string;

			// Handle simplified input: *@domain.com -> create catch-all mailbox *@domain.com
			if (catch_all_mailbox.startsWith("*@")) {
				const inputDomain = catch_all_mailbox.slice(2); // strip "*"
				if (inputDomain.toLowerCase() !== domain.name) {
					return c.json({ error: t("domainMismatch", { inputDomain, domain: domain.name }) }, 400);
				}
				resolvedMailbox = `*@${domain.name}`;

				// Auto-create the catchall mailbox if it does not exist
				const mailboxKey = `mailboxes/${resolvedMailbox}.json`;
				if (!(await c.env.BUCKET.head(mailboxKey))) {
					const defaultSettings = {
						fromName: "Catch-all",
						forwarding: { enabled: false, email: "" },
						signature: { enabled: false, text: "" },
					};
					await c.env.BUCKET.put(mailboxKey, JSON.stringify(defaultSettings));
					await dbService.initMailboxFolders(c.env.DB, resolvedMailbox);
				}
			} else if (catch_all_mailbox.startsWith("@")) {
				// Legacy @domain format -> normalize to *@domain
				resolvedMailbox = `*${catch_all_mailbox}`;
				const mailboxKey = `mailboxes/${resolvedMailbox}.json`;
				if (!(await c.env.BUCKET.head(mailboxKey))) {
					// Auto-create the catchall mailbox if it does not exist
					const defaultSettings = {
						fromName: "Catch-all",
						forwarding: { enabled: false, email: "" },
						signature: { enabled: false, text: "" },
					};
					await c.env.BUCKET.put(mailboxKey, JSON.stringify(defaultSettings));
					await dbService.initMailboxFolders(c.env.DB, resolvedMailbox);
				}
			} else {
				// Traditional input: verify the mailbox exists in R2
				resolvedMailbox = catch_all_mailbox;
				const mailboxKey = `mailboxes/${resolvedMailbox}.json`;
				if (!(await c.env.BUCKET.head(mailboxKey))) {
					return c.json({ error: t("mailboxDoesNotExist", { mailbox: resolvedMailbox }) }, 400);
				}
				// Verify the mailbox belongs to this domain
				const mailboxDomain = resolvedMailbox.split("@")[1]?.toLowerCase();
				if (mailboxDomain !== domain.name) {
					return c.json({ error: t("mailboxMustBelongToDomain", { domain: domain.name }) }, 400);
				}
			}

			await dbService.updateDomain(c.env.DB, id, {
				catch_all_mailbox: resolvedMailbox,
			});
		} else {
			// Clear catch-all
			await dbService.updateDomain(c.env.DB, id, {
				catch_all_mailbox: null,
			});
		}

	const updated = await dbService.getDomain(c.env.DB, id);
	return c.json(updated);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("updateCatchAll failed:", msg);
		return c.json({ error: t("failedToUpdateCatchAll") }, 500);
	}
});

// PUT /api/v1/domains/:id/api-key — update domain-level Resend API key
setup.put("/api/v1/domains/:id/api-key", async (c) => {
	const t = setupT(c);
	try {
		const id = c.req.param("id");
		const body = await c.req.json<{ resend_api_key: string | null }>();

		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: t("domainNotFound") }, 404);
		}

		const { resend_api_key } = body;

		await dbService.updateDomain(c.env.DB, id, {
			resend_api_key: resend_api_key || null,
		});

		const updated = await dbService.getDomain(c.env.DB, id);
		return c.json(updated);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("updateApiKey failed:", msg);
		return c.json({ error: t("failedToUpdateApiKey") }, 500);
	}
});

// GET /api/v1/setup/verify-domain/:domainId — Poll domain verification status
setup.get("/api/v1/setup/verify-domain/:domainId", async (c) => {
	const t = setupT(c);
	try {
		const domainId = c.req.param("domainId");
		const domain = await dbService.getDomain(c.env.DB, domainId);

		if (!domain) {
			return c.json({ error: t("domainNotFound") }, 404);
		}

		// If already verified or failed, just return current status
		if (domain.status === "verified" || domain.status === "failed") {
			return c.json({
				domainId: domain.id,
				name: domain.name,
				status: domain.status,
			});
		}

		// If pending and we have a resend_domain_id, trigger re-verification
		if (domain.status === "pending" && domain.resend_domain_id && domain.resend_api_key) {
			try {
				const verifyRes = await fetchWithTimeout(
					`https://api.resend.com/domains/${domain.resend_domain_id}/verify`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${domain.resend_api_key}`,
							"Content-Type": "application/json",
						},
					},
				);

				if (verifyRes.ok) {
					const verifyData = (await verifyRes.json()) as { status: string };
					const newStatus = normalizeDomainStatus(verifyData.status);

					await dbService.updateDomain(c.env.DB, domainId, {
						status: newStatus,
					});

					return c.json({
						domainId: domain.id,
						name: domain.name,
						status: newStatus,
					});
				}
			} catch (verifyErr) {
				console.error("Re-verification request failed:", verifyErr);
			}
		}

		// Return current status if re-verification didn't help
		return c.json({
			domainId: domain.id,
			name: domain.name,
			status: domain.status,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("verifyDomainPoll failed:", msg);
		return c.json({ error: t("failedToVerifyDomain") }, 500);
	}
});

export default setup;
