// One-off Playwright helper for the Command Center date range picker PR.
// Logs into the manager demo account and takes three screenshots:
//   1. preset buttons + default view
//   2. the custom calendar popover open
//   3. the dashboard after selecting "All time" (multi-month data)
// Usage: node scripts/pw-screenshot-daterange.cjs <outdir> [port]
const { chromium } = require('playwright');

async function main() {
  const outdir = process.argv[2] || '/tmp';
  const port = process.argv[3] || '5055';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();

  await page.goto(`http://127.0.0.1:${port}/command-center`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="input-manager-username"]', { timeout: 20000 });
  await page.fill('[data-testid="input-manager-username"]', 'manager');
  await page.fill('[data-testid="input-manager-password"]', 'manager123');
  await page.click('[data-testid="button-manager-login"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  // 1. Preset buttons visible, default 30-day view
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${outdir}/1-presets-default-30d.png`, fullPage: true });

  // 2. Open the custom calendar popover
  await page.click('[data-testid="button-range-custom"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outdir}/2-custom-calendar-open.png`, fullPage: false });
  // close popover without applying, so the next click starts clean
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 3. Click "All time" preset - multi-month data
  await page.click('[data-testid="button-range-preset-all"]');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${outdir}/3-all-time-multimonth.png`, fullPage: true });

  console.log('Saved screenshots to', outdir);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
