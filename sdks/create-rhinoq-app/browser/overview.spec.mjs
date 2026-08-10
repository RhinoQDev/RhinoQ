import { expect, test } from '@playwright/test';

test('first run explains value, attention and verification without a blank state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByRole('heading', { name: 'Async operations overview' })).toBeVisible();
  await expect(page.getByText('At risk / stuck')).toBeVisible();
  await expect(page.getByText('Recently verified')).toBeVisible();
  await expect(page.getByText(/No progress has been recorded|stopped reporting progress/)).toBeVisible();
  await expect(page.getByRole('link', { name: /View task/ })).toHaveAttribute('href', '/task-center/batch-demo');
  const cards = await page.locator('.metric').all();
  expect(cards).toHaveLength(7);
  await expect(page).toHaveScreenshot('overview-desktop.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.08,
  });
});

test('mobile first run keeps primary actions visible and has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByRole('button', { name: 'Start a 50-item batch' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot('overview-mobile.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.08,
  });
});
