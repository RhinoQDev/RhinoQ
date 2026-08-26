import { expect, test } from '@playwright/test';

async function openStableTaskCenter(page) {
  await page.goto('/task-center');
  await expect(page.getByRole('heading', { name: 'My activity' })).toBeVisible();
  await expect(page.locator('.rhinoq-task')).toHaveCount(4);
  await expect(page.locator('[data-state="uncertain"]')).toBeVisible();
}

test('Task Center pagination bounds the feed and restores browser history', async ({ page }) => {
  await openStableTaskCenter(page);
  await expect(page.getByText('1–4 of 5 · Page 1 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Next task page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.rhinoq-task')).toHaveCount(1);
  await expect(page.getByText('5–5 of 5 · Page 2 of 2')).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.locator('.rhinoq-task')).toHaveCount(4);
});

test('Activity and Workbench use one active navigation treatment', async ({ page }) => {
  await openStableTaskCenter(page);
  const activity = await page.locator('nav[aria-label="Product"] [aria-current="page"]').evaluate((tab) => ({
    background: getComputedStyle(tab).backgroundColor,
    color: getComputedStyle(tab).color,
    radius: getComputedStyle(tab).borderRadius,
    shadow: getComputedStyle(tab).boxShadow,
  }));
  await page.getByRole('link', { name: 'Workbench' }).click();
  await expect(page.getByRole('heading', { name: 'Async work, explained.' })).toBeVisible();
  const workbench = await page.locator('nav[aria-label="Product"] [aria-current="page"]').evaluate((tab) => ({
    background: getComputedStyle(tab).backgroundColor,
    color: getComputedStyle(tab).color,
    radius: getComputedStyle(tab).borderRadius,
    shadow: getComputedStyle(tab).boxShadow,
  }));
  expect(workbench).toEqual(activity);
});

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
  const liveUpdate = await page.evaluate(() => {
    const before = document.querySelector('[data-id="demo-complete"]');
    const buttonBefore = before.querySelector('button[data-action="download"]');
    buttonBefore.focus({ preventScroll: true });
    const scrollBefore = window.scrollY;
    const task = byId.get('demo-complete');
    const completed = Math.max(0, (task.progress.completed ?? 1) - 1);
    put({
      ...task,
      entityVersion: task.entityVersion + 1,
      progress: { ...task.progress, completed },
      updatedAt: new Date().toISOString(),
    });
    renderAll();
    const after = document.querySelector('[data-id="demo-complete"]');
    const buttonAfter = after.querySelector('button[data-action="download"]');
    return {
      sameCard: before === after,
      sameAction: buttonBefore === buttonAfter,
      focusPreserved: document.activeElement === buttonAfter,
      scrollPreserved: window.scrollY === scrollBefore,
      progressChanged: Number(after.querySelector('progress').value) === completed,
    };
  });
  expect(liveUpdate).toEqual({ sameCard: true, sameAction: true, focusPreserved: true, scrollPreserved: true, progressChanged: true });
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

test('Task action uses a branded button and explains a failed request in a toast', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/task-center/demo-complete');
  const primaryAction = page.getByRole('button', { name: /Download result/ });
  await expect(primaryAction).toBeVisible();
  // SSE may replace the current detail DOM between locator resolution and an
  // evaluation. Retrying CSS assertions re-resolve the visible action instead
  // of sampling a detached node and turning a healthy render into a flaky test.
  await expect(primaryAction).toHaveCSS('border-radius', '7px');
  await expect(primaryAction).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(primaryAction).toHaveCSS('height', '34px');
  await page.evaluate(() => {
    showNotice(
      'error',
      'Retry could not be started',
      'The reviewed retry could not be started.',
      'Confirm the latest Task state before trying again.',
    );
  });
  const toast = page.locator('#notice');
  await expect(toast).toContainText('Retry could not be started');
  await expect(toast).toContainText('The reviewed retry could not be started.');
  await expect(toast).toContainText('Confirm the latest Task state before trying again.');
  await expect(toast).toHaveClass(/is-error/);
  await testInfo.attach('task-action-error-toast', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(toast).toBeEmpty();
});

async function openWorkbenchDrawer(page) {
  await page.goto('/rhinoq');
  await expect(page.getByRole('heading', { name: 'Async work, explained.' })).toBeVisible();
  await page.getByRole('row', { name: /Open details for demo-confirmation/ }).click();
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();
}

test('Workbench preserves list context and opens Task evidence on the right', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openWorkbenchDrawer(page);
  const drawer = page.locator('#detailDrawer');
  // Visibility is reported at the first animation frame. Wait for the drawer's
  // 28px entrance transform to settle before asserting its final edge.
  await expect(drawer).toHaveCSS('transform', 'none');
  const layout = await drawer.evaluate((drawer) => {
    const bounds = drawer.getBoundingClientRect();
    const sections = [...drawer.querySelectorAll('.drawer-section')];
    const scroll = drawer.querySelector('.drawer-scroll');
    return {
      right: Math.round(bounds.right),
      // Fixed-position surfaces anchor to the layout viewport (`innerWidth`).
      // `clientWidth` excludes the platform scrollbar gutter and can differ by
      // 28px on Windows even when the drawer is exactly flush with the edge.
      viewport: window.innerWidth,
      bodyLocked: document.body.classList.contains('drawer-open'),
      overviewLinks: document.querySelectorAll('header a[href="/task-center"]').length,
      clippedSections: sections.filter((section) => section.scrollHeight > section.clientHeight + 1).map((section) => section.id),
      drawerScrolls: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  await testInfo.attach('workbench-drawer-desktop', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
  expect(layout.right).toBeGreaterThanOrEqual(layout.viewport);
  expect(Math.abs(layout.right - layout.viewport)).toBeLessThanOrEqual(1);
  expect(layout.bodyLocked).toBe(true);
  expect(layout.overviewLinks).toBe(2);
  expect(layout.clippedSections).toEqual([]);
  expect(layout.drawerScrolls).toBe(true);
  expect(layout.horizontalOverflow).toBe(false);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeHidden();
  await expect(page).toHaveURL(/\/rhinoq$/);
});

test('Workbench Task drawer becomes a full-width mobile surface', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbenchDrawer(page);
  const drawer = page.locator('#detailDrawer');
  await expect(drawer).toHaveCSS('transform', 'none');
  const layout = await drawer.evaluate((drawer) => {
    const bounds = drawer.getBoundingClientRect();
    const sections = [...drawer.querySelectorAll('.drawer-section')];
    return {
      left: Math.round(bounds.left),
      width: Math.round(bounds.width),
      viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clippedSections: sections.filter((section) => section.scrollHeight > section.clientHeight + 1).map((section) => section.id),
    };
  });
  await testInfo.attach('workbench-drawer-mobile', {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
  expect(layout.left).toBeLessThanOrEqual(5); // Windows may reserve a narrow scrollbar gutter.
  expect(layout.width).toBe(layout.viewport);
  expect(layout.overflow).toBe(false);
  expect(layout.clippedSections).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeHidden();
});
