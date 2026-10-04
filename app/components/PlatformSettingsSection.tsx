// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { ChevronDown, ChevronRight, Settings, Link, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

// ── Platform Settings Section ────────────────────────────────────

export function PlatformSettingsSection() {
	const { t } = useTranslation("settings");
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
				title: t("platform.bothRequired"),
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
				title: t("platform.verificationFailed"),
				description: t("platform.invalidCredentials"),
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
				title: t("platform.saveFailed"),
				description: t("platform.databaseError"),
				variant: "error",
			});
			setIsSaving(false);
			return;
		}
		setIsSaving(false);
		setHasChanges(false);
		toastManager.add({
			title: t("platform.verified"),
			description: result.accountName
				? t("platform.accountSummary", {
						accountName: result.accountName,
						count: result.zones.length,
					})
				: t("platform.zonesFound", { count: result.zones.length }),
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
						{t("platformSettingsTitle")}
					</span>
					<span className="text-xs text-kumo-subtle ml-2">
						{t("platform.credentialsSubtitle")}
					</span>
				</div>
				<Badge variant={isConfigured ? "success" : "warning"}>
					{isLoading
						? t("platform.loading")
						: isConfigured
							? t("platform.configured")
							: t("platform.notConfigured")}
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
							{t("platform.apiTokenLabel")}
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
							{t("platform.accountIdLabel")}
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
								{t("platform.createToken")}
							</a>
						</p>
						<p className="text-xs text-kumo-subtle mt-2">
							{t("platform.autoSelectHint")}
						</p>
						<ul className="text-xs text-kumo-subtle list-disc list-inside mt-1 space-y-0.5">
							<li>
								{t("platform.permZoneEdit")}
							</li>
							<li>
								{t("platform.permDnsEdit")}
							</li>
							<li>
								{t("platform.permZoneSettingsEdit")}
							</li>
							<li>
								{t("platform.permEmailRoutingEdit")}
							</li>
						</ul>
						<p className="text-xs text-kumo-subtle mt-2">
							{t("platform.addMoreHint")}
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
							{isVerifying
								? t("platform.verifying")
								: isSaving
									? t("platform.saving")
									: t("platform.verifyAndSave")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
