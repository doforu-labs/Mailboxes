// Copyright (c) 2026 Cloudflare, Inc.
// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Switch, useKumoToastManager } from "@cloudflare/kumo";
import {
	Bot,
	Cpu,
	RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import type { AiProviderSettings } from "~/types";

const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function MailboxSettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");

	// AI Provider state
	const [useCustomAi, setUseCustomAi] = useState(false);
	const [aiBaseUrl, setAiBaseUrl] = useState("");
	const [aiModelName, setAiModelName] = useState("");
	const [aiApiKey, setAiApiKey] = useState("");
	const [showAiApiKey, setShowAiApiKey] = useState(false);

	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			const ap = mailbox.settings?.aiProvider;
			setUseCustomAi(ap?.provider === "openai-compatible" && !!ap?.baseUrl);
			setAiBaseUrl(ap?.baseUrl || "");
			setAiModelName(ap?.modelName || "");
			setAiApiKey(ap?.apiKey || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;

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

	const handleResetPrompt = useCallback(() => {
		setAgentPrompt("");
	}, []);

	if (!mailbox) {
		return (
			<div className="flex items-center justify-center h-full py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;
	const isCustomAi = useCustomAi && aiBaseUrl.trim().length > 0;

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-2xl px-4 py-4 md:px-8 md:py-6">
				<h1 className="mb-6 text-lg font-semibold text-kumo-default">Settings</h1>

				<div className="space-y-6">
					{/* General */}
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
						<div className="mb-4 text-sm font-medium text-kumo-default">
							General
						</div>
						<div className="space-y-3">
							<Input
								label="Display Name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
							/>
							<Input label="Email" type="email" value={mailbox.email} disabled />
						</div>
					</div>

					{/* AI Model */}
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
						<div className="mb-4 flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Cpu size={16} className="text-kumo-subtle" />
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
										{showAiApiKey ? "●" : "○"}
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

					{/* AI Agent Prompt */}
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
						<div className="mb-4 flex items-center justify-between">
							<div className="flex items-center gap-2">
								<Bot size={16} className="text-kumo-subtle" />
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
									icon={<RotateCcw size={14} />}
									onClick={handleResetPrompt}
								>
									Reset to default
								</Button>
							)}
						</div>
						<p className="mb-3 text-xs text-kumo-subtle">
							Customize how the AI agent behaves for this mailbox.
							Leave empty to use the built-in default prompt.
						</p>
						<textarea
							value={agentPrompt}
							onChange={(e) => setAgentPrompt(e.target.value)}
							placeholder={PROMPT_PLACEHOLDER}
							rows={12}
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 font-mono text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring leading-relaxed"
						/>
						<p className="mt-2 text-xs text-kumo-subtle">
							The prompt is sent as the system message to the AI model.
							It controls the agent's personality, writing style, and behavior rules.
						</p>
					</div>

					{/* Save */}
					<div className="flex justify-end">
						<Button variant="primary" onClick={handleSave} loading={isSaving}>
							Save Changes
						</Button>
					</div>

				</div>
			</div>
		</div>

	);
}
