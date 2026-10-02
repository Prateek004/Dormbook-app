'use strict';
// Accounts: owner entries go through the protected ledger, cash close counts them,
// and the books (Trial Balance, Balance Sheet, P&L, ledgers, Day Book) always balance
// and agree with the rest of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

test('a ledger from before this update is upgraded with every row and rupee kept', () => {
  const { setDb } = require('../src/db/connection');
  const L = require('../src/services/ledger');
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  setDb(db);
  // Today's live table: the current schema without the four new entry kinds.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ledger.js'), 'utf8');
  const oldSchema = src.slice(src.indexOf('const SCHEMA = `') + 16, src.indexOf('`;', src.indexOf('const SCHEMA = `')))
    .replace(/,\s*'OWNER_IN'(,'[A-Z_]+')*/g, '');
  assert.ok(!oldSchema.includes('OWNER_IN') && oldSchema.includes('CREDIT_REFUND'));
  db.exec(oldSchema);
  const ins = db.prepare(`INSERT INTO ledger_entries (id, property_id, resident_id, biz_date, ref_date, created_at, kind, category, mode, amount_paise, reversal_of, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('e1', 'p1', null, '2026-09-01', '2026-09-01', 'x', 'EXPENSE', 'food', 'cash', 12345, null, null);
  ins.run('e2', 'p1', 'r1', '2026-09-02', '2026-09-02', 'x', 'PAYMENT', 'rent', 'upi', 900000, null, null);
  ins.run('e3', 'p1', 'r1', '2026-09-03', '2026-09-03', 'x', 'PAYMENT', 'rent', 'upi', -900000, 'e2', 'Reversal: typo');
  ins.run('e4', 'p1', 'r1', '2026-09-04', '2026-09-04', 'x', 'CREDIT_REFUND', 'rent', 'cash', 5000, null, null);
  // A new kind is refused by the old table
  assert.throws(() => ins.run('x', 'p1', null, '2026-09-05', '2026-09-05', 'x', 'OWNER_IN', null, 'cash', 1, null, null), /CHECK/);
  const before = db.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM ledger_entries').get();

  L.setupLedger(db);
  const after = db.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM ledger_entries').get();
  assert.deepEqual(after, before, 'every row and rupee kept');
  assert.deepEqual(db.prepare("SELECT id, kind, amount_paise, reversal_of FROM ledger_entries ORDER BY rowid").all().map((r) => r.id), ['e1', 'e2', 'e3', 'e4']);
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='ledger_entries'").get().sql.includes("'BANK_WITHDRAW'"));
  assert.throws(() => db.prepare('DELETE FROM ledger_entries').run(), /LEDGER_IMMUTABLE/, 'protection triggers recreated');
  assert.throws(() => db.prepare("UPDATE ledger_entries SET amount_paise = 1 WHERE id='e1'").run(), /LEDGER_IMMUTABLE/);
  // New kinds now accepted, with their safety rules
  ins.run('n1', 'p1', null, '2026-09-05', '2026-09-05', 'x', 'OWNER_IN', null, 'cash', 100, null, null);
  assert.throws(() => ins.run('n2', 'p1', null, '2026-09-05', '2026-09-05', 'x', 'OWNER_OUT', null, null, 100, null, null), /CHECK/, 'mode required');
  assert.throws(() => ins.run('n3', 'p1', 'r1', '2026-09-05', '2026-09-05', 'x', 'OTHER_INCOME', null, 'cash', 100, null, null), /CHECK/, 'never linked to a guest');
  L.setupLedger(db); // second run is a no-op
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n, 5);
});

test('owner entries, cash close and the books all tie out', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-accounts-'));
  const s = await boot({ dbDir, port: 21000 + Math.floor(Math.random() * 900) });
  const { call } = s;
  const TODAY = istDate();
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Shanti Hospitality', owner_name: 'Amit', mobile: '9876500002',
      email: 'o@shanti.in', password: 'Owner@12345', pg_name: 'Shanti PG', city: 'Pune' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);
    await call('PATCH', '/properties/settings', { gstin: '27ABCDE1234F1Z5', gst_enabled: true, rent_gst_rate_bp: 0 });

    // Beds and two guests
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    r = await call('POST', '/rooms', { floor_id: r.body.id, room_number: '101' });
    const room = r.body.id;
    const bedA = (await call('POST', '/beds', { room_id: room, bed_label: 'A', daily_rate_paise: 30000 })).body.id;
    const bedB = (await call('POST', '/beds', { room_id: room, bed_label: 'B', daily_rate_paise: 30000 })).body.id;
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000000001', bed_id: bedA, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 200), id_consent: true, id_type: 'passport', id_number: 'k1234567', rate_type: 'monthly',
      rate_paise: 900000, deposit_paise: 1000000, amount_paid_paise: 400000, payment_mode: 'cash', rent_due_day: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ravi = r.body.resident.id;
    r = await call('POST', '/residents', { full_name: 'Neha', mobile: '9000000002', bed_id: bedB, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 3), id_consent: true, id_type: 'passport', id_number: 'k7654321', rate_type: 'daily', rate_paise: 60000 });
    const neha = r.body.resident.id;

    // Guest payment by UPI, an item with 18% GST, a discount, expenses
    r = await call('POST', '/payments', { resident_id: ravi, amount_paise: 250000, type: 'rent', payment_mode: 'upi' }, { 'Idempotency-Key': 'p1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/addons/catalog', { name: 'Laundry', default_price_paise: 11800, gst_rate_bp: 1800, gst_inclusive: true });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    const laundry = r.body.id || (r.body.item && r.body.item.id);
    r = await call('POST', `/residents/${neha}/addons`, { items: [{ catalog_item_id: laundry, quantity: 1 }], billing_mode: 'monthly_bill' });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    r = await call('POST', `/residents/${neha}/discount`, { amount_paise: 10000, reason: 'Regular guest' });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    r = await call('POST', '/expenses', { category: 'Electricity', amount_paise: 150000, expense_date: TODAY, payment_mode: 'cash' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/expenses', { category: 'Internet', amount_paise: 80000, expense_date: TODAY, payment_mode: 'upi' });

    // ── Owner entries
    const entry = (b, key) => call('POST', '/accounts/entries', b, key ? { 'Idempotency-Key': key } : {});
    r = await entry({ type: 'owner_in', amount_paise: 5000000, mode: 'bank_transfer', opening: true, note: 'Bank balance when we started' }, 'k1');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await entry({ type: 'owner_in', amount_paise: 5000000, mode: 'bank_transfer', opening: true }, 'k1');
    assert.equal(r.status, 409, 'same Idempotency-Key twice is refused (double tap)');
    r = await entry({ type: 'owner_in', amount_paise: 200000, mode: 'cash', note: 'Change for the drawer' });
    assert.equal(r.status, 201);
    r = await entry({ type: 'owner_out', amount_paise: 300000, mode: 'cash', note: 'Personal' });
    assert.equal(r.status, 201);
    const drawingsId = r.body.entry.id;
    r = await entry({ type: 'other_income', amount_paise: 50000, mode: 'cash', note: 'Scrap sale' });
    assert.equal(r.status, 201);
    r = await entry({ type: 'to_bank', amount_paise: 100000 });
    assert.equal(r.status, 201);
    assert.equal(r.body.entry.mode, null);
    r = await entry({ type: 'from_bank', amount_paise: 20000 });
    assert.equal(r.status, 201);

    // Bad input is refused
    assert.equal((await entry({ type: 'other_income', amount_paise: 100, mode: 'cash' })).status, 400, 'other income needs a note');
    assert.equal((await entry({ type: 'owner_in', amount_paise: 100 })).status, 400, 'mode required');
    assert.equal((await entry({ type: 'owner_in', amount_paise: -5, mode: 'cash' })).status, 400);
    assert.equal((await entry({ type: 'owner_in', amount_paise: '12abc', mode: 'cash' })).status, 400);
    assert.equal((await entry({ type: 'magic', amount_paise: 100, mode: 'cash' })).status, 400);
    assert.equal((await entry({ type: 'owner_in', amount_paise: 100, mode: 'cash', date: addDays(TODAY, 1) })).status, 400, 'no future dates');

    // Reverse the drawings entry (owner only, reason needed)
    r = await call('POST', `/ledger/entries/${drawingsId}/reverse`, { reason: 'Entered by mistake' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('GET', `/accounts/entries?from=${TODAY}&to=${TODAY}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.rows.find((x) => x.id === drawingsId).is_reversed);
    assert.equal(r.body.rows.filter((x) => x.is_reversal).length, 1);

    // ── Cash drawer: guest cash + owner cash + other income + from bank − expense − to bank
    // cash in: deposit 10,000 + advance 4,000 + owner 2,000 + scrap 500 + from bank 200 = 16,700
    // cash out: electricity 1,500 + to bank 1,000 + drawings 3,000 − 3,000 (reversed) = 2,500
    r = await call('GET', `/reports/daily/cash-book?date=${TODAY}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.drawer.cash_in_paise, 1670000);
    assert.equal(r.body.drawer.cash_out_paise, 250000);
    assert.ok(r.body.entries.some((e) => e.kind === 'OWNER_IN'), 'owner entries show in the cash book');

    // Close the day with an opening float of ₹1,000 and ₹50 short
    const expected = 100000 + 1670000 - 250000;
    r = await call('POST', '/reconciliation/cash', { date: TODAY, opening_cash_paise: 100000, drawer_amount_paise: expected - 5000 });
    assert.ok(r.status < 300, 'cash close: ' + JSON.stringify(r.body));

    // ── Books
    const tb = (await call('GET', `/accounts/trial-balance?to=${TODAY}`)).body;
    assert.equal(tb.balanced, true, JSON.stringify(tb));
    assert.equal(tb.total_debit, tb.total_credit);
    const acct = (k) => tb.rows.find((x) => x.key === k) || { debit: 0, credit: 0 };
    // Books cash = what was counted in the drawer
    assert.equal(acct('cash').debit, expected - 5000, 'cash in hand matches the counted drawer');
    // Bank: opening 50,000 + UPI payment 2,500 + to bank 1,000 − internet 800 − from bank 200 = 52,500
    assert.equal(acct('bank').debit, 5250000);
    assert.equal(acct('deposits').credit, 1000000);
    assert.equal(acct('opening').credit, 5000000 + 100000, 'bank opening + drawer opening');
    assert.equal(acct('capital').credit, 200000);
    assert.equal(acct('drawings').debit + acct('drawings').credit, 0, 'reversed drawings net to zero');
    assert.equal(acct('cash_diff').debit, 5000, 'cash short is an expense');
    assert.equal(acct('gst').credit, 1800, 'GST on laundry is a liability, not income');
    assert.equal(acct('income:other_income').credit, 50000);

    const bs = (await call('GET', `/accounts/balance-sheet?to=${TODAY}`)).body;
    assert.equal(bs.balanced, true, JSON.stringify(bs));
    assert.equal(bs.total_assets, bs.total_liabilities + bs.total_equity);
    assert.deepEqual(bs.warnings, []);

    const pl = (await call('GET', `/accounts/profit-loss?from=${TODAY}&to=${TODAY}`)).body;
    assert.equal(pl.profit, pl.total_income - pl.total_expenses);
    const eqProfit = bs.equity.find((x) => x.name === 'Profit to date').amount;
    assert.equal(eqProfit, pl.profit, 'balance sheet profit = P&L profit (everything is this month)');
    assert.ok(pl.expenses.find((x) => x.name === 'Discounts given' && x.amount === 10000));

    // Ledger for cash: opening 0 before today, closing = trial balance
    const cl = (await call('GET', `/accounts/ledger?account=cash&from=${TODAY}&to=${TODAY}`)).body;
    assert.equal(cl.closing, acct('cash').debit);
    assert.equal(cl.opening + cl.total_debit - cl.total_credit, cl.closing);
    assert.equal((await call('GET', '/accounts/ledger?account=nope')).status, 400);

    const dbk = (await call('GET', `/accounts/day-book?from=${TODAY}&to=${TODAY}`)).body;
    for (const row of dbk.rows) {
      const d = row.debit.reduce((a, x) => a + x.amount, 0), c = row.credit.reduce((a, x) => a + x.amount, 0);
      assert.equal(d, c, `every day-book line balances: ${row.label}`);
    }
    const ch = (await call('GET', '/accounts/chart')).body;
    assert.ok(ch.find((a) => a.key === 'cash') && ch.find((a) => a.key === 'expense:electricity'));

    // Monthly summary counts other income
    const ms = (await call('GET', `/reports/monthly?month=${TODAY.slice(0, 7)}`)).body;
    assert.ok(ms.income.find((x) => /Other income/.test(x.head) && x.amount === 50000), JSON.stringify(ms.income));

    // Day is closed: a back-dated entry moves to the next open day, never into the closed day
    r = await entry({ type: 'owner_in', amount_paise: 1000, mode: 'cash', date: TODAY });
    assert.equal(r.status, 201);
    assert.equal(r.body.entry.biz_date, addDays(TODAY, 1));
    assert.equal(r.body.moved_to_date, addDays(TODAY, 1));

    // Integrity check still clean
    r = await call('GET', '/ledger/integrity');
    assert.equal(r.body.ok, true, JSON.stringify(r.body));

    // Staff without finance rights cannot read books; managers cannot record owner money
    r = await call('POST', '/staff', { name: 'Desk', mobile: '9000000077', role: 'reception', password: 'Desk@12345' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/staff', { name: 'Mgr', mobile: '9000000078', role: 'manager', password: 'Mgr@123456' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken((await call('POST', '/auth/login', { mobile: '9000000077', password: 'Desk@12345' })).body.token);
    assert.equal((await call('GET', '/accounts/trial-balance')).status, 403);
    s.setToken((await call('POST', '/auth/login', { mobile: '9000000078', password: 'Mgr@123456' })).body.token);
    assert.equal((await call('GET', '/accounts/trial-balance')).status, 200, 'manager can read the books');
    assert.equal((await entry({ type: 'owner_in', amount_paise: 100, mode: 'cash' })).status, 403, 'only the owner records owner money');

    assert.ok(!/\[ERROR\]|UNCAUGHT|UNHANDLED/.test(s.logs.join('')), 'no server errors:\n' + s.logs.join(''));
  } finally { s.stop(); }
});
