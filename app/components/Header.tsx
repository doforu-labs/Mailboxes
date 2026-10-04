// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

// [i18n-foundation] LanguageSwitcher mounted here; preserve on text extraction
import { Button, Input, Tooltip } from "@cloudflare/kumo";
import { Settings, List, Search, Sparkles, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import LanguageSwitcher from "~/components/LanguageSwitcher";

export default function Header() {
	const { t } = useTranslation("layout");
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchExpanded, setIsSearchExpanded] = useState(false);
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams] = useSearchParams();
	const { toggleSidebar, toggleAiPanel } = useUIStore();

	// Sync search input with URL query param so it stays populated
	const urlQuery = searchParams.get("q") || "";
	useEffect(() => {
		if (location.pathname.includes("/search") && urlQuery) {
			setSearchQuery(urlQuery);
		}
	}, [urlQuery, location.pathname]);

	const performSearch = () => {
		if (mailboxId && searchQuery.trim()) {
			const q = searchQuery.trim();
			navigate(`/mailbox/${mailboxId}/search?q=${encodeURIComponent(q)}`);
			setIsSearchExpanded(false);
		}
	};

	const clearSearch = () => {
		setSearchQuery("");
		if (location.pathname.includes("/search") && mailboxId) {
			navigate(`/mailbox/${mailboxId}/emails/inbox`);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			performSearch();
		}
		if (e.key === "Escape") {
			if (searchQuery) {
				clearSearch();
			} else {
				setIsSearchExpanded(false);
			}
		}
	};

	const isSettingsActive = location.pathname.includes("/settings");

	return (
		<header className="flex items-center gap-2 px-3 py-2.5 bg-kumo-base border-b border-kumo-line sticky top-0 z-10 md:px-5 md:gap-4">
			{/* Hamburger menu - mobile only */}
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<List size={20} />}
				onClick={toggleSidebar}
				aria-label={t("header.toggleSidebar")}
				className="md:hidden shrink-0"
			/>

			{/* Search - full on desktop, collapsible on mobile */}
			<div
				className={`flex-1 max-w-lg transition-all flex items-center gap-1 ${
					isSearchExpanded ? "flex" : "hidden md:flex"
				}`}
			>
				<div className="flex-1 relative flex items-center">
					<Input
						className="w-full"
						aria-label={t("header.searchEmailsLabel")}
						placeholder={t("header.searchEmailsPlaceholder")}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={clearSearch}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint transition-colors"
							aria-label={t("header.clearSearch")}
						>
							<X size={14} />
						</button>
					)}
				</div>
				<Tooltip content={t("header.search")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<Search size={20} />}
						onClick={performSearch}
						aria-label={t("header.search")}
					/>
				</Tooltip>
			</div>

			{/* Search toggle button - mobile only, hidden when search is expanded */}
			{!isSearchExpanded && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<Search size={20} />}
					onClick={() => setIsSearchExpanded(true)}
					aria-label={t("header.search")}
					className="md:hidden shrink-0"
				/>
			)}

			{/* Close search button - mobile only, visible when search is expanded */}
			{isSearchExpanded && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<X size={20} />}
					onClick={() => setIsSearchExpanded(false)}
					aria-label={t("header.closeSearch")}
					className="md:hidden shrink-0"
				/>
			)}

			<div className="flex items-center gap-1 ml-auto shrink-0">
				{/* [i18n-foundation] LanguageSwitcher mounted here; preserve on text extraction */}
				<LanguageSwitcher />
				<Tooltip content={t("header.aiAssistant")} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						icon={<Sparkles size={20} />}
						onClick={toggleAiPanel}
						aria-label={t("header.aiAssistant")}
					/>
				</Tooltip>
				<Tooltip content={t("common:settings")} side="bottom" asChild>
					<Button
						variant={isSettingsActive ? "secondary" : "ghost"}
						shape="square"
						icon={<Settings size={20} />}
						onClick={() =>
							navigate(
								isSettingsActive
									? `/mailbox/${mailboxId}/emails/inbox`
									: `/mailbox/${mailboxId}/settings`,
							)
						}
						aria-label={t("common:settings")}
					/>
				</Tooltip>
			</div>
		</header>
	);
}
