// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import type { Domain } from "~/types";

const knownStatuses = new Set<Domain["status"]>(["verified", "pending", "failed"]);

function normalize(status: string): Domain["status"] {
	if (knownStatuses.has(status as Domain["status"])) return status as Domain["status"];
	// Resend may return non-standard statuses like "not_started",
	// "dns_verification_in_progress", etc. — treat them all as pending.
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
