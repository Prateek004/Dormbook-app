'use strict';
// Super-admin: account overview shows only business facts and counts (no private data),
// and deleting an account removes all of its data — and nothing of any other account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

/** One owner with beds, a guest (ID photo + payment), a staff login, UPI + bank details. */
async function makeCustomer(s, n) {
  const { call } = s;
  s.setToken(null);
  let r = await call('POST', '/auth/register', { business_name: `Biz ${n}`, owner_name: `Owner ${n}`, mobile: `98765000${n}0`,
    password: 'Passw0rd!23', pg_name: `Dorm ${n}`, city: 'Pune' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  s.setToken(r.body.token);
  r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
  r = await call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 2, beds_per_bunker: 2, daily_rate_paise: 40000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const bed = (await call('GET', '/beds?status=available')).body[0];
  r = await call('POST', '/residents', { full_name: `Secret Guest ${n}`, mobile: `90000011${n}1`, bed_id: bed.id, check_in_date: TODAY,
    expected_checkout: addDays(TODAY, 3), id_consent: true, rate_type: 'daily', rate_paise: 40000, id_type: 'pan', id_number: `abcde123${n}f` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const guest = r.body.resident.id;
  r = await call('POST', `/residents/${guest}/documents`, { doc_type: 'id_front', data_url: JPEG });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call('POST', '/payments', { resident_id: guest, amount_paise: 30000, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': `adm-${n}` });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  r = await call('POST', '/staff', { name: `Staff Person ${n}`, mobile: `90000022${n}2`, role: 'reception', password: 'Desk@12345' });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  r = await call('PATCH', '/account/payment', { upi_id: `secretupi${n}@okhdfcbank`, upi_name: 'Dorm', bank_holder: 'Owner',
    bank_name: 'SBI', bank_account: `12345678901${n}`, bank_ifsc: 'SBIN0001234', bank_branch: 'Pune', show_pay_on_bill: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = (await call('GET', `/residents/${guest}/documents`)).body[0].id;
  return { guest, doc, token: s.token() };
}

test('super-admin: safe account overview, complete and isolated delete', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-admin-'));
  const s = await boot({ dbDir, port: 21000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    const c1 = await makeCustomer(s, 1);
    const c2 = await makeCustomer(s, 2);

    // Owner 2 cannot open anything of owner 1, even with the right ids
    s.setToken(c2.token);
    for (const p of [`/residents/${c1.guest}`, `/residents/${c1.guest}/documents`, `/residents/${c1.guest}/documents/${c1.doc}`,
      `/residents/${c1.guest}/ledger`, `/residents/${c1.guest}/bill`, `/residents/${c1.guest}/statement`, `/residents/${c1.guest}/refund-summary`]) {
      const x = await call('GET', p);
      assert.ok([403, 404].includes(x.status), `owner 2 blocked from ${p} (got ${x.status})`);
      assert.ok(!JSON.stringify(x.body).includes('Secret Guest 1'), `no data of owner 1 at ${p}`);
    }
    let x = await call('GET', `/residents/${c1.guest}/addons`);
    assert.deepEqual(x.body, [], 'no add-ons of owner 1');
    x = await call('GET', '/residents');
    assert.ok(!JSON.stringify(x.body).includes('Secret Guest 1'), 'owner 1 guest not in owner 2 list');
    x = await call('POST', '/payments', { resident_id: c1.guest, amount_paise: 100, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': 'cross' });
    assert.ok(x.status >= 400, 'cannot record a payment on another owner\'s guest');

    // Owners cannot use admin routes
    let r = await call('GET', '/admin/accounts');
    assert.equal(r.status, 403, 'owner is not super-admin');

    s.setToken(null);
    r = await call('POST', '/auth/login', { email: 'superadmin@dormbook.in', password: 'Sup3r!secret' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s.setToken(r.body.token);
    r = await call('GET', '/admin/accounts');
    const acc1 = r.body.find((a) => a.business_name === 'Biz 1');
    const acc2 = r.body.find((a) => a.business_name === 'Biz 2');
    assert.ok(acc1 && acc2);

    // ── Overview: useful facts…
    r = await call('GET', `/admin/accounts/${acc1.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = r.body;
    assert.equal(o.business_name, 'Biz 1');
    assert.equal(o.owner.name, 'Owner 1');
    assert.equal(o.properties.length, 1);
    assert.equal(o.properties[0].beds.total, 4);
    assert.equal(o.properties[0].beds.occupied, 1);
    assert.equal(o.properties[0].guests.staying_now, 1);
    assert.equal(o.properties[0].setup.payment_details_added, true);
    assert.equal(o.staff.by_role.reception, 1);
    // …and nothing private
    const text = JSON.stringify(o);
    for (const secret of ['Secret Guest', '9000001111', 'ABCDE1231F', 'abcde1231f', 'secretupi1', '123456789011', 'SBIN0001234',
      'Staff Person', '9000002212', 'password', 'hash', 'mpin', 'enc', '30000']) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `overview must not contain "${secret}"`);
    }
    r = await call('GET', '/admin/accounts/not-a-real-id');
    assert.equal(r.status, 404);

    // ── Delete account 1: everything of it goes, account 2 stays exactly as it was
    const db = new Database(path.join(dbDir, 'dormbook.db'), { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
    const count = () => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
    const prop1 = db.prepare('SELECT id FROM properties WHERE account_id = ?').get(acc1.id).id;
    const prop2 = db.prepare('SELECT id FROM properties WHERE account_id = ?').get(acc2.id).id;
    const byProp = (pid) => Object.fromEntries(tables.filter((t) => db.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'property_id'))
      .map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE property_id = ?`).get(pid).n]));
    const acc2Before = byProp(prop2);
    const uploads1 = path.join(dbDir, 'uploads', prop1);
    assert.ok(fs.existsSync(uploads1), 'ID photo folder exists before delete');
    db.close();

    r = await call('DELETE', `/admin/accounts/${acc1.id}`);
    if (r.status !== 200) console.log(s.logs.filter((l) => l.includes('ERROR')).join('\n'));   // shows the reason if it fails
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const db2 = new Database(path.join(dbDir, 'dormbook.db'), { readonly: true });
    for (const t of tables) {
      const cols = db2.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      if (cols.includes('property_id')) assert.equal(db2.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE property_id = ?`).get(prop1).n, 0, `${t}: nothing of account 1 left`);
      if (cols.includes('account_id')) assert.equal(db2.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE account_id = ?`).get(acc1.id).n, 0, `${t}: nothing of account 1 left`);
    }
    assert.equal(db2.prepare("SELECT COUNT(*) n FROM residents WHERE full_name LIKE 'Secret Guest 1%'").get().n, 0);
    assert.equal(db2.prepare("SELECT COUNT(*) n FROM users WHERE name = 'Staff Person 1'").get().n, 0);
    assert.equal(db2.prepare('PRAGMA foreign_key_check').all().length, 0, 'no broken links left');
    const acc2After = Object.fromEntries(Object.keys(acc2Before).map((t) => [t, db2.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE property_id = ?`).get(prop2).n]));
    assert.deepEqual(acc2After, acc2Before, 'account 2 untouched');
    db2.close();
    // The "money entries cannot be deleted" rule is back in place for everyone else
    const dbw = new Database(path.join(dbDir, 'dormbook.db'));
    assert.ok(dbw.prepare("SELECT COUNT(*) n FROM ledger_entries").get().n > 0, 'account 2 still has money entries');
    assert.throws(() => dbw.prepare('DELETE FROM ledger_entries').run(), /LEDGER_IMMUTABLE/);
    dbw.close();
    assert.ok(!fs.existsSync(uploads1), 'ID photo files of account 1 removed');
    assert.ok(fs.existsSync(path.join(dbDir, 'uploads', prop2)), 'ID photo files of account 2 kept');

    // Account 2 still signs in and sees its guest
    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9876500020', password: 'Passw0rd!23' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s.setToken(r.body.token);
    r = await call('GET', '/residents');
    assert.equal(r.body.length, 1);
    // Account 1 is gone
    s.setToken(null);
    r = await call('POST', '/auth/login', { mobile: '9876500010', password: 'Passw0rd!23' });
    assert.equal(r.status, 401);
  } finally {
    s.stop();
  }
});
