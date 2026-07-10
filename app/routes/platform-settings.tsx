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
	CaretDownIcon,
	CaretRightIcon,
	DotsThreeVerticalIcon,
	GearSixIcon,
	GlobeIcon,
	KeyIcon,
	LinkIcon,
	EyeIcon,
	EyeSlashIcon,
	PlusIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import { CatchAllDialog } from "~/components/CatchAllDialog";
import { StatusBadge } from "~/components/DomainStatusBadge";
import { useDeleteDomain, useDomains, useSetCatchAll, useUpdateDomainApiKey } from "~/queries/domains";
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

// ── Domain Management Section ───────────────────────────────────

function DomainsSection() {
	const toastManager = useKumoToastManager();
	const { data: domains = [], isLoading } = useDomains();
	const deleteDomain = useDeleteDomain();
	const updateApiKey = useUpdateDomainApiKey();
	const setCatchAll = useSetCatchAll();

	// Add Domain wizard
	const [showAddWizard, setShowAddWizard] = useState(false);

	// Domain menu state
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// Delete confirmation
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [domainToDelete, setDomainToDelete] = useState<Domain | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// API Key dialog state
	const [isApiKeyOpen, setIsApiKeyOpen] = useState(false);
	const [apiKeyDomain, setApiKeyDomain] = useState<Domain | null>(null);
	const [apiKeyValue, setApiKeyValue] = useState("");
	const [isSavingApiKey, setIsSavingApiKey] = useState(false);

	// Catch-all dialog state
	const [isCatchAllOpen, setIsCatchAllOpen] = useState(false);
	const [catchAllDomain, setCatchAllDomain] = useState<Domain | null>(null);

	// Close menu on outside click
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setOpenMenu(null);
			}
		}
		if (openMenu) {
			document.addEventListener("mousedown", handleClick);
			return () => document.removeEventListener("mousedown", handleClick);
		}
	}, [openMenu]);

	// ── Handlers ──

	const handleDelete = async () => {
		if (!domainToDelete) return;
		setIsDeleting(true);
		try {
			await deleteDomain.mutateAsync(domainToDelete.id);
			toastManager.add({ title: `Domain ${domainToDelete.name} deleted` });
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

	const handleApiKeyOpen = (domain: Domain) => {
		setApiKeyDomain(domain);
		setApiKeyValue(domain.resend_api_key ? "" : "");
		setIsApiKeyOpen(true);
		setOpenMenu(null);
	};

	const handleApiKeySave = async () => {
		if (!apiKeyDomain) return;
		setIsSavingApiKey(true);
		try {
			await updateApiKey.mutateAsync({
				domainId: apiKeyDomain.id,
				apiKey: apiKeyValue.trim(),
			});
			toastManager.add({ title: `Resend API Key updated for ${apiKeyDomain.name}` });
			setIsApiKeyOpen(false);
			setApiKeyDomain(null);
		} catch {
			toastManager.add({
				title: "Failed to update Resend API Key",
				variant: "error",
			});
		} finally {
			setIsSavingApiKey(false);
		}
	};

	const handleCatchAllOpen = (domain: Domain) => {
		setCatchAllDomain(domain);
		setIsCatchAllOpen(true);
		setOpenMenu(null);
	};

	const handleEditDns = (domain: Domain) => {
		if (domain.cf_zone_id) {
			const creds = loadCfCredentials();
			const accountId = domain.cf_account_id || creds.cfAccountId;
			if (accountId) {
				window.open(
					`https://dash.cloudflare.com/${accountId}/dns/zone/${domain.cf_zone_id}`,
					"_blank",
				);
			} else {
				toastManager.add({
					title: "No Cloudflare Account ID available",
					variant: "error",
				});
			}
		} else {
			toastManager.add({
				title: "This domain is not managed by Cloudflare",
				variant: "error",
			});
		}
		setOpenMenu(null);
	};

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-3 px-5 py-3.5 border-b border-kumo-line">
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-default">
					<GlobeIcon size={16} />
				</div>
				<div className="min-w-0 flex-1">
					<span className="text-sm font-medium text-kumo-default">
						Domains
					</span>
				</div>
				<Badge variant="info">
					{domains.length}
				</Badge>
				<Button
					variant="primary"
					size="sm"
					icon={<PlusIcon size={16} />}
					onClick={() => setShowAddWizard(true)}
				>
					Add Domain
				</Button>
			</div>

			{/* Domain list */}
			{isLoading ? (
				<div className="flex items-center justify-center py-8">
					<Loader size="md" />
				</div>
			) : domains.length === 0 ? (
				<div className="px-5 py-8 text-center">
					<p className="text-sm text-kumo-subtle">
						No domains configured yet.
					</p>
				</div>
			) : (
				<div>
					{domains.map((domain, idx) => (
						<div
							key={domain.id}
							className={`px-5 py-3.5 ${
								idx > 0 ? "border-t border-kumo-line" : ""
							}`}
						>
							{/* Row 1: Domain name, status, menu */}
							<div className="flex items-center gap-2">
								<GlobeIcon
									size={16}
									className="shrink-0 text-kumo-subtle"
								/>
								<span className="text-sm font-semibold text-kumo-default">
									{domain.name}
								</span>
								<StatusBadge status={domain.status} />
								<div className="ml-auto" ref={openMenu === domain.id ? menuRef : undefined}>
									<div className="relative">
										<button
											type="button"
											className="inline-flex items-center justify-center rounded-md p-1 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
										onClick={() =>
											setOpenMenu(openMenu === domain.id ? null : domain.id)
										}
										aria-label="Domain actions"
									>
										<DotsThreeVerticalIcon size={16} />
									</button>
										{openMenu === domain.id && (
											<div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-lg border border-kumo-line bg-kumo-base py-1 shadow-lg">
												<button
													type="button"
													className="block w-full px-3 py-2 text-left text-sm text-kumo-default hover:bg-kumo-tint"
													onClick={() => handleEditDns(domain)}
												>
													Edit DNS
												</button>
												<button
													type="button"
													className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-kumo-default hover:bg-kumo-tint"
													onClick={() => handleApiKeyOpen(domain)}
												>
													<KeyIcon size={14} />
													Resend API Key
												</button>
												<button
													type="button"
													className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-kumo-default hover:bg-kumo-tint"
													onClick={() => handleCatchAllOpen(domain)}
												>
													Manage Catch-all
												</button>
												<div className="my-1 border-t border-kumo-line" />
												<button
													type="button"
													className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
													onClick={() => {
													setDomainToDelete(domain);
													setIsDeleteOpen(true);
													setOpenMenu(null);
													}}
												>
													<TrashIcon size={14} />
													Delete
												</button>
											</div>
										)}
									</div>
								</div>
							</div>

							{/* Row 2: Status indicators, created date, catch-all */}
							<div className="flex items-center gap-3 mt-1 pl-6 text-[11px]">
								<DomainStatusIndicators domain={domain} />
								<span className="text-kumo-subtle ml-auto">
									{domain.created_at
										? new Date(domain.created_at).toLocaleDateString("en-US", {
												month: "short",
												day: "numeric",
												year: "numeric",
											})
										: "—"}
								</span>
							</div>

							{/* Row 3: Catch-all info */}
							{domain.catch_all_mailbox && (
								<div className="pl-6 mt-1">
									<span className="text-[11px] text-blue-600">
										Catch-all: {domain.catch_all_mailbox}
								</span>
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{/* Add Domain Wizard */}
			{showAddWizard && (
				<AddDomainWizard
					onClose={() => setShowAddWizard(false)}
					onSuccess={() => {}}
					onComplete={() => setShowAddWizard(false)}
				/>
			)}

			{/* Delete Confirmation Dialog */}
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
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{domainToDelete?.name}
						</strong>
						? This will remove all DNS records and cannot be undone.
					</Dialog.Description>
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

			{/* API Key Dialog */}
			<Dialog.Root open={isApiKeyOpen} onOpenChange={setIsApiKeyOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						Resend API Key — {apiKeyDomain?.name}
					</Dialog.Title>
					<p className="text-sm text-kumo-subtle mb-5">
						Configure the Resend API key for sending email from this domain.
					</p>
					<div className="space-y-4">
						<div>
							<label className="block text-sm font-medium text-kumo-default mb-1">
								{apiKeyDomain?.resend_api_key
									? "API Key (update below)"
									: "Resend API Key"}
							</label>
							<input
								type="password"
								className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
								placeholder="re_••••••••••••••••••••••••••••"
								value={apiKeyValue}
								onChange={(e) => setApiKeyValue(e.target.value)}
							/>
						</div>
						<div className="rounded-lg bg-kumo-fill px-3 py-2.5">
							<p className="text-xs text-kumo-subtle">
								Get your key from{' '}
								<a
									href="https://resend.com/api-keys"
									target="_blank"
									rel="noopener noreferrer"
									className="text-blue-600 underline"
								>
									resend.com/api-keys
								</a>
								. Free plan includes 100 emails/day.
							</p>
						</div>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								variant="primary"
								size="sm"
								loading={isSavingApiKey}
								onClick={handleApiKeySave}
							>
								Save
							</Button>
						</div>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Catch-all Dialog */}
			<CatchAllDialog
				domain={catchAllDomain}
				open={isCatchAllOpen}
				onClose={() => {
					setIsCatchAllOpen(false);
					setCatchAllDomain(null);
				}}
			/>
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

				{/* Domain Management */}
				<div className="mt-6">
					<DomainsSection />
				</div>
			</div>
		</div>
	);
}
