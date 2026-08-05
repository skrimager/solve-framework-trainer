// One-off Playwright helper for the Command Center dashboard UX fixes PR.
// Logs into the manager demo account and captures screenshots showing:
//   1. Bigger KPI delta text (top row of cards)
//   2. Alerts card popover/modal open
//   3. Live Feed entry detail modal open
//   4. "Go to Training Center" button navigating to the Scenarios view
//
// Usage: node scripts/pw-screenshot-ux-fixes.cjs [port] [outdir]
const { chromium } = require('playwright');

async function main() {
  const port = process.argv[2] || '5055';
  const outdir = process.argv[3] || '/tmp/ux-fix-screenshots';
  require('fs').mkdirSync(outdir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();

  await page.goto(`http://127.0.0.1:${port}/command-center`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="input-manager-username"]', { timeout: 20000 });
  await page.fill('[data-testid="input-manager-username"]', 'manager');
  await page.fill('[data-testid="input-manager-password"]', 'manager123');
  await page.click('[data-testid="button-manager-login"]');

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);

  // 1. Full dashboard with bigger KPI delta text visible.
  await page.screenshot({ path: `${outdir}/1-dashboard-kpi-delta-text.png`, fullPage: false });
  console.log('Saved 1-dashboard-kpi-delta-text.png');

  // Zoomed crop of just the top KPI row for a clear before/after comparison.
  const kpiRow = await page.$('[data-testid="row-kpi-cards"]');
  if (kpiRow) {
    await kpiRow.screenshot({ path: `${outdir}/1b-kpi-row-closeup.png` });
    console.log('Saved 1b-kpi-row-closeup.png');
  }

  // 2. Alerts card popover/modal.
  const alertsButton = await page.$('[data-testid="kpi-alerts"]');
  if (alertsButton) {
    await alertsButton.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outdir}/2-alerts-modal-open.png`, fullPage: false });
    console.log('Saved 2-alerts-modal-open.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    console.log('WARNING: alerts card button not found');
  }

  // 3. Live Feed entry detail modal.
  const liveFeedRow = await page.$('[data-testid^="live-feed-row-score-"], [data-testid^="live-feed-row-session-"]');
  if (liveFeedRow) {
    await liveFeedRow.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outdir}/3-live-feed-detail-modal.png`, fullPage: false });
    console.log('Saved 3-live-feed-detail-modal.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else {
    console.log('WARNING: live feed row not found');
  }

  // 4. "Go to Training Center" button navigates to Scenarios.
  const ctaButton = await page.$('[data-testid="button-go-training-center"]');
  if (ctaButton) {
    await ctaButton.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${outdir}/4-training-center-scenarios-view.png`, fullPage: false });
    console.log('Saved 4-training-center-scenarios-view.png');
  } else {
    console.log('WARNING: Go to Training Center button not found');
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
