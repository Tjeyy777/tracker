# Bus Tracker

- **Rider site:** `/` — pick a route, watch buses move live, see stop-by-stop ETAs.
- **Admin dashboard:** `/admin.html` — draw routes by clicking stops on the map (snapped to roads), add buses and daily departure times, "Start trip now" for testing.

## Run
    npm install
    ADMIN_PASSWORD=yourpassword npm start      # PowerShell: $env:ADMIN_PASSWORD="yourpassword"; npm start

Defaults: user `admin`, password `admin123` (change it!). Set `TOKEN_SECRET` to keep admin sessions across restarts. Data lives in `data/db.json`.

The old single-file prototype is in `legacy/prototype.html`.
