// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the AI Chat SSE endpoint.
 *
 * To run: npx tsx --test workers/ai-chat.test.ts
 * (requires tsx: npm install -D tsx)
 *
 * These tests verify the AI Chat SSE endpoint logic using mocked
 * D1 database and Workers AI bindings.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";

// ── Mock data ──────────────────────────────────────────────────────

const MOCK_HISTORY = [
	{ id: "h1", role: "user", content: "hello", created_at: "2026-01-01T00:00:00Z" },
	{ id: "h2", role: "assistant", content: "hi there", created_at: "2026-01-01T00:00:01Z" },
];

const MOCK_EMAIL = {
	id: "email-123",
	mailbox_id: "test@example.com",
	folder_id: "inbox",
	subject: "Test Subject",
	sender: "sender@example.com",
	recipient: "test@example.com",
	cc: null,
	bcc: null,
	date: "2026-01-01T00:00:00Z",
	read: false,
	starred: false,
	body: "This is a test email body for the AI to reference",
	in_reply_to: null,
	email_references: null,
	thread_id: null,
	message_id: null,
	raw_headers: null,
	attachments: [],
};

const MOCK_THREAD = [
	{
		...MOCK_EMAIL,
		id: "t1",
		subject: "Earlier thread email",
		body: "Earlier body content",
	},
	{
		...MOCK_EMAIL,
		id: "t2",
		subject: "Later thread email",
		body: "Later body content",
	},
];

// ── Mock db functions (set up BEFORE app import) ───────────────────
// Use mock.module() to intercept the db module import, since ESM
// module namespace objects are non-configurable and mock.method() won't work.

const mockSaveAiMessage = mock.fn<
	(db: any, mailboxId: string, role: string, content: string) => Promise<{ id: string }>
>(async () => ({ id: "mock-msg-id" }));

const mockGetAiChatHistory = mock.fn<
	(db: any, mailboxId: string, limit?: number) => Promise<any[]>
>(async () => []);

const mockClearAiChatHistory = mock.fn<
	(db: any, mailboxId: string) => Promise<void>
>(async () => {});

const mockGetEmail = mock.fn<
	(db: any, mailboxId: string, id: string) => Promise<any>
>(async () => null);

const mockGetThreadEmails = mock.fn<
	(db: any, mailboxId: string, threadId: string) => Promise<any[]>
>(async () => []);

mock.module("./db", {
	namedExports: {
		saveAiMessage: mockSaveAiMessage,
		getAiChatHistory: mockGetAiChatHistory,
		clearAiChatHistory: mockClearAiChatHistory,
		getEmail: mockGetEmail,
		getThreadEmails: mockGetThreadEmails,
	},
});

// Now import the app (will use the mocked db module)
const { app } = await import("./index");

// ── Helper: reset all mock call tracking ───────────────────────────

function resetMockCalls() {
	for (const m of [
		mockSaveAiMessage,
		mockGetAiChatHistory,
		mockClearAiChatHistory,
		mockGetEmail,
		mockGetThreadEmails,
	]) {
		m.mock.resetCalls();
	}
}

// ── Mock env builder ───────────────────────────────────────────────

function createMockEnv() {
	const mockBucket = {
		head: mock.fn(async (_key: string) => ({
			key: "mailboxes/test@example.com.json",
		})),
		get: mock.fn(async () => null),
		put: mock.fn(async () => {}),
		delete: mock.fn(async () => {}),
		list: mock.fn(async () => ({ objects: [] })),
	} as any;

	const mockAi = {
		run: mock.fn(),
	};

	const env = {
		DB: {} as any,
		AI: mockAi,
		BUCKET: mockBucket,
		POLICY_AUD: "dev-placeholder",
	} as any;

	return { env, mockAi, mockBucket };
}

// ── Request helpers ────────────────────────────────────────────────

const BASE = "http://localhost";

function postReq(path: string, body: any, extraHeaders?: Record<string, string>) {
	return new Request(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...extraHeaders },
		body: JSON.stringify(body),
	});
}

function getReq(path: string) {
	return new Request(`${BASE}${path}`, { method: "GET" });
}

function deleteReq(path: string) {
	return new Request(`${BASE}${path}`, { method: "DELETE" });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("AI Chat SSE endpoint", async () => {

	// ── Test 1: POST - validates message field ───────────────────────

	it("should return 400 for empty body", async () => {
		resetMockCalls();
		const { env } = createMockEnv();

		const req = postReq("/api/v1/mailboxes/test@example.com/ai/chat", {});
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 400);
		const data = await res.json();
		assert.strictEqual(data.error, "message is required");
	});

	it("should return 400 for non-string message (number)", async () => {
		resetMockCalls();
		const { env } = createMockEnv();

		const req = postReq("/api/v1/mailboxes/test@example.com/ai/chat", {
			message: 123,
		});
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 400);
		const data = await res.json();
		assert.strictEqual(data.error, "message is required");
	});

	it("should return SSE response for valid message", async () => {
		resetMockCalls();
		const { env, mockAi } = createMockEnv();

		mockAi.run.mock.mockImplementation(async () => ({
			response: "Hello! I'm your email assistant.",
		}));

		const req = postReq(
			"/api/v1/mailboxes/test@example.com/ai/chat",
			{ message: "hi" },
			{ Accept: "text/event-stream" },
		);
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream");

		const body = await res.text();
		assert.ok(body.includes("data: "), "Should have SSE data events");
		assert.ok(body.includes('"token":'), "Should have token events");
		assert.ok(body.includes('"done":true'), "Should have done event");
	});

	// ── Test 2: POST - builds AI messages with email context ─────────

	it("should include email and thread context in AI messages", async () => {
		resetMockCalls();
		const { env, mockAi } = createMockEnv();

		// Mock db to return email and thread
		mockGetEmail.mock.mockImplementation(async () => MOCK_EMAIL);
		mockGetThreadEmails.mock.mockImplementation(async () => MOCK_THREAD);

		mockAi.run.mock.mockImplementation(async () => ({
			response: "Here is your email summary.",
		}));

		const req = postReq(
			"/api/v1/mailboxes/test@example.com/ai/chat",
			{
				message: "find email",
				emailContext: { emailId: "email-123", threadId: "thread-1" },
			},
			{ Accept: "text/event-stream" },
		);
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 200);

		// Verify buildAiMessages was called with email + thread context
		const callArgs = mockAi.run.mock.calls[0].arguments;
		assert.ok(callArgs, "ai.run should have been called");

		const messages = callArgs[1]?.messages;
		assert.ok(messages, "messages should be passed to ai.run");

		const systemMsgs = messages.filter((m: any) => m.role === "system");

		// Email context should be in system messages
		const hasEmailContext = systemMsgs.some(
			(m: any) =>
				m.content.includes("sender@example.com") &&
				m.content.includes("Test Subject"),
		);
		assert.ok(
			hasEmailContext,
			"Email context should be included in system messages",
		);

		// Thread context should be in system messages
		const hasThreadContext = systemMsgs.some(
			(m: any) =>
				m.content.includes("Earlier thread email") ||
				m.content.includes("Earlier body content"),
		);
		assert.ok(
			hasThreadContext,
			"Thread context should be included in system messages",
		);

		// Verify db was queried for email and thread
		assert.strictEqual(mockGetEmail.mock.calls.length, 1);
		assert.strictEqual(mockGetThreadEmails.mock.calls.length, 1);
	});

	// ── Test 3: POST - model fallback works ──────────────────────────

	it("should fallback to second model when first fails", async () => {
		resetMockCalls();
		const { env, mockAi } = createMockEnv();

		let callCount = 0;
		mockAi.run.mock.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) throw new Error("Model A unavailable");
			return { response: "Fallback model response" };
		});

		const req = postReq(
			"/api/v1/mailboxes/test@example.com/ai/chat",
			{ message: "hello" },
			{ Accept: "text/event-stream" },
		);
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 200);

		// Both models should have been called (primary + fallback)
		assert.strictEqual(
			mockAi.run.mock.calls.length,
			2,
			"ai.run should be called twice (primary + fallback)",
		);

		// Parse SSE events to reconstruct full text from token chunks
		const body = await res.text();
		const sseEvents = body.split("\n").filter((l) => l.startsWith("data: "));
		const fullText = sseEvents
			.map((l) => {
				try {
					const parsed = JSON.parse(l.slice(6));
					return parsed.token || "";
				} catch {
					return "";
				}
			})
			.join("");
		assert.ok(
			fullText.includes("Fallback model response"),
			"Should contain fallback model output, not empty string",
		);
		assert.ok(body.includes('"done":true'), "Should have done event");
	});

	// ── Test 4: POST - returns SSE error when both models fail ───────

	it("should return SSE error event when both AI models fail", async () => {
		resetMockCalls();
		const { env, mockAi } = createMockEnv();

		mockAi.run.mock.mockImplementation(async () => {
			throw new Error("AI service unavailable");
		});

		const req = postReq(
			"/api/v1/mailboxes/test@example.com/ai/chat",
			{ message: "hello" },
			{ Accept: "text/event-stream" },
		);
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get("Content-Type"), "text/event-stream");

		const body = await res.text();
		assert.ok(
			body.includes("AI temporarily unavailable"),
			"SSE error should mention AI unavailability",
		);
		assert.ok(body.includes("error"), "SSE response should have error field");
	});

	// ── Test 5: GET - returns chat history ───────────────────────────

	it("should return chat history from GET endpoint", async () => {
		resetMockCalls();

		mockGetAiChatHistory.mock.mockImplementation(async () => MOCK_HISTORY);

		const { env } = createMockEnv();
		const req = getReq("/api/v1/mailboxes/test@example.com/ai/chat");

		const res = await app.fetch(req, env);
		assert.strictEqual(res.status, 200);

		const data = await res.json();
		assert.ok(data.messages, "Response should have messages array");
		assert.strictEqual(data.messages.length, 2);
		assert.strictEqual(data.messages[0].role, "user");
		assert.strictEqual(data.messages[0].content, "hello");
		assert.strictEqual(data.messages[1].role, "assistant");
		assert.strictEqual(data.messages[1].content, "hi there");
	});

	// ── Test 6: DELETE - clears history ──────────────────────────────

	it("should clear chat history from DELETE endpoint", async () => {
		resetMockCalls();

		const { env } = createMockEnv();
		const req = deleteReq("/api/v1/mailboxes/test@example.com/ai/chat");

		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 204);

		// Verify clearAiChatHistory was called with correct params
		assert.strictEqual(mockClearAiChatHistory.mock.calls.length, 1);
		const args = mockClearAiChatHistory.mock.calls[0].arguments;
		assert.strictEqual(args[1], "test@example.com");
	});

	// ── Test 7: POST - validation rejects empty string ───────────────

	it("should return 400 for empty string message", async () => {
		resetMockCalls();
		const { env } = createMockEnv();

		const req = postReq("/api/v1/mailboxes/test@example.com/ai/chat", {
			message: "",
		});
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 400);
		const data = await res.json();
		assert.strictEqual(data.error, "message is required");
	});

	// ── Test 8: POST - validation rejects overly long message ────────

	it("should return 400 for overly long message (>10000 chars)", async () => {
		resetMockCalls();
		const { env } = createMockEnv();
		const longMsg = "a".repeat(10001);

		const req = postReq("/api/v1/mailboxes/test@example.com/ai/chat", {
			message: longMsg,
		});
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 400);
		const data = await res.json();
		assert.strictEqual(
			data.error,
			"message too long",
			"Should reject overly long message",
		);
	});
});
