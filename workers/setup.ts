// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { listMailboxes } from "./lib/email-helpers";
import type { Env } from "./types";

const setup = new Hono<{ Bindings: Env }>();

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

		return c.json({
			domainId,
			status: verifyData.status || "pending",
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

		const { domain, cfApiToken, cfAccountId: _cfAccountId } = body;

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

		return c.json({ success: true });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Email routing setup failed: ${msg}` }, 500);
	}
});

export default setup;
