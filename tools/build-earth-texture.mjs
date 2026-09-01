import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const bundledRequire = createRequire(
  'C:/Users/12783/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/_anchor.js',
);
const sharp = bundledRequire('sharp');

const LEVEL = 5;
const COLS = 40;
const ROWS = 20;
const TILE = 512;
const WIDTH = COLS * TILE;
const HEIGHT = ROWS * TILE;
const OUTPUT = fileURLToPath(new URL('../assets/earth-day-16k.jpg', import.meta.url));
const jobs = [];

for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) jobs.push({ row, col });
}

async function fetchTile({ row, col }) {
  const url = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m/${LEVEL}/${row}/${col}.jpeg`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'XingjiTravelGlobe/0.2 (personal travel record)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tile = Buffer.from(await res.arrayBuffer());
      if (tile.length < 1024) throw new Error('Suspiciously small tile');
      return { row, col, tile };
    } catch (err) {
      if (attempt === 4) throw new Error(`Tile ${row}/${col}: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

const tiles = [];
const workers = Array.from({ length: 10 }, async () => {
  while (jobs.length) {
    const job = jobs.shift();
    const tile = await fetchTile(job);
    tiles.push(tile);
    if (tiles.length % 40 === 0) console.log(`${tiles.length} / ${COLS * ROWS} tiles`);
  }
});

await Promise.all(workers);
tiles.sort((a, b) => (a.row - b.row) || (a.col - b.col));

const native = await sharp({
  create: {
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    background: { r: 8, g: 20, b: 34 },
  },
})
  .composite(tiles.map(({ row, col, tile }) => ({
    input: tile,
    left: col * TILE,
    top: row * TILE,
  })))
  .jpeg({ quality: 96, mozjpeg: true, chromaSubsampling: '4:4:4' })
  .toBuffer();

await sharp(native)
  .resize(16384, 8192, { kernel: 'lanczos3' })
  .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:4:4' })
  .toFile(OUTPUT);

console.log(`Saved ${OUTPUT}`);
