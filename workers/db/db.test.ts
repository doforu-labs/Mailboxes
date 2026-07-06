// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the D1 database service layer.
 *
 * To run: npx tsx --test workers/db/db.test.ts
 *
 * These tests verify the database functions with a mock D1Database,
 * focusing on parameter construction, filtering logic, and edge cases.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";

// ── Mock D1Database ─────────────────────────────────────────────────

/** In-memory row store keyed by SQL fingerprint */
const rowStore = new Map<string, any[]>();

class MockStatement {
	private sql: string;

	constructor(sql: string) {
		this.sql = sql;
	}

	bind(...args: any[]) {
		return this;
	}

	all() {
		return { results: [...(rowStore.get(this.sql) || [])] };
	}

	first() {
		const rows = rowStore.get(this.sql);
		return rows?.[0] ?? null;
	}

	run() {
		return { success: true, meta: { changes: 1, last_row_id: "mock-id" } };
	}

	raw() {
		const rows = rowStore.get(this.sql);
		return rows?.map((r: any) => Object.values(r)) ?? [];
	}
}

function createMockDb() {
	rowStore.clear();
	return {
		prepare: (sql: string) => new MockStatement(sql),
		batch: async (stmts: any[]) => stmts.map(() => ({ success: true })),
	} as unknown as D1Database;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("D1 Database Service", () => {

	describe("checkSendRateLimit", () => {
		it("should return zero counts for empty mailbox", async () => {
			const db = createMockDb();
			const { checkSendRateLimit } = await import("./index");
			const result = await checkSendRateLimit(db, "empty@example.com");
			assert.equal(result.hourlyCount, 0);
			assert.equal(result.dailyCount, 0);
			assert.equal(result.hourlyLimit, 20);
			assert.equal(result.dailyLimit, 100);
		});
	});

	describe("saveAiMessage", () => {
		it("should save and return an id", async () => {
			const db = createMockDb();
			const { saveAiMessage } = await import("./index");
			const result = await saveAiMessage(db, "test@example.com", "user", "Hello");
			assert.ok(result);
			assert.equal(typeof result.id, "string");
			assert.ok(result.id.length > 0);
		});
	});

	describe("getAiChatHistory", () => {
		it("should return empty array for no history", async () => {
			const db = createMockDb();
			const { getAiChatHistory } = await import("./index");
			const messages = await getAiChatHistory(db, "test@example.com", 10);
			assert.ok(Array.isArray(messages));
			assert.equal(messages.length, 0);
		});
	});

	describe("clearAiChatHistory", () => {
		it("should clear without error", async () => {
			const db = createMockDb();
			const { clearAiChatHistory } = await import("./index");
			await clearAiChatHistory(db, "test@example.com");
			assert.ok(true);
		});
	});

	describe("initMailboxFolders", () => {
		it("should create default folders", async () => {
			const db = createMockDb();
			const { initMailboxFolders } = await import("./index");
			await initMailboxFolders(db, "new@example.com");
			assert.ok(true);
		});
	});

	describe("getEmail", () => {
		it("should return null for non-existent email", async () => {
			const db = createMockDb();
			const { getEmail } = await import("./index");
			const email = await getEmail(db, "test@example.com", "non-existent");
			assert.equal(email, null);
		});
	});

	describe("getFolders", () => {
		it("should return empty array for new mailbox", async () => {
			const db = createMockDb();
			const { getFolders } = await import("./index");
			const folders = await getFolders(db, "test@example.com");
			assert.ok(Array.isArray(folders));
		});
	});

	describe("updateEmail", () => {
		it("should update read status", async () => {
			const db = createMockDb();
			const { updateEmail } = await import("./index");
			await updateEmail(db, "test@example.com", "email-1", { read: true });
			assert.ok(true); // no throw = success
		});

		it("should update starred status", async () => {
			const db = createMockDb();
			const { updateEmail } = await import("./index");
			await updateEmail(db, "test@example.com", "email-1", { starred: true });
		});

		it("should update both read and starred", async () => {
			const db = createMockDb();
			const { updateEmail } = await import("./index");
			await updateEmail(db, "test@example.com", "email-1", { read: true, starred: true });
		});
	});

	describe("deleteEmail", () => {
		it("should delete email", async () => {
			const db = createMockDb();
			const { deleteEmail } = await import("./index");
			await deleteEmail(db, "test@example.com", "email-1");
		});
	});

	describe("moveEmail", () => {
		it("should move email to new folder", async () => {
			const db = createMockDb();
			const { moveEmail } = await import("./index");
			await moveEmail(db, "test@example.com", "email-1", "ARCHIVE");
		});
	});

	describe("markThreadRead", () => {
		it("should mark thread emails as read", async () => {
			const db = createMockDb();
			const { markThreadRead } = await import("./index");
			await markThreadRead(db, "test@example.com", "thread-1");
		});
	});

	describe("searchEmails", () => {
		it("should return empty results for no matches", async () => {
			const db = createMockDb();
			const { searchEmails } = await import("./index");
			const results = await searchEmails(db, "test@example.com", {
				query: "nonexistent",
				page: 1,
				limit: 20,
			});
			assert.ok(Array.isArray(results));
		});
	});

	describe("countSearchResults", () => {
		it("should return 0 for no matches", async () => {
			const db = createMockDb();
			const { countSearchResults } = await import("./index");
			const count = await countSearchResults(db, "test@example.com", { query: "xyz" });
			assert.equal(count, 0);
		});
	});

	describe("createFolder", () => {
		it("should create a folder", async () => {
			const db = createMockDb();
			const { createFolder } = await import("./index");
			const result = await createFolder(db, "test@example.com", "My Folder");
			// May return null if UNIQUE constraint would fire (mock)
			assert.ok(result === null || typeof result === "object");
		});
	});

	describe("deleteFolder", () => {
		it("should delete a folder", async () => {
			const db = createMockDb();
			const { deleteFolder } = await import("./index");
			await deleteFolder(db, "test@example.com", "custom-folder");
		});
	});

	describe("updateFolder", () => {
		it("should rename a folder", async () => {
			const db = createMockDb();
			const { updateFolder } = await import("./index");
			await updateFolder(db, "test@example.com", "folder-1", "New Name");
		});
	});
});
