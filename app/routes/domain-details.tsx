// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

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
	CircleCheckBig,
	Copy,
	Eye,
	EyeOff,
	Loader2,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { CatchAllDialog } from "~/components/CatchAllDialog";
import {
	useDeleteDomain,
	useDomains,
	useSetCatchAll,
	useUpdateDomainApiKey,
} from "~/queries/domains";
import { useMailboxes } from "~/queries/mailboxes";
import api, { type VerifyResendResult } from "~/services/api";

// ── DNS Record Static Data ──────────────────────────────────────

interface DnsRecord {
	type: string;
	name: string;
	value: string;
	priority?: number;
	description: string;
}

function getDnsRecords(domain: string): DnsRecord[] {
	return [
		{
			type: "MX",
			name: `feedback-smtp.${domain}`,
			value: "feedback-smtp.us-east-1.amazonses.com",
			priority: 10,
			description: "Bounce and complaint notifications",
		},
		{
			type: "TXT",
			name: domain,
			value: "v=spf1 include:amazonses.com ~all",
			description: "Authorize Amazon SES to send on behalf of this domain",
		},
		{
			type: "CNAME",
			name: `resend._domainkey.${domain}`,
			value: "resend._domainkey.us-east-1.amazonses.com",
			description: "DKIM signing key for email authentication",
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
	const toastManager = useKumoToastManager();

	const handleCopy = (value: string) => {
		navigator.clipboard.writeText(value);
		toastManager.add({ title: "Copied to clipboard" });
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
						Priority: {record.priority}
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
					aria-label={`Copy ${record.value}`}
					title="Copy value"
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
						Delete Domain
					</Dialog.Title>
				</div>
				<p className="text-sm text-kumo-subtle mb-5">
					Are you sure you want to delete{" "}
					<strong className="text-kumo-default">{domainName}</strong>?
					This will remove all DNS records and cannot be undone.
				</p>
				<div className="flex justify-end gap-2">
					<Dialog.Close
						render={(props) => (
							<Button {...props} variant="secondary" size="sm" disabled={isDeleting}>
								Cancel
							</Button>
						)}
					/>
					<Button
						variant="destructive"
						size="sm"
						loading={isDeleting}
						onClick={onDelete}
					>
						Delete
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Page Component ──────────────────────────────────────────────

export function meta() {
	return [{ title: "Domain Details — Mailboxes" }];
}

export default function DomainDetailsRoute() {
	const { id } = useParams();
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();

	const { data: domains = [], isFetched: domainsFetched } = useDomains();
	const { data: mailboxes = [] } = useMailboxes();
	const deleteDomain = useDeleteDomain();
	const updateApiKey = useUpdateDomainApiKey();
	const setCatchAll = useSetCatchAll();

	const domain = domains.find((d) => d.id === id);

	// Resend API key state
	const [showApiKey, setShowApiKey] = useState(false);
	const [apiKeyInput, setApiKeyInput] = useState("");
	const [isEditingApiKey, setIsEditingApiKey] = useState(false);
	const [isVerifyingApiKey, setIsVerifyingApiKey] = useState(false);
	type ApiKeyVerifyStatus = "idle" | "verifying" | "valid" | "invalid" | "error";
	const [apiKeyVerifyStatus, setApiKeyVerifyStatus] = useState<ApiKeyVerifyStatus>("idle");
	const [apiKeyVerifyResult, setApiKeyVerifyResult] = useState<VerifyResendResult | null>(null);

	// Catch-all dialog
	const [isCatchAllOpen, setIsCatchAllOpen] = useState(false);

	// Delete dialog
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// ── Handlers ────────────────────────────────────────────────

	const handleCopy = (value: string) => {
		navigator.clipboard.writeText(value);
		toastManager.add({ title: "Copied to clipboard" });
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
				title: "API key cannot be empty",
				variant: "error",
			});
			return;
		}
		// Auto-verify if not already verified
		if (apiKeyVerifyStatus !== "valid") {
			toastManager.add({
				title: "Please verify the API key first",
				variant: "error",
			});
			return;
		}
		try {
			await updateApiKey.mutateAsync({
				domainId: domain.id,
				apiKey: trimmed,
			});
			toastManager.add({ title: "Resend API key updated" });
			setIsEditingApiKey(false);
			setApiKeyInput("");
			setApiKeyVerifyStatus("idle");
			setApiKeyVerifyResult(null);
		} catch {
			toastManager.add({
				title: "Failed to update API key",
				variant: "error",
			});
		}
	};

	const handleDelete = async () => {
		if (!domain) return;
		setIsDeleting(true);
		try {
			await deleteDomain.mutateAsync(domain.id);
			toastManager.add({ title: "Domain deleted" });
			navigate("/settings");
		} catch {
			toastManager.add({
				title: "Failed to delete domain",
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
							Back to Mailboxes
						</RouterLink>
					</div>
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6 text-center">
						<h2 className="text-lg font-semibold text-kumo-default mb-2">
							Domain not found
						</h2>
						<p className="text-sm text-kumo-subtle mb-5">
							The domain you're looking for doesn't exist or has been deleted.
						</p>
						<Button variant="primary" onClick={() => navigate("/settings")}>
							Back to Mailboxes
						</Button>
					</div>
				</div>
			</div>
		);
	}

	const dnsRecords = getDnsRecords(domain.name);
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
							Back to Mailboxes
						</RouterLink>
					</div>
					<h1 className="text-2xl font-bold text-kumo-default mb-1">
						{domain.name}
					</h1>
					<div className="flex items-center gap-3">
						<DomainFullStatus domain={domain} />
						<span className="text-xs text-kumo-subtle">
							Created{" "}
							{new Date(domain.created_at).toLocaleDateString(undefined, {
								year: "numeric",
								month: "short",
								day: "numeric",
							})}
						</span>
					</div>
				</div>

				{/* ── DNS Records ─────────────────────────────────── */}
				<div className="mb-6">
					<h2 className="text-lg font-semibold text-kumo-default mb-1">
						DNS Records
					</h2>
					<p className="text-sm text-kumo-subtle mb-4">
						Add these DNS records to verify your domain. Changes may take up to
						48 hours to propagate.
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
						Resend API Key
					</h2>
					<p className="text-sm text-kumo-subtle mb-4">
						Required for sending emails via Resend.
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
								aria-label={showApiKey ? "Hide API key" : "Show API key"}
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
								aria-label="Copy API key"
								title="Copy to clipboard"
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
								Edit
							</Button>
						</div>
					) : (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<Input
									type={showApiKey ? "text" : "password"}
									placeholder="re_••••••••••••••••••••••••"
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
									aria-label={showApiKey ? "Hide API key" : "Show API key"}
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
											<span className="text-xs text-kumo-subtle">Verifying with Resend...</span>
										</div>
									)}
									{apiKeyVerifyStatus === "valid" && apiKeyVerifyResult && (
										<div className="space-y-1.5">
											<Badge variant="success"><CircleCheckBig size={12} fill="currentColor" /> API key verified</Badge>
											{apiKeyVerifyResult.sendingReady ? (
												<Badge variant="success">Domain verified & ready to send</Badge>
											) : apiKeyVerifyResult.matchingDomain ? (
												<Badge variant="warning"><TriangleAlert size={12} fill="currentColor" /> Domain "{apiKeyVerifyResult.matchingDomain.domain}" is "{apiKeyVerifyResult.matchingDomain.status}" — <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="underline font-medium">verify DNS records in Resend</a></Badge>
											) : (
												<Badge variant="warning"><TriangleAlert size={12} fill="currentColor" /> No matching domain for {domain.name} in Resend</Badge>
											)}
										</div>
									)}
									{apiKeyVerifyStatus === "invalid" && (
										<div>
											<Badge variant="error"><TriangleAlert size={12} fill="currentColor" /> {apiKeyVerifyResult?.error || "Invalid API key"}</Badge>
										</div>
									)}
									{apiKeyVerifyStatus === "error" && (
										<div>
											<Badge variant="error">Verification failed — try again</Badge>
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
										<><Loader2 size={14} className="animate-spin" /> Verifying…</>
									) : (
										<>Verify</>
									)}
								</Button>
								<Button
									variant="primary"
									size="sm"
									loading={updateApiKey.isPending}
									disabled={updateApiKey.isPending || apiKeyVerifyStatus !== "valid"}
									onClick={handleSaveApiKey}
								>
									Save
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
										Cancel
									</Button>
								)}
							</div>
						</div>
					)}

					{!domain.resend_api_key && !isEditingApiKey && (
						<p className="text-xs text-kumo-muted mt-2">
							Not configured. Click{" "}
							<button
								type="button"
								onClick={() => setIsEditingApiKey(true)}
								className="text-kumo-accent hover:underline"
							>
								here
							</button>{" "}
							to add one.
						</p>
					)}
				</div>

				{/* ── Catch-All Mailbox ─────────────────────────── */}
				<div className="mb-6 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-base font-semibold text-kumo-default mb-1">
								Catch-All Mailbox
							</h2>
							<p className="text-sm text-kumo-subtle">
								{domain.catch_all_mailbox ? (
									<>
										Emails for unknown addresses on{" "}
										<code className="font-mono text-kumo-default">
											{domain.name}
										</code>{" "}
										are routed to{" "}
										<code className="font-mono text-kumo-default">
											{domain.catch_all_mailbox}
										</code>
									</>
								) : (
									<>
										No catch-all configured for{" "}
										<code className="font-mono text-kumo-default">
											{domain.name}
										</code>
										. Unknown addresses will be dropped.
									</>
								)}
							</p>
						</div>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setIsCatchAllOpen(true)}
						>
							{domain.catch_all_mailbox ? "Edit" : "Configure"}
						</Button>
					</div>
				</div>

				{/* ── Danger Zone ────────────────────────────────── */}
				<div className="rounded-xl border border-red-200 bg-kumo-base p-5">
					<h2 className="text-base font-semibold text-red-600 mb-1">
						Danger Zone
					</h2>
					<p className="text-sm text-kumo-subtle mb-4">
						Permanently delete this domain and all associated configuration.
						This action cannot be undone.
					</p>
					<Button
						variant="destructive"
						size="sm"
						icon={<Trash2 size={14} />}
						onClick={() => setIsDeleteOpen(true)}
					>
						Delete Domain
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
