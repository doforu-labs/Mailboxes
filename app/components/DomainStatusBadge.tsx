// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import type { Domain } from "~/types";

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
	return (
		<Badge variant={variants[status]}>{labels[status]}</Badge>
	);
}
