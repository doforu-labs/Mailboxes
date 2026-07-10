// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Loader,
} from "@cloudflare/kumo";
import {
	CaretRightIcon,
	CheckCircleIcon,
	EnvelopeIcon,
	EyeIcon,
	EyeSlashIcon,
	GearSixIcon,
	GlobeIcon,
	UserIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { Link as RouterLink } from "react-router";
import api from "~/services/api";
import type { CfZone } from "~/services/api";

// Cloudflare API Token Template URL — pre-fills the token creation page
// with DNS Edit + Zone Settings Edit permissions.
// Email Routing Rules is NOT supported by template URLs, must be added manually.
// Ref: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
const CF_TOKEN_TEMPLATE_URL = (() => {
	const permissions = [
		{ key: "dns", type: "edit" },
		{ key: "zone_settings", type: "edit" },
	];
	return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
		JSON.stringify(permissions)
	)}&accountId=*&zoneId=all&name=Mailboxes%20Token`;
})();

// ── Types ──────────────────────────────────────────────────────────

interface StepConfig {
	id: string;
	label: string;
	icon: React.ReactNode;
}

// ── Steps ──────────────────────────────────────────────────────────

const STEPS: StepConfig[] = [
	{ id: "welcome", label: "Welcome", icon: <EnvelopeIcon size={16} /> },
	{ id: "cf-config", label: "CF Config", icon: <GearSixIcon size={16} /> },
	{ id: "select-domain", label: "Domain", icon: <GlobeIcon size={16} /> },
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

// ── Setup Page ─────────────────────────────────────────────────────

export default function SetupRoute() {
	// Current step index
	const [stepIndex, setStepIndex] = useState(0);

	// Form state — CF config
	const [cfApiToken, setCfApiToken] = useState("");
	const [cfAccountId, setCfAccountId] = useState("");
	const [showCfToken, setShowCfToken] = useState(false);
	const [showCfAccountId, setShowCfAccountId] = useState(false);

	// Form state — domain selection
	const [cfDomains, setCfDomains] = useState<CfZone[]>([]);
	const [selectedDomain, setSelectedDomain] = useState("");
	const [customDomain, setCustomDomain] = useState("");
	const [useCustomDomain, setUseCustomDomain] = useState(false);
	const [isDetectingDomains, setIsDetectingDomains] = useState(false);

	// Form state — mailbox
	const [mailboxEmail, setMailboxEmail] = useState("");
	const [mailboxName, setMailboxName] = useState("");

	// Loading / error state
	const [isProcessing, setIsProcessing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Email routing status
	const [emailRoutingStatus, setEmailRoutingStatus] = useState<
		"pending" | "loading" | "success" | "error"
	>("pending");

	const stepId = STEPS[stepIndex].id;

	// Resolved domain (either selected from CF or custom)
	const domain = useCustomDomain ? customDomain.trim() : selectedDomain;

	// ── Navigation ──────────────────────────────────────────────────

	const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
	const goBack = () => {
		setError(null);
		setStepIndex((i) => Math.max(i - 1, 0));
	};

	// ── Step Handlers ───────────────────────────────────────────────

	const handleCfConfigSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError(null);

		if (!cfApiToken.trim() || !cfAccountId.trim()) {
			setError("Both Cloudflare API Token and Account ID are required");
			return;
		}

		setIsDetectingDomains(true);
		setError(null);

		try {
			const result = await api.detectCfDomains({
				cfApiToken: cfApiToken.trim(),
				cfAccountId: cfAccountId.trim(),
			});
			setCfDomains(result.zones);

			// If only one zone, auto-select it
			if (result.zones.length === 1) {
				setSelectedDomain(result.zones[0].name);
			}

			goNext();
		} catch (err: unknown) {
			const msg =
				err instanceof Error
					? err.message
					: "Failed to detect domains from Cloudflare";
			setError(msg);
		} finally {
			setIsDetectingDomains(false);
		}
	};

	const handleDomainSubmit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);

		const resolvedDomain = useCustomDomain ? customDomain.trim() : selectedDomain;

		if (!resolvedDomain) {
			setError("Please select or enter a domain");
			return;
		}
		if (!resolvedDomain.includes(".")) {
			setError("Please enter a valid domain (e.g. example.com)");
			return;
		}

		// Auto-fill mailbox email with hello@domain
		if (!mailboxEmail) {
			setMailboxEmail(`hello@${resolvedDomain}`);
		}

		goNext();
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
			// 1. Set up email routing for the CF domain
			setEmailRoutingStatus("loading");
			const routingResult = await api.setupEmailRouting({
				domain: domain.trim(),
				cfApiToken: cfApiToken.trim(),
				cfAccountId: cfAccountId.trim(),
			});
			setEmailRoutingStatus(routingResult.success ? "success" : "error");

			if (!routingResult.success) {
				setError("Email routing setup failed. You can retry from Settings later.");
				return;
			}

			// 2. Create the first mailbox
			const name = mailboxName.trim() || mailboxEmail.split("@")[0];
			await api.createMailbox(mailboxEmail.toLowerCase(), name);
			goNext();
		} catch (err: unknown) {
			const msg =
				err instanceof Error ? err.message : "Failed to create mailbox";
			setError(msg);
			setEmailRoutingStatus("error");
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
							Workers. Let's connect your Cloudflare account and set up your
							first mailbox.
						</p>
						<div className="flex justify-center">
							<Button variant="primary" size="lg" onClick={goNext}>
								Get Started
								<CaretRightIcon size={16} />
							</Button>
						</div>
					</div>
				)}

				{/* ── Step 1: CF Config ────────────────────────── */}
				{stepId === "cf-config" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Cloudflare Configuration
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							Enter your Cloudflare credentials. We'll auto-detect the domains
							in your account.
						</p>
						<form onSubmit={handleCfConfigSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<div>
								<label className="mb-1 block text-sm font-medium text-kumo-default">Cloudflare API Token</label>
								<div className="relative">
									<input
										type={showCfToken ? "text" : "password"}
										className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 pr-10 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
										placeholder="••••••••••••••••••••••••••••••••••••••••"
										value={cfApiToken}
										onChange={(e) => setCfApiToken(e.target.value)}
										autoFocus
										required
									/>
									<button
										type="button"
										className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-muted hover:text-kumo-default"
										onClick={() => setShowCfToken(!showCfToken)}
									>
										{showCfToken ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
									</button>
								</div>
							</div>
							<div>
								<label className="mb-1 block text-sm font-medium text-kumo-default">Cloudflare Account ID</label>
								<div className="relative">
									<input
										type={showCfAccountId ? "text" : "password"}
										className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 pr-10 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
										placeholder="••••••••••••••••••••••••••••••••••••••••"
										value={cfAccountId}
										onChange={(e) => setCfAccountId(e.target.value)}
										required
									/>
									<button
										type="button"
										className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-muted hover:text-kumo-default"
										onClick={() => setShowCfAccountId(!showCfAccountId)}
									>
										{showCfAccountId ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
									</button>
								</div>
							</div>
							<div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2.5">
								<p className="text-xs text-kumo-subtle">
									<a
										href={CF_TOKEN_TEMPLATE_URL}
										target="_blank"
										rel="noopener noreferrer"
										className="text-blue-600 underline font-medium"
									>
										Create a pre-configured token →
									</a>
								</p>
								<p className="text-xs text-kumo-subtle mt-1.5">
									Required permissions / 需要的权限:
								</p>
								<ul className="text-xs text-kumo-subtle list-disc list-inside mt-0.5">
									<li>
										Zone: DNS Edit / 区域: DNS 编辑
									</li>
									<li>
										Zone: Zone Settings Edit / 区域: 区域设置 编辑
									</li>
									<li>
										Zone: Email Routing Rules Edit / 区域: 电子邮件路由规则 编辑
									</li>
								</ul>
								<p className="text-xs text-kumo-subtle mt-1.5">
									The link above pre-fills DNS + Zone Settings permissions. Click "Add more" / "添加更多" to also add Email Routing Rules, then copy the token here.
								</p>
							</div>
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
									loading={isDetectingDomains}
									disabled={isDetectingDomains}
								>
									Detect Domains
									<CaretRightIcon size={14} />
								</Button>
							</div>
						</form>
					</div>
				)}

				{/* ── Step 2: Select Domain ────────────────────── */}
				{stepId === "select-domain" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Select Domain
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							Pick a domain from your Cloudflare account, or enter one manually.
						</p>
						<form onSubmit={handleDomainSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}

							{cfDomains.length > 0 && (
								<>
									<div>
										<label className="mb-1 block text-sm font-medium text-kumo-default">
											Detected Domains ({cfDomains.length})
										</label>
										<select
											className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
											value={selectedDomain}
											onChange={(e) => {
												setSelectedDomain(e.target.value);
												setUseCustomDomain(false);
												setCustomDomain("");
											}}
											disabled={useCustomDomain}
										>
											<option value="">Select a domain…</option>
											{cfDomains
												.filter((z) => z.status === "active")
												.map((zone) => (
													<option key={zone.id} value={zone.name}>
														{zone.name}
													</option>
												))}
											{/* Show inactive domains separately */}
											{cfDomains.some((z) => z.status !== "active") && (
												<optgroup label="Inactive / pending domains">
													{cfDomains
														.filter((z) => z.status !== "active")
														.map((zone) => (
															<option key={zone.id} value={zone.name}>
																{zone.name} ({zone.status})
															</option>
														))}
												</optgroup>
											)}
										</select>
									</div>

									<div className="flex items-center gap-2">
										<div className="h-px flex-1 bg-kumo-line" />
										<span className="text-xs text-kumo-subtle">or</span>
										<div className="h-px flex-1 bg-kumo-line" />
									</div>
								</>
							)}

							<div>
								<label className="mb-1 block text-sm font-medium text-kumo-default">
									{cfDomains.length > 0 ? "Enter domain manually" : "Domain Name"}
								</label>
								<input
									type="text"
									className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
									placeholder="example.com"
									value={customDomain}
									onChange={(e) => {
										setCustomDomain(e.target.value);
										setUseCustomDomain(true);
										setSelectedDomain("");
									}}
									disabled={!useCustomDomain && cfDomains.length > 0 && !!selectedDomain}
									autoFocus={cfDomains.length === 0}
								/>
								<p className="text-xs text-kumo-subtle mt-1">
									Must be added to Cloudflare and using its nameservers.
								</p>
							</div>

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

				{/* ── Step 3: Create First Mailbox ────────────── */}
				{stepId === "mailbox" && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="text-lg font-semibold text-kumo-default mb-1">
							Create Your First Mailbox
						</h2>
						<p className="text-sm text-kumo-subtle mb-6">
							This is the email address you'll use to send and receive on{" "}
							<strong className="text-kumo-default">{domain}</strong>.
						</p>
						<form onSubmit={handleMailboxSubmit} className="space-y-4">
							{error && <ErrorBanner message={error} />}
							<div>
								<label className="mb-1 block text-sm font-medium text-kumo-default">Email Address</label>
								<input
									type="email"
									className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
									placeholder="hello@example.com"
									value={mailboxEmail}
									onChange={(e) => setMailboxEmail(e.target.value)}
									autoFocus
									required
								/>
							</div>
							<div>
								<label className="mb-1 block text-sm font-medium text-kumo-default">Display Name (optional)</label>
								<input
									type="text"
									className="w-full rounded-md border border-kumo-line bg-kumo-fill px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-muted focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
									placeholder="Info"
									value={mailboxName}
									onChange={(e) => setMailboxName(e.target.value)}
								/>
							</div>

							{/* Email routing progress */}
							{emailRoutingStatus !== "pending" && (
								<div className="space-y-1 rounded-lg bg-kumo-fill px-4 py-3">
									<p className="text-xs text-kumo-subtle">
										{emailRoutingStatus === "loading" && (
											<span className="flex items-center gap-1.5">
												<Loader size={12} />
												Setting up catch-all email routing…
											</span>
										)}
										{emailRoutingStatus === "success" && (
											<span className="flex items-center gap-1.5 text-green-600">
												<CheckCircleIcon size={12} />
												Email routing enabled
											</span>
										)}
										{emailRoutingStatus === "error" && (
											<span className="flex items-center gap-1.5 text-red-600">
												<WarningIcon size={12} />
												Email routing failed — you can retry from Settings
											</span>
										)}
									</p>
								</div>
							)}

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

				{/* ── Step 4: Complete ────────────────────────── */}
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
