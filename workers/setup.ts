// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
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
				result: Array<{ id: string; name: string; status: string }>;
				result_info: { total_pages: number };
			};

			if (!data.success) {
				const msg = data.errors?.[0]?.message || "Cloudflare API returned an error";
				return c.json({ error: msg }, 400);
			}

			for (const zone of data.result) {
				zones.push({ id: zone.id, name: zone.name, status: zone.status });
			}

			hasMore = page < data.result_info.total_pages;
			page++;
		}

		return c.json({ zones });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Failed to detect CF domains: ${msg}` }, 500);
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

		// 2. Get Cloudflare zone ID
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

		if (!zonesRes.ok) {
			const errBody = await zonesRes.json().catch(() => ({}));
			const msg =
				(errBody as any)?.errors?.[0]?.message ||
				`Cloudflare API error: ${zonesRes.status}`;
			return c.json({ error: `Failed to find Cloudflare zone: ${msg}` }, 400);
		}

		const zonesData = (await zonesRes.json()) as {
			success: boolean;
			errors: Array<{ message: string }>;
			result: Array<{ id: string }>;
		};

		if (!zonesData.success || !zonesData.result?.length) {
			return c.json(
				{
					error:
						`Zone "${domain}" not found in Cloudflare. Make sure the domain is added and active.`,
				},
				400,
			);
		}

		const zoneId = zonesData.result[0].id;

		// 3. Add DNS records from Resend verification records
		const dnsResults: Array<{ name: string; type: string; status: string }> = [];

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
				});
			} else {
				dnsResults.push({
					name: record.name,
					type: record.type,
					status: "created",
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
				});
			} else {
				await dbService.createDomain(c.env.DB, {
					id: crypto.randomUUID(),
					name: domain.toLowerCase(),
					resend_domain_id: domainId,
					status: normalizeDomainStatus(verifyData.status),
					created_at: new Date().toISOString(),
				});
			}
		} catch (dbErr) {
			console.error("Failed to persist domain to DB:", dbErr);
			// Non-fatal — DNS records are still created
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

		// 1. Get zone ID
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

		if (!zonesRes.ok) {
			const errBody = await zonesRes.json().catch(() => ({}));
			const msg =
				(errBody as any)?.errors?.[0]?.message ||
				`Cloudflare API error: ${zonesRes.status}`;
			return c.json({ error: `Failed to find Cloudflare zone: ${msg}` }, 400);
		}

		const zonesData = (await zonesRes.json()) as {
			success: boolean;
			errors: Array<{ message: string }>;
			result: Array<{ id: string }>;
		};

		if (!zonesData.success || !zonesData.result?.length) {
			return c.json(
				{ error: `Zone "${domain}" not found in Cloudflare.` },
				400,
			);
		}

		const zoneId = zonesData.result[0].id;

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
		}>();

		const { domain, resendApiKey, cfApiToken, cfAccountId } = body;

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
			created_at: now,
		});

		let resendDomainId: string | undefined;
		const dnsResults: Array<{ name: string; type: string; status: string }> = [];

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

				// 2. Get Cloudflare zone ID
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

				let zoneId: string | undefined;
				if (zonesRes.ok) {
					const zonesData = (await zonesRes.json()) as {
						success: boolean;
						result: Array<{ id: string }>;
					};
					if (zonesData.success && zonesData.result?.length) {
						zoneId = zonesData.result[0].id;
					}
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
							});
						} else {
							dnsResults.push({ name: record.name, type: record.type, status: "created" });
						}
					}

					// 4. Enable Email Routing and set catch-all
					await fetch(
						`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/enable`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${cfApiToken}`,
								"Content-Type": "application/json",
							},
						},
					);

					await fetch(
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
				});
			}

			// Update domain with Resend info
			await dbService.updateDomain(c.env.DB, domainId, {
				resend_domain_id: resendDomainId,
				status: "pending",
			});
		} else {
			// Domain record created but Resend setup failed — leave as pending
		}
	}

	const updatedDomain = await dbService.getDomain(c.env.DB, domainId);
		return c.json({ domain: updatedDomain, dnsRecords: dnsResults }, 201);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Failed to add domain: ${msg}` }, 500);
	}
});

// DELETE /api/v1/domains/:id — remove a domain
setup.delete("/api/v1/domains/:id", async (c) => {
	try {
		const id = c.req.param("id");
		const domain = await dbService.getDomain(c.env.DB, id);
		if (!domain) {
			return c.json({ error: "Domain not found" }, 404);
		}

		await dbService.deleteDomain(c.env.DB, id);
		return c.body(null, 204);
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

export default setup;
