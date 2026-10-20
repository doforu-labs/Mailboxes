// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or at https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Contract tests for the reshaping layer — the last place that decides what an
 * external caller actually sees.
 *
 * Three facts were wrong or missing here and all three are silent failures: a
 * caller cannot tell a bug from an empty mailbox.
 *
 *   • `count` was `emails.length`, i.e. the size of ONE PAGE, under a name that
 *     promises a total. An agent that reads "count: 3" concludes the inbox
 *     holds three emails and stops paginating.
 *   • There was no `has_more`, so the only way to know was to reconstruct it
 *     from `page` / `limit` — which most callers never send.
 *   • A `*@domain` catch-all mailbox looked exactly like a personal mailbox.
 *     Scoping a key to it reads like "one address" and actually means "every
 *     address on the domain".
 *
 * These are pure-function tests: no D1, no R2, no network.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { reshapeToolOutput } from "./external-tools";

type EmailPage = {
	emails: Array<{ id: string }>;
	count: number;
	returned: number;
	has_more: boolean;
};

type MailboxList = {
	mailboxes: Array<{ email: string; created_at: string | null; catch_all?: boolean }>;
	count: number;
};

/** A raw tool payload of `n` rows, as `list_emails` would return a page. */
function rawPage(n: number): unknown {
	return Array.from({ length: n }, (_, i) => ({
		id: `id-${i}`,
		subject: `subject ${i}`,
		sender: "someone@example.com",
		date: "2026-01-02T03:04:05.000Z",
		read: 1,
	}));
}

describe("list reshaping: count vs returned vs has_more", () => {
	it("counts the TOTAL across pages and says whether more exist", () => {
		// Page 1 of 25-per-page, 137 emails in the folder.
		const out = reshapeToolOutput("list_emails", rawPage(25), {
			total: 137,
			limit: 25,
			page: 1,
		}) as EmailPage;

		assert.strictEqual(out.returned, 25, "this page holds 25 rows");
		assert.strictEqual(out.count, 137, "`count` is the folder total, not the page");
		assert.strictEqual(out.has_more, true);
	});

	it("has_more is false once the last page is in hand", () => {
		// Page 6 of 25-per-page, 137 emails: rows 126..137, so the page is short.
		const out = reshapeToolOutput("list_emails", rawPage(12), {
			total: 137,
			limit: 25,
			page: 6,
		}) as EmailPage;

		assert.strictEqual(out.returned, 12);
		assert.strictEqual(out.count, 137);
		assert.strictEqual(out.has_more, false);
	});

	it("a last page that is exactly full still reports no more", () => {
		// 50 emails, page 2 of 25 → 25 rows, but nothing after them.
		const out = reshapeToolOutput("list_emails", rawPage(25), {
			total: 50,
			limit: 25,
			page: 2,
		}) as EmailPage;

		assert.strictEqual(out.has_more, false, "an exactly-full page is not proof of more");
	});

	it("degrades honestly when the total is unavailable", () => {
		// No total (count query failed / caller used a non-list tool): the
		// honest statement is "at least this many", never a fabricated total.
		const full = reshapeToolOutput("search_emails", rawPage(25), { limit: 25 }) as EmailPage;
		assert.strictEqual(full.count, 25, "falls back to what the page proves");
		assert.strictEqual(full.has_more, true, "a full page may hide more");

		const partial = reshapeToolOutput("search_emails", rawPage(3), { limit: 25 }) as EmailPage;
		assert.strictEqual(partial.count, 3);
		assert.strictEqual(partial.has_more, false, "a short page cannot have more");
	});

	it("search_emails keeps the folder_name projection", () => {
		const raw = [
			{
				id: "id-0",
				subject: "s",
				sender: "someone@example.com",
				date: "2026-01-02T03:04:05.000Z",
				folder_name: "Archive",
			},
		];
		const out = reshapeToolOutput("search_emails", raw, { total: 1, limit: 25, page: 1 }) as {
			emails: Array<Record<string, unknown>>;
		};
		assert.strictEqual(out.emails[0].folder, "Archive");
	});
});

describe("list_mailboxes: catch-all mailboxes are labelled", () => {
	it("flags a `*@domain` mailbox and leaves ordinary ones unmarked", () => {
		const raw = [
			{ email: "*@domain.test", created_at: "2026-01-01T00:00:00.000Z" },
			{ email: "person@domain.test", created_at: "2026-01-02T00:00:00.000Z" },
		];
		const out = reshapeToolOutput("list_mailboxes", raw) as MailboxList;

		assert.strictEqual(out.count, 2);
		assert.strictEqual(out.mailboxes[0].catch_all, true, "a catch-all must announce itself");
		assert.strictEqual(
			out.mailboxes[1].catch_all,
			undefined,
			"an ordinary mailbox carries no such flag",
		);
		// The address itself is untouched: it is still the id a caller must send.
		assert.strictEqual(out.mailboxes[0].email, "*@domain.test");
	});
});

describe("reshaping leaves the other tools alone", () => {
	it("passes a non-read tool's status object straight through", () => {
		const status = { status: "draft_saved", draftId: "d1", message: "ok" };
		assert.strictEqual(reshapeToolOutput("draft_email", status), status);
	});
});
