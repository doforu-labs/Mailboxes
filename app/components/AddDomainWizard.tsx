// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import {
	Button,
	Dialog,
	Input,
	Badge,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ChevronRight,
	ChevronLeft,
	CircleCheckBig,
	TriangleAlert,
	Globe,
	Loader2,
	Mail,
	Send,
	Cloud,
	ArrowRight,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateDomain } from "~/queries/domains";
import api from "~/services/api";
import { ApiError } from "~/services/api";
import { loadCfCredentials } from "~/components/PlatformSettingsSection";
import type { DnsProviderDetection } from "~/services/api";

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

const STEP_LABEL_KEYS: Record<StepPosition, string> = {
	domain: "stepDomain",
	receive: "stepReceiving",
	sending: "stepSending",
	done: "stepDone",
};

// ── DNS Provider Guide Links ─────────────────────────────────────

function getDnsProviderGuide(provider: string): string | null {
	const guides: Record<string, string> = {
		Cloudflare: "https://developers.cloudflare.com/email-routing/get-started/",
		GoDaddy: "https://www.godaddy.com/help/add-or-edit-mx-records-19238",
		Namecheap: "https://www.namecheap.com/support/knowledgebase/article.aspx/223/22/how-do-i-set-up-mail-forwarding-for-my-domain/",
	};
	return guides[provider] ?? null;
}

// ── Step Indicator ────────────────────────────────────────────────

function StepIndicator({ currentStep }: { currentStep: WizardStep }) {
	const { t } = useTranslation("domain");
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
									<CircleCheckBig size={14} />
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
								{t(STEP_LABEL_KEYS[pos])}
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
			<TriangleAlert size={14} className="text-red-600 shrink-0" />
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
	const { t } = useTranslation("domain");
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
	const [detectedDnsProvider, setDetectedDnsProvider] = useState<DnsProviderDetection | null>(null);

	// Receiving setup
	const [receiveStatus, setReceiveStatus] = useState<
		"idle" | "loading" | "success" | "failed"
	>("idle");
	const [receiveError, setReceiveError] = useState<string | null>(null);

	// MX verification (receive-external step)
	const [mxVerifying, setMxVerifying] = useState(false);
	const [mxVerified, setMxVerified] = useState(false);
	const [mxError, setMxError] = useState<string | null>(null);

	// DNS records for sending
	const [dnsRecords, setDnsRecords] = useState<
		Array<{ name: string; type: string; status: string; value?: string }>
	>([]);

	// Warnings from backend
	const [warnings, setWarnings] = useState<string[]>([]);

	// Verify
	const [verifyStatus, setVerifyStatus] = useState<
		"idle" | "verifying" | "verified" | "failed"
	>("idle");
	const [verifyError, setVerifyError] = useState<string | null>(null);

	const [summary, setSummary] = useState<{
		receiving: "configured" | "skipped" | "failed";
		sending: "configured" | "skipped" | "failed";
	}>({ receiving: "skipped", sending: "skipped" });

	// ── Step 1: Domain name → detect ──
	const handleDomainSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!domainName.trim()) {
			setError(t("enterDomainName"));
			return;
		}
		if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(domainName.trim())) {
			setError(t("invalidDomain"));
			return;
		}

		// Attempt CF detection
		setDetecting(true);
		try {
			const creds = await loadCfCredentials();
			if (creds.cfApiToken && creds.cfAccountId) {
				const result = await api.detectCfDomains(creds);
				const trimmed = domainName.trim();
				const match = result.zones.find(
					(z) => z.name === trimmed || trimmed.endsWith(`.${z.name}`),
				);
				if (match) {
					if (match.status === "active") {
						// Zone fully configured — go to Email Routing setup
						setIsCfManaged(true);
						setCfZoneName(match.name);
						setDetectedDnsProvider(null);
					} else {
						// Zone exists but pending (NS not switched) — guide through migration
						setIsCfManaged(false);
						try {
							const dnsResult = await api.detectDnsProvider(trimmed);
							setDetectedDnsProvider(dnsResult);
						} catch {
							setDetectedDnsProvider({ provider: "Other", nameservers: [] });
						}
					}
				} else {
					setIsCfManaged(false);
					try {
						const dnsResult = await api.detectDnsProvider(trimmed);
						setDetectedDnsProvider(dnsResult);
					} catch {
						setDetectedDnsProvider({ provider: "Other", nameservers: [] });
					}
				}
			} else {
				setIsCfManaged(false);
				try {
					const dnsResult = await api.detectDnsProvider(domainName.trim());
					setDetectedDnsProvider(dnsResult);
				} catch {
					setDetectedDnsProvider({ provider: "Other", nameservers: [] });
				}
			}
		} catch {
			setIsCfManaged(false);
			setDetectedDnsProvider(null);
		} finally {
			setDetecting(false);
			setStep("domain-type");
		}
	};


	// ── MX Verification ──
	const handleVerifyMx = async () => {
		setMxVerifying(true);
		setMxError(null);
		try {
			const result = await api.verifyMx(domainName.trim());
			if (result.verified) {
				setMxVerified(true);
			} else {
				setMxError(
					t("mxRecordNotFound"),
				);
			}
		} catch {
			setMxError(t("failedToVerifyMx"));
		} finally {
			setMxVerifying(false);
		}
	};


	// ── Step 2: Domain type → proceed to receiving ──
	const handleDomainTypeContinue = async () => {
		if (isCfManaged) {
			setStep("receive-cf");
		} else {
			const providerName = detectedDnsProvider?.provider;
			if (providerName) {
				setStep("receive-external");
				return;
			}
			setStep("receive-external");
		}
	};
	useEffect(() => {
		if (step !== "receive-cf" || receiveStatus !== "idle") return;

		const setup = async () => {
			setReceiveStatus("loading");
			try {
				const creds = await loadCfCredentials();
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
						: t("failedToConfigureEmailRouting"),
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
				domain: domainName.trim(),
				resendApiKey: resendApiKey.trim() || undefined,
			});
			setDnsRecords(result.dnsRecords);
			if (result.warnings && result.warnings.length > 0) {
				setWarnings(result.warnings);
			}
			setStep("dns-records");
		} catch (err: unknown) {
			if (err instanceof ApiError && err.status === 409) {
				setError(t("domainAlreadyAdded"));
			} else {
				const msg =
					err instanceof Error ? err.message : t("failedToCreateDomain");
				setError(msg);
			}
		} finally {
			setIsProcessing(false);
		}
	};

	// ── Step 5: DNS verify ──
	const handleVerify = async () => {
		setVerifyError(null);
		setVerifyStatus("verifying");
		try {
			const creds = await loadCfCredentials();
			if (creds.cfApiToken && creds.cfAccountId) {
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
						title: t("toastDomainVerified", { name: domainName }),
					});
					onSuccess();
					onComplete?.();
				} else {
					setVerifyStatus("failed");
					setVerifyError(
						t("toastDomainStatusRedirect", { status: result.status }),
					);
				}
			} else {
				// No CF credentials — just check if domain is verified via Resend
				const domains = await api.domains.list();
				const domain = domains.find((d: { name: string }) => d.name === domainName.trim());
				if (domain && (domain as unknown as { status: string }).status === "verified") {
					setVerifyStatus("verified");
					setSummary({
						receiving: isCfManaged ? "configured" : "skipped",
						sending: "configured",
					});
					setStep("done");
					toastManager.add({
						title: t("toastDomainVerified", { name: domainName }),
					});
					onSuccess();
					onComplete?.();
				} else {
					setVerifyStatus("failed");
					setVerifyError(
						t("toastDomainStatusPending"),
					);
				}
			}
		} catch (err: unknown) {
			setVerifyStatus("failed");
			const msg =
				err instanceof Error ? err.message : t("verificationFailed");
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
			title: t("toastDomainAdded"),
		});
		onSuccess();
		onComplete?.();
	};

	const handleSkipSending = async () => {
		setIsProcessing(true);
		try {
			await createDomain.mutateAsync({
				domain: domainName.trim(),
			});
			setSummary({
				receiving: isCfManaged ? "configured" : "skipped",
				sending: "skipped",
			});
			setStep("done");
			toastManager.add({
				title: t("toastDomainAddedForReceiving"),
			});
			onSuccess();
			onComplete?.();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : t("failedToCreateDomain");
			setError(msg);
		} finally {
			setIsProcessing(false);
		}
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
							{t("addDomain")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							{t("addDomainDescription")}
						</p>
						<form onSubmit={handleDomainSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<div>
								<label className="block text-sm font-medium text-kumo-strong mb-1">
									{t("domainName")}
								</label>
								<input
									type="text"
									placeholder={t("domainNamePlaceholder")}
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
											{t("common:cancel")}
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
									{t("common:continue")}
									<ChevronRight size={14} />
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
									<Cloud
										size={24}
										className="text-blue-500"
									/>
								) : (
									<Globe
										size={24}
										className="text-amber-500"
									/>
								)}
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							{isCfManaged
								? t("cfManagedTitle")
								: t("externalDomainTitle")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-2">
							<strong className="text-kumo-default">
								{domainName}
							</strong>{" "}
							{isCfManaged
								? t("isManagedByCf", { zone: cfZoneName ? ` (${cfZoneName})` : "" })
								: t("isNotManagedByCf")}
						</p>
						{!isCfManaged && detectedDnsProvider?.provider && detectedDnsProvider.provider !== "Other" && (
							<p className="text-xs text-kumo-subtle text-center mb-2">
								{t("managedBy")} <strong className="text-kumo-default">{detectedDnsProvider.provider}</strong>
							</p>
						)}
						<div className="rounded-lg bg-kumo-fill px-3 py-2.5 mb-5">
							{isCfManaged ? (
								<p className="text-xs text-kumo-subtle">
									{t("cfManagedHint")}
								</p>
							) : (
								<p className="text-xs text-kumo-subtle">
									{t("externalDomainHint")}
								</p>
							)}
						</div>
						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setStep("domain")}
							>
								<ChevronLeft size={14} />
								{t("common:back")}
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={handleDomainTypeContinue}
							>
								{t("common:continue")}
								<ChevronRight size={14} />
							</Button>
						</div>
					</>
				)}

				{/* ── Step 3a: Receiving – CF Auto-Setup ────── */}
				{step === "receive-cf" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
								<Mail
									size={24}
									className="text-blue-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							{t("emailRoutingSetup")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							{t("configuringEmailRoutingFor")}{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>
						</p>

						<div className="space-y-3 mb-5">
							{receiveStatus === "loading" && (
								<div className="flex flex-col items-center gap-3 py-4">
									<Loader size="base" />
									<p className="text-sm text-kumo-subtle">
										{t("configuringCatchAll")}
									</p>
								</div>
							)}
							{receiveStatus === "success" && (
								<div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2.5">
									<CircleCheckBig
										size={14}
										className="text-green-600 shrink-0"
									/>
									<span className="text-sm text-green-700">
										{t("emailRoutingConfiguredPrefix")}{" "}
										<code className="font-mono">
											*@{domainName}
										</code>{" "}
										{t("emailRoutingConfiguredSuffix")}
									</span>
								</div>
							)}
							{receiveStatus === "failed" && (
								<div className="space-y-2">
									<ErrorBanner
										message={
											receiveError ??
											t("failedToConfigureEmailRouting")
										}
									/>
									<p className="text-xs text-kumo-subtle">
										{t("setupManuallyLater")}
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
									{t("skipForNow")}
								</Button>
							) : (
								<>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setStep("domain-type")}
									>
										<ChevronLeft size={14} />
										{t("common:back")}
									</Button>
									{receiveStatus === "success" ? (
										<Button
											variant="primary"
											size="sm"
											onClick={() => setStep("sending")}
										>
											{t("common:continue")}
											<ChevronRight size={14} />
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
												{t("skipReceiving")}
											</Button>
											<Button
												variant="primary"
												size="sm"
												onClick={() => {
													setReceiveStatus("idle");
													setReceiveError(null);
												}}
											>
												{t("common:retry")}
											</Button>
										</>
									) : (
										<Button
											variant="primary"
											size="sm"
											onClick={() => setStep("sending")}
										>
											{t("common:continue")}
											<ChevronRight size={14} />
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
								<Mail
									size={24}
									className="text-amber-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							{t("receivingSetup")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							{t("receivingSetupIntroPrefix")}{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>
							{t("receivingSetupIntroSuffix")}
						</p>

						<div className="space-y-3 mb-4">
							{detectedDnsProvider?.provider && detectedDnsProvider.provider !== "Other" && (
								<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
									<p className="text-xs text-kumo-subtle">
										{t("dnsManagedByPrefix")} <strong className="text-kumo-default">{detectedDnsProvider.provider}</strong>.{' '}
										{(() => {
										const guideUrl = getDnsProviderGuide(detectedDnsProvider.provider);
										if (guideUrl) {
											return (
												<a
													href={guideUrl}
													target="_blank"
													rel="noopener noreferrer"
													className="text-blue-600 underline"
												>
													{t("viewDnsSetupGuide", { provider: detectedDnsProvider.provider })}
													</a>
											);
										}
										return null;
									})()}
									</p>
								</div>
							)}
							<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
								<div className="flex items-center gap-2 mb-2">
									<span className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
										MX
									</span>
									<span className="text-xs text-kumo-subtle">
										{t("mxName")}{" "}
										<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
											@
										</code>
									</span>
								</div>
								<p className="text-xs text-kumo-subtle mb-1">
									{t("mxValue")}{" "}
									<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
										mailboxes.pages.dev
									</code>
								</p>
								<p className="text-xs text-kumo-subtle">
									{t("mxPriority")}{" "}
									<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
										10
									</code>
								</p>
							</div>
							<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
								<p className="text-xs text-kumo-subtle">
									{t("mxForwardingHint")}
								</p>
							</div>
						</div>

						{mxError && (
							<div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 mb-2">
								<p className="text-xs text-red-700">{mxError}</p>
							</div>
						)}
						{mxVerified && (
							<div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2.5 mb-2">
								<p className="text-xs text-green-700 flex items-center gap-1.5">
									<CircleCheckBig size={14} className="text-green-600" />
									{t("mxRecordVerified")}
								</p>
							</div>
						)}
						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setStep("domain-type")}
							>
								<ChevronLeft size={14} />
								{t("common:back")}
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={handleVerifyMx}
								disabled={mxVerifying || mxVerified}
							>
								{mxVerifying ? (
									<>
										<Loader2 size={14} className="animate-spin" />
										{t("verifying")}
									</>
								) : mxVerified ? (
									<>{t("verified")}</>
								) : (
									<>{t("verifyMxRecord")}</>
								)}
							</Button>
							{mxVerified && (
								<Button
									variant="primary"
									size="sm"
									onClick={() => setStep("sending")}
								>
									{t("common:continue")}
									<ChevronRight size={14} />
								</Button>
							)}
						</div>
					</>
				)}

				{/* ── Step 4: Sending – Resend API Key ────── */}
				{step === "sending" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
								<Send
									size={24}
									className="text-green-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							{t("sendingSetup")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							{t("sendingSetupIntroPrefix")}{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>
						</p>
						<form onSubmit={handleSendingSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<Input
								label={t("resendApiKey")}
								placeholder="re_••••••••••••••••••••••••••••"
								size="sm"
								type="password"
								value={resendApiKey}
								onChange={(e) => setResendApiKey(e.target.value)}
								autoFocus
							/>
							<div className="rounded-lg bg-kumo-fill px-3 py-2.5">
								<p className="text-xs text-kumo-subtle">
									{t("resendApiKeyHintPrefix")}{" "}
									<a
										href="https://resend.com/api-keys"
										target="_blank"
										rel="noopener noreferrer"
										className="text-blue-600 underline"
									>
										resend.com/api-keys
									</a>
									{t("resendApiKeyHintSuffix")}
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
									<ChevronLeft size={14} />
									{t("common:back")}
								</Button>
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={handleSkipSending}
								>
									{t("skipSending")}
								</Button>
								<Button
									type="submit"
									variant="primary"
									size="sm"
									loading={isProcessing}
									disabled={isProcessing}
								>
									{t("createDomain")}
									<ChevronRight size={14} />
								</Button>
							</div>
						</form>
					</>
				)}

				{/* ── Step 5: DNS Records for Sending ──────── */}
				{step === "dns-records" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							{t("dnsRecordsForSending")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							{t("dnsRecordsIntroPrefix")}{" "}
							<strong className="text-kumo-default">
								{domainName}
							</strong>{" "}
							{t("dnsRecordsIntroSuffix")}
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
												{t("mxName")}{" "}
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
									{record.value && (
										<div className="mt-1.5">
										<p className="text-xs text-kumo-subtle mb-1">
											{t("mxValue")}{" "}
											<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
												{record.value}
											</code>
											<button
												type="button"
												className="ml-1.5 text-blue-600 hover:text-blue-800 underline text-xs"
												onClick={() => {
													navigator.clipboard.writeText(record.value!);
													toastManager.add({ title: t("copiedToClipboard") });
												}}
											>
												{t("dnsRecordCopy")}
											</button>
											</p>
										</div>
									)}
									<p className="text-xs text-kumo-subtle">
										{t("dnsRecordHint", { type: record.type })}
									</p>
								</div>
							))}
							{dnsRecords.length === 0 && (
								<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
									<p className="text-sm text-kumo-subtle">
										{t("noDnsRecords")}
									</p>
								</div>
							)}
						</div>

						<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 mb-5">
							<p className="text-xs text-kumo-subtle">
								{t("dnsPropagationHintPrefix")}{" "}
								<strong>{`"${t("verifyDns")}"`}</strong>{" "}
								{t("dnsPropagationHintSuffix")}
							</p>
						</div>

						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								disabled
								title={t("dnsRecordsBackTooltip")}
							>
								{t("common:back")}
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={handleSkipVerify}
							>
								{t("skipForNow")}
							</Button>
							<Button
								variant="primary"
								size="sm"
								loading={verifyStatus === "verifying"}
								onClick={handleVerify}
							>
								{t("verifyDns")}
								<CircleCheckBig size={14} />
							</Button>
						</div>

						{warnings.length > 0 && (
							<div className="rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2.5 mb-5">
								<p className="text-xs font-medium text-yellow-800 mb-1">{t("warnings")}</p>
								<ul className="text-xs text-yellow-700 list-disc list-inside space-y-0.5">
									{warnings.map((w, i) => (
										<li key={i}>{w}</li>
									))}
								</ul>
							</div>
						)}

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
								<CircleCheckBig
									size={24}
									className="text-green-500"
								/>
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							{t("domainAdded")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							<strong className="text-kumo-default">
								{domainName}
							</strong>{" "}
							{t("domainAddedSuccessSuffix")}
						</p>

						<div className="space-y-2 mb-5">
							<div className="flex items-center gap-2 rounded-lg bg-kumo-fill px-3 py-2">
								<Mail
									size={14}
									className="text-kumo-subtle shrink-0"
								/>
								<span className="text-sm text-kumo-default font-medium">
									{t("receivingLabel")}
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
										? t("statusConfigured")
										: summary.receiving === "failed"
											? t("statusFailed")
											: t("statusSkipped")}
								</Badge>
							</div>
							<div className="flex items-center gap-2 rounded-lg bg-kumo-fill px-3 py-2">
								<Send
									size={14}
									className="text-kumo-subtle shrink-0"
								/>
								<span className="text-sm text-kumo-default font-medium">
									{t("sendingLabel")}
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
										? t("statusConfigured")
										: summary.sending === "failed"
											? t("statusFailed")
											: t("statusSkipped")}
								</Badge>
							</div>
						</div>

						<p className="text-xs text-kumo-subtle text-center mb-5">
							{t("doneFooter")}
						</p>

						<div className="flex justify-center">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="primary" size="sm">
										{t("stepDone")}
										<ArrowRight size={14} />
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
