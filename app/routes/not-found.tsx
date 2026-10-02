// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Button, Empty } from "@cloudflare/kumo";
import { TriangleAlert } from "lucide-react";
import { useNavigate } from "react-router";

export default function NotFoundRoute() {
	const navigate = useNavigate();

	return (
		<div className="flex items-center justify-center min-h-screen">
			<Empty
				icon={<TriangleAlert size={48} className="text-kumo-inactive" />}
				title="404 -- Page Not Found"
				description="The page you're looking for doesn't exist."
				contents={
					<Button variant="primary" size="sm" onClick={() => navigate("/")}>
						Go Home
					</Button>
				}
			/>
		</div>
	);
}
