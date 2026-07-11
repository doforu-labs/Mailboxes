import { test, expect } from '@playwright/test';

test('domain details page loads with no errors and status sync works', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    const response = await page.goto('https://mailboxes.example.workers.dev/settings/domains/REPLACE_WITH_YOUR_DOMAIN_RECORD_ID', {
        waitUntil: 'networkidle',
        timeout: 30000,
    });

    expect(response?.status()).toBe(200);

    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');
    expect(pageText).not.toContain('cfApiToken is not defined');
    expect(pageText).not.toContain('unexpected error');

    expect(errors.length).toBe(0);
    console.log('Page loaded successfully');
    console.log('Page title:', await page.title());
});
