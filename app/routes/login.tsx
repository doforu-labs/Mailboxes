// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

import { Button, Input, Loader, Text } from "@cloudflare/kumo";
import { Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import api, { ApiError } from "~/services/api";

export function meta() {
	return [{ title: "Sign in · Mailboxes" }];
}

export default function LoginRoute() {
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
					: "Sign in failed. Please try again.",
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
						<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kumo-fill text-kumo-default">
							<Mail size={24} />
						</div>
						<div className="text-center">
							<h1 className="m-0 text-xl font-bold text-kumo-default">
								Mailboxes
							</h1>
							<p className="mt-1 text-sm text-kumo-subtle">
								Sign in to manage your mailboxes
							</p>
						</div>
					</div>

					<form onSubmit={handleSubmit} className="grid gap-4">
						<Input
							label="Username"
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							required
							autoFocus
						/>
						<Input
							label="Password"
							type="password"
							placeholder="••••••••"
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
									<Loader size="sm" /> Signing in…
								</span>
							) : (
								"Sign in"
							)}
						</Button>
					</form>
				</div>

				<p className="mt-4 text-center text-xs text-kumo-subtle">
					Self-hosted email client · Cloudflare Workers
				</p>
			</div>
		</div>
	);
}
