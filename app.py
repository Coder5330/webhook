import base64
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory, Response

# --- Storage backend selection ---
# If DATABASE_URL is set (e.g. Render Postgres), use Postgres. Otherwise fall
# back to a local SQLite file so the app runs locally with zero setup.
DATABASE_URL = os.environ.get("DATABASE_URL")
IS_PG = bool(DATABASE_URL)

if IS_PG and DATABASE_URL.startswith("postgres://"):
    # psycopg wants the postgresql:// scheme; Render hands out postgres://.
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

# SQLite (local fallback) file location.
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "database.db")

MAX_REQUESTS_PER_BIN = 300
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

app = Flask(__name__)


# --- Database helpers -------------------------------------------------------
# One small dialect shim keeps a single set of queries working on both engines:
#   * "?" placeholders are rewritten to "%s" for Postgres.
#   * The auto-increment column type differs between the two schemas.

def sql(query):
    return query.replace("?", "%s") if IS_PG else query


def connect():
    if IS_PG:
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def get_db():
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = connect()
    return db


@app.teardown_appcontext
def close_db(exc):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def init_db():
    serial = "BIGSERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    statements = [
        """
        CREATE TABLE IF NOT EXISTS bins (
            id          TEXT PRIMARY KEY,
            cors        INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL
        )
        """,
        f"""
        CREATE TABLE IF NOT EXISTS requests (
            seq          {serial},
            id           TEXT NOT NULL,
            bin_id       TEXT NOT NULL,
            method       TEXT,
            path         TEXT,
            query        TEXT,
            headers      TEXT,
            ip           TEXT,
            content_type TEXT,
            body_text    TEXT,
            body_base64  TEXT,
            body_size    INTEGER NOT NULL DEFAULT 0,
            timestamp    TEXT NOT NULL,
            FOREIGN KEY (bin_id) REFERENCES bins(id) ON DELETE CASCADE
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_requests_bin ON requests(bin_id, seq DESC)",
    ]
    conn = connect()
    try:
        for stmt in statements:
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def short_id():
    return uuid.uuid4().hex[:10]


def get_or_create_bin(bin_id):
    db = get_db()
    row = db.execute(sql("SELECT * FROM bins WHERE id = ?"), (bin_id,)).fetchone()
    if row is None:
        created = now_iso()
        db.execute(
            sql("INSERT INTO bins (id, cors, created_at) VALUES (?, 1, ?)"),
            (bin_id, created),
        )
        db.commit()
        return {"id": bin_id, "cors": 1, "created_at": created}
    return {"id": row["id"], "cors": row["cors"], "created_at": row["created_at"]}


def set_cors(bin_id, enabled):
    get_or_create_bin(bin_id)
    db = get_db()
    db.execute(sql("UPDATE bins SET cors = ? WHERE id = ?"), (1 if enabled else 0, bin_id))
    db.commit()


def row_to_entry(row):
    return {
        "id": row["id"],
        "method": row["method"],
        "path": row["path"],
        "query": json.loads(row["query"]) if row["query"] else {},
        "headers": json.loads(row["headers"]) if row["headers"] else {},
        "ip": row["ip"],
        "contentType": row["content_type"],
        "bodyText": row["body_text"],
        "bodyBase64": row["body_base64"],
        "bodySize": row["body_size"],
        "timestamp": row["timestamp"],
    }


def save_request(bin_id, entry):
    get_or_create_bin(bin_id)
    db = get_db()
    db.execute(
        sql(
            """INSERT INTO requests
               (id, bin_id, method, path, query, headers, ip, content_type,
                body_text, body_base64, body_size, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
        ),
        (
            entry["id"],
            bin_id,
            entry["method"],
            entry["path"],
            json.dumps(entry["query"]),
            json.dumps(entry["headers"]),
            entry["ip"],
            entry["contentType"],
            entry["bodyText"],
            entry["bodyBase64"],
            entry["bodySize"],
            entry["timestamp"],
        ),
    )
    # Trim to the newest MAX_REQUESTS_PER_BIN entries for this bin.
    db.execute(
        sql(
            """DELETE FROM requests
               WHERE bin_id = ? AND seq NOT IN (
                   SELECT seq FROM requests WHERE bin_id = ?
                   ORDER BY seq DESC LIMIT ?
               )"""
        ),
        (bin_id, bin_id, MAX_REQUESTS_PER_BIN),
    )
    db.commit()


def get_requests(bin_id, limit=MAX_REQUESTS_PER_BIN):
    get_or_create_bin(bin_id)
    db = get_db()
    rows = db.execute(
        sql("SELECT * FROM requests WHERE bin_id = ? ORDER BY seq DESC LIMIT ?"),
        (bin_id, limit),
    ).fetchall()
    return [row_to_entry(r) for r in rows]


def clear_requests(bin_id):
    get_or_create_bin(bin_id)
    db = get_db()
    db.execute(sql("DELETE FROM requests WHERE bin_id = ?"), (bin_id,))
    db.commit()


# --- Static dashboard -------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


# --- Capture ANY request under /in/<binId> (and any sub-path) ---------------

CAPTURE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


@app.route("/in/<bin_id>", defaults={"sub": ""}, methods=CAPTURE_METHODS)
@app.route("/in/<bin_id>/<path:sub>", methods=CAPTURE_METHODS)
def capture(bin_id, sub):
    bin_ = get_or_create_bin(bin_id)

    resp_headers = {}
    if bin_["cors"]:
        resp_headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
        resp_headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        resp_headers["Access-Control-Allow-Headers"] = request.headers.get(
            "Access-Control-Request-Headers", "*"
        )
        resp_headers["Access-Control-Allow-Credentials"] = "true"

    # Preflight: short-circuit, don't log it as a "real" request.
    if request.method == "OPTIONS":
        return Response(status=204, headers=resp_headers)

    raw = request.get_data() or b""
    body_text = None
    body_base64 = None
    if raw:
        body_base64 = base64.b64encode(raw).decode("ascii")
        body_text = raw.decode("utf-8", errors="replace")

    entry = {
        "id": str(uuid.uuid4()),
        "method": request.method,
        "path": "/" + sub if sub else "/",
        "query": request.args.to_dict(flat=True),
        "headers": dict(request.headers),
        "ip": request.headers.get("X-Forwarded-For") or request.remote_addr,
        "contentType": request.headers.get("Content-Type"),
        "bodyText": body_text,
        "bodyBase64": body_base64,
        "bodySize": len(raw),
        "timestamp": now_iso(),
    }

    save_request(bin_id, entry)

    resp = jsonify({"ok": True, "captured": entry["id"]})
    resp.headers.extend(resp_headers)
    return resp, 200


# --- Dashboard API ----------------------------------------------------------

@app.route("/api/new-bin")
def new_bin():
    bin_id = short_id()
    get_or_create_bin(bin_id)
    return jsonify({"binId": bin_id})


@app.route("/api/bins/<bin_id>")
def get_bin(bin_id):
    bin_ = get_or_create_bin(bin_id)
    return jsonify(
        {
            "cors": bool(bin_["cors"]),
            "createdAt": bin_["created_at"],
            "requests": get_requests(bin_id),
        }
    )


@app.route("/api/bins/<bin_id>/cors", methods=["POST"])
def update_cors(bin_id):
    enabled = bool((request.get_json(silent=True) or {}).get("enabled"))
    set_cors(bin_id, enabled)
    return jsonify({"cors": enabled})


@app.route("/api/bins/<bin_id>/requests", methods=["DELETE"])
def delete_requests(bin_id):
    clear_requests(bin_id)
    return jsonify({"ok": True})


@app.route("/api/bins/<bin_id>/export")
def export_bin(bin_id):
    bin_ = get_or_create_bin(bin_id)
    requests_ = get_requests(bin_id)
    payload = {
        "binId": bin_id,
        "createdAt": bin_["created_at"],
        "exportedAt": now_iso(),
        "corsEnabled": bool(bin_["cors"]),
        "requestCount": len(requests_),
        "requests": requests_,
    }
    stamp = int(datetime.now(timezone.utc).timestamp() * 1000)
    resp = Response(json.dumps(payload, indent=2), mimetype="application/json")
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="hookcatch-{bin_id}-{stamp}.json"'
    )
    return resp


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    print(f"Webhook catcher listening on port {port}")
    print(f"Storage: {'Postgres' if IS_PG else 'SQLite (' + DB_PATH + ')'}")
    print("Ready to capture webhooks...")
    app.run(host="0.0.0.0", port=port)
