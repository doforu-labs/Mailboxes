// Copyright (c) 2026 Doforu
// Licensed under the AGPL-3.0-only (see LICENSE).

import { useTranslation } from "react-i18next";
import { formatSenderWithAddress } from "shared/participants";

interface MessageAddressLinesProps {
	senderName?: string | null;
	sender?: string | null;
	recipient?: string | null;
}

/**
 * The "From:" / "To:" lines under an expanded message header.
 *
 * Both the single-message view and the thread view render the same pair; this
 * is the single place so a sender can never be shown without its label (which
 * is exactly what made the sender look like it was not rendered at all).
 * Returns null when the message has neither a sender nor a recipient.
 */
export default function MessageAddressLines({
	senderName,
	sender,
	recipient,
}: MessageAddressLinesProps) {
	const { t } = useTranslation("mailPanel");
	const from = formatSenderWithAddress(senderName, sender);
	if (!from && !recipient) return null;
	return (
		<>
			{from && (
				<div className="text-xs text-kumo-subtle">
					{t("message.fromLabel", { email: from })}
				</div>
			)}
			{recipient && (
				<div className="text-xs text-kumo-subtle">
					{t("message.toLabel", { email: recipient })}
				</div>
			)}
		</>
	);
}
