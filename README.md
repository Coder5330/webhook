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

Storage is **SQLite** (via `better-sqlite3`), written to the file at
`DB_PATH` (defaults to `./data/hookcatch.db`). Each bin keeps its most
recent 300 requests. There's also an **Export** button in the dashboard
that downloads the full log for a bin as a JSON file at any time.

### About persistence on Render specifically

- A plain web service on Render has an **ephemeral filesystem** — it
  survives normal restarts (crashes, sleep/wake on the free tier) but
  gets wiped on every new deploy.
- To survive redeploys too, attach a **Render Disk** (Starter plan or
  above) and point `DB_PATH` at a file inside its mount path. The
  included `render.yaml` already does this: it mounts a 1GB disk at
  `/var/data` and sets `DB_PATH=/var/data/hookcatch.db`.
- On the **free plan** (no disks), just delete the `disk:` block from
  `render.yaml` — your data will still survive normal restarts, just not
  redeploys. Use the Export button before redeploying if you want to keep
  a copy.
- If you'd rather use a real hosted database (e.g. because you're
  scaling to multiple instances), swap `db.js` for Postgres — Render's
  managed Postgres works well here and Render's free Postgres tier is
  time-limited, so check current pricing before committing.

## Run locally

```bash
npm install
npm start
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
3. Render should auto-detect the included `render.yaml` — otherwise set:
   - Build command: `npm install`
   - Start command: `npm start`
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
