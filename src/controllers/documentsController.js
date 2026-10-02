'use strict';
/**
 * Resident ID documents (photo / scan of Aadhaar, DL, passport, ...).
 * Sent as a base64 data URL (the app shrinks photos before upload), stored
 * encrypted on the /data volume, and only readable by users with the
 * 'view_id_docs' permission. Every view is written to document_access_log.
 * If Cloudflare R2 is set up, the same encrypted file is also copied to R2,
 * and a file missing from the volume is brought back from R2 automatically.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { encryptBuffer, decryptBuffer } = require('../services/encryption');
const { writeAudit, logDocumentAccess } = require('../middleware/auditLog');
const offsite = require('../services/offsite');

const DOC_TYPES = ['id_front', 'id_back', 'photo', 'other'];
const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_BYTES = 1500 * 1024;   // after the app's compression a phone photo is ~200–400 KB
const MAX_PER_RESIDENT = 10;

function uploadRoot() {
  const base = process.env.DB_DIR || '/data';
  return path.resolve(base, 'uploads');
}

/** What the file really is, from its first bytes. Only these four kinds are ever accepted. */
function sniffType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** A stored path is used only if it is inside the uploads folder (never follow a path out of it). */
function insideUploads(file) {
  const root = uploadRoot();
  const full = path.resolve(String(file || ''));
  return full.startsWith(root + path.sep);
}

function uploadDocument(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const resident = db.prepare('SELECT id FROM residents WHERE id = ? AND property_id = ?').get(req.params.id, propertyId);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });

  const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(req.body.data_url || ''));
  if (!m || !MIME[m[1]]) return res.status(400).json({ error: 'Upload a photo (JPG/PNG) or a PDF' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return res.status(400).json({ error: 'The file is empty' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'File is too large (max 1.5 MB). Take the photo again or use a smaller PDF.' });
  // Check the file really is what it claims to be (its first bytes), not just the name/type it was sent with.
  if (sniffType(buf) !== m[1]) return res.status(400).json({ error: 'The file content does not match its type' });

  const count = db.prepare('SELECT COUNT(*) n FROM resident_documents WHERE resident_id = ?').get(resident.id).n;
  if (count >= MAX_PER_RESIDENT) return res.status(409).json({ error: `A resident can have at most ${MAX_PER_RESIDENT} documents` });

  const id = uuidv4();
  const dir = path.join(uploadRoot(), propertyId.replace(/[^a-zA-Z0-9-]/g, ''), resident.id.replace(/[^a-zA-Z0-9-]/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.${MIME[m[1]]}.enc`);
  const encrypted = encryptBuffer(buf);
  fs.writeFileSync(file, encrypted, { mode: 0o600 });
  try {
    db.prepare(`INSERT INTO resident_documents (id, resident_id, property_id, doc_type, mime_type, size_bytes, file_path, uploaded_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, resident.id, propertyId, docType, m[1], buf.length, file, req.user.id, new Date().toISOString());
  } catch (e) {
    fs.rmSync(file, { force: true }); // never leave an orphan file
    throw e;
  }
  // Off-site copy in R2 — in the background, so the user never waits for it.
  offsite.uploadDocLater({ id, resident_id: resident.id, property_id: propertyId, mime_type: m[1] }, encrypted);
  writeAudit({ propertyId, userId: req.user.id, action: 'ID_DOCUMENT_UPLOADED', entityType: 'residents',
    entityId: resident.id, snapshot: { doc_type: docType, size: buf.length }, ip: req.ip });
  return res.status(201).json({ id, doc_type: docType, mime_type: m[1], size_bytes: buf.length });
}

function listDocuments(req, res) {
  const db = getDb();
  const rows = db.prepare(`SELECT id, doc_type, mime_type, size_bytes, created_at FROM resident_documents
    WHERE resident_id = ? AND property_id = ? ORDER BY created_at`).all(req.params.id, req.user.property_id);
  return res.json(rows);
}

/** Where a document's file should be on the volume (built from ids only). */
function canonicalPath(doc) {
  return path.join(uploadRoot(), String(doc.property_id).replace(/[^a-zA-Z0-9-]/g, ''),
    String(doc.resident_id).replace(/[^a-zA-Z0-9-]/g, ''), `${String(doc.id).replace(/[^a-zA-Z0-9-]/g, '')}.${MIME[doc.mime_type] || 'bin'}.enc`);
}

async function getDocument(req, res, next) {
  try {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM resident_documents WHERE id = ? AND resident_id = ? AND property_id = ?')
      .get(req.params.docId, req.params.id, req.user.property_id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    let data;
    try {
      if (!insideUploads(doc.file_path)) throw new Error('stored path is outside the uploads folder');
      data = decryptBuffer(fs.readFileSync(doc.file_path));
    } catch (e) {
      console.error('[DOCS] cannot read from volume', doc.id, e.message);
      // Self-heal: bring the file back from the R2 copy (and put it back on the volume).
      const encrypted = await offsite.fetchDoc(doc);
      if (encrypted) {
        try {
          data = decryptBuffer(encrypted);
          const target = canonicalPath(doc);
          if (path.resolve(doc.file_path) === target && insideUploads(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, encrypted, { mode: 0o600 });
            console.log(`[DOCS] Restored ${doc.id} from R2`);
          }
        } catch (e2) {
          console.error('[DOCS] R2 copy unusable', doc.id, e2.message);
          data = null;
        }
      }
      if (!data) return res.status(410).json({ error: 'This file is no longer available on the server' });
    }
    if (res.headersSent) return;
    try { logDocumentAccess(db, { residentId: doc.resident_id, accessedBy: req.user.id, documentType: 'id_document', ip: req.ip }); }
    catch (e) { console.error('[AUDIT] document access log failed:', e.message); }
    // Served as a plain file that can never run as a web page or script.
    const type = MIME[doc.mime_type] ? doc.mime_type : 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="id-document.${MIME[type] || 'bin'}"`);
    return res.send(data);
  } catch (err) {
    return next(err);
  }
}

function deleteDocument(req, res) {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM resident_documents WHERE id = ? AND resident_id = ? AND property_id = ?')
    .get(req.params.docId, req.params.id, req.user.property_id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  db.prepare('DELETE FROM resident_documents WHERE id = ?').run(doc.id);
  if (insideUploads(doc.file_path)) fs.rmSync(doc.file_path, { force: true });
  offsite.deleteDocLater(doc);
  writeAudit({ propertyId: req.user.property_id, userId: req.user.id, action: 'ID_DOCUMENT_DELETED', entityType: 'residents',
    entityId: doc.resident_id, snapshot: { doc_type: doc.doc_type }, ip: req.ip });
  return res.json({ message: 'Document deleted' });
}

module.exports = { uploadDocument, listDocuments, getDocument, deleteDocument, DOC_TYPES, sniffType };
