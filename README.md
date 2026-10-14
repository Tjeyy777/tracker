# Bus Tracker

- **Rider site:** `/` — pick a route, watch buses move live, see stop-by-stop ETAs.
- **Admin dashboard:** `/admin.html` — draw routes by clicking stops on the map (snapped to roads), add buses and daily departure times, "Start trip now" for testing.

## Run
    npm install
    npm start

Anyone can create an account on /admin.html; each account manages only its own routes, buses and trips. The session-signing secret is generated and saved in `data/auth.json` (gitignored). Data lives in `data/db.json`.

The old single-file prototype is in `legacy/prototype.html`.
