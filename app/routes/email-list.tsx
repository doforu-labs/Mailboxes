// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import { Button, Dialog, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	Archive,
	Reply,
	RefreshCw,
	MailOpen,
	Mail,
	File,
	Send,
	Pencil,
	Star,
	Trash2,
	Inbox,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { Folders, getFolderDisplayName } from "shared/folders";
import type { Locale } from "shared/i18n/types";
import { formatParticipantLabel } from "shared/participants";
import { formatListDate } from "shared/dates";
import MailboxSplitView from "~/components/MailboxSplitView";
import { getSnippetText } from "~/lib/utils";
import {
	useDeleteEmail,
	useEmails,
	useMarkThreadRead,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		titleKey: string;
		descriptionKey: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <Inbox size={48} className="text-kumo-subtle" />,
		titleKey: "emptyInboxTitle",
		descriptionKey: "emptyInboxDescription",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<Send size={48} className="text-kumo-subtle" />
		),
		titleKey: "emptySentTitle",
		descriptionKey: "emptySentDescription",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <File size={48} className="text-kumo-subtle" />,
		titleKey: "emptyDraftTitle",
		descriptionKey: "emptyDraftDescription",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <Archive size={48} className="text-kumo-subtle" />,
		titleKey: "emptyArchiveTitle",
		descriptionKey: "emptyArchiveDescription",
	},
	[Folders.TRASH]: {
		icon: <Trash2 size={48} className="text-kumo-subtle" />,
		titleKey: "emptyTrashTitle",
		descriptionKey: "emptyTrashDescription",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const { t } = useTranslation("mail");
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<Mail size={48} className="text-kumo-subtle" />
		),
		titleKey: "emptyGenericTitle",
		descriptionKey: "emptyGenericDescription",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{t(config.titleKey)}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{t(config.descriptionKey)}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<Pencil size={16} />}
					onClick={onCompose}
				>
					{t("compose")}
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { t, i18n } = useTranslation("mail");
	const locale = i18n.language as Locale;
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, page],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? getFolderDisplayName(folder, locale) : getFolderDisplayName(Folders.INBOX, locale);
	}, [folders, folder, locale]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
		}
	}, [mailboxId, folder, closePanel]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setPendingDeleteId(emailId);
		setDeleteConfirmOpen(true);
	};

	const confirmDelete = () => {
		if (mailboxId && pendingDeleteId) {
			deleteEmail.mutate({ mailboxId, id: pendingDeleteId });
			if (selectedEmailId === pendingDeleteId) closePanel();
		}
		setDeleteConfirmOpen(false);
		setPendingDeleteId(null);
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	// Prefer the From display name (e.g. "GitHub") over the address local-part
	// (e.g. "noreply"), matching the behaviour of mainstream mail clients.
	const formatParticipants = (email: Email): string =>
		formatParticipantLabel(email.participants_meta, {
			name: email.sender_name,
			address: email.sender,
		});

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className="flex items-center justify-between px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<h1 className="text-lg font-semibold text-kumo-default">
						{folderName}
					</h1>
					<div className="flex items-center gap-1">
						{totalCount > 0 && (
							<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
								{t("conversations", { count: totalCount })}
							</span>
						)}
						<Tooltip
							content={isRefreshing ? t("refreshing") : t("refresh")}
							side="bottom"
							asChild
						>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={
									<RefreshCw
										size={16}
										className={isRefreshing ? "animate-spin" : ""}
									/>
								}
								onClick={handleRefresh}
								disabled={isRefreshing}
								aria-label={t("refresh")}
							/>
						</Tooltip>
					</div>
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const snippet = getSnippetText(email.snippet);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<Star
												size={14}
												fill={email.starred ? "currentColor" : "none"}
												className={
													email.starred
														? "text-kumo-starred"
														: "text-kumo-subtle hover:text-kumo-starred"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														{t("draft")}
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content={t("needsReply")} asChild>
														<span className="shrink-0 text-kumo-warning">
															<Reply size={14} />
														</span>
													</Tooltip>
												)}
												{folder === Folders.SENT && email.send_status === "sending" && (
													<span className="shrink-0 text-xs text-blue-500 font-medium animate-pulse">
														{t("sending")}
												</span>
												)}
												{folder === Folders.SENT && email.send_status === "sent" && (
													<span className="shrink-0 text-xs text-green-600 font-medium">
														{t("sent")}
													</span>
												)}
												{folder === Folders.SENT && email.send_status === "failed" && (
													<Tooltip content={t("deliveryFailed")} asChild>
														<span className="shrink-0 text-xs text-kumo-destructive font-medium">
															{t("failed")}
														</span>
													</Tooltip>
												)}
											</div>
											<div className="truncate text-sm mt-0.5">
													<span
														className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
													>
														{email.subject}
													</span>
													{snippet && (
														<span className="text-kumo-subtle font-normal">
															{" "}&mdash; {snippet}
														</span>
													)}
										</div>
									</div>

										<span className="shrink-0 text-sm text-kumo-subtle ml-2 whitespace-nowrap self-center">
											{formatListDate(email.date, locale)}
										</span>

										{/* Hover actions */}
										<div className="hidden group-hover:flex items-center shrink-0">
											<Tooltip content={email.read ? t("markUnread") : t("markRead")} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <Mail size={16} /> : <MailOpen size={16} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? t("markUnread") : t("markRead")}
												/>
											</Tooltip>
											<Tooltip content={t("delete")} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<Trash2 size={16} />}
													onClick={(e) => handleDelete(e, email.id)}
													aria-label={t("delete")}
												/>
											</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Delete confirmation dialog */}
				<Dialog.Root
					open={deleteConfirmOpen}
					onOpenChange={(isOpen) => {
						if (!isOpen) {
							setDeleteConfirmOpen(false);
							setPendingDeleteId(null);
						}
					}}
				>
					<Dialog size="sm" className="p-6">
						<Dialog.Title className="text-base font-semibold mb-1">
							{t("deleteEmailTitle")}
						</Dialog.Title>
						<p className="text-sm text-kumo-subtle mb-5">
							{t("deleteEmailDescription")}
						</p>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										{t("common:cancel")}
								</Button>
								)}
							/>
							<Button
								variant="destructive"
								size="sm"
								onClick={confirmDelete}
							>
								{t("delete")}
							</Button>
						</div>
					</Dialog>
				</Dialog.Root>

			{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}
		</MailboxSplitView>
	);
}
