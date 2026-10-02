'use strict';
/**
 * Accounts: double-entry books built from the money ledger.
 *
 * Nothing new is stored for the books themselves. Every ledger_entries row is
 * turned into balanced debit/credit postings (debits = credits for every row),
 * so the Day Book, account ledgers, Trial Balance, Profit & Loss and Balance
 * Sheet always agree with the rest of the app.
 *
 * Two things come from cash closes rather than the ledger, so the books' cash
 * matches the drawer:
 *   - the opening cash typed at the very first cash close
 *   - each close's short / excess (counted − expected)
 *
 * Amounts are integer paise. In a posting, + is a debit and − is a credit.
 */
const { getDb } = require('../db/connection');
const ledger = require('../services/ledger');
const { writeAudit } = require('../middleware/auditLog');
const { istDate, istMonthStart, isValidDate, daysBetween } = require('../util/time');
const { schedule } = require('../services/payroll');

const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_LABEL = { asset: 'Assets', liability: 'Liabilities', equity: "Owner's equity", income: 'Income', expense: 'Expenses' };

const FIXED = {
  cash:      { name: 'Cash in hand', type: 'asset' },
  bank:      { name: 'Bank & UPI', type: 'asset' },
  guests:    { name: 'Guests (dues and advances)', type: 'asset' },
  deposits:  { name: 'Security deposits held', type: 'liability' },
  gst:       { name: 'GST payable', type: 'liability' },
  salary:    { name: 'Staff salary (owed / advances)', type: 'liability' },
  capital:   { name: "Owner's capital", type: 'equity' },
  drawings:  { name: "Owner's drawings", type: 'equity' },
  opening:   { name: 'Opening balances', type: 'equity' },
  cash_diff: { name: 'Cash short / excess', type: 'expense' },
};
const INCOME_NAME = { rent: 'Room rent', addon: 'Items & add-ons', food: 'Food', electricity: 'Electricity',
  damage: 'Damage recovery', other: 'Other charges', other_income: 'Other income (not from guests)' };
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };
const KIND_LABEL = {
  CHARGE: 'Charged to guest', PAYMENT: 'Payment from guest', WAIVER: 'Discount given', DEPOSIT_IN: 'Deposit received',
  DEPOSIT_APPLY: 'Deposit adjusted to dues', DEPOSIT_REFUND: 'Deposit refunded', CREDIT_REFUND: 'Advance refunded',
  EXPENSE: 'Expense', BANK_DEPOSIT: 'Cash deposited in bank', BANK_WITHDRAW: 'Cash withdrawn from bank',
  OPENING_DUES: 'Opening dues', OPENING_DEPOSIT: 'Opening deposit', OWNER_IN: 'Owner put money in',
  OWNER_OUT: 'Owner took money out', OTHER_INCOME: 'Other income', OPENING_CASH: 'Opening cash (first cash close)',
  CASH_DIFF: 'Cash short / excess at close', SALARY: 'Salary paid', SALARY_DUE: 'Salary for the month', PURCHASE: 'Purchase',
};

function accountInfo(key) {
  if (FIXED[key]) return { key, ...FIXED[key] };
  if (key.startsWith('income:')) {
    const c = key.slice(7);
    return { key, name: INCOME_NAME[c] || `${c.charAt(0).toUpperCase()}${c.slice(1)} income`, type: 'income' };
  }
  if (key === 'expense:discounts') return { key, name: 'Discounts given', type: 'expense' };
  if (key === 'expense:salaries') return { key, name: 'Staff salaries', type: 'expense' };
  if (key.startsWith('purchase:')) return { key, name: `Purchases: ${key.slice(9) || 'Other'}`, type: 'expense' };
  if (key.startsWith('expense:')) {
    const c = key.slice(8) || 'Other';
    return { key, name: c.charAt(0).toUpperCase() + c.slice(1), type: 'expense' };
  }
  return null;
}

const money = (mode) => (mode === 'cash' ? 'cash' : 'bank');

/** Balanced postings for one ledger row. Sum of amounts is always 0. */
function postingsFor(e) {
  const a = e.amount_paise;          // negative for reversals — postings flip automatically
  const t = e.tax_paise || 0;
  switch (e.kind) {
    case 'CHARGE': {
      const out = [{ acc: 'guests', amt: a }, { acc: `income:${e.category || 'other'}`, amt: -(a - t) }];
      if (t) out.push({ acc: 'gst', amt: -t });
      return out;
    }
    case 'PAYMENT':         return [{ acc: money(e.mode), amt: a }, { acc: 'guests', amt: -a }];
    case 'WAIVER':          return [{ acc: 'expense:discounts', amt: a }, { acc: 'guests', amt: -a }];
    case 'DEPOSIT_IN':      return [{ acc: money(e.mode), amt: a }, { acc: 'deposits', amt: -a }];
    case 'DEPOSIT_APPLY':   return [{ acc: 'deposits', amt: a }, { acc: 'guests', amt: -a }];
    case 'DEPOSIT_REFUND':  return [{ acc: 'deposits', amt: a }, { acc: money(e.mode), amt: -a }];
    case 'CREDIT_REFUND':   return [{ acc: 'guests', amt: a }, { acc: money(e.mode), amt: -a }];
    case 'EXPENSE':         return [{ acc: `expense:${String(e.category || 'Other').trim().toLowerCase()}`, amt: a }, { acc: money(e.mode), amt: -a }];
    case 'BANK_DEPOSIT':    return [{ acc: 'bank', amt: a }, { acc: 'cash', amt: -a }];
    case 'BANK_WITHDRAW':   return [{ acc: 'cash', amt: a }, { acc: 'bank', amt: -a }];
    case 'OPENING_DUES':    return [{ acc: 'guests', amt: a }, { acc: 'opening', amt: -a }];
    case 'OPENING_DEPOSIT': return [{ acc: 'opening', amt: a }, { acc: 'deposits', amt: -a }];
    case 'OWNER_IN':        return [{ acc: money(e.mode), amt: a }, { acc: e.category === 'opening' ? 'opening' : 'capital', amt: -a }];
    case 'OWNER_OUT':       return [{ acc: 'drawings', amt: a }, { acc: money(e.mode), amt: -a }];
    case 'OTHER_INCOME':    return [{ acc: money(e.mode), amt: a }, { acc: 'income:other_income', amt: -a }];
    // Salary: each month's salary is owed (see journal: SALARY_DUE); a payment clears it (or is an advance).
    case 'SALARY':          return [{ acc: 'salary', amt: a }, { acc: money(e.mode), amt: -a }];
    case 'PURCHASE':        return [{ acc: `purchase:${e.category || 'Other'}`, amt: a }, { acc: money(e.mode), amt: -a }];
    default:                return [];
  }
}

/** Every entry for the property up to `to` (inclusive), as journal lines with postings. */
function journal(db, pid, to) {
  const rows = db.prepare(`SELECT e.id, e.biz_date, e.ref_date, e.created_at, e.kind, e.category, e.mode, e.amount_paise,
      e.tax_paise, e.reason, e.reversal_of, e.resident_id, e.source_id, e.period_start, r.full_name resident, b.bed_label bed,
      u.name staff, ps.name payee
    FROM ledger_entries e
    LEFT JOIN residents r ON r.id = e.resident_id LEFT JOIN beds b ON b.id = r.bed_id
    LEFT JOIN payroll_staff ps ON e.kind = 'SALARY' AND ps.id = e.source_id
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.property_id = ? AND e.biz_date <= ? ORDER BY e.biz_date, e.created_at, e.rowid`).all(pid, to);
  const out = rows.map((e) => ({
    id: e.id, date: e.biz_date, kind: e.kind, label: KIND_LABEL[e.kind] || e.kind,
    who: e.resident ? `${e.resident}${e.bed ? ` (Bed ${e.bed})` : ''}` : (e.payee ? `${e.payee}${e.period_start ? `, for ${e.period_start.slice(0, 7)}` : ''}` : ''),
    resident_id: e.resident_id || null, staff_id: e.kind === 'SALARY' ? e.source_id : null,
    note: e.reason || (e.kind === 'EXPENSE' ? e.category : '') || '',
    mode: e.mode ? (MODE_LABEL[e.mode] || e.mode) : '', staff: e.staff || '',
    reversal: !!e.reversal_of, amount: e.amount_paise, postings: postingsFor(e),
  }));
  // From cash closes: opening cash (first close) and short / excess (every close).
  const closes = db.prepare('SELECT * FROM day_closes WHERE property_id = ? AND biz_date <= ? ORDER BY biz_date').all(pid, to);
  if (closes.length && closes[0].opening_cash_paise) {
    const c = closes[0];
    out.push({ id: `opening-cash-${c.biz_date}`, date: c.from_date, kind: 'OPENING_CASH', label: KIND_LABEL.OPENING_CASH,
      who: '', note: 'Cash in the drawer when you started', mode: 'Cash', staff: '', reversal: false, amount: c.opening_cash_paise,
      postings: [{ acc: 'cash', amt: c.opening_cash_paise }, { acc: 'opening', amt: -c.opening_cash_paise }] });
  }
  for (const c of closes) {
    if (!c.variance_paise) continue;
    const v = c.variance_paise;       // + = excess cash, − = short
    out.push({ id: `cash-diff-${c.biz_date}`, date: c.biz_date, kind: 'CASH_DIFF', label: KIND_LABEL.CASH_DIFF,
      who: '', note: v > 0 ? 'Drawer had more cash than expected' : 'Drawer had less cash than expected', mode: 'Cash',
      staff: '', reversal: false, amount: Math.abs(v),
      postings: [{ acc: 'cash', amt: v }, { acc: 'cash_diff', amt: -v }] });
  }
  // Staff salary owed for each month (from the salary set in Staff Salary).
  const staff = db.prepare('SELECT * FROM payroll_staff WHERE property_id = ?').all(pid);
  const rateStmt = db.prepare('SELECT from_month, amount_paise FROM payroll_rates WHERE staff_id = ? ORDER BY from_month');
  for (const s of staff) {
    for (const m of schedule(s, rateStmt.all(s.id), to)) {
      if (!m.due_paise) continue;
      out.push({ id: `salary-due-${s.id}-${m.month}`, date: m.date, kind: 'SALARY_DUE', label: KIND_LABEL.SALARY_DUE,
        who: `${s.name}, ${m.month}`, note: m.note, mode: '', staff: '', reversal: false, amount: m.due_paise, staff_id: s.id,
        postings: [{ acc: 'expense:salaries', amt: m.due_paise }, { acc: 'salary', amt: -m.due_paise }] });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

function range(req, res) {
  const to = req.query.to ? String(req.query.to) : istDate();
  const from = req.query.from ? String(req.query.from) : istMonthStart();
  if (!isValidDate(from) || !isValidDate(to)) { res.status(400).json({ error: 'from/to must be YYYY-MM-DD' }); return null; }
  if (from > to) { res.status(400).json({ error: '"From" must be on or before "To"' }); return null; }
  return { from, to };
}

function asOf(req, res) {
  const to = req.query.to ? String(req.query.to) : istDate();
  if (!isValidDate(to)) { res.status(400).json({ error: 'to must be YYYY-MM-DD' }); return null; }
  return to;
}

/** Balance per account from a list of journal lines. */
function balancesOf(lines, filter = () => true) {
  const bal = new Map();
  for (const l of lines) {
    if (!filter(l)) continue;
    for (const p of l.postings) bal.set(p.acc, (bal.get(p.acc) || 0) + p.amt);
  }
  return bal;
}

function sortAccounts(keys) {
  return keys.map(accountInfo).filter(Boolean).sort((a, b) =>
    TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name));
}

// ── GET /accounts/chart — every account that has an entry, for the ledger picker
function chart(req, res) {
  const db = getDb();
  const lines = journal(db, req.user.property_id, istDate());
  const keys = new Set(Object.keys(FIXED));
  lines.forEach((l) => l.postings.forEach((p) => keys.add(p.acc)));
  return res.json(sortAccounts([...keys]).map((a) => ({ ...a, type_label: TYPE_LABEL[a.type] })));
}

// ── GET /accounts/day-book?from&to — every entry with its debit and credit accounts
function dayBook(req, res) {
  const r = range(req, res); if (!r) return;
  if (daysBetween(r.from, r.to) > 366) return res.status(400).json({ error: 'Choose a period of one year or less' });
  const db = getDb();
  const lines = journal(db, req.user.property_id, r.to).filter((l) => l.date >= r.from);
  const rows = lines.map((l) => {
    const dr = l.postings.filter((p) => p.amt > 0), cr = l.postings.filter((p) => p.amt < 0);
    return {
      id: l.id, date: l.date, label: l.label, who: l.who, note: l.note, mode: l.mode, staff: l.staff, reversal: l.reversal,
      debit: dr.map((p) => ({ account: accountInfo(p.acc).name, amount: p.amt })),
      credit: cr.map((p) => ({ account: accountInfo(p.acc).name, amount: -p.amt })),
      total: dr.reduce((s, p) => s + p.amt, 0),
    };
  });
  const totalDr = rows.reduce((s, x) => s + x.total, 0);
  return res.json({ from: r.from, to: r.to, rows, total: totalDr });
}

// ── GET /accounts/ledger?account=&from&to — one account with running balance
function accountLedger(req, res) {
  const r = range(req, res); if (!r) return;
  const key = String(req.query.account || '');
  const info = accountInfo(key);
  if (!info) return res.status(400).json({ error: 'Choose an account' });
  const db = getDb();
  const lines = journal(db, req.user.property_id, r.to);
  let opening = 0;
  const rows = [];
  let running = 0;
  for (const l of lines) {
    const amt = l.postings.filter((p) => p.acc === key).reduce((s, p) => s + p.amt, 0);
    if (!amt) continue;
    if (l.date < r.from) { opening += amt; continue; }
    if (!rows.length) running = opening;
    running += amt;
    const other = l.postings.filter((p) => p.acc !== key).map((p) => accountInfo(p.acc).name);
    rows.push({ id: l.id, date: l.date, label: l.label, who: l.who, note: l.note, mode: l.mode, reversal: l.reversal,
      against: [...new Set(other)].join(', '), debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, balance: running });
  }
  const closing = rows.length ? running : opening;
  return res.json({ account: { ...info, type_label: TYPE_LABEL[info.type] }, from: r.from, to: r.to,
    opening, closing, rows,
    total_debit: rows.reduce((s, x) => s + x.debit, 0), total_credit: rows.reduce((s, x) => s + x.credit, 0) });
}

// ── GET /accounts/trial-balance?to — every account's balance; debits must equal credits
function trialBalance(req, res) {
  const to = asOf(req, res); if (!to) return;
  const db = getDb();
  const bal = balancesOf(journal(db, req.user.property_id, to));
  const rows = sortAccounts([...bal.keys()]).map((a) => {
    const b = bal.get(a.key);
    return { key: a.key, name: a.name, type: a.type, type_label: TYPE_LABEL[a.type], debit: b > 0 ? b : 0, credit: b < 0 ? -b : 0 };
  }).filter((x) => x.debit || x.credit);
  const debit = rows.reduce((s, x) => s + x.debit, 0), credit = rows.reduce((s, x) => s + x.credit, 0);
  return res.json({ to, rows, total_debit: debit, total_credit: credit, balanced: debit === credit });
}

// ── GET /accounts/profit-loss?from&to — income and expenses billed in the period
function profitLoss(req, res) {
  const r = range(req, res); if (!r) return;
  const db = getDb();
  const bal = balancesOf(journal(db, req.user.property_id, r.to), (l) => l.date >= r.from);
  const pick = (type, sign) => sortAccounts([...bal.keys()]).filter((a) => a.type === type)
    .map((a) => ({ key: a.key, name: a.name, amount: sign * bal.get(a.key) })).filter((x) => x.amount);
  const income = pick('income', -1), expenses = pick('expense', 1);
  const ti = income.reduce((s, x) => s + x.amount, 0), te = expenses.reduce((s, x) => s + x.amount, 0);
  return res.json({ from: r.from, to: r.to, income, expenses, total_income: ti, total_expenses: te, profit: ti - te,
    note: 'Income is counted when it is billed to the guest (not when it is paid). GST collected is not income; it is shown under GST payable.' });
}

// ── GET /accounts/balance-sheet?to — what the business has and owes on a date
function balanceSheet(req, res) {
  const to = asOf(req, res); if (!to) return;
  const db = getDb();
  const lines = journal(db, req.user.property_id, to);
  const bal = balancesOf(lines);
  const g = (k) => bal.get(k) || 0;
  // Split the guests account: money guests owe (asset) vs advance they paid (liability).
  const perGuest = new Map();
  for (const l of lines) {
    if (!l.resident_id) continue;
    for (const p of l.postings) if (p.acc === 'guests') perGuest.set(l.resident_id, (perGuest.get(l.resident_id) || 0) + p.amt);
  }
  let owed = 0, advances = 0;
  for (const v of perGuest.values()) { if (v > 0) owed += v; else advances += -v; }
  const perStaff = new Map();
  for (const l of lines) {
    if (!l.staff_id) continue;
    for (const p of l.postings) if (p.acc === 'salary') perStaff.set(l.staff_id, (perStaff.get(l.staff_id) || 0) + p.amt);
  }
  let salaryOwed = 0, salaryAdvance = 0;
  for (const v of perStaff.values()) { if (v < 0) salaryOwed += -v; else salaryAdvance += v; }
  let profit = 0;
  for (const [k, v] of bal) { const a = accountInfo(k); if (a && (a.type === 'income' || a.type === 'expense')) profit -= v; }

  const assets = [
    { name: 'Cash in hand', amount: g('cash') },
    { name: 'Bank & UPI', amount: g('bank') },
    { name: 'Dues from guests', amount: owed },
    { name: 'Salary advances to staff', amount: salaryAdvance },
  ];
  const liabilities = [
    { name: 'Security deposits held', amount: -g('deposits') },
    { name: 'Advance paid by guests', amount: advances },
    { name: 'GST payable', amount: -g('gst') },
    { name: 'Salary owed to staff', amount: salaryOwed },
  ];
  const equity = [
    { name: "Owner's capital", amount: -g('capital') },
    { name: 'Opening balances', amount: -g('opening') },
    { name: "Less: owner's drawings", amount: -g('drawings') },
    { name: 'Profit to date', amount: profit },
  ];
  const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
  const ta = sum(assets), tl = sum(liabilities), te = sum(equity);
  const warnings = [];
  if (g('cash') < 0) warnings.push('Cash in hand is below zero. Record money the owner put in (Accounts → Record money), or check that cash expenses were entered with the right payment mode.');
  if (g('bank') < 0) warnings.push('Bank & UPI is below zero. Record the bank opening balance or owner money put in through the bank.');
  return res.json({ to, assets, liabilities, equity, total_assets: ta, total_liabilities: tl, total_equity: te,
    balanced: ta === tl + te, warnings });
}

// ── Owner / business entries ─────────────────────────────────────────────────
const ENTRY_KINDS = ['OWNER_IN', 'OWNER_OUT', 'OTHER_INCOME', 'BANK_DEPOSIT', 'BANK_WITHDRAW'];

// GET /accounts/entries?from&to
function listEntries(req, res) {
  const r = range(req, res); if (!r) return;
  const db = getDb();
  const rows = db.prepare(`SELECT e.id, e.biz_date, e.ref_date, e.kind, e.category, e.mode, e.amount_paise, e.reason,
      e.reversal_of, u.name staff,
      EXISTS (SELECT 1 FROM ledger_entries x WHERE x.reversal_of = e.id) is_reversed
    FROM ledger_entries e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.property_id = ? AND e.kind IN (${ENTRY_KINDS.map(() => '?').join(',')}) AND e.biz_date BETWEEN ? AND ?
    ORDER BY e.biz_date DESC, e.created_at DESC`).all(req.user.property_id, ...ENTRY_KINDS, r.from, r.to);
  return res.json({ from: r.from, to: r.to, rows: rows.map((e) => ({
    id: e.id, date: e.biz_date, kind: e.kind, label: e.kind === 'OWNER_IN' && e.category === 'opening' ? 'Opening balance' : KIND_LABEL[e.kind],
    mode: e.mode ? (MODE_LABEL[e.mode] || e.mode) : (e.kind === 'BANK_DEPOSIT' ? 'Cash → Bank' : e.kind === 'BANK_WITHDRAW' ? 'Bank → Cash' : ''),
    amount: e.amount_paise, note: e.reason || '', staff: e.staff || '',
    is_reversal: !!e.reversal_of, is_reversed: !!e.is_reversed,
  })) });
}

// POST /accounts/entries  { type, amount_paise, mode, date, note, opening }
function createEntry(req, res) {
  const b = req.body || {};
  const amount = typeof b.amount_paise === 'number' ? b.amount_paise : Number(String(b.amount_paise ?? '').trim());
  if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });
  const key = req.get('Idempotency-Key');
  const row = ledger.businessEntry({
    propertyId: req.user.property_id, type: String(b.type || ''), amountPaise: amount,
    mode: b.mode, bizDate: b.date ? String(b.date) : undefined, reason: b.note,
    category: b.type === 'owner_in' && b.opening === true ? 'opening' : null,
    userId: req.user.id, idemKey: key ? `acct:${req.user.property_id}:${String(key).slice(0, 80)}` : null,
  });
  writeAudit({ propertyId: req.user.property_id, userId: req.user.id, action: 'ACCOUNT_ENTRY_CREATED',
    entityType: 'ledger_entries', entityId: row.id, amountPaise: amount,
    snapshot: { kind: row.kind, mode: row.mode, date: row.biz_date, note: row.reason }, ip: req.ip });
  const moved = b.date && row.biz_date !== String(b.date);
  return res.status(201).json({ entry: row, moved_to_date: moved ? row.biz_date : null });
}

module.exports = { chart, dayBook, accountLedger, trialBalance, profitLoss, balanceSheet, listEntries, createEntry,
  postingsFor, journal, accountInfo };
