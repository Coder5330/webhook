# hookcatch

A minimal webhook.site-style request catcher. Every request sent to your
unique endpoint is logged (method, path, query, headers, body) and shown
live in a dashboard. Includes a per-endpoint toggle to add CORS headers
to responses.

## How it works

- `GET /` — dashboard UI
- `ANY /in/:binId/*` — send any request here (any method, any body, any
  content-type) and it gets captured
- `GET /api/bins/:binId` — JSON list of captured requests (dashboard polls this)
- `POST /api/bins/:binId/cors` — toggle CORS headers `{ "enabled": true|false }`
- `DELETE /api/bins/:binId/requests` — clear the log

This is a **Flask** app (`app.py`). Storage is a **relational database**,
with two tables (`bins`, `requests`). Each bin keeps its most recent 300
requests. There's also an **Export** button in the dashboard that
downloads the full log for a bin as JSON at any time.

### About persistence on Render specifically

Storage backend is chosen at runtime by the `DATABASE_URL` env var:

- **`DATABASE_URL` set → Postgres.** This is the default in production
  (`render.yaml` provisions a managed Postgres database and wires its
  connection string into `DATABASE_URL`). Data lives in Postgres, so it
  **survives redeploys and free-tier sleep/wake** — this is the fix for
  the "my data disappears" problem that a plain filesystem had.
- **`DATABASE_URL` unset → SQLite** at `DATA_DIR/database.db` (defaults
  to `./database.db`). Zero setup, ideal for local dev. Note: a SQLite
  file on a plain Render web service is ephemeral and gets wiped on
  redeploy — which is exactly why production uses Postgres instead.

> **Render free Postgres caveat:** Render's free Postgres instances are
> time-limited (they expire after ~30 days). For a permanently-free
> option, point `DATABASE_URL` at Neon or Supabase instead — the app
> works with any standard Postgres connection string.

## Run locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py     # uses SQLite unless DATABASE_URL is set
```

Then open http://localhost:3000 — it'll hand you a unique endpoint URL
like `http://localhost:3000/in/ab12cd34ef`. Send it a request:

```bash
curl -X POST http://localhost:3000/in/ab12cd34ef -d '{"hello":"world"}' -H 'Content-Type: application/json'
```

It'll show up in the dashboard within ~2 seconds.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. On Render: **New > Web Service**, connect the repo.
3. Render should auto-detect the included `render.yaml` (a Blueprint that
   provisions both the web service and the Postgres database) — otherwise set:
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn app:app --workers 2 --bind 0.0.0.0:$PORT`
   - and add a Postgres database, wiring its connection string into `DATABASE_URL`.
4. Deploy. Your dashboard will be live at the Render URL, and your
   catch-all endpoint will be `https://<your-app>.onrender.com/in/<binId>`.

### CORS toggle

When enabled (default), any request to `/in/:binId/*` gets:

```
Access-Control-Allow-Origin: <request origin, or *>
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: <requested headers, or *>
Access-Control-Allow-Credentials: true
```

and `OPTIONS` preflight requests get an automatic `204`. This is handy if
you want to fire fetch()/XHR requests directly from browser JS at your
catcher without the browser blocking the response. Turn it off if you
want to see how a strict client behaves without CORS.
