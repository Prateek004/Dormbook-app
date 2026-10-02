'use strict';

const { getDb } = require('../db/connection');

function adminStats(req, res) {
  const db = getDb();
  const now = new Date().toISOString();

  const total     = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const trial     = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan='trial' AND suspended_at IS NULL AND trial_ends_at > ?").get(now).n;
  const active    = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan='active' AND suspended_at IS NULL").get().n;
  const suspended = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE suspended_at IS NOT NULL').get().n;
  const expired   = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan='trial' AND trial_ends_at <= ? AND suspended_at IS NULL").get(now).n;
  const residents = db.prepare("SELECT COUNT(*) AS n FROM residents WHERE status='active'").get().n;

  res.json({ total, trial, active, suspended, expired, residents });
}

function listAccounts(req, res) {
  const db = getDb();
  const accounts = db.prepare(`
    SELECT a.id, a.business_name, a.plan, a.trial_ends_at, a.suspended_at, a.suspension_reason,
           a.created_at,
           COUNT(DISTINCT p.id)  AS properties,
           COUNT(DISTINCT r.id)  AS residents,
           COUNT(DISTINCT u.id)  AS users,
           (SELECT o.name FROM users o WHERE o.account_id = a.id AND o.role = 'owner' ORDER BY o.created_at LIMIT 1) AS owner_name,
           (SELECT o.mobile FROM users o WHERE o.account_id = a.id AND o.role = 'owner' ORDER BY o.created_at LIMIT 1) AS owner_mobile
    FROM accounts a
    LEFT JOIN properties p ON p.account_id = a.id
    LEFT JOIN residents  r ON r.property_id = p.id AND r.status = 'active'
    LEFT JOIN users      u ON u.account_id  = a.id AND u.is_active = 1
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all();
  res.json(accounts);
}

/**
 * GET /api/v1/admin/accounts/:id — what the super-admin may see about one customer.
 * Only business-level facts and counts. Never sent: guest names / mobiles / ID numbers /
 * documents, staff names, money amounts, UPI ID, bank details, password hashes, secrets.
 */
function getAccount(req, res) {
  const db = getDb();
  const a = db.prepare('SELECT id, business_name, plan, trial_ends_at, suspended_at, suspension_reason, created_at FROM accounts WHERE id = ?')
    .get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Account not found' });
  const has = tableHas(db);
  const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch (_) { return null; } };
  const n = (sql, ...args) => { const r = one(sql, ...args); return r ? (r.n || 0) : 0; };
  const now = new Date().toISOString();
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const owner = one("SELECT name, mobile, email, created_at FROM users WHERE account_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", a.id) || {};
  const staffRows = db.prepare('SELECT role, is_active FROM users WHERE account_id = ?').all(a.id);
  const staff = { active: 0, inactive: 0, by_role: {} };
  for (const u of staffRows) {
    if (u.is_active) { staff.active++; staff.by_role[u.role] = (staff.by_role[u.role] || 0) + 1; } else staff.inactive++;
  }

  const props = db.prepare('SELECT * FROM properties WHERE account_id = ? ORDER BY created_at').all(a.id).map((p) => {
    const bedsWhere = has('beds', 'removed_at') ? 'property_id = ? AND removed_at IS NULL' : 'property_id = ?';
    const beds = { total: n(`SELECT COUNT(*) n FROM beds WHERE ${bedsWhere}`, p.id) };
    for (const st of ['occupied', 'available', 'reserved', 'cleaning']) beds[st] = n(`SELECT COUNT(*) n FROM beds WHERE ${bedsWhere} AND status = ?`, p.id, st);
    const guests = {
      staying_now: n("SELECT COUNT(*) n FROM residents WHERE property_id = ? AND status = 'active'", p.id),
      all_time: n('SELECT COUNT(*) n FROM residents WHERE property_id = ?', p.id),
      checked_in_last_30_days: n('SELECT COUNT(*) n FROM residents WHERE property_id = ? AND check_in_date >= ?', p.id, since30),
    };
    const lastAudit = has('audit_log', 'created_at') ? one('SELECT MAX(created_at) t FROM audit_log WHERE property_id = ?', p.id) : null;
    const payments30 = has('payment_ledger', 'created_at') ? n('SELECT COUNT(*) n FROM payment_ledger WHERE property_id = ? AND created_at >= ?', p.id, since30) : 0;
    return {
      name: p.name || '', city: p.city || '', state: p.state || '',
      created_at: p.created_at || null,
      beds, guests,
      payments_recorded_last_30_days: payments30,
      last_activity_at: (lastAudit && lastAudit.t) || null,
      setup: {
        address_added: !!p.address, gstin_added: !!p.gstin, gst_on: !!p.gst_enabled,
        payment_details_added: !!(p.upi_id || p.bank_account_enc),   // yes/no only — never the UPI ID or bank account
      },
    };
  });

  const status = a.suspended_at ? 'suspended'
    : (a.plan === 'trial' && a.trial_ends_at && a.trial_ends_at < now ? 'trial_expired' : a.plan);
  return res.json({
    id: a.id, business_name: a.business_name, plan: a.plan, status,
    trial_ends_at: a.trial_ends_at, created_at: a.created_at,
    suspended_at: a.suspended_at, suspension_reason: a.suspension_reason,
    owner: { name: owner.name || '', mobile: owner.mobile || '', email: owner.email || '', since: owner.created_at || null },
    staff, properties: props,
    hidden: 'Guest names, mobiles, ID proofs, staff names, money amounts, UPI and bank details are not shown to the super-admin.',
  });
}

/** has(table, column) — works on every database version. */
function tableHas(db) {
  const cache = {};
  return (t, c) => {
    if (!cache[t]) {
      try { cache[t] = new Set(db.prepare(`PRAGMA table_info("${t.replace(/"/g, '')}")`).all().map((x) => x.name)); }
      catch (_) { cache[t] = new Set(); }
    }
    return c ? cache[t].has(c) : cache[t].size > 0;
  };
}

function suspendAccount(req, res) {
  const db = getDb();
  const { reason } = req.body;
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  db.prepare(`
    UPDATE accounts SET suspended_at = datetime('now'), suspension_reason = ? WHERE id = ?
  `).run(reason || null, req.params.id);

  res.json({ ok: true });
}

function activateAccount(req, res) {
  const db = getDb();
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  db.prepare(`
    UPDATE accounts
    SET plan = 'trial',
        trial_ends_at = datetime('now', '+30 days'),
        suspended_at = NULL,
        suspension_reason = NULL
    WHERE id = ?
  `).run(req.params.id);

  res.json({ ok: true });
}

/**
 * POST /api/v1/admin/accounts/:id/reset-password  { new_password }
 * Superadmin resets the owner's password (there is no self-service reset
 * while WhatsApp OTP is switched off).
 */
function resetOwnerPassword(req, res) {
  const bcrypt = require('bcryptjs');
  const db = getDb();
  // Phone keyboards often add a space after a suggested word; a space at the
  // start or end is never meant to be part of the password, so drop it.
  const pwd = (req.body && req.body.new_password != null ? String(req.body.new_password) : '').trim();
  if (pwd.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (pwd.length > 200) return res.status(400).json({ error: 'New password is too long' });
  const owner = db.prepare("SELECT id, name, mobile, email FROM users WHERE account_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found for this account' });
  // Whole-second timestamp: tokens carry whole-second issue times, so a login
  // right after the reset is never mistaken for an old session.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  // Also clear any "too many wrong tries" lock (otherwise the owner stays
  // blocked even with the new password) and sign out old sessions.
  db.prepare("UPDATE users SET password_hash = ?, pwd_changed_at = ?, failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(pwd, parseInt(process.env.BCRYPT_ROUNDS || '12', 10)), now, owner.id);
  console.log(`[SUPERADMIN] Owner password reset: account ${req.params.id} (user ${owner.id}) by ${req.user.id}`);
  res.json({
    ok: true,
    message: `Password reset for ${owner.name}`,
    // What the owner types on the sign-in screen.
    login: { name: owner.name, mobile: owner.mobile || '', email: owner.email || '' },
    password: pwd,
  });
}

/**
 * DELETE /api/v1/admin/accounts/:id
 * Super-admin permanently deletes an account and ALL its data — all or nothing.
 * (The old version named two tables that do not exist, so it could stop half-way and
 * leave money records and guest data behind.) Works on every database version: it looks
 * up which tables and columns exist, deletes inside one transaction, and removes the
 * account's ID-proof files from the uploads folder afterwards.
 */
function deleteAccount(req, res) {
  const fs = require('fs');
  const path = require('path');
  const db = getDb();
  const accId = req.params.id;
  const account = db.prepare('SELECT id, business_name FROM accounts WHERE id = ?').get(accId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const has = tableHas(db);
  const q = (t) => `"${t.replace(/"/g, '')}"`;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const PROPS = 'SELECT id FROM properties WHERE account_id = @acc';
  const USERS = 'SELECT id FROM users WHERE account_id = @acc';
  const RESIDENTS = `SELECT id FROM residents WHERE property_id IN (${PROPS})`;
  const propertyIds = db.prepare(PROPS.replace('@acc', '?')).all(accId).map((p) => p.id);
  const KEEP = new Set(['accounts', 'properties', 'users', 'ledger_meta']);

  let removedRows = 0;
  const run = (sql) => { removedRows += db.prepare(sql).run({ acc: accId }).changes; };

  // Money entries are protected by a "no delete" rule in the database. Only this full-account
  // delete lifts it — for this one transaction — and puts the exact same rule back before saving.
  const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ledger_entries' AND sql LIKE '%BEFORE DELETE%'").all();

  db.transaction(() => {
    // Rows may point at each other in any order; check the links once, at the end.
    db.pragma('defer_foreign_keys = ON');
    for (const g of guards) db.exec(`DROP TRIGGER IF EXISTS "${g.name.replace(/"/g, '')}"`);
    // Child rows that only point at a parent row (no property_id of their own)
    if (has('purchase_items', 'purchase_id') && has('purchases', 'property_id')) {
      run(`DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE property_id IN (${PROPS}))`);
    }
    if (has('payroll_rates', 'staff_id') && has('payroll_staff', 'property_id')) {
      run(`DELETE FROM payroll_rates WHERE staff_id IN (SELECT id FROM payroll_staff WHERE property_id IN (${PROPS}))`);
    }
    if (has('audit_log', 'actor_id')) run(`DELETE FROM audit_log WHERE actor_id IN (${USERS})`);
    if (has('login_codes', 'user_id')) run(`DELETE FROM login_codes WHERE user_id IN (${USERS})`);
    if (has('otp_store', 'mobile')) run(`DELETE FROM otp_store WHERE mobile IN (SELECT mobile FROM users WHERE account_id = @acc AND mobile IS NOT NULL)`);
    // Everything that belongs to this account's guests, properties or account id
    for (const t of tables) {
      if (KEEP.has(t) || t === 'residents') continue;
      const conds = [];
      if (has(t, 'resident_id')) conds.push(`resident_id IN (${RESIDENTS})`);
      if (has(t, 'property_id')) conds.push(`property_id IN (${PROPS})`);
      if (has(t, 'account_id')) conds.push('account_id = @acc');
      if (conds.length) run(`DELETE FROM ${q(t)} WHERE ${conds.join(' OR ')}`);
    }
    run(`DELETE FROM residents WHERE property_id IN (${PROPS})`);
    run('DELETE FROM users WHERE account_id = @acc');
    run('DELETE FROM properties WHERE account_id = @acc');
    run('DELETE FROM accounts WHERE id = @acc');
    for (const g of guards) db.exec(g.sql);          // same rule back, before commit
  })();

  // ID-proof files (encrypted) of this account's properties
  const root = path.resolve(process.env.DB_DIR || '/data', 'uploads');
  for (const pid of propertyIds) {
    const dir = path.resolve(root, String(pid).replace(/[^a-zA-Z0-9-]/g, ''));
    if (dir.startsWith(root + path.sep) && dir !== root) {
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch (e) { console.error('[SUPERADMIN] could not remove uploads for property', pid, e.message); }
    }
    require('../services/offsite').deletePropertyDocsLater(pid);   // R2 copies too (if R2 is set up)
  }

  console.log(`[SUPERADMIN] Account deleted: ${account.id} (${removedRows} rows) by ${req.user.id}`);
  res.json({ ok: true, message: `Account "${account.business_name}" permanently deleted.` });
}

module.exports = { adminStats, listAccounts, getAccount, suspendAccount, activateAccount, resetOwnerPassword, deleteAccount };
