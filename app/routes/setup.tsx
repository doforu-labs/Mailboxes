// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Input,
	Loader,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	CheckCircleIcon,
	EnvelopeIcon,
	GlobeIcon,
	GearSixIcon,
	KeyIcon,
	UserIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Link as RouterLink } from "react-router";
import api from "~/services/api";
import type { VerifyResult } from "~/services/api";

// ── Types ──────────────────────────────────────────────────────────

interface StepConfig {
	id: string;
	label: string;
	icon: React.ReactNode;
}

// ── Steps ──────────────────────────────────────────────────────────

const STEPS: StepConfig[] = [
	{ id: "welcome", label: "Welcome", icon: <EnvelopeIcon size={16} /> },
	{ id: "domain", label: "Domain", icon: <GlobeIcon size={16} /> },
	{ id: "resend", label: "Resend", icon: <KeyIcon size={16} /> },
	{ id: "cloudflare", label: "Cloudflare", icon: <GearSixIcon size={16} /> },
	{ id: "mailbox", label: "Mailbox", icon: <UserIcon size={16} /> },
	{ id: "complete", label: "Done", icon: <CheckCircleIcon size={16} /> },
];

// ── Progress Indicator ─────────────────────────────────────────────

function StepProgress({ currentIndex }: { currentIndex: number }) {
	return (
		<div className="flex items-center justify-center gap-1 mb-8">
			{STEPS.map((step, i) => {
				const isActive = i === currentIndex;
				const isComplete = i < currentIndex;
				return (
					<div key={step.id} className="flex items-center">
						{i > 0 && (
							<div
								className={`h-px w-6 mx-1 ${
									isComplete
										? "bg-green-500"
										: isActive
											? "bg-blue-500"
											: "bg-kumo-line"
								}`}
							/>
						)}
						<div
							className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold transition-colors ${
								isComplete
									? "bg-green-500 text-white"
									: isActive
										? "bg-blue-500 text-white"
										: "bg-kumo-fill text-kumo-subtle"
							}`}
							title={step.label}
						>
							{isComplete ? <CheckCircleIcon size={16} /> : step.icon}
						</div>
					</div>
				);
			})}
		</div>
	);
}

// ── Error Banner ───────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
			<WarningIcon size={14} className="text-red-600 shrink-0" />
			<span className="text-sm text-red-600">
				{message}
			</span>
		</div>
	);
}

// ── Status Badge ───────────────────────────────────────────────────

function StatusBadge({
	status,
	label,
}: {
	status: "pending" | "loading" | "success" | "error";
	label: string;
}) {
	const color =
		status === "success"
			? "text-green-600"
			: status === "error"
				? "text-red-600"
				: status === "loading"
					? "text-blue-600"
					: "text-kumo-subtle";
	const icon =
		status === "success" ? (
			<CheckCircleIcon size={14} />
		) : status === "error" ? (
			<WarningIcon size={14} />
		) : status === "loading" ? (
			<Loader size={14} />
		) : null;
	return (
		<span className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
			{icon}
			{label}
		</span>
	);
}

// ── Setup Page ─────────────────────────────────────────────────────

export default function SetupRoute() {
	// Current step index
	const [stepIndex, setStepIndex] = useState(0);

	// Form state
	const [domain, setDomain] = useState("");
	const [resendApiKey, setResendApiKey] = useState("");
	const [cfApiToken, setCfApiToken] = useState("");
	const [cfAccountId, setCfAccountId] = useState("");
	const [mailboxEmail, setMailboxEmail] = useState("");
	const [mailboxName, setMailboxName] = useState("");

	// Loading / error state
	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Cloudflare step progress
	const [domainVerifyStatus, setDomainVerifyStatus] = useState<
		"pending" | "loading" | "success" | "error"
	>("pending");
	const [emailRoutingStatus, setEmailRoutingStatus] = useState<
		"pending" | "loading" | "success" | "error"
	>("pending");
	const [_verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

	const stepId = STEPS[stepIndex].id;

	// ── Navigation ──────────────────────────────────────────────────

	const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
	const goBack = () => {
		setError(null);
		setStepIndex((i) => Math.max(i - 1, 0));
	};

	// ── Step Handlers ───────────────────────────────────────────────

	const handleDomainSubmit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!domain.trim()) {
			setError("Please enter a domain name");
			return;
		}
		// Auto-fill mailbox email with hello@domain
		if (!mailboxEmail) {
			setMailboxEmail(`hello@${domain.trim()}`);
		}
		goNext();
	};

	const handleResendSubmit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!resendApiKey.trim()) {
			setError("Please enter your Resend API Key");
			return;
		}
		goNext();
	};

	const handleCloudflareSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!cfApiToken.trim() || !cfAccountId.trim()) {
			setError("Both Cloudflare API Token and Account ID are required");
			return;
		}

		setIsProcessing(true);
		setEmailRoutingStatus("pending");

		try {
			// Step A: Create Resend domain + add DNS records via CF (only if Resend key provided)
			if (resendApiKey.trim()) {
				setDomainVerifyStatus("loading");
				const result = await api.verifyDomain({
					domain: domain.trim(),
					resendApiKey: resendApiKey.trim(),
					cfApiToken: cfApiToken.trim(),
					cfAccountId: cfAccountId.trim(),
				});
				setVerifyResult(result);
				setDomainVerifyStatus("success");
			} else {
				setDomainVerifyStatus("success");
			}

			// Step B: Configure email routing
			setEmailRoutingStatus("loading");
			const routingResult = await api.setupEmailRouting({
				domain: domain.trim(),
				cfApiToken: cfApiToken.trim(),
				cfAccountId: cfAccountId.trim(),
			});
			setEmailRoutingStatus(routingResult.success ? "success" : "error");
		} catch (err: unknown) {
			const msg =
				err instanceof Error
					? err.message
					: "Unknown error during Cloudflare setup";
			setError(msg);
			if (domainVerifyStatus === "loading") {
				setDomainVerifyStatus("error");
			}
			setEmailRoutingStatus("error");
		} finally {
			setIsProcessing(false);
		}
	};

	const handleCloudflareNext = () => {
		if (domainVerifyStatus === "success" && emailRoutingStatus === "success") {
			goNext();
		}
	};

	const handleMailboxSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!mailboxEmail.trim()) {
			setError("Please enter an email address");
			return;
		}
		if (!mailboxEmail.includes("@")) {
			setError("Please enter a valid email address (e.g. hello@example.com)");
			return;
		}

		setIsProcessing(true);
		try {
			const name = mailboxName.trim() || mailboxEmail.split("@")[0];
			await api.createMailbox(mailboxEmail.toLowerCase(), name);
			goNext();
		} catch (err: unknown) {
			const msg =
				err instanceof Error ? err.message : "Failed to create mailbox";
			setError(msg);
		} finally {
			setIsProcessing(false);
		}
	};

	// ── Render ──────────────────────────────────────────────────────

	return (
		<div className="min-h-screen bg-kumo-recessed flex flex-col items-center justify-center px-4 py-12">
			<div className="w-full max-w-lg">
				<StepProgress currentIndex={stepIndex} />

				{/* ── Step 0: Welcome ──────────────────────────── */}
				{stepId === "welcome" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-10 text-center">
						<div className="flex justify-center mb-5">
							<div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10">
								<EnvelopeIcon
									size={32}
									weight="duotone"
									className="text-blue-500"
								/>
							</div>
						</div>
						<h1 className="text-2xl font-bold text-kumo-default mb-2">
							Welcome to Mailboxes
						</h1>
						<p className="text-sm text-kumo-subtle max-w-sm mx-auto mb-8 leading-relaxed">
							A lightweight, self-hosted email client built on Cloudflare
							Workers. Let's get your first mailbox set up in a few steps.
						</p>
						<div className="flex justify-center">
							<Button variant="primary" size="lg" onClick={goNext}>
								Get Started
								<CaretRightIcon size={16} />
							</Button>
						</div>
					</div>
				)}

				{/* ── Step 1: Domain ───────────────────────────── */}
				{stepId === "domain" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Mail Domain
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							Enter the domain you'll use for sending and receiving email.
						</p>
						<form onSubmit={handleDomainSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<Input
								label="Email Domain"
								placeholder="example.com"
								size="sm"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
								autoFocus
								required
							/>
							<p className="text-xs text-kumo-subtle">
								Must already be added to Cloudflare and using its nameservers.
							</p>
							<div className="flex justify-end gap-2 pt-2">
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={goBack}
								>
									Back
								</Button>
								<Button variant="primary" size="sm" type="submit">
									Continue
									<CaretRightIcon size={14} />
								</Button>
							</div>
						</form>
					</div>
				)}

				{/* ── Step 2: Resend API Key ──────────────────── */}
				{stepId === "resend" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Resend API Key
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							Enter your Resend API key to enable email sending.
							You can skip this step and add it later in Settings.
						</p>
						<form onSubmit={handleResendSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
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
							<div className="flex justify-between gap-2 pt-2">
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={() => { setResendApiKey(""); goNext(); }}
								>
									Skip for now
								</Button>
								<div className="flex gap-2">
									<Button
										variant="secondary"
										size="sm"
										type="button"
										onClick={goBack}
									>
										Back
									</Button>
									<Button variant="primary" size="sm" type="submit">
										Continue
										<CaretRightIcon size={14} />
									</Button>
								</div>
							</div>
						</form>
					</div>
				)}

				{/* ── Step 3: Cloudflare Config ────────────────── */}
				{stepId === "cloudflare" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Cloudflare Configuration
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							Provide your Cloudflare credentials to set up Email
							Routing automatically.
						</p>
						<form onSubmit={handleCloudflareSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<Input
								label="Cloudflare API Token"
								placeholder="••••••••••••••••••••"
								size="sm"
								type="password"
								value={cfApiToken}
								onChange={(e) => setCfApiToken(e.target.value)}
								autoFocus
								required
							/>
							<Input
								label="Cloudflare Account ID"
								placeholder="••••••••••••••••••••"
								size="sm"
								type="password"
								value={cfAccountId}
								onChange={(e) => setCfAccountId(e.target.value)}
								required
							/>
							<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
								<p className="text-xs text-kumo-subtle">
									<strong className="text-blue-700">
										Required permissions:
									</strong>{" "}
									Zone:DNS:Edit + Zone:Email Routing:Edit
								</p>
							</div>

							{/* Progress indicators */}
							{domainVerifyStatus !== "pending" ||
							emailRoutingStatus !== "pending" ? (
								<div className="space-y-2 rounded-lg bg-kumo-fill px-4 py-3">
									<StatusBadge
										status={domainVerifyStatus}
										label={
											!resendApiKey.trim()
												? "Resend skipped"
												: domainVerifyStatus === "loading"
													? "Creating Resend domain & DNS records…"
													: domainVerifyStatus === "success"
														? "Domain verified & DNS configured"
														: domainVerifyStatus === "error"
															? "Domain verification failed"
															: "Domain verification"
										}
									/>
									<StatusBadge
										status={emailRoutingStatus}
										label={
											emailRoutingStatus === "loading"
												? "Setting up catch-all email routing…"
												: emailRoutingStatus === "success"
													? "Email routing enabled"
													: emailRoutingStatus === "error"
														? "Email routing setup failed"
														: "Email routing"
										}
									/>
								</div>
							) : null}

							<div className="flex justify-end gap-2 pt-2">
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={goBack}
								>
									Back
								</Button>
								{domainVerifyStatus === "success" &&
								emailRoutingStatus === "success" ? (
									<Button
										variant="primary"
										size="sm"
										type="button"
										onClick={handleCloudflareNext}
									>
										Continue
										<CaretRightIcon size={14} />
									</Button>
								) : (
									<Button
										variant="primary"
										size="sm"
										type="submit"
										loading={isProcessing}
										disabled={isProcessing}
									>
										Verify & Configure
									</Button>
								)}
							</div>
						</form>
					</div>
				)}

				{/* ── Step 4: Create First Mailbox ────────────── */}
				{stepId === "mailbox" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Create Your First Mailbox
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							This is the email address you'll use to send and receive.
						</p>
						<form onSubmit={handleMailboxSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<Input
								label="Email Address"
								placeholder="hello@example.com"
								size="sm"
								value={mailboxEmail}
								onChange={(e) => setMailboxEmail(e.target.value)}
								autoFocus
								required
							/>
							<Input
								label="Display Name (optional)"
								placeholder="Info"
								size="sm"
								value={mailboxName}
								onChange={(e) => setMailboxName(e.target.value)}
							/>
							<div className="flex justify-end gap-2 pt-2">
								<Button
									variant="secondary"
									size="sm"
									type="button"
									onClick={goBack}
								>
									Back
								</Button>
								<Button
									variant="primary"
									size="sm"
									type="submit"
									loading={isProcessing}
									disabled={isProcessing}
								>
									Create Mailbox
								</Button>
							</div>
						</form>
					</div>
				)}

				{/* ── Step 5: Complete ────────────────────────── */}
				{stepId === "complete" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-10 text-center">
						<div className="flex justify-center mb-5">
							<div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
								<CheckCircleIcon size={32} className="text-green-500" />
							</div>
						</div>
						<h2 className="text-xl font-bold text-kumo-default mb-2">
							You're all set!
						</h2>
						<p className="text-sm text-kumo-subtle max-w-sm mx-auto mb-8 leading-relaxed">
							Your mailbox{" "}
							<strong className="text-kumo-default">{mailboxEmail}</strong> is
							ready. Emails sent to{" "}
							<strong className="text-kumo-default">*@{domain}</strong> will
							be routed to your Worker.
						</p>
						<RouterLink to="/">
							<Button variant="primary" size="lg">
								Go to Mailboxes
								<CaretRightIcon size={16} />
							</Button>
						</RouterLink>
					</div>
				)}
			</div>
		</div>
	);
}

export function meta() {
	return [{ title: "Setup — Mailboxes" }];
}
