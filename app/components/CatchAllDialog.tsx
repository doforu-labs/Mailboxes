// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import {
	Button,
	Dialog,
	Input,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSetCatchAll } from "~/queries/domains";
import type { Domain } from "~/types";

interface CatchAllDialogProps {
	domain: Domain | null;
	open: boolean;
	onClose: () => void;
}

export function CatchAllDialog({ domain, open, onClose }: CatchAllDialogProps) {
	const toastManager = useKumoToastManager();
	const { t } = useTranslation("domain");
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
					title: t("toastCatchAllInputInvalid", { domain: domain.name }),
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
					? t("toastCatchAllSet", { mailbox: catchAllMailbox })
					: t("toastCatchAllDisabled"),
			});
			onClose();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : t("failedToUpdateCatchAll");
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
					{t("catchAllMailboxTitle")}
				</Dialog.Title>
				<p className="text-sm text-kumo-subtle mb-5">
					{t("catchAllDescriptionPrefix")}{' '}
					<strong className="text-kumo-default">{domain.name}</strong>{' '}
					{t("catchAllDescriptionSuffix")}
				</p>

				<div className="space-y-4">
					<div>
						<label className="block text-sm font-medium text-kumo-default mb-1.5">
							{domain.catch_all_mailbox
								? t("catchAllLabel", { mailbox: domain.catch_all_mailbox })
								: t("catchAllDisabledLabel")}
						</label>
						<Input
							placeholder={t("catchAllPlaceholder", { domain: domain.name })}
							size="sm"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							autoFocus
						/>
						<p className="text-xs text-kumo-subtle mt-1.5">
							{t("catchAllInputHintPrefix")}{" "}
							<code className="font-mono">{`*@${domain.name}`}</code>{" "}
							{t("catchAllInputHintSuffix")}
						</p>
					</div>
					<div className="flex justify-end gap-2 pt-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									{t("common:cancel")}
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
							{t("common:save")}
						</Button>
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
