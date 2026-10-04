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
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowLeft,
	Check,
	CircleCheckBig,
	Copy,
	Eye,
	EyeOff,
	Key,
	Loader2,
	Plus,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Link as RouterLink, type MetaArgs, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { CatchAllDialog } from "~/components/CatchAllDialog";
import {
	useDeleteDomain,
	useDomains,
	useSetCatchAll,
	useUpdateDomainApiKey,
} from "~/queries/domains";
import { useMailboxes } from "~/queries/mailboxes";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "~/queries/api-keys";
import api, { type VerifyResendResult } from "~/services/api";
import { isLocale } from "shared/i18n/config";
import { translate } from "shared/i18n/translate";
import type { Locale } from "../../shared/i18n/types";

// ── DNS Record Static Data ──────────────────────────────────────

interface DnsRecord {
	type: string;
	name: string;
	value: string;
	priority?: number;
	description: string;
}

function getDnsRecords(
	domain: string,
	t: (key: string) => string,
): DnsRecord[] {
	return [
		{
			type: "MX",
			name: `feedback-smtp.${domain}`,
			value: "feedback-smtp.us-east-1.amazonses.com",
			priority: 10,
			description: t("dnsRecordMxBounceDescription"),
		},
		{
			type: "TXT",
			name: domain,
			value: "v=spf1 include:amazonses.com ~all",
			description: t("dnsRecordSpfDescription"),
		},
		{
			type: "CNAME",
			name: `resend._domainkey.${domain}`,
			value: "resend._domainkey.us-east-1.amazonses.com",
			description: t("dnsRecordDkimDescription"),
		},
	];
}

// ── DnsRecordRow ───────────────────────────────────────────────

function DnsRecordRow({
	record,
	domain,
}: {
	record: DnsRecord;
	domain: string;
}) {
	const { t } = useTranslation("domainDetails");
	const toastManager = useKumoToastManager();

	const handleCopy = (value: string) => {
		navigator.clipboard.writeText(value);
		toastManager.add({ title: t("copiedToClipboard") });
	};

	const displayName =
		record.name === domain
			? record.name
			: record.name.replace(`.${domain}`, "");
	const displayNameFull = record.name;

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-recessed p-4">
			<div className="flex items-start justify-between gap-4 mb-3">
				<div className="flex items-center gap-2">
					<span className="inline-flex items-center rounded-md bg-kumo-fill px-2 py-0.5 text-xs font-semibold text-kumo-default">
						{record.type}
					</span>
					<code className="text-sm font-mono text-kumo-default break-all">
						{displayNameFull}
					</code>
				</div>
				{record.priority !== undefined && (
					<span className="text-xs text-kumo-subtle">
						{t("dnsRecordPriority", { priority: record.priority })}
					</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				<code className="flex-1 text-xs font-mono text-kumo-subtle break-all bg-kumo-fill rounded px-2 py-1.5">
					{record.value}
				</code>
				<button
					type="button"
					onClick={() => handleCopy(record.value)}
					className="shrink-0 rounded-md p-1.5 text-kumo-muted hover:text-kumo-default hover:bg-kumo-fill transition-colors"
					aria-label={t("dnsRecordCopyAriaLabel", { value: record.value })}
					title={t("dnsRecordCopyValueTitle")}
				>
					<Copy size={14} />
				</button>
			</div>
			<p className="text-xs text-kumo-muted mt-2">{record.description}</p>
		</div>
	);
}

// ── Delete Dialog ───────────────────────────────────────────────

function DeleteDomainDialog({
	domainName,
	open,
	onClose,
	onDelete,
	isDeleting,
}: {
	domainName: string;
	open: boolean;
	onClose: () => void;
	onDelete: () => void;
	isDeleting: boolean;
}) {
	const { t } = useTranslation("domainDetails");
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
		>
			<Dialog size="sm" className="p-6">
				<div className="flex items-center gap-3 mb-4">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600">
						<TriangleAlert size={20} />
					</div>
					<Dialog.Title className="text-base font-semibold text-kumo-default">
						{t("deleteDomain")}
					</Dialog.Title>
				</div>
				<p className="text-sm text-kumo-subtle mb-5">
					{t("deleteDomainConfirmPrefix")}
					<strong className="text-kumo-default">{domainName}</strong>
					{t("deleteDomainConfirmSuffix")}
				</p>
				<div className="flex justify-end gap-2">
					<Dialog.Close
						render={(props) => (
							<Button {...props} variant="secondary" size="sm" disabled={isDeleting}>
								{t("common:cancel")}
							</Button>
						)}
					/>
					<Button
						variant="destructive"
						size="sm"
						loading={isDeleting}
						onClick={onDelete}
					>
						{t("common:delete")}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Page Component ──────────────────────────────────────────────

export function meta({ matches }: MetaArgs) {
	const rootData = matches.find((m) => m?.id === "root")?.data as
		| { locale?: string }
		| undefined;
	const locale = isLocale(rootData?.locale) ? rootData.locale : "en";
	return [{ title: translate(locale, "domainDetails:metaTitle") }];
}

export default function DomainDetailsRoute() {
	const { t } = useTranslation("domainDetails");
	const { i18n } = useTranslation();
	const locale: Locale = isLocale(i18n.language) ? i18n.language : "en";
	const { id: domainId } = useParams();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const toastManager = useKumoToastManager();

	const { data: domains = [], isFetched: domainsFetched } = useDomains();
	const { data: mailboxes = [] } = useMailboxes();

	// API Key management
	const { data: apiKeysData, isLoading: isApiKeysLoading } = useApiKeys(domainId!);
	const createApiKey = useCreateApiKey(domainId!);
	const revokeApiKey = useRevokeApiKey(domainId!);

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [createdKeyData, setCreatedKeyData] = useState<{ id: string; api_key: string; name: string; scopes: string } | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const deleteDomain = useDeleteDomain();
	const updateApiKey = useUpdateDomainApiKey();
	const setCatchAll = useSetCatchAll();

	const domain = domains.find((d) => d.id === domainId);

	// Resend API key state
	const [showApiKey, setShowApiKey] = useState(false);
	const [apiKeyInput, setApiKeyInput] = useState("");
	const [isEditingApiKey, setIsEditingApiKey] = useState(false);
	const [isVerifyingApiKey, setIsVerifyingApiKey] = useState(false);
	type ApiKeyVerifyStatus = "idle" | "verifying" | "valid" | "invalid" | "error";
	const [apiKeyVerifyStatus, setApiKeyVerifyStatus] = useState<ApiKeyVerifyStatus>("idle");
	const [apiKeyVerifyResult, setApiKeyVerifyResult] = useState<VerifyResendResult | null>(null);
	const [isSettingUpResend, setIsSettingUpResend] = useState(false);

	// Catch-all dialog
	const [isCatchAllOpen, setIsCatchAllOpen] = useState(false);

	// Delete dialog
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// ── Handlers ────────────────────────────────────────────────

	const handleCopy = (value: string) => {
		navigator.clipboard.writeText(value);
		toastManager.add({ title: t("copiedToClipboard") });
	};

	const handleVerifyApiKey = async () => {
		if (!domain || !apiKeyInput || !apiKeyInput.trim()) return;
		setIsVerifyingApiKey(true);
		setApiKeyVerifyStatus("verifying");
		setApiKeyVerifyResult(null);
		try {
			// Verify the API key directly against Resend using the domain
			const result = await api.verifyDomainResendKey(domain.id, apiKeyInput.trim());
			setApiKeyVerifyResult(result);
			setApiKeyVerifyStatus(result.valid ? "valid" : "invalid");
			if (result.valid) {
				// Refresh domain data so DomainFullStatus badge picks up the new status
				qc.invalidateQueries({ queryKey: ["domains"] });
			}
		} catch {
			setApiKeyVerifyStatus("error");
		} finally {
			setIsVerifyingApiKey(false);
		}
	};

	const handleSaveApiKey = async () => {
		if (!domain) return;
		const trimmed = apiKeyInput.trim();
		if (!trimmed) {
			toastManager.add({
				title: t("apiKeyEmpty"),
				variant: "error",
			});
			return;
		}
		// Auto-verify if not already verified
		if (apiKeyVerifyStatus !== "valid") {
			toastManager.add({
				title: t("verifyApiKeyFirst"),
				variant: "error",
			});
			return;
		}
		try {
			await updateApiKey.mutateAsync({
				domainId: domain.id,
				apiKey: trimmed,
			});
			toastManager.add({ title: t("resendApiKeyUpdated") });
			setIsEditingApiKey(false);
			setApiKeyInput("");
			setApiKeyVerifyStatus("idle");
			setApiKeyVerifyResult(null);
		} catch {
			toastManager.add({
				title: t("failedToUpdateApiKey"),
				variant: "error",
			});
		}
	};

	const handleSetupResendSending = async () => {
		if (!domain || !apiKeyInput.trim()) return;
		await doSetupResendSending();
	};

	const doSetupResendSending = async () => {
		if (!domain) return;
		setIsSettingUpResend(true);
		try {
			const result = await api.setupResendSending(domain.id, {
				apiKey: apiKeyInput.trim(),
			});
			if (result.success && result.verification) {
				setApiKeyVerifyResult(result.verification);
				setApiKeyVerifyStatus(result.verification.valid ? "valid" : "invalid");
				const dnsCreated = result.dnsResults?.some(r => r.status === "created");
				toastManager.add({
					title: dnsCreated
						? t("resendDomainCreatedDnsConfigured")
						: t("resendDomainCreatedAddDnsManual"),
				});
			} else {
				toastManager.add({
					title: result.error || t("failedToSetupResendDomain"),
					variant: "error",
				});
			}
		} catch {
			toastManager.add({
				title: t("failedToSetupResendDomain"),
				variant: "error",
			});
		} finally {
			setIsSettingUpResend(false);
		}
	};

	const handleDelete = async () => {
		if (!domain) return;
		setIsDeleting(true);
		try {
			await deleteDomain.mutateAsync(domain.id);
			toastManager.add({ title: t("domainDeleted") });
			navigate("/settings");
		} catch {
			toastManager.add({
				title: t("failedToDeleteDomain"),
				variant: "error",
			});
		} finally {
			setIsDeleting(false);
		}
	};

	// ── Loading / Not Found ─────────────────────────────────────

	if (!domainsFetched) {
		return (
			<div className="min-h-screen bg-kumo-recessed flex items-center justify-center">
				<div className="flex items-center justify-center"><Loader size="lg" /></div>
			</div>
		);
	}

	if (!domain) {
		return (
			<div className="min-h-screen bg-kumo-recessed">
				<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
					<div className="mb-6">
						<RouterLink
							to="/settings"
							className="inline-flex items-center gap-1.5 text-sm text-kumo-accent hover:text-kumo-accent/80 transition-colors"
						>
							<ArrowLeft size={14} />
							{t("backToMailboxes")}
						</RouterLink>
					</div>
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6 text-center">
						<h2 className="text-lg font-semibold text-kumo-default mb-2">
							{t("domainNotFoundTitle")}
						</h2>
						<p className="text-sm text-kumo-subtle mb-5">
							{t("domainNotFoundDescription")}
						</p>
						<Button variant="primary" onClick={() => navigate("/settings")}>
							{t("backToMailboxes")}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	const dnsRecords = getDnsRecords(domain.name, t);
	const maskedKey = domain.resend_api_key
		? `${domain.resend_api_key.slice(0, 4)}${"•".repeat(24)}${domain.resend_api_key.slice(-4)}`
		: null;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				{/* ── Header ──────────────────────────────────────── */}
				<div className="mb-8">
					<div className="mb-3">
						<RouterLink
							to="/settings"
							className="inline-flex items-center gap-1.5 text-sm text-kumo-accent hover:text-kumo-accent/80 transition-colors"
						>
							<ArrowLeft size={14} />
							{t("backToMailboxes")}
						</RouterLink>
					</div>
					<h1 className="text-2xl font-bold text-kumo-default mb-1">
						{domain.name}
					</h1>
					<div className="flex items-center gap-3">
						<DomainFullStatus domain={domain} />
						<span className="text-xs text-kumo-subtle">
							{t("created", {
								date: new Date(domain.created_at).toLocaleDateString(
									locale === "zh" ? "zh-CN" : "en-US",
									{
										year: "numeric",
										month: "short",
										day: "numeric",
									},
								),
							})}
						</span>
					</div>
				</div>

				{/* ── DNS Records ─────────────────────────────────── */}
				<div className="mb-6">
					<h2 className="text-lg font-semibold text-kumo-default mb-1">
						{t("dnsRecordsTitle")}
					</h2>
					<p className="text-sm text-kumo-subtle mb-4">
						{t("dnsRecordsDescription")}
					</p>
					<div className="space-y-3">
						{dnsRecords.map((record, idx) => (
							<DnsRecordRow
								key={`${record.type}-${idx}`}
								record={record}
								domain={domain.name}
							/>
						))}
					</div>
				</div>

				{/* ── Resend API Key ─────────────────────────────── */}
				<div className="mb-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<h2 className="text-base font-semibold text-kumo-default mb-1">
						{t("resendApiKeyTitle")}
					</h2>
					<p className="text-sm text-kumo-subtle mb-4">
						{t("resendApiKeyDescription")}
					</p>

					{domain.resend_api_key && !isEditingApiKey ? (
						<div className="flex items-center gap-2">
							<code className="flex-1 text-sm font-mono text-kumo-default bg-kumo-fill rounded px-3 py-2 break-all">
								{showApiKey
									? domain.resend_api_key
									: maskedKey}
							</code>
							<button
								type="button"
								onClick={() => setShowApiKey(!showApiKey)}
								className="shrink-0 rounded-md p-2 text-kumo-muted hover:text-kumo-default hover:bg-kumo-fill transition-colors"
								aria-label={showApiKey ? t("resendApiKeyHideAriaLabel") : t("resendApiKeyShowAriaLabel")}
							>
								{showApiKey ? (
									<EyeOff size={16} />
								) : (
									<Eye size={16} />
								)}
							</button>
							<button
								type="button"
								onClick={() => handleCopy(domain.resend_api_key!)}
								className="shrink-0 rounded-md p-2 text-kumo-muted hover:text-kumo-default hover:bg-kumo-fill transition-colors"
								aria-label={t("resendApiKeyCopyAriaLabel")}
								title={t("resendApiKeyCopyTitle")}
							>
								<Copy size={16} />
							</button>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => {
									setApiKeyInput(domain.resend_api_key ?? "");
									setIsEditingApiKey(true);
									setApiKeyVerifyStatus("idle");
									setApiKeyVerifyResult(null);
								}}
							>
								{t("resendApiKeyEdit")}
							</Button>
						</div>
					) : (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<Input
									type={showApiKey ? "text" : "password"}
									placeholder={t("resendApiKeyPlaceholder")}
									size="sm"
									value={apiKeyInput}
									onChange={(e) => {
										setApiKeyInput(e.target.value);
										setApiKeyVerifyStatus("idle");
										setApiKeyVerifyResult(null);
									}}
									className="flex-1 font-mono"
								/>
								<button
									type="button"
									onClick={() => setShowApiKey(!showApiKey)}
									className="shrink-0 rounded-md p-2 text-kumo-muted hover:text-kumo-default hover:bg-kumo-fill transition-colors"
									aria-label={showApiKey ? t("resendApiKeyHideAriaLabel") : t("resendApiKeyShowAriaLabel")}
								>
									{showApiKey ? (
										<EyeOff size={16} />
									) : (
										<Eye size={16} />
									)}
								</button>
							</div>

							{/* ── Verification status ── */}
							{apiKeyVerifyStatus !== "idle" && (
								<div className="rounded-lg border border-kumo-line bg-kumo-fill/50 px-3 py-2">
									{apiKeyVerifyStatus === "verifying" && (
										<div className="flex items-center gap-2">
											<Loader2 size={12} className="animate-spin text-kumo-subtle shrink-0" />
											<span className="text-xs text-kumo-subtle">{t("verifyingWithResend")}</span>
										</div>
									)}
									{apiKeyVerifyStatus === "valid" && apiKeyVerifyResult && (
										<div className="space-y-1.5">
											<Badge variant="success"><CircleCheckBig size={12} fill="currentColor" /> {t("apiKeyVerified")}</Badge>
											{apiKeyVerifyResult.sendingReady ? (
												<Badge variant="success">{t("domainVerifiedReadyToSend")}</Badge>
											) : apiKeyVerifyResult.matchingDomain ? (
												<Badge variant="warning"><TriangleAlert size={12} fill="currentColor" /> {t("domainMatchingStatus", { domain: apiKeyVerifyResult.matchingDomain.domain, status: apiKeyVerifyResult.matchingDomain.status })}<a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="underline font-medium">{t("verifyDnsRecordsInResend")}</a></Badge>
											) : (
												<div className="space-y-2">
													<Badge variant="warning"><TriangleAlert size={12} fill="currentColor" /> {t("noMatchingDomain", { name: domain.name })}</Badge>
													<Button size="xs" onClick={handleSetupResendSending} disabled={isSettingUpResend}>
														{isSettingUpResend ? (
															<><Loader2 size={12} className="animate-spin" /> {t("settingUp")}</>
														) : (
															<>{t("createAndConfigureInResend")}</>
														)}
													</Button>
												</div>
											)}
										</div>
									)}
									{apiKeyVerifyStatus === "invalid" && (
										<div>
											<Badge variant="error"><TriangleAlert size={12} fill="currentColor" /> {apiKeyVerifyResult?.error || t("invalidApiKey")}</Badge>
										</div>
									)}
									{apiKeyVerifyStatus === "error" && (
										<div>
											<Badge variant="error">{t("verificationFailedRetry")}</Badge>
										</div>
									)}
								</div>
							)}

							<div className="flex items-center gap-2 justify-end">
								<Button
									variant="secondary"
									size="sm"
									loading={isVerifyingApiKey}
									onClick={handleVerifyApiKey}
									disabled={!apiKeyInput || !apiKeyInput.trim() || isVerifyingApiKey}
								>
									{isVerifyingApiKey ? (
										<><Loader2 size={14} className="animate-spin" /> {t("verifying")}</>
									) : (
										<>{t("common:verify")}</>
									)}
								</Button>
								<Button
									variant="primary"
									size="sm"
									loading={updateApiKey.isPending}
									disabled={updateApiKey.isPending || apiKeyVerifyStatus !== "valid"}
									onClick={handleSaveApiKey}
								>
									{t("common:save")}
								</Button>
								{domain.resend_api_key && (
									<Button
										variant="secondary"
										size="sm"
										onClick={() => {
											setIsEditingApiKey(false);
											setApiKeyInput("");
											setApiKeyVerifyStatus("idle");
											setApiKeyVerifyResult(null);
										}}
										disabled={updateApiKey.isPending}
									>
										{t("common:cancel")}
									</Button>
								)}
							</div>
						</div>
					)}

					{!domain.resend_api_key && !isEditingApiKey && (
						<p className="text-xs text-kumo-muted mt-2">
							{t("resendApiKeyNotConfiguredPrefix")}
							<button
								type="button"
								onClick={() => setIsEditingApiKey(true)}
								className="text-kumo-accent hover:underline"
							>
								{t("resendApiKeyNotConfiguredLink")}
							</button>
							{t("resendApiKeyNotConfiguredSuffix")}
						</p>
					)}
				</div>

				{/* ── Catch-All Mailbox ─────────────────────────── */}
				<div className="mb-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-base font-semibold text-kumo-default mb-1">
								{t("catchAllTitle")}
							</h2>
							<p className="text-sm text-kumo-subtle">
								{domain.catch_all_mailbox ? (
									<>
										{t("catchAllRoutedPrefix")}
										<code className="font-mono text-kumo-default">
											{domain.name}
										</code>
										{t("catchAllRoutedSuffix")}
										<code className="font-mono text-kumo-default">
											{domain.catch_all_mailbox}
										</code>
									</>
								) : (
									<>
										{t("catchAllNonePrefix")}
										<code className="font-mono text-kumo-default">
											{domain.name}
										</code>
										{t("catchAllNoneSuffix")}
									</>
								)}
							</p>
						</div>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setIsCatchAllOpen(true)}
						>
							{domain.catch_all_mailbox ? t("catchAllEdit") : t("catchAllConfigure")}
						</Button>
					</div>
				</div>

				{/* ── API Keys ── */}

				<div className="mb-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-semibold text-kumo-default mb-1 flex items-center gap-2">
						<Key size={16} />
						{t("apiKeysTitle")}
					</div>
					<div className="text-sm text-kumo-subtle mb-4">
						{t("apiKeysDescriptionPrefix")}<code className="font-mono text-xs">mb_</code>{t("apiKeysDescriptionSuffix")}
					</div>

					{isApiKeysLoading ? (
						<div className="flex justify-center py-6">
							<Loader2 className="animate-spin" size={20} />
						</div>
					) : (
						<>
							{(!apiKeysData?.api_keys || apiKeysData.api_keys.length === 0) ? (
								<div className="text-sm text-kumo-subtle mb-4">
									{t("apiKeysEmpty")}
								</div>
							) : (
								<div className="mb-4">
									<div className="flex text-xs font-medium text-kumo-subtle px-1 py-1 border-b border-kumo-line">
										<div className="w-[160px]">{t("apiKeysColumnName")}</div>
										<div className="w-[140px]">{t("apiKeysColumnKeyPrefix")}</div>
										<div className="w-[80px]">{t("apiKeysColumnScopes")}</div>
										<div className="flex-1">{t("apiKeysColumnLastUsed")}</div>
										<div className="w-[60px]"></div>
									</div>
									{apiKeysData.api_keys.map((key) => (
										<div key={key.id} className="flex items-center text-xs font-medium px-1 py-1 border-b border-kumo-line">
											<div className="w-[160px] truncate">{key.name}</div>
											<div className="w-[140px] font-mono text-xs">{key.prefix}...</div>
											<div className="w-[80px]">
												<Badge variant="secondary">{key.scopes}</Badge>
											</div>
											<div className="flex-1 text-kumo-subtle">
												{key.last_used_at ? new Date(key.last_used_at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US") : t("apiKeysNever")}
											</div>
											<div className="w-[60px] flex justify-end">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setRevokeTarget({ id: key.id, name: key.name })}
													className="text-kumo-subtle hover:text-red-500"
												>
													<Trash2 size={14} />
												</Button>
											</div>
										</div>
									))}
								</div>
							)}

							<Button variant="primary" size="sm" onClick={() => setIsCreateOpen(true)}>
								<Plus size={14} />
								{t("createApiKey")}
							</Button>
						</>
					)}
				</div>

				{/* Create API Key Dialog */}
				<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title>{t("createApiKey")}</Dialog.Title>
						<div className="flex flex-col gap-4 py-4">
							<Input
								label={t("createApiKeyKeyName")}
								placeholder={t("createApiKeyKeyNamePlaceholder")}
								value={newKeyName}
								onChange={(e) => setNewKeyName(e.target.value)}
							/>
							<div>
								<div className="text-xs font-medium mb-1">{t("createApiKeyScopes")}</div>
								<Badge variant="secondary">send</Badge>
								<div className="text-xs text-kumo-subtle mt-1">
									{t("createApiKeyScopeHint")}
								</div>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="secondary" onClick={() => setIsCreateOpen(false)}>{t("common:cancel")}</Button>
							<Button
								variant="primary"
								onClick={async () => {
									try {
										const result = await createApiKey.mutateAsync({
											name: newKeyName.trim() || t("createApiKeyDefaultName"),
											scopes: "send",
										});
										setCreatedKeyData(result);
										setIsCreateOpen(false);
										setNewKeyName("");
									} catch (err) {
										// error handled by mutation
									}
								}}
								disabled={createApiKey.isPending}
							>
								{createApiKey.isPending ? t("createApiKeyCreating") : t("common:create")}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>

				{/* Revealed Key Dialog */}
				<Dialog.Root open={createdKeyData !== null} onOpenChange={(open) => { if (!open) { setCreatedKeyData(null); setCopiedId(null); } }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title>{t("apiKeyCreatedTitle")}</Dialog.Title>
						<div className="flex flex-col gap-4 py-4">
							<div className="text-sm">
								{t("apiKeyCreatedSaveNow")}
							</div>
							<div className="bg-kumo-base border border-kumo-line rounded p-3 flex items-center justify-between">
								<code className="font-mono text-sm break-all">
									{createdKeyData?.api_key}
								</code>
								<Button
									variant="ghost"
									size="sm"
									onClick={async () => {
										if (createdKeyData?.api_key) {
											await navigator.clipboard.writeText(createdKeyData.api_key);
											setCopiedId("new-key");
											setTimeout(() => setCopiedId(null), 2000);
										}
									}}
								>
									{copiedId === "new-key" ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
								</Button>
							</div>
							<div className="flex gap-1 bg-red-50 border border-red-200 rounded p-3 text-sm">
								<TriangleAlert size={16} className="text-amber-500 shrink-0 mt-1" />
								<span>{t("apiKeyCreatedWarning")}</span>
							</div>
						</div>
						<div className="flex justify-end">
							<Button variant="primary" onClick={() => { setCreatedKeyData(null); setCopiedId(null); }}>
								{t("apiKeyCreatedSaved")}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>

				{/* Revoke Confirmation Dialog */}
				<Dialog.Root open={revokeTarget !== null} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title>{t("revokeApiKeyTitle")}</Dialog.Title>
						<div className="flex flex-col gap-4 py-4">
							<div className="flex gap-1 bg-red-50 border border-red-200 rounded p-3 text-sm">
								<TriangleAlert size={16} className="text-red-500 shrink-0 mt-1" />
								<span>
									{t("revokeApiKeyConfirmPrefix")}<strong>"{revokeTarget?.name}"</strong>{t("revokeApiKeyConfirmSuffix")}
								</span>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="secondary" onClick={() => setRevokeTarget(null)}>{t("common:cancel")}</Button>
							<Button
								variant="destructive"
								onClick={async () => {
									if (!revokeTarget) return;
									try {
										await revokeApiKey.mutateAsync(revokeTarget.id);
										setRevokeTarget(null);
									} catch (err) {
										// error handled by mutation
									}
								}}
								disabled={revokeApiKey.isPending}
							>
								{revokeApiKey.isPending ? t("revoking") : t("revoke")}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>

				{/* ── Danger Zone ────────────────────────────────── */}
				<div className="rounded-xl border border-red-200 bg-kumo-base p-5">
					<h2 className="text-base font-semibold text-red-600 mb-1">
						{t("dangerZoneTitle")}
					</h2>
					<p className="text-sm text-kumo-subtle mb-4">
						{t("dangerZoneDescription")}
					</p>
					<Button
						variant="destructive"
						size="sm"
						icon={<Trash2 size={14} />}
						onClick={() => setIsDeleteOpen(true)}
					>
						{t("deleteDomain")}
					</Button>
				</div>
			</div>

			{/* ── Catch-All Dialog ────────────────────────────────── */}
			<CatchAllDialog
				domain={domain}
				open={isCatchAllOpen}
				onClose={() => setIsCatchAllOpen(false)}
			/>

			{/* ── Delete Confirmation Dialog ──────────────────────── */}
			<DeleteDomainDialog
				domainName={domain.name}
				open={isDeleteOpen}
				onClose={() => setIsDeleteOpen(false)}
				onDelete={handleDelete}
				isDeleting={isDeleting}
			/>

		</div>
	);
}
