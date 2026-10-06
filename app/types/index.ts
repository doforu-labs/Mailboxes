// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	agentSystemPrompt?: string;
	resendApiKey?: string;
	aiProvider?: AiProviderSettings;
}

export interface AiProviderSettings {
	provider?: "cloudflare" | "openai-compatible";
	baseUrl?: string;
	modelName?: string;
	apiKey?: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
	created_at?: string;
	// Summary fields for mailbox list view
	unread_count?: number;
	latest_subject?: string | null;
	latest_sender?: string | null;
	latest_sender_name?: string | null;
	latest_date?: string | null;
	latest_read?: boolean | null;
	latest_snippet?: string | null;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	sender_name?: string | null;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	participants_meta?: string | null;
	needs_reply?: boolean;
	has_draft?: boolean;
	send_status?: string | null; // NULL (not sent), "sending", "sent", "failed"
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Domain {
	id: string;
	name: string;
	resend_domain_id?: string;
	cf_zone_id?: string;
	cf_account_id?: string;
	status: 'pending' | 'verified' | 'failed';
	catch_all_mailbox?: string | null;
	resend_api_key?: string | null;
	created_at: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}
