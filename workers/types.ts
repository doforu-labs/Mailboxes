// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

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
	RESEND_API_KEY?: string;
	DB: D1Database;
	BUCKET: R2Bucket;
	AI: Ai;
}
