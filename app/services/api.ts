// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

import type { Domain, Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

/**
 * Read a string field (`name` / `message`) off a thrown value.
 *
 * Deliberately does NOT use `instanceof`: a value created in another realm (an
 * iframe, a content script) fails `instanceof` against this realm's
 * constructors even though it is a perfectly ordinary error object. `name` and
 * `message` are readable either way and are all this module needs.
 *
 * Also note the WebIDL subtlety this avoids depending on: whether
 * `DOMException` inherits from `Error` is an implementation detail (it does in
 * current Node and browsers, but nothing here should hinge on that).
 */
function errorField(err: unknown, key: "name" | "message"): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const value = (err as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Human-readable reason for a failed `detectCfDomains` verification call.
 *
 * Verification can fail for causes that need completely different fixes: a
 * token that is invalid or missing a permission, a token whose **Client IP
 * Address Filtering** rejects the caller's IP (the Worker queries the
 * Cloudflare API from Cloudflare's own egress addresses, not from the user's
 * machine, so a filter that allows only the user's IP rejects every Worker
 * call while the very same token works fine from `curl`), an upstream
 * Cloudflare error, a network failure, or our own client timeout.
 *
 * Collapsing all of those into a single "the token or account ID is invalid"
 * hint is actively misleading, so prefer the concrete message the backend
 * produced. `ApiError.body` carries what `workers/setup.ts` forwards from the
 * upstream Cloudflare response: `error` (Cloudflare's own message) plus
 * `cfStatus` / `cfCode` (the upstream HTTP status and Cloudflare error code).
 *
 * @param timeoutMessage   shown when the request was aborted client-side
 * @param fallbackMessage  shown when nothing more specific is available
 */
export function describeCfVerifyError(
	err: unknown,
	timeoutMessage: string,
	fallbackMessage: string,
): string {
	const name = errorField(err, "name");

	// Aborted client-side: the AbortController inside `request()` above
	// ("AbortError"), or a deadline the caller supplied such as
	// `AbortSignal.timeout()` ("TimeoutError"). A `TimeoutError` used to fall
	// through to the fallback, which is why both names are listed here.
	if (name === "AbortError" || name === "TimeoutError") {
		return timeoutMessage;
	}

	if (err instanceof ApiError) {
		const cfStatus = err.body?.cfStatus;
		const cfCode = err.body?.cfCode;
		const detail =
			typeof cfStatus === "number"
				? `HTTP ${cfStatus}${
						typeof cfCode === "number" ? `, code ${cfCode}` : ""
					}`
				: `HTTP ${err.status}`;
		return `${err.message} (${detail})`;
	}

	// Network-layer failures only. Deliberately narrowed to `TypeError`: a 2xx
	// response whose body is not valid JSON makes `request()` throw a
	// `SyntaxError` ("Unexpected token '<' ..."), and that parse detail is
	// developer noise — not something to put in front of a user.
	//
	// For `detectCfDomains` this branch is a safety net rather than the usual
	// path: the route parses the upstream Cloudflare body itself and reports a
	// real message on failure, so the client only sees a `SyntaxError` if
	// something in front of our own API answers with HTML.
	//
	// Anything we cannot attribute to a known cause falls back to a neutral
	// message rather than blaming the credentials.
	const message = errorField(err, "message");
	if (name === "TypeError" && message) return message;

	return fallbackMessage;
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			// Session expired / not logged in: bounce to the login page.
			// Skip auth endpoints themselves (login/me/logout handle 401 internally).
			if (res.status === 401 && !url.includes("/api/v1/auth/")) {
				if (typeof window !== "undefined" && window.location.pathname !== "/login") {
					window.location.href = "/login";
				}
			}
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

export interface SetupStatus {
	configured: boolean;
	mailboxCount: number;
	hasEmails: boolean;
}

/** First-run bootstrap state, used by the setup wizard and the auth gate. */
export interface AdminStatus {
	initialized: boolean;
}

export interface VerifyDomainRequest {
	domain: string;
	resendApiKey: string;
	cfApiToken: string;
	cfAccountId: string;
}

export interface DnsRecord {
	name: string;
	type: string;
	status: string;
	value?: string;
}

export interface VerifyResult {
	domainId: string;
	status: string;
	dnsRecords: DnsRecord[];
}

export interface SetupEmailRoutingRequest {
	domain: string;
	cfApiToken: string;
	cfAccountId: string;
}

export interface SetupResult {
	success: boolean;
}

export interface ResendDomainStatus {
	id: string;
	domain: string;
	status: string;
}

export interface VerifyResendResult {
	valid: boolean;
	error?: string;
	domains?: ResendDomainStatus[];
	matchingDomain?: { domain: string; status: string } | null;
	sendingReady?: boolean;
}

export interface DnsRecordResult {
	name: string;
	type: string;
	status: string;
	value: string;
}

export interface SetupResendSendingResult {
	success: boolean;
	error?: string;
	resendDomainId?: string;
	resendDomainStatus?: string;
	dnsResults?: DnsRecordResult[];
	verification?: VerifyResendResult;
}

export interface DetectCfDomainsRequest {
	cfApiToken: string;
	cfAccountId: string;
}

export interface CfZone {
	id: string;
	name: string;
	status: string;
}

export interface DetectCfDomainsResult {
	zones: CfZone[];
	accountName?: string;
}

export interface DnsProviderDetection {
	provider: string;
	nameservers: string[];
}

// ---------- API client ----------

export interface CreateDomainResponse {
	domain: Domain;
	dnsRecords: DnsRecord[];
	warnings?: string[];
}

/**
 * Public shape of a global agent API key. Mirrors `AgentApiKeyPublic` in
 * `workers/db/index.ts` — the key hash never leaves the Worker, so it is not
 * part of this contract.
 */
export interface AgentApiKeyPublic {
	id: string;
	name: string;
	prefix: string;
	scopes: string;
	allowed_mailboxes: string | null;
	created_at: string;
	last_used_at: string | null;
	expires_at: string | null;
	revoked_at: string | null;
}

/** `api_key` is the plaintext secret and is returned by POST exactly once. */
export interface CreatedAgentApiKey {
	id: string;
	name: string;
	prefix: string;
	api_key: string;
	message: string;
}

const api = {
	// Auth
	auth: {
		login: (username: string, password: string) =>
			post<{ authenticated: boolean; username: string }>("/api/v1/auth/login", { username, password }),
		logout: () => post<{ success: boolean }>("/api/v1/auth/logout"),
		me: () => get<{ authenticated: boolean; username: string }>("/api/v1/auth/me"),
	},

	// Global agent API keys (admin, session-cookie auth). These are the keys
	// external LLM / MCP clients present to the root-mounted gateway
	// (`/mcp`, `/tools`) via `Authorization: Bearer <key>`.
	agentApiKeys: {
		list: () =>
			get<{ api_keys: AgentApiKeyPublic[] }>("/api/v1/agent-api-keys"),
		create: (name: string) =>
			post<CreatedAgentApiKey>("/api/v1/agent-api-keys", { name }),
		revoke: (id: string) =>
			del<{ ok: boolean }>(`/api/v1/agent-api-keys/${id}`),
	},

	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[] }>("/api/v1/config"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),

	// Domains
	domains: {
		list: () => get<Domain[]>("/api/v1/domains"),
		create: (data: { domain: string; resendApiKey?: string; provider?: string; providerCredentials?: Record<string, string> }) =>
			post<CreateDomainResponse>("/api/v1/domains", data),
		delete: (id: string) => del<void>(`/api/v1/domains/${id}`),
		setCatchAll: (domainId: string, catchAllMailbox: string | null) =>
			put<Domain>(`/api/v1/domains/${domainId}/catch-all`, { catch_all_mailbox: catchAllMailbox }),
		updateApiKey: (domainId: string, apiKey: string) =>
			put<Domain>(`/api/v1/domains/${domainId}/api-key`, { resend_api_key: apiKey }),
	},

	verifyResendKey: (mailboxId: string, apiKey: string) =>
		post<VerifyResendResult>(`/api/v1/mailboxes/${mailboxId}/verify-resend`, { apiKey }),

	verifyDomainResendKey: (domainId: string, apiKey: string) =>
		post<VerifyResendResult>(`/api/v1/domains/${domainId}/verify-resend`, { apiKey }),

	setupResendSending: (domainId: string, data: { apiKey: string; cfApiToken?: string }) =>
		post<SetupResendSendingResult>(`/api/v1/domains/${domainId}/setup-resend-sending`, data),

	// DNS Provider Detection
	// MX Record Verification
	verifyMx: (domain: string) =>
		post<{
			verified: boolean;
			records: Array<{ priority: number; exchange: string }>;
			matched?: { priority: number; exchange: string } | null;
			error?: string;
		}>("/api/v1/setup/verify-mx", { domain }),

	detectDnsProvider: (domain: string) =>
		post<DnsProviderDetection>("/api/v1/setup/detect-dns-provider", { domain }),

	// Setup
	getSetupStatus: () => get<SetupStatus>("/api/v1/setup/status"),
	// First-run admin bootstrap (public until an admin account exists)
	adminStatus: () => get<AdminStatus>("/api/v1/setup/admin/status"),
	createAdmin: (data: { username: string; password: string }) =>
		post<{ authenticated: boolean; username: string }>("/api/v1/setup/admin", data),
	detectCfDomains: (data: DetectCfDomainsRequest) =>
		post<DetectCfDomainsResult>("/api/v1/setup/detect-cf-domains", data),
	verifyDomain: (data: VerifyDomainRequest) =>
		post<VerifyResult>("/api/v1/setup/verify-domain", data),
	setupEmailRouting: (data: SetupEmailRoutingRequest) =>
		post<SetupResult>("/api/v1/setup/email-routing", data),
	// Platform Settings
	getPlatformSetting: (key: string) =>
		get<{ key: string; value: string | null }>(`/api/v1/platform-settings/${key}`),
	setPlatformSetting: (key: string, value: string) =>
		put<{ key: string; value: string }>(`/api/v1/platform-settings/${key}`, { value }),
};

export default api;
