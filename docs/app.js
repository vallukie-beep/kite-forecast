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

// Windy-like wind palette (knots)
const PAL = [[0, 98, 113, 183], [4, 57, 97, 159], [7, 74, 148, 169], [10, 77, 141, 123], [13, 83, 165, 83], [16, 53, 159, 53],
  [19, 167, 157, 81], [22, 159, 127, 58], [25, 161, 108, 92], [29, 129, 58, 78], [33, 175, 80, 136], [38, 117, 74, 147],
  [45, 109, 97, 163], [55, 68, 105, 141]];
const LUT = (() => {
  const n = 241, out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const kn = i / 4; let k = 0;
    while (k < PAL.length - 2 && kn > PAL[k + 1][0]) k++;
    const a = PAL[k], b = PAL[k + 1], f = Math.min(1, Math.max(0, (kn - a[0]) / (b[0] - a[0])));
    for (let c = 0; c < 3; c++) out[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
  }
  return out;
})();
const lutIdx = (kn) => Math.min(240, Math.max(0, Math.round(kn * 4))) * 3;
const windColor = (kn, a = 1) => { const i = lutIdx(kn); return `rgba(${LUT[i]},${LUT[i + 1]},${LUT[i + 2]},${a})`; };

// ------------------------------------------------------------------ state
const S = {
  D: null, times: [], ti: 0, playing: null,
  ly: Object.assign({ color: true, particles: true, waves: true, swell: false, current: true }, store.get('kf.layers', {})),
  base: store.get('kf.base', 'sat'),
  sel: null, // {lat, lon, spotId, ser}
  spots: [],
  field: null,
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
  return o;
}
function marinePosFor(lat, lon) {
  const pos = {};
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
const map = L.map('map', { zoomControl: true, minZoom: 7, maxZoom: 14, zoomSnap: 0.5, attributionControl: true })
  .fitBounds(store.get('kf.view', [[51.9, 3.7], [53.5, 5.6]]));
map.attributionControl.setPrefix('');
for (const [n, z] of [['windColor', 250], ['windPart', 260], ['arrows', 270], ['labels', 450]]) {
  const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = 'none';
}
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASES = {
  sat: () => [L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { pane: 'labels', maxZoom: 18 })],
  dark: () => [L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 18, subdomains: 'abcd', attribution: '© OpenStreetMap contributors © CARTO' }),
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', { pane: 'labels', maxZoom: 18, subdomains: 'abcd' })],
  osm: () => [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' })],
};
let baseLayers = [];
function setBase(k) {
  if (!BASES[k]) k = 'sat';
  baseLayers.forEach((l) => map.removeLayer(l));
  baseLayers = BASES[k]().map((l) => l.addTo(map));
  S.base = k; store.set('kf.base', k); $('baseSel').value = k;
}
map.attributionControl.addAttribution('Wind: KNMI HARMONIE via Open-Meteo · Waves/current: Rijkswaterstaat Matroos');

function makeCanvas(pane, hiDpi) {
  const c = L.DomUtil.create('canvas', 'kf-canvas', map.getPane(pane));
  return { c, ctx: c.getContext('2d'), hiDpi, dpr: 1 };
}
const CV = { color: makeCanvas('windColor', false), part: makeCanvas('windPart', true), arrows: makeCanvas('arrows', true) };
function placeCanvases() {
  const sz = map.getSize(), pos = map.containerPointToLayerPoint([0, 0]);
  for (const k in CV) {
    const o = CV[k]; o.dpr = o.hiDpi ? Math.min(2, window.devicePixelRatio || 1) : 1;
    o.c.width = sz.x * o.dpr; o.c.height = sz.y * o.dpr; o.c.style.width = sz.x + 'px'; o.c.style.height = sz.y + 'px';
    L.DomUtil.setPosition(o.c, pos);
    o.ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  }
}

// screen-space wind field (every STEP px), rebuilt on move / time change
const STEP = 5;
function buildField() {
  const w = S.D && S.D.wind, t = S.times[S.ti];
  const wi = w && w.idx.get(t);
  const sz = map.getSize(), W = Math.ceil(sz.x / STEP) + 1, H = Math.ceil(sz.y / STEP) + 1;
  if (wi === undefined) { S.field = null; return; }
  const lons = new Float64Array(W), lats = new Float64Array(H);
  for (let i = 0; i < W; i++) lons[i] = map.containerPointToLatLng([i * STEP, 0]).lng;
  for (let j = 0; j < H; j++) lats[j] = map.containerPointToLatLng([0, j * STEP]).lat;
  const U = new Float32Array(W * H), V = new Float32Array(W * H), Sp = new Float32Array(W * H);
  const g = w.grid, AU = w.U[wi], AV = w.V[wi];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, u = bil(g, AU, lats[j], lons[i]), v = bil(g, AV, lats[j], lons[i]);
    U[k] = u; V[k] = v; Sp[k] = Math.hypot(u, v);
  }
  S.field = { W, H, U, V, Sp };
}
function drawColor() {
  const o = CV.color, ctx = o.ctx, sz = map.getSize();
  ctx.clearRect(0, 0, sz.x, sz.y);
  const f = S.field; if (!S.ly.color || !f) return;
  const off = document.createElement('canvas'); off.width = f.W; off.height = f.H;
  const octx = off.getContext('2d'), img = octx.createImageData(f.W, f.H), d = img.data;
  for (let k = 0; k < f.W * f.H; k++) {
    const s = f.Sp[k]; if (!(s === s)) continue;
    const i = lutIdx(s); d[k * 4] = LUT[i]; d[k * 4 + 1] = LUT[i + 1]; d[k * 4 + 2] = LUT[i + 2]; d[k * 4 + 3] = 150;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, f.W * STEP, f.H * STEP);
}

// particles
let parts = [], animId = null, moving = false;
const PK = 0.075; // px per frame per knot
function resetParticles() {
  const sz = map.getSize(), n = Math.round(Math.min(4500, (sz.x * sz.y) / 380));
  parts = Array.from({ length: n }, () => spawn({}, sz));
  const o = CV.part; o.ctx.clearRect(0, 0, sz.x, sz.y);
}
function spawn(p, sz) { p.x = Math.random() * sz.x; p.y = Math.random() * sz.y; p.age = Math.floor(Math.random() * 80); p.max = 60 + Math.random() * 60; return p; }
function frame() {
  animId = requestAnimationFrame(frame);
  if (moving || !S.ly.particles || !S.field) return;
  const o = CV.part, ctx = o.ctx, sz = map.getSize(), f = S.field;
  ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = 'rgba(0,0,0,0.92)'; ctx.fillRect(0, 0, sz.x, sz.y);
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  for (const p of parts) {
    const i = Math.round(p.x / STEP), j = Math.round(p.y / STEP);
    const k = j * f.W + i, u = f.U[k], v = f.V[k];
    if (i < 0 || j < 0 || i >= f.W || j >= f.H || !(u === u) || ++p.age > p.max) { spawn(p, sz); p.age = 0; continue; }
    const nx = p.x + u * PK, ny = p.y - v * PK;
    ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); p.x = nx; p.y = ny;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.1; ctx.stroke();
}

// wave / swell / current arrows
function arrow(ctx, x, y, bearing, len, color, width) {
  const a = bearing * RAD, dx = Math.sin(a), dy = -Math.cos(a);
  const x0 = x - (dx * len) / 2, y0 = y - (dy * len) / 2, x1 = x + (dx * len) / 2, y1 = y + (dy * len) / 2;
  const h = Math.min(6, len * 0.45), px = -dy, py = dx;
  const path = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1 - dx * h + px * h * 0.6, y1 - dy * h + py * h * 0.6); ctx.lineTo(x1, y1); ctx.lineTo(x1 - dx * h - px * h * 0.6, y1 - dy * h - py * h * 0.6); };
  path(); ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = width + 2.2; ctx.stroke();
  path(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
}
function drawArrows() {
  const o = CV.arrows, ctx = o.ctx, sz = map.getSize();
  ctx.clearRect(0, 0, sz.x, sz.y);
  const D = S.D; if (!D) return;
  const t = S.times[S.ti], z = map.getZoom(), sp = z >= 11 ? 56 : 44, labels = z >= 10.5;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.font = '600 10px -apple-system, sans-serif'; ctx.textAlign = 'center';
  const wv = D.waves, vi = wv && wv.idx.get(t), c = D.current, ci = c && c.idx.get(t);
  const text = (s, x, y, col) => { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(s, x, y); ctx.fillStyle = col; ctx.fillText(s, x, y); };
  for (let y = sp / 2; y < sz.y; y += sp) for (let x = sp / 2; x < sz.x; x += sp) {
    if ((S.ly.waves || S.ly.swell) && vi !== undefined) {
      const ll = map.containerPointToLatLng([x, y]), g = wv.grid;
      const hs = bil(g, S.ly.swell ? wv.SW[vi] : wv.HS[vi], ll.lat, ll.lng);
      if (hs > 0.03) {
        const from = bearingOf(bil(g, wv.DX[vi], ll.lat, ll.lng), bil(g, wv.DY[vi], ll.lat, ll.lng));
        const col = S.ly.swell ? '#c4b5fd' : '#ffffff';
        arrow(ctx, x, y, from + 180, 9 + 9 * Math.min(hs, 3), col, 1.3 + Math.min(hs, 3) * 0.6);
        if (labels) text(hs.toFixed(1), x, y - 10, col);
      }
    }
    if (S.ly.current && ci !== undefined) {
      const cx = x + sp / 2, cy = y + sp / 2, ll = map.containerPointToLatLng([cx, cy]), g = c.grid;
      const u = bil(g, c.U[ci], ll.lat, ll.lng), v = bil(g, c.V[ci], ll.lat, ll.lng), s = Math.hypot(u, v);
      if (s > 0.05) {
        arrow(ctx, cx, cy, bearingOf(u, v), 7 + 10 * Math.min(s, 2.5), '#22d3ee', 1.5);
        if (labels) text(s.toFixed(1), cx, cy + 16, '#67e8f9');
      }
    }
  }
}

function redrawMap() { buildField(); drawColor(); drawArrows(); }
map.on('movestart zoomstart', () => {
  moving = true; CV.part.ctx.clearRect(0, 0, CV.part.c.width, CV.part.c.height);
});
map.on('zoomstart', () => { CV.color.c.style.opacity = 0; CV.arrows.c.style.opacity = 0; });
map.on('moveend', () => {
  placeCanvases(); redrawMap(); resetParticles(); moving = false;
  CV.color.c.style.opacity = 1; CV.arrows.c.style.opacity = 1;
  const b = map.getBounds(); store.set('kf.view', [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]);
});
map.on('resize', () => { placeCanvases(); redrawMap(); resetParticles(); });

// hover readout
map.on('mousemove', (e) => { if (S.D) showReadout(e.latlng.lat, e.latlng.lng); });
map.on('mouseout', () => $('readout').classList.add('hidden'));
function showReadout(lat, lon) {
  const r = sampleAt(lat, lon, S.times[S.ti]);
  const parts2 = [`<span class="muted">${lat.toFixed(3)}° N ${lon.toFixed(3)}° E</span>`];
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
  if (S.sel) { drawChart(); drawCompass(); }
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
    run('wind', 'Wind HARMONIE'), run('waves', 'Waves SWAN'), run('current', 'Current DCSM'),
    `<span class="chip ${ageH > 26 ? 'warn' : 'fresh'}">Data fetched <b>${rel(gen)}</b></span>`,
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
    if (!pos[k]) notes.push(`no ${k} data here`);
    else if (pos[k].d > 0.3) notes.push(`${k} from nearest sea point ${pos[k].d.toFixed(1)} km away`);
  }
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
  for (const s of S.spots) { if (s.facing == null) s.facing = estimateFacing(s.lat, s.lon); s.th = Object.assign({}, DEFAULT_TH, s.th); }
  saveSpots();
}
let spotLayer = L.layerGroup().addTo(map);
function renderSpots() {
  spotLayer.clearLayers();
  const list = $('spotList'); list.innerHTML = '';
  if (!S.spots.length) list.innerHTML = '<p class="muted small">No spots yet.</p>';
  for (const s of S.spots) {
    const ev = evaluate(s, pointSeries(s.lat, s.lon)), n = ev.wins.length;
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
  const c = $('legendCanvas'), ctx = c.getContext('2d'), max = 45;
  for (let x = 0; x < c.width; x++) { ctx.fillStyle = windColor((x / c.width) * max); ctx.fillRect(x, 0, 1, c.height); }
  $('legendLabels').innerHTML = [0, 5, 10, 15, 20, 25, 30, 35, 40].map((v) => `<span style="left:${(v / max) * 100}%">${v}</span>`).join('');
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
    <p><b>1. On GitHub</b> (works anywhere): open <a href="${ACTIONS_URL}" target="_blank" rel="noopener">the update job</a>, tap <i>Run workflow</i>, then <i>Run workflow</i> again. New data appears here after about 3 minutes.</p>
    <p><b>2. One tap from this page:</b> paste a GitHub fine-grained token with access to only the <code>${esc(REPO.repo)}</code> repository and the permission <i>Actions: Read and write</i>. It is stored only in this browser.</p>
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
  const show = (msg, busy = true) => dialog(`<h3>Updating forecast</h3><p>${msg}</p>${busy ? '<div class="progress"><div></div></div>' : ''}<div class="btns"><button class="btn ghost" id="dlgCancel">Close</button></div>`) || ($('dlgCancel').onclick = closeDialog);
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
  for (let k = 0; k < 80; k++) {
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
    show(`${state} · ${Math.round((Date.now() - started) / 1000)} s. This usually takes 2–4 minutes.`);
  }
  show('This is taking longer than expected. The page will pick up the new data on its own once it is published.', false);
}

// ------------------------------------------------------------------ boot
async function fetchData() {
  try { const r = await fetch(`data/forecast.json?v=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
function applyData(D) {
  const keepT = S.times[S.ti];
  S.D = D; S.times = prepare(D);
  let i = S.times.indexOf(keepT);
  if (i < 0) { const now = Date.now() / 1000; i = S.times.findIndex((t) => t + 1800 >= now); if (i < 0) i = S.times.length - 1; }
  buildTimebar(); renderStatus();
  if (!S.spots.length) loadSpots();
  renderSpots();
  setTime(i);
  if (S.sel) openPoint(S.sel.lat, S.sel.lon, S.sel.spotId);
}
async function boot() {
  setBase(S.base);
  for (const [id, k] of [['lyColor', 'color'], ['lyParticles', 'particles'], ['lyWaves', 'waves'], ['lySwell', 'swell'], ['lyCurrent', 'current']]) {
    const el = $(id); el.checked = !!S.ly[k];
    el.addEventListener('change', () => {
      S.ly[k] = el.checked;
      if (k === 'swell' && el.checked) { S.ly.waves = false; $('lyWaves').checked = false; }
      if (k === 'waves' && el.checked) { S.ly.swell = false; $('lySwell').checked = false; }
      store.set('kf.layers', S.ly);
      if (k === 'particles' && !el.checked) CV.part.ctx.clearRect(0, 0, CV.part.c.width, CV.part.c.height);
      drawColor(); drawArrows();
    });
  }
  $('baseSel').addEventListener('change', (e) => setBase(e.target.value));
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
