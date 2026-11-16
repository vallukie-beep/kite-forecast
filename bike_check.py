#!/usr/bin/env python3
"""Daily "dry to work?" check and phone alert (Web Push), run by the GitHub job after fetch_data.py.

Reads the HARMONIE hourly rain frames that fetch_data.py just wrote and checks home → work for the
morning and afternoon windows (Amsterdam time), the same way the web page does.

Secrets (GitHub > Settings > Secrets and variables > Actions), never stored in the repo:
  BIKE_ALERT         JSON made by the web page: {"sub": push subscription, "home": [lat, lon],
                     "work": [lat, lon], "am": ["07:30", "09:30"], "pm": ["16:00", "18:00"]}
  VAPID_PRIVATE_KEY  private key that signs the alerts (its public half is VAPID_PUBLIC in docs/app.js)

When it sends: by Amsterdam clock time, whatever started the run (GitHub's schedule, which often skips
runs, the Update button, or an external hourly trigger). The first run between 06:00 and 07:30 sends the
morning alert (both windows), the first between 14:00 and 15:30 the afternoon alert. data/bike_sent.json
(only dates, nothing personal) remembers what was sent so nothing is sent twice. BIKE_TEST=true sends now.

The job log of a public repository is public: this script never prints locations or the subscription.
"""
import argparse
import datetime as dt
import gzip
import json
import math
import os
import sys
from zoneinfo import ZoneInfo

import numpy as np

AMS = ZoneInfo("Europe/Amsterdam")
DRY, LIGHT = 0.1, 0.5        # mm/h: below DRY = dry (green), below LIGHT = a few drops (amber), else rain (red)
MAX_AGE_H = 4                # the HARMONIE run may be at most this old
SITE = "https://vallukie-beep.github.io/kite-forecast/"
SLOTS = {"morning": ((6, 0), (7, 30)), "afternoon": ((14, 0), (15, 30))}   # local times in which an alert may go out


def km(a, b):
    return math.hypot((b[1] - a[1]) * 111.32 * math.cos(math.radians((a[0] + b[0]) / 2)), (b[0] - a[0]) * 110.57)


def points(home, work):
    n = max(1, math.ceil(km(home, work)))
    return [home, work] + [[home[0] + (work[0] - home[0]) * i / n, home[1] + (work[1] - home[1]) * i / n] for i in range(1, n)]


def window(day, win):
    (h0, m0), (h1, m1) = (map(int, w.split(":")) for w in win)
    return (dt.datetime(day.year, day.month, day.day, h0, m0, tzinfo=AMS).timestamp(),
            dt.datetime(day.year, day.month, day.day, h1, m1, tzinfo=AMS).timestamp())


def check(data, weather, pts, a, b):
    """Worst hourly rain (mm/h) in a 3x3 cell box around every point, for the hours overlapping [a, b]."""
    fi = weather["fields"].get("precip")
    if not fi:
        return {"st": "na", "why": "no rain data"}
    times, g = fi.get("times") or weather["times"], weather["grid"]
    need = []
    H = (int(a) // 3600) * 3600 + 3600
    while H - 3600 < b:
        need.append(H)
        H += 3600
    if not all(H in times for H in need):
        return {"st": "na", "why": "not in the forecast"}
    per = []
    for H in need:
        with open(os.path.join(data, "f", "precip", f"{H}.bin.gz"), "rb") as fh:
            q = np.frombuffer(gzip.decompress(fh.read()), "<i2").reshape(g["ny"], g["nx"])
        A = np.where(q == -32768, np.nan, q * fi["scale"])
        mx = 0.0
        for la, lo in pts:
            cx, cy = round((lo - g["lon0"]) / g["dlon"]), round((la - g["lat0"]) / g["dlat"])
            box = A[max(0, cy - 1):cy + 2, max(0, cx - 1):cx + 2]
            if box.size and np.isfinite(box).any():
                mx = max(mx, float(np.nanmax(box)))
        per.append((H, mx))
    m = max(v for _, v in per)
    return {"st": "green" if m < DRY else "amber" if m < LIGHT else "red", "max": m, "per": per}


ICON = {"green": "✅", "amber": "🌦", "red": "☔", "na": "❔"}


def line(win, r):
    span = f"{win[0]}–{win[1]}"
    if r["st"] == "na":
        return f"{ICON['na']} {span}: {r['why']}"
    if r["st"] == "green":
        return f"{ICON['green']} {span} dry"
    wet = max(r["per"], key=lambda p: p[1])
    hour = dt.datetime.fromtimestamp(wet[0] - 3600, AMS).strftime("%H:%M")
    word = "a few drops" if r["st"] == "amber" else "rain"
    return f"{ICON[r['st']]} {span} {word}, up to {r['max']:.1f} mm/h around {hour}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="site/data")
    ap.add_argument("--previous-site", help="live site URL, to read data/bike_sent.json of the last run")
    ap.add_argument("--dry-run", action="store_true", help="print the message instead of sending it")
    a = ap.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    local = now.astimezone(AMS)

    # what was already sent (carried from run to run through the published site)
    sent_path = os.path.join(a.data, "bike_sent.json")
    sent = {}
    if a.previous_site:
        try:
            import urllib.request
            with urllib.request.urlopen(f"{a.previous_site.rstrip('/')}/data/bike_sent.json", timeout=30) as r:
                sent = json.load(r)
        except Exception:  # noqa: BLE001
            sent = {}

    def save():
        with open(sent_path, "w") as fh:
            json.dump(sent, fh)

    save()
    cfg_raw = os.environ.get("BIKE_ALERT", "").strip()
    if not cfg_raw:
        print("bike check: no BIKE_ALERT secret yet, skipping")
        return
    cfg = json.loads(cfg_raw)

    today = local.date().isoformat()
    if os.environ.get("BIKE_TEST", "").lower() == "true":
        slot = "test"
    else:
        hm = (local.hour, local.minute)
        slot = next((k for k, (t0, t1) in SLOTS.items() if t0 <= hm < t1), None)
        if not slot:
            print(f"bike check: {local:%H:%M} is not an alert time")
            return
        if sent.get(slot) == today:
            print(f"bike check: the {slot} alert was already sent today")
            return

    layers = json.load(open(os.path.join(a.data, "layers.json")))
    w = layers.get("weather") or {}
    run = dt.datetime.fromisoformat(w["run"].replace("Z", "+00:00")) if w.get("run") else None
    age_h = (now - run).total_seconds() / 3600 if run else None
    fresh = run is not None and age_h <= MAX_AGE_H and not w.get("stale") and "error" not in w

    day = local.date()
    wins = [("am", cfg.get("am", ["07:30", "09:30"])), ("pm", cfg.get("pm", ["16:00", "18:00"]))]
    if slot == "afternoon":
        wins = wins[1:]
    elif slot == "test" and now.timestamp() > window(day, wins[1][1])[1]:
        day = day + dt.timedelta(days=1)      # test in the evening: show tomorrow
    pts = points(cfg["home"], cfg["work"])

    if not fresh:
        title = "🚲 Dry-commute check: not verified"
        body = (f"The newest HARMONIE run is {age_h:.1f} h old (limit {MAX_AGE_H} h): the KNMI update may be stuck. "
                "Check the radar before you leave." if run else "No HARMONIE data in this update. Check the radar before you leave.")
        status = "stale"
    else:
        res = [(win, check(a.data, w, pts, *window(day, win))) for _, win in wins]
        sts = [r["st"] for _, r in res]
        worst = "red" if "red" in sts else "amber" if "amber" in sts else "na" if "na" in sts else "green"
        when = "Tomorrow" if day != local.date() else "Today"
        title = {"green": f"🚲 {when}: dry ride", "amber": f"🚲 {when}: a few drops possible", "red": f"☔ {when}: rain on your ride",
                 "na": f"🚲 {when}: check incomplete"}[worst]
        run_l = run.astimezone(AMS).strftime("%H:%M")
        body = "\n".join(line(win, r) for win, r in res) + f"\nHARMONIE {run_l} run ({age_h:.1f} h old)"
        status = ",".join(sts)
        if slot == "test":
            title = "[test] " + title

    print(f"bike check ({slot}): {status}; model run age {age_h if age_h is None else round(age_h, 1)} h")
    msg = {"title": title, "body": body, "tag": f"bike-{slot}", "url": "./#bike"}
    if a.dry_run:
        print(json.dumps(msg, ensure_ascii=False, indent=1))
        return

    from pywebpush import WebPushException, webpush
    try:
        r = webpush(subscription_info=cfg["sub"], data=json.dumps(msg), vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
                    vapid_claims={"sub": SITE.rstrip("/")}, ttl=4 * 3600, headers={"Urgency": "high"})
        print(f"bike check: alert sent (HTTP {r.status_code})")
        if slot != "test":
            sent[slot] = today
            save()
    except WebPushException as e:
        code = e.response.status_code if e.response is not None else "?"
        print(f"bike check: sending failed (HTTP {code})" + (": the phone's subscription expired, turn alerts on again in the app" if code in (404, 410) else ""))
        sys.exit(1)


if __name__ == "__main__":
    main()
