// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Badge,
	Button,
	Dialog,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ChevronDown,
	ChevronRight,
	Settings,
	Globe,
	Link,
	Plus,
	Trash2,
	AtSign,
	Eye,
	EyeOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import api from "~/services/api";
import {
	useDeleteDomain,
	useDomains,
} from "~/queries/domains";
import type { Domain } from "~/types";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import { CatchAllDialog } from "~/components/CatchAllDialog";

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

		// Save after verification
		setIsSaving(true);
		saveCfCredentials(creds);
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
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden mb-6">
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
						Cloudflare API credentials for domain detection
					</span>
				</div>
				<Badge variant={isConfigured ? "success" : "warning"}>
					{isConfigured ? "Configured" : "Not configured"}
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
	return [{ title: "Domains — Mailboxes" }];
}

export default function DomainsRoute() {
	const toastManager = useKumoToastManager();
	const { data: domains = [], isFetched: domainsFetched } = useDomains();
	const deleteDomain = useDeleteDomain();

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [domainToDelete, setDomainToDelete] = useState<Domain | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [isCatchAllOpen, setIsCatchAllOpen] = useState(false);
	const [catchAllDomain, setCatchAllDomain] = useState<Domain | null>(null);

	const handleDelete = async () => {
		if (!domainToDelete) return;
		setIsDeleting(true);
		try {
			await deleteDomain.mutateAsync(domainToDelete.id);
			toastManager.add({ title: "Domain deleted" });
			setIsDeleteOpen(false);
			setDomainToDelete(null);
		} catch {
			toastManager.add({
				title: "Failed to delete domain",
				variant: "error",
			});
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				{/* Header */}
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<div>
							<div className="mb-2">
								<RouterLink
									to="/"
									className="text-sm text-kumo-accent hover:text-kumo-accent/80 transition-colors"
								>
									← Back to Mailboxes
								</RouterLink>
							</div>
							<h1 className="text-2xl font-bold text-kumo-default">
								Domains
							</h1>
						</div>
						<Button
							variant="primary"
							icon={<Plus size={16} />}
							onClick={() => setIsCreateOpen(true)}
						>
							Add Domain
						</Button>
					</div>
				</div>

				{/* Platform Settings */}
				<PlatformSettingsSection />

				{/* Domain List */}
				{!domainsFetched ? (
					<div className="flex justify-center py-16">
						<Loader size="lg" />
					</div>
				) : domains.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{domains.map((domain, idx) => (
							<RouterLink
								key={domain.id}
								to={`/domains/${domain.id}`}
								className={`group flex items-center gap-4 px-5 py-4 transition-colors no-underline ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									<Globe size={18} />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-kumo-default truncate">
											{domain.name}
										</span>
									</div>
									<div className="text-xs text-kumo-subtle mt-0.5">
										Added{" "}
										{new Date(domain.created_at).toLocaleDateString(undefined, {
											year: "numeric",
											month: "short",
											day: "numeric",
										})}
									</div>
									<DomainFullStatus domain={domain} />
									{domain.catch_all_mailbox && (
										<div className="text-xs text-kumo-accent mt-0.5">
											Catch-all: {domain.catch_all_mailbox}
										</div>
									)}
								</div>
								<Button
									variant="ghost"
									size="sm"
									shape="square"
									icon={<AtSign size={16} />}
									aria-label={`Catch-all for ${domain.name}`}
									title={domain.catch_all_mailbox ? `Catch-all: ${domain.catch_all_mailbox}` : "Set catch-all mailbox"}
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setCatchAllDomain(domain);
										setIsCatchAllOpen(true);
									}}
								/>
								<Button
									variant="ghost"
									size="sm"
									shape="square"
									icon={<Trash2 size={16} />}
									aria-label={`Delete domain ${domain.name}`}
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										setDomainToDelete(domain);
										setIsDeleteOpen(true);
									}}
								/>
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<Globe
									size={48}
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No domains yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								Add a domain to start sending and receiving emails with
								custom addresses.
							</p>
							<Button
								variant="primary"
								icon={<Plus size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								Add Domain
							</Button>
						</div>
					</div>
				)}
			</div>

			{/* Add Domain Wizard */}
			{isCreateOpen && (
				<AddDomainWizard
					onClose={() => setIsCreateOpen(false)}
					onSuccess={() => setIsCreateOpen(false)}
					onComplete={() => setIsCreateOpen(false)}
				/>
			)}

			{/* Catch-all Mailbox Dialog */}
			<CatchAllDialog
				domain={catchAllDomain}
				open={isCatchAllOpen}
				onClose={() => {
					setIsCatchAllOpen(false);
					setCatchAllDomain(null);
				}}
			/>

			{/* Delete Domain Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setDomainToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Domain
					</Dialog.Title>
					<p className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{domainToDelete?.name}
						</strong>
						? This will remove all DNS records and cannot be undone.
					</p>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
