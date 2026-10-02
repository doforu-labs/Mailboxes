// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

import { Hono } from "hono";
import dns from "node:dns";
// NOTE: dns.promises.resolveMx is kept for detect-dns-provider;
// verify-mx uses DoH directly to avoid Workers polyfill issues.
import { listMailboxes } from "./lib/email-helpers";
import type { Env } from "./types";
import { fetchWithTimeout } from "./lib/fetch-with-timeout";
import * as dbService from "./db";

const setup = new Hono<{ Bindings: Env }>();

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

// ── POST /api/v1/setup/detect-cf-domains ───────────────────────────
// Given a CF API Token + Account ID, return all zones in the account.
setup.post("/api/v1/setup/detect-cf-domains", async (c) => {
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
				{ error: "Missing required fields: cfApiToken, cfAccountId" },
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
					`Cloudflare API error: ${res.status}`;
				return c.json({ error: msg }, 400);
			}

			const data = (await res.json()) as {
				success: boolean;
				errors: Array<{ message: string }>;
				result: Array<{ id: string; name: string; status: string; account?: { id: string; name: string } }>;
				result_info: { total_pages: number };
			};

			if (!data.success) {
				const msg = data.errors?.[0]?.message || "Cloudflare API returned an error";
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
		return c.json({ error: "Failed to detect Cloudflare domains" }, 500);
	}
});

// ── Verify MX Records ────────────────────────────────────────────
setup.post("/api/v1/setup/verify-mx", async (c) => {
	const { domain } = await c.req.json<{ domain: string }>();
	if (!domain) {
		return c.json({ error: "Domain is required" }, 400);
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

		const expectedTarget = "mailboxes.pages.dev";
		const matched = mxRecords.find(
			(r) => r.exchange.toLowerCase() === expectedTarget,
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
		return c.json({ verified: false, error: "DNS lookup failed", records: [] });
	}
});

// ── DNS Provider Detection ───────────────────────────────────────
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
	try {
		const body = await c.req.json<{ domain: string }>();
		const { domain } = body;

		if (!domain) {
			return c.json({ error: "Missing required field: domain" }, 400);
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
		return c.json({ error: "DNS provider detection failed" }, 500);
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
				{ error: "Missing required fields: domain, resendApiKey, cfApiToken, cfAccountId" },
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
				`Resend API error: ${resendRes.status}`;
			return c.json({ error: `Failed to create Resend domain: ${msg}` }, 400);
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
					error:
						`Zone "${domain}" not found in Cloudflare. Make sure the domain is added and active.`,
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
					`DNS record creation failed: ${dnsRes.status}`;
				dnsResults.push({
					name: record.name,
					type: record.type,
					status: `error: ${errMsg}`,
					value: record.value || "",
				});
			} else {
				dnsResults.push({
					name: record.name,
					type: record.type,
					status: "created",
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
			return c.json({ error: "Failed to save domain configuration" }, 500);
		}

		return c.json({
			domainId,
			status: normalizeDomainStatus(verifyData.status),
			dnsRecords: dnsResults,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("verifyDomain failed:", msg);
		return c.json({ error: "Domain verification setup failed" }, 500);
	}
});

// ── POST /api/v1/setup/email-routing ───────────────────────────────
// Enable Cloudflare Email Routing with a catch-all rule pointing to
// the "mailboxes" Worker.
setup.post("/api/v1/setup/email-routing", async (c) => {
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
				{ error: "Missing required fields: domain, cfApiToken" },
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
				{ error: `Zone for "${domain}" not found in Cloudflare.` },
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
				`Failed to enable Email Routing: ${enableRes.status}`;
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
				`Failed to set catch-all rule: ${catchAllRes.status}`;
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
		return c.json({ error: "Failed to setup email routing" }, 500);
	}
});

// ── Domain management routes ───────────────────────────────────

// GET /api/v1/domains — list all domains
setup.get("/api/v1/domains", async (c) => {
	try {
		const domains = await dbService.listDomains(c.env.DB);
		return c.json(domains);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("listDomains failed:", msg);
		return c.json({ error: "Failed to list domains" }, 500);
	}
});

// POST /api/v1/domains — add a new domain (triggers Resend + CF DNS setup)
setup.post("/api/v1/domains", async (c) => {
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
			return c.json({ error: "Missing required field: domain" }, 400);
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
				return c.json({ error: "Domain already exists", domain: existingDomain }, 409);
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
					warnings.push("Could not find Cloudflare zone for this domain — DNS records must be added manually");
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
								status: `error: ${(errBody as any)?.errors?.[0]?.message || "unknown"}`,
								value: record.value || "",
							});
						} else {
							dnsResults.push({ name: record.name, type: record.type, status: "created", value: record.value || "" });
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
						warnings.push("Email Routing setup failed — manual configuration may be needed");
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
						warnings.push("Catch-all routing setup failed");
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
					error: `Failed to create domain on Resend: ${(errBody as any)?.message || resendRes.statusText || resendRes.status}`,
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
			const msg = (errBody as any).message || `Resend API error: ${resendRes.status}`;
			// Resend API failed — roll back the D1 record or revert to original status
			if (domainWasReused) {
				await dbService.updateDomain(c.env.DB, domainId, {
					status: originalStatus ?? "pending",
					resend_api_key: null,
				});
			} else {
				await dbService.deleteDomain(c.env.DB, domainId);
			}
			return c.json({ error: `Failed to create Resend domain: ${msg}` }, 400);
		}
	}

	const updatedDomain = await dbService.getDomain(c.env.DB, domainId);
		return c.json({ domain: updatedDomain, dnsRecords: dnsResults, warnings }, 201);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		console.error("addDomain failed:", msg);
		return c.json({ error: "Failed to add domain" }, 500);
	}
});

// DELETE /api/v1/domains/:id — remove a domain and clean up all resources
setup.delete("/api/v1/domains/:id", async (c) => {
	try {
		const id = c.req.param("id");
		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: "Domain not found" }, 404);
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
				errors.push(`Failed to delete mailbox ${mailbox.id}`);
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
					errors.push(`Resend domain deletion returned ${resendRes.status}`);
				}
			} catch (e) {
				const resendMsg = e instanceof Error ? e.message : "unknown";
				console.error("Resend cleanup failed:", resendMsg);
				errors.push("Resend cleanup failed");
			}
		}

		// ── 3. Disable Cloudflare Email Routing (best-effort) ──
		// Note: CF API token is not stored server-side; we use the catch-all rule
		// deletion which requires zone-level access. If we have cf_zone_id and
		// cf_account_id, we attempt to remove the catch-all rule.
		if (domain.cf_zone_id && domain.cf_account_id) {
			// We cannot call CF API without a token. Log for manual cleanup.
			errors.push(
				`Cloudflare Email Routing for zone ${domain.cf_zone_id} could not be auto-disabled (API token not stored). Please disable manually in Cloudflare dashboard.`,
			);
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
		return c.json({ error: "Failed to delete domain" }, 500);
	}
});

// PUT /api/v1/domains/:id/catch-all — set or clear the catch-all mailbox
setup.put("/api/v1/domains/:id/catch-all", async (c) => {
	try {
		const id = c.req.param("id");
		const body = await c.req.json<{ catch_all_mailbox: string | null }>();

		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: "Domain not found" }, 404);
		}

		const { catch_all_mailbox } = body;

		if (catch_all_mailbox) {
			let resolvedMailbox: string;

			// Handle simplified input: *@domain.com -> create catch-all mailbox *@domain.com
			if (catch_all_mailbox.startsWith("*@")) {
				const inputDomain = catch_all_mailbox.slice(2); // strip "*"
				if (inputDomain.toLowerCase() !== domain.name) {
					return c.json({ error: `Domain mismatch: ${inputDomain} != ${domain.name}` }, 400);
				}
				resolvedMailbox = `*@${domain.name}`;

				// Auto-create the catchall mailbox if it does not exist
				const mailboxKey = `mailboxes/${resolvedMailbox}.json`;
				if (!(await c.env.BUCKET.head(mailboxKey))) {
					const defaultSettings = {
						fromName: "Catch-all",
						forwarding: { enabled: false, email: "" },
						signature: { enabled: false, text: "" },
						autoReply: { enabled: false, subject: "", message: "" },
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
						autoReply: { enabled: false, subject: "", message: "" },
					};
					await c.env.BUCKET.put(mailboxKey, JSON.stringify(defaultSettings));
					await dbService.initMailboxFolders(c.env.DB, resolvedMailbox);
				}
			} else {
				// Traditional input: verify the mailbox exists in R2
				resolvedMailbox = catch_all_mailbox;
				const mailboxKey = `mailboxes/${resolvedMailbox}.json`;
				if (!(await c.env.BUCKET.head(mailboxKey))) {
					return c.json({ error: `Mailbox "${resolvedMailbox}" does not exist` }, 400);
				}
				// Verify the mailbox belongs to this domain
				const mailboxDomain = resolvedMailbox.split("@")[1]?.toLowerCase();
				if (mailboxDomain !== domain.name) {
					return c.json({ error: `Mailbox must belong to domain ${domain.name}` }, 400);
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
		return c.json({ error: "Failed to update catch-all" }, 500);
	}
});

// PUT /api/v1/domains/:id/api-key — update domain-level Resend API key
setup.put("/api/v1/domains/:id/api-key", async (c) => {
	try {
		const id = c.req.param("id");
		const body = await c.req.json<{ resend_api_key: string | null }>();

		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: "Domain not found" }, 404);
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
		return c.json({ error: "Failed to update API key" }, 500);
	}
});

// GET /api/v1/setup/verify-domain/:domainId — Poll domain verification status
setup.get("/api/v1/setup/verify-domain/:domainId", async (c) => {
	try {
		const domainId = c.req.param("domainId");
		const domain = await dbService.getDomain(c.env.DB, domainId);

		if (!domain) {
			return c.json({ error: "Domain not found" }, 404);
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
		return c.json({ error: "Failed to verify domain" }, 500);
	}
});

export default setup;
