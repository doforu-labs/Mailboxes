// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

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

// ---------- API client ----------

export interface CreateDomainResponse {
	domain: Domain;
	dnsRecords: DnsRecord[];
	warnings?: string[];
}

const api = {
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
		create: (data: { domain: string; resendApiKey?: string }) =>
			post<CreateDomainResponse>("/api/v1/domains", data),
		delete: (id: string) => del<void>(`/api/v1/domains/${id}`),
		setCatchAll: (domainId: string, catchAllMailbox: string | null) =>
			put<Domain>(`/api/v1/domains/${domainId}/catch-all`, { catch_all_mailbox: catchAllMailbox }),
		updateApiKey: (domainId: string, apiKey: string) =>
			put<Domain>(`/api/v1/domains/${domainId}/api-key`, { resend_api_key: apiKey }),
	},

	verifyResendKey: (mailboxId: string, apiKey: string) =>
		post<VerifyResendResult>(`/api/v1/mailboxes/${mailboxId}/verify-resend`, { apiKey }),

	// Setup
	getSetupStatus: () => get<SetupStatus>("/api/v1/setup/status"),
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
