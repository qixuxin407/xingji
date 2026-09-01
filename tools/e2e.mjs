import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(
  'C:/Users/12783/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/_anchor.js',
)('playwright');

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const baseUrl = process.env.XINGJI_URL || 'http://127.0.0.1:5173/';
await page.goto(baseUrl, { waitUntil: 'load' });
await page.fill('#search-input', '杭州市');
await page.waitForTimeout(4500);

const resultCount = await page.locator('#results li').count();
console.log('search results:', resultCount);
console.log('status text:', await page.locator('#search-status').textContent());
if (resultCount > 0) {
  const firstName = await page.locator('.result-name').first().textContent();
  console.log('first result:', firstName);
  await page.locator('.result').first().click();
  await page.waitForTimeout(12000);
  const store = await page.evaluate(() => JSON.parse(localStorage.getItem('xingji.v1') || 'null'));
  console.log('visited count:', store?.visited?.length ?? 0);
  console.log('cached geometries:', Object.keys(store?.geo || {}).length);
  await page.screenshot({
    path: fileURLToPath(new URL('./e2e-marked.png', import.meta.url)),
  });
}

console.log(logs.length ? logs.join('\n') : 'console clean');
await browser.close();
