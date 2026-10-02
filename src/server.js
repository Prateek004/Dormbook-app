'use strict';

const path    = require('path');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');

const { setDb } = require('./db/connection');
const { initDb: openDb } = require('./db/init');
const { autoSeedIfEmpty } = require('./db/seed');
const routes        = require('./routes');
const { startScheduler } = require('./services/scheduler');

const app  = express();
const PORT = process.env.PORT || 8080;
const ENV  = process.env.NODE_ENV || 'development';

// Railway (and most PaaS) put the app behind a single reverse proxy. Trusting
// one hop lets express-rate-limit and req.ip see the real client IP instead of
// the proxy's — without it every user would share one IP and be rate-limited
// together.
app.set('trust proxy', 1);
// Query strings are parsed simply (no nested objects/arrays): nothing in the app needs more,
// and it closes the known "qs" denial-of-service holes.
app.set('query parser', 'simple');

// A crash-proof server must survive stray async errors instead of exiting.
// Log loudly and keep serving; a single bad request should never take the
// whole process down.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'"],
    },
  },
}));

// The app and its API are on the same site, so other websites get no CORS access.
// (To allow a separate front-end later, set CORS_ORIGINS=https://a.com,https://b.com)
const corsOrigins = String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  next();
});
app.use(express.json({ limit: '3mb' })); // ID photos arrive as base64 (max 1.5 MB file)
// Request log. Guest bill links (/b/<secret>) and query strings are cut out so no link
// or search text ends up in the logs.
morgan.token('safe-url', (req) => String(req.originalUrl || req.url || '')
  .replace(/^\/b\/[^/?#]+/, '/b/[link]').replace(/\?.*$/, (q) => (q.length > 1 ? '?[…]' : '')));
app.use(morgan(ENV === 'production'
  ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":user-agent"'
  : ':method :safe-url :status :response-time ms'));

// Rate limits: strict on sign-in (per IP + per mobile for codes, back-off per account),
// moderate on public pages, looser for signed-in users. All numbers are env settings —
// see src/middleware/rateLimits.js.
const { applyRateLimits, billLink } = require('./middleware/rateLimits');
applyRateLimits(app);

// Guest bill links (no sign-in): limited so links can't be guessed by brute force.
const share = require('./controllers/shareController');
app.get('/b/:token', billLink, share.viewBill);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/v1', routes);
// Unknown API paths answer JSON 404 (not the app's HTML page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  // A malformed JSON body is a client error, not a server fault — answer 400,
  // not 500, and don't log it as an internal error.
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError) && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // Oversized body → 413 rather than a generic 500.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  // Business-rule errors from the money ledger (day closed, refund > deposit,
  // duplicate payment, ...) are the user's to fix — answer 4xx with the reason.
  if (err && err.isLedgerError) {
    if (res.headersSent) return;
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err && err.code === 'SQLITE_BUSY') {
    if (res.headersSent) return;
    return res.status(503).json({ error: 'Server busy — please retry' });
  }
  // Other client mistakes the body reader reports (bad charset, aborted upload…): plain message, no details.
  const st = err && Number(err.status || err.statusCode);
  if (st >= 400 && st < 500) {
    if (res.headersSent) return;
    return res.status(st).json({ error: 'The request could not be read. Please try again.' });
  }
  // Anything else: full details go to the server log only; the user gets a short message and a
  // reference to quote to support (never a stack trace, file path or database error).
  const ref = require('crypto').randomBytes(4).toString('hex');
  console.error(`[ERROR ref=${ref}] ${req.method} ${String(req.originalUrl || '').replace(/\?.*$/, '')}`,
    err && err.message, err && err.stack);
  if (res.headersSent) return;   // response already streaming (e.g. PDF export)
  res.status(500).json({ error: `Something went wrong on our side. Please try again. (ref ${ref})`, ref });
});

// Refuse to start in production without the secrets the app cannot work without.
// A clear boot error in Railway logs beats a running app where every login fails.
function checkRequiredEnv() {
  const onPaas = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  if (ENV !== 'production' && !onPaas) return;
  if (ENV !== 'production') console.warn('[BOOT WARNING] NODE_ENV is not "production" on Railway — set NODE_ENV=production.');
  const problems = [];
  const jwt = process.env.JWT_SECRET;
  if (!jwt || jwt.startsWith('CHANGE_ME') || jwt.length < 32) problems.push('JWT_SECRET missing or shorter than 32 characters');
  const aes = process.env.AES_256_KEY;
  if (!aes || !/^[0-9a-fA-F]{64}$/.test(aes)) problems.push('AES_256_KEY must be exactly 64 hex characters (openssl rand -hex 32)');
  // On Railway the container disk is wiped on every deploy/restart. Without a
  // volume mounted at DB_DIR, all accounts and data vanish and every open
  // browser gets "User not found or deactivated". Refuse to run like that.
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  if (onRailway && process.env.ALLOW_EPHEMERAL_DB !== 'true') {
    const dbDir = path.resolve(process.env.DB_DIR || '/data');
    const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) : '';
    if (!mount) {
      problems.push(`No volume attached. In Railway: service → Settings → Volumes → add a volume with mount path ${dbDir}`);
    } else if (dbDir !== mount && !dbDir.startsWith(mount + path.sep)) {
      problems.push(`DB_DIR (${dbDir}) is not inside the volume mount (${mount}). Set DB_DIR=${mount}`);
    }
  }
  if (problems.length) {
    console.error('[BOOT ERROR] Fix these Railway settings, then redeploy:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  const mobile = (process.env.SUPERADMIN_MOBILE || '').replace(/\D/g, '');
  if (process.env.SUPERADMIN_MOBILE && mobile.length !== 10) {
    console.warn(`[BOOT WARNING] SUPERADMIN_MOBILE should be a 10-digit mobile number (got ${mobile.length} digits)`);
  }
}

(async () => {
  try {
    checkRequiredEnv();
    const db = openDb();
    setDb(db);
    autoSeedIfEmpty(db);
    startScheduler();
    app.listen(PORT, () => {
      console.log(`[SERVER] DormBook v4.0 on port ${PORT} (${ENV})`);
    });
  } catch (err) {
    console.error('[BOOT ERROR]', err.message, err.stack);
    process.exit(1);
  }
})();
