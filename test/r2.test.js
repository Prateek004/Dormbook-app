'use strict';
// Cloudflare R2 off-site copies + Cloudflare real-IP — tested against a local fake R2 (S3 API).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

/** A tiny S3-compatible server: PUT/GET/HEAD/DELETE objects + ListObjectsV2. Requires a SigV4 header. */
function fakeR2({ failPuts = 0 } = {}) {
  const store = new Map();
  const log = [];
  let putFailures = failPuts;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      log.push(`${req.method} ${u.pathname}`);
      if (!/^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) {
        res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>');
      }
      const [, bucket, ...rest] = u.pathname.split('/');
      if (bucket !== 'dormbook-test') { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
      const key = rest.map(decodeURIComponent).join('/');
      if (!key && req.method === 'GET') {
        const prefix = u.searchParams.get('prefix') || '';
        const items = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.map((k) =>
          `<Contents><Key>${k}</Key><Size>${store.get(k).length}</Size><LastModified>2026-10-03T00:00:00Z</LastModified></Contents>`).join('')}</ListBucketResult>`);
      }
      if (req.method === 'PUT') {
        if (putFailures > 0) { putFailures--; res.writeHead(503); return res.end(); }
        store.set(key, Buffer.concat(chunks)); res.writeHead(200); return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!store.has(key)) { res.writeHead(404); return res.end(); }
        res.writeHead(200); return res.end(req.method === 'GET' ? store.get(key) : undefined);
      }
      if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
      res.writeHead(400); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, store, log, port: server.address().port })));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(100); }
  return false;
}

test('ID documents and backups get an R2 copy; a lost file comes back from R2', async () => {
  const r2 = await fakeR2({ failPuts: 1 });   // first upload fails once → retry must still succeed
  Object.assign(process.env, { R2_ACCOUNT_ID: '9c8b3a2ba6fd0705bc27855ea12f7b0a', R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret', R2_BUCKET: 'dormbook-test', R2_ENDPOINT: `http://127.0.0.1:${r2.port}`,
    R2_BACKUP_DELAY_MS: '50' });
  const { boot } = require('./helpers');
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-r2-'));
  const s = await boot({ dbDir, port: 21000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    assert.ok(await until(() => s.logs.join('').includes('[R2] Connected')), 'boot log confirms R2: ' + s.logs.join(''));

    let r = await call('POST', '/auth/register', { business_name: 'Cloud PG', owner_name: 'Amit', mobile: '9876511111',
      password: 'Passw0rd!23', pg_name: 'Cloud Dorm', city: 'Delhi' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    await call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 1, beds_per_bunker: 2, daily_rate_paise: 40000 });
    const bed = (await call('GET', '/beds?status=available')).body[0];
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000022222', bed_id: bed.id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 2), id_consent: true, rate_type: 'daily', rate_paise: 40000, id_type: 'pan', id_number: 'abcde1234f' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const guest = r.body.resident.id;

    // Upload → stored on the volume AND (in the background) in R2, encrypted
    r = await call('POST', `/residents/${guest}/documents`, { doc_type: 'id_front', data_url: JPEG });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const docId = r.body.id;
    assert.ok(await until(() => [...r2.store.keys()].some((k) => k.startsWith('docs/') && k.includes(docId))), 'document copied to R2');
    const key = [...r2.store.keys()].find((k) => k.includes(docId));
    assert.match(key, /^docs\/[a-f0-9-]+\/[a-f0-9-]+\/[a-f0-9-]+\.jpg\.enc$/);
    assert.notEqual(r2.store.get(key).subarray(0, 2).toString('hex'), 'ffd8', 'R2 copy is encrypted');

    // Volume loses the file → app brings it back from R2 and serves it
    const stored = fs.readdirSync(path.join(dbDir, 'uploads'), { recursive: true }).find((f) => String(f).endsWith('.enc'));
    fs.rmSync(path.join(dbDir, 'uploads', stored));
    const url = `http://127.0.0.1:${s.port}/api/v1/residents/${guest}/documents/${docId}`;
    let res = await fetch(url, { headers: { authorization: `Bearer ${s.token()}` } });
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString('hex'), 'ffd8', 'decrypted JPEG from R2');
    assert.ok(fs.existsSync(path.join(dbDir, 'uploads', stored)), 'file put back on the volume');

    // Gone from both → clear 410, no crash
    fs.rmSync(path.join(dbDir, 'uploads', stored)); r2.store.delete(key);
    res = await fetch(url, { headers: { authorization: `Bearer ${s.token()}` } });
    assert.equal(res.status, 410);

    // Delete removes the R2 copy too
    r = await call('POST', `/residents/${guest}/documents`, { doc_type: 'id_back', data_url: JPEG });
    const doc2 = r.body.id;
    assert.ok(await until(() => [...r2.store.keys()].some((k) => k.includes(doc2))));
    r = await call('DELETE', `/residents/${guest}/documents/${doc2}`);
    assert.equal(r.status, 200);
    assert.ok(await until(() => ![...r2.store.keys()].some((k) => k.includes(doc2))), 'R2 copy deleted');

    // Health still fine; the app never depended on R2 being up
    r2.server.close();
    r = await call('POST', `/residents/${guest}/documents`, { doc_type: 'photo', data_url: JPEG });
    assert.equal(r.status, 201, 'upload still works while R2 is down');
  } finally {
    s.stop(); r2.server.close();
  }
});

test('database backup is encrypted, uploaded to R2 and restorable', async () => {
  const r2mock = await fakeR2();
  Object.assign(process.env, { R2_ACCOUNT_ID: 'x', R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET: 'dormbook-test', R2_ENDPOINT: `http://127.0.0.1:${r2mock.port}`, R2_BACKUP_DELAY_MS: '20' });
  const Database = require('better-sqlite3');
  const { backupDb } = require('../src/db/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-bk-'));
  const dbPath = path.join(dir, 'dormbook.db');
  const db = new Database(dbPath);
  db.exec("CREATE TABLE users (id TEXT); INSERT INTO users VALUES ('u1');");
  try {
    const file = backupDb(db, dbPath, 'daily');
    assert.ok(file);
    assert.ok(await until(() => [...r2mock.store.keys()].some((k) => k === `backups/${path.basename(file)}.enc`)), 'backup in R2');
    const enc = r2mock.store.get(`backups/${path.basename(file)}.enc`);
    assert.notEqual(enc.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'encrypted in R2');
    const { decryptBuffer } = require('../src/services/encryption');
    assert.equal(decryptBuffer(enc).subarray(0, 15).toString('latin1'), 'SQLite format 3', 'decrypts to a real database');
  } finally {
    db.close(); r2mock.server.close();
  }
});

test('real visitor IP is used only for requests that really come from Cloudflare', () => {
  const { cloudflareRealIp, isCloudflare } = require('../src/middleware/cloudflare');
  assert.ok(isCloudflare('172.70.1.2'));
  assert.ok(isCloudflare('::ffff:162.158.10.1'));
  assert.ok(isCloudflare('2606:4700:10::1'));
  assert.ok(!isCloudflare('49.36.1.2'));
  const run = (ip, h) => { const req = { ip, headers: h }; cloudflareRealIp(req, {}, () => {}); return req.ip; };
  assert.equal(run('172.70.1.2', { 'cf-connecting-ip': '49.36.10.20' }), '49.36.10.20', 'via Cloudflare → real IP');
  assert.equal(run('49.36.1.2', { 'cf-connecting-ip': '1.1.1.1' }), '49.36.1.2', 'fake header from a non-Cloudflare IP is ignored');
  assert.equal(run('172.70.1.2', { 'cf-connecting-ip': 'not-an-ip' }), '172.70.1.2', 'junk header ignored');
  assert.equal(run('172.70.1.2', {}), '172.70.1.2');
});
