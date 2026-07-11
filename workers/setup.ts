// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import dns from "node:dns";
// NOTE: dns.promises.resolveMx is kept for detect-dns-provider;
// verify-mx uses DoH directly to avoid Workers polyfill issues.
import { listMailboxes } from "./lib/email-helpers";
import type { Env } from "./types";
import * as dbService from "./db";

const setup = new Hono<{ Bindings: Env }>();

// Normalize Resend domain status to our three standard values.
// Resend may return statuses like "not_started", "dns_verification_in_progress",
// "temporary_failure", etc. — map them all to "pending".
function normalizeDomainStatus(status: string | undefined): "pending" | "verified" | "failed" {
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

		const { cfApiToken, cfAccountId } = body;

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
			const res = await fetch(url.toString(), {
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
		return c.json({ error: `Failed to detect CF domains: ${msg}` }, 500);
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
		const dohRes = await fetch(
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
		return c.json({ verified: false, error: msg, records: [] });
	}
});

// ── DNS Provider Detection ───────────────────────────────────────
const DNS_PROVIDERS: Array<{ pattern: RegExp; name: string }> = [
	{ pattern: /ns\d*\.cloudflare\.com/i, name: "Cloudflare" },
	{ pattern: /awsdns-\d+\.(com|net|org|co\.uk)$/i, name: "AWS Route 53" },
	{ pattern: /googledomains\.com/i, name: "Google Cloud DNS" },
	{ pattern: /ns\d*\.google\.com/i, name: "Google Cloud DNS" },
	{ pattern: /vercel-dns\.com/i, name: "Vercel" },
	{ pattern: /domaincontrol\.com/i, name: "GoDaddy" },
	{ pattern: /godaddy\.com/i, name: "GoDaddy" },
	{ pattern: /registrar-servers\.com/i, name: "Namecheap" },
	{ pattern: /dnsimple-edge\.(com|net|io|org)/i, name: "DNSimple" },
	{ pattern: /dnsmadeeasy\.com/i, name: "DNS Made Easy" },
	{ pattern: /squarespace\.com/i, name: "Squarespace" },
	{ pattern: /gandi\.net/i, name: "Gandi" },
	{ pattern: /name\.com/i, name: "Name.com" },
	{ pattern: /porkbun\.com/i, name: "Porkbun" },
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
		return c.json({ error: `DNS provider detection failed: ${msg}` }, 500);
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

		const { domain, resendApiKey, cfApiToken, cfAccountId } = body;

		if (!domain || !resendApiKey || !cfApiToken || !cfAccountId) {
			return c.json(
				{ error: "Missing required fields: domain, resendApiKey, cfApiToken, cfAccountId" },
				400,
			);
		}

		// 1. Create domain via Resend API
		const resendRes = await fetch("https://api.resend.com/domains", {
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
		const zonesRes = await fetch(zonesUrl.toString(), {
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
				const parentRes = await fetch(
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
			const dnsRes = await fetch(
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

		const verifyRes = await fetch(
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
		return c.json({ error: `Setup failed: ${msg}` }, 500);
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

		const { domain, cfApiToken, cfAccountId } = body;

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
		let zonesRes = await fetch(zonesUrl.toString(), {
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
				zonesRes = await fetch(zonesUrl.toString(), {
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
		const enableRes = await fetch(
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
		const catchAllRes = await fetch(
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
					status: "active",
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
		return c.json({ error: `Email routing setup failed: ${msg}` }, 500);
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
		return c.json({ error: `Failed to list domains: ${msg}` }, 500);
	}
});

// POST /api/v1/domains — add a new domain (triggers Resend + CF DNS setup)
setup.post("/api/v1/domains", async (c) => {
	try {
		const body = await c.req.json<{
			domain: string;
			resendApiKey?: string;
			cfApiToken?: string;
			cfAccountId?: string;
			provider?: string;
			providerCredentials?: Record<string, string>;
		}>();

		const { domain, resendApiKey, cfApiToken, cfAccountId, provider, providerCredentials } = body;

		if (!domain) {
			return c.json({ error: "Missing required field: domain" }, 400);
		}

		// Check if domain already exists
		const existingDomain = await dbService.getDomainByName(c.env.DB, domain.toLowerCase());
		if (existingDomain) {
			return c.json({ error: "Domain already exists", domain: existingDomain }, 409);
		}

		const domainId = crypto.randomUUID();
		const now = new Date().toISOString();

		// Create domain record as pending
		await dbService.createDomain(c.env.DB, {
			id: domainId,
			name: domain.toLowerCase(),
			status: "pending",
			resend_api_key: resendApiKey || null,
			created_at: now,
		});

		let resendDomainId: string | undefined;
		const dnsResults: Array<{ name: string; type: string; status: string; value: string }> = [];
		const warnings: string[] = [];

		// If no Resend API key provided (send-only skipped), mark domain as
		// verified immediately so the UI shows the correct status for receive-only
		// setups.  The full DNS verification path below only runs when all three
		// credentials (resendApiKey + cfApiToken + cfAccountId) are present.
		if (!resendApiKey) {
			await dbService.updateDomain(c.env.DB, domainId, {
				status: "verified",
			});
		}

		// If API keys provided, perform DNS setup automatically
		if (resendApiKey && cfApiToken && cfAccountId) {
			// 1. Create Resend domain
			const resendRes = await fetch("https://api.resend.com/domains", {
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
				const zonesRes = await fetch(
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
						const parentRes = await fetch(
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

						const dnsRes = await fetch(
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
					const emailRoutingRes = await fetch(
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

					const catchAllRes = await fetch(
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
				const verifyRes = await fetch(
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
				// Domain record created but Resend setup failed — leave as pending
			}
	} else if (resendApiKey) {
		// Resend-only mode: create Resend domain, return DNS records for user to add manually
		const resendRes = await fetch("https://api.resend.com/domains", {
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

			// If provider credentials provided, auto-create DNS records via provider API
			if (provider && providerCredentials) {
				const { warnings: dnsWarnings } = await createProviderDnsRecords(
					provider,
					domain,
					resendData.records,
					providerCredentials,
				);
				if (dnsWarnings && dnsWarnings.length > 0) {
					warnings.push(...dnsWarnings);
				}
				// Mark DNS records as created since provider API handled them
				for (const record of dnsResults) {
					record.status = "created";
				}

				// Wait and verify via Resend
				await new Promise((r) => setTimeout(r, 2000));
				const verifyRes = await fetch(
					`https://api.resend.com/domains/${resendDomainId}/verify`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${resendApiKey}`,
							"Content-Type": "application/json",
						},
					},
				);
				if (verifyRes.ok) {
					const verifyData = (await verifyRes.json()) as { status: string };
					const newStatus = normalizeDomainStatus(verifyData.status);
					// Update domain with Resend info and verification status
					await dbService.updateDomain(c.env.DB, domainId, {
						resend_domain_id: resendDomainId,
						status: newStatus,
						resend_api_key: resendApiKey,
					});
				} else {
					await dbService.updateDomain(c.env.DB, domainId, {
						resend_domain_id: resendDomainId,
						status: "pending",
						resend_api_key: resendApiKey,
					});
				}
			} else {
				// Update domain with Resend info (no provider auto-setup)
				await dbService.updateDomain(c.env.DB, domainId, {
					resend_domain_id: resendDomainId,
					status: "pending",
					resend_api_key: resendApiKey,
				});
			}
		} else {
			const errBody = await resendRes.json().catch(() => ({}));
			const msg = (errBody as any).message || `Resend API error: ${resendRes.status}`;
			return c.json({ error: `Failed to create Resend domain: ${msg}` }, 400);
		}
	}

	const updatedDomain = await dbService.getDomain(c.env.DB, domainId);
		return c.json({ domain: updatedDomain, dnsRecords: dnsResults, warnings }, 201);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Failed to add domain: ${msg}` }, 500);
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
				errors.push(`Failed to delete mailbox ${mailbox.id}: ${e instanceof Error ? e.message : "unknown"}`);
			}
		}

		// ── 2. Delete Resend domain ──
		if (domain.resend_domain_id && domain.resend_api_key) {
			try {
				const resendRes = await fetch(
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
				errors.push(`Resend cleanup failed: ${e instanceof Error ? e.message : "unknown"}`);
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
		return c.json({ error: `Failed to delete domain: ${msg}` }, 500);
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
		return c.json({ error: `Failed to update catch-all: ${msg}` }, 500);
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
		return c.json({ error: `Failed to update API key: ${msg}` }, 500);
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
				const verifyRes = await fetch(
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
		return c.json({ error: `Failed to verify domain: ${msg}` }, 500);
	}
});

// ── POST /api/v1/setup/detect-vercel-domains ────────────────────
// Given a Vercel API Token (+ optional Team ID), return all domains.
setup.post("/api/v1/setup/detect-vercel-domains", async (c) => {
	try {
		const body = await c.req.json<{
			vercelApiToken: string;
			vercelTeamId?: string;
		}>();

		const { vercelApiToken, vercelTeamId } = body;

		if (!vercelApiToken) {
			return c.json(
				{ error: "Missing required field: vercelApiToken" },
				400,
			);
		}

		// Build URL — include teamId query param if provided
		const domainsUrl = new URL("https://api.vercel.com/v5/domains");
		if (vercelTeamId) {
			domainsUrl.searchParams.set("teamId", vercelTeamId);
		}

		const res = await fetch(domainsUrl.toString(), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${vercelApiToken}`,
			},
		});

		if (res.status === 401 || res.status === 403) {
			return c.json({ error: "Invalid Vercel API token" }, 400);
		}

		if (!res.ok) {
			const errBody = await res.json().catch(() => ({}));
			const msg =
				(errBody as any)?.error?.message ||
				`Vercel API error: ${res.status}`;
			return c.json({ error: msg }, 400);
		}

		const data = (await res.json()) as {
			domains: Array<{
				name: string;
				createdAt: string;
			}>;
		};

		const domains = (data.domains || []).map((d) => ({
			name: d.name,
			createdAt: d.createdAt,
		}));

		// If teamId was provided, try to get team name
		let teamName: string | null = null;
		if (vercelTeamId) {
			try {
				const teamRes = await fetch(
					`https://api.vercel.com/v2/teams/${vercelTeamId}`,
					{
						method: "GET",
						headers: {
							Authorization: `Bearer ${vercelApiToken}`,
						},
					},
				);
				if (teamRes.ok) {
					const teamData = (await teamRes.json()) as {
						name?: string;
					};
					teamName = teamData.name || null;
				}
			} catch {
				// Non-fatal — team name is optional
			}
		}

		return c.json({ domains, teamName });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json(
			{ error: `Failed to detect Vercel domains: ${msg}` },
			500,
		);
	}
});

// ── POST /api/v1/setup/vercel-verify-domain ─────────────────────
// Create a Resend domain, add DNS records via Vercel API, and verify.
setup.post("/api/v1/setup/vercel-verify-domain", async (c) => {
	try {
		const body = await c.req.json<{
			domain: string;
			resendApiKey: string;
			vercelApiToken: string;
			vercelTeamId?: string;
		}>();

		const { domain, resendApiKey, vercelApiToken, vercelTeamId } = body;

		if (!domain || !resendApiKey || !vercelApiToken) {
			return c.json(
				{
					error:
						"Missing required fields: domain, resendApiKey, vercelApiToken",
				},
				400,
			);
		}

		// 1. Create domain via Resend API
		const resendRes = await fetch("https://api.resend.com/domains", {
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
			return c.json(
				{ error: `Failed to create Resend domain: ${msg}` },
				400,
			);
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

		// 2. Add DNS records from Resend via Vercel API
		const dnsResults: Array<{
			name: string;
			type: string;
			status: string;
			value: string;
		}> = [];

		for (const record of resendData.records) {
			const recordBody: Record<string, string | number> = {
				name: record.name,
				type: record.type,
				value: record.value,
				ttl: record.ttl ? Number(record.ttl) : 60,
			};

			// MX records require priority (Vercel uses mxPriority, not priority)
			if (record.priority !== undefined) {
				recordBody.mxPriority = record.priority;
			}

			// Build Vercel DNS record creation URL
			const recordUrl = new URL(
				`https://api.vercel.com/v2/domains/${domain}/records`,
			);
			if (vercelTeamId) {
				recordUrl.searchParams.set("teamId", vercelTeamId);
			}

			const dnsRes = await fetch(recordUrl.toString(), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${vercelApiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(recordBody),
			});

			if (!dnsRes.ok) {
				const errBody = await dnsRes.json().catch(() => ({}));
				const errMsg =
					(errBody as any)?.error?.message ||
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

		// 3. Wait 2s then verify domain via Resend
		await new Promise((r) => setTimeout(r, 2000));

		const verifyRes = await fetch(
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

		// 4. Persist domain to the domains table
		try {
			const existingDomain = await dbService.getDomainByName(
				c.env.DB,
				domain.toLowerCase(),
			);
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
			return c.json(
				{ error: "Failed to save domain configuration" },
				500,
			);
		}

		return c.json({
			domainId,
			status: normalizeDomainStatus(verifyData.status),
			dnsRecords: dnsResults,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json(
			{ error: `Vercel domain setup failed: ${msg}` },
			500,
		);
	}
});

// ── Helper: Create DNS records via provider API (shared between /domains and /provider-verify-domain) ──

type ResendRecord = {
	record: string;
	name: string;
	type: string;
	ttl: string;
	status: string;
	value: string;
	priority?: number;
};

async function createProviderDnsRecords(
	provider: string,
	domain: string,
	records: ResendRecord[],
	credentials: Record<string, string>,
): Promise<{ warnings?: string[] }> {
	const warnings: string[] = [];

	for (const record of records) {
		try {
			switch (provider) {
				case "vercel": {
					const recordBody: Record<string, string | number> = {
						name: record.name,
						type: record.type,
						value: record.value,
						ttl: record.ttl ? Number(record.ttl) : 60,
					};
					if (record.priority !== undefined) {
						recordBody.mxPriority = record.priority;
					}
					const recordUrl = new URL(`https://api.vercel.com/v2/domains/${domain}/records`);
					if (credentials.teamId) {
						recordUrl.searchParams.set("teamId", credentials.teamId);
					}
					const res = await fetch(recordUrl.toString(), {
						method: "POST",
						headers: {
							"Authorization": `Bearer ${credentials.apiToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(recordBody),
					});
					if (!res.ok) {
						const errBody = await res.json().catch(() => ({}));
						const errMsg = (errBody as any)?.error?.message || `DNS record creation failed: ${res.status}`;
						warnings.push(`Failed to create ${record.type} record via Vercel: ${errMsg}`);
					}
					break;
				}

				case "gandi": {
					const value =
						record.type === "MX"
							? `${record.priority} ${record.value}`
							: record.value;
					const res = await fetch(
						`https://api.gandi.net/v5/livedns/domains/${domain}/records/${record.name}/${record.type}`,
						{
							method: "POST",
							headers: {
								"Authorization": `Bearer ${credentials.apiToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								rrset_ttl: Number(record.ttl) || 3600,
								rrset_values: [value],
							}),
						},
					);
					if (!res.ok)
						warnings.push(
							`Failed to create ${record.type} record via Gandi`,
						);
					break;
				}

				case "porkbun": {
					const res = await fetch(
						`https://api.porkbun.com/api/json/v3/dns/create/${domain}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								apikey: credentials.apiKey,
								secretapikey: credentials.secretApiKey,
								name: record.name,
								type: record.type,
								content: record.value,
								prio: record.priority,
								ttl: Number(record.ttl) || 600,
							}),
						},
					);
					if (!res.ok)
						warnings.push(
							`Failed to create ${record.type} record via Porkbun`,
						);
					break;
				}

				case "name": {
					const auth =
						"Basic " +
						btoa(`${credentials.username}:${credentials.apiToken}`);
					const res = await fetch(
						`https://api.name.com/core/v1/domains/${domain}/records`,
						{
							method: "POST",
							headers: {
								"Authorization": auth,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								type: record.type,
								host: record.name,
								answer: record.value,
								priority: record.priority,
								ttl: Number(record.ttl) || 3600,
							}),
						},
					);
					if (!res.ok)
						warnings.push(
							`Failed to create ${record.type} record via Name.com`,
						);
					break;
				}

				case "dnsimple": {
					const accountId = credentials._accountId;
					if (!accountId) {
						// Get account ID first
						const whoamiRes = await fetch(
							"https://api.dnsimple.com/v2/account/whoami",
							{
								headers: {
									"Authorization": `Bearer ${credentials.apiToken}`,
									"Content-Type": "application/json",
								},
							},
						);
						const whoamiData = (await whoamiRes.json()) as {
							data: { account: { id: number } };
						};
						credentials._accountId = String(
							whoamiData.data.account.id,
						);
					}
					const res = await fetch(
						`https://api.dnsimple.com/v2/${credentials._accountId}/zones/${domain}/records`,
						{
							method: "POST",
							headers: {
								"Authorization": `Bearer ${credentials.apiToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								name: record.name === "@" ? "" : record.name,
								type: record.type,
								content: record.value,
								priority: record.priority,
								ttl: Number(record.ttl) || 600,
							}),
						},
					);
					if (!res.ok)
						warnings.push(
							`Failed to create ${record.type} record via DNSimple`,
						);
					break;
				}
			}
		} catch (err) {
			warnings.push(
				`Error creating ${record.type} record: ${err instanceof Error ? err.message : "unknown"}`,
			);
		}
	}

	return { warnings };
}

// ── Unified DNS Provider Endpoints ───────────────────────────────

// Detect domains for any supported DNS provider
setup.post("/api/v1/setup/detect-provider-domains", async (c) => {
	try {
		const body = await c.req.json();
		const { provider, credentials } = body as {
			provider: string;
			credentials: Record<string, string>;
		};

		if (!provider) {
			return c.json({ error: "provider is required" }, 400);
		}

		// Helper: Bearer auth headers
		const bearerHeaders = (token: string) => ({
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
		});

		interface DomainItem {
			name: string;
			createdAt: string;
		}

		let domains: DomainItem[] = [];
		let teamName: string | null = null;

		switch (provider) {
			case "vercel": {
				const token = credentials.apiToken;
				if (!token) return c.json({ error: "apiToken is required" }, 400);
				const domainsUrl = new URL("https://api.vercel.com/v5/domains");
				if (credentials.teamId) {
					domainsUrl.searchParams.set("teamId", credentials.teamId);
				}
				const res = await fetch(domainsUrl.toString(), {
					headers: bearerHeaders(token),
				});
				if (res.status === 401 || res.status === 403) return c.json({ error: "Invalid Vercel API token" }, 400);
				if (!res.ok) return c.json({ error: "Vercel API error" }, 400);
				const data = (await res.json()) as { domains: Array<{ name: string; createdAt: string }> };
				domains = (data.domains || []).map((d) => ({
					name: d.name,
					createdAt: d.createdAt,
				}));
				break;
			}
			case "gandi": {
				const token = credentials.apiToken;
				if (!token) return c.json({ error: "apiToken is required" }, 400);
				const res = await fetch("https://api.gandi.net/v5/livedns/domains", {
					headers: bearerHeaders(token),
				});
				if (!res.ok) return c.json({ error: "Invalid API token" }, 400);
				const data = (await res.json()) as Array<{ fqdn: string; created_at: string }>;
				domains = (data || []).map((d) => ({
					name: d.fqdn,
					createdAt: d.created_at || "",
				}));
				break;
			}
			case "porkbun": {
				const { apiKey, secretApiKey } = credentials;
				if (!apiKey || !secretApiKey) return c.json({ error: "apiKey and secretApiKey are required" }, 400);
				// Porkbun has no list-domains endpoint; verify keys via pricing API
				const res = await fetch("https://api.porkbun.com/api/json/v3/pricing/get", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ apikey: apiKey, secretapikey: secretApiKey }),
				});
				const data = (await res.json()) as { status: string };
				if (data.status === "ERROR") return c.json({ error: "Invalid API credentials" }, 400);
				domains = [];
				break;
			}
			case "name": {
				const { username, apiToken } = credentials;
				if (!username || !apiToken) return c.json({ error: "username and apiToken are required" }, 400);
				const auth = "Basic " + btoa(`${username}:${apiToken}`);
				const res = await fetch("https://api.name.com/core/v1/domains", {
					headers: { "Authorization": auth, "Content-Type": "application/json" },
				});
				if (!res.ok) return c.json({ error: "Invalid credentials" }, 400);
				const data = (await res.json()) as { domains: Array<{ domain_name: string }> };
				domains = (data.domains || []).map((d) => ({
					name: d.domain_name,
					createdAt: "",
				}));
				break;
			}
			case "dnsimple": {
				const token = credentials.apiToken;
				if (!token) return c.json({ error: "apiToken is required" }, 400);
				const whoamiRes = await fetch("https://api.dnsimple.com/v2/account/whoami", {
					headers: bearerHeaders(token),
				});
				if (!whoamiRes.ok) return c.json({ error: "Invalid API token" }, 400);
				const whoamiData = (await whoamiRes.json()) as { data: { account: { id: number } } };
				const accountId = whoamiData.data.account.id;
				teamName = String(accountId);
				const zonesRes = await fetch(`https://api.dnsimple.com/v2/${accountId}/zones`, {
					headers: bearerHeaders(token),
				});
				if (zonesRes.ok) {
					const zonesData = (await zonesRes.json()) as { data: Array<{ name: string; created_at: string }> };
					domains = (zonesData.data || []).map((z) => ({
						name: z.name,
						createdAt: z.created_at || "",
					}));
				}
				break;
			}
			default:
				return c.json({ error: `Unknown provider: ${provider}` }, 400);
		}

		return c.json({ domains, teamName });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Failed to detect domains: ${msg}` }, 500);
	}
});

// Create Resend domain + DNS records for any supported provider
setup.post("/api/v1/setup/provider-verify-domain", async (c) => {
	try {
		const body = await c.req.json();
		const { provider, domain, resendApiKey, credentials } = body as {
			provider: string;
			domain: string;
			resendApiKey: string;
			credentials: Record<string, string>;
		};

		if (!provider || !domain || !resendApiKey) {
			return c.json(
				{ error: "provider, domain, and resendApiKey are required" },
				400,
			);
		}

		// Step 1: Create Resend domain (same as existing code)
		const resendRes = await fetch("https://api.resend.com/domains", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${resendApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: domain, region: "us-east-1" }),
		});
		const resendData = (await resendRes.json()) as {
			id?: string;
			name?: string;
			records?: Array<{
				record: string;
				name: string;
				type: string;
				ttl: string;
				status: string;
				value: string;
				priority?: number;
			}>
			error?: string;
		};

		if (resendData.error || !resendData.id) {
			return c.json(
				{ error: resendData.error || "Failed to create Resend domain" },
				400,
			);
		}

		const resendDomainId = resendData.id;
		const dnsRecords = resendData.records || [];

		// Step 3: Create DNS records via provider (using shared module-level helper)
		const { warnings } = await createProviderDnsRecords(
			provider,
			domain,
			dnsRecords,
			credentials,
		);

		// Step 4: Wait and verify via Resend
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const verifyRes = await fetch(
			`https://api.resend.com/domains/${resendDomainId}/verify`,
			{
				method: "POST",
				headers: {
					"Authorization": `Bearer ${resendApiKey}`,
				},
			},
		);
		const verifyData = (await verifyRes.json()) as {
			id: string;
			status: string;
		};

		// Step 5: Persist domain in D1
		let domainId = "";

		try {
			const existingDomain = await dbService.getDomainByName(c.env.DB, domain.toLowerCase());
			if (existingDomain) {
				domainId = existingDomain.id;
				await dbService.updateDomain(c.env.DB, existingDomain.id, {
					resend_domain_id: resendDomainId,
					status: normalizeDomainStatus(verifyData.status),
					resend_api_key: resendApiKey,
				});
			} else {
				await dbService.createDomain(c.env.DB, {
					id: crypto.randomUUID(),
					name: domain.toLowerCase(),
					resend_domain_id: resendDomainId,
					status: normalizeDomainStatus(verifyData.status),
					resend_api_key: resendApiKey,
					created_at: new Date().toISOString(),
				});
				const created = await dbService.getDomainByName(c.env.DB, domain.toLowerCase());
				domainId = created?.id || "";
			}
		} catch (dbErr) {
			console.error("Failed to persist domain to DB:", dbErr);
			return c.json({ error: "Failed to save domain configuration" }, 500);
		}

		return c.json({
			domainId,
			status: normalizeDomainStatus(verifyData.status),
			dnsRecords,
			warnings,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json(
			{ error: `Provider domain setup failed: ${msg}` },
			500,
			);
	}
});

export default setup;
