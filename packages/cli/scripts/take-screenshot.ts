import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:5174');
  await page.waitForSelector('[data-testid="project-all"]', { timeout: 10000 });
  await page.screenshot({ path: 'ui-snapshot.png' });
  await browser.close();
  console.log('Screenshot saved to ui-snapshot.png');
})();
