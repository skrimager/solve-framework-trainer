const { chromium } = require('playwright');

async function main() {
  const port = process.argv[2] || '5055';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  await page.goto(`http://127.0.0.1:${port}/command-center`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="input-manager-username"]', { timeout: 20000 });
  await page.fill('[data-testid="input-manager-username"]', 'manager');
  await page.fill('[data-testid="input-manager-password"]', 'manager123');
  await page.click('[data-testid="button-manager-login"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);

  await page.click('[data-testid="nav-settings"]');
  await page.waitForTimeout(800);
  const toggle = page.locator('button[role="switch"]').nth(4);
  const state = await toggle.getAttribute('data-state');
  console.log('Alerts toggle current state:', state);
  if (state !== 'checked') {
    await toggle.click();
    await page.waitForTimeout(1000);
    console.log('Clicked to restore ON');
  } else {
    console.log('Already ON, no action needed');
  }

  await page.click('[data-testid="nav-dashboard"]');
  await page.waitForTimeout(1000);
  const alertsVisible = await page.getByText('Needs your attention').isVisible().catch(() => false);
  console.log('Alerts widget visible after restore:', alertsVisible);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
