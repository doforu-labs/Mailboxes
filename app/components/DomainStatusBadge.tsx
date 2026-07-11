// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import type { Domain } from "~/types";

// ── StatusBadge (kept for backward compat) ───────────────────────

const knownStatuses = new Set<Domain["status"]>(["verified", "pending", "failed"]);

function normalize(status: string): Domain["status"] {
	if (knownStatuses.has(status as Domain["status"])) return status as Domain["status"];
	return "pending";
}

const variants: Record<Domain["status"], "success" | "warning" | "error"> = {
	verified: "success",
	pending: "warning",
	failed: "error",
};

const labels: Record<Domain["status"], string> = {
	verified: "Verified",
	pending: "Pending",
	failed: "Failed",
};

export function StatusBadge({ status }: { status: Domain["status"] }) {
	const normalized = normalize(status);
	return (
		<Badge variant={variants[normalized]}>{labels[normalized]}</Badge>
	);
}

// ── DomainFullStatus ─────────────────────────────────────────────
// Unified status display that replaces StatusBadge + DomainStatusIndicators.
// Shows one clear badge + descriptive subtitle per domain.

type DomainStatus = "active" | "awaiting_dns" | "sending_only" | "receiving_only" | "failed";

function getDomainStatus(domain: Domain): {
	status: DomainStatus;
	badge: { label: string; variant: "success" | "warning" | "error" };
	subtitle: string;
} {
	const hasZone = !!domain.cf_zone_id;
	const hasKey = !!domain.resend_api_key;
	const isVerified = domain.status === "verified";

	// Failed
	if (domain.status === "failed") {
		return {
			status: "failed",
			badge: { label: "Failed", variant: "error" },
			subtitle: "DNS verification failed — check your DNS records and retry",
		};
	}

	// DNS not verified yet (Resend still pending)
	if (!isVerified) {
		return {
			status: "awaiting_dns",
			badge: { label: "Awaiting DNS", variant: "warning" },
			subtitle: hasZone
				? "Cloudflare routing ready — verify DNS to enable sending"
				: "Add DNS records and verify to start sending and receiving",
		};
	}

	// Verified + both
	if (isVerified && hasZone && hasKey) {
		return {
			status: "active",
			badge: { label: "Active", variant: "success" },
			subtitle: "Sending and receiving emails",
		};
	}

	// Verified + receiving only (no Resend key)
	if (isVerified && hasZone && !hasKey) {
		return {
			status: "receiving_only",
			badge: { label: "Receiving Only", variant: "warning" },
			subtitle: "Add a Resend API key to enable sending",
		};
	}

	// Verified + sending only (no CF zone)
	if (isVerified && !hasZone && hasKey) {
		return {
			status: "sending_only",
			badge: { label: "Sending Only", variant: "warning" },
			subtitle: "Configure MX records at your DNS provider to enable receiving",
		};
	}

	// Verified but nothing configured (edge case)
	return {
		status: "awaiting_dns",
		badge: { label: "Verified", variant: "success" },
		subtitle: "Configure sending and receiving to activate",
	};
}

export function DomainFullStatus({ domain }: { domain: Domain }) {
	const { badge, subtitle } = getDomainStatus(domain);

	return (
		<div className="mt-1">
			<Badge variant={badge.variant}>{badge.label}</Badge>
			<div className="text-[11px] text-kumo-subtle mt-0.5">{subtitle}</div>
		</div>
	);
}
