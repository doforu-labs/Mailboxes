// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

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
// Imported for its side effect of loading the real module: mock.module() below
// replaces the whole module, so we spread these exports and override only the
// few functions under test. Without the spread, any other export that the app
// pulls in fails to resolve at import time with "does not provide an export
// named ...".
import * as actualDb from "./db";

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

// ── Admin session used by every request ────────────────────────────
//
// Every /api/v1/mailboxes/:mailboxId/* route sits behind requireAuth
// (workers/lib/auth.ts), which authenticates a signed-in admin from the
// `mailboxes_session` cookie and then looks that token up in the D1 `sessions`
// table. These tests therefore present a real session token and stub only the
// lookup — the middleware itself still runs untouched, so the whole auth chain
// is exercised: a request without a cookie, or with a token the store does not
// know, is still rejected with 401 (see the "admin session authentication"
// block at the end of the file).
const TEST_SESSION_TOKEN = "test-session-token";

const TEST_SESSION_CREATED_AT = new Date(Date.now() - 60 * 1000).toISOString();

type MockSession = { token: string; created_at: string; expires_at: string };

const mockGetSession = mock.fn<
	(db: any, token: string) => Promise<MockSession | null>
>(async () => ({
	token: TEST_SESSION_TOKEN,
	created_at: TEST_SESSION_CREATED_AT,
	expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
}));

// requireAuth deletes a session row it finds expired; stub that write too so the
// expiry path can be exercised without a real D1 binding.
const mockDeleteSession = mock.fn<(db: any, token: string) => Promise<void>>(
	async () => {},
);

const dbMocks = {
	// Keep every real export, then override only the stubs this file needs.
	...actualDb,
	saveAiMessage: mockSaveAiMessage,
	getAiChatHistory: mockGetAiChatHistory,
	clearAiChatHistory: mockClearAiChatHistory,
	getEmail: mockGetEmail,
	getThreadEmails: mockGetThreadEmails,
	getSession: mockGetSession,
	deleteSession: mockDeleteSession,
};

// NOTE: ./lib/auth is deliberately NOT mocked. mock.module() builds a fresh
// module instance for the target, which would re-evaluate workers/lib/auth.ts
// outside this mock registry and re-bind its `./db` import to the REAL module —
// resurrecting the unmocked session lookup. The real requireAuth is left in
// place and satisfied through the db stub instead (see the tests at the end of
// the file), which is what keeps the authentication path under test.
mock.module("./db", { namedExports: dbMocks });

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
		mockGetSession,
	mockDeleteSession,
	]) {
		m.mock.resetCalls();
	}

	// Each test starts from an unexpired session unless it says otherwise.
	mockGetSession.mock.mockImplementation(async () => ({
		token: TEST_SESSION_TOKEN,
		created_at: TEST_SESSION_CREATED_AT,
		expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
	}));
	mockDeleteSession.mock.mockImplementation(async () => {});
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
		run: mock.fn<(model: string, options: unknown) => Promise<unknown>>(),
	};

	const env = {
		DB: {} as any,
		AI: mockAi,
		BUCKET: mockBucket,
	} as any;

	return { env, mockAi, mockBucket };
}

// ── Request helpers ────────────────────────────────────────────────

const BASE = "http://localhost";

/**
 * The cookie an authenticated admin browser sends. requireAuth reads it with
 * hono/cookie's getCookie() and validates the token against the (stubbed)
 * session store before letting the request reach the route.
 */
const SESSION_COOKIE = `mailboxes_session=${TEST_SESSION_TOKEN}`;

function postReq(path: string, body: any, extraHeaders?: Record<string, string>) {
	return new Request(`${BASE}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: SESSION_COOKIE,
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

function getReq(path: string) {
	return new Request(`${BASE}${path}`, {
		method: "GET",
		headers: { Cookie: SESSION_COOKIE },
	});
}

function deleteReq(path: string) {
	return new Request(`${BASE}${path}`, {
		method: "DELETE",
		headers: { Cookie: SESSION_COOKIE },
	});
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
		const data = (await res.json()) as { error?: string };
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
		const data = (await res.json()) as { error?: string };
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

		// `run` receives (model, { messages }); the mock's arguments are typed
		// loosely, so narrow the second argument before reading it.
		const messages = (
			callArgs[1] as { messages?: Array<{ role: string; content: string }> }
		)?.messages;
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

		const data = (await res.json()) as { messages: { role: string; content: string }[] };
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
		const data = (await res.json()) as { error?: string };
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
		const data = (await res.json()) as { error?: string };
		assert.strictEqual(
			data.error,
			"message too long",
			"Should reject overly long message",
		);
	});
});

// ── Admin session authentication ───────────────────────────────────
//
// Guards the fix above: the requests in this file only reach the AI Chat routes
// because they carry a valid session. These cases pin that the guard itself is
// still in place, so the rest of the file cannot be made green by dropping the
// cookie — or by weakening the middleware.

describe("AI Chat endpoint authentication", () => {
	it("rejects a request without a session cookie", async () => {
		resetMockCalls();
		const { env } = createMockEnv();

		const req = new Request(`${BASE}/api/v1/mailboxes/test@example.com/ai/chat`, {
			method: "GET",
		});
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 401);
		assert.strictEqual(sessionDbQueries(), 0, "an anonymous request must not query the session store");
		assert.deepStrictEqual(await res.json(), { error: "Unauthorized" });
	});

	it("rejects a session token that is not in the store", async () => {
		resetMockCalls();
		mockGetSession.mock.mockImplementationOnce(async () => null);

		const { env } = createMockEnv();
		const req = new Request(`${BASE}/api/v1/mailboxes/test@example.com/ai/chat`, {
			method: "GET",
			headers: { Cookie: "mailboxes_session=not-a-real-token" },
		});
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 401);
		assert.strictEqual(sessionDbQueries(), 1, "the presented token must be looked up");
		assert.strictEqual(
			mockGetSession.mock.calls[0].arguments[1],
			"not-a-real-token",
			"the middleware must check the token the client actually sent",
		);
	});

	it("rejects an expired session", async () => {
		resetMockCalls();
		mockGetSession.mock.mockImplementationOnce(async () => ({
			token: TEST_SESSION_TOKEN,
			created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
			expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		}));

		const { env } = createMockEnv();
		const req = getReq("/api/v1/mailboxes/test@example.com/ai/chat");
		const res = await app.fetch(req, env);

		assert.strictEqual(res.status, 401);
		assert.strictEqual(
			mockGetSession.mock.calls[0].arguments[1],
			TEST_SESSION_TOKEN,
			"the expiry check must run against the stored session row",
		);
	});
});

/** Number of times the (stubbed) D1 session lookup has been consulted. */
function sessionDbQueries(): number {
	return mockGetSession.mock.calls.length;
}
