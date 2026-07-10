// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
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
	return useMutation({
		mutationFn: (data: { name: string; resendApiKey?: string }) => api.domains.create(data),
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
