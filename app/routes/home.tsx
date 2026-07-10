// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	DotsThreeVerticalIcon,
	EnvelopeIcon,
	GlobeIcon,
	PlusIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { useDomains } from "~/queries/domains";
import api from "~/services/api";
import { StatusBadge } from "~/components/DomainStatusBadge";
import type { Domain, Mailbox } from "~/types";

export function meta() {
	return [{ title: "Mailboxes" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const {
		data: mailboxes = [],
		isFetched: mailboxesFetched,
	} = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [localPart, setLocalPart] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const { data: domains = [] } = useDomains();
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [openMenu, setOpenMenu] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

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

	// Group mailboxes by domain
	const groupedMailboxes = useMemo(() => {
		const map = new Map<string, { domain: Domain; mailboxes: Mailbox[] }>();

		// Initialize all domain groups
		for (const d of domains) {
			map.set(d.name, { domain: d, mailboxes: [] });
		}

		// Assign mailboxes to their domain group
		for (const m of mailboxes) {
			const domainName = m.email.split("@")[1];
			const group = map.get(domainName);
			if (group) {
				group.mailboxes.push(m);
			} else {
				// Unknown domain mailboxes go into "Other" group
				if (!map.has("__other__")) {
					map.set("__other__", { domain: null as any, mailboxes: [] });
				}
				map.get("__other__")!.mailboxes.push(m);
			}
		}

		// Sort mailboxes within each group by id descending (newest first)
		for (const group of map.values()) {
			group.mailboxes.sort((a, b) => b.id.localeCompare(a.id));
		}

		// Only return groups that have mailboxes
		return [...map.values()].filter((g) => g.mailboxes.length > 0);
	}, [domains, mailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);

		if (!localPart) {
			setCreateError("Please enter a local part");
			return;
		}
		if (!selectedDomain) {
			setCreateError("Please select a domain");
			return;
		}

		const email = `${localPart}@${selectedDomain}`;

		// Handle catch-all pattern (localPart === "*")
		if (localPart === "*") {
			const catchAllEmail = `*@${selectedDomain}`;
			const name = newName || "Catch-all";
			setIsCreating(true);
			try {
				await createMailbox.mutateAsync({ email: catchAllEmail, name });
				const allDomains = await api.domains.list();
				const matchedDomain = allDomains.find(
					(d) => d.name === selectedDomain,
				);
				if (matchedDomain) {
					await api.domains.setCatchAll(matchedDomain.id, catchAllEmail);
				}
				toastManager.add({
					title: `Catch-all mailbox ${catchAllEmail} created!`,
				});
				setIsCreateOpen(false);
				setLocalPart("");
				setSelectedDomain("");
				setNewName("");
			} catch (err: unknown) {
				const message =
					(err instanceof Error ? err.message : null) ||
					"Failed to create catch-all mailbox";
				setCreateError(message);
			} finally {
				setIsCreating(false);
			}
			return;
		}

		const name = newName || localPart;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: "Mailbox created successfully!" });
			setIsCreateOpen(false);
			setLocalPart("");
			setSelectedDomain("");
			setNewName("");
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) ||
				"Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({
				title: "Failed to delete mailbox",
				variant: "error",
			});
		} finally {
			setIsDeleting(false);
		}
	};

	const isEmpty = groupedMailboxes.length === 0;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				{/* Header */}
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">
							Mailboxes
						</h1>
						<div className="flex items-center gap-2">
							<RouterLink
								to="/setup"
								className="inline-flex items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 text-sm font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
							>
								<PlusIcon size={14} />
								New Domain
							</RouterLink>
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								New Mailbox
							</Button>
						</div>
					</div>
				</div>

				{/* Content */}
				{!isEmpty ? (
					<div className="space-y-4">
						{groupedMailboxes.map(({ domain, mailboxes: groupMailboxes }) => {
							const domainId = domain?.id ?? "__other__";
							const isOther = domain === null;

							return (
								<div
									key={domainId}
									className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden"
								>
									{/* Domain header row */}
									<div className="flex items-center gap-3 px-5 py-3 border-b border-kumo-line bg-kumo-fill/50">
										<GlobeIcon
											size={16}
											className="shrink-0 text-kumo-subtle"
										/>
										<span className="text-sm font-semibold text-kumo-default">
											{isOther ? "Other" : domain.name}
										</span>
										{!isOther && <StatusBadge status={domain.status} />}
										<span className="rounded-full bg-kumo-fill px-2 py-0.5 text-xs font-medium text-kumo-subtle">
											{groupMailboxes.length}
										</span>
										<div className="ml-auto" ref={menuRef}>
											{!isOther && (
												<div className="relative">
													<button
														type="button"
														className="inline-flex items-center justify-center rounded-md p-1 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
														onClick={() =>
															setOpenMenu(openMenu === domainId ? null : domainId)
														}
														aria-label="Domain actions"
													>
														<DotsThreeVerticalIcon size={16} />
													</button>
													{openMenu === domainId && (
														<div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-lg border border-kumo-line bg-kumo-base py-1 shadow-lg">
															<RouterLink
																to="/domains"
																className="block px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint no-underline"
																onClick={() => setOpenMenu(null)}
															>
																Edit
															</RouterLink>
															<RouterLink
																to="/domains"
																className="block px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint no-underline"
																onClick={() => setOpenMenu(null)}
															>
																Manage DNS
															</RouterLink>
															{domain.catch_all_mailbox && (
																<div className="px-3 py-2 text-xs text-kumo-subtle">
																	Catch-all: {domain.catch_all_mailbox}
																</div>
															)}
														</div>
													)}
												</div>
											)}
										</div>
									</div>

									{/* Mailbox rows */}
									{groupMailboxes.map((account, idx) => (
										<RouterLink
											key={account.id}
											to={`/mailbox/${account.id}/emails/inbox`}
											className={`group flex items-center gap-4 px-5 py-3.5 no-underline transition-colors hover:bg-kumo-tint ${
												idx > 0 ? "border-t border-kumo-line" : ""
											}`}
										>
											<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
												<EnvelopeIcon size={14} className="text-kumo-subtle" />
											</div>
											<div className="min-w-0 flex-1">
												<div className="text-sm font-medium text-kumo-default truncate">
													{account.name}
												</div>
												<div className="text-xs text-kumo-subtle truncate">
													{account.email}
												</div>
											</div>
											<Button
												variant="ghost"
												size="sm"
												shape="square"
												icon={<TrashIcon size={16} />}
												aria-label={`Delete mailbox ${account.email}`}
												onClick={(e) => {
													e.preventDefault();
													e.stopPropagation();
													setMailboxToDelete({
														id: account.id,
														email: account.email,
													});
													setIsDeleteOpen(true);
												}}
											/>
										</RouterLink>
									))}
								</div>
							);
						})}
					</div>
				) : (
					/* Empty state */
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								Get started by adding a domain to create your first
								mailbox.
							</p>
							<RouterLink
								to="/setup"
								className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-accent px-4 py-2 text-sm font-medium text-white no-underline transition-colors hover:opacity-90"
							>
								<PlusIcon size={16} />
								Add Domain
							</RouterLink>
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New Mailbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div className="grid gap-2">
							<label className="m-0 text-base font-medium text-kumo-default">
								Email Address
							</label>
							<div className="flex items-center">
								<input
									type="text"
									className="h-6.5 min-w-0 flex-1 rounded-l-md border border-kumo-hairline border-r-0 bg-kumo-control px-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none"
									placeholder="hello"
									value={localPart}
									onChange={(e) => setLocalPart(e.target.value)}
									required
								/>
								<span className="flex h-6.5 shrink-0 items-center border-y border-kumo-hairline bg-kumo-control px-1 text-xs text-kumo-subtle">
									@
								</span>
								{domains.length > 0 ? (
									<select
										className="h-6.5 min-w-0 flex-1 appearance-none rounded-r-md border border-kumo-hairline border-l-0 bg-kumo-control px-2 pr-4 text-xs text-kumo-default focus:outline-none"
										value={selectedDomain}
										onChange={(e) => setSelectedDomain(e.target.value)}
										required
									>
										<option value="" disabled>
											Select domain…
										</option>
										{domains.map((domain) => (
											<option key={domain.id} value={domain.name}>
												{domain.name}
											</option>
										))}
									</select>
								) : (
									<p className="text-xs text-kumo-subtle">
										No domains configured yet.{" "}
										<RouterLink to="/setup" className="underline">
											Add a domain
										</RouterLink>{" "}
										first.
									</p>
								)}
							</div>
						</div>
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
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
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
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
		</div>
	);
}
