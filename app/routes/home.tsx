// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import {
	Badge,
	Button,
	Dialog,
	Input,
	Loader,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	RotateCw,
	CircleCheckBig,
	MoreVertical,
	Mail,
	Settings,
	Globe,
	Key,
	Loader2,
	Plus,
	Trash2,
	TriangleAlert,
	LogOut,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, type MetaArgs } from "react-router";
import { useTranslation } from "react-i18next";
import { isLocale } from "shared/i18n/config";
import { translate } from "shared/i18n/translate";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { useDomains, useUpdateDomainApiKey } from "~/queries/domains";
import api, { type VerifyResendResult } from "~/services/api";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { formatSenderLabel } from "shared/participants";
import type { Domain, Mailbox } from "~/types";

export function meta({ matches }: MetaArgs) {
	const rootData = matches.find((m) => m?.id === "root")?.data as
		| { locale?: string }
		| undefined;
	const locale = isLocale(rootData?.locale) ? rootData.locale : "en";
	return [{ title: translate(locale, "dashboard:metaTitle") }];
}

export default function HomeRoute() {
	const { t } = useTranslation("dashboard");
	const { i18n } = useTranslation();
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
	const { data: domains = [], isFetched: domainsFetched } = useDomains();
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

	// Domain API Key dialog state
	const [isApiKeyOpen, setIsApiKeyOpen] = useState(false);
	const [apiKeyDomain, setApiKeyDomain] = useState<{ id: string; name: string; hasKey: boolean } | null>(null);
	const [apiKeyValue, setApiKeyValue] = useState("");
	const [isSavingApiKey, setIsSavingApiKey] = useState(false);
	const [isVerifyingApiKey, setIsVerifyingApiKey] = useState(false);
	type ApiKeyVerifyStatus = "idle" | "verifying" | "valid" | "invalid" | "error";
	const [apiKeyVerifyStatus, setApiKeyVerifyStatus] = useState<ApiKeyVerifyStatus>("idle");
	const [apiKeyVerifyResult, setApiKeyVerifyResult] = useState<VerifyResendResult | null>(null);
	const updateApiKey = useUpdateDomainApiKey();

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

	const [isLoggingOut, setIsLoggingOut] = useState(false);
	async function handleLogout() {
		if (isLoggingOut) return;
		setIsLoggingOut(true);
		try {
			await api.auth.logout();
		} catch {
			// Even if the server call fails, clear the client-side cookie and go home.
		}
		window.location.href = "/login";
	}

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

		// Sort mailboxes within each group by created_at descending (newest first)
		for (const group of map.values()) {
			group.mailboxes.sort((a, b) => {
				const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
				const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
				return tb - ta;
			});
		}

		// Return all groups (including domains with no mailboxes yet)
		return [...map.values()];
	}, [domains, mailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);

		if (!localPart) {
			setCreateError(t("errorLocalPartRequired"));
			return;
		}
		if (!selectedDomain) {
			setCreateError(t("errorDomainRequired"));
			return;
		}

		const email = `${localPart}@${selectedDomain}`;

		// Handle catch-all pattern (localPart === "*")
		if (localPart === "*") {
			const catchAllEmail = `*@${selectedDomain}`;
			const name = newName || t("catchAllDefaultName");
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
					title: t("catchAllCreated", { email: catchAllEmail }),
				});
				setIsCreateOpen(false);
				setLocalPart("");
				setSelectedDomain("");
				setNewName("");
			} catch (err: unknown) {
				const message =
					(err instanceof Error ? err.message : null) ||
					t("catchAllCreateFailed");
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
			toastManager.add({ title: t("mailboxCreated") });
			setIsCreateOpen(false);
			setLocalPart("");
			setSelectedDomain("");
			setNewName("");
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) ||
				t("mailboxCreateFailed");
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleApiKeyOpen = (domain: Domain) => {
		const hasKey = !!(domain as any).resend_api_key;
		setApiKeyDomain({ id: domain.id, name: domain.name, hasKey });
		// Pre-fill with masked key so user knows one is already set
		setApiKeyValue(hasKey ? "••••••••••••••••••••" : "");
		setApiKeyVerifyStatus("idle");
		setApiKeyVerifyResult(null);
		setIsApiKeyOpen(true);
		setOpenMenu(null);
	};

	const handleVerifyApiKey = async () => {
		if (!apiKeyDomain || !apiKeyValue || apiKeyValue === "••••••••••••••••••••") return;
		setIsVerifyingApiKey(true);
		setApiKeyVerifyStatus("verifying");
		setApiKeyVerifyResult(null);
		try {
			// Verify the API key directly against Resend using the domain
			const result = await api.verifyDomainResendKey(apiKeyDomain.id, apiKeyValue.trim());
			setApiKeyVerifyResult(result);
			setApiKeyVerifyStatus(result.valid ? "valid" : "invalid");
		} catch {
			setApiKeyVerifyStatus("error");
		} finally {
			setIsVerifyingApiKey(false);
		}
	};

	const handleApiKeySave = async () => {
		if (!apiKeyDomain) return;
		const value = apiKeyValue.trim();
		// If user didn't change the masked placeholder, treat as "keep existing"
		const finalKey = value === "•••••••••••••••••••" ? "" : value;
		setIsSavingApiKey(true);
		try {
			await updateApiKey.mutateAsync({
				domainId: apiKeyDomain.id,
				apiKey: finalKey,
			});
			toastManager.add({ title: t("resendKeyUpdated", { name: apiKeyDomain.name }) });
			setIsApiKeyOpen(false);
			setApiKeyDomain(null);
		} catch {
			toastManager.add({
				title: t("resendKeyUpdateFailed"),
				variant: "error",
			});
		} finally {
			setIsSavingApiKey(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: t("mailboxDeleted") });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({
				title: t("mailboxDeleteFailed"),
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
						<div className="flex items-center gap-2.5">
							<img
								src="/logo.png"
								alt={t("brandAlt")}
								width={32}
								height={32}
								className="brand-logo-light h-8 w-8 rounded-lg"
							/>
							<img
								src="/logo-dark.png"
								alt=""
								aria-hidden="true"
								width={32}
								height={32}
								className="brand-logo-dark h-8 w-8 rounded-lg"
							/>
							<h1 className="text-2xl font-bold text-kumo-default">
								{t("heading")}
							</h1>
						</div>
						<div className="flex items-center gap-2">
							<RouterLink
								to="/settings"
								className="inline-flex items-center justify-center rounded-lg border border-kumo-line bg-kumo-base p-2 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
								aria-label={t("settingsAria")}
							>
								<Settings size={18} />
							</RouterLink>
							<button
								type="button"
								onClick={handleLogout}
								disabled={isLoggingOut}
								className="inline-flex items-center justify-center rounded-lg border border-kumo-line bg-kumo-base p-2 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-50"
								aria-label={t("signOutAria")}
								title={t("signOutTitle")}
							>
								<LogOut size={18} />
							</button>
							<Button
								variant="primary"
								icon={<Plus size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								{t("newMailbox")}
							</Button>
						</div>
					</div>
				</div>

				{/* Loading state */}
				{(!mailboxesFetched || !domainsFetched) && (
					<div className="flex items-center justify-center py-24">
						<Loader size="lg" />
					</div>
				)}

				{/* Content */}
				{mailboxesFetched && domainsFetched && !isEmpty ? (
					<div className="space-y-4">
						{groupedMailboxes.map(({ domain, mailboxes: groupMailboxes }) => {
							const domainId = domain?.id ?? "__other__";
							const isOther = domain === null;
							const hasNoMailboxes = groupMailboxes.length === 0;

							return (
								<div
									key={domainId}
									className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden"
								>
									{/* Domain header row */}
									<div className="border-b border-kumo-line bg-kumo-fill/50">
										{/* Row 1: Domain name, status, count, menu */}
										<div className="flex items-center gap-3 px-5 py-3">
											<Globe
												size={16}
												className="shrink-0 text-kumo-subtle"
											/>
											<span className="min-w-0 truncate text-sm font-semibold text-kumo-default">
												{isOther ? t("otherDomain") : domain.name}
											</span>
											{!isOther && <DomainFullStatus domain={domain} />}
											<span className="shrink-0 rounded-full bg-kumo-fill px-2 py-0.5 text-xs font-medium text-kumo-subtle">
												{groupMailboxes.length}
											</span>
											<div className="ml-auto shrink-0" ref={menuRef}>
												{!isOther && (
													<div className="relative">
														<button
															type="button"
															className="inline-flex items-center justify-center rounded-md p-1 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
															onClick={() =>
																setOpenMenu(openMenu === domainId ? null : domainId)
															}
															aria-label={t("domainActionsAria")}
														>
															<MoreVertical size={16} />
														</button>
														{openMenu === domainId && (
															<div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-lg border border-kumo-line bg-kumo-base py-1 shadow-lg">
																<RouterLink
																	to={`/settings/domains/${domainId}`}
																	className="block px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint no-underline"
																	onClick={() => setOpenMenu(null)}
																>
																	{t("menuEdit")}
																</RouterLink>
																<RouterLink
																	to={`/settings/domains/${domainId}`}
																	className="block px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint no-underline"
																	onClick={() => setOpenMenu(null)}
																>
																	{t("menuManageDns")}
																</RouterLink>
																<button
																	type="button"
																	className="flex items-center gap-2 w-full px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint text-left"
																	onClick={() => handleApiKeyOpen(domain)}
																>
																	<Key size={14} />
																	{t("menuResendApiKey")}
																	{(domain as any).resend_api_key ? (
																		<CircleCheckBig size={12} className="ml-auto text-green-500" fill="currentColor" />
																	) : (
																		<TriangleAlert size={12} className="ml-auto text-amber-500" fill="currentColor" />
																	)}
																</button>
																{domain.catch_all_mailbox && (
																	<div className="px-3 py-2 text-xs text-kumo-subtle">
																	{t("catchAllLabel", { mailbox: domain.catch_all_mailbox })}
																	</div>
																)}
															</div>
														)}
													</div>
												)}
											</div>
										</div>
										{/* Row 2: Added date, receiving/sending status, catch-all */}
										{!isOther && (
											<div className="flex items-center gap-3 px-5 pb-2.5 text-[11px]">
												<span className="text-kumo-subtle">
													{t("domainAdded", { date: domain.created_at ? new Date(domain.created_at).toLocaleDateString(i18n.language, { month: "short", day: "numeric", year: "numeric" }) : "—" })}
												</span>
												{domain.catch_all_mailbox && (
													<span className="text-blue-600">{t("catchAllLabel", { mailbox: domain.catch_all_mailbox })}</span>
												)}
											</div>
										)}
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
											<div className="relative flex-shrink-0">
												<div className="flex h-9 w-9 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
													<Mail size={14} className="text-kumo-subtle" />
												</div>
												{(account.unread_count ?? 0) > 0 && (
													<div className="absolute -right-1.5 -top-1.5 flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white leading-none">
														{(account.unread_count ?? 0) > 99 ? '99+' : account.unread_count}
													</div>
												)}
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span className="text-sm font-medium text-kumo-default truncate">
														{account.name}
													</span>
												</div>
												<div className="text-xs text-kumo-subtle truncate">
													{account.email}
												</div>
												{account.latest_subject && (
													<div className="mt-0.5 flex items-center gap-1.5 text-xs text-kumo-subtle/70 truncate">
														<span className="truncate font-medium text-kumo-subtle/80">
															{account.latest_subject}
														</span>
														{account.latest_snippet && (
															<>
																<span className="shrink-0 text-kumo-subtle/40">—</span>
																<span className="truncate">
																	{account.latest_snippet}
																</span>
															</>
														)}
													</div>
												)}
												{!account.latest_subject && account.latest_sender && (
													<div className="mt-0.5 flex items-center gap-1.5 text-xs text-kumo-subtle/50 truncate">
														<span>{t("latestSender", { sender: formatSenderLabel(account.latest_sender_name, account.latest_sender) })}</span>
														{account.latest_date && (
															<>
																<span className="shrink-0">·</span>
																<span>{new Date(account.latest_date).toLocaleDateString(i18n.language)}</span>
															</>
														)}
													</div>
												)}
											</div>
											<Button
												variant="ghost"
												size="sm"
												shape="square"
												icon={<Trash2 size={16} />}
												aria-label={t("deleteMailboxAria", { email: account.email })}
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

									{/* Empty domain: prompt to create mailbox */}
									{!isOther && hasNoMailboxes && (
										<div className="px-5 py-4 border-t border-kumo-line space-y-3">
											<p className="text-sm text-kumo-subtle">
												{t("noMailboxesOnDomain")}
											</p>
											<div className="flex gap-2">
												<Button
													variant="primary"
													size="sm"
													icon={<Plus size={14} />}
													onClick={() => {
														setSelectedDomain(domain.name);
														setIsCreateOpen(true);
													}}
												>
													{t("createMailbox")}
												</Button>
												{!domain.cf_zone_id && (
													<RouterLink
														to="/settings"
														className="inline-flex items-center justify-center gap-1.5 rounded-md border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint no-underline"
													>
														<RotateCw size={13} />
														{t("setupReceiving")}
													</RouterLink>
												)}
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				) : (
					/* Empty state */
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<Mail
									size={48}
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								{t("emptyTitle")}
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{t("emptyDescription")}
							</p>
							<RouterLink
							to="/settings"
							className="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium bg-kumo-brand text-white hover:bg-kumo-brand/90 no-underline"
						>
							<Plus size={16} />
							{t("addDomain")}
						</RouterLink>
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						{t("createDialogTitle")}
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<div className="grid gap-2">
							<label className="m-0 text-base font-medium text-kumo-default">
								{t("emailAddressLabel")}
							</label>
							<div className="flex items-center">
								<input
									type="text"
									className="h-7 min-w-0 flex-1 rounded-l-md border border-kumo-hairline border-r-0 bg-kumo-control px-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none"
									placeholder={t("emailLocalPartPlaceholder")}
									value={localPart}
									onChange={(e) => setLocalPart(e.target.value)}
									required
								/>
								<span className="flex h-7 shrink-0 items-center border-y border-kumo-hairline bg-kumo-control px-1 text-xs text-kumo-subtle">
									@
								</span>
								{domains.length > 0 ? (
									<select
										className="h-7 min-w-0 flex-1 appearance-none rounded-r-md border border-kumo-hairline border-l-0 bg-kumo-control px-2 pr-4 text-xs text-kumo-default focus:outline-none"
										value={selectedDomain}
										onChange={(e) => setSelectedDomain(e.target.value)}
										required
									>
										<option value="" disabled>
											{t("selectDomainPlaceholder")}
										</option>
										{domains.map((domain) => (
											<option key={domain.id} value={domain.name}>
												{domain.name}
											</option>
										))}
									</select>
								) : (
									<p className="text-xs text-kumo-subtle">
										{t("noDomainsConfigured")}{" "}
										<RouterLink to="/settings" className="underline">
											{t("addDomainLink")}
										</RouterLink>{" "}
										{t("noDomainsConfiguredSuffix")}
									</p>
								)}
							</div>
						</div>
						<Input
							label={t("displayNameLabel")}
							placeholder={t("displayNamePlaceholder")}
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										{t("common:cancel")}
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
							>
								{t("common:create")}
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
						{t("deleteDialogTitle")}
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						{t("deleteConfirmLead")}{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						{t("deleteConfirmTail")}
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									{t("common:cancel")}
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							{t("common:delete")}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* API Key Dialog */}
			<Dialog.Root open={isApiKeyOpen} onOpenChange={setIsApiKeyOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						{t("apiKeyDialogTitle", { name: apiKeyDomain?.name })}
					</Dialog.Title>
					<p className="text-sm text-kumo-subtle mb-5">
						{t("apiKeyDialogDescription")}
					</p>

					{/* ── 1. API Key Configuration Status ── */}
					<div className="rounded-lg border px-3 py-2 mb-3">
						<div className="flex items-center gap-2">
							<Key size={14} className="text-kumo-subtle shrink-0" />
							<span className="text-xs font-medium text-kumo-default">{t("apiKeyLabel")}</span>
						</div>
						{apiKeyDomain?.hasKey ? (
							<div className="flex items-center gap-2 mt-2">
								<CircleCheckBig size={12} className="text-green-600 shrink-0" fill="currentColor" />
								<span className="text-xs text-green-700">{t("apiKeyConfigured")}</span>
							</div>
						) : (
							<div className="flex items-center gap-2 mt-2">
								<TriangleAlert size={12} className="text-amber-500 shrink-0" fill="currentColor" />
								<span className="text-xs text-amber-700">{t("apiKeyNotConfigured")}</span>
							</div>
						)}
					</div>

					{/* ── 2. Domain Verification Status (shown only after verification) ── */}
					{apiKeyVerifyStatus !== "idle" && (
						<div className="rounded-lg border px-3 py-2 mb-3">
							<div className="flex items-center gap-2">
								<Globe size={14} className="text-kumo-subtle shrink-0" />
								<span className="text-xs font-medium text-kumo-default">{t("apiKeyDomainLabel")}</span>
							</div>

							{apiKeyVerifyStatus === "verifying" && (
								<div className="flex items-center gap-2 mt-2">
									<Loader2 size={12} className="animate-spin text-kumo-subtle shrink-0" />
									<span className="text-xs text-kumo-subtle">{t("verifyingWithResend")}</span>
								</div>
							)}

							{apiKeyVerifyStatus === "valid" && apiKeyVerifyResult && (
								<div className="space-y-1.5 mt-2">
									<Badge variant="success"><CircleCheckBig size={12} fill="currentColor" /> {t("apiKeyVerifiedBadge")}</Badge>
									{apiKeyVerifyResult.sendingReady ? (
										<Badge variant="success">{t("domainReadyToSend")}</Badge>
									) : apiKeyVerifyResult.matchingDomain ? (
										<Badge variant="warning"><TriangleAlert size={12} fill="currentColor" /> {t("domainStatusBadge", { domain: apiKeyVerifyResult.matchingDomain.domain, status: apiKeyVerifyResult.matchingDomain.status })}{" "}<a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="underline font-medium">{t("verifyDnsInResend")}</a></Badge>
									) : (
										<Badge variant="warning"><TriangleAlert size={12} fill="currentColor" /> {t("noMatchingDomain", { name: apiKeyDomain?.name })}</Badge>
									)}
								</div>
							)}

							{apiKeyVerifyStatus === "invalid" && (
								<div className="mt-2">
									<Badge variant="error"><TriangleAlert size={12} fill="currentColor" /> {apiKeyVerifyResult?.error || t("invalidApiKey")}</Badge>
								</div>
							)}

							{apiKeyVerifyStatus === "error" && (
								<div className="mt-2">
									<Badge variant="error">{t("verificationFailed")}</Badge>
								</div>
							)}
						</div>
					)}

					<div className="space-y-4">
						<div className="relative">
							<Input
								label={t("resendApiKeyFieldLabel")}
								type="text"
								placeholder={t("resendApiKeyPlaceholder")}
								value={apiKeyValue}
								onFocus={() => {
									// Auto-clear mask so user can type a new key
									if (apiKeyValue === "••••••••••••••••••••") {
										setApiKeyValue("");
									}
								}}
								onChange={(e) => {
								setApiKeyValue(e.target.value);
								setApiKeyVerifyStatus("idle");
								setApiKeyVerifyResult(null);
							}}
							/>
						</div>
						{apiKeyDomain?.hasKey && apiKeyValue === "••••••••••••••••••••" && (
							<p className="text-xs text-kumo-subtle mt-1">
								{t("enterNewKeyHint")}
							</p>
						)}

						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										{t("common:cancel")}
									</Button>
								)}
							/>
							{apiKeyValue && apiKeyValue !== "••••••••••••••••••••" && (
								<Button
									variant="secondary"
									size="sm"
									loading={isVerifyingApiKey}
									onClick={handleVerifyApiKey}
								>
									{isVerifyingApiKey ? (
										<><Loader2 size={14} className="animate-spin" /> {t("verifying")}</>
									) : (
										<>{t("common:verify")}</>
									)}
								</Button>
							)}
							<Button
								variant="primary"
								size="sm"
								loading={isSavingApiKey}
								onClick={handleApiKeySave}
							>
								{t("common:save")}
							</Button>
						</div>
					</div>
				</Dialog>
			</Dialog.Root>


		</div>
	);
}
