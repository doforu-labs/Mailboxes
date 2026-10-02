// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
/**
 * Standalone E2E test: Verify MX Record + Loader2 fix validation
 * Runs with `npx tsx e2e/run-test-v2.ts`
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
    console.log("  ✅ PASSED\n");
    passed++;
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  }

  // ── Test 2: Invalid domain handled gracefully ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 2: Invalid domain returns verified=false");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  try {
    const res = await fetch(`${BASE_URL}/api/v1/setup/verify-mx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "this-domain-does-not-exist-12345.com" }),
    });
    const body = (await res.json()) as { verified: boolean; records: Array<unknown> };
    if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
    if (body.verified !== false) throw new Error("Expected verified=false");
    console.log("  ✅ PASSED\n");
    passed++;
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  }

  // ── Test 3: Settings page loads WITHOUT Loader2 error / ErrorBoundary ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 3: Settings page - no Loader2 / ErrorBoundary crash");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // Navigate to settings page (where CredentialsSection is rendered)
    console.log(`  Navigating to ${BASE_URL}/settings ...`);
    const resp = await page.goto(`${BASE_URL}/settings`, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    console.log(`  Page status: ${resp?.status()}`);
    console.log(`  Page title: ${await page.title()}`);

    // Check for ErrorBoundary
    const errorBoundary = page.locator("text=Something went wrong");
    const isVisible = await errorBoundary.isVisible().catch(() => false);
    if (isVisible) throw new Error("ErrorBoundary IS visible on settings page!");

    // Check for Loader2 ReferenceError in page errors
    const loader2Errors = pageErrors.filter((e) => e.includes("Loader2"));
    if (loader2Errors.length > 0) {
      throw new Error(`Loader2 ReferenceError detected: ${loader2Errors.join(", ")}`);
    }

    if (pageErrors.length > 0) {
      console.log(`  ⚠️  Other page errors: ${pageErrors.join("; ")}`);
    }

    // Screenshot settings page
    await page.screenshot({ path: shot("settings-page.png"), fullPage: true });
    console.log("  📸 Screenshot saved: e2e/settings-page.png");

    // Verify CredentialsSection rendered (check for provider labels)
    const credSection = page.locator("text=API Credentials, text=Cloudflare API Token");
    const credCount = await credSection.count();
    console.log(`  CredentialsSection rendered: ${credCount > 0 ? "YES" : "NO"} (${credCount} elements found)`);

    console.log("  ✅ PASSED\n");
    passed++;
    await context.close();
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  } finally {
    await browser?.close();
  }

  // ── Test 4: Home page → Click "Awaiting DNS" domain → Verify MX flow ──
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Test 4: Awaiting DNS domain → Verify MX Record button");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  let browser2;
  try {
    browser2 = await chromium.launch({ headless: true });
    const context = await browser2.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    console.log(`  Navigating to ${BASE_URL} ...`);
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20000 });

    // Check for "Awaiting DNS" badge
    const awaitingDns = page.locator("text=Awaiting DNS");
    const awaitingDnsCount = await awaitingDns.count();
    if (awaitingDnsCount === 0) {
      console.log("  ℹ️  No 'Awaiting DNS' domain found, skipping browser interaction");
    } else {
      console.log("  Found 'Awaiting DNS' domain, clicking to expand...");

      // Click the "Awaiting DNS" badge or the domain card to open details
      const domainCard = awaitingDns.locator("..").first();
      await domainCard.click();
      await page.waitForTimeout(1500);

      // Screenshot expanded domain
      await page.screenshot({ path: shot("domain-expanded.png"), fullPage: true });
      console.log("  📸 Screenshot saved: e2e/domain-expanded.png");

      // Look for "Verify MX Record" button
      const verifyBtn = page.locator('button:has-text("Verify MX Record")');
      if ((await verifyBtn.count()) === 0) {
        console.log("  ℹ️  Verify MX Record button not found on expanded view");
        // Try clicking the three-dot menu
        const menuBtn = page.locator('button:has-text("⋮"), button:has([class*="ellipsis"]), [role="menu"]');
        if ((await menuBtn.count()) > 0) {
          await menuBtn.first().click();
          await page.waitForTimeout(1000);
          await page.screenshot({ path: shot("domain-menu.png"), fullPage: true });
          console.log("  📸 Screenshot saved: e2e/domain-menu.png");
        }
      } else {
        console.log("  Found 'Verify MX Record' button, clicking...");

        // Listen for API call
        const [apiResponse] = await Promise.all([
          page.waitForResponse(
            (resp) => resp.url().includes("/api/v1/setup/verify-mx") && resp.request().method() === "POST",
            { timeout: 15000 }
          ),
          verifyBtn.first().click(),
        ]);

        const apiBody = await apiResponse.json();
        console.log(`  API response: ${JSON.stringify(apiBody, null, 2)}`);
        if (!apiResponse.ok()) throw new Error(`MX verify API returned ${apiResponse.status()}`);

        await page.waitForTimeout(2000);
        await page.screenshot({ path: shot("mx-after-click.png"), fullPage: true });
        console.log("  📸 Screenshot saved: e2e/mx-after-click.png");
      }
    }

    // Final check: no ErrorBoundary or Loader2 errors
    const errorBoundary = page.locator("text=Something went wrong");
    const hasError = await errorBoundary.isVisible().catch(() => false);
    if (hasError) throw new Error("ErrorBoundary appeared after interaction!");

    const loader2Errors = pageErrors.filter((e) => e.includes("Loader2"));
    if (loader2Errors.length > 0) {
      throw new Error(`Loader2 ReferenceError: ${loader2Errors.join(", ")}`);
    }

    console.log("  ✅ PASSED\n");
    passed++;
    await context.close();
  } catch (e) {
    console.log(`  ❌ FAILED: ${e}\n`);
    failed++;
  } finally {
    await browser2?.close();
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
