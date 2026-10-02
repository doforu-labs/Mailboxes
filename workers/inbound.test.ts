// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Tests for the Resend Inbound webhook handler.
 *
 * To run: npm test — the db layer is replaced with mock.module(), which needs
 * `--experimental-test-module-mocks`; a bare `tsx --test` cannot run this file.
 *
 * These tests verify the handler correctly processes Resend webhook payloads,
 * fetches the full email content from the Resend API, downloads attachments
 * into R2, and persists the message to D1 through workers/db.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import * as actualDb from "./db";

// We need to set up globals before importing the handler
const originalCryptoDesc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalCrypto = globalThis.crypto;
const originalFetch = globalThis.fetch;

// ── Mock data ──────────────────────────────────────────────────────

const MOCK_WEBHOOK_PAYLOAD = {
	type: "email.received",
	created_at: "2026-02-22T23:41:12.126Z",
	data: {
		email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
		created_at: "2026-02-22T23:41:11.894719+00:00",
		from: "Acme <onboarding@resend.dev>",
		to: ["delivered@resend.dev"],
		bcc: [],
		cc: [],
		received_for: ["incoming@example.com"],
		message_id: "<111-222-333@email.example.com>",
		subject: "Sending this example",
		attachments: [
			{
				id: "2a0c9ce0-3112-4728-976e-47ddcd16a318",
				filename: "avatar.png",
				content_type: "image/png",
				content_disposition: "inline",
				content_id: "img001",
			},
		],
	},
};

const MOCK_FULL_EMAIL = {
	email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
	created_at: "2026-02-22T23:41:11.894719+00:00",
	from: "Acme <onboarding@resend.dev>",
	to: ["delivered@resend.dev"],
	bcc: [],
	cc: [],
	received_for: ["incoming@example.com"],
	message_id: "<111-222-333@email.example.com>",
	subject: "Sending this example",
	html: "<p>Hello!</p>",
	text: "Hello!",
	headers: [
		{ key: "From", value: "Acme <onboarding@resend.dev>" },
		{ key: "To", value: "delivered@resend.dev" },
		{ key: "Subject", value: "Sending this example" },
		{ key: "Date", value: "2026-02-22T23:41:11.894719+00:00" },
		{ key: "Message-ID", value: "<111-222-333@email.example.com>" },
	],
	attachments: [
		{
			id: "2a0c9ce0-3112-4728-976e-47ddcd16a318",
			filename: "avatar.png",
			content_type: "image/png",
			content_disposition: "inline",
			content_id: "img001",
			size: 12345,
		},
	],
};

// ── Mock the db layer ──────────────────────────────────────────────
//
// handleResendInbound persists through workers/db: it resolves catch-all routing
// with getDomainByName, looks up an existing thread with findThreadBySubject,
// and finally writes the message with createEmail (see workers/inbound.ts).
// These tests are about the handler, so the db module is replaced with stubs
// that record what they were asked to do.
//
// mock.module() swaps out the ENTIRE module, so every real export is spread in
// first and only the three functions above are overridden. Without that spread,
// other exports the rest of the app imports (e.g. lookupApiKey, pulled in by
// lib/api-key-middleware-global) fail to resolve at import time with
// "does not provide an export named ...".
//
// `namedExports` is deprecated in favour of `exports` on newer Node releases,
// which warns here; it is kept because Node 22 (the oldest release with
// node:sqlite) does not understand `exports` yet.

const PROBE_MAILBOX = "incoming@example.com";
const DEFAULT_RESEND_API_KEY = "re_mailbox_key";

const createdEmails: Array<{ folder: string; email: any; attachments: any[] }> = [];

const mockCreateEmail = mock.fn(
	async (
		_db: unknown,
		_mailboxId: string,
		folder: string,
		email: any,
		attachments: any[],
	) => {
		createdEmails.push({ folder, email, attachments });
	},
);

const mockFindThreadBySubject = mock.fn(async () => null);

const mockGetDomainByName = mock.fn(async () => null);

mock.module("./db", {
	namedExports: {
		...actualDb,
		createEmail: mockCreateEmail,
		findThreadBySubject: mockFindThreadBySubject,
		getDomainByName: mockGetDomainByName,
	},
});

// ── Mock env builder ───────────────────────────────────────────────

interface MockEnvOptions {
	resendApiKey?: string;
	emailAddresses?: string[];
	mailboxExists?: boolean;
}

function createMockEnv(opts: MockEnvOptions = {}) {
	const {
		// The defaults describe a healthy, fully configured mailbox so each test
		// only has to override the one thing it is actually about.
		resendApiKey = DEFAULT_RESEND_API_KEY,
		emailAddresses = [PROBE_MAILBOX],
		mailboxExists = true,
	} = opts;

	createdEmails.length = 0;
	let agentCalled = false;
	let agentPayload: any = null;

	// Mailbox settings stored in R2
	const mailboxSettings: Record<string, any> = {};
	if (resendApiKey !== undefined) {
		mailboxSettings.resendApiKey = resendApiKey;
	}

	// Production probes a mailbox by address (mailboxes/<address>.json), so a
	// mailbox "exists" exactly when its address is registered through opts.
	const r2Known = new Set(mailboxExists ? emailAddresses : []);
	const addressOf = (key: string) =>
		key.replace(/^mailboxes\//, "").replace(/\.json$/, "");

	const mockBucket = {
		head: mock.fn(async (key: string) =>
			r2Known.has(addressOf(key)) ? ({ key } as R2Object) : null,
		),
		get: mock.fn(async (key: string) =>
			r2Known.has(addressOf(key))
				? ({ json: async () => mailboxSettings } as any)
				: null,
		),
		put: mock.fn(async () => {}),
		delete: mock.fn(async () => {}),
		list: mock.fn(async () => ({ objects: [] })),
	} as unknown as R2Bucket;

	const mockMailboxNs = {
		idFromName: mock.fn((name: string) => name),
		get: mock.fn((_id: string) => ({
			createEmail: mock.fn(async (
				folder: string,
				email: any,
				attachments: any[],
			) => {
				createdEmails.push({ folder, email, attachments });
			}),
			getFolders: mock.fn(async () => []),
			getEmail: mock.fn(async () => null),
			findThreadBySubject: mock.fn(async () => null),
		})),
	} as unknown as DurableObjectNamespace;

	const mockAgentNs = {
		idFromName: mock.fn((name: string) => name),
		get: mock.fn((_id: string) => ({
			fetch: mock.fn(async (request: Request) => {
				agentCalled = true;
				agentPayload = await request.json();
				return new Response(JSON.stringify({ ok: true }));
			}),
		})),
	} as unknown as DurableObjectNamespace;

	const env = {
		// The db module is stubbed above, so this binding is only forwarded
		// through by the handler and never touched directly.
		DB: {} as any,
		BUCKET: mockBucket,
		MAILBOX: mockMailboxNs,
		EMAIL_AGENT: mockAgentNs,
		EMAIL_MCP: null as any,
		AI: null as any,
	} as any;

	return {
		env,
		ctx: { waitUntil: mock.fn() } as unknown as ExecutionContext,
		createdEmails,
		get agentCalled() { return agentCalled; },
		get agentPayload() { return agentPayload; },
	};
}

// ── Setup / Teardown ───────────────────────────────────────────────

function setupGlobals() {
	// Mock crypto.randomUUID
	// Use defineProperty because crypto is a getter-only property in Node >=19
	Object.defineProperty(globalThis, 'crypto', {
		value: {
			...originalCrypto,
			randomUUID: () => "00000000-0000-4000-8000-000000000000",
		},
		writable: true,
		configurable: true,
		enumerable: true,
	});

	// Mock fetch
	let fetchCallCount = 0;
	(globalThis as any).fetch = mock.fn(async (url: string, options?: any) => {
		fetchCallCount++;

		if (url.includes("/emails/receiving/") && !url.includes("/download")) {
			// GET /emails/receiving/{email_id}
			return new Response(JSON.stringify(MOCK_FULL_EMAIL), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.includes("/download")) {
			// GET /emails/receiving/{email_id}/attachments/{id}/download
			return new Response(new ArrayBuffer(8), {
				status: 200,
				headers: { "Content-Type": "image/png" },
			});
		}

		return new Response(JSON.stringify({ error: "not found" }), {
			status: 404,
		});
	});

	return fetchCallCount;
}

function teardownGlobals() {
	// Restore original crypto descriptor
	if (originalCryptoDesc) {
		Object.defineProperty(globalThis, 'crypto', originalCryptoDesc);
	}
	globalThis.fetch = originalFetch;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("handleResendInbound", async () => {

	it("should successfully process a valid webhook payload", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const { env, ctx, createdEmails } = createMockEnv({
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);

		// Verify email was created in MailboxDO
		assert.strictEqual(createdEmails.length, 1);
		assert.strictEqual(createdEmails[0].folder, "inbox");
		assert.strictEqual(
			createdEmails[0].email.sender,
			"onboarding@resend.dev",
		);
		assert.strictEqual(createdEmails[0].email.subject, "Sending this example");
		assert.strictEqual(
			createdEmails[0].email.recipient,
			"delivered@resend.dev",
		);
		assert.strictEqual(createdEmails[0].email.body, "<p>Hello!</p>");

		// Verify attachment was stored
		assert.strictEqual(createdEmails[0].attachments.length, 1);
		assert.strictEqual(createdEmails[0].attachments[0].filename, "avatar.png");
		assert.strictEqual(
			createdEmails[0].attachments[0].mimetype,
			"image/png",
		);

		// Verify R2 put was called for the attachment
		assert.strictEqual(
			(env.BUCKET.put as any).mock.callCount(),
			1,
		);

		// The handler writes straight to D1 now; it no longer hands work to the
		// EmailAgent through ctx.waitUntil. `ctx` is a hand-rolled stub, so its
		// waitUntil is a mock even though the declared type is ExecutionContext.
		assert.strictEqual((ctx.waitUntil as any).mock.callCount(), 0);

		teardownGlobals();
	});

	it("should use received_for address as mailboxId when available", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const { env, ctx, createdEmails } = createMockEnv({
			emailAddresses: ["incoming@example.com"],
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(createdEmails.length, 1);
		assert.strictEqual(
			createdEmails[0].email.recipient.includes("delivered@resend.dev"),
			true,
		);

		teardownGlobals();
	});

	it("should skip emails for unknown recipients (not in EMAIL_ADDRESSES)", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const { env, ctx, createdEmails } = createMockEnv({
			emailAddresses: ["other@example.com"], // Does NOT include incoming@example.com
	
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(createdEmails.length, 0);

		teardownGlobals();
	});

	it("should skip emails when mailbox does not exist in R2", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const { env, ctx, createdEmails } = createMockEnv({
			mailboxExists: false,
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(createdEmails.length, 0);

		teardownGlobals();
	});

	it("should return ok=false when no API key is configured", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const { env, ctx, createdEmails } = createMockEnv({
			// An empty string is a present-but-unconfigured key, which the handler
			// treats as "no Resend API key".
			resendApiKey: "",
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(createdEmails.length, 0);

		teardownGlobals();
	});

	it("should use mailbox-specific resendApiKey", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const { env, ctx, createdEmails } = createMockEnv({
	
			resendApiKey: "re_mailbox_key",
			emailAddresses: ["incoming@example.com"],
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(createdEmails.length, 1);

		teardownGlobals();
	});

	it("should handle emails with no attachments", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");
		const noAttachPayload = {
			...MOCK_WEBHOOK_PAYLOAD,
			data: { ...MOCK_WEBHOOK_PAYLOAD.data, attachments: [] },
		};
		const noAttachFullEmail = {
			...MOCK_FULL_EMAIL,
			attachments: [],
		};

		// Override the mock fetch for this test
		(globalThis as any).fetch = mock.fn(async (url: string) => {
			if (url.includes("/emails/receiving/") && !url.includes("/download")) {
				return new Response(JSON.stringify(noAttachFullEmail), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(new ArrayBuffer(0));
		});

		const { env, ctx, createdEmails } = createMockEnv({
		});

		const result = await handleResendInbound(
			noAttachPayload as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(createdEmails.length, 1);
		assert.strictEqual(createdEmails[0].attachments.length, 0);

		teardownGlobals();
	});

	it("should extract threading headers (in-reply-to, references)", async () => {
		setupGlobals();
		const { handleResendInbound } = await import("./inbound");

		const threadedFullEmail = {
			...MOCK_FULL_EMAIL,
			headers: [
				...MOCK_FULL_EMAIL.headers,
				{
					key: "In-Reply-To",
					value: "<parent-msg-id@example.com>",
				},
				{
					key: "References",
					value:
						"<root-msg-id@example.com> <parent-msg-id@example.com>",
				},
			],
		};

		(globalThis as any).fetch = mock.fn(async (url: string) => {
			if (url.includes("/emails/receiving/") && !url.includes("/download")) {
				return new Response(JSON.stringify(threadedFullEmail), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(new ArrayBuffer(8));
		});

		const { env, ctx, createdEmails } = createMockEnv({
		});

		const result = await handleResendInbound(
			MOCK_WEBHOOK_PAYLOAD as any,
			env,
			ctx,
		);

		assert.strictEqual(result.ok, true);
		assert.strictEqual(createdEmails.length, 1);

		const email = createdEmails[0].email;
		assert.strictEqual(email.in_reply_to, "parent-msg-id@example.com");
		assert.ok(email.email_references);
		const refs = JSON.parse(email.email_references);
		assert.deepStrictEqual(refs, [
			"root-msg-id@example.com",
			"parent-msg-id@example.com",
		]);

		teardownGlobals();
	});
});
