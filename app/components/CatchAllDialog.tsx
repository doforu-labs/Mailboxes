// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Input,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { useState } from "react";
import { useSetCatchAll } from "~/queries/domains";
import type { Domain } from "~/types";

interface CatchAllDialogProps {
	domain: Domain | null;
	open: boolean;
	onClose: () => void;
}

export function CatchAllDialog({ domain, open, onClose }: CatchAllDialogProps) {
	const toastManager = useKumoToastManager();
	const setCatchAll = useSetCatchAll();

	const [inputValue, setInputValue] = useState<string>(
		domain?.catch_all_mailbox ? `*@${domain.name}` : "",
	);
	const [isSaving, setIsSaving] = useState(false);

	const handleSave = async () => {
		if (!domain) return;
		setIsSaving(true);
		try {
			const value = inputValue.trim();
			let catchAllMailbox: string | null;

			if (!value) {
				// Empty field -> disable catch-all
				catchAllMailbox = null;
			} else if (value === `*@${domain.name}`) {
				// Simplified input -> pass as-is, backend will auto-create
				catchAllMailbox = value;
			} else {
				toastManager.add({
					title: `Please enter *@${domain.name} to enable catch-all`,
					variant: "error",
				});
				return;
			}

			await setCatchAll.mutateAsync({
				domainId: domain.id,
				catchAllMailbox,
			});
			toastManager.add({
				title: catchAllMailbox
					? `Catch-all set to ${catchAllMailbox}`
					: "Catch-all disabled",
			});
			onClose();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to update catch-all";
			toastManager.add({ title: msg, variant: "error" });
		} finally {
			setIsSaving(false);
		}
	};

	if (!domain) return null;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold mb-1">
					Catch-all Mailbox
				</Dialog.Title>
				<p className="text-sm text-kumo-subtle mb-5">
					When an email arrives for a non-existent address on{' '}
					<strong className="text-kumo-default">{domain.name}</strong>,{' '}
					it will be delivered to the catch-all mailbox instead of being dropped.
				</p>

				<div className="space-y-4">
					<div>
						<label className="block text-sm font-medium text-kumo-default mb-1.5">
							{domain.catch_all_mailbox
								? `Catch-all: ${domain.catch_all_mailbox}`
								: "Catch-all: disabled"}
						</label>
						<Input
							placeholder={`*@${domain.name}`}
							size="sm"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							autoFocus
						/>
						<p className="text-xs text-kumo-subtle mt-1.5">
							Enter <code className="font-mono">*@{domain.name}</code> to enable catch-all routing.{' '}
							Clear the field to disable.
						</p>
					</div>
					<div className="flex justify-end gap-2 pt-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="primary"
							size="sm"
							loading={isSaving}
							disabled={isSaving}
							onClick={handleSave}
						>
							Save
						</Button>
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
