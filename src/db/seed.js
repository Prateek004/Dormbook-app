'use strict';

require('dotenv').config();
const bcrypt         = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

function autoSeedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
  if (count.n > 0) return;

  const email    = process.env.SUPERADMIN_EMAIL    || process.env.SEED_OWNER_EMAIL    || 'superadmin@dormbook.in';
  // No built-in password on a real server: without SUPERADMIN_PASSWORD the account gets a random
  // password nobody knows (set the variable, then reset it). The simple default is for local testing only.
  const deployed = process.env.NODE_ENV === 'production'
    || !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  let password = process.env.SUPERADMIN_PASSWORD || process.env.SEED_OWNER_PASSWORD || '';
  if (!password) {
    if (deployed) {
      password = require('crypto').randomBytes(24).toString('base64url');
      console.warn('[SEED] SUPERADMIN_PASSWORD is not set — superadmin got a random password nobody knows. Set SUPERADMIN_PASSWORD.');
    } else {
      password = 'ChangeMe@Pilot1!';   // local testing only
    }
  }
  const mobile   = (process.env.SUPERADMIN_MOBILE  || process.env.SEED_OWNER_MOBILE   || '9999900000').replace(/\D/g, '');
  const name     = 'Super Admin';

  if (!process.env.SUPERADMIN_EMAIL && !process.env.SEED_OWNER_EMAIL) {
    console.warn('[SEED] SUPERADMIN_EMAIL / SEED_OWNER_EMAIL not set — using default. Set env vars before production!');
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const now  = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (id, account_id, property_id, name, email, mobile, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, NULL, NULL, ?, ?, ?, ?, 'superadmin', 1, ?, ?)
  `).run(uuidv4(), name, email, mobile, hash, now, now);

  // Never print the password: production logs are readable by anyone with
  // dashboard access and are kept for days.
  console.log('[SEED] ✅ Superadmin created');
  console.log(`[SEED]    Email   : ${email}`);
  console.log(`[SEED]    Mobile  : ${mobile}`);
  console.log('[SEED]    Password: (from SUPERADMIN_PASSWORD env var — not logged)');
}

module.exports = { autoSeedIfEmpty };

if (require.main === module) {
  const { initDb } = require('./init');
  const db = initDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
  if (count.n > 0 && process.env.FORCE !== 'true') {
    console.log('[SEED] Database already has users. Set FORCE=true to re-seed.');
    process.exit(0);
  }
  autoSeedIfEmpty(db);
  db.close();
}
