// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Domain } from "~/types";

const styles: Record<Domain["status"], string> = {
	verified: "bg-green-100 text-green-800",
	pending: "bg-yellow-100 text-yellow-800",
	failed: "bg-red-100 text-red-800",
};

const labels: Record<Domain["status"], string> = {
	verified: "Verified",
	pending: "Pending",
	failed: "Failed",
};

export function StatusBadge({ status }: { status: Domain["status"] }) {
	return (
		<span
			className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
		>
			{labels[status]}
		</span>
	);
}
