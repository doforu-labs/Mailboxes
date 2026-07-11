// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import { ChevronDown, ChevronRight, Eye, EyeOff, Key, Globe } from "lucide-react";
import { useEffect, useState } from "react";
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
	colorClass: string; // background color for icon
}

const PROVIDERS: ProviderDef[] = [
	{
		id: "vercel",
		name: "Vercel",
		description: "API Token for DNS management",
		icon: <Globe size={16} />,
		colorClass: "bg-violet-500/10 text-violet-500",
	},
	// Future providers can be added here:
	// {
	//     id: "digitalocean",
	//     name: "DigitalOcean",
	//     description: "API Token for DNS management",
	//     icon: <Globe size={16} />,
	//     colorClass: "bg-blue-500/10 text-blue-500",
	// },
];

// ── Vercel Form ──────────────────────────────────────────────────

function VercelForm({ onClose }: { onClose?: () => void }) {
	const toastManager = useKumoToastManager();
	const [creds, setCreds] = useState<VercelCredentials>({
		vercelApiToken: "",
		vercelTeamId: "",
	});
	const [showToken, setShowToken] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		loadVercelCredentials().then((saved) => {
			setCreds(saved);
			setIsLoading(false);
		});
	}, []);

	const handleSave = async () => {
		if (!creds.vercelApiToken.trim()) {
			toastManager.add({
				title: "Vercel API Token is required",
				variant: "error",
			});
			return;
		}
		setIsSaving(true);
		try {
			await saveVercelCredentials(creds);
		} catch {
			toastManager.add({
				title: "Failed to save Vercel credentials",
				description: "An error occurred while saving. Please try again.",
				variant: "error",
			});
			setIsSaving(false);
			return;
		}
		setIsSaving(false);
		toastManager.add({ title: "Vercel credentials saved successfully" });
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
			<div>
				<label className="mb-1 block text-sm font-medium text-kumo-default">
					Vercel API Token
				</label>
				<div className="relative">
					<input
						type={showToken ? "text" : "password"}
						className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 pr-10 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
						placeholder="••••••••••••••••••••••••••••••••••••••••"
						value={creds.vercelApiToken}
						onChange={(e) =>
							setCreds((c) => ({ ...c, vercelApiToken: e.target.value }))
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
					Team ID <span className="text-kumo-muted font-normal">(optional)</span>
				</label>
				<input
					type="text"
					className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
					placeholder="Leave empty for personal accounts"
					value={creds.vercelTeamId}
					onChange={(e) =>
						setCreds((c) => ({ ...c, vercelTeamId: e.target.value }))
					}
				/>
			</div>
			<div className="flex justify-end">
				<Button
					variant="primary"
					size="sm"
					onClick={handleSave}
					disabled={isSaving || !creds.vercelApiToken.trim()}
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
		if (provider.id === "vercel") {
			loadVercelCredentials().then((creds) => {
				setIsConfigured(!!creds.vercelApiToken.trim());
			});
		}
	}, [provider.id]);

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
					{provider.id === "vercel" && (
						<VercelForm onClose={() => setIsConfigured(true)} />
					)}
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
