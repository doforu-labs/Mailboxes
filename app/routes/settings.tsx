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
	Globe,
	Plus,
	Trash2,
	AtSign,
} from "lucide-react";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import { CatchAllDialog } from "~/components/CatchAllDialog";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { PlatformSettingsSection } from "~/components/PlatformSettingsSection";
import {
	useDeleteDomain,
	useDomains,
} from "~/queries/domains";
import type { Domain } from "~/types";

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
								to={`/settings/domains/${domain.id}`}
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
