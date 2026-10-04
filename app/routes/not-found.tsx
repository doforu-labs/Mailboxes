// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Button, Empty } from "@cloudflare/kumo";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

export default function NotFoundRoute() {
	const navigate = useNavigate();
	// [i18n-foundation] End-to-end example: a fully translated route.
	// Every other route in the app still renders hard-coded English until the
	// text-extraction chunks migrate them.
	const { t } = useTranslation("common");

	return (
		<div className="flex items-center justify-center min-h-screen">
			<Empty
				icon={<TriangleAlert size={48} className="text-kumo-inactive" />}
				title={t("notFoundTitle")}
				description={t("notFoundDescription")}
				contents={
					<Button variant="primary" size="sm" onClick={() => navigate("/")}>
						{t("goHome")}
					</Button>
				}
			/>
		</div>
	);
}
