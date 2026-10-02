'use strict';
/**
 * Staff salary: who the staff are, their monthly salary over time, salary paid,
 * and what is owed / advanced. Owner only (routes enforce it).
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const ledger = require('../services/ledger');
const { schedule, MONTH_RE } = require('../services/payroll');
const { writeAudit } = require('../middleware/auditLog');
const { istDate, isValidDate } = require('../util/time');

const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };
const text = (v, max) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));
function paise(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isSafeInteger(n) ? n : NaN;
}

function getStaff(db, pid, id) {
  return db.prepare('SELECT * FROM payroll_staff WHERE id = ? AND property_id = ?').get(id, pid);
}
function ratesOf(db, staffId) {
  return db.prepare('SELECT from_month, amount_paise FROM payroll_rates WHERE staff_id = ? ORDER BY from_month').all(staffId);
}
function paymentsOf(db, pid, staffId) {
  return db.prepare(`SELECT e.id, e.biz_date, e.ref_date, e.period_start, e.mode, e.amount_paise, e.reason, e.reversal_of,
      u.name staff_user, EXISTS (SELECT 1 FROM ledger_entries x WHERE x.reversal_of = e.id) is_reversed
    FROM ledger_entries e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.property_id = ? AND e.kind = 'SALARY' AND e.source_table = 'payroll_staff' AND e.source_id = ?
    ORDER BY e.biz_date, e.created_at`).all(pid, staffId);
}

/** Totals for one staff member up to `asOf`. */
function summary(db, pid, s, asOf = istDate()) {
  const sch = schedule(s, ratesOf(db, s.id), asOf);
  const due = sch.reduce((a, m) => a + m.due_paise, 0);
  const paid = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ledger_entries
    WHERE property_id = ? AND kind = 'SALARY' AND source_table = 'payroll_staff' AND source_id = ? AND biz_date <= ?`).get(pid, s.id, asOf).t;
  const rates = ratesOf(db, s.id);
  const current = rates.length ? rates.filter((r) => r.from_month <= asOf.slice(0, 7)).pop() || rates[0] : null;
  return { due_paise: due, paid_paise: paid, balance_paise: due - paid, monthly_salary_paise: current ? current.amount_paise : 0 };
}

// GET /payroll/staff
function listStaff(req, res) {
  const db = getDb(), pid = req.user.property_id;
  const rows = db.prepare('SELECT * FROM payroll_staff WHERE property_id = ? ORDER BY (left_on IS NOT NULL), name').all(pid);
  const staff = rows.map((s) => ({ ...s, active: !s.left_on || s.left_on >= istDate(), ...summary(db, pid, s) }));
  const totals = staff.reduce((t, s) => ({ owed: t.owed + Math.max(0, s.balance_paise), advance: t.advance + Math.max(0, -s.balance_paise),
    monthly: t.monthly + (s.active ? s.monthly_salary_paise : 0) }), { owed: 0, advance: 0, monthly: 0 });
  return res.json({ staff, totals });
}

// POST /payroll/staff  { name, designation, mobile, monthly_salary_paise, joined_on }
function addStaff(req, res) {
  const db = getDb(), pid = req.user.property_id, b = req.body || {};
  const name = text(b.name, 80);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const salary = paise(b.monthly_salary_paise);
  if (!Number.isSafeInteger(salary) || salary < 0 || salary > 100000000) return res.status(400).json({ error: 'Monthly salary is not valid' });
  const joined = b.joined_on ? String(b.joined_on) : istDate();
  if (!isValidDate(joined)) return res.status(400).json({ error: 'Joining date must be YYYY-MM-DD' });
  const mobile = text(b.mobile, 15).replace(/[^\d+]/g, '');
  if (mobile && !/^\+?\d{10,13}$/.test(mobile)) return res.status(400).json({ error: 'Mobile number is not valid' });
  const id = uuidv4();
  db.transaction(() => {
    db.prepare(`INSERT INTO payroll_staff (id, property_id, name, designation, mobile, joined_on, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, pid, name, text(b.designation, 40) || null, mobile || null, joined, req.user.id, new Date().toISOString());
    db.prepare('INSERT INTO payroll_rates (staff_id, property_id, from_month, amount_paise, created_by) VALUES (?,?,?,?,?)')
      .run(id, pid, joined.slice(0, 7), salary, req.user.id);
  })();
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'PAYROLL_STAFF_ADDED', entityType: 'payroll_staff', entityId: id,
    amountPaise: salary, snapshot: { name, joined_on: joined }, ip: req.ip });
  return res.status(201).json(getStaff(db, pid, id));
}

// PATCH /payroll/staff/:id  { name, designation, mobile, left_on (date or null) }
function updateStaff(req, res) {
  const db = getDb(), pid = req.user.property_id, b = req.body || {};
  const s = getStaff(db, pid, req.params.id);
  if (!s) return res.status(404).json({ error: 'Staff member not found' });
  const set = {};
  if (b.name !== undefined) { set.name = text(b.name, 80); if (!set.name) return res.status(400).json({ error: 'Name is required' }); }
  if (b.designation !== undefined) set.designation = text(b.designation, 40) || null;
  if (b.mobile !== undefined) {
    const m = text(b.mobile, 15).replace(/[^\d+]/g, '');
    if (m && !/^\+?\d{10,13}$/.test(m)) return res.status(400).json({ error: 'Mobile number is not valid' });
    set.mobile = m || null;
  }
  if (b.left_on !== undefined) {
    if (b.left_on === null || b.left_on === '') set.left_on = null;
    else {
      if (!isValidDate(String(b.left_on))) return res.status(400).json({ error: 'Leaving date must be YYYY-MM-DD' });
      if (String(b.left_on) < s.joined_on) return res.status(400).json({ error: 'Leaving date is before the joining date' });
      set.left_on = String(b.left_on);
    }
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change' });
  db.prepare(`UPDATE payroll_staff SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => set[k]), new Date().toISOString(), s.id);
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'PAYROLL_STAFF_UPDATED', entityType: 'payroll_staff', entityId: s.id,
    snapshot: { before: s, changes: set }, ip: req.ip });
  return res.json(getStaff(db, pid, s.id));
}

// POST /payroll/staff/:id/salary  { monthly_salary_paise, from_month }
function changeSalary(req, res) {
  const db = getDb(), pid = req.user.property_id, b = req.body || {};
  const s = getStaff(db, pid, req.params.id);
  if (!s) return res.status(404).json({ error: 'Staff member not found' });
  const salary = paise(b.monthly_salary_paise);
  if (!Number.isSafeInteger(salary) || salary < 0 || salary > 100000000) return res.status(400).json({ error: 'Monthly salary is not valid' });
  const from = String(b.from_month || '');
  if (!MONTH_RE.test(from)) return res.status(400).json({ error: 'Choose the month the new salary starts' });
  if (from < s.joined_on.slice(0, 7)) return res.status(400).json({ error: 'That month is before the staff member joined' });
  db.prepare(`INSERT INTO payroll_rates (staff_id, property_id, from_month, amount_paise, created_by) VALUES (?,?,?,?,?)
    ON CONFLICT(staff_id, from_month) DO UPDATE SET amount_paise = excluded.amount_paise, created_by = excluded.created_by,
    created_at = datetime('now')`).run(s.id, pid, from, salary, req.user.id);
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'PAYROLL_SALARY_CHANGED', entityType: 'payroll_staff', entityId: s.id,
    amountPaise: salary, snapshot: { from_month: from }, ip: req.ip });
  return res.status(201).json({ ok: true, rates: ratesOf(db, s.id) });
}

// GET /payroll/staff/:id — month-by-month statement
function staffDetail(req, res) {
  const db = getDb(), pid = req.user.property_id;
  const s = getStaff(db, pid, req.params.id);
  if (!s) return res.status(404).json({ error: 'Staff member not found' });
  const sch = schedule(s, ratesOf(db, s.id));
  const pays = paymentsOf(db, pid, s.id);
  const byMonth = new Map();
  for (const p of pays) { const m = String(p.period_start || p.biz_date).slice(0, 7); byMonth.set(m, (byMonth.get(m) || 0) + p.amount_paise); }
  const months = [...new Set([...sch.map((m) => m.month), ...byMonth.keys()])].sort();
  let running = 0;
  const statement = months.map((m) => {
    const row = sch.find((x) => x.month === m) || { rate_paise: 0, due_paise: 0, note: '' };
    const paid = byMonth.get(m) || 0;
    running += row.due_paise - paid;
    return { month: m, salary_paise: row.due_paise, note: row.note, paid_paise: paid, balance_paise: running };
  });
  return res.json({
    staff: s, rates: ratesOf(db, s.id), ...summary(db, pid, s), statement,
    payments: pays.map((p) => ({ id: p.id, date: p.biz_date, month: String(p.period_start || '').slice(0, 7), mode: MODE_LABEL[p.mode] || p.mode,
      amount: p.amount_paise, note: p.reason || '', by: p.staff_user || '', is_reversal: !!p.reversal_of, is_reversed: !!p.is_reversed })),
  });
}

// POST /payroll/staff/:id/pay  { amount_paise, mode, date, month, note }
function paySalary(req, res) {
  const db = getDb(), pid = req.user.property_id, b = req.body || {};
  const s = getStaff(db, pid, req.params.id);
  if (!s) return res.status(404).json({ error: 'Staff member not found' });
  const amount = paise(b.amount_paise);
  if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
  const month = String(b.month || istDate().slice(0, 7));
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'Choose the month this salary is for' });
  const key = req.get('Idempotency-Key');
  const row = ledger.salaryPayment({ propertyId: pid, staffId: s.id, month, amountPaise: amount, mode: b.mode,
    bizDate: b.date ? String(b.date) : undefined, reason: b.note, userId: req.user.id,
    idemKey: key ? `salary:${pid}:${String(key).slice(0, 80)}` : null });
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'SALARY_PAID', entityType: 'payroll_staff', entityId: s.id,
    amountPaise: amount, snapshot: { month, mode: row.mode, date: row.biz_date, ledger_id: row.id }, ip: req.ip });
  return res.status(201).json({ entry: row, moved_to_date: b.date && row.biz_date !== String(b.date) ? row.biz_date : null,
    ...summary(db, pid, s) });
}

module.exports = { listStaff, addStaff, updateStaff, changeSalary, staffDetail, paySalary, summary, ratesOf };
