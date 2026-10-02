'use strict';
// Data isolation ("row level security"): one PG business must never see or change another's data.
// Builds PG A with every kind of record, then uses PG B's logins (owner and reception) and the
// super-admin to read and change A's records by id, by request body and through every list.
// Afterwards A's data must be exactly as before, and no A detail may appear in any B response.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
const MONTH = TODAY.slice(0, 7);
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

// Strings that exist ONLY in PG A. None may ever appear in a response given to PG B.
const SECRETS = ['Alpha Secret Guest', '9000077771', 'ALPHAUPI@okaxis', 'Alpha Hidden Expense', 'Alpha Cook Kamla',
  'Alpha Desk Person', '9000077772', 'Alpha Prospect', 'Alpha Vendor Stores', 'Alpha Hospitality', 'Alpha Dorm'];

async function json(s, method, p, body, headers) { return s.call(method, p, body, headers); }

test('PG B (owner, staff) and the super-admin cannot read or change PG A data', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-iso-'));
  const s = await boot({ dbDir, port: 22000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  const ok = (r, msg) => assert.ok(r.status >= 200 && r.status < 300, `${msg}: ${r.status} ${JSON.stringify(r.body)}`);
  try {
    // ───────────── PG A: one of everything ─────────────
    let r = await call('POST', '/auth/register', { business_name: 'Alpha Hospitality', owner_name: 'Alpha Owner', mobile: '9876577770',
      password: 'Passw0rd!23', pg_name: 'Alpha Dorm', city: 'Pune' });
    ok(r, 'register A');
    const tokenA = r.body.token; s.setToken(tokenA);
    const A = {};
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' }); ok(r, 'A floor'); A.floor = r.body.id;
    r = await call('POST', `/floors/${A.floor}/bunkers`, { bunkers: 2, beds_per_bunker: 2, daily_rate_paise: 40000 }); ok(r, 'A beds');
    r = await call('POST', '/rooms', { floor_id: A.floor, room_number: '101' }); ok(r, 'A room'); A.room = r.body.id;
    r = await call('POST', '/beds', { room_id: A.room, bed_label: 'A', daily_rate_paise: 30000 }); ok(r, 'A bed in room'); A.roomBed = r.body.id;
    const bedsA = (await call('GET', '/beds')).body;
    A.bed = bedsA[0].id; A.freeBed = bedsA[1].id;
    r = await call('POST', '/residents', { full_name: 'Alpha Secret Guest', mobile: '9000077771', bed_id: A.bed, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 5), id_consent: true, rate_type: 'daily', rate_paise: 40000, id_type: 'pan', id_number: 'abcde1234f' });
    ok(r, 'A resident'); A.res = r.body.resident.id;
    r = await call('POST', `/residents/${A.res}/documents`, { doc_type: 'id_front', data_url: JPEG }); ok(r, 'A doc'); A.doc = r.body.id;
    r = await call('POST', '/payments', { resident_id: A.res, amount_paise: 50000, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': 'a-pay' });
    ok(r, 'A payment'); A.payment = r.body.payment.id;
    await new Promise((res) => setTimeout(res, 400));   // the receipt is made in the background
    { const Database = require('better-sqlite3'); const d = new Database(path.join(dbDir, 'dormbook.db'), { readonly: true });
      A.receipt = (d.prepare('SELECT receipt_number FROM receipts WHERE payment_ledger_id = ?').get(A.payment) || {}).receipt_number; d.close(); }
    r = await call('POST', '/addons/catalog', { name: 'Alpha Tea', default_price_paise: 1000 }); ok(r, 'A catalog'); A.cat = r.body.id;
    r = await call('POST', `/residents/${A.res}/addons`, { items: [{ catalog_item_id: A.cat, quantity: 1 }], billing_mode: 'monthly_bill' }); ok(r, 'A addon');
    r = await call('POST', '/expenses', { category: 'Electricity', amount_paise: 150000, expense_date: TODAY, payment_mode: 'cash', description: 'Alpha Hidden Expense' });
    ok(r, 'A expense'); A.exp = r.body.id;
    r = await call('POST', '/staff', { name: 'Alpha Desk Person', mobile: '9000077772', role: 'reception', password: 'Desk@12345' }); ok(r, 'A staff');
    A.staff = r.body.id || (r.body.user && r.body.user.id);
    r = await call('POST', '/bookings', { bed_id: A.freeBed, prospect_name: 'Alpha Prospect', prospect_phone: '9000077773' }); ok(r, 'A booking');
    A.booking = r.body.id || r.body.booking_id;
    r = await call('POST', '/reconciliation/cash', { date: TODAY, opening_cash_paise: 0, drawer_amount_paise: 1000 }); ok(r, 'A cash close');
    A.recon = r.body.id;
    r = await call('POST', '/payroll/staff', { name: 'Alpha Cook Kamla', designation: 'Cook', monthly_salary_paise: 1200000, joined_on: `${MONTH}-01` });
    ok(r, 'A payroll staff'); A.pstaff = r.body.id;
    r = await call('POST', '/purchases', { date: TODAY, vendor: 'Alpha Vendor Stores', category: 'Kitchen & utensils', mode: 'cash', items: [{ item: 'Cooker', qty: 1, rate_paise: 180000 }] });
    ok(r, 'A purchase');
    r = await call('PATCH', '/account/payment', { upi_id: 'ALPHAUPI@okaxis', upi_name: 'Alpha', bank_holder: 'Alpha' }); ok(r, 'A upi');
    { const Database = require('better-sqlite3'); const d = new Database(path.join(dbDir, 'dormbook.db'), { readonly: true });
      A.entry = (d.prepare("SELECT id FROM ledger_entries WHERE resident_id = ? AND kind = 'PAYMENT'").get(A.res) || {}).id; d.close(); }
    for (const [k, v] of Object.entries(A)) assert.ok(v, `PG A setup: ${k} id missing`);

    // Snapshot of A, compared after the attacks
    const snapPaths = ['/beds', `/residents/${A.res}`, `/residents/${A.res}/ledger`, `/residents/${A.res}/documents`, '/expenses',
      '/staff', '/bookings', '/reconciliation/cash', '/payroll/staff', '/addons/catalog', '/floors', '/account/payment', '/accounts/entries'];
    const snapshot = async () => {
      s.setToken(tokenA);
      const out = {};
      for (const p of snapPaths) {
        const res = await call('GET', p);
        // ignore fields that change by themselves with time
        out[p] = JSON.stringify(res.body, (k, v) => (['generated_at', 'now', 'today', 'days_stayed', 'nights', 'last_login_at', 'updated_at'].includes(k) ? undefined : v));
      }
      return out;
    };
    const before = await snapshot();

    // ───────────── PG B + its reception staff ─────────────
    s.setToken(null);
    r = await call('POST', '/auth/register', { business_name: 'Bravo Stays', owner_name: 'Bravo Owner', mobile: '9876588880',
      password: 'Passw0rd!23', pg_name: 'Bravo PG', city: 'Delhi' });
    ok(r, 'register B');
    const tokenB = r.body.token; s.setToken(tokenB);
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' }); const floorB = r.body.id;
    await call('POST', `/floors/${floorB}/bunkers`, { bunkers: 1, beds_per_bunker: 2, daily_rate_paise: 30000 });
    const bedB = (await call('GET', '/beds')).body[0].id;
    r = await call('POST', '/residents', { full_name: 'Bravo Guest', mobile: '9000088881', bed_id: bedB, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 3), id_consent: true, rate_type: 'daily', rate_paise: 30000, id_type: 'pan', id_number: 'bcdef2345g' });
    ok(r, 'B resident'); const resB = r.body.resident.id;
    r = await call('POST', '/staff', { name: 'Bravo Desk', mobile: '9000088882', role: 'reception', password: 'Desk@12345' }); ok(r, 'B staff');
    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9000088882', password: 'Desk@12345' }); ok(r, 'B staff login');
    const tokenBDesk = r.body.token;
    r = await call('POST', '/auth/login', { email: 'superadmin@dormbook.in', password: 'Sup3r!secret' }); ok(r, 'superadmin login');
    const tokenSuper = r.body.token;

    // Every way to touch an A record by id or by body
    const attacks = [
      ['GET', `/residents/${A.res}`], ['GET', `/residents/${A.res}/ledger`], ['GET', `/residents/${A.res}/documents`],
      ['GET', `/residents/${A.res}/documents/${A.doc}`], ['GET', `/residents/${A.res}/bill`], ['GET', `/residents/${A.res}/statement`],
      ['GET', `/residents/${A.res}/checkout-preview`], ['GET', `/residents/${A.res}/refund-summary`], ['GET', `/residents/${A.res}/addons`],
      ['GET', `/beds/${A.bed}`], ['GET', `/payroll/staff/${A.pstaff}`],
      ['GET', `/receipts/${A.receipt}`], ['GET', `/receipts/${A.receipt}/pdf`], ['POST', `/receipts/${A.receipt}/resend`, {}],
      ['POST', `/residents/${A.res}/documents`, { doc_type: 'photo', data_url: JPEG }],
      ['DELETE', `/residents/${A.res}/documents/${A.doc}`],
      ['POST', `/residents/${A.res}/checkout`, { checkout_date: TODAY }], ['POST', `/residents/${A.res}/checkout/approve`, { decision: 'approved' }],
      ['POST', `/residents/${A.res}/extend`, { new_expected_checkout: addDays(TODAY, 30) }], ['PATCH', `/residents/${A.res}/rent`, { rate_paise: 1 }],
      ['POST', `/residents/${A.res}/discount`, { amount_paise: 100, reason: 'x' }], ['POST', `/residents/${A.res}/bill-link`, {}],
      ['POST', `/residents/${A.res}/refund-deductions`, { amount_paise: 100, reason: 'x' }],
      ['POST', `/residents/${A.res}/addons`, { name: 'Hack', amount_paise: 100, billing_mode: 'monthly_bill' }],
      ['POST', `/residents/${resB}/addons`, { items: [{ catalog_item_id: A.cat, quantity: 1 }], billing_mode: 'monthly_bill' }],
      ['POST', '/payments', { resident_id: A.res, amount_paise: 100, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': 'x1' }],
      ['POST', `/payments/${A.payment}/approve`, { decision: 'approved' }],
      ['POST', '/residents', { full_name: 'Intruder', mobile: '9000099991', bed_id: A.freeBed, check_in_date: TODAY, expected_checkout: addDays(TODAY, 2),
        id_consent: true, rate_type: 'daily', rate_paise: 100, id_type: 'pan', id_number: 'cdefg3456h' }],
      ['PATCH', `/beds/${A.bed}/status`, { status: 'maintenance' }], ['PATCH', `/beds/${A.freeBed}/status`, { status: 'maintenance' }],
      ['PATCH', `/beds/${A.bed}/rate`, { daily_rate_paise: 1 }], ['PATCH', '/beds/bulk-rate', { bed_ids: [A.bed, A.freeBed], daily_rate_paise: 1 }],
      ['PATCH', '/beds/names', { beds: [{ id: A.freeBed, label: 'HACKED' }] }],
      ['PATCH', '/beds/names', { floors: [{ id: A.floor, label: 'HACKED' }] }], ['PATCH', '/beds/names', { rooms: [{ id: A.room, label: 'HACKED' }] }],
      ['DELETE', `/beds/${A.freeBed}`], ['DELETE', `/beds/${A.roomBed}`], ['DELETE', `/rooms/${A.room}`], ['DELETE', `/floors/${A.floor}`],
      ['POST', '/rooms', { floor_id: A.floor, room_number: '999' }], ['POST', '/beds', { room_id: A.room, bed_label: 'Z', daily_rate_paise: 1 }],
      ['POST', `/floors/${A.floor}/bunkers`, { bunkers: 1, beds_per_bunker: 1 }], ['POST', `/rooms/${A.room}/beds`, { label: 'Z9' }],
      ['PATCH', `/expenses/${A.exp}`, { amount_paise: 1 }], ['DELETE', `/expenses/${A.exp}`],
      ['PATCH', `/staff/${A.staff}`, { is_active: false }], ['PATCH', `/staff/${A.staff}`, { password: 'Hacked@12345' }],
      ['DELETE', `/staff/${A.staff}`], ['POST', `/staff/${A.staff}/login-code`, {}],
      ['POST', '/bookings', { bed_id: A.freeBed, prospect_name: 'X', prospect_phone: '9000099992' }],
      ['POST', `/bookings/${A.booking}/confirm`, {}], ['POST', `/bookings/${A.booking}/cancel`, {}],
      ['PATCH', `/reconciliation/cash/${A.recon}/explain`, { note: 'hacked' }],
      ['POST', `/ledger/entries/${A.entry}/reverse`, { reason: 'hacked' }],
      ['PATCH', `/payroll/staff/${A.pstaff}`, { left_on: `${MONTH}-02` }],
      ['POST', `/payroll/staff/${A.pstaff}/salary`, { monthly_salary_paise: 1, from_month: MONTH }],
      ['POST', `/payroll/staff/${A.pstaff}/pay`, { month: MONTH, amount_paise: 100, mode: 'cash' }],
      ['PATCH', `/addons/catalog/${A.cat}`, { is_active: false }],
      ['PATCH', `/feedback/${A.res}/resolve`, { notes: 'x' }],
    ];
    // Lists / reports: must not contain anything of A
    const lists = ['/beds', '/floors', '/residents', '/residents?status=all', '/expenses', '/staff', '/bookings', '/reconciliation/cash',
      '/payroll/staff', '/purchases', '/addons/catalog', '/feedback', '/audit', '/dashboard/summary', '/dashboard/today',
      '/reports/summary', '/reports/monthly', `/reports/daily/snapshot?date=${TODAY}`, `/reports/daily/bed-map?date=${TODAY}`,
      `/reports/daily/movements?date=${TODAY}`, `/reports/daily/cash-book?date=${TODAY}`, '/reports/daily/dues', '/payments/pending-approvals',
      '/accounts/chart', '/accounts/day-book', '/accounts/entries', '/accounts/trial-balance', '/accounts/profit-loss', '/accounts/balance-sheet',
      '/account/payment', '/properties/profile', '/properties/settings', '/ledger/integrity', '/reports/registers',
      `/reports/export?from=${TODAY}&to=${TODAY}&format=csv`, `/reconciliation/cash/preview?date=${TODAY}`];
    const regs = (await call('GET', '/reports/registers')).body;
    for (const g of (Array.isArray(regs) ? regs : regs.registers || [])) lists.push(`/reports/registers/${g.id || g.type}?from=${addDays(TODAY, -7)}&to=${TODAY}`);
    const ledgerAccounts = (await call('GET', '/accounts/chart')).body;
    for (const a of (Array.isArray(ledgerAccounts) ? ledgerAccounts : ledgerAccounts.accounts || []).slice(0, 40)) {
      lists.push(`/accounts/ledger?account=${encodeURIComponent(a.code || a.id || a.key || a.name)}&from=${addDays(TODAY, -7)}&to=${TODAY}`);
    }
    // Ask the lists FOR A explicitly too (query / body property_id must be ignored or refused)
    lists.push(`/residents?property_id=${'x'}`);

    const leaks = [];
    const check = (who, method, p, res) => {
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      const hit = SECRETS.find((x) => text.includes(x)) || Object.values(A).find((id) => typeof id === 'string' && id.length > 8 && text.includes(id));
      if (hit) leaks.push(`${who} ${method} ${p} -> ${res.status} shows A's "${hit}"`);
    };
    for (const [who, token] of [['B-owner', tokenB], ['B-reception', tokenBDesk], ['superadmin', tokenSuper]]) {
      for (const [method, p, body, headers] of attacks) {
        s.setToken(token);
        const res = await call(method, p, body, headers);
        check(who, method, p, res);
        // Super-admin may refuse with 403 for writes; for reads it must not get private guest data
        if (res.status >= 200 && res.status < 300 && method !== 'GET') leaks.push(`${who} ${method} ${p} -> ${res.status} (write was accepted)`);
      }
      for (const p of lists) {
        s.setToken(token);
        check(who, 'GET', p, await call('GET', p));
      }
    }
    assert.deepEqual(leaks, [], 'cross-PG access found:\n' + leaks.join('\n'));

    // A unchanged by all of it
    const after = await snapshot();
    for (const p of snapPaths) assert.equal(after[p], before[p], `PG A data changed: ${p}`);
  } finally {
    s.stop();
  }
});

test('inside one PG: reception sees only what its role allows; a user-manager cannot take over a bigger login', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-role-'));
  const s = await boot({ dbDir, port: 23000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  const ok = (r, msg) => assert.ok(r.status >= 200 && r.status < 300, `${msg}: ${r.status} ${JSON.stringify(r.body)}`);
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Role Test', owner_name: 'Owner', mobile: '9876566660',
      password: 'Passw0rd!23', pg_name: 'Role PG', city: 'Pune' });
    ok(r, 'register'); s.setToken(r.body.token);
    r = await call('POST', '/floors', { floor_number: 0, label: 'G' });
    await call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 1, beds_per_bunker: 2, daily_rate_paise: 40000 });
    const bed = (await call('GET', '/beds')).body[0].id;
    r = await call('POST', '/residents', { full_name: 'Guest One', mobile: '9000066661', bed_id: bed, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 3), id_consent: true, rate_type: 'daily', rate_paise: 40000, id_type: 'pan', id_number: 'abcde1234f' });
    ok(r, 'resident'); const res = r.body.resident.id;
    r = await call('POST', `/residents/${res}/documents`, { doc_type: 'id_front', data_url: JPEG }); const doc = r.body.id;
    r = await call('POST', '/staff', { name: 'Desk', mobile: '9000066662', role: 'reception', password: 'Desk@12345' }); ok(r, 'desk');
    r = await call('POST', '/staff', { name: 'Big Manager', mobile: '9000066663', role: 'manager', password: 'Mgr@123456' }); ok(r, 'manager');
    const big = r.body.id;
    // "Lead": reception who may manage users, but has no money/approval powers
    r = await call('POST', '/staff', { name: 'Lead', mobile: '9000066664', role: 'reception', password: 'Lead@12345', permissions: ['checkin', 'payments', 'staff'] });
    ok(r, 'lead');
    r = await call('POST', '/staff', { name: 'Small', mobile: '9000066665', role: 'reception', password: 'Small@12345', permissions: ['checkin'] });
    ok(r, 'small'); const small = r.body.id;

    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9000066662', password: 'Desk@12345' }); ok(r, 'desk login'); const desk = r.body.token;
    r = await call('POST', '/auth/login', { mobile: '9000066664', password: 'Lead@12345' }); ok(r, 'lead login'); const lead = r.body.token;

    // Reception (default role) must be refused all of these
    s.setToken(desk);
    const refused = [
      ['GET', '/audit'], ['GET', '/staff'], ['GET', '/payroll/staff'], ['GET', '/expenses'], ['GET', '/reports/daily/dues'],
      ['GET', '/accounts/day-book'], ['GET', '/accounts/profit-loss'], ['GET', `/residents/${res}/documents/${doc}`],
      ['GET', '/properties/settings'], ['GET', '/account/payment'], [`GET`, `/reports/export?from=${TODAY}&to=${TODAY}&format=csv`],
      ['POST', '/accounts/entries', { kind: 'OWNER_IN', amount_paise: 100, mode: 'cash' }], ['PATCH', '/properties/settings', { address: 'x' }],
      ['PATCH', '/account/payment', { upi_id: 'x@okaxis' }], ['PATCH', `/beds/${bed}/rate`, { daily_rate_paise: 1 }],
      ['POST', `/residents/${res}/discount`, { amount_paise: 100, reason: 'x' }], ['PATCH', `/residents/${res}/rent`, { rate_paise: 1 }],
      ['POST', '/staff', { name: 'X', mobile: '9000066669', role: 'manager', password: 'Xyz@123456' }], ['DELETE', `/staff/${big}`],
      ['DELETE', `/residents/${res}/documents/${doc}`],
    ];
    const allowedWrongly = [];
    for (const [m, p, b] of refused) {
      const x = await call(m, p, b);
      if (x.status !== 403) allowedWrongly.push(`reception ${m} ${p} -> ${x.status}`);
    }
    // A user-manager with less access than "Big Manager" cannot take that login over
    s.setToken(lead);
    const takeover = [
      ['PATCH', `/staff/${big}`, { new_password: 'Taken@12345' }], ['POST', `/staff/${big}/login-code`, {}],
      ['DELETE', `/staff/${big}`], ['PATCH', `/staff/${small}`, { role: 'manager' }],
      ['PATCH', `/staff/${small}`, { permissions: ['checkin', 'approvals'] }],
      ['POST', '/staff', { name: 'New Mgr', mobile: '9000066667', role: 'manager', password: 'Xyz@123456' }],
    ];
    for (const [m, p, b] of takeover) {
      const x = await call(m, p, b);
      if (x.status !== 403) allowedWrongly.push(`user-manager ${m} ${p} ${JSON.stringify(b)} -> ${x.status}`);
    }
    assert.deepEqual(allowedWrongly, [], 'allowed wrongly:\n' + allowedWrongly.join('\n'));
    // ...but can still manage people with less (or equal) access
    r = await call('PATCH', `/staff/${small}`, { new_password: 'Small@99999' }); ok(r, 'lead resets a smaller user');
    r = await call('POST', '/staff', { name: 'New Desk', mobile: '9000066668', role: 'reception', password: 'Xyz@123456', permissions: ['checkin'] });
    ok(r, 'lead adds a smaller user');
    // Big Manager's password still works
    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9000066663', password: 'Mgr@123456' }); ok(r, 'big manager unaffected');
  } finally {
    s.stop();
  }
});
