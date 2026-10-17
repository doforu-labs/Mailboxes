// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt

/**
 * Regression coverage for the sender line under an opened message header.
 *
 * The bug: the detail panel rendered only the bare `message.toLabel` line, so
 * users saw "To: …" alone and concluded the sender had not been rendered at
 * all. `MessageAddressLines` now always renders the sender line next to the
 * recipient line — in both the single-message view and the expanded thread
 * view — so the assertions that matter are:
 *
 *   1. the sender line is rendered at all,
 *   2. it precedes the recipient line in the DOM, and
 *   3. the sender is never dropped, i.e. the number of From: lines equals the
 *      number of To: lines (the bug was exactly that imbalance).
 *
 * Why text assertions and no `data-testid`: both lines are plain
 * `<div>{t(...)}</div>` siblings whose rendered text (`From: Name <addr>`) is
 * unique on the page, so `getByText(..., { exact: true })` is unambiguous here
 * and keeps working if the header is restyled. Adding a test-only
 * `data-testid` would have meant touching production code for a fix whose
 * visible contract — the rendered text — is already exactly assertable.
 *
 * Preconditions:
 *   - `npm run dev` is serving http://localhost:5173 (cold start takes ~40-50s;
 *     `beforeAll` polls for it up to DEV_READY_TIMEOUT_MS).
 *   - The local D1 has the seed applied (mailbox `inbox@demo.local` with the
 *     `seed-*@demo.local` messages).
 *
 * Auth: there is no dev bypass, so this spec plants a fixed, far-future session
 * row in the local D1 `sessions` table (`INSERT OR REPLACE`) and injects the
 * same value as the `mailboxes_session` cookie. Re-running overwrites the row
 * with an identical one, so the spec is idempotent. The row is intentionally
 * left behind: deleting it would race with sessions owned by the developer's
 * own browser. Nothing else in D1 is written: the spec never sends, moves or
 * deletes mail.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The system Chrome is used because this repo does not vendor Playwright's
// browser binaries (`~/Library/Caches/ms-playwright` may not exist).
test.use({ channel: "chrome" });

// The config's global timeout (30s) is tight here: each test shells out to
// `npx wrangler d1 execute` (slow process start) and then waits for a fresh
// client-side render. Budget for both instead of racing the default.
test.setTimeout(120_000);

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const MAILBOX = "inbox@demo.local";
const INBOX_PATH = `/mailbox/${MAILBOX}/emails/inbox`;

// Fixed token, stable across runs, shaped like the real thing (64 hex chars).
const E2E_SESSION_TOKEN =
	"e2e0000000000000000000000000000000000000000000000000000000000e2e";
const SESSION_COOKIE = "mailboxes_session";
const LOCALE_COOKIE = "lang";

// Seeded fixtures.
const SINGLE_SUBJECT = "Q1 roadmap review notes"; // thread t2, only itself -> SingleMessageView
const THREAD_SUBJECT = "Welcome to your new mailbox"; // thread t1 -> ThreadMessage

const EN_FROM_SINGLE = "From: Priya M <pm@acme.dev>";
const EN_TO_SINGLE = "To: inbox@demo.local";
const EN_FROM_THREAD = "From: Acme Team <hello@acme.dev>";
const ZH_FROM_SINGLE = "发件人：Priya M <pm@acme.dev>";
const ZH_TO_SINGLE = "收件人：inbox@demo.local";

const DEV_READY_TIMEOUT_MS = Number(process.env.DEV_READY_TIMEOUT_MS || 120_000);
const RENDER_TIMEOUT_MS = 15_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Helpers ─────────────────────────────────────────────────────────

/** Make sure the dev server answers before Playwright starts driving a page. */
test.beforeAll(async ({ request }) => {
	const deadline = Date.now() + DEV_READY_TIMEOUT_MS;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const res = await request.get(`${BASE_URL}/login`, { timeout: 5_000 });
			if (res.status() < 500) return;
			lastError = new Error(`GET /login -> ${res.status()}`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(
		`Dev server at ${BASE_URL} did not become ready within ${DEV_READY_TIMEOUT_MS}ms. ` +
			`Start it with \`npm run dev\`. Last error: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`,
	);
});

/**
 * Plant a valid admin session in the local D1 so the app does not bounce every
 * `/api/v1/*` call to /login. `INSERT OR REPLACE` keeps the spec repeatable.
 */
function seedLocalSession(): void {
	execFileSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"mailboxes-db",
			"--local",
			"--command",
			`INSERT OR REPLACE INTO sessions (token, created_at, expires_at) ` +
				`VALUES ('${E2E_SESSION_TOKEN}', datetime('now'), '2099-01-01T00:00:00.000Z');`,
		],
		{ cwd: repoRoot, stdio: "pipe", timeout: 120_000 },
	);
}

/** Pin the session and the copy: an explicit `lang` cookie is the stable way. */
async function seedContext(context: BrowserContext, locale: "en" | "zh"): Promise<void> {
	seedLocalSession();
	await context.addCookies([
		{ name: SESSION_COOKIE, value: E2E_SESSION_TOKEN, domain: "localhost", path: "/" },
		{ name: LOCALE_COOKIE, value: locale, domain: "localhost", path: "/" },
	]);
}

/** Escape regex metacharacters so a subject can be used as a literal pattern. */
function literal(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Click, and retry until `isDone()` reports success.
 *
 * Opening a row and expanding a thread message are React state updates that a
 * background refetch (the list polls every 30s) can reset right after the
 * click. Retrying the click, rather than sleeping and hoping, keeps the spec
 * deterministic without weakening the assertions that follow.
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
			// Give React a beat to commit before re-checking.
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

	// A rejected session makes every query 401 and the app redirect to /login;
	// surface that explicitly instead of as a mysterious missing-element error.
	await expect(page, "the app must not redirect to /login (session cookie rejected?)")
		.not.toHaveURL(/\/login/, { timeout: RENDER_TIMEOUT_MS });

	const row = page.getByRole("button", { name: new RegExp(literal(subject)) }).first();
	await expect(row, `inbox row "${subject}" should be listed`).toBeVisible({
		timeout: RENDER_TIMEOUT_MS,
	});
	await clickUntil(
		row,
		async () => (await page.getByRole("heading", { name: subject }).count()) > 0,
		`opening "${subject}" in the detail panel`,
	);
}

/**
 * The detail (reading) panel, identified by its `<h2>` subject heading. The
 * inbox list and the panel both contain the sender name, so panel-scoped
 * selectors are needed to avoid clicking the list row by accident.
 */
const detailPanel = (page: Page) =>
	page.locator("div.flex.flex-col.h-full").filter({ has: page.locator("h2") }).first();

type AddressFamily = "from" | "to";

const LABEL_PREFIX: Record<"en" | "zh", Record<AddressFamily, string>> = {
	en: { from: "From:", to: "To:" },
	zh: { from: "发件人：", to: "收件人：" },
};

/**
 * The rendered address lines: the childless `<div>`s emitted by
 * `MessageAddressLines`, matched by their localised label prefix rather than by
 * class name, so restyling the header cannot break this test.
 */
const addressLines = (page: Page, locale: "en" | "zh", family: AddressFamily) =>
	page
		.locator("div:not(:has(*))")
		.filter({ hasText: new RegExp(`^\\s*${literal(LABEL_PREFIX[locale][family])}`) });

// ── Tests ───────────────────────────────────────────────────────────

test.describe("message address lines", () => {
	test("single message view (en) shows the sender line above the recipient line", async ({
		page,
		context,
	}) => {
		await seedContext(context, "en");
		await openMessage(page, SINGLE_SUBJECT);

		const from = page.getByText(EN_FROM_SINGLE, { exact: true });
		const to = page.getByText(EN_TO_SINGLE, { exact: true });

		await expect(from, "single view must render the From: line").toBeVisible({
			timeout: RENDER_TIMEOUT_MS,
		});
		await expect(to, "single view must render the To: line").toBeVisible({
			timeout: RENDER_TIMEOUT_MS,
		});

		// The bug read as "the sender was never rendered"; DOM order is the fix.
		const fromBeforeTo = await from.evaluate((node, toText) => {
			const other = Array.from(document.querySelectorAll("div:not(:has(*))")).find(
				(el) => el.textContent?.trim() === toText,
			);
			if (!other) throw new Error(`counterpart line "${toText}" not found`);
			return Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
		}, EN_TO_SINGLE);
		expect(
			fromBeforeTo,
			`"${EN_FROM_SINGLE}" must appear before "${EN_TO_SINGLE}" in the DOM`,
		).toBe(true);

		// The essence of the bug: never more To: lines than From: lines.
		await expect(addressLines(page, "en", "from")).toHaveCount(1);
		await expect(addressLines(page, "en", "to")).toHaveCount(1);
	});

	test("expanded thread message (en) shows the From: line", async ({ page, context }) => {
		await seedContext(context, "en");
		await openMessage(page, THREAD_SUBJECT);

		// A thread renders collapsed headers first; the address block only
		// exists once a message is expanded.
		await expect(addressLines(page, "en", "from")).toHaveCount(0);

		// Scope to the panel: the inbox row for this thread also contains
		// "Acme Team", and clicking that would merely re-select the row. The
		// panel header is the candidate that does not quote the subject.
		const collapsedHeader = detailPanel(page)
			.locator("button")
			.filter({ hasText: /Acme Team/ })
			.filter({ hasNotText: new RegExp(literal(THREAD_SUBJECT)) })
			.last();
		await expect(collapsedHeader, "the thread's collapsed header should be visible").toBeVisible({
			timeout: RENDER_TIMEOUT_MS,
		});
		await clickUntil(
			collapsedHeader,
			async () => (await addressLines(page, "en", "from").count()) > 0,
			"expanding the thread message",
		);

		const from = page.getByText(EN_FROM_THREAD, { exact: true });
		const to = page.getByText(EN_TO_SINGLE, { exact: true }).first();
		await expect(from, "expanded thread message must render the From: line").toBeVisible({
			timeout: RENDER_TIMEOUT_MS,
		});
		await expect(to, "expanded thread message must render the To: line").toBeVisible({
			timeout: RENDER_TIMEOUT_MS,
		});

		// Sender and recipient lines are rendered as a symmetric pair.
		expect(
			await addressLines(page, "en", "from").count(),
			"every From: line must be paired with a To: line",
		).toBe(await addressLines(page, "en", "to").count());
	});

	test("chinese locale renders the localised 发件人/收件人 labels", async ({ page, context }) => {
		await seedContext(context, "zh");
		await openMessage(page, SINGLE_SUBJECT);

		const from = page.getByText(ZH_FROM_SINGLE, { exact: true });
		const to = page.getByText(ZH_TO_SINGLE, { exact: true });

		await expect(
			from,
			"zh must render the 发件人 line from mailPanel.message.fromLabel",
		).toBeVisible({ timeout: RENDER_TIMEOUT_MS });
		await expect(to, "zh must render the 收件人 line").toBeVisible({
			timeout: RENDER_TIMEOUT_MS,
		});

		await expect(addressLines(page, "zh", "from")).toHaveCount(1);
		await expect(addressLines(page, "zh", "to")).toHaveCount(1);
	});
});
