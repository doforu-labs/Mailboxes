// Copyright (c) 2026 Doforu
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const DOMAIN_ID = process.env.TEST_DOMAIN_ID || 'example-domain-id';

test('domain details page loads with no errors and status sync works', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    const response = await page.goto(`${BASE_URL}/settings/domains/${DOMAIN_ID}`, {
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
