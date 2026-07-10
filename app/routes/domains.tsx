// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	CheckCircleIcon,
	GlobeIcon,
	PlusIcon,
	TrashIcon,
	WarningIcon,
	AtIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
	useCreateDomain,
	useDeleteDomain,
	useDomains,
	useSetCatchAll,
} from "~/queries/domains";
import type { Domain } from "~/types";

// ── Helpers ────────────────────────────────────────────────────────

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

// ── Add Domain Wizard ──────────────────────────────────────────────

interface AddDomainWizardProps {
	onClose: () => void;
	onSuccess: () => void;
}

type WizardStep = "domain" | "resend-key" | "dns-records" | "done";

function AddDomainWizard({ onClose, onSuccess }: AddDomainWizardProps) {
	const toastManager = useKumoToastManager();
	const createDomain = useCreateDomain();

	const [step, setStep] = useState<WizardStep>("domain");
	const [domainName, setDomainName] = useState("");
	const [resendApiKey, setResendApiKey] = useState("");
	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Step A: Domain name
	const handleDomainSubmit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!domainName.trim()) {
			setError("Please enter a domain name");
			return;
		}
		if (!domainName.includes(".")) {
			setError("Please enter a valid domain (e.g. example.com)");
			return;
		}
		setStep("resend-key");
	};

	// Step B: Resend API Key → create domain via backend + get DNS records
	const handleResendSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!resendApiKey.trim()) {
			setError("Please enter your Resend API Key");
			return;
		}

		setIsProcessing(true);
		try {
			// Call backend which creates the Resend domain and returns DNS records
			await createDomain.mutateAsync({
				name: domainName.trim(),
				resendApiKey: resendApiKey.trim(),
			});

			setStep("dns-records");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to add domain";
			setError(msg);
		} finally {
			setIsProcessing(false);
		}
	};

	// Step C → D: User confirms DNS records
	const handleDnsConfirm = () => {
		setStep("done");
		toastManager.add({ title: "Domain added! Waiting for DNS verification." });
		onSuccess();
	};

	const handleClose = () => {
		if (step === "done") {
			onClose();
		} else {
			onClose();
		}
	};

	return (
		<Dialog.Root open onOpenChange={handleClose}>
			<Dialog size="sm" className="p-6">
				{/* ── Step A: Domain Name ──────────────────── */}
				{step === "domain" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							Add Domain
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							Enter the domain you want to add for sending and receiving email via Resend.
						</p>
						<form onSubmit={handleDomainSubmit} className="space-y-4">
							{error && (
								<div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
									<WarningIcon size={14} className="text-red-600 shrink-0" />
									<span className="text-sm text-red-600">{error}</span>
								</div>
							)}
							<Input
								label="Domain Name"
								placeholder="example.com"
								size="sm"
								value={domainName}
								onChange={(e) => setDomainName(e.target.value)}
								autoFocus
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
								<Button type="submit" variant="primary" size="sm">
									Continue
									<CaretRightIcon size={14} />
								</Button>
							</div>
						</form>
					</>
				)}

				{/* ── Step B: Resend API Key ────────────────── */}
				{step === "resend-key" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							Resend API Key
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							Enter your Resend API key to set up email sending for{" "}
							<strong className="text-kumo-default">{domainName}</strong>.
						</p>
						<form onSubmit={handleResendSubmit} className="space-y-4">
							{error && (
								<div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
									<WarningIcon size={14} className="text-red-600 shrink-0" />
									<span className="text-sm text-red-600">{error}</span>
								</div>
							)}
							<Input
								label="Resend API Key"
								placeholder="re_••••••••••••••••••••••••••••"
								size="sm"
								type="password"
								value={resendApiKey}
								onChange={(e) => setResendApiKey(e.target.value)}
								autoFocus
								required
							/>
							<div className="rounded-lg bg-kumo-fill px-3 py-2.5">
								<p className="text-xs text-kumo-subtle">
									Get your key from{" "}
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
							<div className="flex justify-end gap-2 pt-2">
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={() => { setError(null); setStep("domain"); }}
								>
									Back
								</Button>
								<Button
									type="submit"
									variant="primary"
									size="sm"
									loading={isProcessing}
									disabled={isProcessing}
								>
									Create Domain
								</Button>
							</div>
						</form>
					</>
				)}

				{/* ── Step C: DNS Records ───────────────────── */}
				{step === "dns-records" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							Add DNS Records
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							Add these DNS records to <strong className="text-kumo-default">{domainName}</strong> at your
							DNS provider to enable email sending via Resend.
						</p>

						<div className="space-y-3 mb-5">
							{/* MX Record */}
							<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
								<div className="flex items-center gap-2 mb-2">
									<span className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
										MX
									</span>
									<span className="text-xs text-kumo-subtle">
										Priority: 10
									</span>
								</div>
								<div className="space-y-1">
									<div>
										<span className="text-xs text-kumo-subtle">Name: </span>
										<code className="text-xs text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
											@
										</code>
									</div>
									<div>
										<span className="text-xs text-kumo-subtle">Value: </span>
										<code className="text-xs text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded break-all">
											feedback-smtp.us-east-1.amazonses.com
										</code>
									</div>
								</div>
							</div>

							{/* TXT Record (SPF) */}
							<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
								<div className="flex items-center gap-2 mb-2">
									<span className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
										TXT
									</span>
								</div>
								<div className="space-y-1">
									<div>
										<span className="text-xs text-kumo-subtle">Name: </span>
										<code className="text-xs text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
											@
										</code>
									</div>
									<div>
										<span className="text-xs text-kumo-subtle">Value: </span>
										<code className="text-xs text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded break-all">
											v=spf1 include:amazonses.com ~all
										</code>
									</div>
								</div>
							</div>
						</div>

						<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 mb-5">
							<p className="text-xs text-kumo-subtle">
								DNS changes may take up to 24-48 hours to propagate. We'll
								automatically verify the domain once the records are detected.
							</p>
						</div>

						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setStep("resend-key")}
							>
								Back
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={handleDnsConfirm}
							>
								I'll Add These Later
								<CheckCircleIcon size={14} />
							</Button>
						</div>
					</>
				)}

				{/* ── Step D: Done ─────────────────────────── */}
				{step === "done" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
								<CheckCircleIcon size={24} className="text-green-500" />
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							Domain Added
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							<strong className="text-kumo-default">{domainName}</strong> has been
							added and is waiting for DNS verification. Once the DNS records
							propagate, the domain will be verified automatically.
						</p>
						<div className="flex justify-center">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="primary" size="sm">
										Done
									</Button>
								)}
							/>
						</div>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

// ── Catch-all Mailbox Dialog ────────────────────────────────────

interface CatchAllDialogProps {
	domain: Domain | null;
	open: boolean;
	onClose: () => void;
}

function CatchAllDialog({ domain, open, onClose }: CatchAllDialogProps) {
	const toastManager = useKumoToastManager();
	const setCatchAll = useSetCatchAll();

	const [inputValue, setInputValue] = useState<string>(
		domain?.catch_all_mailbox ? `*@${domain.name}` : "",
	);
	const [isSaving, setIsSaving] = useState(false);

	const handleSave = async () => {
		if (!domain) return;
		setIsSaving(true);
		try {
			const value = inputValue.trim();
			let catchAllMailbox: string | null;

			if (!value) {
				// Empty field -> disable catch-all
				catchAllMailbox = null;
			} else if (value === `*@${domain.name}`) {
				// Simplified input -> pass as-is, backend will auto-create
				catchAllMailbox = value;
			} else {
				toastManager.add({
					title: `Please enter *@${domain.name} to enable catch-all`,
					variant: "error",
				});
				return;
			}

			await setCatchAll.mutateAsync({
				domainId: domain.id,
				catchAllMailbox,
			});
			toastManager.add({
				title: catchAllMailbox
					? `Catch-all set to catchall@${domain.name}`
					: "Catch-all disabled",
			});
			onClose();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to update catch-all";
			toastManager.add({ title: msg, variant: "error" });
		} finally {
			setIsSaving(false);
		}
	};

	if (!domain) return null;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-1">
					Catch-all Mailbox
				</Dialog.Title>
				<p className="text-sm text-kumo-subtle mb-5">
					When an email arrives for a non-existent address on{' '}
					<strong className="text-kumo-default">{domain.name}</strong>,{' '}
					it will be delivered to the catch-all mailbox instead of being dropped.
				</p>

				<div className="space-y-4">
					<div>
						<label className="block text-sm font-medium text-kumo-default mb-1.5">
							{domain.catch_all_mailbox
								? `Catch-all: ${domain.catch_all_mailbox}`
								: "Catch-all: disabled"}
						</label>
						<Input
							placeholder={`*@${domain.name}`}
							size="sm"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							autoFocus
						/>
						<p className="text-xs text-kumo-subtle mt-1.5">
							Type <code className="font-mono">*@{domain.name}</code> to route unmatched emails to{' '}
							<code className="font-mono">catchall@{domain.name}</code>.{' '}
							Clear the field to disable.
						</p>
					</div>
					<div className="flex justify-end gap-2 pt-2">
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
							loading={isSaving}
							disabled={isSaving}
							onClick={handleSave}
						>
							Save
						</Button>
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
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
									icon={<AtIcon size={16} />}
									aria-label={`Catch-all for ${domain.name}`}
									title={domain.catch_all_mailbox ? `Catch-all: ${domain.catch_all_mailbox}` : "Set catch-all mailbox"}
									onClick={() => {
										setCatchAllDomain(domain);
										setIsCatchAllOpen(true);
									}}
								/>
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

			{/* Add Domain Wizard */}
			{isCreateOpen && (
				<AddDomainWizard
					onClose={() => setIsCreateOpen(false)}
					onSuccess={() => setIsCreateOpen(false)}
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
