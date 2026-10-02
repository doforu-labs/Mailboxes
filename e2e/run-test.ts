// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
/**
 * Standalone E2E test: Verify MX Record functionality
 * Runs with `npx tsx e2e/run-test.ts`
 *
 * Fix applied: Replaced dns.promises.resolveMx with Cloudflare DoH API
 * to avoid node:dns polyfill compatibility issues in Workers runtime.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Save screenshots next to this script, regardless of the working directory.
const __dirname = dirname(fileURLToPath(import.meta.url));
const shot = (name: string) => join(__dirname, name);

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const TEST_DOMAIN = process.env.TEST_DOMAIN || "example.com";

async function runTests() {
  let passed = 0;
  let failed = 0;

  console.log(`\n🧪 Testing against: ${BASE_URL}\n`);

  // ── Test 1: API endpoint works ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 1: API endpoint returns correct MX records");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  try {
    const res = await fetch(`${BASE_URL}/api/v1/setup/verify-mx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: TEST_DOMAIN }),
    });
    const body = (await res.json()) as {
      verified: boolean;
      records: Array<{ priority: number; exchange: string }>;
      matched: { priority: number; exchange: string } | null;
    };

    console.log(`  Status: ${res.status}`);
    console.log(`  Response: ${JSON.stringify(body, null, 2)}`);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!body.verified) throw new Error("MX record not verified");
    if (!body.records || body.records.length === 0)
      throw new Error("No MX records returned");
    if (!body.matched) throw new Error("MX record not matched");

    console.log("  ✅ PASSED\n");
    passed++;
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  }

  // ── Test 2: Invalid domain handled gracefully ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 2: Invalid domain returns verified=false (no crash)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  try {
    const res = await fetch(`${BASE_URL}/api/v1/setup/verify-mx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "this-domain-does-not-exist-12345.com" }),
    });
    const body = (await res.json()) as {
      verified: boolean;
      records: Array<unknown>;
    };

    console.log(`  Status: ${res.status}`);
    console.log(`  Response: ${JSON.stringify(body, null, 2)}`);

    if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
    if (body.verified !== false) throw new Error("Expected verified=false");

    console.log("  ✅ PASSED\n");
    passed++;
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  }

  // ── Test 3: Browser - No ErrorBoundary on setup page ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 3: Browser - No ErrorBoundary on setup page");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Track console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Track uncaught errors
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    console.log(`  Navigating to ${BASE_URL}/setup ...`);
    const response = await page.goto(`${BASE_URL}/setup`, {
      waitUntil: "networkidle",
      timeout: 20000,
    });

    console.log(`  Page status: ${response?.status()}`);
    const title = await page.title();
    console.log(`  Page title: ${title}`);

    // Check for ErrorBoundary
    const errorBoundary = page.locator("text=Something went wrong");
    const isVisible = await errorBoundary.isVisible().catch(() => false);

    if (isVisible) {
      throw new Error("ErrorBoundary IS visible on the page!");
    }

    // Check for page errors
    if (pageErrors.length > 0) {
      console.log(`  ⚠️  Page errors detected: ${pageErrors.join(", ")}`);
    }
    if (consoleErrors.length > 0) {
      console.log(
        `  ⚠️  Console errors detected: ${consoleErrors.join(", ")}`
      );
    }

    // Take a screenshot
    await page.screenshot({
      path: shot("setup-page.png"),
      fullPage: true,
    });
    console.log("  📸 Screenshot saved: e2e/setup-page.png");

    // If we can find domain input and verify button, test the full flow
    const domainInput = page.locator(
      'input[placeholder*="domain" i], input[placeholder*="Domain" i], input[name="domain"]'
    );

    if ((await domainInput.count()) > 0) {
      console.log("  Found domain input, filling with test domain...");
      await domainInput.first().fill(TEST_DOMAIN);

      const verifyBtn = page.locator(
        'button:has-text("Verify MX"), button:has-text("verify MX")'
      );
      if ((await verifyBtn.count()) > 0) {
        console.log("  Found Verify MX Record button, clicking...");

        // Listen for API response
        const [apiResponse] = await Promise.all([
          page.waitForResponse(
            (resp) =>
              resp.url().includes("/api/v1/setup/verify-mx") &&
              resp.request().method() === "POST",
            { timeout: 15000 }
          ),
          verifyBtn.first().click(),
        ]);

        const apiBody = await apiResponse.json();
        console.log(
          `  API response: ${JSON.stringify(apiBody, null, 2)}`
        );

        if (!apiResponse.ok()) {
          throw new Error(
            `MX verify API returned ${apiResponse.status()}`
          );
        }
        if (!apiBody.verified) {
          throw new Error("MX verification failed in browser");
        }

        // Wait for UI to update
        await page.waitForTimeout(2000);

        // Verify no ErrorBoundary after clicking
        const errorAfterClick = await errorBoundary
          .isVisible()
          .catch(() => false);
        if (errorAfterClick) {
          throw new Error(
            "ErrorBoundary appeared after clicking Verify MX!"
          );
        }

        // Take screenshot of success state
        await page.screenshot({
          path: shot("mx-verified.png"),
          fullPage: true,
        });
        console.log(
          "  📸 Screenshot saved: e2e/mx-verified.png"
        );
      } else {
        console.log(
          "  ℹ️  Verify MX button not found, skipping browser click test"
        );
      }
    } else {
      console.log(
        "  ℹ️  Domain input not found on page, skipping browser interaction test"
      );
      // Still valid - the page loaded without ErrorBoundary
    }

    console.log("  ✅ PASSED\n");
    passed++;
    await context.close();
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  } finally {
    await browser?.close();
  }

  // ── Summary ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
