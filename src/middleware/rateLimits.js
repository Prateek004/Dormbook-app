'use strict';
/**
 * Rate limits — one place, every number configurable by an environment variable.
 *
 *   Sign-in routes (strict)      per IP                   RL_AUTH_IP_MAX / RL_AUTH_IP_WINDOW_MIN        (40 / 15 min)
 *   Code / OTP sends (strict)    per mobile number        RL_CODE_PER_MOBILE_MAX / RL_CODE_WINDOW_MIN   (5 / 60 min)
 *   Public, not signed in        per IP                   RL_PUBLIC_MAX / RL_PUBLIC_WINDOW_SEC          (120 / 60 s)
 *   Guest bill links /b/…        per IP                   RL_BILL_LINK_MAX / RL_PUBLIC_WINDOW_SEC       (30 / 60 s)
 *   Signed-in users (loose)      per user                 RL_USER_MAX / RL_USER_WINDOW_SEC              (600 / 60 s)
 *   Flood guard, whole API       per IP                   RL_IP_FLOOD_MAX / RL_USER_WINDOW_SEC          (3000 / 60 s)
 *
 * Per-account wrong password / MPIN: after AUTH_LOCK_AFTER (6) wrong tries in a row the account
 *   is locked for AUTH_LOCK_MIN (15) minutes. Every further AUTH_LOCK_AFTER wrong tries lock it
 *   again. A correct sign-in resets the count. (Staff MPIN is switched off after MPIN_WIPE_AT (10) misses.)
 *
 * The flood guard is high on purpose: a whole hostel's staff can share one Wi-Fi IP.
 * Limits are kept in memory (one server). Set RL_DISABLED=true only for load tests.
 */
const { rateLimit } = require('express-rate-limit');
const jwt = require('jsonwebtoken');

function num(name, dflt, min = 1, max = 1e7) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n < min || n > max) return dflt;
  return Math.floor(n);
}

const CFG = Object.freeze({
  authIpMax:        num('RL_AUTH_IP_MAX', 40),
  authIpWindowMs:   num('RL_AUTH_IP_WINDOW_MIN', 15) * 60 * 1000,
  codePerMobileMax: num('RL_CODE_PER_MOBILE_MAX', 5),
  codeWindowMs:     num('RL_CODE_WINDOW_MIN', 60) * 60 * 1000,
  publicMax:        num('RL_PUBLIC_MAX', 120),
  publicWindowMs:   num('RL_PUBLIC_WINDOW_SEC', 60) * 1000,
  billLinkMax:      num('RL_BILL_LINK_MAX', 30),
  userMax:          num('RL_USER_MAX', 600),
  userWindowMs:     num('RL_USER_WINDOW_SEC', 60) * 1000,
  ipFloodMax:       num('RL_IP_FLOOD_MAX', 3000),
  lockAfter:        num('AUTH_LOCK_AFTER', 6, 3, 20),
  lockMin:          num('AUTH_LOCK_MIN', 15, 1, 24 * 60),
  mpinWipeAt:       num('MPIN_WIPE_AT', 10, 3, 1000),
  disabled:         process.env.RL_DISABLED === 'true',
});

/** Seconds the account is locked after `n` wrong tries in a row (0 = not locked).
 *  Locks on the 6th wrong try (and the 12th, 18th…) for AUTH_LOCK_MIN minutes. */
function backoffSeconds(n) {
  if (!Number.isFinite(n) || n < CFG.lockAfter || n % CFG.lockAfter !== 0) return 0;
  return CFG.lockMin * 60;
}

/** Wrong tries left before the next lock (for the warning shown on the sign-in screen). */
function triesLeft(n) {
  if (!Number.isFinite(n) || n < 0) return CFG.lockAfter;
  return CFG.lockAfter - (n % CFG.lockAfter);
}

/** "45 seconds" / "3 minutes" */
function waitText(iso) {
  const s = Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

const json = (error) => ({ error });
const base = { standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false } };
const off = (req, res, next) => next();
const make = (opts) => (CFG.disabled ? off : rateLimit({ ...base, ...opts }));

/** Signed-in user id from a VALID token (signature checked), else null. Cheap: HMAC only, no DB. */
function tokenUser(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    const { getJwtSecret } = require('./auth');
    const p = jwt.verify(h.slice(7), getJwtSecret(), { algorithms: ['HS256'] });
    return p && typeof p.sub === 'string' ? p.sub : null;
  } catch (_) { return null; }
}

/** The mobile number a code/OTP request is about (digits only), falling back to the IP. */
function mobileKey(req) {
  const b = req.body || {};
  const raw = typeof b.mobile === 'string' || typeof b.mobile === 'number' ? String(b.mobile) : '';
  const d = raw.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `m:${d}` : `ip:${req.ip}`;
}

const authIp = make({
  windowMs: CFG.authIpWindowMs, max: CFG.authIpMax,
  message: json('Too many attempts from this network. Please try again in a few minutes.'),
});

const codePerMobile = make({
  windowMs: CFG.codeWindowMs, max: CFG.codePerMobileMax, keyGenerator: mobileKey,
  message: json('Too many codes asked for this mobile number. Please try again later.'),
});

const ipFlood = make({
  windowMs: CFG.userWindowMs, max: CFG.ipFloodMax,
  message: json('Too many requests. Please wait a minute.'),
});

// Signed-in → counted per user (loose). Not signed in → counted per IP (moderate).
const perUser = make({
  windowMs: CFG.userWindowMs, max: CFG.userMax,
  skip: (req) => !tokenUser(req),
  keyGenerator: (req) => `u:${tokenUser(req)}`,
  message: json('Too many requests. Please wait a minute.'),
});
const publicIp = make({
  windowMs: CFG.publicWindowMs, max: CFG.publicMax,
  skip: (req) => !!tokenUser(req),
  message: json('Too many requests. Please wait a minute.'),
});

const billLink = make({
  windowMs: CFG.publicWindowMs, max: CFG.billLinkMax,
  message: 'Too many requests. Please wait a minute.',
});

/** Attach everything to the app, before the routes. */
function applyRateLimits(app) {
  app.use('/api/', ipFlood);
  const authPaths = ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password', '/api/v1/auth/staff', '/api/v1/auth/change-password', '/api/v1/auth/change-mpin'];
  for (const p of authPaths) app.use(p, authIp);
  // Codes cost money (SMS) and can be used to pester someone: also limited per mobile number.
  app.use('/api/v1/auth/forgot-password', codePerMobile);
  app.use('/api/v1/auth/staff/request-code', codePerMobile);
  app.use('/api/', publicIp, perUser);
}

module.exports = { CFG, backoffSeconds, triesLeft, waitText, applyRateLimits, billLink };
