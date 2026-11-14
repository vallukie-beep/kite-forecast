# Kite Forecast NL

Windy-style forecast map for the Dutch coast (Hoek van Holland – Terschelling), with kite alerts.

- **Wind:** KNMI HARMONIE-AROME 2 km, via Open-Meteo (colours + moving particles, wind and gusts).
- **Waves:** Rijkswaterstaat SWAN Kuststrook via Matroos (wave height, period, direction, swell).
- **Current:** Rijkswaterstaat DCSM7/ZUNO via Matroos.

A GitHub Action (`.github/workflows/update.yml`) fetches the data every day at 04:40 UTC and publishes the
page to GitHub Pages. The page shows how old the data is and when the next update runs. The **Update now**
button starts the same job.

Click anywhere for a graph of wind, gusts, waves, swell and current. Save a spot to set its limits
(wind range, gusts, side-shore margins, current against the wind, waves, minimum duration, daylight);
spots get a green badge when a kite window is coming. Spots are stored in your browser.

Local test: `python3 fetch_data.py --out docs/data` then `python3 -m http.server -d docs 8811`.
