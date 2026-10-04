// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Button, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Reply,
	Forward,
	ArrowLeft,
	ReplyAll,
	Code,
	MailOpen,
	Mail,
	Folder as FolderIcon,
	Send,
	Pencil,
	Star,
	Trash2,
	X,
} from "lucide-react";
import type { Folder, Email } from "~/types";

interface EmailPanelToolbarProps {
	email: Email;
	mailboxId?: string;
	isDraftFolder: boolean;
	isSending: boolean;
	moveToFolders: Folder[];
	lastReceivedMessage?: Email;
	onBack: () => void;
	onSendDraft: () => void;
	onEditDraft: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onMove: (folderId: string) => void;
	onViewSource: () => void;
	onDelete: () => void;
}

export default function EmailPanelToolbar({
	email,
	mailboxId,
	isDraftFolder,
	isSending,
	moveToFolders,
	onBack,
	onSendDraft,
	onEditDraft,
	onReply,
	onReplyAll,
	onForward,
	onToggleStar,
	onToggleRead,
	onMove,
	onViewSource,
	onDelete,
}: EmailPanelToolbarProps) {
	const { t } = useTranslation("editor");
	return (
		<div className="flex items-center gap-1 px-3 py-2 border-b border-kumo-line shrink-0 md:px-4">
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ArrowLeft size={18} />}
				onClick={onBack}
				aria-label={t("backToList")}
				className="md:hidden shrink-0"
			/>

			{isDraftFolder ? (
				<>
					<Button
						variant="primary"
						size="sm"
						icon={<Send size={16} />}
						onClick={onSendDraft}
						loading={isSending}
					>
						{isSending ? t("common:sending") : t("common:send")}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						icon={<Pencil size={16} />}
						onClick={onEditDraft}
					>
						{t("edit")}
					</Button>
				</>
			) : (
				<>
					<Tooltip content={t("reply")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<Reply size={18} />}
							onClick={onReply}
							aria-label={t("reply")}
						/>
					</Tooltip>
					<Tooltip content={t("replyAll")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ReplyAll size={18} />}
							onClick={onReplyAll}
							aria-label={t("replyAll")}
						/>
					</Tooltip>
					<Tooltip content={t("forward")} side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<Forward size={18} />}
							onClick={onForward}
							aria-label={t("forward")}
						/>
					</Tooltip>
				</>
			)}

			<div className="h-5 w-px bg-kumo-fill mx-0.5" />

			<Tooltip content={email.starred ? t("unstar") : t("star")} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={
						<Star
							size={18}
							fill={email.starred ? "currentColor" : "none"}
							className={email.starred ? "text-kumo-starred" : ""}
						/>
					}
					onClick={onToggleStar}
					aria-label={email.starred ? t("unstar") : t("star")}
				/>
			</Tooltip>

			<Tooltip content={email.read ? t("markAsUnread") : t("markAsRead")} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={email.read ? <Mail size={18} /> : <MailOpen size={18} />}
					onClick={onToggleRead}
					aria-label={email.read ? t("markAsUnread") : t("markAsRead")}
				/>
			</Tooltip>

			<MoveToFolderMenu folders={moveToFolders} onMove={onMove} />

			<div className="ml-auto flex items-center gap-0.5">
				<Tooltip content={t("viewSource")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<Code size={18} />}
						onClick={onViewSource}
						aria-label={t("viewSource")}
					/>
				</Tooltip>
				<Tooltip content={t("common:delete")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<Trash2 size={18} />}
						onClick={onDelete}
						aria-label={t("common:delete")}
					/>
				</Tooltip>
				<Tooltip content={t("common:close")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<X size={18} />}
						onClick={onBack}
						aria-label={t("common:close")}
						className="hidden md:inline-flex"
					/>
				</Tooltip>
			</div>
		</div>
	);
}

function MoveToFolderMenu({ folders, onMove }: { folders: Folder[]; onMove: (id: string) => void }) {
	const { t } = useTranslation("editor");
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<Tooltip content={t("moveToFolder")} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<FolderIcon size={18} />}
					onClick={() => setOpen((o) => !o)}
					aria-label={t("moveToFolder")}
				/>
			</Tooltip>
			{open && (
				<div className="absolute top-full left-0 z-50 mt-1 min-w-[160px] rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg py-1">
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">{t("moveTo")}</div>
					<div className="h-px bg-kumo-line my-1" />
					{folders.map((f) => (
						<button
							key={f.id}
							type="button"
							className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors"
							onClick={() => { onMove(f.id); setOpen(false); }}
						>
							{f.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
