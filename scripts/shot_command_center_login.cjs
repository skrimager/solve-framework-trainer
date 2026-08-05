// One-off script to capture desktop and mobile screenshots of the redesigned
// Command Center login page for the PR. Not part of the app's test suite.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

(async () => {
  const outDir = path.join(__dirname, "..", "docs", "pr-screenshots", "command-center-login-redesign");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();

  const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktopPage.goto("http://127.0.0.1:5050/command-center", { waitUntil: "networkidle" });
  await desktopPage.waitForTimeout(500);
  await desktopPage.screenshot({ path: path.join(outDir, "desktop-1280.png"), fullPage: true });

  const mobilePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await mobilePage.goto("http://127.0.0.1:5050/command-center", { waitUntil: "networkidle" });
  await mobilePage.waitForTimeout(500);
  await mobilePage.screenshot({ path: path.join(outDir, "mobile-375.png"), fullPage: true });

  await browser.close();
  console.log("Screenshots saved to", outDir);
})();
