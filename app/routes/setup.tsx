// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader, Text } from "@cloudflare/kumo";
import { Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import api from "~/services/api";

export function meta() {
	return [{ title: "Set up · Mailboxes" }];
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
			setError("Username is required.");
			return;
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
			return;
		}
		if (password !== confirm) {
			setError("Passwords do not match.");
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
					: "Setup failed. Please try again.",
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
								Create your admin account
							</h1>
							<p className="mt-1 text-sm text-kumo-subtle">
								This is the only account on this deployment.
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
							placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
							autoComplete="new-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
						<Input
							label="Confirm password"
							type="password"
							placeholder="••••••••"
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
									<Loader size="sm" /> Creating…
								</span>
							) : (
								"Create admin account"
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
