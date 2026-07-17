const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB_PATH lets you point this at a Render persistent disk (e.g. /var/data/hookcatch.db).
// Defaults to a local file next to the app, which works fine for local dev but is
// wiped on every Render redeploy unless a disk is mounted there (see README).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'hookcatch.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bins (
    id TEXT PRIMARY KEY,
    cors INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    bin_id TEXT NOT NULL,
    method TEXT,
    path TEXT,
    query TEXT,
    headers TEXT,
    ip TEXT,
    content_type TEXT,
    body_text TEXT,
    body_base64 TEXT,
    body_size INTEGER,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_requests_bin_time
    ON requests (bin_id, timestamp DESC);
`);

const MAX_REQUESTS_PER_BIN = 300;

const stmts = {
  getBin: db.prepare('SELECT * FROM bins WHERE id = ?'),
  insertBin: db.prepare('INSERT INTO bins (id, cors, created_at) VALUES (?, ?, ?)'),
  setCors: db.prepare('UPDATE bins SET cors = ? WHERE id = ?'),

  insertRequest: db.prepare(`
    INSERT INTO requests
      (id, bin_id, method, path, query, headers, ip, content_type, body_text, body_base64, body_size, timestamp)
    VALUES (@id, @bin_id, @method, @path, @query, @headers, @ip, @content_type, @body_text, @body_base64, @body_size, @timestamp)
  `),
  getRequests: db.prepare(`
    SELECT * FROM requests WHERE bin_id = ? ORDER BY timestamp DESC LIMIT ?
  `),
  countRequests: db.prepare('SELECT COUNT(*) AS n FROM requests WHERE bin_id = ?'),
  pruneRequests: db.prepare(`
    DELETE FROM requests WHERE bin_id = ? AND id NOT IN (
      SELECT id FROM requests WHERE bin_id = ? ORDER BY timestamp DESC LIMIT ?
    )
  `),
  clearRequests: db.prepare('DELETE FROM requests WHERE bin_id = ?'),
};

function getOrCreateBin(binId) {
  let bin = stmts.getBin.get(binId);
  if (!bin) {
    const createdAt = new Date().toISOString();
    stmts.insertBin.run(binId, 1, createdAt);
    bin = { id: binId, cors: 1, created_at: createdAt };
  }
  return bin;
}

function setCors(binId, enabled) {
  getOrCreateBin(binId);
  stmts.setCors.run(enabled ? 1 : 0, binId);
}

function saveRequest(binId, entry) {
  getOrCreateBin(binId);
  stmts.insertRequest.run({
    id: entry.id,
    bin_id: binId,
    method: entry.method,
    path: entry.path,
    query: JSON.stringify(entry.query || {}),
    headers: JSON.stringify(entry.headers || {}),
    ip: entry.ip,
    content_type: entry.contentType,
    body_text: entry.bodyText,
    body_base64: entry.bodyBase64,
    body_size: entry.bodySize,
    timestamp: entry.timestamp,
  });
  stmts.pruneRequests.run(binId, binId, MAX_REQUESTS_PER_BIN);
}

function getRequests(binId, limit = MAX_REQUESTS_PER_BIN) {
  const rows = stmts.getRequests.all(binId, limit);
  return rows.map(row => ({
    id: row.id,
    method: row.method,
    path: row.path,
    query: JSON.parse(row.query || '{}'),
    headers: JSON.parse(row.headers || '{}'),
    ip: row.ip,
    contentType: row.content_type,
    bodyText: row.body_text,
    bodyBase64: row.body_base64,
    bodySize: row.body_size,
    timestamp: row.timestamp,
  }));
}

function clearRequests(binId) {
  stmts.clearRequests.run(binId);
}

module.exports = {
  getOrCreateBin,
  setCors,
  saveRequest,
  getRequests,
  clearRequests,
  DB_PATH,
};
