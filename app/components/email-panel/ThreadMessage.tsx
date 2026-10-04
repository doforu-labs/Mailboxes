// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import {
	ChevronDown,
	ChevronUp,
	Code,
	Send,
	Pencil,
	Trash2,
} from "lucide-react";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import { useTranslation } from "react-i18next";
import { formatSenderFull } from "shared/participants";
import { isLocale } from "shared/i18n/config";
import {
	formatDetailDate,
	formatShortDate,
	rewriteInlineImages,
	stripHtml,
} from "~/lib/utils";
import type { Email } from "~/types";

interface ThreadMessageProps {
	email: Email;
	mailboxId?: string;
	mailboxEmail?: string;
	isLast: boolean;
	isDraft?: boolean;
	isSending?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	onDeleteDraft?: () => void;
	onViewSource?: () => void;
	onPreviewImage?: (url: string, filename: string) => void;
}

function Avatar({ isDraft, isSelf, sender }: { isDraft?: boolean; isSelf: boolean; sender: string }) {
	return (
		<div
			className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
				isDraft
					? "bg-kumo-fill text-kumo-subtle"
					: isSelf
						? "bg-kumo-brand text-kumo-inverse"
						: "bg-kumo-fill text-kumo-default"
			}`}
		>
			{isDraft ? "D" : sender.charAt(0).toUpperCase()}
		</div>
	);
}

export default function ThreadMessage({
	email,
	mailboxId,
	mailboxEmail,
	isLast,
	isDraft,
	isSending,
	isExpanded,
	onToggleExpand,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onViewSource,
	onPreviewImage,
}: ThreadMessageProps) {
	const { t, i18n } = useTranslation("mailPanel");
	// Follow the active UI language so timestamps match the rest of the app.
	const locale = isLocale(i18n.language) ? i18n.language : "en";
	const isSelf = email.sender === mailboxEmail;
	const containerClassName = `${!isLast ? "border-b border-kumo-line" : ""} ${isDraft ? "border-l-2 border-l-kumo-warning bg-kumo-warning/[0.02]" : ""}`;
	const senderLabel = isDraft ? t("message.draftReply") : isSelf ? t("message.you") : formatSenderFull(email.sender_name, email.sender);

	if (!isExpanded) {
		return (
			<div className={containerClassName}>
				<button
					type="button"
					onClick={onToggleExpand}
					className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kumo-tint rounded-lg text-left"
				>
					<Avatar isDraft={isDraft} isSelf={isSelf} sender={formatSenderFull(email.sender_name, email.sender)} />
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium text-kumo-default truncate">
								{senderLabel}
							</span>
							<span className="text-xs text-kumo-subtle shrink-0">
								{formatDetailDate(email.date, locale)}
							</span>
						</div>
						<p className="text-xs text-kumo-subtle truncate">
							{stripHtml(email.body || "").slice(0, 80)}
						</p>
					</div>
					<ChevronDown size={14} className="text-kumo-subtle shrink-0" />
				</button>
			</div>
		);
	}

	return (
		<div className={`group/thread-msg ${containerClassName}`}>
			<div className="px-4 py-4 md:px-6">
				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<button
							type="button"
							onClick={onToggleExpand}
							className="shrink-0"
							aria-label={t("message.collapse")}
						>
							<div className="cursor-pointer hover:ring-2 hover:ring-kumo-brand/30 transition-shadow rounded-full">
								<Avatar isDraft={isDraft} isSelf={isSelf} sender={formatSenderFull(email.sender_name, email.sender)} />
							</div>
						</button>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium text-kumo-default truncate">
									{senderLabel}
								</span>
								{isDraft && <Badge variant="outline">{t("message.draftBadge")}</Badge>}
							</div>
							<div className="text-xs text-kumo-subtle">
								{t("message.toLabel", { email: email.recipient })}
							</div>
						</div>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						<span className="text-xs text-kumo-subtle">
							{formatShortDate(email.date, locale)}
						</span>
						{onViewSource && (
							<Tooltip content={t("message.viewSource")} side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<Code size={14} />}
									onClick={onViewSource}
									aria-label={t("message.viewSource")}
									className="transition-opacity !h-6 !w-6"
								/>
							</Tooltip>
						)}
						<button
							type="button"
							onClick={onToggleExpand}
							className="ml-1"
							aria-label={t("message.collapse")}
						>
							<ChevronUp
								size={14}
								className="text-kumo-subtle hover:text-kumo-default transition-colors"
							/>
						</button>
					</div>
				</div>

				<div className="md:ml-[42px]">
					<EmailIframe
						body={rewriteInlineImages(
							email.body || "",
							mailboxId || "",
							email.id,
							email.attachments,
						)}
						autoSize
					/>
				</div>

				{isDraft && (onSendDraft || onEditDraft || onDeleteDraft) && (
					<div className="flex gap-2 mt-3 md:ml-[42px]">
						{onSendDraft && (
							<Button
								variant="primary"
								size="sm"
								icon={<Send size={14} />}
								onClick={onSendDraft}
								loading={isSending}
								disabled={isSending}
							>
								{isSending ? t("message.sending") : t("message.send")}
							</Button>
						)}
						{onEditDraft && (
							<Button
								variant="secondary"
								size="sm"
								icon={<Pencil size={14} />}
								onClick={onEditDraft}
								disabled={isSending}
							>
								{t("message.edit")}
							</Button>
						)}
						{onDeleteDraft && (
							<Button
								variant="ghost"
								size="sm"
								icon={<Trash2 size={14} />}
								onClick={onDeleteDraft}
								disabled={isSending}
							>
								{t("message.discard")}
							</Button>
						)}
					</div>
				)}

				<EmailAttachmentList
					mailboxId={mailboxId}
					emailId={email.id}
					attachments={email.attachments}
					onPreviewImage={onPreviewImage}
					className="mt-3 md:ml-[42px]"
				/>
			</div>
		</div>
	);
}
