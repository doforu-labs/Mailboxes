// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

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

type DomainStatus = "active" | "awaiting_dns" | "sending_only" | "receiving" | "failed";

function getDomainStatus(domain: Domain): {
	status: DomainStatus;
	badge: { label: string; variant: "success" | "warning" | "error" };
	subtitle: string;
} {
	const hasZone = !!domain.cf_zone_id;
	const hasKey = !!domain.resend_api_key;
	const isVerified = domain.status === "verified";

	// 1. Failed
	if (domain.status === "failed") {
		return {
			status: "failed",
			badge: { label: "Failed", variant: "error" },
			subtitle: "DNS verification failed — check your DNS records and retry",
		};
	}

	// 2. 接收已就绪（有 Cloudflare zone）
	if (hasZone) {
		if (isVerified && hasKey) {
			// 收发都正常
			return {
				status: "active",
				badge: { label: "Active", variant: "success" },
				subtitle: "Sending and receiving emails",
			};
		}
		// 只能接收，不能发送 — 用副标题区分原因
		return {
			status: "receiving",
			badge: { label: "Receiving", variant: "success" },
			subtitle: isVerified
				? "Receiving emails. Add a Resend API key to enable sending"
				: hasKey
					? "Receiving emails. Sending pending DNS verification with Resend"
					: "Receiving emails. Add a Resend API key to enable sending",
		};
	}

	// 3. 接收未就绪（无 Cloudflare zone）
	if (isVerified && hasKey) {
		// 只能发送，不能接收
		return {
			status: "sending_only",
			badge: { label: "Sending Only", variant: "warning" },
			subtitle: "Configure MX records at your DNS provider to enable receiving",
		};
	}

	if (isVerified && !hasKey) {
		// 已验证但什么都没配置
		return {
			status: "awaiting_dns",
			badge: { label: "Verified", variant: "success" },
			subtitle: "Configure sending and receiving to activate",
		};
	}

	// 未验证 + 无 zone — 收发都未就绪
	return {
		status: "awaiting_dns",
		badge: { label: "Awaiting DNS", variant: "warning" },
		subtitle: "Add DNS records and verify to start sending and receiving",
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
