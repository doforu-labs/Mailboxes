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
	| "migrate-vercel"
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
		case "migrate-vercel":
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

// ── DNS Provider Guide Links ─────────────────────────────────────

function getDnsProviderGuide(provider: string): string | null {
	const guides: Record<string, string> = {
		Cloudflare: "https://developers.cloudflare.com/email-routing/get-started/",
		Vercel: "https://vercel.com/docs/domains/manage-a-domain#configuring-dns-records",
		GoDaddy: "https://www.godaddy.com/help/add-or-edit-mx-records-19238",
		Namecheap: "https://www.namecheap.com/support/knowledgebase/article.aspx/223/22/how-do-i-set-up-mail-forwarding-for-my-domain/",
	};
	return guides[provider] ?? null;
}

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
	const [matchedProvider, setMatchedProvider] = useState<string | null>(null);
	const [matchedProviderCreds, setMatchedProviderCreds] = useState<Record<string, string> | null>(null);

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

	// Summary
	// Vercel migration
	const [vercelToken, setVercelToken] = useState("");
	const [migrationStatus, setMigrationStatus] = useState<
		"idle" | "migrating" | "success" | "failed"
	>("idle");
	const [migrationStep, setMigrationStep] = useState(0);
	const [migrationError, setMigrationError] = useState<string | null>(null);
	const [cfApiToken, setCfApiToken] = useState("");

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
		if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(domainName.trim())) {
			setError("Please enter a valid domain (e.g. example.com)");
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
					setIsCfManaged(true);
					setCfZoneName(match.name);
					setDetectedDnsProvider(null);
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

	// Provider ID mapping from DNS detection name to our provider ID
	const PROVIDER_MAP: Record<string, string> = {
		"Vercel": "vercel",
		"Gandi": "gandi",
		"Porkbun": "porkbun",
		"Name.com": "name",
		"DNSimple": "dnsimple",
	};

	const PROVIDER_DISPLAY: Record<string, string> = {
		vercel: "Vercel",
		gandi: "Gandi",
		porkbun: "Porkbun",
		name: "Name.com",
		dnsimple: "DNSimple",
	};
	async function loadProviderCreds(providerId: string): Promise<Record<string, string> | null> {
		const settingApi = (await import("~/services/api")).default;
		switch (providerId) {
			case "vercel": {
				const [t, team] = await Promise.all([
					settingApi.getPlatformSetting("vercel_api_token"),
					settingApi.getPlatformSetting("vercel_team_id"),
				]);
				return t.value ? { apiToken: t.value || "", teamId: team.value || "" } : null;
			}
			case "gandi": {
				const t = await settingApi.getPlatformSetting("gandi_api_token");
				return t.value ? { apiToken: t.value || "" } : null;
			}
			case "porkbun": {
				const [k, s] = await Promise.all([
					settingApi.getPlatformSetting("porkbun_api_key"),
					settingApi.getPlatformSetting("porkbun_secret_api_key"),
				]);
				return k.value && s.value ? { apiKey: k.value || "", secretApiKey: s.value || "" } : null;
			}
			case "name": {
				const [u, t] = await Promise.all([
					settingApi.getPlatformSetting("namecom_username"),
					settingApi.getPlatformSetting("namecom_api_token"),
				]);
				return u.value && t.value ? { username: u.value || "", apiToken: t.value || "" } : null;
			}
			case "dnsimple": {
				const t = await settingApi.getPlatformSetting("dnsimple_api_token");
				return t.value ? { apiToken: t.value || "" } : null;
			}
			default:
				return null;
		}
	}

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
					"MX record not found. Please add the MX record at your DNS provider and try again. DNS changes may take a few minutes to propagate.",
				);
			}
		} catch {
			setMxError("Failed to verify MX record. Please try again.");
		} finally {
			setMxVerifying(false);
		}
	};

	const MIGRATION_STEPS = [
		{ id: "verify-token", label: "验证 API Token 权限" },
		{ id: "cf-zone", label: "添加域名到 Cloudflare" },
		{ id: "vercel-ns", label: "修改 Vercel NS 记录" },
		{ id: "dns-propagation", label: "等待 DNS 传播" },
		{ id: "email-routing", label: "启用 Email Routing" },
		{ id: "dns-records", label: "配置 DNS 记录" },
	];

	const handleStartMigration = async () => {
		setMigrationStatus("migrating");
		setMigrationError(null);

		try {
			const cfCreds = await loadCfCredentials();
			if (!cfCreds.cfApiToken) {
				throw new Error("请先在平台设置中配置 Cloudflare API Token");
			}
			setCfApiToken(cfCreds.cfApiToken);
			setMigrationStep(0);

			// Pre-flight: 验证 CF Token 权限
			const verifyRes = await fetch("/api/v1/setup/cloudflare/verify-token", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cfApiToken: cfCreds.cfApiToken }),
			});
			const verifyData = await verifyRes.json();
			if (!verifyRes.ok || !verifyData.valid) {
				throw new Error(verifyData.error || "API Token 权限不足，请检查 Token 配置");
			}
			setMigrationStep(1);

			// Step 2: 添加域名到 Cloudflare
			const zoneRes = await fetch("/api/v1/setup/cloudflare/add-zone", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ domain: domainName.trim(), cfApiToken: cfCreds.cfApiToken }),
			});
			const zoneData = await zoneRes.json();
			if (!zoneRes.ok) throw new Error(zoneData.error || "添加域名到 Cloudflare 失败");
			setMigrationStep(2);

			// Step 3: 更新 Vercel NS
			const nsRes = await fetch("/api/v1/setup/vercel/update-ns", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: domainName.trim(),
					vercelToken,
					nameservers: zoneData.nameservers,
				}),
			});
			const nsData = await nsRes.json();
			if (!nsRes.ok) throw new Error(nsData.error || "修改 Vercel NS 记录失败");
			setMigrationStep(3);

			// Step 4: 轮询检查 NS 传播（最多 5 分钟）
			let propagated = false;
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 10000));
				const checkRes = await fetch(
					`/api/v1/setup/check-ns/${domainName.trim()}?expected=${zoneData.nameservers.join(",")}`
				);
				const checkData = await checkRes.json();
				if (checkData.propagated) {
					propagated = true;
					break;
				}
			}
			if (!propagated) {
				throw new Error("DNS 传播超时，请稍后在域名详情页重试");
			}
			setMigrationStep(4);

			// Step 5: 启用 Email Routing (retry — zone may still be activating)
			let erOk = false;
			let erLastErr = "";
			for (let attempt = 0; attempt < 5; attempt++) {
				const erRes = await fetch("/api/v1/setup/email-routing", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						domain: domainName.trim(),
						cfApiToken: cfCreds.cfApiToken,
						cfAccountId: cfCreds.cfAccountId,
					}),
				});
				if (erRes.ok) {
					erOk = true;
					break;
				}
				const erData = await erRes.json();
				erLastErr = erData.error || `HTTP ${erRes.status}`;
				// Zone not found or not ready — wait 30s and retry
				if (erRes.status === 400 && erLastErr.includes("not found")) {
					await new Promise((r) => setTimeout(r, 30000));
					continue;
				}
				// Other errors — don't retry
				break;
			}
			if (!erOk) throw new Error(erLastErr || "启用 Email Routing 失败");
			setMigrationStep(5);

			// Step 6: 创建域名记录（仅收件）
			const domainRes = await fetch("/api/v1/domains", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ domain: domainName.trim() }),
			});
			if (!domainRes.ok && domainRes.status !== 409) {
				const domainData = await domainRes.json();
				throw new Error(domainData.error || "创建域名记录失败");
			}

			setMigrationStatus("success");
			setSummary({ receiving: "configured", sending: "skipped" });
			setStep("done");
			toastManager.add({ title: `域名 ${domainName} 自动迁移完成！` });
			onSuccess();
			onComplete?.();
		} catch (err: unknown) {
			setMigrationStatus("failed");
			setMigrationError(err instanceof Error ? err.message : "迁移失败");
		}
	};

	// ── Step 2: Domain type → proceed to receiving ──
	const handleDomainTypeContinue = async () => {
		if (isCfManaged) {
			setStep("receive-cf");
		} else {
			const providerName = detectedDnsProvider?.provider;
			const providerId = providerName ? PROVIDER_MAP[providerName] : undefined;
			if (providerId) {
				const creds = await loadProviderCreds(providerId);
				if (creds) {
					setMatchedProvider(providerId);
					setMatchedProviderCreds(creds);

					// 如果是 Vercel 且有 Token，进入自动迁移流程
					if (providerId === "vercel" && creds.apiToken) {
						setVercelToken(creds.apiToken);
						setStep("migrate-vercel");
						return;
					}

					setStep("receive-external");
					return;
				}
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
				domain: domainName.trim(),
				resendApiKey: resendApiKey.trim() || undefined,
				provider: matchedProvider ?? undefined,
				providerCredentials: matchedProviderCreds ?? undefined,
			});
			setDnsRecords(result.dnsRecords);
			if (result.warnings && result.warnings.length > 0) {
				setWarnings(result.warnings);
			}
			setStep("dns-records");
		} catch (err: unknown) {
			if (err instanceof ApiError && err.status === 409) {
				setError("This domain has already been added. You can find it in the Domains list.");
			} else {
				const msg =
					err instanceof Error ? err.message : "Failed to create domain";
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
						title: `Domain ${domainName} verified successfully!`,
					});
					onSuccess();
					onComplete?.();
				} else {
					setVerifyStatus("failed");
					setVerifyError(
						"Domain status: pending. DNS records may still be propagating. Please wait a few minutes and try again.",
					);
				}
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
				title: "Domain added for receiving. You can set up sending later.",
			});
			onSuccess();
			onComplete?.();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to create domain";
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
						{!isCfManaged && detectedDnsProvider?.provider && detectedDnsProvider.provider !== "Other" && (
							<p className="text-xs text-kumo-subtle text-center mb-2">
								Managed by <strong className="text-kumo-default">{detectedDnsProvider.provider}</strong>
							</p>
						)}
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
								<ChevronLeft size={14} />
								Back
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={handleDomainTypeContinue}
							>
								Continue
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
									<CircleCheckBig
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
										<ChevronLeft size={14} />
										Back
									</Button>
									{receiveStatus === "success" ? (
										<Button
											variant="primary"
											size="sm"
											onClick={() => setStep("sending")}
										>
											Continue
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
											<ChevronRight size={14} />
										</Button>
									)}
								</>
							)}
						</div>
					</>
				)}



				{/* ── Step 3c: Auto-Migrate from Vercel ──── */}
				{step === "migrate-vercel" && (
					<>
						<div className="flex justify-center mb-4">
							<div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
								<Globe size={24} className="text-amber-500" />
							</div>
						</div>
						<Dialog.Title className="text-base font-semibold text-center mb-1">
							自动迁移 DNS
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle text-center mb-5">
							将 <strong className="text-kumo-default">{domainName}</strong> 的 DNS
							从 Vercel 迁移到 Cloudflare，以启用邮件接收功能。
						</p>

						{migrationStatus === "idle" && (
							<>
								<div className="rounded-lg bg-kumo-fill px-3 py-2.5 mb-4">
									<p className="text-xs text-kumo-subtle">
										此操作将自动完成以下步骤：
									</p>
									<ul className="text-xs text-kumo-subtle mt-2 space-y-1 list-disc list-inside">
										<li>将域名添加到 Cloudflare</li>
										<li>修改 Vercel DNS 的 NS 记录</li>
										<li>等待 DNS 传播（约 2-5 分钟）</li>
										<li>启用 Cloudflare Email Routing</li>
										<li>配置 MX / SPF / DKIM 记录</li>
									</ul>
								</div>
								<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 mb-4">
									<p className="text-xs text-kumo-subtle">
										ℹ️ 此操作不会影响您在 Vercel 上的其他 DNS 记录和网站托管。
										仅修改 NS 记录以将邮件路由切换到 Cloudflare。
									</p>
								</div>
								<div className="flex justify-end gap-2">
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setStep("domain-type")}
									>
										<ChevronLeft size={14} />
										Back
									</Button>
									<Button
										variant="primary"
										size="sm"
										onClick={handleStartMigration}
									>
										开始迁移
										<ArrowRight size={14} />
									</Button>
								</div>
							</>
						)}

						{migrationStatus === "migrating" && (
							<>
								<div className="space-y-3 mb-5">
									{MIGRATION_STEPS.map((s, i) => (
										<div key={s.id} className="flex items-center gap-3">
											{i < migrationStep ? (
												<CircleCheckBig size={16} className="text-green-500 shrink-0" />
											) : i === migrationStep ? (
												<Loader2 size={16} className="text-blue-500 animate-spin shrink-0" />
											) : (
												<div className="h-4 w-4 rounded-full border-2 border-kumo-line shrink-0" />
											)}
											<span className={`text-sm ${i < migrationStep ? "text-green-600" : i === migrationStep ? "text-blue-600" : "text-kumo-muted"}`}>
												{s.label}
											</span>
										</div>
									))}
								</div>
								{migrationStep === 2 && (
									<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 mb-4">
										<p className="text-xs text-kumo-subtle">
											⏳ 正在等待 DNS 传播，这通常需要 2-5 分钟...
										</p>
									</div>
								)}
							</>
						)}

						{migrationStatus === "failed" && (
							<>
								<ErrorBanner message={migrationError ?? "迁移失败"} />
								<div className="flex justify-end gap-2 mt-4">
									<Button
										variant="secondary"
										size="sm"
										onClick={() => {
											setMigrationStatus("idle");
											setMigrationStep(0);
											setMigrationError(null);
										}}
									>
										重试
									</Button>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => setStep("receive-external")}
									>
										手动配置
									</Button>
								</div>
							</>
						)}
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
							{detectedDnsProvider?.provider && detectedDnsProvider.provider !== "Other" && (
								<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
									<p className="text-xs text-kumo-subtle">
										Your domain's DNS is managed by <strong className="text-kumo-default">{detectedDnsProvider.provider}</strong>.{' '}
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
													View {detectedDnsProvider.provider} DNS setup guide
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

						{mxError && (
							<div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 mb-2">
								<p className="text-xs text-red-700">{mxError}</p>
							</div>
						)}
						{mxVerified && (
							<div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2.5 mb-2">
								<p className="text-xs text-green-700 flex items-center gap-1.5">
									<CircleCheckBig size={14} className="text-green-600" />
									MX record verified! Your domain is configured to receive email.
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
								Back
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
										Verifying
									</>
								) : mxVerified ? (
									<>Verified</>
								) : (
									<>Verify MX Record</>
								)}
							</Button>
							{mxVerified && (
								<Button
									variant="primary"
									size="sm"
									onClick={() => setStep("sending")}
								>
									Continue
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
									<ChevronLeft size={14} />
									Back
								</Button>
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={handleSkipSending}
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
									{record.value && (
										<div className="mt-1.5">
										<p className="text-xs text-kumo-subtle mb-1">
											Value:{" "}
											<code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">
												{record.value}
											</code>
											<button
												type="button"
												className="ml-1.5 text-blue-600 hover:text-blue-800 underline text-xs"
												onClick={() => {
													navigator.clipboard.writeText(record.value!);
													toastManager.add({ title: "Copied to clipboard" });
												}}
											>
												Copy
											</button>
											</p>
										</div>
									)}
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
								disabled
								title="Domain already created. Please continue with DNS setup."
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
								<CircleCheckBig size={14} />
							</Button>
						</div>

						{warnings.length > 0 && (
							<div className="rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2.5 mb-5">
								<p className="text-xs font-medium text-yellow-800 mb-1">Warnings</p>
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
								<Mail
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
								<Send
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
