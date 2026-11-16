#!/usr/bin/env python3
"""Download the kite forecast data and write one compact JSON file for the web page.

Sources
- Weather: KNMI HARMONIE-AROME Cy43 P1 (2.5 km, whole model area), from the KNMI Data Platform.
           Needs a free API key in the environment variable KNMI_API_KEY (a GitHub secret).
           Without it, the spot/chart wind falls back to HARMONIE via Open-Meteo and the
           weather map layers are not produced.
- Waves:   Rijkswaterstaat SWAN Kuststrook (HARMONIE-forced), via Matroos (noos.matroos.rws.nl).
- Current: Rijkswaterstaat DCSM7/ZUNO (HARMONIE-forced, bias-filtered), via Matroos.

Output (in --out):
- forecast.json   point data for the spot checks and the click graph (coastal area)
- wadden.json     fine current grid for the Wadden Sea (graphs)
- layers.json     list of map layers, grids and times
- f/<field>/<unix time>.bin.gz   one map frame: gzip of int16 values (row 0 = south),
                  value = int * scale, -32768 = no data

Usage:  python3 fetch_data.py --out docs/data [--previous old_forecast.json] [--previous-site URL]
A source that fails keeps the data from the previous run, so the page never goes blank.
Depends only on requests + numpy (nc3.py reads netCDF-3, grib1.py reads GRIB1).
"""
import argparse
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import shutil
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import tarfile
import time

import numpy as np
from zoneinfo import ZoneInfo
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nc3 import NC3  # noqa: E402
from grib1 import messages  # noqa: E402

# ---------------------------------------------------------------- CONFIG
BBOX = dict(lon0=3.5, lon1=5.7, lat0=51.8, lat1=53.6)       # Hoek van Holland .. Terschelling
WIND_STEP = (0.1, 0.0667)                                     # lon, lat step of the wind grid (~7 km)
MARINE_N = (56, 46)                                           # xn, yn of the Matroos grids (0.04°, ~3-4 km)
MATROOS = "https://noos.matroos.rws.nl/direct"
WAVE_SOURCE = "swan_kuststrook_harmonie"
WAVE_FIELDS = ["wave_height_hm0", "wave_period_tm10", "wave_dir_th0", "swellwave_height_hm0"]
CURRENT_SOURCE = "dcsm7_harmonie_bf_f2w_zuno"
CURRENT_FIELDS = ["VELU", "VELV"]
# Wadden Sea (Texel to Terschelling): the same current model on a ~670 m grid so the tidal channels show.
# Written to a separate file (wadden.json) that the page loads after the main forecast.
WADDEN_BBOX = dict(lon0=4.65, lon1=5.70, lat0=52.90, lat1=53.45)
WADDEN_N = (106, 92)                                          # 0.01° lon x 0.006° lat
HORIZON_H = 72
WEATHER_H = 60          # HARMONIE P1 goes to +60 h

# Full-resolution map frames
KNMI_API = "https://api.dataplatform.knmi.nl/open-data/v1/datasets/harmonie_arome_cy43_p1/versions/1.0"
# Matroos regridded close to the native model resolution (SWAN ~300-450 m, ZUNO ~500-900 m near the coast)
MARINE_BOX = dict(lon0=2.5, lon1=7.3, lat0=51.0, lat1=54.2)
CURRENT_FINE_N = (601, 641)      # 0.008° x 0.005°
WAVES_FINE_N = (801, 801)        # 0.006° x 0.004°
# HARMONIE GRIB1 fields: (indicatorOfParameter, levelType, level) -> name, conversion, int16 scale
HM = {
    "u10": ((33, 105, 10), lambda a: a, 0.01),                 # m/s
    "v10": ((34, 105, 10), lambda a: a, 0.01),
    "gu": ((162, 105, 10), lambda a: a, 0.01),                 # gust components, combined into "gust"
    "gv": ((163, 105, 10), lambda a: a, 0.01),
    "t2m": ((11, 105, 2), lambda a: a - 273.15, 0.01),         # °C
    "td2m": ((17, 105, 2), lambda a: a - 273.15, 0.01),        # °C
    "rh": ((52, 105, 2), lambda a: a * 100 if np.nanmax(a) <= 1.5 else a, 0.01),   # %
    "mslp": ((1, 103, 0), lambda a: a / 100, 0.1),             # hPa
    "precip": ((61, 105, 0), lambda a: a, 0.01),               # accumulated kg/m2 -> mm/h below
    "tcc": ((71, 105, 0), lambda a: a * 100 if np.nanmax(a) <= 1.5 else a, 0.01),  # %
    "lcc": ((73, 105, 0), lambda a: a * 100 if np.nanmax(a) <= 1.5 else a, 0.01),
    "mcc": ((74, 105, 0), lambda a: a * 100 if np.nanmax(a) <= 1.5 else a, 0.01),
    "hcc": ((75, 105, 0), lambda a: a * 100 if np.nanmax(a) <= 1.5 else a, 0.01),
    "vis": ((20, 105, 0), lambda a: a, 10),                    # m
}
UPDATE_EVERY_H, UPDATE_MIN = 1, 17   # must match the cron in .github/workflows/update.yml
KN_PER_MS = 1.943844
UA = {"User-Agent": "kite-forecast/1.0 (personal, non-commercial)"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url, params=None, timeout=240, tries=4):
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout, headers=UA)
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            wait = 10 * (i + 1) ** 2
            log(f"  retry in {wait}s after: {e}")
            time.sleep(wait)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def ints(a, scale):
    """numpy array -> list of ints (value*scale), None for NaN."""
    flat = np.asarray(a, dtype=float).ravel() * scale
    return [None if not math.isfinite(v) else int(round(v)) for v in flat]


# ---------------------------------------------------------------- WIND
def fetch_wind():
    dlon, dlat = WIND_STEP
    nx = int(round((BBOX["lon1"] - BBOX["lon0"]) / dlon)) + 1
    ny = int(round((BBOX["lat1"] - BBOX["lat0"]) / dlat)) + 1
    lons = [round(BBOX["lon0"] + i * dlon, 4) for i in range(nx)]
    lats = [round(BBOX["lat0"] + j * dlat, 4) for j in range(ny)]
    pts = [(la, lo) for la in lats for lo in lons]  # row-major, south row first
    log(f"wind: {nx}x{ny} = {len(pts)} points from Open-Meteo HARMONIE")

    run = None
    try:
        # only used to show the run time; from GitHub's servers this file sometimes hangs, so give up quickly
        meta = get("https://api.open-meteo.com/data/knmi_harmonie_arome_netherlands/static/meta.json", timeout=20, tries=2).json()
        run = dt.datetime.fromtimestamp(meta["last_run_initialisation_time"], dt.timezone.utc)
    except Exception as e:  # noqa: BLE001
        log("  (no run metadata)", e)

    series, times = [], None
    chunk = 80
    for k in range(0, len(pts), chunk):
        part = pts[k:k + chunk]
        params = {
            "latitude": ",".join(str(p[0]) for p in part),
            "longitude": ",".join(str(p[1]) for p in part),
            "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
            "models": "knmi_harmonie_arome_netherlands",
            "wind_speed_unit": "kn",
            "timezone": "GMT",
            "timeformat": "unixtime",
            "past_hours": 6,
            "forecast_hours": HORIZON_H,
            "cell_selection": "nearest",
        }
        # short timeout: a normal answer takes ~1 s; a hanging connection should fail fast and retry
        res = get("https://api.open-meteo.com/v1/forecast", params=params, timeout=45, tries=5).json()
        if isinstance(res, dict):
            res = [res]
        for r in res:
            h = r["hourly"]
            if times is None:
                times = h["time"]
            series.append(h)
        log(f"  {min(k + chunk, len(pts))}/{len(pts)}")
        time.sleep(11)  # Open-Meteo counts every point; stay below 600 points per minute

    nt = len(times)
    # drop trailing hours that the model doesn't cover
    def ok(i):
        return any(s["wind_speed_10m"][i] is not None for s in series)
    last = max(i for i in range(nt) if ok(i))
    first = min(i for i in range(nt) if ok(i))
    times = times[first:last + 1]
    U, V, G = [], [], []
    for i in range(first, last + 1):
        u, v, g = [], [], []
        for s in series:
            sp, di, gu = s["wind_speed_10m"][i], s["wind_direction_10m"][i], s["wind_gusts_10m"][i]
            if sp is None or di is None:
                u.append(None); v.append(None); g.append(None); continue
            rad = math.radians(di)
            u.append(int(round(-sp * math.sin(rad) * 10)))   # toward east, 0.1 kn
            v.append(int(round(-sp * math.cos(rad) * 10)))   # toward north
            g.append(None if gu is None else int(round(gu * 10)))
        U.append(u); V.append(v); G.append(g)
    return {
        "source": "KNMI HARMONIE-AROME 2 km (via Open-Meteo)",
        "run": iso(run) if run else None,
        "grid": dict(lon0=lons[0], dlon=dlon, nx=nx, lat0=lats[0], dlat=dlat, ny=ny),
        "times": times,
        "units": "u,v,gust in 0.1 kn",
        "u": U, "v": V, "gust": G,
    }


# ---------------------------------------------------------------- MAP FRAMES
def write_frame(out, field, t, a, scale):
    """Save one map frame as gzip(int16), row 0 = south. Returns the file size."""
    q = np.where(np.isfinite(a), np.round(np.asarray(a, dtype=float) / scale), -32768)
    q = np.clip(q, -32768, 32767).astype("<i2")
    d = os.path.join(out, "f", field)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{t}.bin.gz")
    with open(path, "wb") as fh:
        fh.write(gzip.compress(q.tobytes(), 6))
    return os.path.getsize(path)


# ---------------------------------------------------------------- HARMONIE (KNMI)
def knmi(path, key, **kw):
    r = requests.get(f"{KNMI_API}{path}", headers={"Authorization": key, **UA}, timeout=60, **kw)
    r.raise_for_status()
    return r.json()


class SameRun(Exception):
    """KNMI has no newer HARMONIE run than the one already published."""


def fetch_harmonie(out, published_run=None):
    """Download the newest HARMONIE P1 run, write every map frame, and return
    (layer info, wind block for forecast.json). Raises SameRun when that run is already published."""
    key = os.environ.get("KNMI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("no KNMI_API_KEY set")
    files = knmi("/files", key, params={"maxKeys": 5, "orderBy": "created", "sorting": "desc"})["files"]
    name = files[0]["filename"]
    m = re.search(r"(\d{10})\.tar$", name)
    if m and published_run:
        newest = dt.datetime.strptime(m.group(1), "%Y%m%d%H").replace(tzinfo=dt.timezone.utc)
        if iso(newest) == published_run:
            raise SameRun(published_run)
    url = knmi(f"/files/{name}/url", key)["temporaryDownloadUrl"]
    log(f"harmonie: {name} ({files[0].get('size', 0) / 1e6:.0f} MB)")

    grid = run = None
    times, acc = [], {}
    sizes, written = 0, set()
    inventory_done = False
    wind = {"u": [], "v": [], "gust": [], "times": []}
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        r.raw.decode_content = True
        with tarfile.open(fileobj=r.raw, mode="r|*") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                data = tar.extractfile(member).read()
                got, valid = {}, None
                msgs = list(messages(data))
                if not inventory_done:
                    log("  GRIB inventory of", member.name, ":",
                        " ".join(f"{m.param}/{m.levtype}/{m.level}" for m in msgs))
                    inventory_done = True
                want = {v[0]: k for k, v in HM.items()}
                for m in msgs:
                    k = want.get(m.key)
                    if k is None or k in got:
                        continue
                    got[k] = HM[k][1](m.values())
                    valid = m.valid
                    if grid is None:
                        g = m.grid
                        grid = dict(lon0=g["lon0"], dlon=g["dlon"], nx=g["ni"], lat0=g["lat0"], dlat=g["dlat"], ny=g["nj"])
                        run = m.ref
                if valid is None or "u10" not in got:
                    continue
                lead = (valid - run).total_seconds() / 3600
                if lead > WEATHER_H:
                    continue
                t = int(valid.timestamp())
                # precipitation is a running total: hourly amounts are written after the loop
                if "precip" in got:
                    acc[t] = got.pop("precip")
                if "gu" in got and "gv" in got:
                    got["gust"] = np.hypot(got.pop("gu"), got.pop("gv"))
                for k, a in got.items():
                    scale = HM[k][2] if k in HM else 0.01
                    sizes += write_frame(out, k, t, a, scale)
                    written.add(k)
                times.append(t)
                # spot/chart wind: the coastal box at full resolution
                if "gust" in got and "v10" in got:
                    wind["times"].append(t)
                    for k, src in (("u", "u10"), ("v", "v10"), ("gust", "gust")):
                        wind[k].append(got[src])
                log(f"  +{lead:.0f} h: {', '.join(sorted(got))}")
    if not times:
        raise RuntimeError("no usable HARMONIE fields found")
    times = sorted(times)
    ts = sorted(acc)
    for i, t in enumerate(ts):   # mm in the hour that ends at t
        if i == 0:
            continue
        sizes += write_frame(out, "precip", t, np.maximum(acc[t] - acc[ts[i - 1]], 0), HM["precip"][2])
        written.add("precip")
    log(f"harmonie: {len(times)} hours written, {sizes / 1e6:.0f} MB")
    info = {"source": "KNMI HARMONIE-AROME Cy43 P1 (2.5 km)", "run": iso(run), "grid": grid,
            "times": times, "fields": {k: {"scale": (HM[k][2] if k in HM else 0.01)} for k in sorted(written)}}
    if "precip" in written:
        info["fields"]["precip"]["times"] = ts[1:]
    return info, harmonie_wind_block(grid, wind, run)


def harmonie_wind_block(grid, w, run):
    """forecast.json wind block (same format as before): HARMONIE cut to the coastal box."""
    lon = grid["lon0"] + np.arange(grid["nx"]) * grid["dlon"]
    lat = grid["lat0"] + np.arange(grid["ny"]) * grid["dlat"]
    xi = np.where((lon >= BBOX["lon0"] - 0.05) & (lon <= BBOX["lon1"] + 0.05))[0]
    yi = np.where((lat >= BBOX["lat0"] - 0.05) & (lat <= BBOX["lat1"] + 0.05))[0]
    order = np.argsort(w["times"])
    cut = lambda a: a[yi[0]:yi[-1] + 1, xi[0]:xi[-1] + 1] * KN_PER_MS  # noqa: E731
    return {
        "source": "KNMI HARMONIE-AROME Cy43 P1 (2.5 km)",
        "run": iso(run),
        "grid": dict(lon0=float(lon[xi[0]]), dlon=grid["dlon"], nx=len(xi), lat0=float(lat[yi[0]]), dlat=grid["dlat"], ny=len(yi)),
        "times": [w["times"][i] for i in order],
        "units": "u,v,gust in 0.1 kn",
        "u": [ints(cut(w["u"][i]), 10) for i in order],
        "v": [ints(cut(w["v"][i]), 10) for i in order],
        "gust": [ints(cut(w["gust"][i]), 10) for i in order],
    }


# ---------------------------------------------------------------- MATROOS
def matroos_last_anal(source):
    now = dt.datetime.now(dt.timezone.utc)
    r = get(f"{MATROOS}/get_anal_times.php", params={
        "database": "maps2d", "source": source,
        "tstart": (now - dt.timedelta(days=2)).strftime("%Y%m%d%H%M"),
        "tstop": (now + dt.timedelta(days=3)).strftime("%Y%m%d%H%M"),
    }, timeout=60)
    anals = [a.strip() for a in r.text.split() if a.strip().isdigit()]
    if not anals:
        raise RuntimeError(f"no analysis times for {source}")
    return sorted(anals)[-1]


MATROOS_PARALLEL = threading.Semaphore(6)   # at most 6 requests at once to Matroos, over all sources together


def fetch_matroos(source, fields, bbox=BBOX, n=MARINE_N, chunk_h=None):
    """Matroos regridded to a regular lat/lon grid. chunk_h splits big requests into time windows
    (Matroos answers 503 when one request is too large). The pieces are fetched in parallel."""
    anal = matroos_last_anal(source)
    t0 = dt.datetime.strptime(anal, "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
    t_end = t0 + dt.timedelta(hours=HORIZON_H)
    step = dt.timedelta(hours=chunk_h or HORIZON_H + 1)
    xn, yn = n
    log(f"{source}: run {anal}, fields {fields}, grid {xn}x{yn}")
    windows, a_from = [], t0
    while a_from <= t_end:
        a_to = min(a_from + step - dt.timedelta(hours=1), t_end)
        windows.append((a_from, a_to))
        a_from = a_to + dt.timedelta(hours=1)

    def one(job):   # one field, one time window -> parsed netCDF, or None past the end of the run
        f, (w0, w1) = job
        with MATROOS_PARALLEL:
            r = get(f"{MATROOS}/get_matroos.php", params={
                "source": source, "anal": anal, "color": f,
                "from": w0.strftime("%Y%m%d%H%M"), "to": w1.strftime("%Y%m%d%H%M"), "dtmin": 60,
                "xmin": bbox["lon0"], "xmax": bbox["lon1"], "ymin": bbox["lat0"], "ymax": bbox["lat1"],
                "xn": xn, "yn": yn, "coords": "WGS84", "format": "nc",
            }, timeout=600)
        if not r.content.startswith(b"CDF"):
            if w0 == t0:
                raise RuntimeError(f"Matroos: {r.text[:200]}")
            return None
        return NC3(r.content)

    jobs = [(f, w) for f in fields for w in windows]
    with ThreadPoolExecutor(max_workers=6) as ex:
        got = dict(zip(jobs, ex.map(one, jobs)))

    out = {}
    times = grid = None
    for f in fields:
        frames, fts = [], []
        for w in windows:
            nc = got[(f, w)]
            if nc is None:
                break           # past the end of the model run
            ts = [int(m * 60) for m in nc.get("time")]
            if not ts:
                break
            keep = [i for i, t in enumerate(ts) if t % 3600 == 0 and t not in fts]   # hourly only
            if grid is None:
                x, y = nc.get("x"), nc.get("y")
                grid = dict(lon0=float(x[0]), dlon=float((x[-1] - x[0]) / (len(x) - 1)), nx=len(x),
                            lat0=float(y[0]), dlat=float((y[-1] - y[0]) / (len(y) - 1)), ny=len(y))
            frames.append(nc.get(f)[keep].astype(np.float32))
            fts += [ts[i] for i in keep]
        a = np.concatenate(frames)
        if times is None:
            times = fts
        elif fts != times:   # keep the hours every field has
            common = sorted(set(times) & set(fts))
            out = {k: v[[times.index(t) for t in common]] for k, v in out.items()}
            a = a[[fts.index(t) for t in common]]
            times = common
        out[f] = a
        log(f"  {source} {f}: {len(fts)} frames, range {np.nanmin(a):.2f}..{np.nanmax(a):.2f}")
    return iso(t0), times, grid, out


def fetch_waves():
    run, times, grid, f = fetch_matroos(WAVE_SOURCE, WAVE_FIELDS)
    return {
        "source": "Rijkswaterstaat SWAN Kuststrook (Matroos)",
        "run": run, "grid": grid, "times": times,
        "units": "hs,swell in cm; tm in 0.1 s; dir = coming from, degrees",
        "hs": [ints(fr, 100) for fr in f["wave_height_hm0"]],
        "tm": [ints(fr, 10) for fr in f["wave_period_tm10"]],
        "dir": [ints(fr, 1) for fr in f["wave_dir_th0"]],
        "swell": [ints(fr, 100) for fr in f["swellwave_height_hm0"]],
    }


def fetch_current(bbox=BBOX, n=MARINE_N, label="Rijkswaterstaat DCSM7/ZUNO (Matroos)"):
    run, times, grid, f = fetch_matroos(CURRENT_SOURCE, CURRENT_FIELDS, bbox, n)
    return {
        "source": label,
        "run": run, "grid": grid, "times": times,
        "units": "u,v in cm/s (u toward east, v toward north)",
        "u": [ints(fr, 100) for fr in f["VELU"]],
        "v": [ints(fr, 100) for fr in f["VELV"]],
    }


def fetch_marine_frames(out):
    """Full-resolution current and wave map frames (both sources side by side)."""
    def one(spec):
        kind, source, fields, n, chunk, label = spec
        try:
            run, times, grid, f = fetch_matroos(source, fields, MARINE_BOX, n, chunk)
            names = {"VELU": "cu", "VELV": "cv", "wave_height_hm0": "hs", "wave_period_tm10": "tm",
                     "swellwave_height_hm0": "swell", "wave_dir_th0": "wd"}
            scales = {"wd": 0.1}   # wave direction (coming from, degrees) does not fit int16 at 0.01
            size = 0
            for fld, arr in f.items():
                for i, t in enumerate(times):
                    size += write_frame(out, names[fld], t, arr[i], scales.get(names[fld], 0.01))
            log(f"{kind} frames: {len(times)} hours, {size / 1e6:.0f} MB")
            return kind, {"source": label, "run": run, "grid": grid, "times": times,
                          "fields": {names[k]: {"scale": scales.get(names[k], 0.01)} for k in f}}
        except Exception as e:  # noqa: BLE001
            log(f"!! {kind} frames failed: {e}")
            return kind, {"error": str(e)[:300]}

    specs = (
        ("current", CURRENT_SOURCE, CURRENT_FIELDS, CURRENT_FINE_N, 24, "Rijkswaterstaat DCSM7/ZUNO (Matroos)"),
        ("waves", WAVE_SOURCE, ["wave_height_hm0", "wave_period_tm10", "swellwave_height_hm0", "wave_dir_th0"], WAVES_FINE_N, 6,
         "Rijkswaterstaat SWAN Kuststrook (Matroos)"),
    )
    with ThreadPoolExecutor(max_workers=2) as ex:
        return dict(ex.map(one, specs))


def copy_previous_frames(site, kind, out):
    """Reuse the previous run's frames of one source (downloaded from the live site)."""
    prev = requests.get(f"{site}/data/layers.json", timeout=60, headers=UA).json()[kind]
    n = 0
    for fld in prev["fields"]:
        d = os.path.join(out, "f", fld)
        os.makedirs(d, exist_ok=True)
        for t in prev["times"]:
            r = get(f"{site}/data/f/{fld}/{t}.bin.gz", timeout=60, tries=2)
            with open(os.path.join(d, f"{t}.bin.gz"), "wb") as fh:
                fh.write(r.content)
            n += 1
    prev["stale"] = True
    log(f"   kept previous {kind} frames ({n} files, run {prev.get('run')})")
    return prev


# ---------------------------------------------------------------- MAIN
def next_update(now):
    t = now.replace(hour=now.hour - now.hour % UPDATE_EVERY_H, minute=UPDATE_MIN, second=0, microsecond=0)
    while t <= now:
        t += dt.timedelta(hours=UPDATE_EVERY_H)
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/data")
    ap.add_argument("--previous", help="previous forecast.json; used for any source that fails")
    ap.add_argument("--previous-site", help="URL of the live site, to reuse its map frames when a source fails")
    ap.add_argument("--previous-dir", help="the data folder of the last published site; unchanged sources are copied from it")
    ap.add_argument("--full", action="store_true", help="fetch every source, even when the published data is still current")
    ap.add_argument("--weather-only", action="store_true", help="test: only fetch HARMONIE map frames (merged into an existing layers.json)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.weather_only:
        path = os.path.join(a.out, "layers.json")
        layers = json.load(open(path)) if os.path.exists(path) else {}
        layers["weather"], _ = fetch_harmonie(a.out)
        with open(path, "w") as fh:
            json.dump(layers, fh, separators=(",", ":"))
        log("wrote", path)
        return

    # the data published by the last successful run (unpacked by the workflow); reused where nothing changed
    pdir = a.previous_dir if a.previous_dir and os.path.isdir(a.previous_dir) else None

    def pjson(name):
        try:
            return json.load(open(os.path.join(pdir, name))) if pdir else {}
        except Exception as e:  # noqa: BLE001
            log(f"previous {name} unreadable: {e}")
            return {}
    prev, prev_layers, prev_wad = pjson("forecast.json"), pjson("layers.json"), pjson("wadden.json")
    if not prev and a.previous and os.path.exists(a.previous):
        try:
            prev = json.load(open(a.previous))
        except Exception as e:  # noqa: BLE001
            log("previous file unreadable:", e)

    now = dt.datetime.now(dt.timezone.utc)
    data = {"generated": iso(now), "next_update": iso(next_update(now)), "bbox": BBOX, "errors": {}}

    # HARMONIE every run (skipped when KNMI has no newer run); waves and current once a day
    marine_due = a.full or not pdir or marine_is_due(prev_layers, now)
    published_run = None if a.full or not pdir else (prev_layers.get("weather") or {}).get("run")
    log(f"plan: HARMONIE {'(if newer than ' + published_run + ')' if published_run else '(always)'}, "
        f"waves/current {'fetch' if marine_due else 'reuse (fetched once a day, after %02d:00 Amsterdam)' % MARINE_HOUR}")

    # every source at the same time: KNMI and Matroos are separate servers, and the Matroos requests
    # share one limit of 6 at a time (MATROOS_PARALLEL)
    t_start = time.time()
    with ThreadPoolExecutor(max_workers=5) as ex:
        jobs = {"harmonie": ex.submit(fetch_harmonie, a.out, published_run)}
        if marine_due:
            jobs.update({
                "marine": ex.submit(fetch_marine_frames, a.out),
                "waves": ex.submit(fetch_waves),
                "current": ex.submit(fetch_current),
                "wadden": ex.submit(fetch_current, WADDEN_BBOX, WADDEN_N, "Rijkswaterstaat DCSM7/ZUNO, fine Wadden grid (Matroos)"),
            })

    def result(key):
        if key not in jobs:
            return None, "not fetched in this run"
        try:
            return jobs[key].result(), None
        except SameRun:
            return None, "same"
        except Exception as e:  # noqa: BLE001
            log(f"!! {key} failed: {e}")
            return None, str(e)[:300]

    def keep(kind, stale):
        """Copy the previously published frames of one source; stale=True marks a failed update."""
        info = dict(prev_layers[kind])
        n = 0
        for fld in info.get("fields", {}):
            src = os.path.join(pdir, "f", fld)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(a.out, "f", fld), dirs_exist_ok=True)
                n += len(os.listdir(src))
        if stale:
            info["stale"] = True
        else:
            info.pop("stale", None)
        log(f"   {kind}: kept the published frames ({n} files, run {info.get('run')})")
        return info

    # map layers (full resolution)
    layers = {"generated": iso(now)}
    hm, err = result("harmonie")
    hm_wind = None
    if hm:
        layers["weather"], hm_wind = hm
        layers["weather"]["fetched"] = iso(now)
    elif err == "same" and "error" not in prev_layers.get("weather", {"error": 1}):
        log(f"harmonie: no newer run than {published_run}")
        layers["weather"] = keep("weather", False)
    else:
        layers["weather"] = {"error": err}
    if marine_due:
        layers.update(result("marine")[0] or {"current": {"error": "failed"}, "waves": {"error": "failed"}})
        for kind in ("current", "waves"):
            if "error" not in layers[kind]:
                layers[kind]["fetched"] = iso(now)
    else:
        for kind in ("current", "waves"):
            layers[kind] = keep(kind, False)
    for kind in ("weather", "current", "waves"):
        if "error" in layers[kind]:
            err = layers[kind]["error"]
            try:
                if pdir and "error" not in prev_layers.get(kind, {"error": 1}):
                    layers[kind] = keep(kind, True)
                elif a.previous_site:
                    layers[kind] = copy_previous_frames(a.previous_site, kind, a.out)
                layers[kind]["error"] = err
            except Exception as e:  # noqa: BLE001
                log(f"   no previous {kind} frames: {e}")
    with open(os.path.join(a.out, "layers.json"), "w") as fh:
        json.dump(layers, fh, separators=(",", ":"))

    # point data for spots and graphs; wind from the HARMONIE run above when we have it
    for key in ("wind", "waves", "current"):
        reuse = key in prev and not prev[key].get("stale") and (
            (key != "wind" and not marine_due) or (key == "wind" and err_same(jobs)))
        if reuse:
            data[key] = prev[key]
            continue
        if key == "wind":
            try:
                val, err = (hm_wind, None) if hm_wind else (fetch_wind(), None)
            except Exception as e:  # noqa: BLE001
                val, err = None, str(e)[:300]
                log(f"!! wind failed: {e}")
        else:
            val, err = result(key)
        if val is not None:
            data[key] = val
            data[key]["fetched"] = iso(now)
        else:
            data["errors"][key] = err
            if key in prev:
                data[key] = prev[key]
                data[key]["stale"] = True
                log(f"   kept previous {key} data (run {prev[key].get('run')})")
    if not any(k in data for k in ("wind", "waves", "current")):
        sys.exit("all sources failed")

    path = os.path.join(a.out, "forecast.json")
    with open(path, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    log(f"wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)")

    # fine Wadden Sea current; optional, the page works without it
    path = os.path.join(a.out, "wadden.json")
    cur, err = result("wadden") if marine_due else (None, "reuse")
    if cur:
        with open(path, "w") as fh:
            json.dump({"generated": iso(now), "bbox": WADDEN_BBOX, "current": cur}, fh, separators=(",", ":"))
        log(f"wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)")
    elif prev_wad:
        shutil.copy(os.path.join(pdir, "wadden.json"), path)
        log("wadden.json: kept the published one")
    else:
        log("!! wadden current failed (page falls back to the coarse grid)")
    log(f"all sources done in {time.time() - t_start:.0f} s")


def err_same(jobs):
    """True when HARMONIE was skipped because the published run is still the newest."""
    try:
        jobs["harmonie"].result()
        return False
    except SameRun:
        return True
    except Exception:  # noqa: BLE001
        return False


MARINE_HOUR = 5   # waves and current are refreshed by the first run after 05:00 Amsterdam time


def marine_is_due(prev_layers, now):
    """Waves/current are fetched once a day: when the published ones are from before today's 05:00
    (Amsterdam), failed last time, or carry no fetch time."""
    infos = [prev_layers.get(k) or {} for k in ("current", "waves")]
    if any("error" in i or i.get("stale") or not i.get("fetched") for i in infos):
        return True
    last = min(dt.datetime.fromisoformat(i["fetched"].replace("Z", "+00:00")) for i in infos)
    loc = now.astimezone(ZoneInfo("Europe/Amsterdam"))
    cut = loc.replace(hour=MARINE_HOUR, minute=0, second=0, microsecond=0)
    if loc < cut:
        cut -= dt.timedelta(days=1)
    return last < cut


if __name__ == "__main__":
    main()
