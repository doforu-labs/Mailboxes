// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CaretRightIcon,
	GearSixIcon,
	LinkIcon,
	EyeIcon,
	EyeSlashIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import api from "~/services/api";
import type { Domain } from "~/types";

// ── CF Credentials (localStorage) ────────────────────────────────

const CF_CREDENTIALS_KEY = "mailboxes_cf_credentials";

interface CfCredentials {
	cfApiToken: string;
	cfAccountId: string;
}

function loadCfCredentials(): CfCredentials {
	try {
		const raw = localStorage.getItem(CF_CREDENTIALS_KEY);
		if (!raw) return { cfApiToken: "", cfAccountId: "" };
		const parsed = JSON.parse(raw);
		return {
			cfApiToken: parsed.cfApiToken ?? "",
			cfAccountId: parsed.cfAccountId ?? "",
		};
	} catch {
		return { cfApiToken: "", cfAccountId: "" };
	}
}

function saveCfCredentials(creds: CfCredentials): void {
	localStorage.setItem(CF_CREDENTIALS_KEY, JSON.stringify(creds));
}

// ── CF Token Template URL ────────────────────────────────────────

const CF_TOKEN_TEMPLATE_URL = (() => {
	const permissions = [
		{ key: "dns", type: "edit" },
		{ key: "zone_settings", type: "edit" },
	];
	return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
		JSON.stringify(permissions)
	)}&accountId=*&zoneId=all&name=Mailboxes%20Token`;
})();

// ── Domain Status Indicators ─────────────────────────────────────

function DomainStatusIndicators({ domain }: { domain: Domain }) {
	const isReceiving = !!domain.cf_zone_id;
	const isSending = !!domain.resend_api_key && domain.status === "verified";

	return (
		<div className="flex items-center gap-2 mt-1">
			<span
				className="inline-flex items-center gap-1 text-[11px] font-medium"
				title={
					isReceiving
						? "Email Routing active — CF-managed domain"
						: "No Cloudflare zone linked — Email Routing not configured"
				}
			>
				<span
					className={`inline-block h-1.5 w-1.5 rounded-full ${
						isReceiving ? "bg-green-500" : "bg-amber-400"
					}`}
				/>
				<span className={isReceiving ? "text-green-600" : "text-amber-600"}>
					Receiving
				</span>
			</span>
			<span
				className="inline-flex items-center gap-1 text-[11px] font-medium"
				title={
					isSending
						? "Resend API key configured and DNS verified"
						: !domain.resend_api_key
							? "No Resend API key — sending not configured"
							: "DNS not yet verified — sending unavailable"
				}
			>
				<span
					className={`inline-block h-1.5 w-1.5 rounded-full ${
						isSending ? "bg-green-500" : "bg-amber-400"
					}`}
				/>
				<span className={isSending ? "text-green-600" : "text-amber-600"}>
					Sending
				</span>
			</span>
		</div>
	);
}

// ── Platform Settings ────────────────────────────────────────────

function PlatformSettingsSection() {
	const toastManager = useKumoToastManager();
	const [isExpanded, setIsExpanded] = useState(false);
	const [creds, setCreds] = useState<CfCredentials>(loadCfCredentials);
	const [showToken, setShowToken] = useState(false);
	const [showAccountId, setShowAccountId] = useState(false);
	const [hasChanges, setHasChanges] = useState(false);

	const isConfigured = !!(creds.cfApiToken.trim() && creds.cfAccountId.trim());

	// Track changes
	useEffect(() => {
		const saved = loadCfCredentials();
		setHasChanges(
			creds.cfApiToken !== saved.cfApiToken ||
				creds.cfAccountId !== saved.cfAccountId
		);
	}, [creds]);

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
		try {
			await api.detectCfDomains({
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

		// Save after verification
		setIsSaving(true);
		saveCfCredentials(creds);
		setIsSaving(false);
		setHasChanges(false);
		toastManager.add({ title: "Cloudflare credentials verified successfully" });
	};

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden mb-6">
			{/* Collapsed header */}
			<button
				type="button"
				className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-kumo-fill/50"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-default">
					<GearSixIcon size={16} />
				</div>
				<div className="min-w-0 flex-1">
					<span className="text-sm font-medium text-kumo-default">
						Platform Settings
					</span>
					<span className="text-xs text-kumo-subtle ml-2">
						Cloudflare API credentials for domain detection
					</span>
				</div>
				<Badge variant={isConfigured ? "success" : "warning"}>
					{isConfigured ? "Configured" : "Not configured"}
				</Badge>
				{isExpanded ? (
					<CaretDownIcon size={16} className="text-kumo-muted shrink-0" />
				) : (
					<CaretRightIcon size={16} className="text-kumo-muted shrink-0" />
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
								{showToken ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
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
									<EyeSlashIcon size={16} />
								) : (
									<EyeIcon size={16} />
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
								<LinkIcon size={12} />
								Create a pre-configured token →
							</a>
						</p>
						<p className="text-xs text-kumo-subtle mt-2">
							Required permissions / 需要的权限:
						</p>
						<ul className="text-xs text-kumo-subtle list-disc list-inside mt-1 space-y-0.5">
							<li>
								Zone: DNS Edit / 区域: DNS 编辑
							</li>
							<li>
								Zone: Zone Settings Edit / 区域: 区域设置 编辑
							</li>
							<li>
								Zone: Email Routing Rules Edit / 区域: 电子邮件路由规则 编辑
							</li>
						</ul>
						<p className="text-xs text-kumo-subtle mt-2">
							The link above pre-fills DNS + Zone Settings permissions. Click "Add more" / "添加更多" to also add Email Routing Rules, then copy the token here.
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

// ── Page ───────────────────────────────────────────────────────────

export function meta() {
	return [{ title: "Settings — Mailboxes" }];
}

export default function SettingsRoute() {
	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				{/* Header */}
				<div className="mb-8">
					<div className="mb-2">
						<RouterLink
							to="/"
							className="text-sm text-kumo-accent hover:text-kumo-accent/80 transition-colors"
						>
							← Back to Mailboxes
						</RouterLink>
					</div>
					<h1 className="text-2xl font-bold text-kumo-default">
						Settings
					</h1>
				</div>

				{/* Platform Settings */}
				<PlatformSettingsSection />
			</div>
		</div>
	);
}
