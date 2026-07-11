// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { ChevronDown, ChevronRight, Eye, EyeOff, Globe } from "lucide-react";
import { useEffect, useState } from "react";
import api from "~/services/api";
import {
	loadVercelCredentials,
	saveVercelCredentials,
	type VercelCredentials,
} from "~/components/PlatformSettingsSection";

// ── Provider Definitions ─────────────────────────────────────────

interface ProviderDef {
	id: string;
	name: string;
	description: string;
	icon: React.ReactNode;
	colorClass: string;
	fields: FieldDef[];
	storageKeys: string[];
	loadCreds: () => Promise<Record<string, string>>;
	saveCreds: (creds: Record<string, string>) => Promise<void>;
}

interface FieldDef {
	key: string;
	label: string;
	type: "password" | "text";
	placeholder?: string;
	optional?: boolean;
}

// ── Generic credential storage via D1 platform_settings ──────────

function makeStorageHelpers(prefix: string, keys: string[]) {
	return {
		loadCreds: async (): Promise<Record<string, string>> => {
			const results = await Promise.all(
				keys.map((k) => api.getPlatformSetting(`${prefix}_${k}`)),
			);
			const creds: Record<string, string> = {};
			keys.forEach((k, i) => {
				creds[k] = results[i].value ?? "";
			});
			return creds;
		},
		saveCreds: async (creds: Record<string, string>): Promise<void> => {
			await Promise.all(
				keys.map((k) =>
					api.setPlatformSetting(`${prefix}_${k}`, creds[k] || ""),
				),
			);
		},
	};
}

// ── Provider configs ─────────────────────────────────────────────

const PROVIDERS: ProviderDef[] = [
	{
		id: "vercel",
		name: "Vercel",
		description: "API Token for DNS management",
		icon: <Globe size={16} />,
		colorClass: "bg-violet-500/10 text-violet-500",
		fields: [
			{ key: "apiToken", label: "API Token", type: "password", placeholder: "••••••••••••••••" },
			{ key: "teamId", label: "Team ID", type: "text", placeholder: "Leave empty for personal accounts", optional: true },
		],
		storageKeys: ["vercel_api_token", "vercel_team_id"],
		loadCreds: async () => {
			const c = await loadVercelCredentials();
			return { apiToken: c.vercelApiToken, teamId: c.vercelTeamId };
		},
		saveCreds: async (creds) => {
			await saveVercelCredentials({
				vercelApiToken: creds.apiToken || "",
				vercelTeamId: creds.teamId || "",
			});
		},
	},

	{
		id: "gandi",
		name: "Gandi",
		description: "API Key for DNS management (LiveDNS)",
		icon: <Globe size={16} />,
		colorClass: "bg-emerald-500/10 text-emerald-500",
		fields: [
			{ key: "apiToken", label: "API Key (Personal Access Token)", type: "password", placeholder: "••••••••••••••••" },
		],
		storageKeys: ["gandi_api_token"],
		...makeStorageHelpers("gandi", ["api_token"]),
	},
	{
		id: "porkbun",
		name: "Porkbun",
		description: "API Key + Secret for DNS management",
		icon: <Globe size={16} />,
		colorClass: "bg-pink-500/10 text-pink-500",
		fields: [
			{ key: "apiKey", label: "API Key", type: "password", placeholder: "pk1_..." },
			{ key: "secretApiKey", label: "Secret API Key", type: "password", placeholder: "sk1_..." },
		],
		storageKeys: ["porkbun_api_key", "porkbun_secret_api_key"],
		...makeStorageHelpers("porkbun", ["api_key", "secret_api_key"]),
	},
	{
		id: "name",
		name: "Name.com",
		description: "Username + API Token for DNS management",
		icon: <Globe size={16} />,
		colorClass: "bg-orange-500/10 text-orange-500",
		fields: [
			{ key: "username", label: "Username", type: "text", placeholder: "Your name.com username" },
			{ key: "apiToken", label: "API Token", type: "password", placeholder: "••••••••••••••••" },
		],
		storageKeys: ["namecom_username", "namecom_api_token"],
		...makeStorageHelpers("namecom", ["username", "api_token"]),
	},
	{
		id: "dnsimple",
		name: "DNSimple",
		description: "API Token for DNS management",
		icon: <Globe size={16} />,
		colorClass: "bg-indigo-500/10 text-indigo-500",
		fields: [
			{ key: "apiToken", label: "API Token", type: "password", placeholder: "••••••••••••••••" },
		],
		storageKeys: ["dnsimple_api_token"],
		...makeStorageHelpers("dnsimple", ["api_token"]),
	},
];

// ── Generic Provider Form ────────────────────────────────────────

function ProviderForm({
	provider,
	onClose,
}: {
	provider: ProviderDef;
	onClose?: () => void;
}) {
	const toastManager = useKumoToastManager();
	const [creds, setCreds] = useState<Record<string, string>>({});
	const [showFields, setShowFields] = useState<Record<string, boolean>>({});
	const [isSaving, setIsSaving] = useState(false);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		provider.loadCreds().then((saved) => {
			setCreds(saved);
			setIsLoading(false);
		});
	}, [provider]);

	const handleSave = async () => {
		// Check required fields
		for (const field of provider.fields) {
			if (!field.optional && !creds[field.key]?.trim()) {
				toastManager.add({
					title: `${field.label} is required`,
					variant: "error",
				});
				return;
			}
		}
		setIsSaving(true);
		try {
			await provider.saveCreds(creds);
		} catch {
			toastManager.add({
				title: `Failed to save ${provider.name} credentials`,
				description: "An error occurred while saving. Please try again.",
				variant: "error",
			});
			setIsSaving(false);
			return;
		}
		setIsSaving(false);
		toastManager.add({ title: `${provider.name} credentials saved successfully` });
		onClose?.();
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-6">
				<span className="text-sm text-kumo-subtle">Loading…</span>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{provider.fields.map((field) => (
				<div key={field.key}>
					<label className="mb-1 block text-sm font-medium text-kumo-default">
						{field.label}{" "}
						{field.optional && (
							<span className="text-kumo-muted font-normal">(optional)</span>
						)}
					</label>
					<div className="relative">
						<input
							type={field.type === "password" && !showFields[field.key] ? "password" : "text"}
							className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 pr-10 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
							placeholder={field.placeholder}
							value={creds[field.key] || ""}
							onChange={(e) =>
								setCreds((c) => ({ ...c, [field.key]: e.target.value }))
							}
						/>
						{field.type === "password" && (
							<button
								type="button"
								className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-muted hover:text-kumo-default"
								onClick={() =>
									setShowFields((s) => ({ ...s, [field.key]: !s[field.key] }))
								}
							>
								{showFields[field.key] ? <EyeOff size={16} /> : <Eye size={16} />}
							</button>
						)}
					</div>
				</div>
			))}
			<div className="flex justify-end">
				<Button
					variant="primary"
					size="sm"
					onClick={handleSave}
					disabled={
						isSaving ||
						provider.fields.some(
							(f) => !f.optional && !creds[f.key]?.trim(),
						)
					}
					loading={isSaving}
				>
					{isSaving ? "Saving…" : "Save"}
				</Button>
			</div>
		</div>
	);
}

// ── Provider Card ────────────────────────────────────────────────

function ProviderCard({ provider }: { provider: ProviderDef }) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [isConfigured, setIsConfigured] = useState<boolean | null>(null);

	useEffect(() => {
		provider.loadCreds().then((creds) => {
			const configured = provider.fields.some(
				(f) => !f.optional && creds[f.key]?.trim(),
			);
			setIsConfigured(configured);
		});
	}, [provider]);

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			<button
				type="button"
				className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-kumo-fill/50"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div
					className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${provider.colorClass}`}
				>
					{provider.icon}
				</div>
				<div className="min-w-0 flex-1">
					<span className="text-sm font-medium text-kumo-default">
						{provider.name}
					</span>
					<span className="text-xs text-kumo-subtle ml-2">
						{provider.description}
					</span>
				</div>
				<Badge variant={isConfigured === true ? "success" : isConfigured === false ? "warning" : "default"}>
					{isConfigured === null
						? "Loading…"
						: isConfigured
							? "Configured"
							: "Not configured"}
				</Badge>
				{isExpanded ? (
					<ChevronDown size={16} className="text-kumo-muted shrink-0" />
				) : (
					<ChevronRight size={16} className="text-kumo-muted shrink-0" />
				)}
			</button>

			{isExpanded && (
				<div className="border-t border-kumo-line px-5 py-5">
					<ProviderForm provider={provider} onClose={() => setIsConfigured(true)} />
				</div>
			)}
		</div>
	);
}

// ── Credentials Section ──────────────────────────────────────────

export function CredentialsSection() {
	return (
		<div className="space-y-3">
			{PROVIDERS.map((provider) => (
				<ProviderCard key={provider.id} provider={provider} />
			))}
		</div>
	);
}
