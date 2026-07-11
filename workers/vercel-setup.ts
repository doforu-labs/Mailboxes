// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Vercel → Cloudflare domain migration helpers.
 *
 * Three endpoints:
 *   POST /api/v1/setup/cloudflare/add-zone   – add zone to CF
 *   POST /api/v1/setup/vercel/update-ns      – replace NS in Vercel
 *   GET  /api/v1/setup/check-ns/:domain      – check NS propagation
 */

import type { Context } from "hono";
import type { Env } from "./types";

type AppContext = Context<{ Bindings: Env }>;

// ── Handler A: Add Cloudflare Zone ─────────────────────────────

export async function handleAddCloudflareZone(c: AppContext): Promise<Response> {
	try {
		const { domain, cfApiToken } = (await c.req.json()) as {
			domain: string;
			cfApiToken: string;
		};

		if (!domain || !cfApiToken) {
			return c.json({ error: "Missing required fields: domain, cfApiToken" }, 400);
		}

		const res = await fetch("https://api.cloudflare.com/client/v4/zones", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cfApiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: domain, type: "full" }),
		});

		const data = (await res.json()) as {
			success: boolean;
			result: { id: string; name_servers: string[] };
			errors: Array<{ message: string }>;
		};

		if (!data.success) {
			const msg = data.errors?.[0]?.message || "Cloudflare zone creation failed";
			return c.json({ error: msg }, 400);
		}

		return c.json({
			zoneId: data.result.id,
			nameservers: data.result.name_servers,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Failed to add Cloudflare zone: ${msg}` }, 500);
	}
}

// ── Handler B: Update Vercel NS Records ────────────────────────

export async function handleUpdateVercelNS(c: AppContext): Promise<Response> {
	try {
		const { domain, vercelToken, nameservers } = (await c.req.json()) as {
			domain: string;
			vercelToken: string;
			nameservers: string[];
		};

		if (!domain || !vercelToken || !nameservers?.length) {
			return c.json({ error: "Missing required fields: domain, vercelToken, nameservers" }, 400);
		}

		// 1. Fetch current domain records from Vercel
		const getRes = await fetch(
			`https://api.vercel.com/v9/domains/${domain}`,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${vercelToken}` },
			},
		);

		if (!getRes.ok) {
			const errBody = await getRes.json().catch(() => ({})) as { error?: { message?: string } };
			const msg = errBody?.error?.message || `Vercel API error: ${getRes.status}`;
			return c.json({ error: msg }, 400);
		}

		const domainData = (await getRes.json()) as {
			records: Array<{ id: string; type: string; value: string }>;
		};

		// 2. Find all existing NS records
		const nsRecords = (domainData.records || []).filter((r) => r.type === "NS");

		// 3. Delete all existing NS records
		for (const record of nsRecords) {
			const deleteRes = await fetch(
				`https://api.vercel.com/v2/domains/${domain}/records/${record.id}`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${vercelToken}` },
				},
			);

			if (!deleteRes.ok) {
				const errBody = await deleteRes.json().catch(() => ({})) as { error?: { message?: string } };
				const msg = errBody?.error?.message || `Failed to delete NS record: ${deleteRes.status}`;
				return c.json({ error: msg }, 500);
			}
		}

		// 4. Create new NS records (one per nameserver)
		for (const ns of nameservers) {
			const createRes = await fetch(
				`https://api.vercel.com/v2/domains/${domain}/records`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${vercelToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ name: "@", type: "NS", value: ns }),
				},
			);

			if (!createRes.ok) {
				const errBody = await createRes.json().catch(() => ({})) as { error?: { message?: string } };
				const msg = errBody?.error?.message || `Failed to create NS record for ${ns}: ${createRes.status}`;
				return c.json({ error: msg }, 500);
			}
		}

		return c.json({ success: true });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `Failed to update Vercel NS records: ${msg}` }, 500);
	}
}

// ── Handler C: Check NS Propagation ────────────────────────────

export async function handleCheckNS(c: AppContext): Promise<Response> {
	try {
		const domain = c.req.param("domain");
		const expectedParam = c.req.query("expected");

		if (!domain) {
			return c.json({ error: "Domain is required" }, 400);
		}

		const expectedNS = expectedParam
			? expectedParam.split(",").map((ns) => ns.trim().toLowerCase())
			: [];

		// Query DNS-over-HTTPS for NS records
		const dohRes = await fetch(
			`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=NS`,
		);

		const dnsJson = (await dohRes.json()) as {
			Status: number;
			Answer?: Array<{ type: number; data: string }>;
		};

		// Extract NS records (type 2 = NS) and clean trailing dots
		const currentNS = (dnsJson.Answer || [])
			.filter((a) => a.type === 2)
			.map((a) => a.data.replace(/\.$/, "").toLowerCase());

		// Check if all expected NS are present in current NS
		const propagated =
			expectedNS.length > 0 &&
			expectedNS.every((ns) => currentNS.includes(ns));

		return c.json({ propagated, currentNS, expectedNS });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: `NS check failed: ${msg}` }, 500);
	}
}
