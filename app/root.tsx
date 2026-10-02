// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import {
	Button,
	Empty,
	LinkProvider,
	Loader,
	Toasty,
	TooltipProvider,
} from "@cloudflare/kumo";
import { TriangleAlert } from "lucide-react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { forwardRef, useEffect, useState } from "react";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Link as RouterLink,
	Scripts,
	ScrollRestoration,
} from "react-router";
import { ApiError } from "~/services/api";
import api from "~/services/api";
import { Navigate, useLocation } from "react-router";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}
const KumoLink = forwardRef<
	HTMLAnchorElement,
	React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
>(function KumoLink({ href, ...props }, ref) {
	if (href && !href.startsWith("http")) {
		return (
			<RouterLink to={href} ref={ref} {...(props as Record<string, unknown>)} />
		);
	}
	return <a href={href} ref={ref} {...props} />;
});

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" data-theme="porcelain" data-mode="light">
			<head>
				<script dangerouslySetInnerHTML={{
					__html: [
						"window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};",
						"window.$RefreshReg$ = () => {};",
						"window.$RefreshSig$ = () => (type) => type;",
						"window.__vite_plugin_react_preamble_installed__ = true;",
						"window.RefreshRuntime = {",
						"  injectIntoGlobalHook: () => {},",
						"  createOverlay: () => ({ show() {}, hide() {} }),",
						"  performReactRefresh: () => Promise.resolve(),",
						"};",
						"console.log('[Polyfill] $RefreshSig$ set to:', typeof window.$RefreshSig$);",
					].join("\n"),
				}} />
				<meta charSet="UTF-8" />
				{/* Theme boot: allow ?theme=<kumo|midnight|porcelain|sakura>&mode=<light|dark>
				    to override the default theme before first paint. */}
				<script
					dangerouslySetInnerHTML={{
						__html: `(function(){try{var p=new URLSearchParams(location.search);var t=p.get("theme"),m=p.get("mode");if(t)document.documentElement.setAttribute("data-theme",t);if(m)document.documentElement.setAttribute("data-mode",m);}catch(e){}})();`,
					}}
				/>
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<link
					rel="icon"
					type="image/x-icon"
					href="/favicon.ico"
					sizes="48x48 32x32 16x16"
				/>
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Mailboxes</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-kumo-recessed text-kumo-default antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div className="flex items-center justify-center h-screen">
			<Loader size="lg" />
		</div>
	);
}

// ── Auth gate ──────────────────────────────────────────────────
// Checks the admin session once on mount. Unauthenticated visitors are
// redirected to /login; authenticated visitors on /login are sent home.
// Logout / login use a full page reload (window.location), so the gate
// always re-runs when auth state changes.
function AuthGate({ children }: { children: React.ReactNode }) {
	const location = useLocation();
	const [status, setStatus] = useState<
		"loading" | "authed" | "unauthed" | "setup"
	>("loading");

	useEffect(() => {
		let cancelled = false;
		api.auth
			.me()
			.then(() => {
				if (!cancelled) setStatus("authed");
			})
			.catch(async () => {
				// Not signed in. A fresh deployment has no admin account yet, in
				// which case the setup wizard is the only reachable page.
				try {
					const { initialized } = await api.adminStatus();
					if (!cancelled) setStatus(initialized ? "unauthed" : "setup");
				} catch {
					if (!cancelled) setStatus("unauthed");
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const isLoginPage = location.pathname === "/login";
	const isSetupPage = location.pathname === "/setup";

	if (status === "loading") {
		return (
			<div className="flex h-screen items-center justify-center bg-kumo-recessed">
				<Loader size="lg" />
			</div>
		);
	}
	// Uninitialised deployment: force the first-run setup wizard.
	if (status === "setup") {
		return isSetupPage ? children : <Navigate to="/setup" replace />;
	}
	if (status === "authed") {
		return isLoginPage || isSetupPage ? <Navigate to="/" replace /> : children;
	}
	return isLoginPage ? children : <Navigate to="/login" replace />;
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<LinkProvider component={KumoLink}>
				<TooltipProvider>
					<Toasty>
						<AuthGate>
							<Outlet />
						</AuthGate>
					</Toasty>
				</TooltipProvider>
			</LinkProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title = "Something went wrong";
	let description = "An unexpected error occurred. Please try again.";
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = "Page not found";
			description =
				"The page you're looking for doesn't exist or has been moved.";
		} else {
			title = `Error ${error.status}`;
			description = error.statusText || description;
		}
	} else if (error instanceof Error && import.meta.env.DEV) {
		description = error.message;
	}

	return (
		<div className="flex items-center justify-center min-h-screen p-8">
			<Empty
				icon={<TriangleAlert size={48} className="text-kumo-inactive" />}
				title={status === 404 ? "404 — Page not found" : title}
				description={description}
				contents={
					<Button
						variant="primary"
						onClick={() => {
							window.location.href = "/";
						}}
					>
						Go Home
					</Button>
				}
			/>
		</div>
	);
}
