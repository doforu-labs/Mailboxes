// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, EyeIcon, GearSixIcon, CheckCircleIcon, WarningCircleIcon, CircleNotchIcon, XCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import api, { type VerifyResendResult } from "~/services/api";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import type { AiProviderSettings } from "~/types";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [resendApiKey, setResendApiKey] = useState("");
	const [showResendKey, setShowResendKey] = useState(false);
	const [agentPrompt, setAgentPrompt] = useState("");

	// AI Provider state
	const [useCustomAi, setUseCustomAi] = useState(false);
	const [aiBaseUrl, setAiBaseUrl] = useState("");
	const [aiModelName, setAiModelName] = useState("");
	const [aiApiKey, setAiApiKey] = useState("");
	const [showAiApiKey, setShowAiApiKey] = useState(false);

	const [isSaving, setIsSaving] = useState(false);

	// Resend verification state
	type VerifyStatus = "idle" | "verifying" | "valid" | "invalid" | "error";
	const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>("idle");
	const [verifyResult, setVerifyResult] = useState<VerifyResendResult | null>(null);
	const verifyTimerRef = useRef<ReturnType<typeof setTimeout>>();
	const lastVerifiedKeyRef = useRef("");

	const doVerify = useCallback(
		async (key: string) => {
			if (!mailboxId) return;
			const trimmed = key.trim();
			if (!trimmed || !trimmed.startsWith("re_")) {
				setVerifyStatus("idle");
				setVerifyResult(null);
				lastVerifiedKeyRef.current = "";
				return;
			}
			// Skip if already verified for this key
			if (trimmed === lastVerifiedKeyRef.current && verifyStatus === "valid") return;
			setVerifyStatus("verifying");
			try {
				const result = await api.verifyResendKey(mailboxId, trimmed);
				setVerifyResult(result);
				lastVerifiedKeyRef.current = trimmed;
				if (!result.valid) {
					setVerifyStatus("invalid");
				} else {
					// Use "valid" for both ready and not-ready — JSX checks sendingReady to show details
					setVerifyStatus("valid");
				}
			} catch {
				setVerifyStatus("error");
				setVerifyResult(null);
			}
		},
		[mailboxId, verifyStatus],
	);

	const doVerifyRef = useRef(doVerify);
	doVerifyRef.current = doVerify;

	// Debounced auto-verify on key change
	useEffect(() => {
		if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
		const trimmed = resendApiKey.trim();
		if (!trimmed || !trimmed.startsWith("re_")) {
			setVerifyStatus("idle");
			setVerifyResult(null);
			lastVerifiedKeyRef.current = "";
			return;
		}
		verifyTimerRef.current = setTimeout(() => doVerifyRef.current(trimmed), 600);
		return () => { if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current); };
	}, [resendApiKey]);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setResendApiKey(mailbox.settings?.resendApiKey || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			const ap = mailbox.settings?.aiProvider;
			setUseCustomAi(ap?.provider === "openai-compatible" && !!ap?.baseUrl);
			setAiBaseUrl(ap?.baseUrl || "");
			setAiModelName(ap?.modelName || "");
			setAiApiKey(ap?.apiKey || "");
		}
	}, [mailbox]);

	// Domain wizard state
	const [isDomainWizardOpen, setIsDomainWizardOpen] = useState(false);

	const canSave = !resendApiKey.trim() || verifyStatus === "valid" || verifyStatus === "idle";

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;

		// If key is entered but not yet verified, verify first
		const trimmedKey = resendApiKey.trim();
		if (trimmedKey && trimmedKey.startsWith("re_") && verifyStatus !== "valid") {
			await doVerify(trimmedKey);
			if (lastVerifiedKeyRef.current !== trimmedKey) {
				toastManager.add({
					title: "Cannot save: Resend API key verification failed",
					variant: "error",
				});
				return;
			}
		}

		setIsSaving(true);

		const aiProviderSettings: AiProviderSettings | undefined =
			useCustomAi && aiBaseUrl.trim()
				? {
						provider: "openai-compatible",
						baseUrl: aiBaseUrl.trim().replace(/\/+$/, ""),
						modelName: aiModelName.trim() || undefined,
						apiKey: aiApiKey.trim() || undefined,
					}
				: undefined;

		const settings = {
			...mailbox.settings,
			fromName: displayName,
			resendApiKey: trimmedKey || undefined,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			aiProvider: aiProviderSettings,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;
	const isCustomAi = useCustomAi && aiBaseUrl.trim().length > 0;

	return (
		<>
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
						<div className="relative">
							<Input
								label="Resend API Key"
								type={showResendKey ? "text" : "password"}
								placeholder="re_..."
								value={resendApiKey}
								onChange={(e) => setResendApiKey(e.target.value)}
							/>
							<button
								type="button"
								onClick={() => setShowResendKey(!showResendKey)}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-default transition-colors"
								title={showResendKey ? "Hide key" : "Show key"}
							>
								<EyeIcon size={16} weight={showResendKey ? "fill" : "regular"} />
							</button>
						</div>
						{/* Resend API Key verification status */}
						{resendApiKey.trim() && !resendApiKey.startsWith("re_") && (
							<Badge variant="warning">Invalid format (should start with re_)</Badge>
						)}
						{verifyStatus === "verifying" && resendApiKey.startsWith("re_") && (
							<div className="flex items-center gap-1.5 text-xs text-kumo-subtle">
								<CircleNotchIcon size={14} weight="bold" className="animate-spin" />
								<span>Verifying key with Resend...</span>
							</div>
						)}
						{verifyStatus === "valid" && verifyResult?.sendingReady && (
							<div className="space-y-1.5">
								<Badge variant="success"><CheckCircleIcon size={12} weight="fill" /> API key verified</Badge>
								<Badge variant="success">Domain verified & ready to send</Badge>
							</div>
						)}
						{verifyStatus === "valid" && verifyResult && !verifyResult.sendingReady && (
							<div className="space-y-1.5">
								<Badge variant="success"><CheckCircleIcon size={12} weight="fill" /> API key verified</Badge>
								{verifyResult.matchingDomain ? (
									<Badge variant="warning"><WarningCircleIcon size={12} weight="fill" /> Domain "{verifyResult.matchingDomain.domain}" is "{verifyResult.matchingDomain.status}" — <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="underline font-medium hover:text-kumo-default">verify DNS records in Resend</a></Badge>
								) : (
									<Badge variant="warning"><WarningCircleIcon size={12} weight="fill" /> No matching domain for {mailbox.email.split("@")[1]} in Resend — <button type="button" onClick={() => setIsDomainWizardOpen(true)} className="underline font-medium hover:text-kumo-default">Set up domain in app</button></Badge>
								)}
								<details className="text-xs text-kumo-subtle">
									<summary className="cursor-pointer hover:text-kumo-default">View all Resend domains</summary>
									<ul className="mt-1 ml-3 list-disc space-y-0.5">
										{verifyResult.domains?.map((d) => (
											<li key={d.id}>
												{d.domain} — <span className={d.status === "valid" ? "text-green-500" : "text-yellow-500"}>{d.status}</span>
											</li>
										))}
										{verifyResult.domains?.length === 0 && <li>No domains configured</li>}
									</ul>
								</details>
							</div>
						)}
						{verifyStatus === "invalid" && (
							<Badge variant="error"><XCircleIcon size={12} weight="fill" /> {verifyResult?.error || "Invalid API key"}</Badge>
						)}
						{verifyStatus === "error" && (
							<Badge variant="error">Verification failed — try again</Badge>
						)}
					</div>
				</div>

				{/* AI Model */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<GearSixIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Model
							</span>
							{isCustomAi ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Cloudflare</Badge>
							)}
						</div>
						<Switch
							checked={useCustomAi}
							onCheckedChange={(checked) => setUseCustomAi(checked)}
						/>
					</div>

					{useCustomAi ? (
						<div className="space-y-3">
							<Input
								label="Base URL"
								type="url"
								placeholder="https://api.deepseek.com/v1"
								value={aiBaseUrl}
								onChange={(e) => setAiBaseUrl(e.target.value)}
							/>
							<Input
								label="Model Name"
								placeholder="deepseek-v4-flash"
								value={aiModelName}
								onChange={(e) => setAiModelName(e.target.value)}
							/>
							<div className="relative">
								<Input
									label="API Key"
									type={showAiApiKey ? "text" : "password"}
									placeholder="sk-..."
									value={aiApiKey}
									onChange={(e) => setAiApiKey(e.target.value)}
								/>
								<button
									type="button"
									onClick={() => setShowAiApiKey(!showAiApiKey)}
									className="absolute right-2 top-1/2 -translate-y-1/2 text-kumo-subtle hover:text-kumo-default transition-colors"
									title={showAiApiKey ? "Hide key" : "Show key"}
								>
									<EyeIcon size={16} weight={showAiApiKey ? "fill" : "regular"} />
								</button>
							</div>
							<p className="text-xs text-kumo-subtle">
								Falls back to Cloudflare Workers AI if the custom provider is unreachable.
							</p>
						</div>
					) : (
						<p className="text-xs text-kumo-subtle">
							Using <strong>Cloudflare Workers AI</strong> — {aiModelName || "@cf/moonshotai/kimi-k2.6"}.
							Toggle the switch above to connect a custom OpenAI-compatible provider.
						</p>
					)}
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving} disabled={!canSave}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>

		{isDomainWizardOpen && mailbox && (
			<AddDomainWizard
				onClose={() => setIsDomainWizardOpen(false)}
				onSuccess={() => {
				setIsDomainWizardOpen(false);
				// Re-trigger verification to pick up the new domain
				const trimmed = resendApiKey.trim();
				if (trimmed && trimmed.startsWith("re_")) {
					lastVerifiedKeyRef.current = "";
					doVerify(trimmed);
				}
			}}
				defaultDomain={mailbox.email.split("@")[1]}
				defaultApiKey={resendApiKey.trim() || undefined}
			/>
		)}
		</>
	);
}
