// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Workers AI / OpenAI-compatible tool definition for Function Calling.
 */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: Record<
				string,
				{
					type: string;
					description: string;
					enum?: string[];
				}
			>;
			required: string[];
		};
	};
}

export interface Env extends Cloudflare.Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	AI: Ai;
	/**
	 * `"1"` only on the public read-only demo instance (wrangler.demo.jsonc).
	 * Absent on production — and the demo code branches on the exact string, so
	 * a missing, empty or mistyped value keeps the production path.
	 */
	DEMO_MODE?: string;
}
