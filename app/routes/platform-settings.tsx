// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import {
	Badge,
	Button,
	Loader,
} from "@cloudflare/kumo";
import {
	ArrowLeft,
	Globe,
	Plus,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type MetaArgs, Link as RouterLink } from "react-router";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import { AgentApiKeysSection } from "~/components/AgentApiKeysSection";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { PlatformSettingsSection } from "~/components/PlatformSettingsSection";
import { useDomains } from "~/queries/domains";
import { isLocale } from "shared/i18n/config";
import { translate } from "shared/i18n/translate";

// ── Domain Management Section ───────────────────────────────────

function DomainsSection() {
	const { t, i18n } = useTranslation("settings");
	const { data: domains = [], isLoading } = useDomains();

	// Add Domain wizard
	const [showAddWizard, setShowAddWizard] = useState(false);

	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			{/* Header */}
			<div className="flex items-center gap-3 px-5 py-3.5 border-b border-kumo-line">
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-default">
					<Globe size={16} />
				</div>
				<div className="min-w-0 flex-1">
					<span className="text-sm font-medium text-kumo-default">
						{t("domainsTitle")}
					</span>
				</div>
				<Badge variant="info">
					{domains.length}
				</Badge>
				<Button
					variant="primary"
					size="sm"
					icon={<Plus size={16} />}
					onClick={() => setShowAddWizard(true)}
				>
					{t("domains.addDomain")}
				</Button>
			</div>

			{/* Domain list */}
			{isLoading ? (
				<div className="flex items-center justify-center py-8">
					<Loader size="base" />
				</div>
			) : domains.length === 0 ? (
				<div className="px-5 py-8 text-center">
					<p className="text-sm text-kumo-subtle">
						{t("domains.empty")}
					</p>
				</div>
			) : (
				<div>
					{domains.map((domain, idx) => (
						<RouterLink
							key={domain.id}
							to={`/settings/domains/${domain.id}`}
							className={`block px-5 py-3.5 no-underline transition-colors hover:bg-kumo-tint ${
								idx > 0 ? "border-t border-kumo-line" : ""
							}`}
						>
							{/* Row 1: Domain name, status */}
							<div className="flex items-center gap-2">
								<Globe
									size={16}
									className="shrink-0 text-kumo-subtle"
								/>
								<span className="text-sm font-semibold text-kumo-default">
									{domain.name}
								</span>
								<div className="ml-auto">
									<DomainFullStatus domain={domain} />
								</div>
							</div>

							{/* Row 2: Date + Catch-all */}
							<div className="flex items-center gap-3 mt-1 pl-6 text-[11px]">
								<span className="text-kumo-subtle">
									{domain.created_at
										? new Date(domain.created_at).toLocaleDateString(i18n.language, {
												month: "short",
												day: "numeric",
												year: "numeric",
											})
										: "—"}
								</span>
								{domain.catch_all_mailbox && (
									<span className="text-blue-600">
										{t("domains.catchAll", { mailbox: domain.catch_all_mailbox })}
									</span>
								)}
							</div>
						</RouterLink>
					))}
				</div>
			)}

			{/* Add Domain Wizard */}
			{showAddWizard && (
				<AddDomainWizard
					onClose={() => setShowAddWizard(false)}
					onSuccess={() => setShowAddWizard(false)}
					onComplete={() => setShowAddWizard(false)}
				/>
			)}
		</div>
	);
}

// ── Page ───────────────────────────────────────────────────────────

export function meta({ matches }: MetaArgs) {
	const rootData = matches.find((m) => m?.id === "root")?.data as
		| { locale?: string }
		| undefined;
	const locale = isLocale(rootData?.locale) ? rootData.locale : "en";
	return [{ title: translate(locale, "settings:metaTitle") }];
}

export default function SettingsRoute() {
	const { t } = useTranslation("settings");
	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				{/* Header */}
				<div className="mb-8">
					<div className="mb-2">
						<RouterLink
							to="/"
							className="inline-flex items-center gap-1.5 text-sm text-kumo-accent hover:text-kumo-accent/80 transition-colors"
						>
							<ArrowLeft size={14} />
							{t("backToMailboxes")}
						</RouterLink>
					</div>
					<h1 className="text-2xl font-bold text-kumo-default">
						{t("title")}
					</h1>
				</div>

				{/* Platform Settings */}
				<div className="mb-6">
					<h2 className="text-sm font-semibold text-kumo-default mb-3">{t("platformSettingsTitle")}</h2>
					<PlatformSettingsSection />
				</div>

				{/* Global Agent API Keys — consumed by external LLM / MCP clients */}
				<div className="mb-6">
					<h2 className="text-sm font-semibold text-kumo-default mb-3">{t("agentApiKeysTitle")}</h2>
					<AgentApiKeysSection />
				</div>

				{/* Domain Management */}
				<div className="mb-6">
					<h2 className="text-sm font-semibold text-kumo-default mb-3">{t("domainsTitle")}</h2>
					<DomainsSection />
				</div>

			</div>
		</div>
	);
}
