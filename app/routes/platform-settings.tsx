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
	ArrowLeft,
	MoreVertical,
	Globe,
	Key,
	Plus,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import { CatchAllDialog } from "~/components/CatchAllDialog";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { PlatformSettingsSection, loadCfCredentials } from "~/components/PlatformSettingsSection";
import { useDeleteDomain, useDomains, useSetCatchAll, useUpdateDomainApiKey } from "~/queries/domains";
import type { Domain } from "~/types";

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

	const navigate = useNavigate();

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
			// Domain not on Cloudflare — go to details page to see DNS records
			navigate(`/domains/${domain.id}`);
			toastManager.add({
				title: "Not on Cloudflare — showing DNS records instead",
				variant: "warning",
			});
		}
		setOpenMenu(null);
	};

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-3 px-5 py-3.5 border-b border-kumo-line">
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-default">
					<Globe size={16} />
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
					icon={<Plus size={16} />}
					onClick={() => setShowAddWizard(true)}
				>
					Add Domain
				</Button>
			</div>

			{/* Domain list */}
			{isLoading ? (
				<div className="flex items-center justify-center py-8">
					<Loader size="base" />
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
								<Globe
									size={16}
									className="shrink-0 text-kumo-subtle"
								/>
								<RouterLink
									to={`/domains/${domain.id}`}
									className="text-sm font-semibold text-kumo-default hover:underline no-underline"
								>
									{domain.name}
								</RouterLink>
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
										<MoreVertical size={16} />
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
													<Key size={14} />
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
													<Trash2 size={14} />
													Delete
												</button>
											</div>
										)}
									</div>
								</div>
							</div>

							{/* Row 2: Status + date */}
							<div className="flex items-center gap-3 mt-1 pl-6 text-[11px]">
								<div className="flex-1">
									<DomainFullStatus domain={domain} />
								</div>
								<span className="text-kumo-subtle shrink-0">
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
					onSuccess={() => setShowAddWizard(false)}
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
			{catchAllDomain && (
				<CatchAllDialog
					domain={catchAllDomain}
					open={isCatchAllOpen}
					onClose={() => {
						setIsCatchAllOpen(false);
						setCatchAllDomain(null);
					}}
				/>
			)}
		</div>
	);
}

// ── Page ───────────────────────────────────────────────────────────

export function meta() {
	return [{ title: "Platform Settings — Mailboxes" }];
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
							className="inline-flex items-center gap-1.5 text-sm text-kumo-accent hover:text-kumo-accent/80 transition-colors"
						>
							<ArrowLeft size={14} />
							Back to Mailboxes
						</RouterLink>
					</div>
					<h1 className="text-2xl font-bold text-kumo-default">
						Platform Settings
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
