// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

import { Button, Input, Loader, Text } from "@cloudflare/kumo";
import { Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { type MetaArgs } from "react-router";
import { useTranslation } from "react-i18next";
import { isLocale } from "shared/i18n/config";
import { translate } from "shared/i18n/translate";
import api from "~/services/api";

export function meta({ matches }: MetaArgs) {
	const rootData = matches.find((m) => m?.id === "root")?.data as
		| { locale?: string }
		| undefined;
	const locale = isLocale(rootData?.locale) ? rootData.locale : "en";
	return [{ title: translate(locale, "auth:setupMetaTitle") }];
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * First-run setup wizard.
 *
 * Only reachable while the `admins` table is empty — the root auth gate
 * redirects here, and the server rejects the request with 409 once an admin
 * account exists.
 */
export default function SetupRoute() {
	const { t } = useTranslation("auth");
	const [username, setUsername] = useState("admin");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (isSubmitting) return;
		setError(null);

		if (!username.trim()) {
			setError(t("setupUsernameRequired"));
			return;
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			setError(t("setupPasswordTooShort", { n: MIN_PASSWORD_LENGTH }));
			return;
		}
		if (password !== confirm) {
			setError(t("setupPasswordMismatch"));
			return;
		}

		setIsSubmitting(true);
		try {
			await api.createAdmin({
				username: username.trim(),
				password,
			});
			// Full reload so the root auth guard picks up the new session.
			window.location.href = "/";
		} catch (err) {
			setError(
				err instanceof Error && err.message
					? err.message
					: t("setupError"),
			);
			setIsSubmitting(false);
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-kumo-recessed px-4 py-10">
			<div className="w-full max-w-sm">
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-8 shadow-sm">
					{/* Brand */}
					<div className="mb-6 flex flex-col items-center gap-3">
						<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kumo-fill text-kumo-default">
							<Mail size={24} />
						</div>
						<div className="text-center">
							<h1 className="m-0 text-xl font-bold text-kumo-default">
								{t("setupTitle")}
							</h1>
							<p className="mt-1 text-sm text-kumo-subtle">
								{t("setupSubtitle")}
							</p>
						</div>
					</div>

					<form onSubmit={handleSubmit} className="grid gap-4">
						<Input
							label={t("username")}
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							required
							autoFocus
						/>
						<Input
							label={t("password")}
							type="password"
							placeholder={t("setupPasswordPlaceholder", { n: MIN_PASSWORD_LENGTH })}
							autoComplete="new-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
						<Input
							label={t("confirmPassword")}
							type="password"
							placeholder={t("passwordPlaceholder")}
							autoComplete="new-password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
							required
						/>

						{error && (
							<Text variant="error" size="sm">
								{error}
							</Text>
						)}

						<Button
							type="submit"
							variant="primary"
							className="mt-1 w-full"
							disabled={isSubmitting}
						>
							{isSubmitting ? (
								<span className="inline-flex items-center gap-2">
									<Loader size="sm" /> {t("creating")}
								</span>
							) : (
								t("createAdminAccount")
							)}
						</Button>
					</form>
				</div>

				<p className="mt-4 text-center text-xs text-kumo-subtle">
					{t("footer")}
				</p>
			</div>
		</div>
	);
}
