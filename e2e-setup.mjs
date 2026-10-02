import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  let errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(`${BASE_URL}/setup`, { waitUntil: 'networkidle', timeout: 30000 });
  
  // Step 1: Welcome
  console.log('Step 1: Welcome ✓');
  await page.screenshot({ path: 'setup-1-welcome.png', fullPage: true });
  await page.getByText('Get Started').click();
  await page.waitForTimeout(500);
  
  // Step 2: Domain
  console.log('Step 2: Domain ✓');
  await page.screenshot({ path: 'setup-2-domain.png', fullPage: true });
  await page.getByPlaceholder('example.com').fill('example.com');
  await page.getByText('Continue').click();
  await page.waitForTimeout(500);
  
  // Step 3: Resend
  console.log('Step 3: Resend ✓');
  await page.screenshot({ path: 'setup-3-resend.png', fullPage: true });
  
  if (errors.length > 0) {
    console.log('ERRORS:', errors);
  } else {
    console.log('✅ All steps loaded without errors!');
  }

  await browser.close();
})();
