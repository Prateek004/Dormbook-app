'use strict';
// Staff salary (advances / owed, month by month) and purchases: saved through the
// protected ledger, counted in cash close, and balanced in the books.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');
const { istDate } = require('../src/util/time');
const { schedule } = require('../src/services/payroll');

const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

test('salary schedule: full months, pro-rata joining and leaving, salary changes', () => {
  const rates = [{ from_month: '2026-01', amount_paise: 1500000 }, { from_month: '2026-03', amount_paise: 2000000 }];
  const s = schedule({ joined_on: '2026-01-16', left_on: '2026-03-10' }, rates, '2026-09-30');
  assert.deepEqual(s.map((m) => [m.month, m.due_paise]), [
    ['2026-01', Math.round(1500000 * 16 / 31)],   // 16..31 January
    ['2026-02', 1500000],
    ['2026-03', Math.round(2000000 * 10 / 31)],   // new salary, 1..10 March
  ]);
  assert.equal(s[0].date, '2026-01-16');
  assert.deepEqual(schedule({ joined_on: '2026-10-01' }, rates, '2026-09-30'), [], 'nothing due before joining');
  assert.equal(schedule({ joined_on: '2026-01-01' }, [], '2026-02-10').reduce((a, m) => a + m.due_paise, 0), 0, 'no salary set = nothing due');
});

test('staff salary advances and dues, purchases, cash close and books', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-payroll-'));
  const s = await boot({ dbDir, port: 22000 + Math.floor(Math.random() * 900) });
  const { call } = s;
  const TODAY = istDate(), THIS = TODAY.slice(0, 7), LAST = prevMonth(THIS);
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Shanti Hospitality', owner_name: 'Amit', mobile: '9876500003',
      email: 'p@shanti.in', password: 'Owner@12345', pg_name: 'Shanti PG', city: 'Pune' });
    s.setToken(r.body.token);
    const ownerToken = r.body.token;

    // ── Staff: Ramesh (manager) ₹15,000 from the 1st of last month
    r = await call('POST', '/payroll/staff', { name: 'Ramesh', designation: 'Manager', mobile: '9000011111',
      monthly_salary_paise: 1500000, joined_on: `${LAST}-01` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ramesh = r.body.id;
    r = await call('POST', '/payroll/staff', { name: 'Sita', designation: 'Cook', monthly_salary_paise: 1200000, joined_on: `${THIS}-01` });
    const sita = r.body.id;
    // bad input
    assert.equal((await call('POST', '/payroll/staff', { name: '', monthly_salary_paise: 100 })).status, 400);
    assert.equal((await call('POST', '/payroll/staff', { name: 'X', monthly_salary_paise: -1 })).status, 400);
    assert.equal((await call('POST', '/payroll/staff', { name: 'X', monthly_salary_paise: 100, mobile: '12' })).status, 400);

    // Your example: salary 15,000 — paid 18,000 last month, 25,000 this month
    const pay = (id, b) => call('POST', `/payroll/staff/${id}/pay`, b);
    r = await pay(ramesh, { amount_paise: 1800000, mode: 'cash', month: LAST, note: 'Salary + 3,000 advance' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await pay(ramesh, { amount_paise: 2500000, mode: 'upi', month: THIS });
    assert.equal(r.status, 201);
    assert.equal(r.body.balance_paise, 3000000 - 4300000, '₹13,000 advance');
    assert.equal((await pay(ramesh, { amount_paise: 0, mode: 'cash', month: THIS })).status, 400);
    assert.equal((await pay(ramesh, { amount_paise: 100, mode: 'cash', month: '2026-13' })).status, 400);
    assert.equal((await pay(ramesh, { amount_paise: 100, month: THIS })).status, 400, 'mode required');
    assert.equal((await pay('nope', { amount_paise: 100, mode: 'cash', month: THIS })).status, 404);

    r = await call('GET', `/payroll/staff/${ramesh}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.statement.map((m) => [m.month, m.salary_paise, m.paid_paise, m.balance_paise]), [
      [LAST, 1500000, 1800000, -300000],        // 3,000 advance after last month
      [THIS, 1500000, 2500000, -1300000],       // 13,000 advance now
    ]);

    // Salary raised to 20,000 from this month → due 35,000, paid 43,000 → 8,000 advance
    r = await call('POST', `/payroll/staff/${ramesh}/salary`, { monthly_salary_paise: 2000000, from_month: THIS });
    assert.equal(r.status, 201);
    r = await call('GET', '/payroll/staff');
    const R = r.body.staff.find((x) => x.id === ramesh);
    assert.equal(R.monthly_salary_paise, 2000000);
    assert.equal(R.balance_paise, -800000);
    const S = r.body.staff.find((x) => x.id === sita);
    assert.equal(S.balance_paise, 1200000, 'Sita is owed this month\'s salary');
    assert.equal(r.body.totals.owed, 1200000);
    assert.equal(r.body.totals.advance, 800000);
    assert.equal((await call('POST', `/payroll/staff/${ramesh}/salary`, { monthly_salary_paise: 100, from_month: '2020-01' })).status, 400, 'before joining');

    // Undo a salary payment (owner, reason) → advance shrinks
    const lastPay = (await call('GET', `/payroll/staff/${ramesh}`)).body.payments.find((p) => p.month === LAST);
    r = await call('POST', `/ledger/entries/${lastPay.id}/reverse`, { reason: 'Wrong amount' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await pay(ramesh, { amount_paise: 1500000, mode: 'cash', month: LAST, note: 'Corrected' });
    assert.equal(r.body.balance_paise, 3500000 - 4000000, '5,000 advance after the correction');

    // ── Purchase: 4 blankets × 450 + 2 pillows × 200 = 2,200, cash
    r = await call('POST', '/purchases', { date: TODAY, vendor: 'Laxmi Stores', bill_no: 'LS-104', category: 'Bedding & linen',
      mode: 'cash', items: [{ item: 'Blanket', qty: 4, unit: 'pcs', rate_paise: 45000 }, { item: 'Pillow', qty: 2, rate_paise: 20000 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total_paise, 220000);
    const purchaseLedger = r.body.entry.id;
    r = await call('POST', '/purchases', { date: TODAY, category: 'Kitchen & utensils', mode: 'upi', items: [{ item: 'Pressure cooker', qty: 1, rate_paise: 180000 }] });
    assert.equal(r.status, 201);
    // bad bills
    assert.equal((await call('POST', '/purchases', { mode: 'cash', items: [] })).status, 400);
    assert.equal((await call('POST', '/purchases', { mode: 'cash', items: [{ item: '', qty: 1, rate_paise: 1 }] })).status, 400);
    assert.equal((await call('POST', '/purchases', { mode: 'cash', items: [{ item: 'A', qty: 0, rate_paise: 1 }] })).status, 400);
    assert.equal((await call('POST', '/purchases', { mode: 'cheque', items: [{ item: 'A', qty: 1, rate_paise: 1 }] })).status, 400);
    assert.equal((await call('POST', '/purchases', { mode: 'cash', items: [{ item: 'A', qty: 1, rate_paise: 0 }] })).status, 400, 'zero total');

    r = await call('GET', `/purchases?from=${TODAY}&to=${TODAY}`);
    assert.equal(r.body.purchases.length, 2);
    assert.equal(r.body.total, 400000);
    assert.equal(r.body.purchases.find((p) => p.vendor === 'Laxmi Stores').items.length, 2);

    // Undo the kitchen purchase
    const kitchen = r.body.purchases.find((p) => p.category === 'Kitchen & utensils');
    r = await call('POST', `/ledger/entries/${kitchen.ledger_id}/reverse`, { reason: 'Returned to shop' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('GET', `/purchases?from=${TODAY}&to=${TODAY}`);
    assert.ok(r.body.purchases.find((p) => p.id === kitchen.id).cancelled);
    assert.equal(r.body.total, 220000, 'undone purchase not counted');

    // ── Cash book / drawer: salary + purchase in cash are cash out
    r = await call('GET', `/reports/daily/cash-book?date=${TODAY}`);
    assert.ok(r.body.entries.some((e) => e.kind === 'SALARY' && e.resident === 'Ramesh'), 'salary shows with the staff name');
    assert.ok(r.body.entries.some((e) => e.kind === 'PURCHASE'));
    // cash out today: 18,000 (then reversed −18,000) + 15,000 salary + 2,200 purchase = 17,200
    assert.equal(r.body.drawer.cash_out_paise, 1720000);

    // ── Books balance and show salary advances / owed
    const tb = (await call('GET', `/accounts/trial-balance?to=${TODAY}`)).body;
    assert.equal(tb.balanced, true);
    const bs = (await call('GET', `/accounts/balance-sheet?to=${TODAY}`)).body;
    assert.equal(bs.balanced, true, JSON.stringify(bs));
    assert.equal(bs.assets.find((x) => x.name === 'Salary advances to staff').amount, 500000);
    assert.equal(bs.liabilities.find((x) => x.name === 'Salary owed to staff').amount, 1200000);
    const pl = (await call('GET', `/accounts/profit-loss?from=${LAST}-01&to=${TODAY}`)).body;
    assert.equal(pl.expenses.find((x) => x.name === 'Staff salaries').amount, 1500000 + 2000000 + 1200000);
    assert.equal(pl.expenses.find((x) => x.name === 'Purchases: Bedding & linen').amount, 220000);
    assert.ok(!pl.expenses.find((x) => x.name === 'Purchases: Kitchen & utensils'), 'undone purchase nets to zero');
    const led = (await call('GET', `/accounts/ledger?account=salary&from=${LAST}-01&to=${TODAY}`)).body;
    assert.equal(led.closing, 500000 - 1200000, 'salary account = advances − owed');

    // Monthly summary counts salaries and purchases as money out
    const ms = (await call('GET', `/reports/monthly?month=${THIS}`)).body;
    assert.ok(ms.expenses.find((x) => x.head === 'Staff salaries'), JSON.stringify(ms.expenses));
    assert.ok(ms.expenses.find((x) => x.head === 'Purchases: Bedding & linen'));

    r = await call('GET', '/ledger/integrity');
    assert.equal(r.body.ok, true, JSON.stringify(r.body));

    // ── Who can do what
    await call('POST', '/staff', { name: 'Mgr', mobile: '9000000088', role: 'manager', password: 'Mgr@123456' });
    await call('POST', '/staff', { name: 'Desk', mobile: '9000000089', role: 'reception', password: 'Desk@12345' });
    s.setToken((await call('POST', '/auth/login', { mobile: '9000000088', password: 'Mgr@123456' })).body.token);
    assert.equal((await call('GET', '/payroll/staff')).status, 403, 'salaries are owner-only');
    assert.equal((await call('POST', '/purchases', { mode: 'cash', items: [{ item: 'Soap', qty: 2, rate_paise: 4000 }] })).status, 201, 'manager can record purchases');
    s.setToken((await call('POST', '/auth/login', { mobile: '9000000089', password: 'Desk@12345' })).body.token);
    assert.equal((await call('GET', '/purchases')).status, 403);
    s.setToken(ownerToken);

    // Staff leaves: no salary due after the leaving day
    r = await call('PATCH', `/payroll/staff/${sita}`, { left_on: `${THIS}-01` });
    assert.equal(r.status, 200);
    r = await call('GET', `/payroll/staff/${sita}`);
    assert.equal(r.body.due_paise, Math.round(1200000 / Number(new Date(Date.UTC(+THIS.slice(0, 4), +THIS.slice(5), 0)).getUTCDate())), 'one day of salary');

    assert.ok(!/\[ERROR\]|UNCAUGHT|UNHANDLED/.test(s.logs.join('')), 'no server errors:\n' + s.logs.join(''));
  } finally { s.stop(); }
});
