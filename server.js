const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

function shortId() {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

// --- Static dashboard ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Capture ANY request under /in/:binId (and any sub-path) ---
// Raw body parser so we can accept literally any content-type without choking.
app.use('/in/:binId', express.raw({ type: '*/*', limit: '10mb' }));

app.all(['/in/:binId', '/in/:binId/*'], (req, res) => {
  const { binId } = req.params;
  const bin = db.getOrCreateBin(binId);

  if (bin.cors) {
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.set('Access-Control-Allow-Credentials', 'true');
  }

  // Preflight: short-circuit, don't log it as a "real" request.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  let bodyText = null;
  let bodyBase64 = null;
  if (buf && buf.length) {
    bodyBase64 = buf.toString('base64');
    bodyText = buf.toString('utf8');
  }

  const subPath = req.originalUrl.slice(`/in/${binId}`.length).split('?')[0] || '/';

  const entry = {
    id: randomUUID(),
    method: req.method,
    path: subPath,
    query: req.query,
    headers: req.headers,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null,
    contentType: req.headers['content-type'] || null,
    bodyText,
    bodyBase64,
    bodySize: buf ? buf.length : 0,
    timestamp: new Date().toISOString(),
  };

  db.saveRequest(binId, entry);

  res.status(200).json({ ok: true, captured: entry.id });
});

// --- Dashboard API ---

app.get('/api/new-bin', (req, res) => {
  const binId = shortId();
  db.getOrCreateBin(binId);
  res.json({ binId });
});

app.get('/api/bins/:binId', (req, res) => {
  const bin = db.getOrCreateBin(req.params.binId);
  const requests = db.getRequests(req.params.binId);
  res.json({ cors: !!bin.cors, createdAt: bin.created_at, requests });
});

app.post('/api/bins/:binId/cors', express.json(), (req, res) => {
  db.setCors(req.params.binId, !!req.body.enabled);
  res.json({ cors: !!req.body.enabled });
});

app.delete('/api/bins/:binId/requests', (req, res) => {
  db.clearRequests(req.params.binId);
  res.json({ ok: true });
});

// Manual export/download — a JSON snapshot of everything captured so far.
app.get('/api/bins/:binId/export', (req, res) => {
  const { binId } = req.params;
  const bin = db.getOrCreateBin(binId);
  const requests = db.getRequests(binId);
  const payload = {
    binId,
    createdAt: bin.created_at,
    exportedAt: new Date().toISOString(),
    corsEnabled: !!bin.cors,
    requestCount: requests.length,
    requests,
  };
  res.set('Content-Disposition', `attachment; filename="hookcatch-${binId}-${Date.now()}.json"`);
  res.set('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
});

app.listen(PORT, () => {
  console.log(`Webhook catcher listening on port ${PORT}`);
  console.log(`Persisting requests to ${db.DATA_DIR}`);
});
