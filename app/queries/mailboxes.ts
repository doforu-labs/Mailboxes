// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Distributed here as part of a work licensed under the AGPL-3.0-only (see LICENSE).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Mailbox } from "~/types";
import { queryKeys } from "./keys";

export function useMailboxes() {
	return useQuery<Mailbox[]>({
		queryKey: queryKeys.mailboxes.all,
		queryFn: () => api.listMailboxes() as Promise<Mailbox[]>,
		refetchInterval: 30_000,
	});
}

export function useMailbox(mailboxId: string | undefined) {
	return useQuery<Mailbox>({
		queryKey: mailboxId
			? queryKeys.mailboxes.detail(mailboxId)
			: ["mailboxes", "_disabled"],
		queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
		enabled: !!mailboxId,
	});
}

export function useCreateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name }: { email: string; name: string }) =>
			api.createMailbox(email, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useUpdateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: { mailboxId: string; settings: unknown }) =>
			api.updateMailbox(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useDeleteMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
