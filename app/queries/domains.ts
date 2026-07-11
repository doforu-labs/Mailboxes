// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type CreateDomainResponse, type DnsRecord } from "~/services/api";
import type { Domain } from "~/types";
import { queryKeys } from "./keys";

export function useDomains() {
	return useQuery<Domain[]>({
		queryKey: queryKeys.domains.all,
		queryFn: () => api.domains.list() as Promise<Domain[]>,
	});
}

export function useCreateDomain() {
	const qc = useQueryClient();
	return useMutation<CreateDomainResponse, Error, { domain: string; resendApiKey?: string }>({
		mutationFn: (data) => api.domains.create(data) as Promise<CreateDomainResponse>,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.domains.all });
		},
	});
}

export function useDeleteDomain() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.domains.delete(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.domains.all });
		},
	});
}

export function useSetCatchAll() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ domainId, catchAllMailbox }: { domainId: string; catchAllMailbox: string | null }) =>
			api.domains.setCatchAll(domainId, catchAllMailbox),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.domains.all });
		},
	});
}

export function useUpdateDomainApiKey() {
	const qc = useQueryClient();
	return useMutation<Domain, Error, { domainId: string; apiKey: string }>({
		mutationFn: ({ domainId, apiKey }) =>
			api.domains.updateApiKey(domainId, apiKey) as Promise<Domain>,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.domains.all });
		},
	});
}
