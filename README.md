# Bus Tracker

- **Rider site:** `/` — pick a route, watch buses move live, see stop-by-stop ETAs.
- **Admin dashboard:** `/admin.html` — draw routes by clicking stops on the map (snapped to roads), add buses and daily departure times, "Start trip now" for testing.

## Run
    npm install
    npm start

Anyone can create an account on `/admin.html`; each account manages only its own routes, buses and trips.

## Storage
- **Production:** set `DATABASE_URL` to a Postgres connection string (e.g. a free Neon database). Tables are created automatically.
- **Local dev:** with no `DATABASE_URL`, data is kept in `data/db.json` and `data/auth.json` (gitignored).

Optional: `TOKEN_SECRET` (otherwise a secret is generated and stored with the accounts), `PUBLIC_URL`.

The old single-file prototype is in `legacy/prototype.html`.
