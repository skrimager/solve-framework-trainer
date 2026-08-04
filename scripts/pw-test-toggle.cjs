// Logs in, goes to Dashboard Settings, toggles off "Alerts" widget, verifies
// it disappears from the Dashboard tab, then toggles back on.
const { chromium } = require('playwright');

async function main() {
  const port = process.argv[2] || '5055';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
  });
  page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));

  await page.goto(`http://127.0.0.1:${port}/command-center`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="input-manager-username"]', { timeout: 20000 });
  await page.fill('[data-testid="input-manager-username"]', 'manager');
  await page.fill('[data-testid="input-manager-password"]', 'manager123');
  await page.click('[data-testid="button-manager-login"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);

  // Confirm Alerts widget visible on Dashboard tab initially
  await page.click('[data-testid="nav-dashboard"]');
  await page.waitForTimeout(800);
  const alertsVisibleBefore = await page.getByText('Needs your attention').isVisible().catch(() => false);
  console.log('Alerts widget visible BEFORE toggle-off:', alertsVisibleBefore);

  // Go to settings and toggle off Alerts
  await page.click('[data-testid="nav-settings"]');
  await page.waitForTimeout(800);
  const alertsRow = page.locator('text=Alerts').first().locator('xpath=ancestor::div[contains(@class,"flex")][1]');
  // Fallback: find switch near "Alerts" heading using role
  const alertsHeading = page.getByText('Alerts', { exact: true });
  await alertsHeading.scrollIntoViewIfNeeded();
  const row = page.locator('div', { has: page.getByText('Alerts', { exact: true }) }).last();
  const toggle = page.locator('button[role="switch"]').nth(4); // Alerts is 5th widget (index 4)
  await toggle.click();
  await page.waitForTimeout(1000);

  // Go back to dashboard tab and confirm alerts widget gone
  await page.click('[data-testid="nav-dashboard"]');
  await page.waitForTimeout(1000);
  const alertsVisibleAfter = await page.getByText('Needs your attention').isVisible().catch(() => false);
  console.log('Alerts widget visible AFTER toggle-off:', alertsVisibleAfter);

  await page.screenshot({ path: '/home/user/workspace/screenshots/dashboard_after_toggle_off.png', fullPage: true });

  // Reload page fresh to confirm persistence server-side
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const alertsVisibleAfterReload = await page.getByText('Needs your attention').isVisible().catch(() => false);
  console.log('Alerts widget visible AFTER reload (persistence check):', alertsVisibleAfterReload);

  // Toggle back on for cleanliness
  await page.click('[data-testid="nav-settings"]');
  await page.waitForTimeout(800);
  const toggle2 = page.locator('button[role="switch"]').nth(4);
  await toggle2.click();
  await page.waitForTimeout(1000);
  await page.click('[data-testid="nav-dashboard"]');
  await page.waitForTimeout(1000);
  const alertsVisibleRestored = await page.getByText('Needs your attention').isVisible().catch(() => false);
  console.log('Alerts widget visible AFTER toggle back on:', alertsVisibleRestored);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
