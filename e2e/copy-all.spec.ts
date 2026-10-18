// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression coverage for the toolbar "copy all" action.
 *
 * The bug being defended against: Ctrl+A cannot copy an opened email in full.
 * The body is rendered by `EmailIframe` inside a sandboxed iframe that
 * deliberately omits `allow-same-origin`, so the body is its own
 * opaque-origin document and browser selection — which is scoped per document —
 * can only ever cover one of the two documents. With focus in the body, Ctrl+A
 * yields the message text without subject/sender; with focus outside it, the
 * body is unreachable.
 *
 * The fix is a toolbar button that assembles the same content as plain text.
 * The assertions that matter are therefore:
 *
 *   1. the button exists and is labelled per locale,
 *   2. the clipboard really contains the header block (subject / from / to /
 *      cc / date) *and* the body text, as plain text rather than markup,
 *   3. a thread copies every message in the conversation — including the ones
 *      that are still collapsed on screen,
 *   4. the success toast fires, i.e. the copy path reported success.
 *
 * Preconditions:
 *   - `npm run dev` is serving (default `http://localhost:5173`; override with
 *     `BASE_URL`). Cold start takes ~40-50s, hence the `beforeAll` poll.
 *   - Local D1 has the seed applied. This spec writes its own fixtures with an
 *     `e2e-copy-` id prefix and removes them in `afterAll` (and again up front,
 *     so a crashed earlier run cannot break the next one).
 *
 * Auth: there is no dev bypass, so this spec plants a fixed, far-future session
 * row in the local D1 `sessions` table and injects the same value as the
 * `mailboxes_session` cookie — the same approach as
 * `message-address-lines.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The system Chrome is used because this repo does not vendor Playwright's
// browser binaries.
test.use({ channel: "chrome" });

// Each test drives a cold-start dev server, and the one-off D1 seeding add a
// wrangler process start on top. The config's 30s default is far too tight.
test.setTimeout(240_000);

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const MAILBOX = "inbox@demo.local";
const INBOX_PATH = `/mailbox/${MAILBOX}/emails/inbox`;

const E2E_SESSION_TOKEN =
	"e2e0000000000000000000000000000000000000000000000000000000000e2e";
const SESSION_COOKIE = "mailboxes_session";
const LOCALE_COOKIE = "lang";

// ── Fixtures ────────────────────────────────────────────────────────
//
// Two conversations: one with a single message (`SingleMessageView`), one with
// two messages (`ThreadMessage` list). Bodies are wrapped in markup on purpose:
// the copied text must be plain, so any surviving `<p>` / `<b>` is a defect.

const FIXTURE_PREFIX = "e2e-copy-";
const SINGLE_ID = `${FIXTURE_PREFIX}single`;
const SINGLE_THREAD = `${FIXTURE_PREFIX}t-single`;
const THREAD_MSG_1 = `${FIXTURE_PREFIX}thr-1`;
const THREAD_MSG_2 = `${FIXTURE_PREFIX}thr-2`;
const THREAD_THREAD = `${FIXTURE_PREFIX}t-thread`;

const SINGLE_SUBJECT = "E2E copy single QZ1";
const THREAD_SUBJECT = "E2E copy thread QZ2";
const THREAD_REPLY_SUBJECT = `Re: ${THREAD_SUBJECT}`;

const SINGLE_BODY_MARKER = "QZ1BODY";
const THREAD_BODY_MARKER_1 = "QZ2ONE";
const THREAD_BODY_MARKER_2 = "QZ2TWO";

/** Separator emitted by `buildEmailClipboardText` between messages. */
const MESSAGE_DIVIDER = "----------------------------------------";

const LABELS = {
	en: {
		subject: "Subject:",
		from: "From:",
		to: "To:",
		cc: "Cc:",
		date: "Date:",
		button: "Copy all (with subject and addresses)",
		toast: "Copied the full email",
	},
	zh: {
		subject: "主题:",
		from: "发件人:",
		to: "收件人:",
		cc: "抄送:",
		date: "时间:",
		button: "复制全文（含主题和收发件人）",
		toast: "已复制完整邮件内容",
	},
} as const;

const DEV_READY_TIMEOUT_MS = Number(process.env.DEV_READY_TIMEOUT_MS || 120_000);
const RENDER_TIMEOUT_MS = 20_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── D1 helpers ──────────────────────────────────────────────────────

/**
 * Run SQL against the local D1.
 *
 * The local `wrangler` binary is used instead of `npx wrangler`: under the test
 * runner `npx` can decide it needs to fetch the package first and then blocks
 * on a piping-unfriendly confirmation prompt, which surfaces as a spawn
 * timeout rather than as a D1 error.
 */
function d1(sql: string): void {
	execFileSync(path.join(repoRoot, "node_modules", ".bin", "wrangler"), [
		"d1",
		"execute",
		"mailboxes-db",
		"--local",
		"--command",
		sql,
	], { cwd: repoRoot, stdio: "pipe", timeout: 180_000 });
}

/**
 * Plant a valid admin session in the local D1 so the app does not bounce every
 * `/api/v1/*` call to /login, then (re)create the fixtures.
 *
 * One `wrangler` invocation for everything: each call costs ~20s of process
 * start plus local-D1 lock acquisition, so the session row, the leftover
 * cleanup and the fixture insert are sent as a single multi-statement command.
 * `INSERT OR REPLACE` and the leading `DELETE` keep the spec repeatable.
 */
function seedDatabase(): void {
	d1(
		`INSERT OR REPLACE INTO sessions (token, created_at, expires_at) ` +
			`VALUES ('${E2E_SESSION_TOKEN}', datetime('now'), '2099-01-01T00:00:00.000Z'); ` +
			`DELETE FROM emails WHERE id LIKE '${FIXTURE_PREFIX}%'; ` +
			fixtureInsertSql(),
	);
}

function removeFixtures(): void {
	d1(`DELETE FROM emails WHERE id LIKE '${FIXTURE_PREFIX}%';`);
}

function fixtureInsertSql(): string {
	// Columns mirror the `emails` schema; `send_status` stays NULL because none
	// of these fixtures is an outgoing message.
	return (
		`INSERT OR REPLACE INTO emails ` +
		`(id, mailbox_id, folder_id, subject, sender, sender_name, recipient, cc, bcc, date, read, starred, body, thread_id, send_status) VALUES ` +
		`('${SINGLE_ID}', '${MAILBOX}', 'inbox', '${SINGLE_SUBJECT}', 'qa@copy.test', 'Copy QA', '${MAILBOX}', 'cc@copy.test', NULL, '2026-03-01T10:00:00.000Z', 1, 0, '<p>Single body marker <b>${SINGLE_BODY_MARKER}</b></p>', '${SINGLE_THREAD}', NULL), ` +
		`('${THREAD_MSG_1}', '${MAILBOX}', 'inbox', '${THREAD_SUBJECT}', 'alice@copy.test', 'Alice Copy', '${MAILBOX}', NULL, NULL, '2026-03-02T10:00:00.000Z', 1, 0, '<p>Thread body one ${THREAD_BODY_MARKER_1}</p>', '${THREAD_THREAD}', NULL), ` +
		`('${THREAD_MSG_2}', '${MAILBOX}', 'inbox', '${THREAD_REPLY_SUBJECT}', 'bob@copy.test', 'Bob Copy', 'alice@copy.test', NULL, NULL, '2026-03-03T10:00:00.000Z', 1, 0, '<div>Thread body two ${THREAD_BODY_MARKER_2}</div>', '${THREAD_THREAD}', NULL);`
	);
}

// ── Page helpers ────────────────────────────────────────────────────

/** Make sure the dev server answers before Playwright starts driving a page. */
test.beforeAll(async ({ request }) => {
	const deadline = Date.now() + DEV_READY_TIMEOUT_MS;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const res = await request.get(`${BASE_URL}/login`, { timeout: 5_000 });
			if (res.status() < 500) break;
			lastError = new Error(`GET /login -> ${res.status()}`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	if (Date.now() >= deadline) {
		throw new Error(
			`Dev server at ${BASE_URL} did not become ready within ${DEV_READY_TIMEOUT_MS}ms. ` +
				`Start it with \`npm run dev\`. Last error: ${
					lastError instanceof Error ? lastError.message : String(lastError)
				}`,
		);
	}

	seedDatabase();
});

test.afterAll(() => {
	removeFixtures();
});

function literal(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedContext(context: BrowserContext, locale: "en" | "zh"): Promise<void> {
	await context.addCookies([
		{ name: SESSION_COOKIE, value: E2E_SESSION_TOKEN, domain: "localhost", path: "/" },
		{ name: LOCALE_COOKIE, value: locale, domain: "localhost", path: "/" },
	]);
	// The copy button writes through the async Clipboard API, which needs the
	// origin to hold both permissions; without them the fallback path runs and
	// `readText()` cannot verify the payload.
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin: BASE_URL,
	});
}

/**
 * Click, and retry until `isDone()` reports success. Opening a row is a React
 * state update that a background refetch can reset right after the click.
 */
async function clickUntil(
	target: ReturnType<Page["locator"]>,
	isDone: () => Promise<boolean>,
	description: string,
): Promise<void> {
	const deadline = Date.now() + RENDER_TIMEOUT_MS;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			if (await isDone()) return;
			await target.click({ timeout: 5_000 });
			await new Promise((resolve) => setTimeout(resolve, 300));
			if (await isDone()) return;
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`${description}: still not satisfied after ${RENDER_TIMEOUT_MS}ms of clicking. ` +
			`Last error: ${lastError instanceof Error ? lastError.message : "none"}`,
	);
}

/** Open the inbox and select the row whose subject matches. */
async function openMessage(page: Page, subject: string): Promise<void> {
	await page.goto(`${BASE_URL}${INBOX_PATH}`, { waitUntil: "domcontentloaded" });

	await expect(page, "the app must not redirect to /login (session cookie rejected?)")
		.not.toHaveURL(/\/login/, { timeout: RENDER_TIMEOUT_MS });

	const row = page.getByRole("button", { name: new RegExp(literal(subject)) }).first();
	await expect(row, `inbox row "${subject}" should be listed`).toBeVisible({
		timeout: RENDER_TIMEOUT_MS,
	});
	await clickUntil(
		row,
		async () => (await page.getByRole("heading", { name: new RegExp(literal(subject)) }).count()) > 0,
		`opening "${subject}" in the detail panel`,
	);
}

/** Click the toolbar copy button and return what actually landed on the clipboard. */
async function copyAll(page: Page, locale: "en" | "zh"): Promise<string> {
	const button = page.getByRole("button", { name: LABELS[locale].button });
	await expect(button, "the copy-all button must be in the message toolbar").toBeVisible({
		timeout: RENDER_TIMEOUT_MS,
	});

	// Start from a known clipboard so a stale value from another test cannot pass.
	await page.evaluate(() => navigator.clipboard.writeText("__e2e_cleared__"));

	await button.click();

	// The toast is the app's own signal that the copy path returned success.
	await expect(page.getByText(LABELS[locale].toast)).toBeVisible({
		timeout: RENDER_TIMEOUT_MS,
	});

	return page.evaluate(() => navigator.clipboard.readText());
}

/** Markup that must never survive into the plain-text payload. */
function expectNoMarkup(text: string): void {
	for (const marker of ["<p>", "</p>", "<div>", "</div>", "<b>", "</b>", "style="]) {
		expect(text, `copied text must not contain markup (${marker})`).not.toContain(marker);
	}
}

// ── Tests ───────────────────────────────────────────────────────────

/**
 * React dev builds log two kinds of noise on *every* page of this app:
 *
 *   - a stale React DevTools version banner, and
 *   - `Each child in a list should have a unique "key" prop` warnings from
 *     components that predate this change (`Layout`, `Sidebar`, `Header`,
 *     `EmailPanelToolbar`, `SingleMessageView`, `EmailPanel`, …).
 *
 * Baseline measured on an unmodified tree while writing this spec: the same 9
 * unique messages appear without the copy button, so they say nothing about the
 * feature under test. Filtering them keeps the "no console errors" assertion
 * meaningful — anything the copy path breaks still fails.
 */
const DEV_CONSOLE_NOISE = [/React DevTools/, /unique "key" prop/];

function realConsoleErrors(messages: string[]): string[] {
	return messages.filter((message) => !DEV_CONSOLE_NOISE.some((re) => re.test(message)));
}

test.describe("copy all from the message toolbar", () => {
	test("copies the full single message (en): headers plus plain-text body", async ({
		page,
		context,
	}) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});
		page.on("pageerror", (err) => consoleErrors.push(err.message));

		await seedContext(context, "en");
		await openMessage(page, SINGLE_SUBJECT);

		const text = await copyAll(page, "en");

		const labels = LABELS.en;
		expect(text, "the subject line must be copied").toContain(
			`${labels.subject} ${SINGLE_SUBJECT}`,
		);
		expect(text, "the sender line must carry name and address").toContain(
			`${labels.from} Copy QA <qa@copy.test>`,
		);
		expect(text, "the recipient line must be copied").toContain(
			`${labels.to} ${MAILBOX}`,
		);
		expect(text, "the cc line must be copied").toContain(`${labels.cc} cc@copy.test`);
		expect(text, "the date line must be copied").toMatch(/Date: .+\d/);
		expect(text, "the body text must be copied").toContain(
			`Single body marker ${SINGLE_BODY_MARKER}`,
		);
		expectNoMarkup(text);

		// A single message must not be split by the thread separator.
		expect(text).not.toContain(MESSAGE_DIVIDER);

		expect(realConsoleErrors(consoleErrors), "the copy flow must not log console errors").toEqual([]);
	});

	test("copies every message of a thread, including collapsed ones (en)", async ({
		page,
		context,
	}) => {
		await seedContext(context, "en");
		await openMessage(page, THREAD_SUBJECT);

		// Only the newest message is expanded by default, so the second body is
		// not on screen — it must still make it into the copy.
		await page.getByRole("heading", { name: THREAD_SUBJECT }).first().waitFor({
			timeout: RENDER_TIMEOUT_MS,
		});

		const text = await copyAll(page, "en");

		expect(text, "the oldest message body must be copied").toContain(THREAD_BODY_MARKER_1);
		expect(text, "the newest message body must be copied").toContain(THREAD_BODY_MARKER_2);
		expect(text, "each message must keep its own sender").toContain(
			"From: Alice Copy <alice@copy.test>",
		);
		expect(text).toContain("From: Bob Copy <bob@copy.test>");
		expect(
			text.split(MESSAGE_DIVIDER).length - 1,
			"two messages must be separated by exactly one divider",
		).toBe(1);
		expectNoMarkup(text);
	});

	test("uses the localised labels in chinese", async ({ page, context }) => {
		await seedContext(context, "zh");
		await openMessage(page, SINGLE_SUBJECT);

		const text = await copyAll(page, "zh");
		const labels = LABELS.zh;

		expect(text).toContain(`${labels.subject} ${SINGLE_SUBJECT}`);
		expect(text).toContain(`${labels.from} Copy QA <qa@copy.test>`);
		expect(text).toContain(`${labels.to} ${MAILBOX}`);
		expect(text).toContain(`${labels.cc} cc@copy.test`);
		expect(text, "the zh date label must be used").toMatch(/时间: .+\d/);

		// Guard against a half-translated payload.
		expect(text).not.toContain("Subject:");
		expect(text).not.toContain("From:");
	});
});
