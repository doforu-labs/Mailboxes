// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

import { Button, Input, Loader, Text } from "@cloudflare/kumo";
import { type FormEvent, useState } from "react";
import { type MetaArgs } from "react-router";
import { useTranslation } from "react-i18next";
import { isLocale } from "shared/i18n/config";
import { translate } from "shared/i18n/translate";
import api, { ApiError } from "~/services/api";

export function meta({ matches }: MetaArgs) {
	const rootData = matches.find((m) => m?.id === "root")?.data as
		| { locale?: string }
		| undefined;
	const locale = isLocale(rootData?.locale) ? rootData.locale : "en";
	return [{ title: translate(locale, "auth:loginMetaTitle") }];
}

export default function LoginRoute() {
	const { t } = useTranslation("auth");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (isSubmitting) return;
		setError(null);
		setIsSubmitting(true);
		try {
			await api.auth.login(username.trim(), password);
			// Full reload so the root auth guard picks up the new session.
			window.location.href = "/";
		} catch (err) {
			// Fresh deployment with no admin account yet — send them to the wizard.
			if (err instanceof ApiError && err.status === 409) {
				window.location.href = "/setup";
				return;
			}
			setError(
				err instanceof Error && err.message
					? err.message
					: t("loginError"),
			);
			setIsSubmitting(false);
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-kumo-recessed px-4">
			<div className="w-full max-w-sm">
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-8 shadow-sm">
					{/* Brand */}
					<div className="mb-6 flex flex-col items-center gap-3">
						<img
							src="/logo.png"
							alt={t("loginBrandTitle")}
							width={48}
							height={48}
							className="brand-logo-light h-12 w-12 rounded-xl"
						/>
						<img
							src="/logo-dark.png"
							alt=""
							aria-hidden="true"
							width={48}
							height={48}
							className="brand-logo-dark h-12 w-12 rounded-xl"
						/>
						<div className="text-center">
							<h1 className="m-0 text-xl font-bold text-kumo-default">
								{t("loginBrandTitle")}
							</h1>
							<p className="mt-1 text-sm text-kumo-subtle">
								{t("loginSubtitle")}
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
							placeholder={t("passwordPlaceholder")}
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
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
									<Loader size="sm" /> {t("signingIn")}
								</span>
							) : (
								t("common:signIn")
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
