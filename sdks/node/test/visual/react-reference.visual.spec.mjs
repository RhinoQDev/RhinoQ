import { expect, test } from '@playwright/test';

const referenceURL = 'http://127.0.0.1:4173/';

async function openReference(page) {
  await page.goto(referenceURL);
  await expect(page.getByRole('heading', { name: 'My activity' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Background tasks' }).getByRole('button')).toHaveCount(5);
}

test('React reference app preserves live cards and browser state', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReference(page);
  const running = page.getByRole('button', { name: /Open report\.export: Running/ });
  await running.evaluate((card) => { card.dataset.liveIdentityProbe = 'preserved'; });
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('ORD-2048');
  await expect(page.getByRole('list', { name: 'Background tasks' }).getByRole('button')).toHaveCount(1);
  await expect(page).toHaveURL(/q=ORD-2048/);
  await page.getByRole('button', { name: 'Reset filters' }).click();
  const firstProgress = await running.getByRole('progressbar').getAttribute('value');
  await expect.poll(() => running.getByRole('progressbar').getAttribute('value'), { timeout: 12_000 }).not.toBe(firstProgress);
  expect(await running.evaluate((card) => card.dataset.liveIdentityProbe)).toBe('preserved');
  await page.getByRole('combobox', { name: 'Saved task view' }).selectOption('needs-review');
  await expect(page).toHaveURL(/view=needs-review/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test('React drawer is keyboard-contained and restores the opener', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReference(page);
  const opener = page.getByRole('button', { name: 'Open report.archive: Completed' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Task details' });
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close task details' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('React Result & Artifact Center previews an owner-resolved file', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReference(page);
  await page.getByRole('button', { name: 'Open report.archive: Completed' }).click();
  await expect(page.getByRole('region', { name: 'Results and artifacts' })).toContainText('2 files');
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('img', { name: 'report-preview.svg' });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((image) => image.naturalWidth > 0)).toBe(true);
});

test('React approval is explicit while uncertain provider work stays fail-closed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReference(page);
  await page.getByRole('button', { name: /Open budget\.approval:/ }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Approval recorded' })).toBeVisible();
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('button', { name: 'Open provider.publish: Awaiting confirmation' }).click();
  await expect(page.getByRole('region', { name: 'Requests and approvals' })).toContainText('Waiting for an external update');
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('React compact queue batches user-named jobs inside a bounded list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReference(page);
  await page.getByRole('button', { name: 'Compact queue' }).click();
  const list = page.getByRole('list', { name: 'Background tasks' });
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(list.getByRole('button', { name: /Download product launch video/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show 2 more tasks' })).toBeVisible();
  await expect(list).toHaveCSS('max-height', '360px');
  await expect(list).toHaveCSS('overflow-y', 'auto');
  await page.getByRole('button', { name: 'Show 2 more tasks' }).click();
  await expect(list.getByRole('button')).toHaveCount(5);
  await expect(page.getByText('Load more', { exact: true })).toHaveCount(0);
});

test('React reference app is responsive without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReference(page);
  await page.getByRole('button', { name: 'Open report.archive: Completed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Task details' });
  await expect(dialog).toHaveCSS('width', '390px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
