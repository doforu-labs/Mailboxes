// Copyright (c) 2026 Doforu
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE-APACHE file or at:
//     https://opensource.org/licenses/Apache-2.0
// Modifications Copyright (c) 2026 Doforu, distributed under the AGPL-3.0-only (see LICENSE).

/**
 * Shared types and Zod schemas for email data.
 *
 * Types: used by the agent and route handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";
import { DEFAULT_LOCALE } from "../../shared/i18n/config";
import { getBackendT } from "../../shared/i18n/translate";
import type { Locale } from "../../shared/i18n/types";

/**
 * [i18n apiAuth] These zod schemas are module-level singletons, so they cannot
 * capture a per-request locale. The refine messages below are therefore
 * resolved ONCE, at module load, against `DEFAULT_LOCALE` (English) — there is
 * no request-scoped/parameterized localization path for a schema's `message`.
 * English here is intentionally a last-resort fallback (schema-level wording
 * also ends up in `details`): handlers localize the user-facing `error` field
 * themselves via `api:validationFailed`.
 */
function schemaMessage(locale: Locale, key: string): string {
	return getBackendT(locale, "apiAuth")(key) as string;
}

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	sender_name?: string | null;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1),
]);

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email(),
			z.object({ email: z.string().email(), name: z.string() }),
		]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(), // base64 encoded
					filename: z.string(),
					type: z.string(),
					disposition: z.enum(["attachment", "inline"]),
					contentId: z.string().optional(),
				}),
			)
			.optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: schemaMessage(DEFAULT_LOCALE, "eitherHtmlOrTextRequired"),
	});

export const ReplyBodySchema = z
	.object({
		body: z.string().optional(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(),
					filename: z.string(),
					type: z.string().optional(),
					disposition: z.enum(["attachment", "inline"]).optional(),
				}),
			)
			.optional(),
	})
	.refine((data) => data.body || data.html || data.text, {
		message: schemaMessage(DEFAULT_LOCALE, "eitherBodyHtmlOrTextRequired"),
	});

export const ForwardBodySchema = z
	.object({
		to: z.union([z.string().email(), z.array(z.string().email())]).optional(),
		body: z.string().optional(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(),
					filename: z.string(),
					type: z.string().optional(),
					disposition: z.enum(["attachment", "inline"]).optional(),
				}),
			)
			.optional(),
	})
	.refine((data) => data.body || data.html || data.text, {
		message: schemaMessage(DEFAULT_LOCALE, "eitherBodyHtmlOrTextRequired"),
	});

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});
