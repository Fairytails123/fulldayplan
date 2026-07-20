# Fairy Tails — Van Tracker

Internal live map of the Fairy Tails transport vans (BV, BVX, SV) for the office.

- Single-page site (Leaflet + OpenStreetMap), hosted on GitHub Pages.
- Reads live van positions from the self-hosted n8n endpoint, gated by an access key.
- **No secrets in this repo.** The access key is entered in the browser and stored locally; it is never committed.

Open with `?key=YOUR_KEY` or enter the key when prompted.
