// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable(
	"folders",
	{
		mailbox_id: text("mailbox_id").notNull(),
		id: text("id").notNull(),
		name: text("name").notNull(),
		is_deletable: integer("is_deletable").notNull().default(1),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.mailbox_id, table.id] }),
	}),
);

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	mailbox_id: text("mailbox_id").notNull(),
	folder_id: text("folder_id").notNull(),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	send_status: text("send_status"), // NULL (not sent), "sending", "sent", "failed"
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id").notNull(),
	mailbox_id: text("mailbox_id").notNull(),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
});

export const aiChatMessages = sqliteTable("ai_chat_messages", {
	id: text("id").primaryKey(),
	mailbox_id: text("mailbox_id").notNull(),
	role: text("role").notNull(),
	content: text("content").notNull(),
	created_at: text("created_at").notNull(),
});

export const domains = sqliteTable("domains", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	resend_domain_id: text("resend_domain_id"),
	cf_zone_id: text("cf_zone_id"),
	cf_account_id: text("cf_account_id"),
	status: text("status").notNull().default("pending"),
	catch_all_mailbox: text("catch_all_mailbox"),
	resend_api_key: text("resend_api_key"),
	created_at: text("created_at").notNull(),
});
