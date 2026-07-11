// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

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
import { Link as RouterLink } from "react-router";
import { AddDomainWizard } from "~/components/AddDomainWizard";
import { DomainFullStatus } from "~/components/DomainStatusBadge";
import { PlatformSettingsSection } from "~/components/PlatformSettingsSection";
import { useDomains } from "~/queries/domains";

// ── Domain Management Section ───────────────────────────────────

function DomainsSection() {
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
						Domains
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
					Add Domain
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
						No domains configured yet.
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
										? new Date(domain.created_at).toLocaleDateString("en-US", {
												month: "short",
												day: "numeric",
												year: "numeric",
											})
										: "—"}
								</span>
								{domain.catch_all_mailbox && (
									<span className="text-blue-600">
										Catch-all: {domain.catch_all_mailbox}
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

export function meta() {
	return [{ title: "Platform Settings — Mailboxes" }];
}

export default function SettingsRoute() {
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
							Back to Mailboxes
						</RouterLink>
					</div>
					<h1 className="text-2xl font-bold text-kumo-default">
						Platform Settings
					</h1>
				</div>

				{/* Platform Settings */}
				<PlatformSettingsSection />

				{/* Domain Management */}
				<div className="mt-6">
					<DomainsSection />
				</div>
			</div>
		</div>
	);
}
