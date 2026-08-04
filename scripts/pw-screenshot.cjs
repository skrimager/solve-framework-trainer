// One-off Playwright helper: logs into the manager demo account and screenshots
// the Command Center dashboard at desktop width. Usage:
//   node scripts/pw-screenshot.cjs <outfile.png> [port]
const { chromium } = require('playwright');

async function main() {
  const outfile = process.argv[2] || '/tmp/dashboard.png';
  const port = process.argv[3] || '5055';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  await page.goto(`http://127.0.0.1:${port}/command-center`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="input-manager-username"]', { timeout: 20000 });
  await page.fill('[data-testid="input-manager-username"]', 'manager');
  await page.fill('[data-testid="input-manager-password"]', 'manager123');
  await page.click('[data-testid="button-manager-login"]');

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: outfile, fullPage: true });
  console.log('Saved screenshot to', outfile);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
