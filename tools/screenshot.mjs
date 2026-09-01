import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The bundled runtime keeps Playwright outside this workspace, so we anchor
// require() resolution inside its own node_modules directory.
const bundledRequire = createRequire(
  'C:/Users/12783/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/_anchor.js',
);
const { chromium } = bundledRequire('playwright');

const outUrl = new URL('../shots/', import.meta.url);
mkdirSync(fileURLToPath(outUrl), { recursive: true });

const FAKE_HANGZHOU = {
  id: 'CN:330100',
  name: '浙江杭州',
  country: '中国',
  kind: '市',
  center: [120.155, 30.274],
  ts: Date.now(),
};

// A coarse stand-in polygon so the offline render check exercises the full
// outline + beacon pipeline without touching the geocoder.
const ring = [
  [119.9, 30.1], [120.2, 29.95], [120.45, 30.15], [120.5, 30.4],
  [120.3, 30.6], [120.05, 30.55], [119.85, 30.35],
].map(([lon, lat]) => [lon, lat]);
ring.push(ring[0]);

const bigRing = [
  [118.6, 28.6], [119.6, 27.4], [121.2, 27.6], [122.6, 28.4], [123.0, 29.6],
  [122.0, 30.9], [120.6, 31.3], [119.2, 31.2], [118.4, 30.2],
].map(([lon, lat]) => [lon, lat]);
bigRing.push(bigRing[0]);

const bootstrap = {
  visited: [
    FAKE_HANGZHOU,
    { id: 'R913809', name: '浙江省(测试大轮廓)', country: '中国', kind: '省', center: [120.1, 29.2], ts: Date.now() },
  ],
  geo: {
    'CN:330100': { rings: [ring], ts: FAKE_HANGZHOU.ts },
    R913809: { rings: [bigRing], ts: Date.now() },
  },
  details: {
    'CN:330100': {
      arrival: '2025-06-17',
      departure: '2025-06-21',
      tripTitle: '杭州之旅',
      weather: '天气阴',
      summary: '西湖清晨有薄雾，午后沿满觉陇走到杨梅岭。龙井村的路比记忆里更安静。',
      photos: [],
    },
  },
};

// The sandbox ships no Playwright browsers; fall back to system Edge.
const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const consoleLogs = [];

/* Album shots need real blobs in IndexedDB; paint them in the page first. */
async function seedAlbumPhotos(page) {
  await page.evaluate(async () => {
    const makeBlob = (hue, label) => new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 960, 720);
      grad.addColorStop(0, `hsl(${hue} 62% 46%)`);
      grad.addColorStop(1, `hsl(${(hue + 48) % 360} 58% 28%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 960, 720);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 54px system-ui, sans-serif';
      ctx.fillText(label, 64, 120);
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.8);
    });
    const blobs = await Promise.all([makeBlob(28, '西湖'), makeBlob(120, '龙井'), makeBlob(205, '钱塘江')]);
    const ids = ['pa', 'pb', 'pc'];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xingji-media.v1', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('photos')) {
          request.result.createObjectStore('photos');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await Promise.all(ids.map((id, index) => new Promise((resolve, reject) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').put(blobs[index], `CN:330100:${id}`);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    })));
    const raw = JSON.parse(localStorage.getItem('xingji.v1'));
    raw.details['CN:330100'].photos = ids.map((id, index) => ({ id, caption: '', ts: index + 1 }));
    localStorage.setItem('xingji.v1', JSON.stringify(raw));
  });
}

async function shoot(name, viewport, preSeed) {
  const context = await browser.newContext({ viewport });
  if (preSeed) {
    await context.addInitScript((data) => {
      if (!localStorage.getItem('xingji.v1')) localStorage.setItem('xingji.v1', JSON.stringify(data));
    }, bootstrap);
  }
  const page = await context.newPage();
  page.on('console', (m) => consoleLogs.push(`[${name}][${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLogs.push(`[${name}][pageerror] ${e.message}`));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(2600);
  if (name === 'desktop-detail') {
    await page.locator('.chip-main').first().click();
    await page.waitForTimeout(900);
  }
  if (name === 'desktop-album') {
    await seedAlbumPhotos(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1800);
    await page.locator('.chip-main').first().click();
    await page.waitForTimeout(900);
    await page.locator('#album-next').click();
    await page.waitForTimeout(700);
  }
  if (name === 'desktop-edit') {
    await page.locator('.chip-main').first().click();
    await page.waitForTimeout(700);
    await page.locator('#detail-edit-button').click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: fileURLToPath(new URL(`./${name}.png`, outUrl)) });
  await context.close();
}

await shoot('desktop-clean', { width: 1440, height: 900 }, false);
await shoot('desktop-seeded', { width: 1440, height: 900 }, true);
await shoot('desktop-detail', { width: 1440, height: 900 }, true);
await shoot('desktop-album', { width: 1440, height: 900 }, true);
await shoot('desktop-edit', { width: 1440, height: 900 }, true);
await shoot('mobile-seeded', { width: 390, height: 844 }, true);

await browser.close();
console.log(consoleLogs.length ? consoleLogs.join('\n') : 'console clean');
