# Bus Tracker

- **Rider site:** `/` — pick a route, watch buses move live, see stop-by-stop ETAs.
- **Admin dashboard:** `/admin.html` — draw routes by clicking stops on the map (snapped to roads), add buses and daily departure times, "Start trip now" for testing.

## Run
    npm install
    npm start

Anyone can create an account on `/admin.html`; each account manages only its own routes, buses and trips.

## Storage
- **Production:** set `DATABASE_URL` to a Postgres connection string (e.g. Supabase session pooler). Tables (`users`, `routes`, `buses`, `trips`, `meta`) are created automatically, and data from the earlier single-table version is migrated on first start.
- **Local dev:** with no `DATABASE_URL`, data is kept in `data/db.json` and `data/auth.json` (gitignored).

Run a **single server instance**: the in-memory copy is the source of truth, and writes go to Postgres row by row.

## Optional env vars
`TOKEN_SECRET` (otherwise generated and stored in the database), `PUBLIC_URL` (base for share links), `MAX_ROUTES` / `MAX_BUSES` / `MAX_TRIPS` (per-account limits, default 20 / 50 / 200).

Health check for the host: `GET /healthz`.

The old single-file prototype is in `legacy/prototype.html`.
