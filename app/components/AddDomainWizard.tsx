// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	Badge,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	CheckCircleIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { useCreateDomain } from "~/queries/domains";
import api from "~/services/api";

interface AddDomainWizardProps {
	onClose: () => void;
	onSuccess: () => void;
	onComplete?: () => void;
	defaultDomain?: string;
	defaultApiKey?: string;
}

type WizardStep = "domain" | "resend-key" | "dns-records" | "verify" | "done";

export function AddDomainWizard({
	onClose,
	onSuccess,
	onComplete,
	defaultDomain,
	defaultApiKey,
}: AddDomainWizardProps) {
	const toastManager = useKumoToastManager();
	const createDomain = useCreateDomain();

	const [step, setStep] = useState<WizardStep>(defaultApiKey ? "domain" : "domain");
	const [domainName, setDomainName] = useState(defaultDomain ?? "");
	const [resendApiKey, setResendApiKey] = useState(defaultApiKey ?? "");
	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dnsRecords, setDnsRecords] = useState<Array<{ name: string; type: string; status: string }>>([]);
	const [verifyStatus, setVerifyStatus] = useState<"idle" | "verifying" | "verified" | "failed">("idle");
	const [verifyError, setVerifyError] = useState<string | null>(null);
	const [createdDomainId, setCreatedDomainId] = useState<string | null>(null);

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
			const result = await createDomain.mutateAsync({
				name: domainName.trim(),
				resendApiKey: resendApiKey.trim(),
			});
			setDnsRecords(result.dnsRecords);
			setCreatedDomainId(result.domain.id);
			setStep("dns-records");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to add domain";
			setError(msg);
		} finally {
			setIsProcessing(false);
		}
	};

	// Step C → Verify: user adds DNS records, then clicks verify
	const handleVerify = async () => {
		setVerifyError(null);
		setVerifyStatus("verifying");
		try {
			const result = await api.verifyDomain({
				domain: domainName.trim(),
				resendApiKey: resendApiKey.trim(),
				cfApiToken: "",
				cfAccountId: "",
			});
			if (result.status === "verified" || result.status === "valid") {
				setVerifyStatus("verified");
				setStep("done");
				toastManager.add({ title: `Domain ${domainName} verified successfully!` });
				onSuccess();
				onComplete?.();
			} else {
				setVerifyStatus("failed");
				setVerifyError(`Domain status: ${result.status}. DNS records may still be propagating. Please wait a few minutes and try again.`);
			}
		} catch (err: unknown) {
			setVerifyStatus("failed");
			const msg = err instanceof Error ? err.message : "Verification failed";
			setVerifyError(msg);
		}
	};

	const handleSkipVerify = () => {
		setStep("done");
		toastManager.add({ title: "Domain added! You can verify DNS later from the Domains page." });
		onSuccess();
		onComplete?.();
	};

	const handleClose = () => onClose();

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
							<div>
								<label className="block text-sm font-medium text-kumo-strong mb-1">Domain Name</label>
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
									onClick={() => { setError(null); setResendApiKey(""); setStep("dns-records"); }}
								>
									Skip
								</Button>
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

				{/* ── Step C: DNS Records (dynamic) ────────────────── */}
				{step === "dns-records" && (
					<>
						<Dialog.Title className="text-base font-semibold mb-1">
							Add DNS Records
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							Add these DNS records to <strong className="text-kumo-default">{domainName}</strong> at your
							domain registrar or DNS provider to enable email sending via Resend.
						</p>

						<div className="space-y-3 mb-5">
							{dnsRecords.map((record, i) => (
								<div key={i} className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
									<div className="flex items-center gap-2 mb-2">
										<span className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">
											{record.type}
										</span>
										{record.name && (
											<span className="text-xs text-kumo-subtle">
												Name: <code className="text-kumo-default font-mono bg-kumo-recessed px-1.5 py-0.5 rounded">{record.name}</code>
											</span>
										)}
										<Badge variant={record.status === "verified" ? "success" : record.status === "failed" ? "error" : "info"}>
											{record.status}
										</Badge>
									</div>
									<p className="text-xs text-kumo-subtle">
										Go to your DNS provider and add this {record.type} record. The status above shows whether Resend has detected it.
									</p>
								</div>
							))}
							{dnsRecords.length === 0 && (
								<div className="rounded-lg border border-kumo-line bg-kumo-fill p-3">
									<p className="text-sm text-kumo-subtle">No DNS records returned. The domain may already be configured.</p>
								</div>
							)}
						</div>

						<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5 mb-5">
							<p className="text-xs text-kumo-subtle">
								DNS changes may take a few minutes to propagate. After adding the records above,
								click <strong>"Verify DNS"</strong> to check if they are detected.
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
								<p className="text-xs text-yellow-800">{verifyError}</p>
							</div>
						)}
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
