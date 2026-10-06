// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * React Query hooks for the *global* agent API keys.
 *
 * Scope note: these keys authenticate external LLM / MCP clients against the
 * root-mounted gateway (`/mcp`, `/tools`) — they are deliberately NOT
 * mailbox- or domain-scoped, so unlike the old domain key hooks there is no id
 * in the query key. The management endpoints themselves are cookie-auth
 * (`/api/v1/agent-api-keys`), which is exactly the admin surface we want.
 *
 * The plaintext key is returned by `create` exactly once and never cached: the
 * mutation resolves with it and the caller (the reveal dialog) holds it in
 * component state until the user dismisses it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type AgentApiKeyPublic,
	type CreatedAgentApiKey,
} from "~/services/api";
import { queryKeys } from "./keys";

/** List every agent API key, newest first. */
export function useAgentApiKeys() {
	return useQuery<AgentApiKeyPublic[]>({
		queryKey: queryKeys.agentApiKeys.all,
		queryFn: async () => {
			const data = await api.agentApiKeys.list();
			return data.api_keys ?? [];
		},
	});
}

/**
 * Mint a new key. Resolves with `{ id, name, prefix, api_key, message }` —
 * `api_key` is the plaintext secret and will never be readable again.
 */
export function useCreateAgentApiKey() {
	const qc = useQueryClient();
	return useMutation<CreatedAgentApiKey, Error, { name: string }>({
		mutationFn: ({ name }) => api.agentApiKeys.create(name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.agentApiKeys.all });
		},
	});
}

/**
 * Revoke a key (soft delete — the row stays in the list with `revoked_at`
 * stamped). Rejects with an `ApiError` (404) when nothing was revoked.
 */
export function useRevokeAgentApiKey() {
	const qc = useQueryClient();
	return useMutation<{ ok: boolean }, Error, string>({
		mutationFn: (id) => api.agentApiKeys.revoke(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.agentApiKeys.all });
		},
	});
}
