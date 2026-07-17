const path = require('path');
const fs = require('fs');

// DATA_DIR lets you point this at a Render persistent disk (e.g. /var/data).
// Defaults to a local folder next to the app, which works fine for local dev
// but is wiped on every Render redeploy unless a disk is mounted there
// (see README). Plain JSON files on disk — no native compilation, nothing
// to break across Node versions.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BINS_DIR = path.join(DATA_DIR, 'bins');

fs.mkdirSync(BINS_DIR, { recursive: true });

const MAX_REQUESTS_PER_BIN = 300;

function binPath(binId) {
  // binId is always our own generated short hex id, but guard against
  // path traversal regardless since it comes from the URL.
  const safe = String(binId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(BINS_DIR, `${safe}.json`);
}

function readBinFile(binId) {
  const file = binPath(binId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read/parse bin ${binId}:`, e.message);
    return null;
  }
}

function writeBinFile(binId, data) {
  const file = binPath(binId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // atomic on same filesystem
}

function getOrCreateBin(binId) {
  let bin = readBinFile(binId);
  if (!bin) {
    bin = { id: binId, cors: 1, created_at: new Date().toISOString(), requests: [] };
    writeBinFile(binId, bin);
  }
  return bin;
}

function setCors(binId, enabled) {
  const bin = getOrCreateBin(binId);
  bin.cors = enabled ? 1 : 0;
  writeBinFile(binId, bin);
}

function saveRequest(binId, entry) {
  const bin = getOrCreateBin(binId);
  bin.requests.unshift(entry);
  if (bin.requests.length > MAX_REQUESTS_PER_BIN) {
    bin.requests = bin.requests.slice(0, MAX_REQUESTS_PER_BIN);
  }
  writeBinFile(binId, bin);
}

function getRequests(binId, limit = MAX_REQUESTS_PER_BIN) {
  const bin = getOrCreateBin(binId);
  return bin.requests.slice(0, limit);
}

function clearRequests(binId) {
  const bin = getOrCreateBin(binId);
  bin.requests = [];
  writeBinFile(binId, bin);
}

module.exports = {
  getOrCreateBin,
  setCors,
  saveRequest,
  getRequests,
  clearRequests,
  DATA_DIR,
};
