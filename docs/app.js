'use strict';
/* Kite Forecast NL: Windy-style map of HARMONIE wind, SWAN waves and DCSM current, with kite alerts.
   Data: data/forecast.json, written daily by fetch_data.py (GitHub Action). Everything else runs here. */

const TZ = 'Europe/Amsterdam';
const KN_PER_MS = 1.94384;
const WORKFLOW = 'update.yml';
const REPO = (() => {
  const h = location.hostname;
  if (h.endsWith('.github.io')) return { owner: h.split('.')[0], repo: location.pathname.split('/').filter(Boolean)[0] || h };
  return { owner: 'vallukie-beep', repo: 'kite-forecast' };
})();
const ACTIONS_URL = `https://github.com/${REPO.owner}/${REPO.repo}/actions/workflows/${WORKFLOW}`;

const DEFAULT_TH = {
  windMin: 15, windMax: 30, gustMax: 35,
  onMargin: 40,     // degrees from parallel toward onshore that still count (side-onshore)
  offMargin: 0,     // degrees from parallel toward offshore that still count (side-offshore); 0 = never offshore
  curOpp: true, curTol: 60, curMin: 0.2,
  waveMax: '', minHours: 2, daylight: true,
};
const SEED_SPOTS = [
  { name: 'Hoek van Holland', lat: 51.993, lon: 4.112 },
  { name: 'Scheveningen', lat: 52.112, lon: 4.268 },
  { name: 'Wijk aan Zee', lat: 52.494, lon: 4.584 },
  { name: 'Texel Paal 17', lat: 53.081, lon: 4.733 },
  { name: 'Terschelling West aan Zee', lat: 53.394, lon: 5.268 },
  { name: 'Vlieland', lat: 53.315, lon: 5.060 },
];

// ------------------------------------------------------------------ small helpers
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const RAD = Math.PI / 180;
const norm360 = (a) => ((a % 360) + 360) % 360;
const angDiff = (a, b) => { const d = Math.abs(norm360(a) - norm360(b)); return d > 180 ? 360 - d : d; };
const bearingOf = (u, v) => norm360(Math.atan2(u, v) / RAD);           // direction a vector points to
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (d) => COMPASS[Math.round(norm360(d) / 22.5) % 16];
const fmt1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const fmt0 = (x) => (Number.isFinite(x) ? Math.round(x) : '–');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const F = {
  full: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' }),
  hm: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
  dayhm: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  hour: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }),
};
const tf = (f, sec) => f.format(new Date(sec * 1000));
const localHour = (sec) => +F.hour.format(new Date(sec * 1000)) % 24;
function rel(sec) {
  const d = sec - Date.now() / 1000, a = Math.abs(d);
  const s = a < 3600 ? `${Math.max(1, Math.round(a / 60))} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return d < 0 ? `${s} ago` : `in ${s}`;
}

// Sun altitude in degrees (low-precision NOAA formulas, good to ~0.1°)
function sunAlt(tSec, lat, lon) {
  const d = (tSec - 946728000) / 86400;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = norm360((18.697374558 + 24.06570982441908 * d) * 15);
  const ha = (gmst + lon - ra) * RAD;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha)) / RAD;
}
const isDay = (t, lat, lon) => sunAlt(t, lat, lon) > -0.833;

// ------------------------------------------------------------------ colour scales (after Windy's)
// stops: [value, r, g, b, alpha 0..1 (optional)] in the unit the layer shows
const MS = 1.94384;
const PALS = {
  wind: [[0, 98, 113, 183], [1, 57, 97, 159], [3, 74, 148, 169], [5, 77, 141, 123], [7, 83, 165, 83], [9, 53, 159, 53], [11, 167, 157, 81],
    [13, 159, 127, 58], [15, 161, 108, 92], [17, 129, 58, 78], [19, 175, 80, 136], [21, 117, 74, 147], [24, 109, 97, 163],
    [27, 68, 105, 141], [29, 92, 144, 152], [36, 125, 68, 165], [46, 231, 215, 215]].map(([v, ...c]) => [v * MS, ...c]),
  temp: [[-70, 115, 70, 105], [-55, 202, 172, 195], [-40, 162, 70, 145], [-25, 143, 89, 169], [-15, 157, 219, 217], [-8, 106, 191, 181],
    [-4, 100, 166, 189], [0, 93, 133, 198], [1, 68, 125, 99], [10, 128, 147, 24], [21, 243, 183, 4], [30, 232, 83, 25], [47, 71, 14, 0]],
  rain: [[0, 111, 111, 111, 0], [0.1, 60, 116, 160, 0.35], [0.6, 60, 116, 160, 0.85], [2, 59, 140, 161, 0.9], [6, 59, 161, 161], [8, 59, 161, 61],
    [10, 130, 161, 59], [15, 161, 161, 59], [20, 161, 59, 59], [31, 161, 59, 161], [50, 168, 168, 168]],
  cloud: [[0, 30, 30, 30, 0], [10, 90, 90, 90, 0.15], [40, 150, 150, 150, 0.45], [70, 200, 200, 200, 0.7], [100, 240, 240, 240, 0.88]],
  pressure: [[960, 0, 32, 96], [980, 0, 52, 146], [990, 0, 90, 148], [1000, 0, 117, 146], [1010, 26, 140, 147], [1020, 103, 162, 155],
    [1030, 155, 183, 172], [1040, 182, 182, 182], [1050, 176, 174, 152]],
  rh: [[0, 173, 85, 56], [30, 173, 110, 56], [40, 173, 146, 56], [50, 105, 173, 56], [60, 56, 173, 121], [70, 56, 174, 173],
    [80, 56, 157, 173], [87, 56, 135, 173], [93, 56, 123, 173], [97, 56, 98, 157], [100, 56, 70, 114]],
  cape: [[0, 110, 110, 110, 0], [100, 87, 140, 180, 0.5], [300, 87, 140, 180], [600, 64, 200, 64], [1000, 200, 200, 50],
    [1500, 230, 140, 30], [2500, 220, 40, 40], [3500, 200, 40, 200]],
  vis: [[0, 175, 60, 160], [1, 190, 110, 200], [3, 130, 140, 200], [5, 90, 160, 180], [10, 90, 150, 110], [20, 70, 120, 75], [50, 55, 90, 60]],
  current: [[0, 37, 74, 255], [0.2, 0, 100, 254], [0.4, 0, 200, 254], [0.6, 37, 193, 146], [0.8, 0, 230, 0], [1.0, 0, 250, 0],
    [1.3, 254, 225, 0], [1.6, 254, 174, 0], [2.0, 220, 74, 28], [2.5, 180, 0, 50], [3, 254, 0, 150], [4, 151, 50, 222]],
  waves: [[0, 159, 85, 181], [0.5, 48, 106, 182], [1, 107, 144, 212], [1.5, 107, 192, 215], [2, 114, 219, 184], [2.5, 190, 226, 128],
    [3, 232, 220, 98], [4, 232, 170, 80], [5, 221, 110, 60], [6, 206, 60, 60], [8, 170, 40, 100], [10, 110, 20, 80]],
  period: [[0, 80, 80, 180], [3, 70, 130, 200], [5, 80, 180, 180], [7, 100, 190, 110], [9, 200, 200, 80], [11, 230, 150, 60],
    [14, 210, 70, 70], [18, 160, 50, 160]],
};
// 512-entry RGBA lookup over [lo, hi]
function makeLut(stops, lo, hi) {
  const n = 512, out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = lo + ((hi - lo) * i) / (n - 1); let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const a = stops[k], b = stops[k + 1], f = Math.min(1, Math.max(0, (v - a[0]) / (b[0] - a[0])));
    for (let c = 1; c <= 3; c++) out[i * 4 + c - 1] = a[c] + (b[c] - a[c]) * f;
    const aa = a[4] ?? 1, ba = b[4] ?? 1;
    out[i * 4 + 3] = 255 * (aa + (ba - aa) * f);
  }
  return { lut: out, lo, hi, k: (n - 1) / (hi - lo) };
}
const WIND_LUT = makeLut(PALS.wind, 0, 70);
const lutAt = (L, v) => Math.min(511, Math.max(0, Math.round((v - L.lo) * L.k))) * 4;
const windColor = (kn, a = 1) => { const i = lutAt(WIND_LUT, kn); return `rgba(${WIND_LUT.lut[i]},${WIND_LUT.lut[i + 1]},${WIND_LUT.lut[i + 2]},${a})`; };

// map layers: topic, frame fields, value function, unit, scale, legend ticks
const KN = KN_PER_MS;
const LAYERS = [
  { id: 'wind', topic: 'weather', name: 'Wind', icon: '🌬', fields: ['u10', 'v10'], val: (u, v) => Math.hypot(u, v) * KN, unit: 'kn', pal: 'wind', lo: 0, hi: 70, ticks: [0, 5, 10, 15, 20, 25, 30, 40, 50], particles: 'wind', alpha: 0.85 },
  { id: 'gust', topic: 'weather', name: 'Gusts', icon: '💨', fields: ['gust'], val: (g) => g * KN, unit: 'kn', pal: 'wind', lo: 0, hi: 70, ticks: [0, 10, 20, 30, 40, 50, 60], particles: 'wind', alpha: 0.85 },
  { id: 'rain', topic: 'weather', name: 'Rain', icon: '🌧', fields: ['precip'], val: (p) => p, unit: 'mm/h', pal: 'rain', lo: 0, hi: 50, ticks: [0.5, 2, 6, 10, 20, 30, 50], particles: 'wind', alpha: 1, note: 'amount in the hour before the map time' },
  { id: 'tcc', topic: 'weather', name: 'Clouds', icon: '☁', fields: ['tcc'], val: (c) => c, unit: '%', pal: 'cloud', lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100], particles: 'wind', alpha: 1 },
  { id: 'lcc', topic: 'weather', name: 'Low clouds', icon: '🌫', fields: ['lcc'], val: (c) => c, unit: '%', pal: 'cloud', lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100], particles: 'wind', alpha: 1 },
  { id: 'mcc', topic: 'weather', name: 'Medium clouds', icon: '☁', fields: ['mcc'], val: (c) => c, unit: '%', pal: 'cloud', lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100], particles: 'wind', alpha: 1 },
  { id: 'hcc', topic: 'weather', name: 'High clouds', icon: '🌥', fields: ['hcc'], val: (c) => c, unit: '%', pal: 'cloud', lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100], particles: 'wind', alpha: 1 },
  { id: 'temp', topic: 'weather', name: 'Temperature', icon: '🌡', fields: ['t2m'], val: (t) => t, unit: '°C', pal: 'temp', lo: -25, hi: 40, ticks: [-20, -10, 0, 10, 20, 30, 40], particles: 'wind', alpha: 0.85 },
  { id: 'dew', topic: 'weather', name: 'Dew point', icon: '💧', fields: ['td2m'], val: (t) => t, unit: '°C', pal: 'temp', lo: -25, hi: 40, ticks: [-20, -10, 0, 10, 20, 30], particles: 'wind', alpha: 0.85 },
  { id: 'rh', topic: 'weather', name: 'Humidity', icon: '💦', fields: ['rh'], val: (h) => h, unit: '%', pal: 'rh', lo: 0, hi: 100, ticks: [20, 40, 60, 80, 100], particles: 'wind', alpha: 0.85 },
  { id: 'pressure', topic: 'weather', name: 'Pressure', icon: '🧭', fields: ['mslp'], val: (p) => p, unit: 'hPa', pal: 'pressure', lo: 960, hi: 1050, ticks: [970, 990, 1010, 1030, 1050], particles: 'wind', alpha: 0.85 },
  { id: 'vis', topic: 'weather', name: 'Visibility (fog)', icon: '👁', fields: ['vis'], val: (m) => m / 1000, unit: 'km', pal: 'vis', lo: 0, hi: 50, ticks: [0, 1, 5, 10, 20, 50], particles: 'wind', alpha: 0.85 },
  { id: 'current', topic: 'current', name: 'Current', icon: '🌊', fields: ['cu', 'cv'], val: (u, v) => Math.hypot(u, v) * KN, unit: 'kn', pal: 'current', lo: 0, hi: 4, ticks: [0, 0.5, 1, 1.5, 2, 3], particles: 'current', alpha: 0.85 },
  { id: 'hs', topic: 'waves', name: 'Waves', icon: '〰', fields: ['hs'], val: (h) => h, unit: 'm', pal: 'waves', lo: 0, hi: 10, ticks: [0, 0.5, 1, 2, 3, 4, 6], particles: null, alpha: 0.85 },
  { id: 'swell', topic: 'waves', name: 'Swell', icon: '🌀', fields: ['swell'], val: (h) => h, unit: 'm', pal: 'waves', lo: 0, hi: 10, ticks: [0, 0.5, 1, 2, 3, 4], particles: null, alpha: 0.85 },
  { id: 'tm', topic: 'waves', name: 'Wave period', icon: '⏱', fields: ['tm'], val: (t) => t, unit: 's', pal: 'period', lo: 0, hi: 18, ticks: [0, 3, 5, 7, 9, 12, 15], particles: null, alpha: 0.85 },
];
for (const L of LAYERS) L.L = makeLut(PALS[L.pal], L.lo, L.hi);
const TOPICS = { weather: 'Weather', current: 'Current', waves: 'Waves' };
const SRC = { weather: 'weather', current: 'current', waves: 'waves' };

// ------------------------------------------------------------------ state
const S = {
  D: null, times: [], ti: 0, playing: null,
  ly: Object.assign({ layer: 'wind', particles: true, depth: false, contours: false, seamarks: false }, store.get('kf.layers2', {})),
  LJ: null, // layers.json: grids and times of the full-resolution map frames
  base: store.get('kf.base', 'sat'),
  sel: null, // {lat, lon, spotId, ser}
  spots: [],
  field: null,
  W: null, // fine Wadden Sea current grid (data/wadden.json), loaded after the main forecast
};

// ------------------------------------------------------------------ data
function toFrames(frames, scale) {
  return frames.map((fr) => { const a = new Float32Array(fr.length); for (let i = 0; i < fr.length; i++) a[i] = fr[i] == null ? NaN : fr[i] * scale; return a; });
}
function prepare(D) {
  const all = [];
  for (const k of ['wind', 'waves', 'current']) {
    const ds = D[k]; if (!ds) continue;
    ds.idx = new Map(ds.times.map((t, i) => [t, i]));
    all.push(...ds.times);
  }
  if (D.wind) { D.wind.U = toFrames(D.wind.u, 0.1); D.wind.V = toFrames(D.wind.v, 0.1); D.wind.G = toFrames(D.wind.gust, 0.1); }
  if (D.waves) {
    const w = D.waves; w.HS = toFrames(w.hs, 0.01); w.TM = toFrames(w.tm, 0.1); w.SW = toFrames(w.swell, 0.01);
    const dir = toFrames(w.dir, 1);
    w.DX = dir.map((a) => a.map((d) => Math.sin(d * RAD))); w.DY = dir.map((a) => a.map((d) => Math.cos(d * RAD))); // "from" unit vector
  }
  if (D.current) { D.current.U = toFrames(D.current.u, 0.01 * KN_PER_MS); D.current.V = toFrames(D.current.v, 0.01 * KN_PER_MS); }
  const t0 = Math.min(...all), t1 = Math.max(...all), times = [];
  for (let t = t0; t <= t1; t += 3600) times.push(t);
  return times;
}

// bilinear sample on a regular grid; NaN cells are skipped (weights renormalised)
function bil(g, A, lat, lon, minW = 0.5) {
  const fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
  if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, g.nx - 1), y1 = Math.min(y0 + 1, g.ny - 1);
  const wx = fx - x0, wy = fy - y0;
  let s = 0, w = 0, v;
  v = A[y0 * g.nx + x0]; if (v === v) { const k = (1 - wx) * (1 - wy); s += v * k; w += k; }
  v = A[y0 * g.nx + x1]; if (v === v) { const k = wx * (1 - wy); s += v * k; w += k; }
  v = A[y1 * g.nx + x0]; if (v === v) { const k = (1 - wx) * wy; s += v * k; w += k; }
  v = A[y1 * g.nx + x1]; if (v === v) { const k = wx * wy; s += v * k; w += k; }
  return w >= minW ? s / w : NaN;
}
// nearest grid node with data (for beach spots that fall on a land cell)
function nearestSea(g, A, lat, lon, maxCells = 4) {
  const cx = Math.round((lon - g.lon0) / g.dlon), cy = Math.round((lat - g.lat0) / g.dlat);
  let best = null;
  for (let dy = -maxCells; dy <= maxCells; dy++) for (let dx = -maxCells; dx <= maxCells; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= g.nx || y >= g.ny || !(A[y * g.nx + x] === A[y * g.nx + x])) continue;
    const la = g.lat0 + y * g.dlat, lo = g.lon0 + x * g.dlon, d = kmBetween(lat, lon, la, lo);
    if (!best || d < best.d) best = { lat: la, lon: lo, d };
  }
  return best;
}
function kmBetween(la1, lo1, la2, lo2) {
  const dx = (lo2 - lo1) * 111.32 * Math.cos(((la1 + la2) / 2) * RAD), dy = (la2 - la1) * 110.57;
  return Math.hypot(dx, dy);
}
// Simplified North Sea coastline, walked with the sea on the LEFT, so beach facing = segment bearing − 90°.
const COAST = [
  [[51.975, 4.09], [52.11, 4.27], [52.205, 4.395], [52.24, 4.425], [52.375, 4.525], [52.46, 4.565], [52.62, 4.625], [52.77, 4.655], [52.84, 4.69], [52.955, 4.72]], // Hoek v Holland – Den Helder
  [[53.0, 4.705], [53.08, 4.73], [53.13, 4.78], [53.175, 4.86]],                         // Texel west coast
  [[53.235, 4.92], [53.30, 5.10]],                                                        // Vlieland
  [[53.34, 5.17], [53.40, 5.30], [53.45, 5.45], [53.48, 5.60]],                            // Terschelling
];
function coastFacing(lat, lon) {
  let best = null;
  const kx = 111.32 * Math.cos(lat * RAD), ky = 110.57;
  for (const line of COAST) for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const ax = (a[1] - lon) * kx, ay = (a[0] - lat) * ky, bx = (b[1] - lon) * kx, by = (b[0] - lat) * ky;
    const dx = bx - ax, dy = by - ay, f = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(ax + f * dx, ay + f * dy);
    if (!best || d < best.d) best = { d, facing: norm360(Math.atan2(dx, dy) / RAD - 90) };
  }
  return best && best.d < 8 ? Math.round(best.facing / 5) * 5 : null;
}
// seaward direction of the beach: from the coastline above, else estimated from the current model's land/sea mask
function estimateFacing(lat, lon) {
  const cf = coastFacing(lat, lon); if (cf != null) return cf;
  const c = S.D.current; if (!c) return 290;
  const g = c.grid, A = c.U[0], R = 12;
  let sx = 0, sy = 0;
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    const la = g.lat0 + y * g.dlat, lo = g.lon0 + x * g.dlon;
    const dx = (lo - lon) * 111.32 * Math.cos(lat * RAD), dy = (la - lat) * 110.57, d = Math.hypot(dx, dy);
    if (d < 0.5 || d > R) continue;
    const w = A[y * g.nx + x] === A[y * g.nx + x] ? 1 : -1;
    sx += (w * dx) / d; sy += (w * dy) / d;
  }
  return Math.round(norm360(Math.atan2(sx, sy) / RAD) / 5) * 5;
}

// all model values at one point and one time index
function sampleAt(lat, lon, t, marinePos) {
  const D = S.D, o = { t };
  const w = D.wind, wi = w && w.idx.get(t);
  if (wi !== undefined) {
    const u = bil(w.grid, w.U[wi], lat, lon), v = bil(w.grid, w.V[wi], lat, lon);
    o.ws = Math.hypot(u, v); o.wd = norm360(bearingOf(u, v) + 180); o.gust = bil(w.grid, w.G[wi], lat, lon);
  }
  const wv = D.waves, vi = wv && wv.idx.get(t);
  if (vi !== undefined) {
    const p = marinePos ? marinePos.waves : { lat, lon };
    if (p) {
      o.hs = bil(wv.grid, wv.HS[vi], p.lat, p.lon); o.tm = bil(wv.grid, wv.TM[vi], p.lat, p.lon); o.sw = bil(wv.grid, wv.SW[vi], p.lat, p.lon);
      o.vd = bearingOf(bil(wv.grid, wv.DX[vi], p.lat, p.lon), bil(wv.grid, wv.DY[vi], p.lat, p.lon)); // from
    }
  }
  const c = D.current, ci = c && c.idx.get(t);
  if (ci !== undefined) {
    const p = marinePos ? marinePos.current : { lat, lon };
    if (p) { const u = bil(c.grid, c.U[ci], p.lat, p.lon), v = bil(c.grid, c.V[ci], p.lat, p.lon); o.cs = Math.hypot(u, v); o.cd = bearingOf(u, v); } // to
  }
  // inside the Wadden grid the fine grid wins; a gap there means a dry flat at that hour
  const W = S.W, fi = W && W.idx.get(t), fp = marinePos ? marinePos.wadden : (W && inGrid(W.grid, lat, lon) ? { lat, lon } : null);
  if (W && fi !== undefined && fp) {
    const u = bil(W.grid, W.U[fi], fp.lat, fp.lon, 0.75), v = bil(W.grid, W.V[fi], fp.lat, fp.lon, 0.75);
    o.cs = Math.hypot(u, v); o.cd = Number.isFinite(o.cs) ? bearingOf(u, v) : NaN; o.cfine = true;
  }
  return o;
}
const inGrid = (g, lat, lon) => lon >= g.lon0 && lat >= g.lat0 && lon <= g.lon0 + (g.nx - 1) * g.dlon && lat <= g.lat0 + (g.ny - 1) * g.dlat;
function marinePosFor(lat, lon) {
  const pos = {};
  if (S.W && inGrid(S.W.grid, lat, lon)) {
    const g = S.W.grid, A = S.W.U[0];
    pos.wadden = bil(g, A, lat, lon, 0.75) === bil(g, A, lat, lon, 0.75) ? { lat, lon, d: 0 } : nearestSea(g, A, lat, lon, 4);
  }
  for (const [k, key] of [['waves', 'HS'], ['current', 'U']]) {
    const ds = S.D[k]; if (!ds) continue;
    const A = ds[key][0];
    if (bil(ds.grid, A, lat, lon) === bil(ds.grid, A, lat, lon)) pos[k] = { lat, lon, d: 0 };
    else pos[k] = nearestSea(ds.grid, A, lat, lon);
  }
  return pos;
}
function pointSeries(lat, lon) {
  const pos = marinePosFor(lat, lon);
  return { lat, lon, pos, rows: S.times.map((t) => sampleAt(lat, lon, t, pos)) };
}

// ------------------------------------------------------------------ kite evaluation
function checkHour(r, th, facing, lat, lon) {
  const why = [];
  if (!Number.isFinite(r.ws)) return { ok: false, why: ['no wind data'] };
  if (r.ws < th.windMin) why.push(`wind ${fmt0(r.ws)} < ${th.windMin} kn`);
  if (r.ws > th.windMax) why.push(`wind ${fmt0(r.ws)} > ${th.windMax} kn`);
  if (th.gustMax !== '' && Number.isFinite(+th.gustMax) && r.gust > +th.gustMax) why.push(`gusts ${fmt0(r.gust)} > ${th.gustMax} kn`);
  const relA = angDiff(r.wd, facing); // 0 = onshore, 90 = side-shore, 180 = offshore
  if (relA > 90 + +th.offMargin) why.push(relA > 135 ? 'offshore wind' : 'side-offshore wind');
  else if (relA < 90 - +th.onMargin) why.push(relA < 45 ? 'onshore wind' : 'too much onshore');
  if (th.daylight && !(isDay(r.t, lat, lon) && isDay(r.t + 3600, lat, lon))) why.push('dark');
  if (th.curOpp) {
    if (!Number.isFinite(r.cs)) why.push('no current data');
    else {
      if (angDiff(r.cd, r.wd) > +th.curTol) why.push('current not against wind');
      if (r.cs < +th.curMin) why.push(`current ${fmt1(r.cs)} < ${th.curMin} kn`);
    }
  }
  if (th.waveMax !== '' && Number.isFinite(+th.waveMax)) {
    if (!Number.isFinite(r.hs)) why.push('no wave data');
    else if (r.hs > +th.waveMax) why.push(`waves ${fmt1(r.hs)} > ${th.waveMax} m`);
  }
  return { ok: why.length === 0, why };
}
function evaluate(spot, ser) {
  const th = Object.assign({}, DEFAULT_TH, spot.th);
  const hours = ser.rows.map((r) => checkHour(r, th, spot.facing, spot.lat, spot.lon));
  const wins = [];
  let i = 0;
  const nowH = Math.floor(Date.now() / 3600000) * 3600;
  while (i < hours.length) {
    if (!hours[i].ok) { i++; continue; }
    let j = i; while (j + 1 < hours.length && hours[j + 1].ok) j++;
    const n = j - i + 1;
    if (n >= +th.minHours && ser.rows[j].t >= nowH) {
      const rs = ser.rows.slice(i, j + 1);
      wins.push({ i0: i, i1: j, t0: ser.rows[i].t, t1: ser.rows[j].t + 3600, hours: n,
        wmin: Math.min(...rs.map((r) => r.ws)), wmax: Math.max(...rs.map((r) => r.ws)), gmax: Math.max(...rs.map((r) => r.gust || 0)),
        wd: rs[Math.floor(rs.length / 2)].wd, cs: Math.max(...rs.map((r) => r.cs || 0)) });
    }
    i = j + 1;
  }
  return { th, hours, wins };
}
const winText = (w) => `${tf(F.dayhm, w.t0)}–${tf(F.hm, w.t1)} · ${w.hours} h · ${fmt0(w.wmin)}–${fmt0(w.wmax)} kn ${compass(w.wd)} (gusts ${fmt0(w.gmax)}) · current up to ${fmt1(w.cs)} kn`;

// ------------------------------------------------------------------ map
const map = L.map('map', { zoomControl: true, minZoom: 5, maxZoom: 14, zoomSnap: 0.5, attributionControl: true })
  .fitBounds(store.get('kf.view', [[51.9, 3.7], [53.5, 5.6]]));
map.attributionControl.setPrefix('');
for (const [n, z] of [['dataColor', 250], ['overlay', 255], ['windPart', 260], ['labels', 450]]) {
  const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = 'none';
}
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASES = {
  sat: () => [L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { pane: 'labels', maxZoom: 18 })],
  dark: () => [L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 18, subdomains: 'abcd', attribution: '© OpenStreetMap contributors © CARTO' }),
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', { pane: 'labels', maxZoom: 18, subdomains: 'abcd' })],
  osm: () => [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' })],
  sea: () => [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' })],
};
const BASE_NAMES = { sat: 'Satellite', dark: 'Dark map', osm: 'Street map', sea: 'Sea chart (OpenSeaMap)' };
// overlays above the data colours: EMODnet bathymetry (colours / depth contours) and OpenSeaMap sea marks
const EMOD = 'https://ows.emodnet-bathymetry.eu/wms';
const OVERLAYS = {
  depth: { name: 'Depth (EMODnet)', title: 'Sea-floor depth, EMODnet Bathymetry', make: () => L.tileLayer.wms(EMOD, { layers: 'emodnet:mean_multicolour', format: 'image/png', transparent: true, opacity: 0.8, pane: 'overlay', attribution: 'Bathymetry © EMODnet' }) },
  contours: { name: 'Depth contours', title: 'Depth lines, EMODnet Bathymetry', make: () => L.tileLayer.wms(EMOD, { layers: 'emodnet:contours', format: 'image/png', transparent: true, pane: 'overlay', attribution: 'Bathymetry © EMODnet' }) },
  seamarks: { name: 'Sea marks', title: 'OpenSeaMap buoys, beacons, lights and fairways (zoom in)', make: () => L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { pane: 'labels', maxZoom: 18, attribution: 'Sea marks © OpenSeaMap contributors' }) },
};
function setOverlay(k, on) {
  const o = OVERLAYS[k]; S.ly[k] = !!on; store.set('kf.layers2', S.ly);
  if (on) { o.layer = o.layer || o.make(); o.layer.addTo(map); } else if (o.layer) map.removeLayer(o.layer);
  const el = $('ov_' + k); if (el) el.checked = !!on;
}
let baseLayers = [];
function setBase(k) {
  if (!BASES[k]) k = 'sat';
  baseLayers.forEach((l) => map.removeLayer(l));
  baseLayers = BASES[k]().map((l) => l.addTo(map));
  S.base = k; store.set('kf.base', k); if ($('baseSel')) $('baseSel').value = k;
  if (k === 'sea') setOverlay('seamarks', true);
}
map.attributionControl.addAttribution('Weather: KNMI HARMONIE-AROME · Waves/current: Rijkswaterstaat Matroos');

function makeCanvas(pane, hiDpi) {
  const c = L.DomUtil.create('canvas', 'kf-canvas', map.getPane(pane));
  return { c, ctx: c.getContext('2d'), hiDpi, dpr: 1 };
}
const CV = { color: makeCanvas('dataColor', false), part: makeCanvas('windPart', true) };
function placeCanvases() {
  const sz = map.getSize(), pos = map.containerPointToLayerPoint([0, 0]);
  for (const k in CV) {
    const o = CV[k]; o.dpr = o.hiDpi ? Math.min(2, window.devicePixelRatio || 1) : 1;
    o.c.width = sz.x * o.dpr; o.c.height = sz.y * o.dpr; o.c.style.width = sz.x + 'px'; o.c.style.height = sz.y + 'px';
    L.DomUtil.setPosition(o.c, pos);
    o.ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  }
}

// ---- full-resolution map frames: data/f/<field>/<time>.bin.gz = gzip(int16), row 0 = south
const frameCache = new Map(), FRAME_MAX = 90;
async function gunzip(buf) {
  const b = new Uint8Array(buf);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;                    // already decoded by the browser
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
function loadFrame(field, t, scale) {
  const key = `${field}@${t}`;
  if (frameCache.has(key)) { const v = frameCache.get(key); frameCache.delete(key); frameCache.set(key, v); return v; }
  const p = fetch(`data/f/${field}/${t}.bin.gz`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then(gunzip).then((ab) => {
      const q = new Int16Array(ab), a = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) a[i] = q[i] === -32768 ? NaN : q[i] * scale;
      return a;
    }).catch(() => null);
  frameCache.set(key, p);
  while (frameCache.size > FRAME_MAX) frameCache.delete(frameCache.keys().next().value);
  return p;
}
const layerById = (id) => LAYERS.find((l) => l.id === id) || LAYERS[0];
const curLayer = () => layerById(S.ly.layer);
// grid info + whether every field of a layer exists at time t
function frameInfo(L, t) {
  const src = S.LJ && S.LJ[SRC[L.topic]];
  if (!src || !src.grid || !src.fields) return null;
  for (const f of L.fields) {
    const fi = src.fields[f]; if (!fi) return null;
    if (!(fi.times || src.times).includes(t)) return null;
  }
  return src;
}
async function layerArrays(L, t) {
  const src = frameInfo(L, t); if (!src) return null;
  const arrs = await Promise.all(L.fields.map((f) => loadFrame(f, t, src.fields[f].scale)));
  return arrs.some((a) => !a) ? null : { g: src.grid, arrs };
}
function preloadNext() {
  const L = curLayer(), t = S.times[S.ti + 1];
  if (t && frameInfo(L, t)) layerArrays(L, t);
  const P = particleLayer(); if (P && t && frameInfo(P, t)) layerArrays(P, t);
}

// screen sampling helpers: lon per column, lat per row (Web Mercator)
function screenAxes(step) {
  const sz = map.getSize(), W = Math.ceil(sz.x / step) + 1, H = Math.ceil(sz.y / step) + 1;
  const lons = new Float64Array(W), lats = new Float64Array(H);
  for (let i = 0; i < W; i++) lons[i] = map.containerPointToLatLng([i * step, 0]).lng;
  for (let j = 0; j < H; j++) lats[j] = map.containerPointToLatLng([0, j * step]).lat;
  return { W, H, lons, lats };
}
// bilinear sample without allocation; NaN where fewer than 3 of 4 corners have data
function sampleGrid(g, A, lat, lon) {
  const fx = (lon - g.lon0) / g.dlon, fy = (lat - g.lat0) / g.dlat;
  if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
  return bil(g, A, lat, lon, 0.6);
}

let drawToken = 0;
const PSTEP = 2; // colour layer resolution in screen px
async function drawColor() {
  const tok = ++drawToken, Ly = curLayer(), t = S.times[S.ti];
  const data = await layerArrays(Ly, t);
  if (tok !== drawToken) return;
  const o = CV.color, ctx = o.ctx, sz = map.getSize();
  // pin the canvas to the current view (the map may have moved while the frame was loading)
  if (o.c.width !== sz.x || o.c.height !== sz.y) { o.c.width = sz.x; o.c.height = sz.y; o.c.style.width = sz.x + 'px'; o.c.style.height = sz.y + 'px'; }
  L.DomUtil.setPosition(o.c, map.containerPointToLayerPoint([0, 0]));
  ctx.clearRect(0, 0, sz.x, sz.y);
  renderLegendNote(data ? '' : (S.LJ && S.LJ[SRC[Ly.topic]] && S.LJ[SRC[Ly.topic]].error ? 'not available in this update' : 'no data at this time'));
  if (!data) return;
  const { g, arrs } = data, ax = screenAxes(PSTEP), lut = Ly.L.lut;
  const off = document.createElement('canvas'); off.width = ax.W; off.height = ax.H;
  const octx = off.getContext('2d'), img = octx.createImageData(ax.W, ax.H), d = img.data;
  const n = arrs.length, A0 = arrs[0], A1 = arrs[1], alpha = Ly.alpha;
  for (let j = 0; j < ax.H; j++) {
    const lat = ax.lats[j];
    for (let i = 0; i < ax.W; i++) {
      const lon = ax.lons[i];
      const a = sampleGrid(g, A0, lat, lon); if (!(a === a)) continue;
      const v = n === 1 ? Ly.val(a) : Ly.val(a, sampleGrid(g, A1, lat, lon)); if (!(v === v)) continue;
      const li = lutAt(Ly.L, v), k = (j * ax.W + i) * 4;
      d[k] = lut[li]; d[k + 1] = lut[li + 1]; d[k + 2] = lut[li + 2]; d[k + 3] = lut[li + 3] * alpha;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, ax.W * PSTEP, ax.H * PSTEP);
}

// ---- particles: wind on weather layers, current on the current layer
const particleLayer = () => { const k = curLayer().particles; return k ? layerById(k) : null; };
const FSTEP = 6;
async function buildField() {
  const P = particleLayer(), t = S.times[S.ti];
  const data = P && S.ly.particles ? await layerArrays(P, t) : null;
  if (!data) { S.field = null; return; }
  const { g, arrs } = data, ax = screenAxes(FSTEP), U = new Float32Array(ax.W * ax.H), V = new Float32Array(ax.W * ax.H);
  for (let j = 0; j < ax.H; j++) for (let i = 0; i < ax.W; i++) {
    const k = j * ax.W + i; U[k] = sampleGrid(g, arrs[0], ax.lats[j], ax.lons[i]) * KN; V[k] = sampleGrid(g, arrs[1], ax.lats[j], ax.lons[i]) * KN;
  }
  // speed in px per frame: wind 0.075 px per knot, current 1.4 px per knot (currents are ~15x slower)
  S.field = { W: ax.W, H: ax.H, U, V, pk: P.id === 'current' ? 1.4 : 0.075 };
}
let parts = [], animId = null, moving = false;
function resetParticles() {
  const sz = map.getSize(), n = Math.round(Math.min(4500, (sz.x * sz.y) / 380));
  parts = Array.from({ length: n }, () => spawn({}, sz));
  const o = CV.part; o.ctx.clearRect(0, 0, sz.x, sz.y);
}
function spawn(p, sz) { p.x = Math.random() * sz.x; p.y = Math.random() * sz.y; p.age = Math.floor(Math.random() * 80); p.max = 60 + Math.random() * 60; return p; }
function frame() {
  animId = requestAnimationFrame(frame);
  const o = CV.part, ctx = o.ctx, sz = map.getSize(), f = S.field;
  if (moving) return;
  if (!S.ly.particles || !f) { if (o.dirty) { ctx.clearRect(0, 0, sz.x, sz.y); o.dirty = false; } return; }
  o.dirty = true;
  ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = 'rgba(0,0,0,0.92)'; ctx.fillRect(0, 0, sz.x, sz.y);
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  for (const p of parts) {
    const i = Math.round(p.x / FSTEP), j = Math.round(p.y / FSTEP);
    const k = j * f.W + i, u = f.U[k], v = f.V[k];
    if (i < 0 || j < 0 || i >= f.W || j >= f.H || !(u === u) || ++p.age > p.max) { spawn(p, sz); p.age = 0; continue; }
    const nx = p.x + u * f.pk, ny = p.y - v * f.pk;
    ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); p.x = nx; p.y = ny;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.1; ctx.stroke();
}

// small arrow (used by the chart)
function arrow(ctx, x, y, bearing, len, color, width) {
  const a = bearing * RAD, dx = Math.sin(a), dy = -Math.cos(a);
  const x0 = x - (dx * len) / 2, y0 = y - (dy * len) / 2, x1 = x + (dx * len) / 2, y1 = y + (dy * len) / 2;
  const h = Math.min(6, len * 0.45), px = -dy, py = dx;
  const path = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1 - dx * h + px * h * 0.6, y1 - dy * h + py * h * 0.6); ctx.lineTo(x1, y1); ctx.lineTo(x1 - dx * h - px * h * 0.6, y1 - dy * h - py * h * 0.6); };
  path(); ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = width + 2.2; ctx.stroke();
  path(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
}

async function redrawMap() { if (!S.D && !S.LJ) return; drawColor(); await buildField(); preloadNext(); }
map.on('movestart zoomstart', () => {
  moving = true; CV.part.ctx.clearRect(0, 0, CV.part.c.width, CV.part.c.height);
});
map.on('zoomstart', () => { CV.color.c.style.opacity = 0; });
map.on('moveend', () => {
  placeCanvases(); redrawMap(); resetParticles(); moving = false;
  CV.color.c.style.opacity = 1;
  const b = map.getBounds(); store.set('kf.view', [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]);
});
map.on('resize', () => { placeCanvases(); redrawMap(); resetParticles(); });
// keep colours under the finger while dragging (throttled; skipped during zoom animations)
let zooming = false, lastLive = 0;
map.on('zoomstart', () => { zooming = true; });
map.on('zoomend', () => { zooming = false; });
map.on('move', () => {
  const now = performance.now();
  if (zooming || now - lastLive < 120 || !S.LJ) return;
  lastLive = now; placeCanvases(); drawColor();
});

// ---- layer menu (Windy-style: topic tabs, layer list, overlays, background)
function renderMenu() {
  const L = curLayer(), box = $('layers');
  const avail = (l) => { const src = S.LJ && S.LJ[SRC[l.topic]]; return !!(src && src.fields && l.fields.every((f) => src.fields[f])); };
  box.innerHTML = `<div class="tabs">${Object.entries(TOPICS).map(([k, n]) => `<button class="tab ${L.topic === k ? 'on' : ''}" data-topic="${k}">${n}</button>`).join('')}</div>
    <div class="lylist">${LAYERS.filter((l) => l.topic === L.topic).map((l) => `<button class="ly ${l.id === L.id ? 'on' : ''}" data-ly="${l.id}" ${avail(l) ? '' : 'disabled title="Not in this update"'}><span>${l.icon}</span>${l.name}</button>`).join('')}</div>
    <div class="card-title">Overlays</div>
    <label><input type="checkbox" id="ov_particles" ${S.ly.particles ? 'checked' : ''}> Moving ${L.particles === 'current' ? 'current' : 'wind'} particles</label>
    ${Object.entries(OVERLAYS).map(([k, o]) => `<label title="${o.title}"><input type="checkbox" id="ov_${k}" ${S.ly[k] ? 'checked' : ''}> ${o.name}</label>`).join('')}
    <div class="card-title">Background</div>
    <select id="baseSel">${Object.entries(BASE_NAMES).map(([k, n]) => `<option value="${k}" ${S.base === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  box.querySelectorAll('[data-topic]').forEach((b) => b.onclick = () => { const l = LAYERS.find((x) => x.topic === b.dataset.topic && avail(x)) || LAYERS.find((x) => x.topic === b.dataset.topic); selectLayer(l.id); });
  box.querySelectorAll('[data-ly]').forEach((b) => b.onclick = () => selectLayer(b.dataset.ly));
  $('ov_particles').onchange = (e) => { S.ly.particles = e.target.checked; store.set('kf.layers2', S.ly); redrawMap(); };
  for (const k of Object.keys(OVERLAYS)) $('ov_' + k).onchange = (e) => setOverlay(k, e.target.checked);
  $('baseSel').onchange = (e) => setBase(e.target.value);
}
function selectLayer(id) {
  S.ly.layer = id; store.set('kf.layers2', S.ly);
  renderMenu(); drawLegend(); resetParticles(); redrawMap();
}

// hover readout
map.on('mousemove', (e) => { if (S.D) showReadout(e.latlng.lat, e.latlng.lng); });
map.on('mouseout', () => $('readout').classList.add('hidden'));
function showReadout(lat, lon) {
  const r = S.D ? sampleAt(lat, lon, S.times[S.ti]) : {};
  const parts2 = [`<span class="muted">${lat.toFixed(3)}° N ${lon.toFixed(3)}° E</span>`];
  const L = curLayer(), t = S.times[S.ti], src = frameInfo(L, t);
  if (src) {
    const ks = L.fields.map((f) => frameCache.get(`${f}@${t}`));
    Promise.all(ks).then((arrs) => {
      if (arrs.some((a) => !a) || !$('roLayer')) return;
      const vals = arrs.map((a) => sampleGrid(src.grid, a, lat, lon)), v = L.val(...vals);
      if (Number.isFinite(v)) {
        const li = lutAt(L.L, v), c = L.L.lut;
        $('roLayer').innerHTML = `<b style="color:rgb(${c[li]},${c[li + 1]},${c[li + 2]})">■</b> ${L.name} <b>${v < 10 && L.unit !== '%' ? v.toFixed(1) : Math.round(v)} ${L.unit}</b>` +
          (L.fields.length === 2 ? ` toward ${compass(bearingOf(vals[0], vals[1]))}` : '');
      } else $('roLayer').textContent = `${L.name}: no data here`;
    });
    parts2.push('<span id="roLayer"></span>');
  }
  if (Number.isFinite(r.ws)) parts2.push(`<b style="color:${windColor(r.ws)}">■</b> Wind <b>${fmt0(r.ws)} kn</b> from ${compass(r.wd)} · gusts ${fmt0(r.gust)} kn`);
  if (Number.isFinite(r.hs)) parts2.push(`Waves <b>${fmt1(r.hs)} m</b> ${fmt1(r.tm)} s from ${compass(r.vd)} · swell ${fmt1(r.sw)} m`);
  if (Number.isFinite(r.cs)) parts2.push(`Current <b>${fmt1(r.cs)} kn</b> toward ${compass(r.cd)}`);
  $('readout').innerHTML = parts2.join('<br>'); $('readout').classList.remove('hidden');
}

// ------------------------------------------------------------------ time bar
function setTime(i) {
  S.ti = Math.max(0, Math.min(S.times.length - 1, i));
  $('slider').value = S.ti;
  $('tLabel').textContent = tf(F.full, S.times[S.ti]);
  redrawMap();
  if (S.sel) { drawChart(); drawCompass(); renderWins(); }
}
function buildTimebar() {
  const sl = $('slider'), n = S.times.length;
  sl.max = n - 1;
  const days = $('tlDays'); days.innerHTML = '';
  S.times.forEach((t, i) => {
    if (localHour(t) === 0 || i === 0) {
      const s = document.createElement('span'); s.textContent = tf(F.day, t);
      s.style.left = (i / (n - 1)) * 100 + '%'; days.appendChild(s);
    }
  });
}
$('slider').addEventListener('input', (e) => setTime(+e.target.value));
$('btnPlay').addEventListener('click', () => {
  if (S.playing) { clearInterval(S.playing); S.playing = null; $('btnPlay').textContent = '▶'; return; }
  $('btnPlay').textContent = '❚❚';
  S.playing = setInterval(() => setTime(S.ti + 1 >= S.times.length ? 0 : S.ti + 1), 800);
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text],input[type=number],textarea')) return;
  if (e.key === 'ArrowRight') setTime(S.ti + 1);
  if (e.key === 'ArrowLeft') setTime(S.ti - 1);
  if (e.key === 'Escape') closePanel('point');
});

// ------------------------------------------------------------------ status bar
function renderStatus() {
  const D = S.D; if (!D) return;
  const ts = (iso) => (iso ? Date.parse(iso) / 1000 : null);
  const run = (k, label) => {
    const ds = D[k]; if (!ds) return `<span class="chip warn">${label}: no data</span>`;
    const r = ts(ds.run);
    return `<span class="chip">${label}: <b>${r ? tf(F.dayhm, r) : '?'}</b> run${ds.stale ? ' <span class="warn">(old: update failed)</span>' : ''}</span>`;
  };
  const gen = ts(D.generated), nxt = ts(D.next_update), ageH = (Date.now() / 1000 - gen) / 3600;
  $('status').innerHTML = [
    S.LJ && S.LJ.weather && S.LJ.weather.run ? `<span class="chip">HARMONIE: <b>${tf(F.dayhm, ts(S.LJ.weather.run))}</b> run${S.LJ.weather.stale ? ' <span class="warn">(old: update failed)</span>' : ''}</span>` : run('wind', 'Wind HARMONIE'),
    run('waves', 'Waves SWAN'), run('current', 'Current DCSM'),
    `<span class="chip ${ageH > 7 ? 'warn' : 'fresh'}">Data fetched <b>${rel(gen)}</b></span>`,
    `<span class="chip">Next update <b>${tf(F.dayhm, nxt)}</b> (${rel(nxt)})</span>`,
  ].join('');
  $('status').title = `Fetched ${tf(F.full, gen)} (${TZ}). Model runs are shown in local time.` + (Object.keys(D.errors || {}).length ? `\nErrors: ${JSON.stringify(D.errors)}` : '');
}
setInterval(renderStatus, 60000);

// ------------------------------------------------------------------ point panel + chart
let selMarker = null;
function openPoint(lat, lon, spotId) {
  S.sel = { lat, lon, spotId, ser: pointSeries(lat, lon) };
  if (selMarker) map.removeLayer(selMarker);
  if (!spotId) selMarker = L.marker([lat, lon], { icon: L.divIcon({ className: 'spot-icon', html: '<div class="sel-pin"></div>', iconSize: [14, 14] }), interactive: false }).addTo(map);
  const spot = spotId && S.spots.find((s) => s.id === spotId);
  $('pTitle').textContent = spot ? spot.name : `${lat.toFixed(3)}° N, ${lon.toFixed(3)}° E`;
  const pos = S.sel.ser.pos, notes = [];
  for (const k of ['waves', 'current']) {
    const q = k === 'current' && pos.wadden ? pos.wadden : pos[k];
    if (!q) notes.push(`no ${k} data here`);
    else if (q.d > 0.3) notes.push(`${k} from nearest sea point ${q.d.toFixed(1)} km away`);
  }
  if (pos.wadden) notes.push('current from the fine Wadden grid (~670 m)');
  $('pSub').textContent = notes.join(' · ');
  $('btnSaveSpot').classList.toggle('hidden', !!spot);
  $('point').classList.remove('hidden');
  renderSpotCfg();
  drawChart();
}
function closePanel(id) {
  $(id).classList.add('hidden');
  if (id === 'point') { S.sel = null; if (selMarker) { map.removeLayer(selMarker); selMarker = null; } }
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel(b.dataset.close)));
map.on('click', (e) => { if (S.D) openPoint(e.latlng.lat, e.latlng.lng, null); });

const chart = { c: $('chart'), geo: null, hover: null };
function drawChart() {
  if (!S.sel) return;
  const c = chart.c, dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const ser = S.sel.ser, rows = ser.rows, n = rows.length;
  const spot = S.sel.spotId && S.spots.find((s) => s.id === S.sel.spotId);
  const ev = spot ? evaluate(spot, ser) : null;
  const padL = 36, padR = 40, top = 22, rowH = 17, nRows = 3, bottom = 16;
  const pb = H - bottom - nRows * rowH - 6, pt = top;
  const t0 = rows[0].t, t1 = rows[n - 1].t;
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const maxKn = Math.max(25, Math.ceil((Math.max(0, ...rows.map((r) => r.gust || 0, 0)) + 3) / 5) * 5);
  const maxR = Math.max(2, Math.ceil(Math.max(0, ...rows.map((r) => Math.max(r.hs || 0, r.cs || 0, r.sw || 0))) * 2 + 0.6) / 2);
  const YL = (v) => pb - (v / maxKn) * (pb - pt), YR = (v) => pb - (v / maxR) * (pb - pt);
  chart.geo = { X, padL, padR, W, t0, t1, n, pt, pb };
  const css = getComputedStyle(document.documentElement);
  const col = (n2) => css.getPropertyValue(n2).trim();
  const half = (X(t0 + 3600) - X(t0)) / 2;

  // night
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  rows.forEach((r) => { if (!isDay(r.t, ser.lat, ser.lon)) ctx.fillRect(X(r.t) - half, pt, half * 2 + 0.5, pb - pt); });
  // kite windows
  if (ev) {
    for (const w of ev.wins) {
      const xa = X(rows[w.i0].t) - half, xb = X(rows[w.i1].t) + half;
      ctx.fillStyle = 'rgba(34,197,94,0.16)'; ctx.fillRect(xa, pt, xb - xa, pb - pt);
      ctx.fillStyle = '#22c55e'; ctx.fillRect(xa, 4, xb - xa, 12);
      ctx.fillStyle = '#062b14'; ctx.font = '700 10px sans-serif'; ctx.textAlign = 'center';
      if (xb - xa > 26) ctx.fillText(`${w.hours} h`, (xa + xb) / 2, 13);
    }
  }
  // grid + axes
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = col('--muted'); ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  const stepKn = maxKn > 40 ? 10 : 5;
  for (let v = 0; v <= maxKn; v += stepKn) { ctx.beginPath(); ctx.moveTo(padL, YL(v)); ctx.lineTo(W - padR, YL(v)); ctx.stroke(); ctx.fillText(v, padL - 4, YL(v) + 3); }
  ctx.textAlign = 'left';
  for (let v = 0; v <= maxR + 1e-9; v += maxR > 3 ? 1 : 0.5) ctx.fillText(v.toFixed(1), W - padR + 4, YR(v) + 3);
  ctx.save(); ctx.translate(10, (pt + pb) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('knots', 0, 0); ctx.restore();
  ctx.save(); ctx.translate(W - 6, (pt + pb) / 2); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('m  /  kn current', 0, 0); ctx.restore();
  // days
  ctx.textAlign = 'left';
  rows.forEach((r, i) => {
    if (localHour(r.t) === 0 || i === 0) {
      const x = X(r.t); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, H - bottom); ctx.stroke();
      ctx.fillStyle = col('--text'); ctx.fillText(tf(F.day, r.t), x + 3, H - 4);
    } else if (localHour(r.t) % 6 === 0 && W > 500) { ctx.fillStyle = col('--muted'); ctx.fillText(String(localHour(r.t)).padStart(2, '0'), X(r.t) - 6, H - 4); }
  });
  // threshold lines
  if (ev) {
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(34,197,94,0.7)';
    for (const v of [ev.th.windMin, ev.th.windMax]) if (v <= maxKn) { ctx.beginPath(); ctx.moveTo(padL, YL(v)); ctx.lineTo(W - padR, YL(v)); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  const line = (key, Y, color, width, dash, fill) => {
    ctx.beginPath(); let on = false, first = null, last = null;
    rows.forEach((r) => { const v = r[key]; if (!Number.isFinite(v)) { on = false; return; } const x = X(r.t), y = Y(v); if (!on) { ctx.moveTo(x, y); on = true; if (first == null) first = x; } else ctx.lineTo(x, y); last = x; });
    if (fill && first != null) { ctx.save(); ctx.lineTo(last, pb); ctx.lineTo(first, pb); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.restore(); ctx.beginPath(); on = false; rows.forEach((r) => { const v = r[key]; if (!Number.isFinite(v)) { on = false; return; } const x = X(r.t), y = Y(v); if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y); }); }
    ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
  };
  line('hs', YR, 'rgba(255,255,255,0.75)', 1.5, null, 'rgba(255,255,255,0.10)');
  line('sw', YR, col('--swell'), 1.5, [2, 3]);
  line('cs', YR, col('--cur'), 2);
  line('gust', YL, col('--gust'), 1.5, [5, 3]);
  line('ws', YL, col('--wind'), 2.6, null, 'rgba(96,165,250,0.12)');
  // direction rows
  const labelsRow = ['Wind', 'Waves', 'Current'];
  const every = Math.max(1, Math.ceil(16 / (half * 2)));
  ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  labelsRow.forEach((lb, k) => { ctx.fillStyle = col('--muted'); ctx.fillText(lb, padL - 4, pb + 6 + k * rowH + 12); });
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  rows.forEach((r, i) => {
    if (i % every) return;
    const x = X(r.t), y0 = pb + 6 + rowH / 2;
    if (Number.isFinite(r.ws)) arrow(ctx, x, y0, r.wd + 180, 12, ev && ev.hours[i].ok ? '#22c55e' : windColor(r.ws), 1.6);
    if (Number.isFinite(r.vd) && r.hs > 0.03) arrow(ctx, x, y0 + rowH, r.vd + 180, 6 + 4 * Math.min(r.hs, 1.5), '#fff', 1.4);
    if (Number.isFinite(r.cd) && r.cs > 0.03) arrow(ctx, x, y0 + 2 * rowH, r.cd, 6 + 4 * Math.min(r.cs, 1.5), '#22d3ee', 1.4);
  });
  // selected map time + now
  const ts = S.times[S.ti];
  if (ts >= t0 && ts <= t1) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(ts), pt - 4); ctx.lineTo(X(ts), H - bottom); ctx.stroke(); }
  const now = Date.now() / 1000;
  if (now >= t0 && now <= t1) { ctx.strokeStyle = 'rgba(239,68,68,0.9)'; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(X(now), pt); ctx.lineTo(X(now), pb); ctx.stroke(); ctx.setLineDash([]); }
  // hover crosshair
  if (chart.hover != null) { const x = X(rows[chart.hover].t); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, pb); ctx.stroke(); }

  $('chartKey').innerHTML = [
    `<span><i style="background:var(--wind)"></i>Wind (kn)</span>`, `<span><i class="dash"></i>Gusts (kn)</span>`,
    `<span><i style="background:#fff"></i>Waves Hs (m)</span>`, `<span><i style="background:var(--swell)"></i>Swell (m)</span>`,
    `<span><i style="background:var(--cur)"></i>Current (kn)</span>`, `<span><i style="background:rgba(0,0,0,.6)"></i>Night</span>`,
    ev ? `<span><i style="background:#22c55e"></i>Kite window</span>` : '',
    `<span>Arrows point where wind, waves and current go. Tap the chart to move the map to that hour.</span>`,
  ].join('');
}
function chartIndexAt(ev) {
  const g = chart.geo; if (!g) return null;
  const r = chart.c.getBoundingClientRect(), x = ev.clientX - r.left;
  const f = (x - g.padL) / (g.W - g.padL - g.padR);
  if (f < -0.02 || f > 1.02) return null;
  return Math.max(0, Math.min(g.n - 1, Math.round(f * (g.n - 1))));
}
chart.c.addEventListener('pointermove', (e) => {
  const i = chartIndexAt(e); chart.hover = i; drawChart();
  const tip = $('chartTip'); if (i == null || !S.sel) { tip.classList.add('hidden'); return; }
  const r = S.sel.ser.rows[i], spot = S.sel.spotId && S.spots.find((s) => s.id === S.sel.spotId);
  const lines = [`<b>${tf(F.full, r.t)}</b> ${isDay(r.t, S.sel.lat, S.sel.lon) ? '' : '<span class="muted">(dark)</span>'}`];
  lines.push(Number.isFinite(r.ws) ? `Wind <b>${fmt0(r.ws)} kn</b> from ${compass(r.wd)} (${fmt0(r.wd)}°) · gusts ${fmt0(r.gust)}` : 'Wind: no data');
  lines.push(Number.isFinite(r.hs) ? `Waves <b>${fmt1(r.hs)} m</b> · ${fmt1(r.tm)} s · from ${compass(r.vd)} · swell ${fmt1(r.sw)} m` : 'Waves: no data');
  lines.push(Number.isFinite(r.cs) ? `Current <b>${fmt1(r.cs)} kn</b> toward ${compass(r.cd)} (${fmt0(r.cd)}°)` : 'Current: no data');
  if (spot) { const h = evaluate(spot, S.sel.ser).hours[i]; lines.push(h.ok ? '<span style="color:#4ade80">✓ all conditions OK</span>' : `<span style="color:#fca5a5">✗ ${h.why.join(', ')}</span>`); }
  tip.innerHTML = lines.join('<br>'); tip.classList.remove('hidden');
  const rect = chart.c.getBoundingClientRect(), x = e.clientX - rect.left;
  tip.style.top = '24px'; tip.style.left = Math.min(Math.max(4, x + 12), rect.width - tip.offsetWidth - 4) + 'px';
  if (x + 12 + tip.offsetWidth > rect.width) tip.style.left = Math.max(4, x - tip.offsetWidth - 12) + 'px';
});
chart.c.addEventListener('pointerleave', () => { chart.hover = null; $('chartTip').classList.add('hidden'); drawChart(); });
chart.c.addEventListener('click', (e) => {
  const i = chartIndexAt(e); if (i == null) return;
  const t = S.sel.ser.rows[i].t, k = S.times.indexOf(t); if (k >= 0) setTime(k);
});
window.addEventListener('resize', () => { if (S.sel) drawChart(); });

// ------------------------------------------------------------------ spots
const uid = () => Math.random().toString(36).slice(2, 9);
function saveSpots() { store.set('kf.spots', S.spots); $('spotJson').value = JSON.stringify(S.spots); }
function loadSpots() {
  const sp = store.get('kf.spots', null);
  S.spots = Array.isArray(sp) ? sp : SEED_SPOTS.map((s) => ({ id: uid(), ...s, facing: null, th: { ...DEFAULT_TH } }));
  // spots added to the defaults later: give them to browsers that saved their spots before
  if (!store.get('kf.seedVlieland', false)) {
    if (!S.spots.some((s) => /vlieland/i.test(s.name))) S.spots.push({ id: uid(), ...SEED_SPOTS.find((s) => s.name === 'Vlieland'), facing: null, th: { ...DEFAULT_TH } });
    store.set('kf.seedVlieland', true);
  }
  for (const s of S.spots) { if (s.facing == null) s.facing = estimateFacing(s.lat, s.lon); s.th = Object.assign({}, DEFAULT_TH, s.th); }
  saveSpots();
}
let spotLayer = L.layerGroup().addTo(map);
function renderSpots() {
  spotLayer.clearLayers();
  const list = $('spotList'); list.innerHTML = '';
  if (!S.spots.length) list.innerHTML = '<p class="muted small">No spots yet.</p>';
  S.spotSer = new Map();
  for (const s of S.spots) {
    const ser = pointSeries(s.lat, s.lon); S.spotSer.set(s.id, ser);
    const ev = evaluate(s, ser), n = ev.wins.length;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'spot-icon', html: `<div class="spot-pin ${n ? 'ok' : ''}" title="${esc(s.name)}">🪁${n ? `<b>${n}</b>` : ''}</div>`, iconSize: [26, 26] }) })
      .on('click', () => openPoint(s.lat, s.lon, s.id)).bindTooltip(`${esc(s.name)}: ${n ? n + ' kite window' + (n > 1 ? 's' : '') : 'no kite window'}`, { direction: 'top', offset: [0, -14] }).addTo(spotLayer);
    const el = document.createElement('div'); el.className = 'spot';
    el.innerHTML = `<div class="row"><b>${esc(s.name)}</b><span class="badge ${n ? 'ok' : 'no'}">${n}</span></div>` +
      (n ? ev.wins.slice(0, 4).map((w) => `<div class="win">✓ ${winText(w)}</div>`).join('') : '<div class="win none">No window that meets all conditions in this forecast.</div>');
    el.addEventListener('click', () => { map.setView([s.lat, s.lon], Math.max(map.getZoom(), 10)); openPoint(s.lat, s.lon, s.id); if (innerWidth < 760) closePanel('spots'); });
    list.appendChild(el);
  }
}
$('btnSpots').addEventListener('click', () => $('spots').classList.toggle('hidden'));
$('btnSaveSpot').addEventListener('click', () => {
  if (!S.sel) return;
  const name = prompt('Name for this spot:', 'My spot'); if (!name) return;
  const s = { id: uid(), name, lat: +S.sel.lat.toFixed(4), lon: +S.sel.lon.toFixed(4), facing: estimateFacing(S.sel.lat, S.sel.lon), th: { ...DEFAULT_TH } };
  S.spots.push(s); saveSpots(); renderSpots(); if (selMarker) { map.removeLayer(selMarker); selMarker = null; } openPoint(s.lat, s.lon, s.id);
});
$('btnImport').addEventListener('click', () => {
  try { const v = JSON.parse($('spotJson').value); if (!Array.isArray(v)) throw new Error('not a list'); S.spots = v; loadSpotsFix(); saveSpots(); renderSpots(); alert('Spots loaded.'); } catch (e) { alert('Could not read that text: ' + e.message); }
});
function loadSpotsFix() { for (const s of S.spots) { s.id = s.id || uid(); if (s.facing == null) s.facing = estimateFacing(s.lat, s.lon); s.th = Object.assign({}, DEFAULT_TH, s.th); } }

const FIELDS = [
  ['windMin', 'Wind at least (kn)', 1], ['windMax', 'Wind at most (kn)', 1], ['gustMax', 'Gusts at most (kn)', 1],
  ['onMargin', 'Side-onshore margin (°)', 5], ['offMargin', 'Side-offshore margin (°)', 5],
  ['curTol', 'Current vs wind tolerance (°)', 5], ['curMin', 'Current at least (kn)', 0.1],
  ['waveMax', 'Waves at most (m, empty = any)', 0.1], ['minHours', 'Minimum duration (h)', 1],
];
function renderSpotCfg() {
  const box = $('spotCfg'), spot = S.sel && S.sel.spotId && S.spots.find((s) => s.id === S.sel.spotId);
  if (!spot) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const th = spot.th;
  box.innerHTML = `
    <div class="compass"><div id="compassSvg"></div>
      <label>Beach faces (°) <input type="number" id="cfFacing" min="0" max="359" step="5" value="${spot.facing}"></label>
      <button class="btn small ghost" id="cfAuto" style="margin-top:6px">Estimate from coastline</button></div>
    <div><div class="fields">
      <label>Name <input type="text" id="cfName" value="${esc(spot.name)}"></label>
      ${FIELDS.map(([k, lb, st]) => `<label>${lb} <input type="number" data-k="${k}" step="${st}" value="${th[k]}"></label>`).join('')}
      <label>Only in daylight <input type="checkbox" data-k="daylight" ${th.daylight ? 'checked' : ''}></label>
      <label>Current must run against wind <input type="checkbox" data-k="curOpp" ${th.curOpp ? 'checked' : ''}></label>
    </div>
    <p class="muted small">Side-shore = wind roughly parallel to the beach. The margins say how far the wind may turn toward the sea (side-onshore) or toward the land (side-offshore). Offshore wind never passes with the side-offshore margin at 0. “Against the wind” means the current flows toward where the wind comes from, within the tolerance.</p>
    <button class="btn small danger" id="cfDelete">Delete spot</button></div>
    <div class="wins" id="cfWins"></div>`;
  const upd = () => { saveSpots(); drawChart(); drawCompass(); renderWins(); renderSpots(); };
  box.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.k;
    th[k] = inp.type === 'checkbox' ? inp.checked : (inp.value === '' ? '' : +inp.value);
    upd();
  }));
  $('cfFacing').addEventListener('change', (e) => { spot.facing = norm360(+e.target.value || 0); upd(); });
  $('cfAuto').addEventListener('click', () => { spot.facing = estimateFacing(spot.lat, spot.lon); $('cfFacing').value = spot.facing; upd(); });
  $('cfName').addEventListener('change', (e) => { spot.name = e.target.value || spot.name; $('pTitle').textContent = spot.name; upd(); });
  $('cfDelete').addEventListener('click', () => {
    if (!confirm(`Delete spot “${spot.name}”?`)) return;
    S.spots = S.spots.filter((s) => s !== spot); saveSpots(); renderSpots(); closePanel('point');
  });
  drawCompass(); renderWins();
}
function renderWins() {
  const el = $('cfWins'); if (!el || !S.sel) return;
  const spot = S.spots.find((s) => s.id === S.sel.spotId); if (!spot) return;
  const ev = evaluate(spot, S.sel.ser);
  el.innerHTML = '<b>Kite windows</b>' + (ev.wins.length ? ev.wins.map((w) => `<div class="win">✓ ${winText(w)}</div>`).join('') : '<div class="win none">None in this forecast. Hover the chart to see which condition fails each hour.</div>');
}
function drawCompass() {
  const el = $('compassSvg'); if (!el || !S.sel) return;
  const spot = S.spots.find((s) => s.id === S.sel.spotId); if (!spot) return;
  const th = Object.assign({}, DEFAULT_TH, spot.th), R = 80, cx = 95, cy = 95;
  const pt = (b, r) => [cx + r * Math.sin(b * RAD), cy - r * Math.cos(b * RAD)];
  let wedges = '';
  for (let b = 0; b < 360; b += 5) {
    const relA = angDiff(b, spot.facing);
    const ok = relA <= 90 + +th.offMargin && relA >= 90 - +th.onMargin;
    const colr = ok ? '#22c55e' : relA > 90 ? '#ef4444' : '#64748b';
    const [x1, y1] = pt(b - 2.5, R), [x2, y2] = pt(b + 2.5, R), [x3, y3] = pt(b + 2.5, R - 18), [x4, y4] = pt(b - 2.5, R - 18);
    wedges += `<path d="M${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} L${x3},${y3} A${R - 18},${R - 18} 0 0 0 ${x4},${y4}Z" fill="${colr}" opacity="${ok ? 0.9 : 0.55}"/>`;
  }
  const r = sampleAt(spot.lat, spot.lon, S.times[S.ti], S.sel.ser.pos);
  let windArrow = '', curArrow = '';
  if (Number.isFinite(r.ws)) { const [x0, y0] = pt(r.wd, R - 4), [x1, y1] = pt(r.wd + 180, 30); windArrow = `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#fff" stroke-width="3" marker-end="url(#ah)"/>`; }
  if (Number.isFinite(r.cs) && r.cs > 0.03) { const [x0, y0] = pt(r.cd + 180, 26), [x1, y1] = pt(r.cd, 26); curArrow = `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#22d3ee" stroke-width="3" marker-end="url(#ahc)"/>`; }
  const [sx, sy] = pt(spot.facing, 46), [lx, ly] = pt(spot.facing + 180, 46);
  const lbl = ['N', 'E', 'S', 'W'].map((t, i) => { const [x, y] = pt(i * 90, R + 9); return `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#9aa8b6" font-size="11">${t}</text>`; }).join('');
  el.innerHTML = `<svg viewBox="0 0 190 190" role="img" aria-label="Wind directions that pass for this spot">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#fff"/></marker>
    <marker id="ahc" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#22d3ee"/></marker></defs>
    ${wedges}${lbl}
    <text x="${sx}" y="${sy + 4}" text-anchor="middle" fill="#7dd3fc" font-size="11" font-weight="700">SEA</text>
    <text x="${lx}" y="${ly + 4}" text-anchor="middle" fill="#d6b98c" font-size="11" font-weight="700">LAND</text>
    ${windArrow}${curArrow}</svg>
    <div class="small muted">Ring = wind coming <i>from</i> that side: <span style="color:#22c55e">■ OK</span> <span style="color:#ef4444">■ offshore</span> <span style="color:#94a3b8">■ onshore</span>. White = wind, cyan = current at the map time.</div>`;
}

// ------------------------------------------------------------------ legend
function drawLegend() {
  const L = curLayer(), c = $('legendCanvas'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  for (let x = 0; x < c.width; x++) {
    const v = L.lo + ((L.hi - L.lo) * x) / c.width, i = lutAt(L.L, v), u = L.L.lut;
    ctx.fillStyle = `rgba(${u[i]},${u[i + 1]},${u[i + 2]},${Math.max(0.25, u[i + 3] / 255)})`; ctx.fillRect(x, 0, 1, c.height);
  }
  $('legendLabels').innerHTML = L.ticks.map((v) => `<span style="left:${((v - L.lo) / (L.hi - L.lo)) * 100}%">${v}</span>`).join('');
  renderLegendNote('');
}
function renderLegendNote(note) {
  const L = curLayer();
  document.querySelector('#legend .legend-unit').innerHTML = `${esc(L.name)}, ${esc(L.unit)}${L.note ? ` · <span class="muted">${esc(L.note)}</span>` : ''}${note ? ` · <span class="warn">${esc(note)}</span>` : ''}`;
}

// ------------------------------------------------------------------ forced update via GitHub Actions
function dialog(html) { $('dlgBox').innerHTML = html; $('dlg').classList.remove('hidden'); }
function closeDialog() { $('dlg').classList.add('hidden'); }
$('dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') closeDialog(); });
$('btnUpdate').addEventListener('click', () => {
  const tok = store.get('kf.ghToken', '');
  if (tok) return dispatchUpdate(tok);
  dialog(`<h3>Update the forecast now</h3>
    <p>New data is fetched by a GitHub job. Two ways to start it:</p>
    <p><b>1. On GitHub</b> (works anywhere): open <a href="${ACTIONS_URL}" target="_blank" rel="noopener">the update job</a>, tap <i>Run workflow</i>, then <i>Run workflow</i> again. New data appears here after about 10–15 minutes.</p>
    <p><b>2. One tap from this page:</b> paste a GitHub fine-grained token with access to only the <code>${esc(REPO.repo)}</code> repository and the permission <i>Actions: Read and write</i>. It is stored only in this browser.</p>
    <p class="small muted">Make one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>: <i>Repository access</i> → <i>Only select repositories</i> → <code>${esc(REPO.repo)}</code>; <i>Permissions</i> → <i>Actions</i> → <i>Read and write</i>; then <i>Generate token</i> and copy it.</p>
    <input type="password" id="tokIn" placeholder="github_pat_…" autocomplete="off">
    <div class="btns"><button class="btn ghost" id="dlgCancel">Close</button><a class="btn ghost" href="${ACTIONS_URL}" target="_blank" rel="noopener">Open GitHub</a><button class="btn" id="tokSave">Save token &amp; update</button></div>`);
  $('dlgCancel').onclick = closeDialog;
  $('tokSave').onclick = () => { const v = $('tokIn').value.trim(); if (!v) return; store.set('kf.ghToken', v); dispatchUpdate(v); };
});
async function gh(path, tok, opts = {}) {
  return fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}${path}`, { ...opts, headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
}
async function dispatchUpdate(tok) {
  const before = S.D && S.D.generated, started = Date.now();
  let opened = false;
  const show = (msg, busy = true) => {
    if (busy && opened && $('dlg').classList.contains('hidden')) return; // closed by the user: keep checking quietly
    opened = true;
    dialog(`<h3>Updating forecast</h3><p>${msg}</p>${busy ? '<div class="progress"><div></div></div>' : ''}<div class="btns"><button class="btn ghost" id="dlgCancel">Close</button></div>`);
    $('dlgCancel').onclick = closeDialog;
  };
  show('Starting the GitHub job…');
  try {
    const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, tok, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      store.del('kf.ghToken');
      dialog(`<h3>GitHub refused the token</h3><p>HTTP ${r.status}. The token was removed from this browser. Check that it has access to the <code>${esc(REPO.repo)}</code> repository with <i>Actions: Read and write</i>, or start the job <a href="${ACTIONS_URL}" target="_blank" rel="noopener">on GitHub</a>.</p><div class="btns"><button class="btn" id="dlgCancel">OK</button></div>`);
      $('dlgCancel').onclick = closeDialog; return;
    }
    if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
  } catch (e) { show(`Could not start the job: ${esc(e.message)}`, false); return; }
  // follow the run, then wait for the new data file
  for (let k = 0; k < 150; k++) {
    await new Promise((res) => setTimeout(res, 10000));
    let state = 'waiting for GitHub';
    try {
      const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1&event=workflow_dispatch`, tok);
      const run = (await r.json()).workflow_runs?.[0];
      if (run && Date.parse(run.created_at) > started - 60000) {
        state = run.status === 'completed' ? `job ${run.conclusion}` : `job ${run.status.replace('_', ' ')}`;
        if (run.status === 'completed' && run.conclusion !== 'success') { show(`The job ended with “${esc(run.conclusion)}”. See <a href="${esc(run.html_url)}" target="_blank" rel="noopener">the log on GitHub</a>.`, false); return; }
      }
    } catch { /* keep polling */ }
    const fresh = await fetchData();
    if (fresh && fresh.generated !== before) { applyData(fresh); show('Done: new data loaded.', false); setTimeout(closeDialog, 1500); return; }
    show(`${state} · ${Math.round((Date.now() - started) / 1000)} s. This usually takes 10–15 minutes; you can close this, the page keeps checking.`);
  }
  show('This is taking longer than expected. The page will pick up the new data on its own once it is published.', false);
}

// ------------------------------------------------------------------ alert (Scheveningen only)
const ALERT_SPOT = /scheveningen/i;
const alerted = new Set();
function checkAlert() {
  const spot = S.spots.find((s) => ALERT_SPOT.test(s.name)); if (!spot || !S.spotSer) return;
  const now = Date.now() / 1000, w = evaluate(spot, S.spotSer.get(spot.id)).wins.find((x) => x.t1 > now);
  if (!w) return;
  const key = `${spot.id}:${w.t0}`; if (alerted.has(key)) return; alerted.add(key);
  const title = w.t0 <= now ? `Kite window open now at ${spot.name}` : `Kite window at ${spot.name} ${rel(w.t0)}`;
  const body = winText(w);
  const notify = () => { try { new Notification(title, { body, tag: key, icon: document.querySelector('link[rel=icon]').href }); } catch { /* not supported */ } };
  if ('Notification' in window && Notification.permission === 'granted') notify();
  let el = $('alertToast');
  if (!el) { el = document.createElement('div'); el.id = 'alertToast'; el.className = 'card'; document.body.appendChild(el); }
  el.style.cssText = 'top:64px;left:50%;transform:translateX(-50%);z-index:1200;max-width:min(520px,calc(100% - 20px));border-color:#22c55e;line-height:1.45';
  const ask = 'Notification' in window && Notification.permission === 'default';
  el.innerHTML = `<div style="display:flex;gap:8px;align-items:flex-start"><div>🪁 <b>${esc(title)}</b><br>${esc(body)}</div><button class="x" id="alertX">×</button></div>` +
    `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><button class="btn small" id="alertOpen">Show</button>` +
    (ask ? '<button class="btn small ghost" id="alertAsk">Also as a browser notification</button>' : '') + '</div>';
  $('alertX').onclick = () => el.remove();
  $('alertOpen').onclick = () => { el.remove(); setTime(Math.max(0, S.times.indexOf(w.t0))); map.setView([spot.lat, spot.lon], Math.max(map.getZoom(), 11)); openPoint(spot.lat, spot.lon, spot.id); };
  if (ask) $('alertAsk').onclick = async () => { if ((await Notification.requestPermission()) === 'granted') { notify(); $('alertAsk').remove(); } };
}

// ------------------------------------------------------------------ boot
async function loadWadden() {
  try {
    const r = await fetch(`data/wadden.json?v=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) return;
    const c = (await r.json()).current; if (!c) return;
    c.idx = new Map(c.times.map((t, i) => [t, i]));
    c.U = toFrames(c.u, 0.01 * KN_PER_MS); c.V = toFrames(c.v, 0.01 * KN_PER_MS); delete c.u; delete c.v;
    S.W = c;
    renderSpots();
    if (S.sel) openPoint(S.sel.lat, S.sel.lon, S.sel.spotId);
  } catch { /* optional file */ }
}
async function fetchData() {
  try { const r = await fetch(`data/forecast.json?v=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
async function fetchLayers() {
  try { const r = await fetch(`data/layers.json?v=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
async function applyData(D) {
  const keepT = S.times[S.ti];
  S.LJ = await fetchLayers();
  frameCache.clear();
  S.D = D;
  // one hourly time axis over the point data and every map layer
  const all = [...prepare(D)];
  for (const k of ['weather', 'current', 'waves']) { const src = S.LJ && S.LJ[k]; if (src && src.times) all.push(...src.times); }
  const t0 = Math.min(...all), t1 = Math.max(...all); S.times = [];
  for (let t = t0; t <= t1; t += 3600) S.times.push(t);
  renderMenu(); drawLegend();
  let i = S.times.indexOf(keepT);
  if (i < 0) { const now = Date.now() / 1000; i = S.times.findIndex((t) => t + 1800 >= now); if (i < 0) i = S.times.length - 1; }
  buildTimebar(); renderStatus();
  if (!S.spots.length) loadSpots();
  renderSpots();
  setTime(i);
  if (S.sel) openPoint(S.sel.lat, S.sel.lon, S.sel.spotId);
  checkAlert();
  loadWadden();
}
async function boot() {
  for (const k of Object.keys(OVERLAYS)) if (S.ly[k]) setOverlay(k, true);
  setBase(S.base);
  renderMenu();
  drawLegend(); placeCanvases(); frame();
  const D = await fetchData();
  if (!D) { $('status').innerHTML = '<span class="warn">No forecast data yet. The first GitHub update has not run, or it failed.</span>'; return; }
  applyData(D);
  // keep an open page current: after the scheduled update, look for new data every 10 minutes
  setInterval(async () => {
    if (!S.D || Date.now() < Date.parse(S.D.next_update) + 5 * 60000) return;
    const fresh = await fetchData(); if (fresh && fresh.generated !== S.D.generated) applyData(fresh);
  }, 600000);
}
boot();
