// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * "Agent API Keys" management section for the Settings page.
 *
 * These are the *global* keys an external LLM / MCP client presents to the
 * root-mounted agent gateway (`POST /mcp`, `GET /tools`, `POST /tools/call`)
 * as `Authorization: Bearer <key>`. Unlike the old domain-scoped keys they are
 * not tied to a mailbox or domain, so there is exactly one list for the whole
 * account.
 *
 * Three flows, all backed by the admin endpoints under
 * `/api/v1/agent-api-keys` (session-cookie auth):
 *   1. list    — GET, Name / Prefix / Scopes / Created / Last Used
 *   2. create  — POST { name } → the plaintext key is shown exactly once
 *   3. revoke  — DELETE /:id, behind a confirmation dialog
 */

import {
	Badge,
	Button,
	Dialog,
	Input,
	Loader,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Key,
	Plus,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAgentApiKeys,
	useCreateAgentApiKey,
	useRevokeAgentApiKey,
} from "~/queries/agent-api-keys";
import { ApiError, type AgentApiKeyPublic } from "~/services/api";

/** Mirrors `MAX_NAME_LENGTH` in `workers/routes/agent-api-keys.ts`. */
const MAX_NAME_LENGTH = 64;

/** Keys whose `revoked_at` is set stay in the list but are no longer usable. */
function isRevoked(key: AgentApiKeyPublic): boolean {
	return !!key.revoked_at;
}

/**
 * Best-effort extraction of the backend's localized error message. Returns
 * `undefined` when the failure carried no message, so callers can hand it
 * straight to a toast `description` (which renders nothing for undefined).
 */
function errorMessage(err: unknown): string | undefined {
	if (err instanceof ApiError && typeof err.body.error === "string") {
		return err.body.error;
	}
	return undefined;
}

function formatDate(value: string | null, locale: string): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

// ── Create dialog ───────────────────────────────────────────────

function CreateKeyDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (key: string, prefix: string) => void;
}) {
	const { t } = useTranslation("agentApiKeys");
	const toastManager = useKumoToastManager();
	const createKey = useCreateAgentApiKey();
	const [name, setName] = useState("");

	const trimmed = name.trim();
	const close = () => {
		setName("");
		onOpenChange(false);
	};

	const handleCreate = async () => {
		if (!trimmed) {
			toastManager.add({ title: t("createKeyName"), variant: "error" });
			return;
		}
		try {
			const result = await createKey.mutateAsync({ name: trimmed });
			setName("");
			onOpenChange(false);
			onCreated(result.api_key, result.prefix);
		} catch (err) {
			toastManager.add({
				title: t("createFailed"),
				description: errorMessage(err),
				variant: "error",
			});
		}
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) close();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold text-kumo-default">
					{t("createKeyTitle")}
				</Dialog.Title>
				<div className="flex flex-col gap-4 py-4">
					<Input
						label={t("createKeyName")}
						placeholder={t("createKeyNamePlaceholder")}
						maxLength={MAX_NAME_LENGTH}
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<div>
						<div className="mb-1 text-xs font-medium text-kumo-default">
							{t("createKeyScopes")}
						</div>
						<Badge variant="secondary">all</Badge>
						<div className="mt-1 text-xs text-kumo-subtle">
							{t("createKeyScopeHint")}
						</div>
					</div>
				</div>
				<div className="flex justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={close}
						disabled={createKey.isPending}
					>
						{t("common:cancel")}
					</Button>
					<Button
						variant="primary"
						size="sm"
						onClick={handleCreate}
						disabled={createKey.isPending || !trimmed}
						loading={createKey.isPending}
					>
						{createKey.isPending ? t("createKeyCreating") : t("createKeySubmit")}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── One-time plaintext reveal dialog ────────────────────────────

function RevealKeyDialog({
	created,
	onClose,
}: {
	created: { apiKey: string; prefix: string } | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("agentApiKeys");
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		if (!created) return;
		try {
			await navigator.clipboard.writeText(created.apiKey);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard can be unavailable (insecure context); the key is still
			// selectable in the <code> block below.
		}
	};

	return (
		<Dialog.Root
			open={created !== null}
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold text-kumo-default">
					{t("createdTitle")}
				</Dialog.Title>
				<div className="flex flex-col gap-4 py-4">
					<p className="text-sm text-kumo-default">{t("createdSaveNow")}</p>
					<div className="flex items-center justify-between gap-2 rounded border border-kumo-line bg-kumo-recessed p-3">
						<code className="break-all font-mono text-sm text-kumo-default">
							{created?.apiKey}
						</code>
						<Button
							variant="ghost"
							size="sm"
							onClick={handleCopy}
							aria-label={t("copied")}
						>
							{copied ? (
								<Check size={14} className="text-green-500" />
							) : (
								<Copy size={14} />
							)}
						</Button>
					</div>
					<div className="flex gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm">
						<TriangleAlert size={16} className="mt-0.5 shrink-0 text-red-500" />
						<span className="text-kumo-default">{t("createdWarning")}</span>
					</div>
				</div>
				<div className="flex justify-end">
					<Button variant="primary" size="sm" onClick={onClose}>
						{t("createdDismiss")}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Revoke confirmation dialog ──────────────────────────────────

function RevokeKeyDialog({
	target,
	onClose,
}: {
	target: { id: string; name: string } | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("agentApiKeys");
	const toastManager = useKumoToastManager();
	const revokeKey = useRevokeAgentApiKey();

	const handleRevoke = async () => {
		if (!target) return;
		try {
			await revokeKey.mutateAsync(target.id);
			toastManager.add({ title: t("revokeSuccess") });
			onClose();
		} catch (err) {
			toastManager.add({
				title: t("revokeFailed"),
				description: errorMessage(err),
				variant: "error",
			});
		}
	};

	return (
		<Dialog.Root
			open={target !== null}
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
		>
			<Dialog size="sm" className="p-6">
				<Dialog.Title className="text-base font-semibold text-kumo-default">
					{t("revokeKeyTitle")}
				</Dialog.Title>
				<div className="py-4">
					<div className="flex gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm">
						<TriangleAlert size={16} className="mt-0.5 shrink-0 text-red-500" />
						<span className="text-kumo-default">
							{t("revokeConfirmPrefix")} <strong>“{target?.name}”</strong>
							{t("revokeConfirmSuffix")}
						</span>
					</div>
				</div>
				<div className="flex justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={onClose}
						disabled={revokeKey.isPending}
					>
						{t("common:cancel")}
					</Button>
					<Button
						variant="destructive"
						size="sm"
						onClick={handleRevoke}
						disabled={revokeKey.isPending}
						loading={revokeKey.isPending}
					>
						{revokeKey.isPending ? t("revoking") : t("revokeKey")}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

// ── Section ─────────────────────────────────────────────────────

export function AgentApiKeysSection() {
	const { t, i18n } = useTranslation("agentApiKeys");
	const toastManager = useKumoToastManager();
	const { data: keys = [], isLoading, isError } = useAgentApiKeys();
	const [isExpanded, setIsExpanded] = useState(false);
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [created, setCreated] = useState<{ apiKey: string; prefix: string } | null>(
		null,
	);
	const [revokeTarget, setRevokeTarget] = useState<{
		id: string;
		name: string;
	} | null>(null);

	const activeCount = keys.filter((key) => !isRevoked(key)).length;

	// The list is usually already in cache (the query starts as soon as this
	// section mounts), so an inline error strip reads better than a toast fired
	// from render. It sits in the expanded body only — the collapsed header
	// stays a quiet summary.
	return (
		<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
			{/* Collapsed header */}
			<button
				type="button"
				className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-kumo-fill/50"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-default">
					<Key size={16} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium text-kumo-default">
						{t("title")}
					</div>
					<div className="text-xs text-kumo-subtle">{t("description")}</div>
				</div>
				<Badge variant={activeCount > 0 ? "info" : "secondary"}>
					{t("badgeCount", { count: activeCount })}
				</Badge>
				{isExpanded ? (
					<ChevronDown size={16} className="shrink-0 text-kumo-muted" />
				) : (
					<ChevronRight size={16} className="shrink-0 text-kumo-muted" />
				)}
			</button>

			{/* Expanded content */}
			{isExpanded && (
				<div className="space-y-4 border-t border-kumo-line px-5 py-5">
					<p className="text-xs text-kumo-subtle">{t("expandedDescription")}</p>

					{isError && (
						<div className="flex gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm">
							<TriangleAlert
								size={16}
								className="mt-0.5 shrink-0 text-red-500"
							/>
							<span className="text-kumo-default">{t("loadFailed")}</span>
						</div>
					)}

					{isLoading ? (
						<div className="flex items-center justify-center py-6">
							<Loader size="base" />
						</div>
					) : keys.length === 0 ? (
						<div className="rounded-lg border border-dashed border-kumo-line px-5 py-8 text-center">
							<p className="text-sm text-kumo-subtle">{t("empty")}</p>
						</div>
					) : (
						<div className="overflow-x-auto">
							<div className="min-w-[640px] text-left text-xs font-medium text-kumo-subtle">
								<div className="flex items-center border-b border-kumo-line px-1 py-1.5">
									<div className="w-[180px]">{t("columnName")}</div>
									<div className="w-[140px]">{t("columnPrefix")}</div>
									<div className="w-[80px]">{t("columnScopes")}</div>
									<div className="w-[120px]">{t("columnCreated")}</div>
									<div className="flex-1">{t("columnLastUsed")}</div>
									<div className="w-[60px] text-right">
										{t("columnActions")}
									</div>
								</div>
								{keys.map((key) => {
									const revoked = isRevoked(key);
									const created = formatDate(key.created_at, i18n.language);
									const lastUsed = formatDate(key.last_used_at, i18n.language);
									return (
										<div
											key={key.id}
											className={`flex items-center border-b border-kumo-line px-1 py-2 text-xs ${
												revoked ? "opacity-60" : ""
											}`}
										>
											<div className="flex w-[180px] items-center gap-1.5 truncate pr-2">
												<span className="truncate text-kumo-default">
													{key.name}
												</span>
												{revoked && (
													<Badge variant="secondary">{t("revoked")}</Badge>
												)}
											</div>
											<div className="w-[140px] truncate pr-2 font-mono text-kumo-default">
												{key.prefix}…
											</div>
											<div className="w-[80px]">
												<Badge variant="secondary">{key.scopes}</Badge>
											</div>
											<div className="w-[120px] text-kumo-subtle">
												{created ?? "—"}
											</div>
											<div className="flex-1 text-kumo-subtle">
												{lastUsed ?? t("never")}
											</div>
											<div className="flex w-[60px] justify-end">
												<Button
													variant="ghost"
													size="sm"
													disabled={revoked}
													onClick={() =>
														setRevokeTarget({ id: key.id, name: key.name })
													}
													aria-label={t("revokeKey")}
													title={t("revokeKey")}
													className="text-kumo-subtle hover:text-red-500"
												>
													<Trash2 size={14} />
												</Button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					<div className="flex justify-end">
						<Button
							variant="primary"
							size="sm"
							icon={<Plus size={16} />}
							onClick={() => setIsCreateOpen(true)}
						>
							{t("createKey")}
						</Button>
					</div>
				</div>
			)}

			<CreateKeyDialog
				open={isCreateOpen}
				onOpenChange={setIsCreateOpen}
				onCreated={(apiKey, prefix) => {
					setCreated({ apiKey, prefix });
					toastManager.add({ title: t("createSuccess") });
				}}
			/>
			<RevealKeyDialog created={created} onClose={() => setCreated(null)} />
			<RevokeKeyDialog
				target={revokeTarget}
				onClose={() => setRevokeTarget(null)}
			/>
		</div>
	);
}
