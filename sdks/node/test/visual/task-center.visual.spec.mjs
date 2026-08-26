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
  expect(layout).toEqual({ overflow: false, titleSize: '26px', cardRadius: '8px' });
  await testInfo.attach('task-center-desktop', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
});

test('mobile Task Center remains readable without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStableTaskCenter(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator('.rhinoq-tools')).toHaveCSS('grid-template-columns', /390px|350px|1fr/);
  await testInfo.attach('task-center-mobile', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
});
