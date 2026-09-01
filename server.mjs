import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.XINGJI_PORT || 5173);
const localUrl = `http://127.0.0.1:${port}`;

function openInBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function proxyJson(res, url) {
  return fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'XingjiTravelGlobe/0.2 (personal travel record)',
    },
    signal: AbortSignal.timeout(25_000),
  })
    .then(async (upstream) => {
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })
    .catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.name || 'proxy failed' }));
    });
}

function serveApi(req, res, pathname, searchParams) {
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (pathname === '/api/photon') {
    proxyJson(res, `https://photon.komoot.io/api/?${searchParams}`);
    return;
  }
  if (pathname === '/api/overpass') {
    const query = searchParams.get('data');
    if (!query) {
      res.writeHead(400).end();
      return;
    }
    proxyJson(res, `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
    return;
  }
  const datav = pathname.match(/^\/api\/datav\/(\d{6})\.json$/);
  if (datav) {
    proxyJson(res, `https://geo.datav.aliyun.com/areas_v3/bound/${datav[1]}.json`);
    return;
  }
  res.writeHead(404).end();
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(root + path.sep) && filePath !== path.resolve(root, 'index.html')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const extension = path.extname(filePath).toLowerCase();
    const isLiveSource = ['.html', '.js', '.css'].includes(extension);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': isLiveSource ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    serveApi(req, res, url.pathname, url.searchParams);
    return;
  }
  await serveStatic(res, url.pathname);
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log('端口已被占用。若行迹已在运行，将直接打开浏览器。');
  if (process.env.XINGJI_OPEN === '1') {
    openInBrowser(localUrl);
    process.exit(0);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`行迹运行于 ${localUrl}`);
  if (process.env.XINGJI_OPEN === '1') openInBrowser(localUrl);
});
