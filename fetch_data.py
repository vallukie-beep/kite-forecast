#!/usr/bin/env python3
"""Download the kite forecast data and write one compact JSON file for the web page.

Sources
- Wind:    KNMI HARMONIE-AROME (2 km), via the Open-Meteo API (model knmi_harmonie_arome_netherlands).
- Waves:   Rijkswaterstaat SWAN Kuststrook (HARMONIE-forced), via Matroos (noos.matroos.rws.nl).
- Current: Rijkswaterstaat DCSM7/ZUNO (HARMONIE-forced, bias-filtered), via Matroos.

Usage:  python3 fetch_data.py --out docs/data [--previous old_forecast.json]
A source that fails keeps the data from --previous (if given) so the page never goes blank.
Depends only on requests + numpy (nc3.py is a small netCDF-3 reader).
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import time

import numpy as np
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nc3 import NC3  # noqa: E402

# ---------------------------------------------------------------- CONFIG
BBOX = dict(lon0=3.5, lon1=5.7, lat0=51.8, lat1=53.6)       # Hoek van Holland .. Terschelling
WIND_STEP = (0.1, 0.0667)                                     # lon, lat step of the wind grid (~7 km)
MARINE_N = (56, 46)                                           # xn, yn of the Matroos grids (0.04°, ~3-4 km)
MATROOS = "https://noos.matroos.rws.nl/direct"
WAVE_SOURCE = "swan_kuststrook_harmonie"
WAVE_FIELDS = ["wave_height_hm0", "wave_period_tm10", "wave_dir_th0", "swellwave_height_hm0"]
CURRENT_SOURCE = "dcsm7_harmonie_bf_f2w_zuno"
CURRENT_FIELDS = ["VELU", "VELV"]
HORIZON_H = 72
UPDATE_UTC = (4, 40)   # must match the cron in .github/workflows/update.yml
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


def fetch_matroos(source, fields):
    anal = matroos_last_anal(source)
    t0 = dt.datetime.strptime(anal, "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
    t1 = t0 + dt.timedelta(hours=HORIZON_H)
    xn, yn = MARINE_N
    log(f"{source}: run {anal}, fields {fields}")
    out = {}
    times = grid = None
    for f in fields:  # one field per request keeps Matroos' interpolation fast and errors isolated
        r = get(f"{MATROOS}/get_matroos.php", params={
            "source": source, "anal": anal, "color": f,
            "from": t0.strftime("%Y%m%d%H%M"), "to": t1.strftime("%Y%m%d%H%M"), "dtmin": 60,
            "xmin": BBOX["lon0"], "xmax": BBOX["lon1"], "ymin": BBOX["lat0"], "ymax": BBOX["lat1"],
            "xn": xn, "yn": yn, "coords": "WGS84", "format": "nc",
        }, timeout=600)
        nc = NC3(r.content)
        x, y = nc.get("x"), nc.get("y")
        tm = nc.get("time")
        ts = [int(m * 60) for m in tm]
        keep = [i for i, t in enumerate(ts) if t % 3600 == 0]   # hourly only
        if times is None:
            times = [ts[i] for i in keep]
            grid = dict(lon0=float(x[0]), dlon=float((x[-1] - x[0]) / (len(x) - 1)), nx=len(x),
                        lat0=float(y[0]), dlat=float((y[-1] - y[0]) / (len(y) - 1)), ny=len(y))
        a = nc.get(f)
        out[f] = a[keep]
        log(f"  {f}: {len(keep)} frames, range {np.nanmin(a):.2f}..{np.nanmax(a):.2f}")
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


def fetch_current():
    run, times, grid, f = fetch_matroos(CURRENT_SOURCE, CURRENT_FIELDS)
    return {
        "source": "Rijkswaterstaat DCSM7/ZUNO (Matroos)",
        "run": run, "grid": grid, "times": times,
        "units": "u,v in cm/s (u toward east, v toward north)",
        "u": [ints(fr, 100) for fr in f["VELU"]],
        "v": [ints(fr, 100) for fr in f["VELV"]],
    }


# ---------------------------------------------------------------- MAIN
def next_update(now):
    t = now.replace(hour=UPDATE_UTC[0], minute=UPDATE_UTC[1], second=0, microsecond=0)
    return t if t > now else t + dt.timedelta(days=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/data")
    ap.add_argument("--previous", help="previous forecast.json; used for any source that fails")
    a = ap.parse_args()

    prev = {}
    if a.previous and os.path.exists(a.previous):
        try:
            prev = json.load(open(a.previous))
        except Exception as e:  # noqa: BLE001
            log("previous file unreadable:", e)

    now = dt.datetime.now(dt.timezone.utc)
    data = {"generated": iso(now), "next_update": iso(next_update(now)), "bbox": BBOX, "errors": {}}
    for key, fn in (("wind", fetch_wind), ("waves", fetch_waves), ("current", fetch_current)):
        try:
            data[key] = fn()
            data[key]["fetched"] = iso(now)
        except Exception as e:  # noqa: BLE001
            log(f"!! {key} failed: {e}")
            data["errors"][key] = str(e)[:300]
            if key in prev:
                data[key] = prev[key]
                data[key]["stale"] = True
                log(f"   kept previous {key} data (run {prev[key].get('run')})")
    if not any(k in data for k in ("wind", "waves", "current")):
        sys.exit("all sources failed")

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "forecast.json")
    with open(path, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    log(f"wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
