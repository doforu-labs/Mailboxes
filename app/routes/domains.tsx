// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Loader,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { GlobeIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
	useCreateDomain,
	useDeleteDomain,
	useDomains,
} from "~/queries/domains";
import type { Domain } from "~/types";

function StatusBadge({ status }: { status: Domain["status"] }) {
	const styles: Record<Domain["status"], string> = {
		verified: "bg-green-100 text-green-800",
		pending: "bg-yellow-100 text-yellow-800",
		failed: "bg-red-100 text-red-800",
	};

	const labels: Record<Domain["status"], string> = {
		verified: "Verified",
		pending: "Pending",
		failed: "Failed",
	};

	return (
		<span
			className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
		>
			{labels[status]}
		</span>
	);
}

export function meta() {
	return [{ title: "Domains — Mailboxes" }];
}

export default function DomainsRoute() {
	const toastManager = useKumoToastManager();
	const { data: domains = [], isFetched: domainsFetched } = useDomains();
	const createDomain = useCreateDomain();
	const deleteDomain = useDeleteDomain();

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newDomainName, setNewDomainName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [domainToDelete, setDomainToDelete] = useState<Domain | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newDomainName.trim()) {
			setCreateError("Please enter a domain name");
			return;
		}
		// Basic validation: must contain a dot
		if (!newDomainName.includes(".")) {
			setCreateError("Please enter a valid domain (e.g. example.com)");
			return;
		}
		setIsCreating(true);
		try {
			await createDomain.mutateAsync({ name: newDomainName.trim() });
			toastManager.add({ title: "Domain added successfully!" });
			setIsCreateOpen(false);
			setNewDomainName("");
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) || "Failed to add domain";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

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
							icon={<PlusIcon size={16} />}
							onClick={() => setIsCreateOpen(true)}
						>
							Add Domain
						</Button>
					</div>
				</div>

				{/* Domain List */}
				{!domainsFetched ? (
					<div className="flex justify-center py-16">
						<Loader size="lg" />
					</div>
				) : domains.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{domains.map((domain, idx) => (
							<div
								key={domain.id}
								className={`group flex items-center gap-4 px-5 py-4 transition-colors ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									<GlobeIcon size={18} />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-kumo-default truncate">
											{domain.name}
										</span>
										<StatusBadge status={domain.status} />
									</div>
									<div className="text-xs text-kumo-subtle mt-0.5">
										Added{" "}
										{new Date(domain.created_at).toLocaleDateString(undefined, {
											year: "numeric",
											month: "short",
											day: "numeric",
										})}
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									shape="square"
									icon={<TrashIcon size={16} />}
									aria-label={`Delete domain ${domain.name}`}
									onClick={() => {
										setDomainToDelete(domain);
										setIsDeleteOpen(true);
									}}
								/>
							</div>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<GlobeIcon
									size={48}
									weight="thin"
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
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								Add Domain
							</Button>
						</div>
					</div>
				)}
			</div>

			{/* Create Domain Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Add Domain
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<Input
							label="Domain Name"
							placeholder="example.com"
							size="sm"
							value={newDomainName}
							onChange={(e) => setNewDomainName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
							>
								Add Domain
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

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
