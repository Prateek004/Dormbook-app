'use strict';
/**
 * Cloudflare R2 storage (S3-compatible) — no extra npm package needed.
 *
 * What goes to R2:
 *   - Resident ID documents (already AES-encrypted, same bytes as on the volume)   docs/<property>/<resident>/<doc>.<ext>.enc
 *   - Database backups (encrypted with AES_256_KEY before upload)                  backups/dormbook-<IST time>-<kind>.db.enc
 *
 * Safety rules:
 *   - R2 is an EXTRA copy. The /data volume stays the main copy, so the app works
 *     exactly as before if R2 is not set up, slow, or down.
 *   - Every call has a timeout and retries; nothing here can crash the server.
 *   - Keys/secrets are never logged.
 *
 * Railway variables (all four needed, otherwise R2 is simply OFF):
 *   R2_ACCOUNT_ID         9c8b3a2ba6fd0705bc27855ea12f7b0a
 *   R2_ACCESS_KEY_ID      from Cloudflare → R2 → Manage API tokens
 *   R2_SECRET_ACCESS_KEY  shown once when the token is created
 *   R2_BUCKET             e.g. dormbook-files
 * Optional:
 *   R2_ENDPOINT           default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
 *   R2_BACKUP_KEEP        how many backups of each kind to keep in R2 (default 30)
 */
const crypto = require('crypto');

const REGION = 'auto';
const SERVICE = 's3';

function cfg() {
  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = String(process.env.R2_BUCKET || '').trim();
  let endpoint = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (!endpoint && accountId) endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  return { accessKeyId, secretAccessKey, bucket, endpoint };
}

/** True only when every needed setting is present and looks right. */
function enabled() {
  const c = cfg();
  return !!(c.accessKeyId && c.secretAccessKey && c.endpoint && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket)
    && /^https?:\/\//.test(c.endpoint));
}

// ── AWS Signature V4 ─────────────────────────────────────────────────────────
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

/** Only simple, safe object keys are ever used (letters, digits, - _ . /). */
function safeKey(key) {
  const k = String(key || '');
  if (!k || k.length > 512 || !/^[A-Za-z0-9._\-/]+$/.test(k) || k.includes('..') || k.startsWith('/')) {
    throw new Error('R2: invalid object key');
  }
  return k;
}

function sign({ method, key = '', query = {}, headers = {}, payloadHash, now = new Date() }) {
  const c = cfg();
  const url = new URL(c.endpoint);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');           // 20261003T101500Z
  const day = amzDate.slice(0, 8);
  const basePath = url.pathname.replace(/\/+$/, '');
  const canonicalUri = `${basePath}/${rfc3986(c.bucket)}${key ? '/' + key.split('/').map(rfc3986).join('/') : ''}`;
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`).join('&');
  const all = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), REGION), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const out = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  return { url: `${url.origin}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`, headers: out };
}

// ── One request with timeout + retries ───────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, key, { body, query, headers = {}, timeoutMs = 20000, tries = 3 } = {}) {
  if (!enabled()) throw new Error('R2 is not configured');
  const k = key ? safeKey(key) : '';
  const payload = body ? Buffer.from(body) : Buffer.alloc(0);
  const payloadHash = sha256hex(payload);
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const s = sign({ method, key: k, query, headers, payloadHash });   // fresh date on every try
      const res = await fetch(s.url, { method, headers: s.headers, body: payload.length ? payload : undefined,
        signal: AbortSignal.timeout(timeoutMs) });
      // 5xx / 429 are temporary → retry. Everything else is the final answer.
      if ((res.status >= 500 || res.status === 429) && attempt < tries) {
        await res.arrayBuffer().catch(() => {});
        lastErr = new Error(`R2 ${method} HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;   // network error / timeout → retry
    }
    await sleep(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
  }
  throw lastErr || new Error(`R2 ${method} failed`);
}

async function failText(res) {
  const t = await res.text().catch(() => '');
  const code = (/<Code>([^<]+)<\/Code>/.exec(t) || [])[1];
  return `HTTP ${res.status}${code ? ` ${code}` : ''}`;
}

// ── Public API ───────────────────────────────────────────────────────────────
async function putObject(key, buf, contentType = 'application/octet-stream', opts = {}) {
  const res = await request('PUT', key, { body: buf, headers: { 'content-type': contentType }, ...opts });
  if (!res.ok) throw new Error(`R2 upload failed: ${await failText(res)}`);
  await res.arrayBuffer().catch(() => {});
  return true;
}

/** Returns the object's bytes, or null if it does not exist. */
async function getObject(key, opts = {}) {
  const res = await request('GET', key, opts);
  if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
  if (!res.ok) throw new Error(`R2 download failed: ${await failText(res)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function headObject(key, opts = {}) {
  const res = await request('HEAD', key, opts);
  await res.arrayBuffer().catch(() => {});
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`R2 check failed: HTTP ${res.status}`);
  return true;
}

async function deleteObject(key, opts = {}) {
  const res = await request('DELETE', key, opts);
  await res.arrayBuffer().catch(() => {});
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: HTTP ${res.status}`);
  return true;
}

/** All keys under a prefix (pages through results). [{ key, size, lastModified }] */
async function listObjects(prefix = '', { max = 5000 } = {}) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', 'max-keys': '1000', prefix };
    if (token) query['continuation-token'] = token;
    const res = await request('GET', '', { query });
    const xml = await res.text();
    if (!res.ok) throw new Error(`R2 list failed: HTTP ${res.status}`);
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = (/<Key>([^<]*)<\/Key>/.exec(m[1]) || [])[1];
      if (!key) continue;
      out.push({ key: key.replace(/&amp;/g, '&'), size: Number((/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1] || 0),
        lastModified: (/<LastModified>([^<]*)<\/LastModified>/.exec(m[1]) || [])[1] || null });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml) || [])[1] : null;
  } while (token && out.length < max);
  return out;
}

/** Quick connection test for the boot log. Never throws. */
async function check() {
  if (!enabled()) {
    const anySet = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].some((k) => process.env[k]);
    if (anySet) console.warn('[R2] Some R2 variables are set but not all (need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET). R2 is OFF.');
    return { ok: false, enabled: false };
  }
  try {
    const res = await request('GET', '', { query: { 'list-type': '2', 'max-keys': '1' }, tries: 2, timeoutMs: 10000 });
    if (!res.ok) {
      const why = await failText(res);
      console.error(`[R2] Cannot reach bucket "${cfg().bucket}" (${why}). Check the bucket name and API token permissions (Object Read & Write). Files stay safe on the volume.`);
      return { ok: false, enabled: true, error: why };
    }
    await res.arrayBuffer().catch(() => {});
    console.log(`[R2] Connected — bucket "${cfg().bucket}". ID documents and backups get an off-site copy.`);
    return { ok: true, enabled: true };
  } catch (e) {
    console.error('[R2] Connection test failed:', e.message, '— files stay safe on the volume.');
    return { ok: false, enabled: true, error: e.message };
  }
}

module.exports = { enabled, putObject, getObject, headObject, deleteObject, listObjects, check, sign, _cfg: cfg };
