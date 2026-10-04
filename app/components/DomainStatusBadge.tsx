// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

import { Badge } from "@cloudflare/kumo";
import { useTranslation } from "react-i18next";
import type { Domain } from "~/types";
import type { TFunction } from "i18next";

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

export function StatusBadge({ status }: { status: Domain["status"] }) {
	const { t } = useTranslation("domainDetails");
	const normalized = normalize(status);
	const labels: Record<Domain["status"], string> = {
		verified: t("statusVerified"),
		pending: t("statusPending"),
		failed: t("statusFailed"),
	};
	return (
		<Badge variant={variants[normalized]}>{labels[normalized]}</Badge>
	);
}

// ── DomainFullStatus ─────────────────────────────────────────────
// Unified status display that replaces StatusBadge + DomainStatusIndicators.
// Shows one clear badge + descriptive subtitle per domain.

type DomainStatus = "active" | "awaiting_dns" | "sending_only" | "receiving" | "failed";

function getDomainStatus(
	domain: Domain,
	t: TFunction<"domainDetails">,
): {
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
			badge: { label: t("statusFailed"), variant: "error" },
			subtitle: t("statusSubtitleDnsVerificationFailed"),
		};
	}

	// 2. 接收已就绪（有 Cloudflare zone）
	if (hasZone) {
		if (isVerified && hasKey) {
			// 收发都正常
			return {
				status: "active",
				badge: { label: t("statusActive"), variant: "success" },
				subtitle: t("statusSubtitleActive"),
			};
		}
		// 只能接收，不能发送 — 用副标题区分原因
		return {
			status: "receiving",
			badge: { label: t("statusReceiving"), variant: "success" },
			subtitle: isVerified
				? t("statusSubtitleReceivingNoKey")
				: hasKey
					? t("statusSubtitleReceivingPendingVerification")
					: t("statusSubtitleReceivingNoKey"),
		};
	}

	// 3. 接收未就绪（无 Cloudflare zone）
	if (isVerified && hasKey) {
		// 只能发送，不能接收
		return {
			status: "sending_only",
			badge: { label: t("statusSendingOnly"), variant: "warning" },
			subtitle: t("statusSubtitleSendingOnly"),
		};
	}

	if (isVerified && !hasKey) {
		// 已验证但什么都没配置
		return {
			status: "awaiting_dns",
			badge: { label: t("statusVerified"), variant: "success" },
			subtitle: t("statusSubtitleVerifiedNoConfig"),
		};
	}

	// 未验证 + 无 zone — 收发都未就绪
	return {
		status: "awaiting_dns",
		badge: { label: t("statusAwaitingDns"), variant: "warning" },
		subtitle: t("statusSubtitleAwaitingDns"),
	};
}

export function DomainFullStatus({ domain }: { domain: Domain }) {
	const { t } = useTranslation("domainDetails");
	const { badge, subtitle } = getDomainStatus(domain, t);

	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<Badge variant={badge.variant}>{badge.label}</Badge>
			<span className="truncate text-[11px] text-kumo-subtle" title={subtitle}>{subtitle}</span>
		</span>
	);
}
