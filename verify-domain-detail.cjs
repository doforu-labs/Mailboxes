const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // First get domains from home page to find an id
  console.log('=== 1. Fetching domain list from home page ===');
  const resp = await page.goto('https://mailboxes.example.workers.dev/', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  console.log(`Status: ${resp.status()}, URL: ${page.url()}`);

  if (resp.status() === 403 || page.url().includes('cloudflareaccess')) {
    console.log('⚠️  CF Access required. Cannot verify production.');
    await browser.close();
    return;
  }

  await page.waitForTimeout(2000);
  const homeBody = await page.textContent('body') || '';

  // Check if home page has the new links
  const domainLinks = await page.$$('a[href*="/domains/"]');
  console.log(`Domain detail links found on home: ${domainLinks.length}`);

  // Try navigating to domain details for a.example.com
  // First find a link
  if (domainLinks.length > 0) {
    const href = await domainLinks[0].getAttribute('href');
    console.log(`First domain link href: ${href}`);
  }

  // Try direct URL (we know the domains from earlier)
  // We need the domain ID, not the name. Let's try clicking Edit on the first domain.
  // The menu needs to be opened first.

  // Let's try a different approach: check if the API returns domain IDs
  console.log('\n=== 2. Trying domain details page ===');

  // Navigate to a known domain detail page (test with a known ID pattern)
  // Since we can't easily get the ID from the home page without clicking menus,
  // let's check the API response
  const apiPage = await context.newPage();
  const apiResp = await apiPage.goto('https://mailboxes.example.workers.dev/api/v1/domains', {
    waitUntil: 'networkidle', timeout: 15000,
  });
  const apiBody = await apiPage.textContent('body') || '';
  console.log(`API response: ${apiBody.substring(0, 500)}`);

  // Parse the domain ID from API response
  try {
    const domains = JSON.parse(apiBody);
    if (Array.isArray(domains) && domains.length > 0) {
      const firstDomain = domains[0];
      console.log(`\nFirst domain: ${firstDomain.name} (id: ${firstDomain.id})`);

      // Navigate to domain details
      console.log(`\n=== 3. Navigating to /domains/${firstDomain.id} ===`);
      await page.goto(`https://mailboxes.example.workers.dev/domains/${firstDomain.id}`, {
        waitUntil: 'networkidle', timeout: 30000,
      });
      await page.waitForTimeout(2000);

      const detailBody = await page.textContent('body') || '';
      console.log(`Detail page URL: ${page.url()}`);
      console.log(`Detail page length: ${detailBody.length}`);

      const checks = {
        'Domain name present': detailBody.includes(firstDomain.name),
        'Back link present': detailBody.includes('Back to Mailboxes'),
        'DNS Records section': detailBody.includes('DNS Records') || detailBody.includes('MX'),
        'Resend API Key section': detailBody.includes('Resend API Key') || detailBody.includes('API Key'),
        'Catch-all section': detailBody.includes('Catch-all') || detailBody.includes('Catch All'),
        'Danger Zone / Delete': detailBody.includes('Delete') || detailBody.includes('Danger'),
        'Copy buttons': detailBody.includes('Copy'),
      };

      console.log('\n=== Domain Details Verification ===');
      let allPass = true;
      for (const [label, pass] of Object.entries(checks)) {
        console.log(`${pass ? '✅' : '❌'} ${label}`);
        if (!pass) allPass = false;
      }

      // Print content excerpt
      console.log(`\n--- Page content preview ---`);
      console.log(detailBody.substring(0, 600));

      console.log(`\n=== ${allPass ? 'ALL PASSED ✅' : 'SOME FAILED ❌'} ===`);
    }
  } catch (e) {
    console.log('Could not parse API response:', e.message);
  }

  await browser.close();
  console.log('\nDone.');
})();
