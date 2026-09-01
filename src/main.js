import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/* ------------------------------------------------------------------ */
/* Basic constants                                                     */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
const GLOBE_R = 1;
const OUTLINE_R = GLOBE_R * 1.006;
const BEACON_R = GLOBE_R * 1.003;
const STORE_KEY = 'xingji.v1';
const MEDIA_DB_NAME = 'xingji-media.v1';
const MEDIA_STORE = 'photos';
const GEO_DB_NAME = 'xingji-geo.v1';
const GEO_STORE = 'boundaries';
const GEO_CACHE_VERSION = 1;
const GEO_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_POINTS_PER_PLACE = 6500;
const CHINA_INDEX_URL = './vendor/data/china-areas.json';
const COUNTRIES_TOPO_URL = './vendor/data/countries-110m.json';
const DATAV_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const PHOTON_BASE = 'https://photon.komoot.io/api/';
const OVERPASS_BASE = 'https://overpass-api.de/api/interpreter';
const API_BASE = '/api';
const SEARCH_TIMEOUT_MS = 7000;
const BOUNDARY_TIMEOUT_MS = 18000;

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEFAULT_HINT = '输入地名开始搜索，点击结果即可标记。';

const TYPE_LABELS = {
  administrative: '行政区',
  city: '市',
  town: '镇',
  village: '村镇',
  suburb: '城区',
  borough: '城区',
  state: '省',
  province: '省',
  country: '国家',
  county: '县',
  district: '区',
  municipality: '市',
};

const ICON_FOCUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m22 12h-4"/><path d="m6 12H2"/><path d="m12 6V2"/><path d="m12 22v-4"/></svg>';
const ICON_REMOVE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/* ------------------------------------------------------------------ */
/* State + persistence                                                 */
/* ------------------------------------------------------------------ */

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { visited: [], geo: {}, details: {} };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.visited)) data.visited = [];
    if (!data.geo || typeof data.geo !== 'object') data.geo = {};
    if (!data.details || typeof data.details !== 'object') data.details = {};
    for (const detail of Object.values(data.details)) {
      if (!Array.isArray(detail.photos)) detail.photos = [];
    }
    return data;
  } catch {
    return { visited: [], geo: {}, details: {} };
  }
}

const store = loadStore();

if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

let saveWarned = false;
function persist() {
  let attempt = JSON.stringify({ visited: store.visited, details: store.details });
  for (;;) {
    try {
      localStorage.setItem(STORE_KEY, attempt);
      return true;
    } catch (err) {
      if (!isQuotaError(err)) {
        console.warn('Local storage save failed', err);
        return false;
      }
      if (!saveWarned) {
        saveWarned = true;
        setStatus('浏览器存储空间不足。请导出备份并清理图片后重试。', true);
      }
      return false;
    }
  }
}

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
}

/* Local photo blobs live in IndexedDB; localStorage only keeps lightweight metadata. */
let mediaDbPromise = null;
function openMediaDb() {
  mediaDbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return mediaDbPromise;
}

function mediaTransaction(db, mode) {
  return db.transaction(MEDIA_STORE, mode).objectStore(MEDIA_STORE);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let geoDbPromise = null;
function openGeoDb() {
  geoDbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(GEO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GEO_STORE)) db.createObjectStore(GEO_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return geoDbPromise;
}

async function saveGeometry(id, prepared) {
  store.geo[id] = prepared;
  try {
    const db = await openGeoDb();
    await requestToPromise(db.transaction(GEO_STORE, 'readwrite').objectStore(GEO_STORE).put(prepared, id));
  } catch (err) {
    console.warn('Geometry cache save failed', err);
  }
}

async function removeGeometry(id) {
  delete store.geo[id];
  try {
    const db = await openGeoDb();
    await requestToPromise(db.transaction(GEO_STORE, 'readwrite').objectStore(GEO_STORE).delete(id));
  } catch (err) {
    console.warn('Geometry cache delete failed', err);
  }
}

async function initGeoStore() {
  const db = await openGeoDb();
  const objectStore = db.transaction(GEO_STORE, 'readonly').objectStore(GEO_STORE);
  const [keys, values] = await Promise.all([
    requestToPromise(objectStore.getAllKeys()),
    requestToPromise(objectStore.getAll()),
  ]);

  let migrated = false;
  for (const [id, prepared] of Object.entries(store.geo)) {
    if (prepared?.rings) {
      await saveGeometry(id, prepared);
      migrated = true;
    }
  }

  const cached = new Map((keys || []).map((key, index) => [String(key), values[index]]));
  store.geo = {};
  for (const meta of store.visited) {
    const prepared = cached.get(meta.id);
    if (prepared?.rings) store.geo[meta.id] = prepared;
  }

  await cleanupOrphanData();
  if (migrated) persist();
}

async function deletePlaceMedia(id) {
  const detail = store.details[id];
  const keys = [
    timelineCoverKey(id),
    `timeline-cover-original:${id}`,
    ...(detail?.photos || []).map((photo) => photoStorageKey(id, photo.id)),
  ];
  await Promise.allSettled(keys.map((key) => removePhotoBlob(key)));
}

async function cleanupOrphanData() {
  const valid = new Set(store.visited.map((meta) => meta.id));
  const orphanIds = Object.keys(store.details).filter((id) => !valid.has(id));
  if (!orphanIds.length) return;
  await Promise.allSettled(orphanIds.map((id) => deletePlaceMedia(id)));
  for (const id of orphanIds) delete store.details[id];
  persist();
}

async function savePhotoBlob(key, blob) {
  const db = await openMediaDb();
  await requestToPromise(mediaTransaction(db, 'readwrite').put(blob, key));
}

async function loadPhotoBlob(key) {
  const db = await openMediaDb();
  return requestToPromise(mediaTransaction(db, 'readonly').get(key));
}

async function removePhotoBlob(key) {
  const db = await openMediaDb();
  await requestToPromise(mediaTransaction(db, 'readwrite').delete(key));
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}

function photoStorageKey(placeId, photoId) {
  return `${placeId}:${photoId}`;
}

function timelineCoverKey(placeId) {
  return `timeline-cover:${placeId}`;
}

function timelineCoverSourceKey(placeId) {
  return `timeline-cover-original:${placeId}`;
}

async function compressCoverSource(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

async function compressTimelineCover(file, focusX = 0.5, focusY = 0.5) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const width = 1200;
  const height = 480;
  const sourceRatio = bitmap.width / bitmap.height;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (sourceRatio > targetRatio) {
    sw = bitmap.height * targetRatio;
    sx = (bitmap.width - sw) * focusX;
  } else {
    sh = bitmap.width / targetRatio;
    sy = (bitmap.height - sh) * focusY;
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function lonLatToVec3(lon, lat, radius, target = new THREE.Vector3()) {
  const cl = Math.cos(lat * DEG);
  return target.set(
    radius * cl * Math.cos(lon * DEG),
    radius * Math.sin(lat * DEG),
    -radius * cl * Math.sin(lon * DEG),
  );
}

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function perpDist2(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const pl = dx * dx + dy * dy;
  if (pl === 0) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return ex * ex + ey * ey;
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / pl;
  t = Math.max(0, Math.min(1, t));
  const qx = p[0] - (a[0] + t * dx);
  const qy = p[1] - (a[1] + t * dy);
  return qx * qx + qy * qy;
}

function simplifyRing(points, eps) {
  if (points.length < 4) return points.slice();
  const sqEps = eps * eps;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist2(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > sqEps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function extractPolys(geojson) {
  if (!geojson) return [];
  if (geojson.type === 'Polygon') return [geojson.coordinates];
  if (geojson.type === 'MultiPolygon') return geojson.coordinates;
  if (geojson.type === 'FeatureCollection') {
    return (geojson.features || []).flatMap((feature) => extractPolys(feature.geometry));
  }
  if (geojson.type === 'Feature') return extractPolys(geojson.geometry);
  return [];
}

const rnd5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Simplifies OSM boundary GeoJSON into compact cached form:
 * { rings: [[[lon,lat], ...]], ts } - all rings flattened (holes included).
 */
function prepareGeometry(rawGeojson) {
  const rawPolys = extractPolys(rawGeojson);
  const sources = []; // open rings
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const poly of rawPolys) {
    for (const ring of poly) {
      if (!ring || ring.length < 4) continue;
      const open = ring.slice(0, ring.length - 1);
      if (open.length < 3) continue;
      sources.push(open);
      for (const p of open) {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
    }
  }
  if (!sources.length) return null;

  const span = Math.max(maxLon - minLon, maxLat - minLat, 0.05);
  let eps = Math.min(0.02, Math.max(0.0006, span * 0.0009));

  let current = sources.map((r) => simplifyRing(r, eps));
  let total = current.reduce((n, r) => n + r.length, 0);
  for (let guard = 0; total > MAX_POINTS_PER_PLACE && guard < 8; guard++) {
    eps *= 1.8;
    current = sources.map((r) => simplifyRing(r, eps));
    total = current.reduce((n, r) => n + r.length, 0);
  }

  const rings = [];
  for (const r of current) {
    if (r.length < 3) continue;
    rings.push(r.map(([lon, lat]) => [rnd5(lon), rnd5(lat)]));
  }
  if (!rings.length) return null;
  return { rings, ts: Date.now(), version: GEO_CACHE_VERSION };
}

/** Builds Float32 segment positions for a longitude/latitude line on the sphere. */
function polylineToSegmentPositions(points, radius = OUTLINE_R) {
  const out = [];
  const a = new THREE.Vector3();
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    let lonB = p2[0];
    let dLon = lonB - p1[0];
    if (dLon > 180) lonB -= 360;
    else if (dLon < -180) lonB += 360;
    const dLat = p2[1] - p1[1];
    const maxStepDeg = Math.max(Math.abs(lonB - p1[0]), Math.abs(dLat));
    const steps = Math.min(96, Math.max(1, Math.ceil(maxStepDeg / 1.4)));
    lonLatToVec3(p1[0], p1[1], radius, a);
    let prevX = a.x, prevY = a.y, prevZ = a.z;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      lonLatToVec3(p1[0] + (lonB - p1[0]) * t, p1[1] + dLat * t, radius, a);
      out.push(prevX, prevY, prevZ, a.x, a.y, a.z);
      prevX = a.x; prevY = a.y; prevZ = a.z;
    }
  }
  return out.length >= 6 ? out : null;
}

/** Builds Float32 segment positions for closed cached boundary rings. */
function ringToSegmentPositions(ring) {
  return polylineToSegmentPositions([...ring, ring[0]], OUTLINE_R);
}

/*
 * world-atlas publishes compact TopoJSON. National borders are represented by a
 * shared set of quantized arcs, so decoding every arc once also de-duplicates
 * the line where two countries touch.
 */
async function addCountryBorders() {
  try {
    const topo = await (await fetch(COUNTRIES_TOPO_URL)).json();
    const transform = topo.transform;
    const arcCache = new Map();

    const decodeArc = (index) => {
      if (arcCache.has(index)) return arcCache.get(index);
      let x = 0;
      let y = 0;
      const points = [];
      for (const delta of topo.arcs[index]) {
        x += Number.isFinite(delta[0]) ? delta[0] : 0;
        y += Number.isFinite(delta[1]) ? delta[1] : 0;
        points.push(transform
          ? [
              x * transform.scale[0] + transform.translate[0],
              y * transform.scale[1] + transform.translate[1],
            ]
          : [x, y]);
      }
      arcCache.set(index, points);
      return points;
    };

    const usedArcs = new Set();
    const collectArcIndexes = (value) => {
      if (typeof value === 'number') {
        usedArcs.add(Math.abs(value));
      } else if (Array.isArray(value)) {
        for (const item of value) collectArcIndexes(item);
      }
    };
    for (const geom of topo.objects.countries.geometries) collectArcIndexes(geom.arcs);

    const segments = [];
    for (const index of usedArcs) {
      segments.push(...polylineToSegmentPositions(decodeArc(index), GLOBE_R * 1.0025));
    }
    if (!segments.length) return;

    const geometry = new LineSegmentsGeometry().setPositions(new Float32Array(segments));
    const material = makeOutlineMaterial('#dbe6f5', 1, 0.50);
    material.depthWrite = false;
    const borders = new LineSegments2(geometry, material);
    borders.renderOrder = 1;
    scene.add(borders);
  } catch (err) {
    console.warn('Unable to load national boundaries', err);
  }
}

/* ------------------------------------------------------------------ */
/* Three.js scene                                                      */
/* ------------------------------------------------------------------ */

const stage = document.getElementById('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
} catch {
  const msg = document.createElement('div');
  msg.className = 'webgl-fallback';
  msg.textContent = '你的浏览器不支持 WebGL，无法显示地球。';
  stage.appendChild(msg);
}

if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x07090f, 0);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', '可拖动旋转的三维地球。已去过的城市会以白色轮廓和亮黄白呼吸光点标出。');
  stage.appendChild(renderer.domElement);
}

const scene = new THREE.Scene();
let starUniforms = null;
const starPointer = new THREE.Vector2();
const starPointerTarget = new THREE.Vector2();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.01, 120);
lonLatToVec3(105, 27, 2.9, camera.position);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer ? renderer.domElement : document.body);
controls.enableDamping = !REDUCED_MOTION;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.minDistance = 1.35;
controls.maxDistance = 6;
controls.rotateSpeed = 0.55;
controls.autoRotateSpeed = 0.38;
controls.autoRotate = !REDUCED_MOTION;

let lastInteract = performance.now() - 7000;
controls.addEventListener('start', () => { lastInteract = performance.now(); });
controls.addEventListener('end', () => { lastInteract = performance.now(); });
window.addEventListener('wheel', () => { lastInteract = performance.now(); }, { passive: true });
window.addEventListener('pointermove', (event) => {
  starPointerTarget.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -((event.clientY / window.innerHeight) * 2 - 1),
  );
}, { passive: true });
document.documentElement.addEventListener('pointerleave', () => starPointerTarget.set(0, 0));

scene.add(new THREE.AmbientLight(0xffffff, 1)); // shaders are custom; light keeps future mats simple

// Uniformly lit Blue Marble base map, with a small offline-safe fallback texture.
const fallbackPixels = new Uint8Array([10, 22, 38, 255]);
const fallbackTexture = new THREE.DataTexture(fallbackPixels, 1, 1);
fallbackTexture.needsUpdate = true;

const globeMat = new THREE.ShaderMaterial({
  uniforms: {
    uMap: { value: fallbackTexture },
    uRim: { value: new THREE.Color('#5ea8ff') },
    uSunTint: { value: new THREE.Color('#eaf6ff') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vNormalW;
    varying vec3 vPosW;
    void main() {
      vUv = uv;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform vec3 uRim, uSunTint;
    varying vec2 vUv;
    varying vec3 vNormalW;
    varying vec3 vPosW;

    vec3 linearToSRGB(vec3 color) {
      vec3 low = color * 12.92;
      vec3 high = pow(color, vec3(0.4166667)) * 1.055 - 0.055;
      return mix(low, high, step(vec3(0.0031308), color));
    }

    void main() {
      vec3 n = normalize(vNormalW);
      vec3 vDir = normalize(cameraPosition - vPosW);
      vec4 mapColor = texture2D(uMap, vUv);

      // The 16K texture uses an sRGB internal format, so its texels arrive in
      // linear space. Convert once at the end because this custom shader is
      // responsible for its own output transform.
      vec3 col = pow(mapColor.rgb, vec3(0.88)) * 1.08 + vec3(0.008, 0.014, 0.024);

      float facing = max(dot(n, vDir), 0.0);
      float limb = 1.0 - facing;
      float rayleigh = pow(limb, 2.2);
      float mie = pow(limb, 6.0);
      col = mix(col, col * 0.88 + uRim * 0.48, rayleigh * 0.36);
      col += uSunTint * mie * 0.14;
      col += vec3(0.012, 0.026, 0.052) * rayleigh;
      col = clamp(col, 0.0, 1.0);
      col = linearToSRGB(col);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 96, 64), globeMat));

new THREE.TextureLoader().load(
  './assets/earth-day-16k.jpg',
  (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    if (renderer?.capabilities?.getMaxAnisotropy) {
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
    fallbackTexture.dispose();
    globeMat.uniforms.uMap.value = texture;
  },
  undefined,
  (err) => console.warn('Unable to load Earth texture', err),
);

// A moving cirrus layer. Procedural noise keeps the bundle small while giving
// the surface believable scale and atmospheric motion.
	const cloudMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uTime: { value: 0 }, uMotion: { value: REDUCED_MOTION ? 0 : 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vNormalW;
    varying vec3 vPosW;
    void main() {
      vUv = uv;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime, uMotion;
    varying vec2 vUv;
    varying vec3 vNormalW;
    varying vec3 vPosW;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.54;
      for (int i = 0; i < 5; i++) {
        value += amplitude * noise(p);
        p = p * 2.04 + vec2(13.2, 7.7);
        amplitude *= 0.52;
      }
      return value;
    }

    void main() {
      float drift = uTime * uMotion * 0.0022;
      vec2 p = vec2(vUv.x * 16.0 + drift, vUv.y * 8.0);
      float shape = fbm(p + fbm(p * 1.7) * 0.65);
      float bands = 0.76 + 0.24 * sin(vUv.y * 28.0 + fbm(p * 0.4) * 4.0);
      float coverage = smoothstep(0.57, 0.82, shape * bands);
      float edge = smoothstep(0.0, 0.14, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
      vec3 n = normalize(vNormalW);
      vec3 vDir = normalize(cameraPosition - vPosW);
      float facing = max(dot(n, vDir), 0.0);
      float shade = 0.82 + 0.18 * facing;
      float limbFade = smoothstep(0.0, 0.24, facing);
      gl_FragColor = vec4(vec3(0.965, 0.978, 1.0) * shade, coverage * edge * limbFade * 0.30);
    }`,
});
const clouds = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.011, 128, 80), cloudMat);
clouds.renderOrder = 0;
scene.add(clouds);

// Atmosphere halo
const haloMat = new THREE.ShaderMaterial({
  uniforms: {
    uRayleigh: { value: new THREE.Color('#3d8dff') },
    uMie: { value: new THREE.Color('#bfe4ff') },
  },
  side: THREE.BackSide,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    varying vec3 vNormalW;
    varying vec3 vPosW;
    void main() {
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uRayleigh, uMie;
    varying vec3 vNormalW;
    varying vec3 vPosW;
    void main() {
      vec3 n = normalize(vNormalW);
      vec3 vDir = normalize(cameraPosition - vPosW);
      float angle = 1.0 - abs(dot(n, vDir));
      float broad = pow(angle, 3.0);
      float rayleigh = pow(angle, 4.0);
      float mie = pow(angle, 11.0);
      vec3 color = uRayleigh * (rayleigh * 0.52 + broad * 0.10)
        + uMie * mie * 0.40;
      float alpha = clamp(rayleigh * 0.50 + broad * 0.08 + mie * 0.20, 0.0, 1.0);
      gl_FragColor = vec4(color, alpha);
    }`,
});
const halo = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.11, 72, 52), haloMat);
scene.add(halo);

// Graticule (very quiet)
{
  const pts = [];
  const pushSeg = (la1, lo1, la2, lo2) => {
    const a = lonLatToVec3(lo1, la1, GLOBE_R * 1.0015);
    const b = lonLatToVec3(lo2, la2, GLOBE_R * 1.0015);
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 4) pushSeg(lat, lon, lat, lon + 4);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -88; lat < 88; lat += 4) pushSeg(lat, lon, lat + 4, lon);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicMaterial({ color: 0x89a7c9, transparent: true, opacity: 0.055, depthWrite: false });
  scene.add(new THREE.LineSegments(g, m));
}

// Starfield. Two implicit depth layers shift at slightly different rates to add parallax.
{
  const starCount = 1100;
  const pos = new Float32Array(starCount * 3);
  const col = new Float32Array(starCount * 3);
  const depth = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const layer = Math.random() < 0.68 ? 0.25 + Math.random() * 0.35 : 0.65 + Math.random() * 0.35;
    const radius = THREE.MathUtils.lerp(15, 38, layer);
    const dir = new THREE.Vector3().randomDirection().multiplyScalar(radius);
    pos[i * 3] = dir.x; pos[i * 3 + 1] = dir.y; pos[i * 3 + 2] = dir.z;
    const tint = 0.75 + Math.random() * 0.25;
    col[i * 3] = tint * (0.82 + Math.random() * 0.18);
    col[i * 3 + 1] = tint * (0.86 + Math.random() * 0.14);
    col[i * 3 + 2] = tint;
    depth[i] = layer;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  starUniforms = {
    uPointer: { value: new THREE.Vector2() },
    uCameraDir: { value: new THREE.Vector3() },
    uScale: { value: 700 },
  };
  const starMat = new THREE.ShaderMaterial({
    uniforms: { ...starUniforms, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aDepth;
      uniform float uTime;
      uniform vec2 uPointer;
      uniform vec3 uCameraDir;
      uniform float uScale;
      varying vec3 vColor;
      varying float vDepth;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        vColor = color;
        vDepth = aDepth;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec4 clipPosition = projectionMatrix * mvPosition;
        vec2 drift = uPointer * (0.012 + 0.024 * aDepth)
          + uCameraDir.xy * (0.010 + 0.020 * aDepth);
        clipPosition.xy += drift * clipPosition.w;
        gl_Position = clipPosition;
        float twinkleSeed = hash(vec2(aDepth * 289.0, position.x + position.y));
        float twinkle = 0.72 + 0.28 * sin(uTime * (0.7 + twinkleSeed * 2.0) + twinkleSeed * 6.28);
        float size = (0.042 + 0.048 * aDepth) * twinkle * uScale / max(1.0, -mvPosition.z);
        gl_PointSize = clamp(size, 1.0, 5.5);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vDepth;
      void main() {
        float dist = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float alpha = smoothstep(1.0, 0.32, dist) * (0.60 + 0.50 * vDepth);
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    vertexColors: true,
  });
  const stars = new THREE.Points(g, starMat);
  starUniforms.uTwinkle = starMat.uniforms.uTime;
  stars.renderOrder = -2;
  scene.add(stars);
}

function updateStarProjection() {
  if (!starUniforms) return;
  const scale = renderer.domElement.height * 0.5 / Math.tan(camera.fov * DEG / 2);
  starUniforms.uScale.value = scale;
}
updateStarProjection();

scene.add(camera);

// Outlines container
const outlinesGroup = new THREE.Group();
scene.add(outlinesGroup);

const lineResolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
const outlineMaterials = [];
function makeOutlineMaterial(color, widthPx, opacity) {
  const mat = new LineMaterial({
    color: new THREE.Color(color),
    linewidth: widthPx,
    transparent: true,
    opacity,
    worldUnits: false,
    dashed: false,
    resolution: lineResolution.clone(),
  });
  outlineMaterials.push(mat);
  return mat;
}
const primaryLineMat = makeOutlineMaterial('#ffffff', 1.5, 1);
primaryLineMat.depthWrite = false;
const hoverLineMat = makeOutlineMaterial('#ffffff', 1, 0.32);
hoverLineMat.depthWrite = false;
const activeLineMat = makeOutlineMaterial('#ffffff', 2.4, 1);
activeLineMat.depthWrite = false;
const activeGlowLineMat = makeOutlineMaterial('#ffffff', 5.4, 0.16);
activeGlowLineMat.depthWrite = false;

// Invisible fills give the city polygons a stable hit area. They do not draw,
// but let the raycaster distinguish “inside Hangzhou” from nearby ocean/land.
const hitGroup = new THREE.Group();
hitGroup.renderOrder = -1;
scene.add(hitGroup);
const hitMaterial = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const placeHitMeshes = new Map();

function createSpherePolygonGeometry(rings) {
  const positions = [];
  const indices = [];
  const vertex = new THREE.Vector3();

  for (const ring of rings) {
    if (ring.length < 3) continue;
    const contour = ring.map(([lon, lat]) => new THREE.Vector2(lon, lat));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = positions.length / 3;
    for (const [lon, lat] of ring) {
      lonLatToVec3(lon, lat, GLOBE_R * 1.001, vertex);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
    for (const [a, b, c] of faces) indices.push(base + a, base + b, base + c);
  }

  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// Beacons (pulsing dots)
const beaconGeo = new THREE.BufferGeometry();
const beaconUniforms = {
  uTime: { value: 0 },
  uWorldSize: { value: 0.062 },
  uPerspective: { value: 1 },
  uMotion: { value: REDUCED_MOTION ? 0 : 1 },
};
const beaconMat = new THREE.ShaderMaterial({
  uniforms: beaconUniforms,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    uniform float uTime, uWorldSize, uPerspective, uMotion;
    varying float vWave;
    void main() {
      float cycle = fract(uTime / 2.8);
      float eased = 1.0 - pow(1.0 - cycle, 2.2);
      vWave = mix(0.66, eased, uMotion);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uWorldSize * uPerspective / (-mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vWave;
    void main() {
      float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
      vec3 white = vec3(1.0);
      float core = smoothstep(0.23, 0.02, d);
      float glow = exp(-d * 3.0) * 0.32;

      float ringRadius = mix(0.16, 1.00, vWave);
      float ring = exp(-pow((d - ringRadius) * 8.6, 2.0));
      float ringFade = pow(1.0 - vWave, 1.8) * smoothstep(0.0, 0.10, vWave);
      float ringAlpha = ring * ringFade;

      vec3 col = white * (core * 1.38 + glow + ring * ringFade * 0.98);
      float a = clamp(core * 1.00 + glow * 0.74 + ringAlpha, 0.0, 1.0);
      if (a < 0.02) discard;
      gl_FragColor = vec4(col, a);
    }`,
});
const beacons = new THREE.Points(beaconGeo, beaconMat);
beacons.renderOrder = 3;
beacons.raycast = (() => {
  const orig = THREE.Points.prototype.raycast;
  return function patched(raycaster, intersects) {
    const old = raycaster.params.Points.threshold;
    raycaster.params.Points.threshold = 0.030;
    orig.call(this, raycaster, intersects);
    raycaster.params.Points.threshold = old;
  };
})();
scene.add(beacons);

/* ------------------------------------------------------------------ */
/* Place details + travel photos                                       */
/* ------------------------------------------------------------------ */

const detailPanel = document.getElementById('detail-panel');
const viewTitle = document.getElementById('view-title');
const viewMonth = document.getElementById('view-month');
const viewSummaryLine = document.getElementById('view-summary-line');
const viewDesc = document.getElementById('view-desc');
const detailEditButton = document.getElementById('detail-edit-button');
const detailClose = document.getElementById('detail-close');
const albumStage = document.getElementById('album-stage');
const albumEmpty = document.getElementById('album-empty');
const albumPrev = document.getElementById('album-prev');
const albumNext = document.getElementById('album-next');
const albumCounter = document.getElementById('album-counter');
const editForm = document.getElementById('detail-edit');
const editClose = document.getElementById('edit-close');
const editTitle = document.getElementById('edit-title');
const editArrival = document.getElementById('edit-arrival');
const editDeparture = document.getElementById('edit-departure');
const editTripTitle = document.getElementById('edit-trip-title');
const editWeather = document.getElementById('edit-weather');
const editSummary = document.getElementById('edit-summary');
const editCancel = document.getElementById('edit-cancel');
const editSave = document.getElementById('edit-save');
const detailSaveStatus = document.getElementById('detail-save-status');
const photoGrid = document.getElementById('photo-grid');
const photoInput = document.getElementById('photo-input');
const photoStatus = document.getElementById('photo-status');
const uploadButton = document.querySelector('.upload-button');
const coverPreview = document.getElementById('cover-preview');
const coverImage = document.getElementById('cover-image');
const coverEmpty = document.getElementById('cover-empty');
const coverInput = document.getElementById('cover-input');
const coverRemove = document.getElementById('cover-remove');
const coverStatus = document.getElementById('cover-status');
const exportDataButton = document.getElementById('export-data');
const importDataButton = document.getElementById('import-data');
const importInput = document.getElementById('import-input');
const lightbox = document.getElementById('lightbox');
const lightboxImage = document.getElementById('lightbox-image');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxCounter = document.getElementById('lightbox-counter');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

const photoUrls = new Map();
const timelineCoverUrls = new Map();
let detailSaveTimer = null;
let coverStatusTimer = null;
let photoStatusTimer = null;
let renderingPlaceId = null;
let albumIndex = 0;
let albumFlipTimer = null;
let lightboxItems = [];
let lightboxIndex = 0;

function getPlaceMeta(id) {
  return store.visited.find((item) => item.id === id);
}

function getDetail(id) {
  if (!store.details[id]) {
    store.details[id] = { arrival: '', departure: '', tripTitle: '', weather: '', summary: '', photos: [], journals: {} };
  }
  const detail = store.details[id];
  detail.arrival ||= '';
  detail.departure ||= '';
  detail.tripTitle ||= '';
  detail.weather ||= '';
  detail.summary ||= '';
  detail.timelineCover ||= false;
  if (!detail.coverFocus || typeof detail.coverFocus !== 'object') detail.coverFocus = { x: 0.5, y: 0.5 };
  detail.coverFocus.x = THREE.MathUtils.clamp(Number(detail.coverFocus.x ?? 0.5), 0, 1);
  detail.coverFocus.y = THREE.MathUtils.clamp(Number(detail.coverFocus.y ?? 0.5), 0, 1);
  if (!Array.isArray(detail.photos)) detail.photos = [];
  if (!detail.journals || typeof detail.journals !== 'object' || Array.isArray(detail.journals)) detail.journals = {};
  for (const [date, text] of Object.entries(detail.journals)) {
    if (typeof text !== 'string') detail.journals[date] = '';
  }
  detail.photos.forEach((photo) => {
    photo.date ||= toISODate(new Date(photo.ts || Date.now())) || detail.arrival || '';
  });
  if (detail.photos.some((photo) => photo.order == null)) {
    detail.photos.sort((a, b) => {
      const dateDelta = String(a.date || '').localeCompare(String(b.date || ''));
      return dateDelta || (a.ts || 0) - (b.ts || 0);
    });
    detail.photos.forEach((photo, index) => { photo.order = index; });
  }
  detail.photos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return detail;
}

function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}${uuid.replaceAll('-', '')}` : `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function releasePlacePhotoUrls(id) {
  for (const [key, url] of [...photoUrls]) {
    if (key.startsWith(`${id}:`)) {
      URL.revokeObjectURL(url);
      photoUrls.delete(key);
    }
  }
}

function releaseAllPlacePhotoUrls() {
  for (const [key, url] of [...photoUrls]) {
    URL.revokeObjectURL(url);
    photoUrls.delete(key);
  }
  for (const [key, url] of [...timelineCoverUrls]) {
    URL.revokeObjectURL(url);
    timelineCoverUrls.delete(key);
  }
}

async function ensurePlacePhotoUrls(id) {
  const detail = getDetail(id);
  await Promise.all(detail.photos.map(async (photo) => {
    const key = photoStorageKey(id, photo.id);
    if (photoUrls.has(key)) return;
    const blob = await loadPhotoBlob(key);
    if (blob) photoUrls.set(key, URL.createObjectURL(blob));
  }));
}

function setSaveStatus(message = '已自动保存') {
  detailSaveStatus.textContent = message;
  detailSaveStatus.classList.remove('photo-toast');
  clearTimeout(detailSaveTimer);
  detailSaveTimer = setTimeout(() => {
    detailSaveStatus.textContent = '';
  }, 1800);
}

function setPhotoStatus(message, isError = false) {
  photoStatus.textContent = message;
  photoStatus.classList.toggle('photo-toast', isError);
  clearTimeout(photoStatusTimer);
  photoStatusTimer = setTimeout(() => {
    photoStatus.textContent = '';
  }, 2600);
}

function setCoverStatus(message, isError = false) {
  coverStatus.textContent = message;
  coverStatus.classList.toggle('photo-toast', isError);
  clearTimeout(coverStatusTimer);
  coverStatusTimer = setTimeout(() => {
    coverStatus.textContent = '';
  }, 2600);
}

function renderCoverPreview(id) {
  const hasCover = Boolean(timelineCoverUrls.get(timelineCoverKey(id)));
  coverImage.src = hasCover ? timelineCoverUrls.get(timelineCoverKey(id)) : '';
  coverImage.hidden = !hasCover;
  coverEmpty.hidden = hasCover;
  coverRemove.hidden = !hasCover;
}

async function ensureTimelineCoverUrls() {
  await Promise.all(store.visited.map(async (meta) => {
    const detail = getDetail(meta.id);
    if (!detail.timelineCover) return;
    const key = timelineCoverKey(meta.id);
    if (timelineCoverUrls.has(key)) return;
    const blob = await loadPhotoBlob(key);
    if (blob) timelineCoverUrls.set(key, URL.createObjectURL(blob));
  }));
}

function renderPhotoGrid(id) {
  const detail = getDetail(id);
  photoGrid.replaceChildren();
  if (!detail.photos.length) {
    const empty = document.createElement('p');
    empty.className = 'photo-empty';
    empty.textContent = '还没有照片。上传几张车票、街角或海岸，让这份足迹更完整。';
    photoGrid.appendChild(empty);
    return;
  }

  for (const photo of detail.photos) {
    const card = document.createElement('figure');
    card.className = 'photo-card';
    card.draggable = true;
    card.tabIndex = 0;
    card.dataset.photoId = photo.id;
    const media = document.createElement('div');
    media.className = 'photo';
    const image = document.createElement('img');
    const key = photoStorageKey(id, photo.id);
    image.alt = photo.caption || `${getPlaceMeta(id)?.name || '旅行'}照片`;
    image.src = photoUrls.get(key) || '';
    image.loading = 'lazy';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-delete';
    remove.title = '删除照片';
    remove.setAttribute('aria-label', `删除照片：${photo.caption || image.alt}`);
    remove.innerHTML = ICON_REMOVE;
    remove.addEventListener('click', () => removePhoto(id, photo.id));
    media.append(image, remove);

    const caption = document.createElement('input');
    caption.className = 'photo-caption';
    caption.setAttribute('aria-label', '图片说明');
    caption.value = photo.caption || '';
    caption.placeholder = '添加图片说明';
    caption.addEventListener('change', () => {
      photo.caption = caption.value.trim();
      persist();
      setSaveStatus();
    });

    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'photo-date';
    date.setAttribute('aria-label', '照片所属日期');
    date.value = photo.date || '';
    date.addEventListener('change', () => {
      photo.date = date.value || photo.date;
      persist();
      renderPhotoGrid(id);
      setSaveStatus();
    });

    card.append(media, caption, date);
    photoGrid.appendChild(card);

    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', photo.id);
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('is-drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('is-drag-over'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('is-drag-over');
      const sourceId = event.dataTransfer.getData('text/plain') || card.dataset.photoId;
      reorderPhotos(id, sourceId, photo.id, event.clientX < event.currentTarget.getBoundingClientRect().left + event.currentTarget.offsetWidth / 2);
    });
    card.addEventListener('keydown', (event) => {
      if (!event.altKey) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); movePhotoByOffset(id, photo.id, -1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); movePhotoByOffset(id, photo.id, 1); }
    });
  }
}

function normalizePhotoOrder(detail) {
  detail.photos.forEach((photo, index) => { photo.order = index; });
}

function reorderPhotos(placeId, sourceId, targetId, beforeTarget) {
  if (sourceId === targetId) return;
  const detail = getDetail(placeId);
  const sourceIndex = detail.photos.findIndex((photo) => photo.id === sourceId);
  const targetIndex = detail.photos.findIndex((photo) => photo.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return;
  const [photo] = detail.photos.splice(sourceIndex, 1);
  const targetAfterRemoval = targetIndex - (sourceIndex < targetIndex ? 1 : 0);
  const insertIndex = beforeTarget ? targetAfterRemoval : targetAfterRemoval + 1;
  detail.photos.splice(insertIndex, 0, photo);
  normalizePhotoOrder(detail);
  persist();
  renderPhotoGrid(placeId);
  if (renderingPlaceId === placeId) renderAlbum(placeId);
  setSaveStatus('顺序已调整');
}

function movePhotoByOffset(placeId, photoId, offset) {
  const detail = getDetail(placeId);
  const index = detail.photos.findIndex((photo) => photo.id === photoId);
  const next = index + offset;
  if (index === -1 || next < 0 || next >= detail.photos.length) return;
  const [photo] = detail.photos.splice(index, 1);
  detail.photos.splice(next, 0, photo);
  normalizePhotoOrder(detail);
  persist();
  renderPhotoGrid(placeId);
  if (renderingPlaceId === placeId) renderAlbum(placeId);
  setSaveStatus('顺序已调整');
}

async function renderDetail(id) {
  const meta = getPlaceMeta(id);
  if (!meta) return;
  renderingPlaceId = id;
  const detail = getDetail(id);

  viewTitle.textContent = meta.name;
  viewMonth.textContent = formatMonth(detail.arrival || detail.departure);
  viewMonth.hidden = !viewMonth.textContent;

  const summaryParts = [formatDateRange(detail), detail.tripTitle, detail.weather].filter(Boolean);
  viewSummaryLine.replaceChildren();
  if (summaryParts.length) {
    for (const part of summaryParts) {
      const span = document.createElement('span');
      span.textContent = part;
      viewSummaryLine.appendChild(span);
    }
    viewSummaryLine.hidden = false;
  } else {
    viewSummaryLine.hidden = true;
  }

  if (detail.summary) {
    viewDesc.textContent = detail.summary;
    viewDesc.hidden = false;
  } else {
    viewDesc.hidden = true;
  }

  renderAlbum(id);
  renderPhotoGrid(id);
  try {
    await ensurePlacePhotoUrls(id);
    if (renderingPlaceId === id) {
      renderAlbum(id);
      renderPhotoGrid(id);
    }
  } catch (err) {
    console.warn('Unable to load travel photos', err);
    if (renderingPlaceId === id) setPhotoStatus('本地图片读取失败', true);
  }
}

function formatMonth(dateStr) {
  const match = /^(\d{4})-(\d{2})/.exec(dateStr || '');
  return match ? `${match[1]}年${match[2]}月` : '';
}

function formatDay(dateStr) {
  return dateStr ? dateStr.replaceAll('-', '.') : '';
}

function formatDateRange(detail) {
  const a = formatDay(detail.arrival);
  const d = formatDay(detail.departure);
  if (a && d && a !== d) return `${a}-${d}`;
  return a || d || '';
}

function renderAlbum(id) {
  const detail = getDetail(id);
  const name = getPlaceMeta(id)?.name || '旅行';
  albumStage.replaceChildren();
  albumIndex = 0;
  clearTimeout(albumFlipTimer);

  if (!detail.photos.length) {
    albumEmpty.hidden = false;
    albumPrev.hidden = true;
    albumNext.hidden = true;
    albumCounter.hidden = true;
    albumStage.classList.remove('has-photos');
    return;
  }

  albumEmpty.hidden = true;
  albumStage.classList.add('has-photos');
  detail.photos.forEach((photo, index) => {
    const slide = document.createElement('figure');
    slide.className = 'album-slide';
    const image = document.createElement('img');
    const key = photoStorageKey(id, photo.id);
    image.alt = photo.caption || `${name}照片 ${index + 1}`;
    image.src = photoUrls.get(key) || '';
    image.loading = index === 0 ? 'eager' : 'lazy';
    image.addEventListener('click', () => {
      const items = detail.photos.map((photo, itemIndex) => ({
        src: photoUrls.get(photoStorageKey(id, photo.id)) || '',
        caption: photo.caption || `${name}照片 ${itemIndex + 1}`,
      }));
      openLightbox(items, index);
    });
    slide.appendChild(image);
    albumStage.appendChild(slide);
  });
  albumStage.children[0].classList.add('is-active');
  updateAlbumControls();
}

function updateLightbox() {
  const item = lightboxItems[lightboxIndex];
  if (!item) return;
  lightboxImage.src = item.src;
  lightboxImage.alt = item.caption;
  lightboxCaption.textContent = item.caption;
  lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
}

function openLightbox(items, index = 0) {
  lightboxItems = items.filter((item) => item.src);
  if (!lightboxItems.length) return;
  lightboxIndex = THREE.MathUtils.clamp(index, 0, lightboxItems.length - 1);
  updateLightbox();
  lightbox.hidden = false;
  requestAnimationFrame(() => lightbox.classList.add('is-open'));
  lightboxClose.focus({ preventScroll: true });
}

function closeLightbox() {
  lightbox.classList.remove('is-open');
  setTimeout(() => {
    lightbox.hidden = true;
    lightboxImage.src = '';
  }, 240);
}

function lightboxGo(offset) {
  if (!lightboxItems.length) return;
  lightboxIndex = (lightboxIndex + offset + lightboxItems.length) % lightboxItems.length;
  updateLightbox();
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => lightboxGo(-1));
lightboxNext.addEventListener('click', () => lightboxGo(1));
lightbox.addEventListener('click', (event) => {
  if (event.target === lightbox || event.target.classList.contains('lightbox-figure')) closeLightbox();
});

function updateAlbumControls() {
  const count = albumStage.children.length;
  albumPrev.hidden = count < 2;
  albumNext.hidden = count < 2;
  albumCounter.hidden = count < 2;
  if (count >= 2) albumCounter.textContent = `${albumIndex + 1} / ${count}`;
}

function albumGo(delta) {
  const count = albumStage.children.length;
  if (count < 2) return;
  const dir = delta > 0 ? 1 : -1;
  const next = (albumIndex + delta + count) % count;
  const current = albumStage.children[albumIndex];
  const target = albumStage.children[next];
  if (current === target) return;

  current.classList.remove('is-active');
  current.classList.remove('exit-left', 'exit-right');
  void current.offsetWidth;
  current.classList.add(dir > 0 ? 'exit-left' : 'exit-right');

  target.classList.remove('is-active', 'exit-left', 'exit-right');
  target.classList.add(dir > 0 ? 'enter-right' : 'enter-left');
  void target.offsetWidth;
  target.classList.add('is-active');
  target.classList.remove('enter-right', 'enter-left');

  albumIndex = next;
  updateAlbumControls();
  clearTimeout(albumFlipTimer);
  albumFlipTimer = setTimeout(() => {
    current.classList.remove('exit-left', 'exit-right');
  }, 520);
}

function openDetail(id, { fly = false } = {}) {
  const meta = getPlaceMeta(id);
  if (!meta) return;
  const shouldFly = fly && selectedPlaceId !== id;
  selectedPlaceId = id;
  if (hoveredPlaceId === id) {
    hoveredPlaceId = null;
    hoverGrowth = null;
  }
  refreshPlaceVisualStyles();
  setDetailMode('view');
  detailPanel.hidden = false;
  requestAnimationFrame(() => {
    detailPanel.classList.add('is-open');
    detailPanel.focus({ preventScroll: true });
  });
  renderDetail(id);
  if (shouldFly) flyTo(meta.center);
}

function setDetailMode(mode) {
  detailPanel.dataset.mode = mode;
  if (mode === 'edit') {
    const id = selectedPlaceId || renderingPlaceId;
    if (!id) return;
    const meta = getPlaceMeta(id);
    const detail = getDetail(id);
    editTitle.value = meta?.name || '';
    editArrival.value = detail.arrival;
    editDeparture.value = detail.departure;
    editTripTitle.value = detail.tripTitle;
    editWeather.value = detail.weather;
    editSummary.value = detail.summary;
    renderCoverPreview(id);
    detailSaveStatus.textContent = '';
  }
}

function saveEdit(event) {
  event.preventDefault();
  const id = selectedPlaceId || renderingPlaceId;
  const meta = id && getPlaceMeta(id);
  if (!meta) return;
  const detail = getDetail(id);
  meta.name = editTitle.value.trim() || '未命名地点';
  detail.arrival = editArrival.value;
  detail.departure = editDeparture.value;
  detail.tripTitle = editTripTitle.value.trim();
  detail.weather = editWeather.value.trim();
  detail.summary = editSummary.value.trim();
  persist();
  refreshChips();
  if (isPlaceRoute()) {
    closeDetail();
    selectedPlaceId = id;
    renderPlacePage(id);
  } else {
    setDetailMode('view');
    renderDetail(id);
  }
  showToast('已保存');
}

function closeDetail() {
  detailPanel.classList.remove('is-open');
  detailPanel.hidden = true;
  selectedPlaceId = null;
  refreshPlaceVisualStyles();
}

window.addEventListener('keydown', (event) => {
  if (lightbox.hidden) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') lightboxGo(-1);
  if (event.key === 'ArrowRight') lightboxGo(1);
});

async function addPhotos(files) {
  const id = selectedPlaceId || renderingPlaceId;
  const meta = id && getPlaceMeta(id);
  if (!meta || !files?.length) return;
  const detail = getDetail(id);
  const images = [...files].filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  uploadButton.classList.add('is-loading');
  setPhotoStatus('正在导入照片…');
  let added = 0;
  try {
    for (const file of images) {
      const photoId = createId('p');
      const key = photoStorageKey(id, photoId);
      const blob = await compressImage(file);
      await savePhotoBlob(key, blob);
      photoUrls.set(key, URL.createObjectURL(blob));
      detail.photos.push({
        id: photoId,
        caption: '',
        date: detail.arrival || toISODate(new Date()),
        ts: Date.now(),
        order: detail.photos.length,
      });
      added += 1;
    }
    persist();
    if (renderingPlaceId === id) renderPhotoGrid(id);
    if (renderingPlacePageId === id) renderPlacePage(id);
    setPhotoStatus(`已添加 ${added} 张照片`);
  } catch (err) {
    console.warn('Photo upload failed', err);
    setPhotoStatus('照片保存失败，请重试', true);
  } finally {
    uploadButton.classList.remove('is-loading');
    photoInput.value = '';
  }
}

async function removePhoto(placeId, photoId) {
  const detail = getDetail(placeId);
  const index = detail.photos.findIndex((item) => item.id === photoId);
  if (index === -1) return;
  const [photo] = detail.photos.splice(index, 1);
  const key = photoStorageKey(placeId, photoId);
  try {
    await removePhotoBlob(key);
  } catch (err) {
    console.warn('Unable to delete photo blob', err);
  }
  const url = photoUrls.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    photoUrls.delete(key);
  }
  persist();
  renderPhotoGrid(placeId);
  setPhotoStatus('已删除照片');
}

async function addTimelineCover(files) {
  const id = selectedPlaceId || renderingPlaceId;
  if (!id || !files?.length) return;
  const file = [...files].find((item) => item.type.startsWith('image/'));
  if (!file) return;
  setCoverStatus('正在处理封面…');
  try {
    const sourceBlob = await compressCoverSource(file);
    const sourceKey = timelineCoverSourceKey(id);
    await savePhotoBlob(sourceKey, sourceBlob);
    const detail = getDetail(id);
    const blob = await compressTimelineCover(sourceBlob, detail.coverFocus.x, detail.coverFocus.y);
    const key = timelineCoverKey(id);
    const oldUrl = timelineCoverUrls.get(key);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    await savePhotoBlob(key, blob);
    timelineCoverUrls.set(key, URL.createObjectURL(blob));
    getDetail(id).timelineCover = true;
    persist();
    renderCoverPreview(id);
    setCoverStatus('封面已更新');
    if (!timelinePage.hidden) renderTimeline();
  } catch (err) {
    console.warn('Timeline cover upload failed', err);
    setCoverStatus('封面上传失败，请重试', true);
  } finally {
    coverInput.value = '';
  }
}

async function removeTimelineCover() {
  const id = selectedPlaceId || renderingPlaceId;
  if (!id) return;
  const key = timelineCoverKey(id);
  const url = timelineCoverUrls.get(key);
  await Promise.allSettled([
    removePhotoBlob(key),
    removePhotoBlob(timelineCoverSourceKey(id)),
  ]);
  if (url) {
    URL.revokeObjectURL(url);
    timelineCoverUrls.delete(key);
  }
  const detail = getDetail(id);
  delete detail.timelineCover;
  persist();
  renderCoverPreview(id);
  setCoverStatus('封面已移除');
  if (!timelinePage.hidden) renderTimeline();
}

async function updateTimelineCoverFocus(event) {
  const id = selectedPlaceId || renderingPlaceId;
  if (!id || !coverImage || coverImage.hidden) return;
  const rect = coverImage.getBoundingClientRect();
  const focusX = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const focusY = THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height, 0, 1);
  const detail = getDetail(id);
  detail.coverFocus = { x: focusX, y: focusY };
  setCoverStatus('正在调整焦点…');
  try {
    const source = await loadPhotoBlob(timelineCoverSourceKey(id));
    if (!source) throw new Error('Original cover missing');
    const blob = await compressTimelineCover(source, focusX, focusY);
    const key = timelineCoverKey(id);
    const oldUrl = timelineCoverUrls.get(key);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    await savePhotoBlob(key, blob);
    timelineCoverUrls.set(key, URL.createObjectURL(blob));
    persist();
    renderCoverPreview(id);
    setCoverStatus('焦点已更新');
    if (!timelinePage.hidden) renderTimeline();
  } catch (err) {
    console.warn('Cover focus update failed', err);
    setCoverStatus('焦点更新失败', true);
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read blob'));
    reader.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataURL) {
  const [meta, base64] = String(dataURL).split(',');
  const type = /^data:([^;]+)/.exec(meta)?.[1] || 'image/jpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

function normalizeImportedDetail(raw) {
  const detail = {
    arrival: raw?.arrival || '',
    departure: raw?.departure || '',
    tripTitle: raw?.tripTitle || '',
    weather: raw?.weather || '',
    summary: raw?.summary || '',
    photos: Array.isArray(raw?.photos) ? raw.photos : [],
    journals: raw?.journals && typeof raw.journals === 'object' ? raw.journals : {},
  };
  if (raw?.coverFocus) detail.coverFocus = raw.coverFocus;
  if (raw?.timelineCover) detail.timelineCover = true;
  return detail;
}

async function exportBackup() {
  try {
    showToast('正在准备备份…');
    const payload = {
      format: 'xingji-backup.v1',
      exportedAt: new Date().toISOString(),
      places: [],
    };

    for (const meta of store.visited) {
      const detail = structuredClone(getDetail(meta.id));
      const photos = {};
      const imageKeys = [
        ...detail.photos.map((photo) => photoStorageKey(meta.id, photo.id)),
        timelineCoverKey(meta.id),
        timelineCoverSourceKey(meta.id),
      ];
      for (const key of imageKeys) {
        const blob = await loadPhotoBlob(key);
        if (blob) photos[key] = await blobToDataURL(blob);
      }
      payload.places.push({ meta, detail, geo: store.geo[meta.id] || null, photos });
    }

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `xingji-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('备份已导出');
  } catch (err) {
    console.warn('Backup export failed', err);
    showToast('备份导出失败');
  }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (raw?.format !== 'xingji-backup.v1' || !Array.isArray(raw.places)) {
      showToast('备份格式不支持');
      return;
    }
    if (!window.confirm('导入备份会替换当前所有足迹、日记和图片，确定继续吗？')) return;

    showToast('正在导入备份…');
    for (const id of Object.keys(store.details)) await deletePlaceMedia(id);
    const mediaDb = await openMediaDb();
    await requestToPromise(mediaDb.transaction(MEDIA_STORE, 'readwrite').objectStore(MEDIA_STORE).clear());
    releaseAllPlacePhotoUrls();

    store.visited = [];
    store.details = {};
    store.geo = {};

    for (const place of raw.places) {
      const meta = place.meta;
      if (!meta?.id) continue;
      const detail = normalizeImportedDetail(place.detail);
      store.visited.push(meta);
      store.details[meta.id] = detail;
      for (const [key, dataURL] of Object.entries(place.photos || {})) {
        await savePhotoBlob(key, dataURLToBlob(dataURL));
      }
      if (place.geo?.rings) await saveGeometry(meta.id, place.geo);
    }

    persist();
    rebuildAllVisuals();
    refreshChips();
    await ensureTimelineCoverUrls();
    if (!timelinePage.hidden) renderTimeline();
    if (!placePage.hidden && currentPlacePageId) renderPlacePage(currentPlacePageId);
    if (!detailPanel.hidden && selectedPlaceId) renderDetail(selectedPlaceId);
    showToast('备份已导入');
  } catch (err) {
    console.warn('Backup import failed', err);
    showToast('备份导入失败');
  } finally {
    importInput.value = '';
  }
}

exportDataButton.addEventListener('click', exportBackup);
importDataButton.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => importBackup(importInput.files[0]));

detailClose.addEventListener('click', closeDetail);
detailEditButton.addEventListener('click', () => setDetailMode('edit'));
editClose.addEventListener('click', () => {
  setDetailMode('view');
  if (isPlaceRoute()) closeDetail();
});
editCancel.addEventListener('click', () => {
  setDetailMode('view');
  if (isPlaceRoute()) closeDetail();
});
editForm.addEventListener('submit', saveEdit);
photoInput.addEventListener('change', () => addPhotos(photoInput.files));
coverInput.addEventListener('change', () => addTimelineCover(coverInput.files));
coverRemove.addEventListener('click', () => removeTimelineCover());
coverPreview.addEventListener('click', updateTimelineCoverFocus);
albumPrev.addEventListener('click', () => albumGo(-1));
albumNext.addEventListener('click', () => albumGo(1));

detailPanel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (detailPanel.dataset.mode === 'edit') setDetailMode('view');
    else closeDetail();
  }
  if (detailPanel.dataset.mode !== 'view') return;
  if (event.key === 'ArrowLeft') albumGo(-1);
  if (event.key === 'ArrowRight') albumGo(1);
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || detailPanel.hidden || document.activeElement === searchInput) return;
  if (detailPanel.dataset.mode === 'edit') setDetailMode('view');
  else closeDetail();
});

const placeVisuals = new Map(); // id -> LineSegments2

function addPlaceVisual(id, rings) {
  const chunks = [];
  for (const ring of rings) {
    const segs = ringToSegmentPositions(ring);
    if (segs) chunks.push(...segs);
  }
  if (!chunks.length) return;
  const geom = new LineSegmentsGeometry().setPositions(new Float32Array(chunks));
  const line = new LineSegments2(geom, hoverLineMat);
  line.visible = false;
  line.frustumCulled = false;
  line.computeLineDistances?.();
  line.userData.placeId = id;
  line.renderOrder = 2;
  const glow = new LineSegments2(geom, activeGlowLineMat);
  glow.renderOrder = 1;
  glow.visible = false;
  line.add(glow);

  outlinesGroup.add(line);
  placeVisuals.set(id, line);

  const hitGeometry = createSpherePolygonGeometry(rings);
  if (hitGeometry) {
    const hitMesh = new THREE.Mesh(hitGeometry, hitMaterial);
    hitMesh.userData.placeId = id;
    hitGroup.add(hitMesh);
    placeHitMeshes.set(id, hitMesh);
  }
}

function outlineSegmentCount(geometry) {
  return geometry.attributes.instanceStart?.count
    || Math.floor((geometry.attributes.position?.count || 0) / 6);
}

function removePlaceVisual(id) {
  const line = placeVisuals.get(id);
  if (!line) return;
  outlinesGroup.remove(line);
  line.geometry.dispose();
  placeVisuals.delete(id);
  const hitMesh = placeHitMeshes.get(id);
  if (hitMesh) {
    hitGroup.remove(hitMesh);
    hitMesh.geometry.dispose();
    placeHitMeshes.delete(id);
  }
}

let hoveredPlaceId = null;
let selectedPlaceId = null;
let hoverGrowth = null;

function refreshPlaceVisualStyles() {
  for (const [id, line] of placeVisuals) {
    const active = id === selectedPlaceId;
    const hovered = id === hoveredPlaceId;
    const glow = line.children[0];
    const segmentCount = outlineSegmentCount(line.geometry);
    if (glow) glow.visible = active;
    line.material = active ? activeLineMat : hovered ? hoverLineMat : primaryLineMat;
    line.visible = active || hovered;
    if (active || (!hovered && (!hoverGrowth || hoverGrowth.id !== id))) {
      line.geometry.instanceCount = segmentCount;
    }
  }
}

function setHoveredPlace(id) {
  if (hoveredPlaceId === id && id !== selectedPlaceId) return;
  if (id && id === selectedPlaceId) {
    hoveredPlaceId = null;
    hoverGrowth = null;
    refreshPlaceVisualStyles();
    return;
  }
  hoveredPlaceId = id;
  if (id) {
    const line = placeVisuals.get(id);
    if (line) {
      hoverGrowth = { id, start: performance.now() };
      line.geometry.instanceCount = REDUCED_MOTION ? outlineSegmentCount(line.geometry) : 0;
    }
  } else {
    hoverGrowth = null;
  }
  refreshPlaceVisualStyles();
}

function rebuildAllVisuals() {
  for (const id of [...placeVisuals.keys()]) removePlaceVisual(id);
  for (const meta of store.visited) {
    const geo = store.geo[meta.id];
    if (geo?.rings) addPlaceVisual(meta.id, geo.rings);
  }
  refreshPlaceVisualStyles();
  rebuildBeacons();
}

function rebuildBeacons() {
  const n = store.visited.length;
  const pos = new Float32Array(n * 3);
  store.visited.forEach((meta, i) => {
    const v = lonLatToVec3(meta.center[0], meta.center[1], BEACON_R);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
  });
  beaconGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  beaconGeo.setDrawRange(0, n);
  beaconGeo.computeBoundingSphere();
}

/* ------------------------------------------------------------------ */
/* Camera flight                                                       */
/* ------------------------------------------------------------------ */

let flight = null;
function flyTo(center) {
  const target = lonLatToVec3(center[0], center[1], 1).normalize();
  const startDir = camera.position.clone().normalize();
  const angle = startDir.angleTo(target);
  const currentDist = camera.position.length();
  if (!REDUCED_MOTION && angle < 0.012) {
    lastInteract = performance.now();
    return;
  }

  // Short moves stay at a constant viewing distance. The zoom-out arc only
  // appears once the camera really has a long way to travel around the globe.
  const arcMix = THREE.MathUtils.smoothstep(angle, 0.42, 1.18);
  const settleMix = THREE.MathUtils.smoothstep(angle, 0.78, 1.65);
  const settledDist = THREE.MathUtils.clamp(currentDist, 2.0, 2.5);
  const endDist = THREE.MathUtils.lerp(currentDist, settledDist, settleMix);
  const peakExtra = THREE.MathUtils.lerp(0.015, 0.32 + angle * 0.20, arcMix);
  const desiredPeak = Math.max(currentDist, endDist) + peakExtra;
  const peakDist = currentDist > 4.2 ? currentDist : Math.min(desiredPeak, 4.2);
  flight = {
    start: startDir,
    end: target,
    quaternion: new THREE.Quaternion().setFromUnitVectors(startDir, target),
    radiusFrom: currentDist,
    radiusTo: endDist,
    radiusPeak: peakDist,
    t: 0,
    duration: REDUCED_MOTION ? 0.01 : THREE.MathUtils.clamp(0.74 + angle * 0.56, 0.82, 2.05),
  };
  controls.autoRotate = false;
  lastInteract = performance.now();
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

const searchInput = document.getElementById('search-input');
const searchStatus = document.getElementById('search-status');
const resultsEl = document.getElementById('results');
let searchTimer = null;
let abortCtrl = null;
let chinaAreasPromise = null;

function setStatus(msg, isError = false) {
  searchStatus.textContent = msg;
  searchStatus.classList.toggle('is-error', isError);
}

function clearSearchUi() {
  searchInput.value = '';
  resultsEl.hidden = true;
  resultsEl.replaceChildren();
  setStatus(DEFAULT_HINT);
}

async function runSearch(query) {
  abortCtrl?.abort();
  const ctrl = new AbortController();
  abortCtrl = ctrl;
  setStatus(`正在搜索 「${query}」…`);
  try {
    const [localRows, remoteRows] = await Promise.allSettled([
      loadChinaAreas().catch(() => []),
      queryPhoton(query),
    ]);

    if (ctrl.signal.aborted) return;
    const places = [
      ...(localRows.status === 'fulfilled' ? searchChinaIndex(localRows.value, query) : []),
      ...(remoteRows.status === 'fulfilled' ? normalizePhotonRows(remoteRows.value) : []),
    ].slice(0, 8);

    renderResults(places);
    if (!places.length) {
      const networkFailed = remoteRows.status === 'rejected';
      setStatus(networkFailed
        ? '搜索服务暂时不可用，请稍后重试。'
        : '没有找到合适的行政区域，试试更完整的名称。', true);
    } else if (places[0].source === 'osm') {
      setStatus('选择结果后，会立即从 OpenStreetMap 边界服务加载轮廓。');
    } else {
      setStatus('在中国区划数据库中找到了结果，选择后会显示边界。');
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (err?.name === 'TimeoutError') {
      setStatus('搜索请求超时了。中国城市通常可直接搜索，国际地名可稍后重试。', true);
      return;
    }
    console.warn('geocode failed', err);
    setStatus('无法连接搜索服务，请检查网络后重试。', true);
  }
}

function loadChinaAreas() {
  chinaAreasPromise ||= fetch(CHINA_INDEX_URL)
    .then((res) => res.json());
  return chinaAreasPromise;
}

async function fetchRelayed(localUrl, remoteUrl, timeoutMs) {
  const localRes = await fetchWithTimeout(localUrl, timeoutMs);
  if (localRes.status !== 404) return localRes;
  return fetchWithTimeout(remoteUrl, timeoutMs);
}

function searchChinaIndex(rows, query) {
  const q = query.toLowerCase();
  const parentNames = new Map(rows.map((row) => [String(row.adcode), row.name]));
  return rows
    .filter((row) => ['province', 'city', 'district'].includes(row.level) && String(row.name).toLowerCase().includes(q))
    .sort((a, b) => {
      const rank = (row) => (String(row.name).toLowerCase() === q ? 0 : String(row.name).toLowerCase().startsWith(q) ? 1 : 2);
      return rank(a) - rank(b) || a.adcode - b.adcode;
    })
    .slice(0, 6)
    .map((row) => ({
      id: `CN:${row.adcode}`,
      source: 'cn',
      adcode: String(row.adcode),
      name: cnDisplayTitle(row, parentNames.get(String(row.parent))),
      country: '中国',
      kind: typeLabel({ type: row.level }),
      center: [rnd5(row.lng), rnd5(row.lat)],
      meta: [parentNames.get(String(row.parent)), '中国行政区划'].filter(Boolean).join(' · '),
    }));
}

/* City rows default to “省名 + 市名”（如 浙江杭州）；省市区之外保持原名。 */
function cnDisplayTitle(row, parentName) {
  const name = row.name || '';
  if (row.level !== 'city') return name;
  const prov = (parentName || '').replace(/省$/, '');
  const city = name.replace(/市$/, '');
  if (!prov || prov === city || name === parentName) return city || name;
  return `${prov}${city}`;
}

async function queryPhoton(query) {
  const params = new URLSearchParams({ q: query, limit: '12' });
  const res = await fetchRelayed(`${API_BASE}/photon?${params}`, `${PHOTON_BASE}?${params}`, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  return res.json();
}

function normalizePhotonRows(payload) {
  const wantedTypes = new Set([
    'city', 'town', 'state', 'province', 'county', 'district', 'municipality', 'suburb', 'borough', 'country',
  ]);
  const rows = (payload.features || [])
    .filter((feature) => {
      const p = feature.properties || {};
      return p.osm_type === 'R' && (wantedTypes.has(p.type) || p.osm_key === 'boundary');
    })
    .slice(0, 5)
    .map((feature) => {
      const p = feature.properties || {};
      const center = feature.geometry?.coordinates || [];
      const kind = typeLabel({ type: p.type });
      return {
        id: `R${p.osm_id}`,
        source: 'osm',
        osmId: String(p.osm_id),
        name: p.name || p.city || p.county || p.state || `OSM ${p.osm_id}`,
        country: p.country || '',
        kind: kind === '区域' ? '行政区' : kind,
        center: [rnd5(center[0]), rnd5(center[1])],
        meta: [p.city, p.county, p.state, p.country].filter(Boolean).join(' · '),
      };
    });
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

function typeLabel(item) {
  return TYPE_LABELS[item.type] || (item.class === 'boundary' ? '边界' : item.type || '区域');
}

function renderResults(places) {
  resultsEl.replaceChildren();
  for (const item of places) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'result';
    const text = document.createElement('span');
    text.className = 'result-text';
    const name = document.createElement('strong');
    name.className = 'result-name';
    name.textContent = item.name || '(未命名)';
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent = item.meta || '';
    text.append(name, meta);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = item.kind || (item.source === 'cn' ? '中国区划' : '行政区');
    btn.append(text, badge);
    btn.addEventListener('click', () => markPlace(item));
    li.appendChild(btn);
    resultsEl.appendChild(li);
  }
  resultsEl.hidden = places.length === 0;
}

function uniqueIdFor(item) {
  if (item.id) return item.id;
  if (item.osm_type && item.osm_id) return item.osm_type[0].toUpperCase() + String(item.osm_id);
  return 'N' + hash01(item.name || String(Date.now())).toString(36) + Date.now().toString(36);
}

async function fetchChinaBoundary(adcode) {
  const res = await fetchRelayed(`${API_BASE}/datav/${adcode}.json`, `${DATAV_BASE}${adcode}.json`, BOUNDARY_TIMEOUT_MS);
  if (!res.ok) throw new Error(`DataV ${res.status}`);
  return res.json();
}

/* Older saves may still carry district-level collections; silently upgrade
   them to the single city outline now served by the proxy. */
async function refreshChinaGeometries() {
  for (const meta of store.visited) {
    if (!meta.id.startsWith('CN:')) continue;
    try {
      const cached = store.geo[meta.id];
      if (
        cached?.version === GEO_CACHE_VERSION
        && Date.now() - Number(cached.ts || 0) < GEO_REFRESH_MS
      ) continue;
      const raw = await fetchChinaBoundary(meta.id.slice(3));
      const prepared = prepareGeometry(raw);
      if (!prepared) continue;
      store.geo[meta.id] = prepared;
      await saveGeometry(meta.id, prepared);
      removePlaceVisual(meta.id);
      addPlaceVisual(meta.id, prepared.rings);
      refreshPlaceVisualStyles();
    } catch (err) {
      console.warn('boundary refresh skipped', meta.name, err);
    }
  }
}

function sameEndpoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

function buildRingsFromOverpassMembers(members) {
  const fragments = [];
  const used = new Set();
  for (const member of members) {
    if (!['outer', 'inner'].includes(member.role) || !Array.isArray(member.geometry)) continue;
    const key = `${member.role}:${member.ref}`;
    if (used.has(key)) continue;
    used.add(key);
    fragments.push(member.geometry.map((point) => [point.lon, point.lat]));
  }

  const rings = [];
  while (fragments.length) {
    const ring = fragments.shift();
    while (!sameEndpoint(ring[0], ring[ring.length - 1])) {
      let idx = -1;
      let appendForward = true;
      for (let i = 0; i < fragments.length; i++) {
        const frag = fragments[i];
        if (sameEndpoint(ring.at(-1), frag[0])) { idx = i; appendForward = true; break; }
        if (sameEndpoint(ring.at(-1), frag.at(-1))) { idx = i; appendForward = false; break; }
      }
      if (idx === -1) break;
      const frag = fragments.splice(idx, 1)[0];
      ring.push(...(appendForward ? frag.slice(1) : frag.slice(0, -1).reverse()));
    }
    if (sameEndpoint(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring.slice(0, -1));
  }
  return rings.filter((ring) => ring.length >= 3).map((ring) => [ring]);
}

async function fetchOsmBoundary(osmRelationId) {
  const query = `[out:json][timeout:18];relation(${osmRelationId});out geom;`;
  const encoded = encodeURIComponent(query);
  const res = await fetchRelayed(`${API_BASE}/overpass?data=${encoded}`, `${OVERPASS_BASE}?data=${encoded}`, BOUNDARY_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const payload = await res.json();
  const rings = payload.elements?.flatMap((element) => {
    if ((element.type !== 'relation') || element.tags?.boundary !== 'administrative') return [];
    return buildRingsFromOverpassMembers(element.members || []);
  }) || [];
  if (!rings.length) throw new Error('No administrative rings');
  return { type: 'MultiPolygon', coordinates: rings };
}

async function markPlace(item) {
  const id = uniqueIdFor(item);
  const existing = store.visited.find((v) => v.id === id);
  const name = item.name || '未命名地点';
  if (existing) {
    showToast(`「${existing.name}」已在足迹中`);
    clearSearchUi();
    openDetail(existing.id, { fly: true });
    return;
  }
  resultsEl.hidden = true;
  resultsEl.replaceChildren();
  setStatus(`正在加载「${name}」的行政轮廓…`);
  try {
    const rawBoundary = item.source === 'cn'
      ? await fetchChinaBoundary(item.adcode)
      : await fetchOsmBoundary(item.osmId);
    const prepared = prepareGeometry(rawBoundary);
    if (!prepared) throw new Error('Empty boundary');

    const center = Array.isArray(item.center)
      && Number.isFinite(item.center[0]) && Number.isFinite(item.center[1])
      ? [rnd5(item.center[0]), rnd5(item.center[1])]
      : approximateCenter(prepared.rings);
    const meta = {
      id,
      name,
      country: item.country || '',
      kind: item.kind || '行政区',
      center,
      ts: Date.now(),
    };
    store.visited.push(meta);
    await saveGeometry(id, prepared);
    persist();
    addPlaceVisual(id, prepared.rings);
    rebuildBeacons();
    refreshPlaceVisualStyles();
    refreshChips();
    clearSearchUi();
    showToast(`已点亮 ${name}`);
    openDetail(id, { fly: true });
  } catch (err) {
    console.warn('boundary load failed', err);
    setStatus('这个区域的边界服务暂时不可用，请稍后重试。', true);
  }
}

function approximateCenter(rings) {
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) {
    for (const p of ring) { sx += p[0]; sy += p[1]; n++; }
  }
  return n ? [rnd5(sx / n), rnd5(sy / n)] : [0, 0];
}

async function unmark(id) {
  const idx = store.visited.findIndex((v) => v.id === id);
  if (idx === -1) return;
  const [meta] = store.visited.splice(idx, 1);
  await removeGeometry(id);
  await deletePlaceMedia(id);
  delete store.details[id];
  persist();
  releasePlacePhotoUrls(id);
  if (selectedPlaceId === id) closeDetail();
  removePlaceVisual(id);
  rebuildBeacons();
  refreshChips();
  showToast(`已移除 ${meta.name}`);
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    abortCtrl?.abort();
    resultsEl.hidden = true;
    resultsEl.replaceChildren();
    setStatus(DEFAULT_HINT);
    return;
  }
  searchStatus.classList.remove('is-error');
  searchTimer = setTimeout(() => runSearch(q), 340);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearSearchUi();
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length >= 2) runSearch(q);
  }
});

/* ------------------------------------------------------------------ */
/* Visited chips                                                       */
/* ------------------------------------------------------------------ */

const chipsEl = document.getElementById('visited-list');
const countEl = document.getElementById('visited-count');
const emptyEl = document.getElementById('visited-empty');

function refreshChips() {
  chipsEl.replaceChildren();
  countEl.textContent = String(store.visited.length).padStart(2, '0');
  emptyEl.hidden = store.visited.length !== 0;
  for (const meta of store.visited) {
    const li = document.createElement('li');
    li.className = 'chip';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'chip-main';
    main.title = `查看 ${meta.name}`;
    main.insertAdjacentHTML('beforeend', ICON_FOCUS);
    const label = document.createElement('span');
    label.textContent = meta.name;
    main.appendChild(label);
    main.addEventListener('click', () => openDetail(meta.id, { fly: true }));

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'chip-remove';
    rm.title = `移除 ${meta.name}`;
    rm.setAttribute('aria-label', `移除 ${meta.name}`);
    rm.insertAdjacentHTML('beforeend', ICON_REMOVE);
    rm.addEventListener('click', () => unmark(meta.id));

    li.append(main, rm);
    chipsEl.appendChild(li);
  }
}

/* ------------------------------------------------------------------ */
/* Travel timeline                                                     */
/* ------------------------------------------------------------------ */

const timelinePage = document.getElementById('timeline-page');
const timelineFlow = document.getElementById('timeline-flow');
const timelineEmpty = document.getElementById('timeline-empty');
const timelineCloseButton = document.getElementById('timeline-close');
const detailTimelineButton = document.getElementById('detail-timeline-button');
const timelineTopButton = document.getElementById('timeline-top');
const TIMELINE_HASH = '#/timeline';
let timelineHideTimer = null;
let lastFocusedElement = null;

function tripDate(meta) {
  const detail = getDetail(meta.id);
  return detail.arrival || detail.departure || '';
}

function tripDateSortKey(meta) {
  const date = tripDate(meta);
  const time = date ? new Date(`${date}T00:00:00`).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}


function tripMonthKey(meta) {
  return (/^(\d{4}-\d{2})/.exec(tripDate(meta)) || [])[1] || '';
}

function renderTimeline() {
  const trips = [...store.visited].sort((a, b) => tripDateSortKey(a) - tripDateSortKey(b));
  timelineFlow.replaceChildren();
  timelineEmpty.hidden = trips.length !== 0;

  const groups = [];
  for (const meta of trips) {
    const key = tripMonthKey(meta);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(meta);
    } else {
      groups.push({ key, items: [meta] });
    }
  }

  const fragment = document.createDocumentFragment();
  let lastYear = '';
  for (const [groupIndex, group] of groups.entries()) {
    const year = group.key.slice(0, 4);
    if (year && year !== lastYear) {
      const yearDivider = document.createElement('div');
      yearDivider.className = 'timeline-year';
      yearDivider.textContent = `${year} 年`;
      fragment.appendChild(yearDivider);
      lastYear = year;
    }

    const month = document.createElement('article');
    month.className = 'timeline-month';
    month.style.setProperty('--month-index', String(groupIndex));

    const marker = document.createElement('div');
    marker.className = 'month-marker';
    const label = document.createElement('span');
    label.className = 'month-label';
    label.textContent = group.key ? formatMonth(`${group.key}-01`) : '未定时间';
    const node = document.createElement('span');
    node.className = 'month-node';
    node.setAttribute('aria-hidden', 'true');
    marker.append(label, node);

    const monthBody = document.createElement('div');
    monthBody.className = 'month-body';
    const tripGrid = document.createElement('div');
    tripGrid.className = 'trip-grid';

    for (const meta of group.items) {
      const ticket = document.createElement('div');
      ticket.className = 'trip-ticket';

      const label = document.createElement('span');
      label.className = 'trip-cover-label';
      label.textContent = meta.name;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'trip-card';
      button.setAttribute('aria-label', `查看 ${meta.name}`);
      button.addEventListener('pointermove', (event) => {
        const rect = button.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        button.style.setProperty('--pointer-x', `${x * 100}%`);
        button.style.setProperty('--pointer-y', `${y * 100}%`);
        button.style.setProperty('--tilt-x', `${(0.5 - y) * 5.5}deg`);
        button.style.setProperty('--tilt-y', `${(x - 0.5) * 7.5}deg`);
      });
      button.addEventListener('pointerleave', () => {
        button.style.removeProperty('--tilt-x');
        button.style.removeProperty('--tilt-y');
      });
      const coverUrl = timelineCoverUrls.get(timelineCoverKey(meta.id));
      if (coverUrl) {
        const image = document.createElement('img');
        image.src = coverUrl;
        image.alt = '';
        image.loading = 'lazy';
        button.appendChild(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'trip-cover-empty';
        placeholder.setAttribute('aria-hidden', 'true');
        button.appendChild(placeholder);
      }
      button.addEventListener('click', () => {
        placeReturnHash = TIMELINE_HASH;
        location.hash = `/place/${meta.id}`;
      });
      ticket.append(label, button);
      tripGrid.appendChild(ticket);
    }

    monthBody.appendChild(tripGrid);
    month.append(marker, monthBody);
    fragment.appendChild(month);
  }

  timelineFlow.appendChild(fragment);
}

function isTimelineRoute() {
  return location.hash === TIMELINE_HASH;
}

function openTimeline() {
  if (!isTimelineRoute()) {
    location.hash = '/timeline';
    return;
  }
  clearTimeout(timelineHideTimer);
  timelinePage.classList.remove('is-closing');
  renderTimeline();
  if (!detailPanel.hidden) closeDetail();
  timelineTopButton.hidden = true;
  timelinePage.hidden = false;
  timelinePage.scrollTop = 0;
  lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ensureTimelineCoverUrls()
    .then(() => {
      if (isTimelineRoute()) renderTimeline();
    })
    .catch((err) => console.warn('Unable to load timeline covers', err));
  requestAnimationFrame(() => {
    timelinePage.classList.add('is-open');
    timelineCloseButton.focus({ preventScroll: true });
  });
}

function closeTimeline() {
  if (isTimelineRoute()) {
    location.hash = '/';
    return;
  }
  timelinePage.classList.remove('is-open');
  timelinePage.classList.add('is-closing');
  clearTimeout(timelineHideTimer);
  timelineHideTimer = setTimeout(() => {
    timelinePage.hidden = true;
    timelinePage.classList.remove('is-closing');
    lastFocusedElement?.focus({ preventScroll: true });
    lastFocusedElement = null;
  }, 460);
}

function syncTimelineRoute() {
  if (isTimelineRoute()) openTimeline();
  else closeTimeline();

  const placeId = getPlaceRouteId();
  if (placeId) openPlacePage(placeId);
  else closePlacePage(false);

  document.body.dataset.route = isTimelineRoute() ? 'timeline' : placeId ? 'place' : 'home';
  document.body.classList.remove('route-enter');
  void document.body.offsetWidth;
  document.body.classList.add('route-enter');
  for (const link of document.querySelectorAll('[data-route-link]')) {
    link.classList.toggle('is-active', link.dataset.routeLink === document.body.dataset.route);
  }
}

timelinePage.addEventListener('scroll', () => {
  timelineTopButton.hidden = timelinePage.scrollTop < 420;
}, { passive: true });
timelineTopButton.addEventListener('click', () => {
  timelinePage.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
});

timelineCloseButton.addEventListener('click', closeTimeline);
detailTimelineButton.addEventListener('click', () => {
  const id = selectedPlaceId || renderingPlaceId;
  if (!id) return;
  placeReturnHash = '#/';
  location.hash = `/place/${id}`;
});
window.addEventListener('hashchange', syncTimelineRoute);
timelinePage.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeTimeline();
});

/* ------------------------------------------------------------------ */
/* Fullscreen place page                                               */
/* ------------------------------------------------------------------ */

const placePage = document.getElementById('place-page');
const placeBack = document.getElementById('place-back');
const placeTitle = document.getElementById('place-page-title');
const placeAlbumTitle = document.getElementById('place-album-title');
const placeDate = document.getElementById('place-date');
const placeDayList = document.getElementById('place-day-list');
const placePhotoGroups = document.getElementById('place-photo-groups');
const journalDay = document.getElementById('journal-day');
const journalDate = document.getElementById('journal-date');
const journalCity = document.getElementById('journal-city');
const journalText = document.getElementById('journal-text');
const placeEditFab = document.getElementById('place-edit-fab');
const placeEditor = document.getElementById('place-editor');
const placeEditForm = document.getElementById('place-edit-form');
const placeEditorCancel = document.getElementById('place-editor-cancel');
const placeEditTitle = document.getElementById('place-edit-title');
const placeEditArrival = document.getElementById('place-edit-arrival');
const placeEditDeparture = document.getElementById('place-edit-departure');
const placeEditTripTitle = document.getElementById('place-edit-trip-title');
const placeEditWeather = document.getElementById('place-edit-weather');
const placeEditSummary = document.getElementById('place-edit-summary');
const placeJournalEditor = document.getElementById('place-journal-editor');
const placeNewDayDate = document.getElementById('place-new-day-date');
const placeAddDay = document.getElementById('place-add-day');
const PLACE_HASH_PREFIX = '#/place/';
let placeReturnHash = '#/';
let currentPlacePageId = null;
let selectedTripDate = '';
let renderingPlacePageId = null;
let placePageCloseTimer = null;
let placePageFocusElement = null;

function getPlaceRouteId() {
  if (!location.hash.startsWith(PLACE_HASH_PREFIX)) return '';
  const id = decodeURIComponent(location.hash.slice(PLACE_HASH_PREFIX.length));
  return store.visited.some((item) => item.id === id) ? id : '';
}

function isPlaceRoute() {
  return location.hash.startsWith(PLACE_HASH_PREFIX) && Boolean(getPlaceRouteId());
}

function chineseWeekday(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
}

function shortDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  return match ? `${match[2]}月${Number(match[3])}日` : '未定日期';
}

function fullDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : '日期待定';
}

function buildTripDays(detail) {
  const dayMap = new Map();
  for (const photo of detail.photos) {
    const date = photo.date || detail.arrival || '';
    if (!dayMap.has(date)) dayMap.set(date, []);
    dayMap.get(date).push(photo);
  }
  for (const date of Object.keys(detail.journals)) {
    if (!dayMap.has(date)) dayMap.set(date, []);
  }

  const arrival = detail.arrival;
  const departure = detail.departure || arrival;
  if (arrival) {
    const start = new Date(`${arrival}T00:00:00`);
    const end = new Date(`${departure || arrival}T00:00:00`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const limit = Math.min(Math.round((end - start) / 86400000) + 1, 31);
      for (let index = 0; index < limit; index += 1) {
        const date = toISODate(new Date(start.getTime() + index * 86400000));
        if (!dayMap.has(date)) dayMap.set(date, []);
      }
    }
  }
  if (!dayMap.size) dayMap.set('', []);

  return [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, photos], index) => ({ date, photos, number: index + 1 }));
}

function replayDayTransition(element) {
  element.classList.remove('day-enter');
  void element.offsetWidth;
  if (!REDUCED_MOTION) element.classList.add('day-enter');
}

function renderPlaceJournal(days, { animate = false } = {}) {
  const day = days.find((item) => item.date === selectedTripDate) || days[0];
  if (!day) return;
  journalDay.textContent = `Day ${day.number}`;
  journalDate.textContent = fullDate(day.date);
  journalCity.textContent = getPlaceMeta(currentPlacePageId)?.name || '旅行地点';
  const detail = getDetail(currentPlacePageId);
  const journal = detail.journals?.[day.date] || '';
  journalText.textContent = journal
    || (day.number === 1 ? detail.summary : '')
    || '这一天的文字还没有写，点右下角编辑按钮补一笔吧。';
  if (animate) replayDayTransition(journalDay.closest('.journal-card'));
}

function renderPlacePhotos(days, meta, detail, { animate = false } = {}) {
  const id = currentPlacePageId;
  const day = days.find((item) => item.date === selectedTripDate) || days[0];
  if (!day) return;

  const group = document.createElement('section');
  group.className = 'photo-group';
  group.dataset.date = day.date;
  const head = document.createElement('div');
  head.className = 'group-head';
  head.innerHTML = `<h4>Day ${day.number}</h4><span>${shortDate(day.date)} ${chineseWeekday(day.date)} · ${day.photos.length} 张照片</span>`;
  const grid = document.createElement('div');
  grid.className = 'album-grid';

  if (!day.photos.length) {
    const empty = document.createElement('p');
    empty.className = 'group-empty';
    empty.textContent = '这一天还没有照片。';
    group.append(head, empty);
  } else {
    for (const photo of day.photos) {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.alt = photo.caption || `${meta.name} Day ${day.number}照片`;
      image.src = photoUrls.get(photoStorageKey(id, photo.id)) || '';
      image.loading = 'lazy';
      image.addEventListener('click', () => {
        const globalIndex = detail.photos.findIndex((item) => item.id === photo.id);
        openLightbox(detail.photos.map((item) => ({
          src: photoUrls.get(photoStorageKey(id, item.id)) || '',
          caption: item.caption || `${meta.name}照片`,
        })), globalIndex);
      });
      figure.appendChild(image);
      if (photo.caption) {
        const caption = document.createElement('figcaption');
        caption.textContent = photo.caption;
        figure.appendChild(caption);
      }
      grid.appendChild(figure);
    }
    group.append(head, grid);
  }

  placePhotoGroups.replaceChildren(group);
  if (animate) replayDayTransition(group);
}

function renderPlacePage(id) {
  const meta = getPlaceMeta(id);
  if (!meta) return;
  const detail = getDetail(id);
  const days = buildTripDays(detail);
  if (!days.some((day) => day.date === selectedTripDate)) selectedTripDate = days[0].date;

  placeTitle.textContent = meta.name;
  placeAlbumTitle.textContent = `${meta.name}的照片集`;
  placeDate.textContent = formatDateRange(detail) || formatMonth(detail.arrival || detail.departure) || '时间待定';
  placeDayList.replaceChildren();

  days.forEach((day) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `day-button${day.date === selectedTripDate ? ' is-active' : ''}`;
    button.dataset.date = day.date;
    button.innerHTML = `<span>Day ${day.number}</span><strong>${shortDate(day.date)} ${chineseWeekday(day.date)}</strong><em>${day.photos.length} 张照片</em>`;
    button.addEventListener('click', () => selectTripDay(day.date));
    placeDayList.appendChild(button);
  });

  renderPlacePhotos(days, meta, detail);
  renderPlaceJournal(days);
}

function selectTripDay(date) {
  selectedTripDate = date;
  for (const button of placeDayList.querySelectorAll('.day-button')) {
    button.classList.toggle('is-active', button.dataset.date === date);
  }
  const detail = getDetail(currentPlacePageId);
  const days = buildTripDays(detail);
  const meta = getPlaceMeta(currentPlacePageId);
  renderPlacePhotos(days, meta, detail, { animate: true });
  renderPlaceJournal(days, { animate: true });
}

function openPlacePage(id) {
  if (currentPlacePageId !== id) {
    currentPlacePageId = id;
    selectedTripDate = '';
  }
  selectedPlaceId = id;
  refreshPlaceVisualStyles();
  detailPanel.classList.remove('is-open');
  detailPanel.hidden = true;
  clearTimeout(placePageCloseTimer);
  placePage.classList.remove('is-closing');
  placePage.dataset.mode = 'view';
  placeEditor.hidden = true;
  placePage.hidden = false;
  placePageFocusElement ||= document.activeElement;
  requestAnimationFrame(() => placePage.classList.add('is-open'));
  renderingPlacePageId = id;
  renderPlacePage(id);
  ensurePlacePhotoUrls(id)
    .then(() => {
      if (renderingPlacePageId === id) {
        renderPlacePage(id);
        if (placePage.dataset.mode === 'edit') renderPhotoGrid(id);
      }
    })
    .catch((err) => console.warn('Unable to load place photos', err));
}

function closePlacePage(goHome = true) {
  if (!placePage.hidden) {
    placePage.classList.remove('is-open');
    placePage.classList.add('is-closing');
    clearTimeout(placePageCloseTimer);
    placePageCloseTimer = setTimeout(() => {
      placePage.hidden = true;
      placePage.classList.remove('is-closing');
      placePageFocusElement?.focus({ preventScroll: true });
      placePageFocusElement = null;
      if (goHome && getPlaceRouteId()) {
        location.hash = placeReturnHash.startsWith('#/timeline') ? '/timeline' : '/';
      }
    }, 380);
    return;
  }
  if (goHome && getPlaceRouteId()) {
    location.hash = placeReturnHash.startsWith('#/timeline') ? '/timeline' : '/';
  }
}

function isPlaceEditorOpen() {
  return !placeEditor.hidden;
}

function renderPlaceEditorJournals(detail) {
  placeJournalEditor.replaceChildren();
  const days = buildTripDays(detail);
  if (!days.length) {
    const empty = document.createElement('p');
    empty.className = 'editor-empty';
    empty.textContent = '先设置到达日期，或新增一个日记日期。';
    placeJournalEditor.appendChild(empty);
    return;
  }

  days.forEach((day) => {
    const row = document.createElement('article');
    row.className = 'journal-editor';
    row.dataset.originalDate = day.date;

    const meta = document.createElement('div');
    meta.className = 'journal-editor-meta';
    meta.innerHTML = `<strong>Day ${day.number}</strong>`;
    const date = document.createElement('input');
    date.type = 'date';
    date.value = day.date;
    date.setAttribute('aria-label', `Day ${day.number}日期`);
    meta.appendChild(date);

    if (detail.journals[day.date] !== undefined) {
      const removeDay = document.createElement('button');
      removeDay.type = 'button';
      removeDay.className = 'journal-remove';
      removeDay.textContent = '删除日记';
      removeDay.setAttribute('aria-label', `删除 Day ${day.number}日记`);
      removeDay.addEventListener('click', () => {
        delete detail.journals[day.date];
        persist();
        renderPlaceEditorJournals(detail);
      });
      meta.appendChild(removeDay);
    }

    const text = document.createElement('textarea');
    text.rows = 5;
    text.placeholder = `记录 Day ${day.number} 的路线、食物、天气或最想记住的瞬间……`;
    text.value = detail.journals[day.date] || '';
    text.setAttribute('aria-label', `Day ${day.number}日记`);

    row.append(meta, text);
    placeJournalEditor.appendChild(row);
  });
}

function openPlaceEditor() {
  const id = currentPlacePageId;
  const meta = getPlaceMeta(id);
  if (!meta) return;
  const detail = getDetail(id);

  placeEditTitle.value = meta.name;
  placeEditArrival.value = detail.arrival;
  placeEditDeparture.value = detail.departure;
  placeEditTripTitle.value = detail.tripTitle;
  placeEditWeather.value = detail.weather;
  placeEditSummary.value = detail.summary;
  placeNewDayDate.value = '';
  renderPlaceEditorJournals(detail);
  renderPhotoGrid(id);

  placePage.dataset.mode = 'edit';
  placeEditor.hidden = false;
  placeEditor.scrollTop = 0;
  placeEditor.classList.add('is-open');
}

function closePlaceEditor() {
  placeEditor.classList.remove('is-open');
  placeEditor.hidden = true;
  placePage.dataset.mode = 'view';
  renderPlacePage(currentPlacePageId);
}

function savePlaceEditor(event) {
  event.preventDefault();
  const id = currentPlacePageId;
  const meta = getPlaceMeta(id);
  if (!meta) return;
  const detail = getDetail(id);

  meta.name = placeEditTitle.value.trim() || '未命名地点';
  detail.arrival = placeEditArrival.value;
  detail.departure = placeEditDeparture.value;
  detail.tripTitle = placeEditTripTitle.value.trim();
  detail.weather = placeEditWeather.value.trim();
  detail.summary = placeEditSummary.value.trim();

  const journals = {};
  for (const row of placeJournalEditor.querySelectorAll('.journal-editor')) {
    const originalDate = row.dataset.originalDate || '';
    const date = row.querySelector('input[type="date"]')?.value || originalDate;
    const text = row.querySelector('textarea')?.value.trim() || '';
    if (!date) continue;
    journals[date] = journals[date] ? `${journals[date]}\n\n${text}` : text;
  }
  detail.journals = journals;

  selectedTripDate = Object.keys(journals)[0] || selectedTripDate;
  persist();
  refreshChips();
  closePlaceEditor();
  showToast('详情已保存');
}

placeBack.addEventListener('click', () => {
  if (isPlaceEditorOpen()) {
    closePlaceEditor();
    return;
  }
  closePlacePage();
});

placeEditFab.addEventListener('click', () => {
  if (!currentPlacePageId) return;
  openPlaceEditor();
});

placeEditorCancel.addEventListener('click', closePlaceEditor);
placeEditForm.addEventListener('submit', savePlaceEditor);
placeAddDay.addEventListener('click', () => {
  const date = placeNewDayDate.value;
  if (!date) {
    showToast('请先选择日期');
    return;
  }
  const detail = getDetail(currentPlacePageId);
  if (buildTripDays(detail).some((day) => day.date === date)) {
    showToast('这个日期已经有了');
    return;
  }
  detail.journals[date] = '';
  renderPlaceEditorJournals(detail);
  placeNewDayDate.value = '';
});

placePage.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !detailPanel.hidden) return;
  if (isPlaceEditorOpen()) closePlaceEditor();
  else closePlacePage();
});

document.addEventListener('paste', (event) => {
  if (!isPlaceEditorOpen()) return;
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (files.length && currentPlacePageId) {
    event.preventDefault();
    addPhotos(files);
  }
});

placeEditor.addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  placeEditor.classList.add('is-file-dragging');
});

placeEditor.addEventListener('dragleave', () => {
  placeEditor.classList.remove('is-file-dragging');
});

placeEditor.addEventListener('drop', (event) => {
  placeEditor.classList.remove('is-file-dragging');
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
  if (files.length && currentPlacePageId) addPhotos(files);
});

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

/* ------------------------------------------------------------------ */
/* Pointer picking (hover tip + click-to-focus on beacons)             */
/* ------------------------------------------------------------------ */

const tipEl = document.getElementById('globe-tip');
const raycaster = new THREE.Raycaster();
raycaster.params.Points = { threshold: 0.024 };
const ndc = new THREE.Vector2();
let tipPending = false;
let downPos = null;

renderer?.domElement.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});

renderer?.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 6) return;
  const placeId = pickPlace(e.clientX, e.clientY);
  if (placeId) {
    openDetail(placeId, { fly: true });
    return;
  }
  const hit = pickBeacon(e.clientX, e.clientY);
  if (hit) {
    openDetail(store.visited[hit.index].id, { fly: true });
  } else {
    closeDetail();
  }
});

renderer?.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (tipPending) return;
  tipPending = true;
  requestAnimationFrame(() => {
    tipPending = false;
    const placeId = pickPlace(e.clientX, e.clientY);
    const hit = placeId ? null : pickBeacon(e.clientX, e.clientY);
    const meta = placeId ? getPlaceMeta(placeId) : (hit ? store.visited[hit.index] : null);
    setHoveredPlace(placeId);
    if (meta) {
      tipEl.textContent = meta.name;
      tipEl.style.left = `${e.clientX}px`;
      tipEl.style.top = `${e.clientY}px`;
      tipEl.hidden = false;
      document.body.style.cursor = 'pointer';
    } else {
      tipEl.hidden = true;
      document.body.style.cursor = '';
    }
  });
});

renderer?.domElement.addEventListener('pointerleave', () => {
  setHoveredPlace(null);
  tipEl.hidden = true;
  document.body.style.cursor = '';
});

function setRayFromClient(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

function pickPlace(clientX, clientY) {
  if (!hitGroup.children.length) return null;
  setRayFromClient(clientX, clientY);
  const cameraDistance = camera.position.length();
  const hit = raycaster.intersectObjects(hitGroup.children, false)
    .find((item) => item.point.distanceTo(camera.position) < cameraDistance);
  return hit?.object.userData.placeId || null;
}

function pickBeacon(clientX, clientY) {
  if (!store.visited.length) return null;
  setRayFromClient(clientX, clientY);
  const cameraDistance = camera.position.length();
  const hit = raycaster.intersectObject(beacons, false)
    .find((item) => item.point.distanceTo(camera.position) < cameraDistance);
  return hit ? { index: hit.index } : null;
}

/* ------------------------------------------------------------------ */
/* Resize + loop                                                       */
/* ------------------------------------------------------------------ */

function updatePerspectiveUniform() {
  const h = renderer.domElement.height; // drawing-buffer height incl. pixelRatio
  beaconUniforms.uPerspective.value = h / (2 * Math.tan(camera.fov * DEG / 2));
}

window.addEventListener('resize', () => {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const w = window.innerWidth;
  const h = window.innerHeight;
  lineResolution.set(w, h);
  for (const mat of outlineMaterials) mat.resolution.set(w, h);
  updatePerspectiveUniform();
  updateStarProjection();
});

const clock = new THREE.Clock();
const identityQuaternion = new THREE.Quaternion();
const flightQuaternion = new THREE.Quaternion();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), REDUCED_MOTION ? 0.05 : 0.1);
  beaconUniforms.uTime.value += dt;
  cloudMat.uniforms.uTime.value += dt;
  starUniforms.uTwinkle.value += dt;
  activeGlowLineMat.opacity = REDUCED_MOTION ? 0.18 : 0.10 + 0.10 * Math.sin(beaconUniforms.uTime.value * 1.7);
  const parallaxEase = 1 - Math.exp(-dt * 2.4);
  starPointer.lerp(starPointerTarget, parallaxEase);
  starUniforms.uPointer.value.copy(starPointer);
  starUniforms.uCameraDir.value.copy(camera.position).normalize();

  if (hoverGrowth) {
    const line = placeVisuals.get(hoverGrowth.id);
    if (line && hoveredPlaceId === hoverGrowth.id) {
      const elapsed = (performance.now() - hoverGrowth.start) / 1800;
      const progress = REDUCED_MOTION ? 1 : Math.min(1, elapsed);
      const eased = progress < 0.5
        ? 4 * progress ** 3
        : 1 - (-2 * progress + 2) ** 3 / 2;
      const segmentCount = outlineSegmentCount(line.geometry);
      line.geometry.instanceCount = Math.max(1, Math.ceil(segmentCount * eased));
      if (progress >= 1) hoverGrowth = null;
    } else {
      hoverGrowth = null;
    }
  }
  if (flight) {
    flight.t = Math.min(1, flight.t + dt / flight.duration);
    const k = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    flightQuaternion.slerpQuaternions(identityQuaternion, flight.quaternion, k);
    const dir = flight.start.clone().applyQuaternion(flightQuaternion).normalize();
    const baseRadius = THREE.MathUtils.lerp(flight.radiusFrom, flight.radiusTo, k);
    const arc = Math.sin(Math.PI * k);
    const radius = THREE.MathUtils.lerp(baseRadius, flight.radiusPeak, arc);
    camera.position.copy(dir.multiplyScalar(radius));
    camera.lookAt(0, 0, 0);
    if (flight.t >= 1) flight = null;
  } else {
    controls.autoRotate = !REDUCED_MOTION && selectedPlaceId === null && (performance.now() - lastInteract > 6000);
    controls.update();
  }
  renderer?.render(scene, camera);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clock.getDelta();
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

initGeoStore()
  .then(() => {
    rebuildAllVisuals();
    if (location.hash.startsWith(PLACE_HASH_PREFIX) && getPlaceRouteId()) selectedPlaceId = getPlaceRouteId();
    if (isTimelineRoute()) selectedPlaceId = null;
    refreshPlaceVisualStyles();
  })
  .catch((err) => {
    console.warn('Unable to load geometry cache', err);
    rebuildAllVisuals();
  });
refreshChips();
addCountryBorders();
setTimeout(() => {
  refreshChinaGeometries();
}, 900);
lineResolution.set(window.innerWidth, window.innerHeight);
for (const mat of outlineMaterials) mat.resolution.set(window.innerWidth, window.innerHeight);
updateStarProjection();
updatePerspectiveUniform();
tick();
syncTimelineRoute();
