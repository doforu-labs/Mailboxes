// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { ChevronDown, ChevronRight, Settings, Link, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import api from "~/services/api";

// ── CF Credentials (D1 via API) ──────────────────────────────────

const CF_API_TOKEN_KEY = "cf_api_token";
const CF_ACCOUNT_ID_KEY = "cf_account_id";

export interface CfCredentials {
	cfApiToken: string;
	cfAccountId: string;
}

const LOCAL_STORAGE_KEY = "mailboxes_cf_credentials";

export async function loadCfCredentials(): Promise<CfCredentials> {
	try {
		const [tokenRes, accountRes] = await Promise.all([
			api.getPlatformSetting(CF_API_TOKEN_KEY),
			api.getPlatformSetting(CF_ACCOUNT_ID_KEY),
		]);
		const creds = {
			cfApiToken: tokenRes.value ?? "",
			cfAccountId: accountRes.value ?? "",
		};

		// One-time migration: if D1 is empty but localStorage has old data, migrate it
		if (!creds.cfApiToken && !creds.cfAccountId) {
			try {
				const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
				if (raw) {
					const parsed = JSON.parse(raw) as CfCredentials;
					if (parsed.cfApiToken && parsed.cfAccountId) {
						await saveCfCredentials(parsed);
						localStorage.removeItem(LOCAL_STORAGE_KEY);
						return parsed;
					}
				}
			} catch {
				// Ignore localStorage errors
			}
		}

		return creds;
	} catch {
		return { cfApiToken: "", cfAccountId: "" };
	}
}

export async function saveCfCredentials(creds: CfCredentials): Promise<void> {
	await Promise.all([
		api.setPlatformSetting(CF_API_TOKEN_KEY, creds.cfApiToken),
		api.setPlatformSetting(CF_ACCOUNT_ID_KEY, creds.cfAccountId),
	]);
}

// ── CF Token Template URL ────────────────────────────────────────

export const CF_TOKEN_TEMPLATE_URL = (() => {
	const permissions = [
		{ key: "dns", type: "edit" },
		{ key: "zone", type: "edit" },
		{ key: "zone_settings", type: "edit" },
		{ key: "email_routing", type: "edit" },
	];
	return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
		JSON.stringify(permissions)
	)}&accountId=*&zoneId=all&name=Mailboxes%20Token`;
})();

// ── Vercel Credentials (D1 via API) ──────────────────────────────
// Kept here as shared utilities. UI is in CredentialsSection.

const VERCEL_API_TOKEN_KEY = "vercel_api_token";
const VERCEL_TEAM_ID_KEY = "vercel_team_id";

export interface VercelCredentials {
	vercelApiToken: string;
	vercelTeamId: string;
}

export async function loadVercelCredentials(): Promise<VercelCredentials> {
	try {
		const [tokenRes, teamRes] = await Promise.all([
			api.getPlatformSetting(VERCEL_API_TOKEN_KEY),
			api.getPlatformSetting(VERCEL_TEAM_ID_KEY),
		]);
		return {
			vercelApiToken: tokenRes.value ?? "",
			vercelTeamId: teamRes.value ?? "",
		};
	} catch {
		return { vercelApiToken: "", vercelTeamId: "" };
	}
}

export async function saveVercelCredentials(creds: VercelCredentials): Promise<void> {
	await Promise.all([
		api.setPlatformSetting(VERCEL_API_TOKEN_KEY, creds.vercelApiToken),
		api.setPlatformSetting(VERCEL_TEAM_ID_KEY, creds.vercelTeamId),
	]);
}

// ── Platform Settings Section ────────────────────────────────────

export function PlatformSettingsSection() {
	const toastManager = useKumoToastManager();
	const [isExpanded, setIsExpanded] = useState(false);
	const [creds, setCreds] = useState<CfCredentials>({ cfApiToken: "", cfAccountId: "" });
	const [showToken, setShowToken] = useState(false);
	const [showAccountId, setShowAccountId] = useState(false);
	const [hasChanges, setHasChanges] = useState(false);
	const [isLoading, setIsLoading] = useState(true);

	// Load credentials from D1 on mount
	useEffect(() => {
		loadCfCredentials().then((savedCf) => {
			setCreds(savedCf);
			setIsLoading(false);
		});
	}, []);

	const isConfigured = !!(creds.cfApiToken.trim() && creds.cfAccountId.trim());

	// Track changes against saved state
	useEffect(() => {
		if (isLoading) return;
		loadCfCredentials().then((savedCf) => {
			setHasChanges(
				creds.cfApiToken !== savedCf.cfApiToken ||
					creds.cfAccountId !== savedCf.cfAccountId
			);
		});
	}, [creds, isLoading]);

	const [isVerifying, setIsVerifying] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const handleSave = async () => {
		if (!creds.cfApiToken.trim() || !creds.cfAccountId.trim()) {
			toastManager.add({
				title: "Both API Token and Account ID are required",
				variant: "error",
			});
			return;
		}

		// Verify credentials before saving
		setIsVerifying(true);
		let result;
		try {
			result = await api.detectCfDomains({
				cfApiToken: creds.cfApiToken.trim(),
				cfAccountId: creds.cfAccountId.trim(),
			});
		} catch {
			toastManager.add({
				title: "Verification failed",
				description: "The provided Cloudflare API Token or Account ID is invalid. Please check and try again.",
				variant: "error",
			});
			setIsVerifying(false);
			return;
		}
		setIsVerifying(false);

		// Save to D1 via API
		setIsSaving(true);
		try {
			await saveCfCredentials(creds);
		} catch {
			toastManager.add({
				title: "Failed to save credentials",
				description: "An error occurred while saving to the database. Please try again.",
				variant: "error",
			});
			setIsSaving(false);
			return;
		}
		setIsSaving(false);
		setHasChanges(false);
		toastManager.add({
			title: "Cloudflare credentials verified successfully",
			description: result.accountName
				? `Account: ${result.accountName} · ${result.zones.length} zone(s) found`
				: `${result.zones.length} zone(s) found`,
		});
	};

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			{/* Collapsed header */}
			<button
				type="button"
				className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-kumo-fill/50"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-default">
					<Settings size={16} />
				</div>
				<div className="min-w-0 flex-1">
					<span className="text-sm font-medium text-kumo-default">
						Platform Settings
					</span>
					<span className="text-xs text-kumo-subtle ml-2">
						Cloudflare API credentials
					</span>
				</div>
				<Badge variant={isConfigured ? "success" : "warning"}>
					{isLoading ? "Loading…" : isConfigured ? "Configured" : "Not configured"}
				</Badge>
				{isExpanded ? (
					<ChevronDown size={16} className="text-kumo-muted shrink-0" />
				) : (
					<ChevronRight size={16} className="text-kumo-muted shrink-0" />
				)}
			</button>

			{/* Expanded content */}
			{isExpanded && (
				<div className="border-t border-kumo-line px-5 py-5 space-y-4">
					<div>
						<label className="mb-1 block text-sm font-medium text-kumo-default">
							Cloudflare API Token
						</label>
						<div className="relative">
							<input
								type={showToken ? "text" : "password"}
								className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 pr-10 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
								placeholder="••••••••••••••••••••••••••••••••••••••••"
								value={creds.cfApiToken}
								onChange={(e) =>
									setCreds((c) => ({ ...c, cfApiToken: e.target.value }))
								}
							/>
							<button
								type="button"
								className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-muted hover:text-kumo-default"
								onClick={() => setShowToken(!showToken)}
							>
								{showToken ? <EyeOff size={16} /> : <Eye size={16} />}
							</button>
						</div>
					</div>
					<div>
						<label className="mb-1 block text-sm font-medium text-kumo-default">
							Cloudflare Account ID
						</label>
						<div className="relative">
							<input
								type={showAccountId ? "text" : "password"}
								className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 pr-10 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
								placeholder="••••••••••••••••••••••••••••••••••••••••"
								value={creds.cfAccountId}
								onChange={(e) =>
									setCreds((c) => ({ ...c, cfAccountId: e.target.value }))
								}
							/>
							<button
								type="button"
								className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-muted hover:text-kumo-default"
								onClick={() => setShowAccountId(!showAccountId)}
							>
								{showAccountId ? (
									<EyeOff size={16} />
								) : (
									<Eye size={16} />
								)}
							</button>
						</div>
					</div>

					<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
						<p className="text-xs text-kumo-subtle">
							<a
								href={CF_TOKEN_TEMPLATE_URL}
								target="_blank"
								rel="noopener noreferrer"
								className="text-blue-600 underline font-medium inline-flex items-center gap-1"
							>
								<Link size={12} />
								创建预配置 Token →
							</a>
						</p>
						<p className="text-xs text-kumo-subtle mt-2">
							点击上方链接会自动勾选前 3 项权限。还需手动添加第 4 项：
						</p>
						<ul className="text-xs text-kumo-subtle list-disc list-inside mt-1 space-y-0.5">
							<li>
								Zone Edit — 创建域名区域（必需）
							</li>
							<li>
								DNS Edit — 管理 DNS 记录
							</li>
							<li>
								Zone Settings Edit — 区域设置
							</li>
							<li>
								Email Routing Rules Edit — 邮件路由（⚠️ 需手动添加）
							</li>
						</ul>
						<p className="text-xs text-kumo-subtle mt-2">
							链接已自动勾选前 3 项权限。请额外点击"添加更多"，手动添加：
								区域 → 电子邮件路由规则 → 编辑
								然后复制 Token 粘贴到上方输入框。
						</p>
					</div>

					<div className="flex justify-end">
						<Button
							variant="primary"
							size="sm"
							onClick={handleSave}
							disabled={isVerifying || isSaving || !creds.cfApiToken.trim() || !creds.cfAccountId.trim()}
							loading={isVerifying || isSaving}
						>
							{isVerifying ? "Verifying…" : isSaving ? "Saving…" : "Verify & Save"}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
