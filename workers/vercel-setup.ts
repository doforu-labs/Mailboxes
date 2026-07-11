// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Vercel → Cloudflare domain migration helpers.
 *
 * Five endpoints:
 *   POST /api/v1/setup/cloudflare/verify-token  – verify CF token permissions
 *   POST /api/v1/setup/cloudflare/add-zone      – add zone to CF
 *   POST /api/v1/setup/vercel/update-ns         – replace NS in Vercel
 *   GET  /api/v1/setup/check-ns/:domain         – check NS propagation
 *   GET  /api/v1/setup/check-zone-status/:zoneId – check CF zone activation
 */

import type { Context } from "hono";
import type { Env } from "./types";

type AppContext = Context<{ Bindings: Env }>;

// ── Handler: Verify CF Token Permissions ──────────────────────

export async function handleVerifyCfToken(c: AppContext): Promise<Response> {
	try {
		const { cfApiToken } = (await c.req.json()) as { cfApiToken: string };

		if (!cfApiToken) {
			return c.json({ error: "Missing required field: cfApiToken" }, 400);
		}

		// Call CF API to verify token is valid
		const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
			method: "GET",
			headers: { Authorization: "Bearer " + cfApiToken },
		});

		const verifyData = (await verifyRes.json()) as {
			success: boolean;
			errors: Array<{ message: string }>;
		};

		if (!verifyData.success) {
			const msg = verifyData.errors?.[0]?.message || "Token 无效";
			return c.json({ valid: false, error: "API Token 无效: " + msg }, 400);
		}

		// Verify Zone list access (proves Zone:Edit permission exists)
		const zonesRes = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=1", {
			headers: { Authorization: "Bearer " + cfApiToken },
		});
		const zonesData = (await zonesRes.json()) as { success: boolean };

		if (!zonesData.success) {
			return c.json({
				valid: false,
				error: "API Token 缺少 Zone 权限。请在 Cloudflare Dashboard → API Tokens 中编辑 Token，添加：\n资源: Zone  权限: Edit",
			}, 400);
		}

		return c.json({ valid: true });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ valid: false, error: "Token verification failed: " + msg }, 500);
	}
}

// ── Handler A: Add Zone to Cloudflare ─────────────────────────

export async function handleAddCloudflareZone(c: AppContext): Promise<Response> {
	try {
		const { domain, cfApiToken } = (await c.req.json()) as {
			domain: string;
			cfApiToken: string;
		};

		if (!domain || !cfApiToken) {
			return c.json({ error: "Missing required fields: domain, cfApiToken" }, 400);
		}

		// Create zone in Cloudflare (type: "full" = bring your own NS)
		const res = await fetch("https://api.cloudflare.com/client/v4/zones", {
			method: "POST",
			headers: {
				Authorization: "Bearer " + cfApiToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: domain,
				type: "full",
				jump_start: false,
			}),
		});

		const data = (await res.json()) as {
			success: boolean;
			errors: Array<{ code: number; message: string }>;
			result: { id: string; name_servers: string[] };
		};

		if (!data.success) {
			const err = data.errors?.[0];
			// Zone already exists — return existing zone info
			if (err?.code === 7103 || err?.code === 1061) {
				const zonesRes = await fetch(
					"https://api.cloudflare.com/client/v4/zones?name=" + encodeURIComponent(domain),
					{ headers: { Authorization: "Bearer " + cfApiToken } },
				);
				const zonesData = (await zonesRes.json()) as {
					success: boolean;
					result: Array<{ id: string; name_servers: string[] }>;
				};
				if (zonesData.success && zonesData.result?.length > 0) {
					const zone = zonesData.result[0];
					return c.json({ zoneId: zone.id, nameservers: zone.name_servers });
				}
			}
			return c.json({ error: err?.message || "Cloudflare zone creation failed" }, 400);
		}

		return c.json({
			zoneId: data.result.id,
			nameservers: data.result.name_servers,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: "Failed to add Cloudflare zone: " + msg }, 500);
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

		// ── Strategy 1: Domain registered on Vercel → use Registrar API ──
		// The Registrar API supports changing NS for root domains purchased through Vercel
		// First get teamId (required for team-owned domains)
		const userRes = await fetch("https://api.vercel.com/v2/user", {
			headers: { Authorization: "Bearer " + vercelToken },
		});
		let teamId = "";
		if (userRes.ok) {
			const userData = (await userRes.json()) as { user?: { defaultTeamId?: string } };
			teamId = userData.user?.defaultTeamId || "";
		}

		const v1Url = "https://api.vercel.com/v1/domains/" + domain + (teamId ? "?teamId=" + teamId : "");
		const v1DomainRes = await fetch(v1Url, {
			headers: { Authorization: "Bearer " + vercelToken },
		});
		let isVercelRegistered = false;
		if (v1DomainRes.ok) {
			const v1Body = (await v1DomainRes.json()) as { domain?: { boughtAt?: string | number; registrar?: string } };
			const dom = v1Body.domain || v1Body as unknown as { boughtAt?: string | number; registrar?: string };
			isVercelRegistered = !!(dom.boughtAt || (dom.registrar && dom.registrar !== "none"));
		}

		if (isVercelRegistered) {
			// Use Vercel Registrar API to change NS (supports root domains)
			const regRes = await fetch(
				"https://api.vercel.com/v1/registrar/domains/" + domain + "/nameservers",
				{
					method: "PATCH",
					headers: {
						Authorization: "Bearer " + vercelToken,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ nameservers }),
				},
			);

			if (regRes.ok || regRes.status === 204) {
				return c.json({ success: true, method: "registrar", nameservers });
			}

			// If registrar API fails, try subdomain NS record approach as fallback
			console.warn("Registrar API failed (" + regRes.status + "), trying fallback");
		}

		// ── Strategy 2: External domain → check if root or subdomain ──
		const parts = domain.split(".");
		const isRootDomain = parts.length <= 2 || (parts.length === 3 && parts[0] === "www");
		if (isRootDomain) {
			return c.json({
				error: "root_domain_ns",
				nameservers,
				domain,
				detail: "域名未在 Vercel 购买，无法通过 API 修改根域名 NS。请前往域名注册商控制台手动修改。",
			}, 400);
		}

		// ── Strategy 3: Subdomain on external domain → use Vercel DNS records API ──
		const getRes = await fetch(
			"https://api.vercel.com/v5/domains/" + domain + "/records?limit=100",
			{
				method: "GET",
				headers: { Authorization: "Bearer " + vercelToken },
			},
		);

		if (!getRes.ok) {
			const errBody = await getRes.json().catch(() => ({})) as { error?: { message?: string } };
			const msg = errBody?.error?.message || "Vercel API error: " + getRes.status;
			return c.json({ error: msg }, 400);
		}

		const recordsData = (await getRes.json()) as {
			records: Array<{ id: string; type: string; name: string; value: string }>;
		};

		// 2. Find all existing NS records
		const nsRecords = (recordsData.records || []).filter((r) => r.type === "NS");

		// 3. Delete all existing NS records (skip system-managed ones that fail)
		for (const record of nsRecords) {
			const deleteRes = await fetch(
				"https://api.vercel.com/v2/domains/" + domain + "/records/" + record.id,
				{
					method: "DELETE",
					headers: { Authorization: "Bearer " + vercelToken },
				},
			);

			// System-managed records cannot be deleted — log and continue
			if (!deleteRes.ok) {
				console.warn("Skipping NS record " + record.id + " (" + record.name + "=" + record.value + "): system-managed or protected");
			}
		}

		// 4. Create new NS records (one per nameserver)
		for (const ns of nameservers) {
			const createRes = await fetch(
				"https://api.vercel.com/v2/domains/" + domain + "/records",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer " + vercelToken,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ name: "@", type: "NS", value: ns }),
				},
			);

			if (!createRes.ok) {
				const errBody = await createRes.json().catch(() => ({})) as { error?: { message?: string } };
				const msg = errBody?.error?.message || "Failed to create NS record for " + ns + ": " + createRes.status;
				return c.json({ error: msg }, 500);
			}
		}

		return c.json({ success: true });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: "Failed to update Vercel NS records: " + msg }, 500);
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
			"https://dns.google/resolve?name=" + encodeURIComponent(domain) + "&type=NS",
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
		return c.json({ error: "NS check failed: " + msg }, 500);
	}
}

// ── Handler D: Check CF Zone Activation Status ────────────────

export async function handleCheckZoneStatus(c: AppContext): Promise<Response> {
	try {
		const zoneId = c.req.param("zoneId");
		const cfApiToken = c.req.query("cfApiToken");

		if (!zoneId || !cfApiToken) {
			return c.json({ error: "Missing required params: zoneId, cfApiToken" }, 400);
		}

		// Check zone status via CF API
		const res = await fetch(
			"https://api.cloudflare.com/client/v4/zones/" + zoneId,
			{
				method: "GET",
				headers: { Authorization: "Bearer " + cfApiToken },
			},
		);

		const data = (await res.json()) as {
			success: boolean;
			result: { id: string; status: string; name: string };
		};

		if (!data.success) {
			return c.json({ error: "Failed to check zone status" }, 400);
		}

		return c.json({
			zoneId: data.result.id,
			status: data.result.status, // "active" | "pending" | "moved"
			name: data.result.name,
			active: data.result.status === "active",
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "Unknown error";
		return c.json({ error: "Zone status check failed: " + msg }, 500);
	}
}
