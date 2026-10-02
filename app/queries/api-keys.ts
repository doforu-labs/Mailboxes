// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

export function useApiKeys(domainId: string) {
	return useQuery({
		queryKey: ["api-keys", domainId],
		queryFn: () => api.domainApiKeys.list(domainId),
		enabled: !!domainId,
	});
}

export function useCreateApiKey(domainId: string) {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: ({ name, scopes }: { name?: string; scopes?: string }) =>
			api.domainApiKeys.create(domainId, name, scopes),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["api-keys", domainId] });
		},
	});
}

export function useRevokeApiKey(domainId: string) {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: (keyId: string) => api.domainApiKeys.revoke(domainId, keyId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["api-keys", domainId] });
		},
	});
}
