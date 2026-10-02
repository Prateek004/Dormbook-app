'use strict';
/**
 * Off-site copies in Cloudflare R2 (see services/r2.js).
 *
 * The /data volume is always the main copy. These functions add a second copy
 * in R2 and, if a file ever goes missing from the volume, bring it back from R2.
 * Every function here is "best effort": it logs problems and never throws, so
 * a slow or broken R2 can never stop a check-in, an upload or a backup.
 */
const fs = require('fs');
const path = require('path');
const r2 = require('./r2');
const { encryptBuffer } = require('./encryption');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const clean = (s) => String(s || '').replace(/[^a-zA-Z0-9-]/g, '');

/** R2 key for a resident document — built only from database ids, never from a stored path. */
function docKey(doc) {
  return `docs/${clean(doc.property_id)}/${clean(doc.resident_id)}/${clean(doc.id)}.${EXT[doc.mime_type] || 'bin'}.enc`;
}

/** Upload an (already encrypted) document in the background. */
function uploadDocLater(doc, encrypted) {
  if (!r2.enabled()) return;
  r2.putObject(docKey(doc), encrypted)
    .then(() => console.log(`[R2] Document ${doc.id} copied off-site`))
    .catch((e) => console.error(`[R2] Document ${doc.id} not copied yet (nightly sync will retry):`, e.message));
}

/** Encrypted bytes of a document from R2, or null. Never throws. */
async function fetchDoc(doc) {
  if (!r2.enabled()) return null;
  try { return await r2.getObject(docKey(doc), { timeoutMs: 15000 }); }
  catch (e) { console.error(`[R2] Could not fetch document ${doc.id}:`, e.message); return null; }
}

function deleteDocLater(doc) {
  if (!r2.enabled()) return;
  r2.deleteObject(docKey(doc)).catch((e) => console.error(`[R2] Could not delete document ${doc.id}:`, e.message));
}

/** Remove every R2 document of a property (used when an account is deleted). Background, never throws. */
function deletePropertyDocsLater(propertyId) {
  if (!r2.enabled()) return;
  const prefix = `docs/${clean(propertyId)}/`;
  if (prefix === 'docs//') return;
  (async () => {
    const items = await r2.listObjects(prefix, { max: 100000 });
    for (const o of items) await r2.deleteObject(o.key).catch(() => {});
    if (items.length) console.log(`[R2] Removed ${items.length} document(s) of deleted property ${propertyId}`);
  })().catch((e) => console.error(`[R2] Could not remove documents of property ${propertyId}:`, e.message));
}

/**
 * Make sure every document on the volume also exists in R2 (newest first, `limit` per run).
 * Runs on boot and every night, so uploads that failed earlier are retried.
 */
let syncing = false;
async function syncDocs(db, { limit = 500 } = {}) {
  if (!r2.enabled() || syncing) return { checked: 0, uploaded: 0, failed: 0 };
  syncing = true;
  let checked = 0, uploaded = 0, failed = 0;
  try {
    const existing = new Set((await r2.listObjects('docs/', { max: 100000 })).map((o) => o.key));
    const rows = db.prepare('SELECT id, resident_id, property_id, mime_type, file_path FROM resident_documents ORDER BY created_at DESC').all();
    for (const doc of rows) {
      if (uploaded + failed >= limit) break;
      checked++;
      const key = docKey(doc);
      if (existing.has(key)) continue;
      let buf;
      try { buf = fs.readFileSync(doc.file_path); } catch (_) { continue; } // not on the volume — nothing to copy
      try { await r2.putObject(key, buf); uploaded++; } catch (e) { failed++; console.error(`[R2] Sync of document ${doc.id} failed:`, e.message); }
    }
    if (uploaded || failed) console.log(`[R2] Document sync: ${uploaded} copied, ${failed} failed, ${checked} checked`);
  } catch (e) {
    console.error('[R2] Document sync skipped:', e.message);
  } finally {
    syncing = false;
  }
  return { checked, uploaded, failed };
}

/**
 * Upload a database backup file to R2, encrypted with AES_256_KEY, then keep
 * only the newest R2_BACKUP_KEEP (default 30) of that kind. Never throws.
 */
async function uploadBackup(file, kind) {
  if (!r2.enabled() || !file) return false;
  try {
    const size = fs.statSync(file).size;
    if (size > 400 * 1024 * 1024) { console.warn(`[R2] Backup ${path.basename(file)} is ${Math.round(size / 1048576)} MB — too big to upload in one go, skipped`); return false; }
    const key = `backups/${path.basename(file)}.enc`;
    await r2.putObject(key, encryptBuffer(fs.readFileSync(file)), 'application/octet-stream', { timeoutMs: 5 * 60 * 1000 });
    console.log(`[R2] Backup ${path.basename(file)} copied off-site`);
    const keep = Math.max(3, Math.min(365, Number(process.env.R2_BACKUP_KEEP) || 30));
    const mine = (await r2.listObjects('backups/')).map((o) => o.key)
      .filter((k) => k.startsWith('backups/dormbook-') && k.endsWith(`-${kind}.db.enc`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - keep))) {
      await r2.deleteObject(old).catch(() => {});
    }
    return true;
  } catch (e) {
    console.error(`[R2] Backup ${path.basename(String(file))} NOT copied off-site:`, e.message, '(local copy is safe)');
    return false;
  }
}

module.exports = { docKey, uploadDocLater, fetchDoc, deleteDocLater, deletePropertyDocsLater, syncDocs, uploadBackup };
