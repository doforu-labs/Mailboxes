// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Badge,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	CaretLeftIcon,
	CheckCircleIcon,
	WarningIcon,
	GlobeIcon,
	EnvelopeSimpleIcon,
	PaperPlaneIcon,
	CloudIcon,
	ArrowRightIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
import { useCreateDomain } from "~/queries/domains";
import api from "~/services/api";

// ── CF Credentials from localStorage ──────────────────────────────

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

// ── Types ─────────────────────────────────────────────────────────

interface AddDomainWizardProps {
	onClose: () => void;
	onSuccess: () => void;
	onComplete?: () => void;
	defaultDomain?: string;
	defaultApiKey?: string;
}

type WizardStep =
	| "domain"
	| "domain-type"
	| "receive-cf"
	| "receive-external"
	| "sending"
	| "dns-records"
	| "done";

/** Logical positions for the step indicator (not all steps are visible). */
type StepPosition = "domain" | "receive" | "sending" | "done";

const STEP_POSITIONS: StepPosition[] = ["domain", "receive", "sending", "done"];

function positionForStep(step: WizardStep): StepPosition {
	switch (step) {
		case "domain":
			return "domain";
		case "domain-type":
			return "domain";
		case "receive-cf":
		case "receive-external":
			return "receive";
		case "sending":
		case "dns-records":
			return "sending";
		case "done":
			return "done";
	}
}

const STEP_LABELS: Record<StepPosition, string> = {
	domain: "Domain",
	receive: "Receiving",
	sending: "Sending",
	done: "Done",
};

// ── Step Indicator ────────────────────────────────────────────────

function StepIndicator({ currentStep }: { currentStep: WizardStep }) {
	const current = positionForStep(currentStep);
	const currentIdx = STEP_POSITIONS.indexOf(current);

	return (
		<div className="flex items-center justify-center gap-2 mb-6">
			{STEP_POSITIONS.map((pos, i) => {
				const isCompleted = i < currentIdx;
				const isActive = i === currentIdx;
				return (
					<div key={pos} className="flex items-center gap-2">
						<div className="flex flex-col items-center gap-1">
							<div
								className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
									isCompleted
										? "bg-green-500 text-white"
										: isActive
											? "bg-blue-600 text-white"
											: "bg-kumo-fill text-kumo-muted border border-kumo-line"
								}`}
							>
								{isCompleted ? (
									<CheckCircleIcon size={14} />
								) : (
									i + 1
								)}
							</div>
							<span
								className={`text-[10px] font-medium ${
									isActive
										? "text-blue-600"
										: isCompleted
											? "text-green-600"
											: "text-kumo-muted"
								}`}
							>
								{STEP_LABELS[pos]}
							</span>
						</div>
						{i < STEP_POSITIONS.length - 1 && (
							<div
								className={`h-px w-8 mb-4 ${
									i < currentIdx ? "bg-green-400" : "bg-kumo-line"
								}`}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ── Error Banner ──────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
			<WarningIcon size={14} className="text-red-600 shrink-0" />
			<span className="text-sm text-red-600">{message}</span>
		</div>
	);
}

// ── Main Component ────────────────────────────────────────────────

export function AddDomainWizard({
	onClose,
	onSuccess,
	onComplete,
	defaultDomain,
	defaultApiKey,
}: AddDomainWizardProps) {
	const toastManager = useKumoToastManager();
	const createDomain = useCreateDomain();

	// ── State ──
	const [step, setStep] = useState<WizardStep>("domain");
	const [domainName, setDomainName] = useState(defaultDomain ?? "");
	const [resendApiKey, setResendApiKey] = useState(defaultApiKey ?? "");
	const [error, setError] = useState<string | null>(null);
	const [isProcessing, setIsProcessing] = useState(false);

	// Domain detection
	const [isCfManaged, setIsCfManaged] = useState<boolean | null>(null);
	const [cfZoneName, setCfZoneName] = useState<string | null>(null);
	const [detecting, setDetecting] = useState(false);

	// Receiving setup
	const [receiveStatus, setReceiveStatus] = useState<
		"idle" | "loading" | "success" | "failed"
	>("idle");
	const [receiveError, setReceiveError] = useState<string | null>(null);

	// DNS records for sending
	const [dnsRecords, setDnsRecords] = useState<
		Array<{ name: string; type: string; status: string }>
	>([]);

	// Verify
	const [verifyStatus, setVerifyStatus] = useState<
		"idle" | "verifying" | "verified" | "failed"
	>("idle");
	const [verifyError, setVerifyError] = useState<string | null>(null);

	// Summary
	const [summary, setSummary] = useState<{
		receiving: "configured" | "skipped" | "failed";
		sending: "configured" | "skipped" | "failed";
	}>({ receiving: "skipped", sending: "skipped" });

	// ── Step 1: Domain name → detect ──
	const handleDomainSubmit = async (e: FormEvent) => {
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

		// Attempt CF detection
		setDetecting(true);
		try {
			const creds = loadCfCredentials();
			if (creds.cfApiToken && creds.cfAccountId) {
				const result = await api.detectCfDomains(creds);
				const trimmed = domainName.trim();
				const match = result.zones.find(
					(z) => z.name === trimmed || trimmed.endsWith(`.${z.name}`),
				);
				if (match) {
					setIsCfManaged(true);
					setCfZoneName(match.name);
				} else {
					setIsCfManaged(false);
				}
			} else {
				setIsCfManaged(false);
			}
		} catch {
			setIsCfManaged(false);
		} finally {
			setDetecting(false);
			setStep("domain-type");
		}
	};

	// ── Step 2: Domain type → proceed to receiving ──
	const handleDomainTypeContinue = () => {
		if (isCfManaged) {
			setStep("receive-cf");
		} else {
			setStep("receive-external");
		}
	};

	// ── Step 3a: Receiving – CF auto-setup ──
	useEffect(() => {
		if (step !== "receive-cf" || receiveStatus !== "idle") return;

		const setup = async () => {
			setReceiveStatus("loading");
			try {
				const creds = loadCfCredentials();
				await api.setupEmailRouting({
					domain: domainName.trim(),
					cfApiToken: creds.cfApiToken,
					cfAccountId: creds.cfAccountId,
				});
				setReceiveStatus("success");
			} catch (err: unknown) {
				setReceiveStatus("failed");
				setReceiveError(
					err instanceof Error
						? err.message
						: "Failed to configure email routing",
				);
			}
		};
		setup();
	}, [step, receiveStatus, domainName]);

	// ── Step 4: Sending – Resend API Key → create domain ──
	const handleSendingSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		setIsProcessing(true);
		try {
			const result = await createDomain.mutateAsync({
				name: domainName.trim(),
				resendApiKey: resendApiKey.trim() || undefined,
			});
			setDnsRecords(result.dnsRecords);
			setStep("dns-records");
		} catch (err: unknown) {
			const msg =
				err instanceof Error ? err.message : "Failed to create domain";
			setError(msg);
		} finally {
			setIsProcessing(false);
		}
	};

	// ── Step 5: DNS verify ──
	const handleVerify = async () => {
		setVerifyError(null);
		setVerifyStatus("verifying");
		try {
			const creds = loadCfCredentials();
			const result = await api.verifyDomain({
				domain: domainName.trim(),
				resendApiKey: resendApiKey.trim(),
				cfApiToken: creds.cfApiToken,
				cfAccountId: creds.cfAccountId,
			});
			if (result.status === "verified" || result.status === "valid") {
				setVerifyStatus("verified");
				setSummary({
					receiving: isCfManaged ? "configured" : "skipped",
					sending: "configured",
				});
				setStep("done");
				toastManager.add({
					title: `Domain ${domainName} verified successfully!`,
				});
				onSuccess();
				onComplete?.();
			} else {
				setVerifyStatus("failed");
				setVerifyError(
					`Domain status: ${result.status}. DNS records may still be propagating. Please wait a few minutes and try again.`,
				);
			}
		} catch (err: unknown) {
			setVerifyStatus("failed");
			const msg =
				err instanceof Error ? err.message : "Verification failed";
			setVerifyError(msg);
		}
	};

	const handleSkipVerify = () => {
		setSummary({
			receiving: isCfManaged ? "configured" : "skipped",
			sending: "configured",
		});
		setStep("done");
		toastManager.add({
			title: "Domain added! You can verify DNS later from the Domains page.",
		});
		onSuccess();
		onComplete?.();
	};

	const handleSkipSending = () => {
		setSummary({
			receiving: isCfManaged ? "configured" : "skipped",
			sending: "skipped",
		});
		setStep("done");
		toastManager.add({
			title: "Domain added for receiving. You can set up sending later.",
		});
		onSuccess();
		onComplete?.();
	};

	const handleClose = () => onClose();

	return (
		<Dialog.Root open onOpenChange={handleClose}>
			<Dialog size="sm" className="p-6">
				<StepIndicator currentStep={step} />

				{/* ── Step 1: Domain Name ──────────────────── */}
				{step === "domain" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							Add Domain
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							Enter the domain you want to add for sending and
							receiving email.
						</p>
						<form onSubmit={handleDomainSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<div>
								<label className="block text-sm font-medium text-kumo-strong mb-1">
									Domain Name
								</label>
								<input
									type="text"
									placeholder="example.com"
									className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
									value={domainName}
									onChange={(e) => setDomainName(e.target.value)}
									autoFocus
									required
								/>
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
									type="submit"
									variant="primary"
									size="sm"
									loading={detecting}
									disabled={detecting}
								>
									Continue
									<CaretRightIcon size={14} />
								</Button>
							</div>
						</form>
					</>
				)}

				{/* ── Step 2: Domain Type Detected ────────── */}
				{step === "domain-type" && (
					<>
						<div className="flex justify-center mb-4">
							<div
								className={`flex h-12 w-12 items-center justify-center rounded-full ${
									isCfManaged
										? "bg-blue-500/10"
										: "bg-amber-500/10"
								}`}
							>
								{isCfManaged ? (
									<CloudIcon
										size={24}
										className="text-blue-500"
									/>
								) : (
									<GlobeIcon
										size={24}
										className="text-amber-500"
									/>
								)}
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							{isCfManaged
								? "Cloudflare-Managed Domain"
								: "External Domain"}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-2">
							<strong className="text-kumo-default">
								{domainName}
							</strong>{" "}
							{isCfManaged
								? `is managed by Cloudflare${cfZoneName ? ` (${cfZoneName})` : ""}.`
								: "is not managed by Cloudflare."}
						</p>
						<div className="rounded-lg bg-kumo-fill px-3 py-2.5 mb-5">
							{isCfManaged ? (
								<p className="text-xs text-kumo-subtle">
									Email Routing can be configured automatically.
									In the next step we'll set up a catch-all route
									to receive all email sent to this domain.
								</p>
							) : (
								<p className="text-xs text-kumo-subtle">
									You'll need to manually configure MX records
									and email forwarding at your DNS provider. We'll
									provide the instructions.
								</p>
							)}
						</div>
						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setStep("domain")}
							>
								<CaretLeftIcon size={14} />
								Back
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={handleDomainTypeContinue}
							>
								Continue
								<CaretRightIcon size={14} />
							</Button>
						</div>
					</>
				)}

				{/* ── Step 3a: Receiving – CF Auto-Setup ────── */}
				{step === "receive-cf" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
								<EnvelopeSimpleIcon
									size={24}
									className="text-blue-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							Email Routing Setup
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							Configuring Cloudflare Email Routing for{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>
							.
						</p>

						<div className="space-y-3 mb-5">
							{receiveStatus === "loading" && (
								<div className="flex flex-col items-center gap-3 py-4">
									<Loader size="base" />
									<p className="text-sm text-kumo-subtle">
										Configuring catch-all email routing…
									</p>
								</div>
							)}
							{receiveStatus === "success" && (
								<div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2.5">
									<CheckCircleIcon
										size={14}
										className="text-green-600 shrink-0"
									/>
									<span className="text-sm text-green-700">
										Email Routing configured! All email sent to{" "}
										<code className="font-mono">
											*@{domainName}
										</code>{" "}
										will be delivered to your catch-all mailbox.
									</span>
								</div>
							)}
							{receiveStatus === "failed" && (
								<div className="space-y-2">
									<ErrorBanner
										message={
											receiveError ??
											"Failed to configure email routing"
										}
									/>
									<p className="text-xs text-kumo-subtle">
										You can set this up manually later, or try
										again from the Domains page.
									</p>
								</div>
							)}
						</div>

						<div className="flex justify-end gap-2">
							{receiveStatus === "loading" ? (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => {
										setReceiveStatus("idle");
										setReceiveError(null);
										setStep("sending");
									}}
								>
									Skip for now
								</Button>
							) : (
								<>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setStep("domain-type")}
									>
										<CaretLeftIcon size={14} />
										Back
									</Button>
									{receiveStatus === "success" ? (
										<Button
											variant="primary"
											size="sm"
											onClick={() => setStep("sending")}
										>
											Continue
											<CaretRightIcon size={14} />
										</Button>
									) : receiveStatus === "failed" ? (
										<>
											<Button
												variant="secondary"
												size="sm"
												onClick={() => {
													setReceiveStatus("idle");
													setReceiveError(null);
													setStep("sending");
												}}
											>
												Skip receiving
											</Button>
											<Button
												variant="primary"
												size="sm"
												onClick={() => {
													setReceiveStatus("idle");
													setReceiveError(null);
												}}
											>
												Retry
											</Button>
										</>
									) : (
										<Button
											variant="primary"
											size="sm"
											onClick={() => setStep("sending")}
										>
											Continue
											<CaretRightIcon size={14} />
										</Button>
									)}
								</>
							)}
						</div>
					</>
				)}

				{/* ── Step 3b: Receiving – External Domain ──── */}
				{step === "receive-external" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
								<EnvelopeSimpleIcon
									size={24}
									className="text-amber-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							Receiving Setup
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							To receive email for{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>
							, add these MX records at your DNS provider.
						</p>

						<div className="space-y-3 mb-4">
							<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
								<div className="flex items-center gap-2 mb-2">
									<span className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
										MX
									</span>
									<span className="text-xs text-kumo-subtle">
										Name:{" "}
										<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
											@
										</code>
									</span>
								</div>
								<p className="text-xs text-kumo-subtle mb-1">
									Value:{" "}
									<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
										mailboxes.pages.dev
									</code>
								</p>
								<p className="text-xs text-kumo-subtle">
									Priority:{" "}
									<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
										10
									</code>
								</p>
							</div>
							<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
								<p className="text-xs text-kumo-subtle">
									After adding the MX record, set up email
									forwarding at your DNS provider to forward
									mail to your Cloudflare Worker endpoint. The
									exact steps depend on your provider.
								</p>
							</div>
						</div>

						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setStep("domain-type")}
							>
								<CaretLeftIcon size={14} />
								Back
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={handleSkipSending}
							>
								Skip for now
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={() => setStep("sending")}
							>
								Continue
								<CaretRightIcon size={14} />
							</Button>
						</div>
					</>
				)}

				{/* ── Step 4: Sending – Resend API Key ────── */}
				{step === "sending" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
								<PaperPlaneIcon
									size={24}
									className="text-green-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							Sending Setup
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							Enter your Resend API key to enable email sending
							for{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>
							.
						</p>
						<form onSubmit={handleSendingSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<Input
								label="Resend API Key"
								placeholder="re_••••••••••••••••••••••••••••"
								size="sm"
								type="password"
								value={resendApiKey}
								onChange={(e) => setResendApiKey(e.target.value)}
								autoFocus
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
									onClick={() => {
										setError(null);
										setStep(
											isCfManaged
												? "receive-cf"
												: "receive-external",
										);
									}}
								>
									<CaretLeftIcon size={14} />
									Back
								</Button>
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={() => {
										setError(null);
										setResendApiKey("");
										setSummary({
											receiving: isCfManaged
												? "configured"
												: "skipped",
											sending: "skipped",
										});
										setStep("done");
										toastManager.add({
											title: "Domain added! You can set up sending later.",
										});
										onSuccess();
										onComplete?.();
									}}
								>
									Skip sending
								</Button>
								<Button
									type="submit"
									variant="primary"
									size="sm"
									loading={isProcessing}
									disabled={isProcessing}
								>
									Create Domain
									<CaretRightIcon size={14} />
								</Button>
							</div>
						</form>
					</>
				)}

				{/* ── Step 5: DNS Records for Sending ──────── */}
				{step === "dns-records" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							DNS Records for Sending
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							Add these DNS records to{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>{" "}
							at your domain registrar or DNS provider.
						</p>

						<div className="space-y-3 mb-5">
							{dnsRecords.map((record, i) => (
								<div
									key={i}
									className="rounded-lg border border-kumo-line bg-kumo-fill p-3"
								>
									<div className="flex items-center gap-2 mb-2">
										<span className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
											{record.type}
										</span>
										{record.name && (
											<span className="text-xs text-kumo-subtle">
												Name:{" "}
												<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
													{record.name}
												</code>
											</span>
										)}
										<Badge
											variant={
												record.status === "verified"
													? "success"
													: record.status === "failed"
														? "error"
														: "info"
											}
										>
											{record.status}
										</Badge>
									</div>
									<p className="text-xs text-kumo-subtle">
										Add this {record.type} record at your DNS
										provider. The status above shows whether
										Resend has detected it.
									</p>
								</div>
							))}
							{dnsRecords.length === 0 && (
								<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
									<p className="text-sm text-kumo-subtle">
										No DNS records returned. The domain may
										already be configured.
									</p>
								</div>
							)}
						</div>

						<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 mb-5">
							<p className="text-xs text-kumo-subtle">
								DNS changes may take a few minutes to propagate.
								After adding the records, click{" "}
								<strong>"Verify DNS"</strong> to check if they
								are detected.
							</p>
						</div>

						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setStep("sending")}
							>
								Back
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={handleSkipVerify}
							>
								Skip for Now
							</Button>
							<Button
								variant="primary"
								size="sm"
								loading={verifyStatus === "verifying"}
								onClick={handleVerify}
							>
								Verify DNS
								<CheckCircleIcon size={14} />
							</Button>
						</div>

						{verifyError && (
							<div className="mt-4 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2.5">
								<p className="text-xs text-yellow-800">
									{verifyError}
								</p>
							</div>
						)}
					</>
				)}

				{/* ── Step 6: Done ────────────────────────── */}
				{step === "done" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
								<CheckCircleIcon
									size={24}
									className="text-green-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							Domain Added
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							<strong className="text-kumo-default">
								{domainName}
							</strong>{" "}
							has been added successfully.
						</p>

						<div className="space-y-2 mb-5">
							<div className="flex items-center gap-2 rounded-lg bg-kumo-fill px-3 py-2">
								<EnvelopeSimpleIcon
									size={14}
									className="text-kumo-subtle shrink-0"
								/>
								<span className="text-sm text-kumo-default font-medium">
									Receiving
								</span>
								<Badge
									variant={
										summary.receiving === "configured"
											? "success"
											: summary.receiving === "failed"
												? "error"
												: "secondary"
									}
								>
									{summary.receiving === "configured"
										? "Configured"
										: summary.receiving === "failed"
											? "Failed"
											: "Skipped"}
								</Badge>
							</div>
							<div className="flex items-center gap-2 rounded-lg bg-kumo-fill px-3 py-2">
								<PaperPlaneIcon
									size={14}
									className="text-kumo-subtle shrink-0"
								/>
								<span className="text-sm text-kumo-default font-medium">
									Sending
								</span>
								<Badge
									variant={
										summary.sending === "configured"
											? "success"
											: summary.sending === "failed"
												? "error"
												: "secondary"
									}
								>
									{summary.sending === "configured"
										? "Configured"
										: summary.sending === "failed"
											? "Failed"
											: "Skipped"}
								</Badge>
							</div>
						</div>

						<p className="text-xs text-kumo-subtle text-center mb-5">
							You can configure additional settings from the
							Domains page at any time.
						</p>

						<div className="flex justify-center">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="primary" size="sm">
										Done
										<ArrowRightIcon size={14} />
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
