const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (message) => { errors.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('test', 'yes');
    localStorage.setItem('xingji.v1', JSON.stringify({
      visited: [{ id: 'CN:330100', name: '浙江杭州', country: '中国', kind: '市', center: [120.155, 30.274], ts: 1 }],
      geo: {},
      details: {
        'CN:330100': {
          arrival: '2025-06-17',
          departure: '2025-06-21',
          tripTitle: '杭州之旅',
          weather: '天气阴',
          summary: '西湖边的五天。',
          photos: [],
          journals: {
            '2025-06-17': '抵达杭州，夜里沿湖走了很久。',
            '2025-06-18': '清晨的苏堤，雾气还没散。',
          },
        },
      },
    }));
  });
  await page.goto('http://127.0.0.1:5173/#/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#stage canvas');
  await page.waitForTimeout(1200);
  const home = await page.evaluate(() => ({
    route: document.body.dataset.route,
    lightboxWidth: document.getElementById('lightbox').getBoundingClientRect().width,
  }));
  await page.screenshot({ path: 'shots/smoke-home.png' });

  await page.click('[data-route-link="timeline"]');
  await page.waitForFunction(() => document.body.dataset.route === 'timeline' && document.querySelectorAll('.trip-card').length > 0);
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => ({
    test: localStorage.getItem('test'),
    route: document.body.dataset.route,
    buttons: document.querySelectorAll('.trip-card').length,
    empty: document.getElementById('timeline-empty').hidden,
    topHidden: document.getElementById('timeline-top').hidden,
  }));
  await page.screenshot({ path: 'shots/smoke-timeline.png' });

  await page.click('.trip-card');
  await page.waitForSelector('#place-page.is-open');
  await page.waitForTimeout(1200);
  const place = await page.evaluate(() => ({
    route: document.body.dataset.route,
    title: document.getElementById('place-page-title').textContent,
    days: document.querySelectorAll('.day-button').length,
    editorHidden: document.getElementById('place-editor').hidden,
  }));
  await page.screenshot({ path: 'shots/smoke-place.png' });
  console.log(JSON.stringify({ home, state, place, errors }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
