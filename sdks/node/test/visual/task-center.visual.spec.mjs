import { expect, test } from '@playwright/test';

async function openStableTaskCenter(page) {
  await page.goto('/task-center');
  await expect(page.getByRole('heading', { name: 'My activity' })).toBeVisible();
  await expect(page.locator('.rhinoq-task')).toHaveCount(4);
  await expect(page.locator('[data-state="uncertain"]')).toBeVisible();
}

test('desktop Task Center keeps the compact workspace contract', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openStableTaskCenter(page);
  const layout = await page.locator('[data-rhinoq-task-center]').evaluate((root) => {
    const title = root.querySelector('h1');
    const card = root.querySelector('.rhinoq-task');
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      titleSize: title ? getComputedStyle(title).fontSize : '',
      cardRadius: card ? getComputedStyle(card).borderRadius : '',
    };
  });
  await testInfo.attach('task-center-desktop', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
  expect(layout).toEqual({ overflow: false, titleSize: '26px', cardRadius: '8px' });
});

test('mobile Task Center remains readable without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStableTaskCenter(page);
  const layout = await page.locator('.rhinoq-tools').evaluate((tools) => ({
    columns: getComputedStyle(tools).gridTemplateColumns.trim().split(/\s+/).length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    right: Math.ceil(tools.getBoundingClientRect().right),
    viewport: document.documentElement.clientWidth,
  }));
  await testInfo.attach('task-center-mobile', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
  expect(layout.columns).toBe(1);
  expect(layout.overflow).toBe(false);
  expect(layout.right).toBeLessThanOrEqual(layout.viewport);
});
