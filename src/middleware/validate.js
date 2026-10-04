'use strict';
/**
 * Input validation — runs before every API route.
 *
 * 1. Strict schemas for the sign-in routes (the ones strangers can reach): every field has a
 *    type, a length and a format; unknown fields are refused. Nothing is "cleaned up" — a
 *    request that does not match gets 400.
 * 2. A shape guard for every other request (the business screens keep their own field checks
 *    in each controller on top of this):
 *      - only plain JSON values (text, number, true/false, null, lists, objects)
 *      - no keys like __proto__ / constructor / prototype (prototype pollution)
 *      - no NUL characters, no text over the size limit, no numbers out of range
 *      - not too deep, not too many values
 *      - query values are single short texts; URL ids use safe characters only
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 8;
const MAX_NODES = 50000;             // bed layout saves can hold ~2000 rows
const MAX_TEXT = 20000;              // notes, rules, addresses
const MAX_FILE_TEXT = 3 * 1024 * 1024; // base64 photos (ID proof) — body limit is 3 MB anyway
const FILE_KEY = /(photo|image|file|data_url|dataurl|document|doc_data|base64|qr)/i;
const KEY_OK = /^[^\u0000-\u001f\u007f]{1,200}$/;
const PARAM_OK = /^[^\u0000-\u001f\u007f/\\<>"'`]{1,128}$/;   // ids, receipt numbers, register types
const MAX_QUERY = 200;

function bad(res, msg) { return res.status(400).json({ error: msg }); }

/** Returns an error message, or null when the value is a safe JSON shape. */
function checkShape(root) {
  let nodes = 0;
  const walk = (v, depth, key) => {
    if (++nodes > MAX_NODES) return 'Request has too many values';
    if (depth > MAX_DEPTH) return 'Request is nested too deeply';
    if (v === null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 1e15 ? null : `"${key}" is not a valid number`;
    if (typeof v === 'string') {
      const max = FILE_KEY.test(key || '') ? MAX_FILE_TEXT : MAX_TEXT;
      if (v.length > max) return `"${key}" is too long`;
      if (v.includes('\u0000')) return `"${key}" has an invalid character`;
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v) { const e = walk(x, depth + 1, key); if (e) return e; }
      return null;
    }
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return 'Request has an invalid value';
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k)) return 'Request has a field name that is not allowed';
        if (!KEY_OK.test(k)) return 'Request has an invalid field name';
        const e = walk(v[k], depth + 1, k); if (e) return e;
      }
      return null;
    }
    return 'Request has an invalid value';
  };
  return walk(root, 0, 'body');
}

// ── Strict schemas for sign-in routes ────────────────────────────
// t: 'str' (text) · req: required · min/max: length · re: format
const MOBILE = /^[+\d][\d\s()-]{8,18}$/;
const DIGITS = (n) => new RegExp(`^\\d{${n}}$`);
const SCHEMAS = {
  'POST /auth/login': {
    email:    { max: 120 },
    mobile:   { max: 20 },
    password: { req: true, min: 1, max: 200, msg: 'Login credential and password are required' },
  },
  'POST /auth/register': {
    business_name: { req: true, min: 1, max: 120 },
    owner_name:    { req: true, min: 1, max: 120 },
    mobile:        { req: true, max: 20, re: MOBILE, msg: 'Invalid mobile number' },
    email:         { max: 120, re: /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: 'Email is not valid' },
    password:      { req: true, min: 8, max: 200, msg: 'Password must be at least 8 characters' },
    pg_name:       { max: 120 },
    city:          { max: 60 },
    property_type: { max: 20, re: /^(pg|hostel|dormitory)$/, msg: 'Choose PG, Hostel or Dormitory' },
    hostel_style:  { max: 20, re: /^(monthly|nightly)$/, msg: 'Hostel kind must be monthly or nightly' },
  },
  'POST /auth/forgot-password': {
    mobile: { req: true, max: 20 },
  },
  'POST /auth/reset-password': {
    mobile:       { req: true, max: 20 },
    otp:          { req: true, max: 10, re: /^\s*\d{6}\s*$/, msg: 'Invalid or expired OTP' },
    new_password: { req: true, min: 8, max: 200, msg: 'Password must be at least 8 characters' },
  },
  'POST /auth/staff/request-code': {
    mobile: { req: true, max: 20 },
  },
  'POST /auth/staff/set-mpin': {
    mobile: { req: true, max: 20 },
    code:   { req: true, max: 12 },
    mpin:   { req: true, max: 6, re: /^(\d{4}|\d{6})$/, msg: 'MPIN must be 4 or 6 digits' },
  },
  'POST /auth/change-password': {
    current_password: { req: true, min: 1, max: 200 },
    new_password:     { req: true, min: 8, max: 200, msg: 'New password must be at least 8 characters' },
  },
  'POST /auth/change-mpin': {
    current_mpin: { req: true, max: 6, re: DIGITS('4,6') },
    new_mpin:     { req: true, max: 6, re: /^(\d{4}|\d{6})$/, msg: 'New MPIN must be 4 or 6 digits' },
  },
};

function checkSchema(schema, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
  for (const k of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) return `Unknown field "${k}"`;
  }
  for (const [k, r] of Object.entries(schema)) {
    let v = body[k];
    if (v === undefined || v === null || v === '') {
      if (r.req) return r.msg && v !== undefined ? r.msg : `"${k}" is required`;
      continue;
    }
    // Numbers are accepted for digit fields (a mobile or MPIN typed as a number), then treated as text.
    if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
    if (typeof v !== 'string') return `"${k}" must be text`;
    if (r.min && v.length < r.min) return r.msg || `"${k}" is too short`;
    if (r.max && v.length > r.max) return r.msg || `"${k}" is too long`;
    if (r.re && !r.re.test(v)) return r.msg || `"${k}" is not in the right format`;
  }
  return null;
}

/** Express middleware for the /api/v1 router. */
function validateRequest(req, res, next) {
  // URL ids (:id, :docId …) — checked by the router param hook below; here the query string.
  for (const [k, v] of Object.entries(req.query || {})) {
    if (FORBIDDEN_KEYS.has(k) || !KEY_OK.test(k)) return bad(res, 'Invalid query parameter');
    if (typeof v !== 'string') return bad(res, `Query "${k}" must be a single value`);
    if (v.length > MAX_QUERY || v.includes('\u0000')) return bad(res, `Query "${k}" is too long`);
  }
  if (req.body !== undefined && req.body !== null && (typeof req.body !== 'object')) {
    return bad(res, 'Request body must be JSON');
  }
  if (req.body && typeof req.body === 'object') {
    const e = checkShape(req.body);
    if (e) return bad(res, e);
  }
  const schema = SCHEMAS[`${req.method} ${req.path}`];
  if (schema) {
    const e = checkSchema(schema, req.body || {});
    if (e) return bad(res, e);
  }
  return next();
}

/** router.param hook: ids in the URL must be short and use safe characters only. */
function checkParam(req, res, next, value) {
  if (typeof value !== 'string' || !PARAM_OK.test(value)) return bad(res, 'Invalid id in the address');
  return next();
}

module.exports = { validateRequest, checkParam, checkShape, checkSchema, SCHEMAS };
