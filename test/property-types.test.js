'use strict';
// PG / Hostel / Dormitory: existing data is untouched, and each type works end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
const port = () => 21000 + Math.floor(Math.random() * 3000);

test('an existing (live-like) database keeps every value and works as a Dormitory', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-live-'));
  const file = path.join(dbDir, 'dormbook.db');
  const db = new Database(file);
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-before-19sep.sql'), 'utf8'));
  db.pragma('foreign_keys = OFF'); // fixture rows reference each other in a circle (property owner ↔ user)
  const ci = addDays(TODAY, -20);
  db.exec(`INSERT INTO accounts (id, business_name, owner_name, owner_mobile, trial_ends_at) VALUES ('a1','Old Biz','Amit','9811111111','2099-01-01');
    INSERT INTO properties (id, account_id, name, owner_id) VALUES ('p1','a1','Old Dorm','u1');
    INSERT INTO floors (id, property_id, floor_number, label) VALUES ('f1','p1',0,'Ground');
    INSERT INTO rooms (id, floor_id, property_id, room_number, room_type) VALUES ('rm1','f1','p1','0A','dormitory');
    INSERT INTO beds (id, room_id, property_id, bed_label, daily_rate_paise, base_rate_paise, status) VALUES
      ('b1','rm1','p1','0A1',40000,40000,'occupied'), ('b2','rm1','p1','0A2',40000,40000,'available');
    INSERT INTO residents (id, property_id, bed_id, full_name, mobile, check_in_date, expected_checkout, status, monthly_rent_paise,
      rate_type, rate_paise, deposit_paise, checkin_by, rent_due_day)
      VALUES ('r1','p1','b1','Ravi','9000000001','${ci}','${addDays(TODAY, 10)}','active',1200000,'daily',40000,200000,'u1',1);`);
  db.prepare(`INSERT INTO users (id, account_id, property_id, name, mobile, password_hash, role) VALUES ('u1','a1','p1','Amit','9811111111',?,'owner')`)
    .run(bcrypt.hashSync('Passw0rd!23', 4));
  const snap = (d) => ['properties', 'floors', 'rooms', 'beds', 'residents', 'users'].map((t) => {
    const cols = d.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name);
    return [t, cols, d.prepare(`SELECT ${cols.join(',')} FROM ${t} ORDER BY id`).all()];
  });
  const before = snap(db);
  db.close();

  const s = await boot({ dbDir, port: port() });
  try {
    const r = await s.call('POST', '/auth/login', { mobile: '9811111111', password: 'Passw0rd!23' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s.setToken(r.body.token);
    const prof = await s.call('GET', '/properties/profile');
    assert.equal(prof.body.property_type, 'dormitory');
    assert.equal(prof.body.unit_word, 'Bunker');
    assert.equal(prof.body.long_stay, false);
    const add = await s.call('POST', '/floors/f1/bunkers', { bunkers: 1, beds_per_bunker: 2 });
    assert.deepEqual(add.body.created[0].beds, ['0B1', '0B2'], 'dormitory naming unchanged');
    assert.ok(!/\[ERROR\]|UNCAUGHT/.test(s.logs.join('')), s.logs.join(''));
  } finally {
    s.stop();
    await new Promise((ok) => s.child.on('exit', ok));
  }

  // Every original column of every original row is exactly as it was (new columns are extra).
  const after = new Database(file, { readonly: true });
  for (const [t, cols, rows] of before) {
    const now = after.prepare(`SELECT ${cols.join(',')} FROM ${t} WHERE id IN (${rows.map(() => '?').join(',') || "''"}) ORDER BY id`)
      .all(...rows.map((x) => x.id));
    const strip = (list) => list.map((x) => { const y = { ...x }; delete y.updated_at; return y; });
    assert.deepEqual(strip(now), strip(rows), `${t} rows changed`);
  }
  assert.equal(after.prepare("SELECT property_type FROM properties WHERE id='p1'").get().property_type, 'dormitory');
  after.close();
});

test('PG: rooms with sharing rent, open-ended stays, food on the bill, notice period', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-pg-'));
  const s = await boot({ dbDir, port: port() });
  const { call } = s;
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Sunrise', owner_name: 'Amit', mobile: '9876512345',
      password: 'Passw0rd!23', pg_name: 'Sunrise PG', property_type: 'pg' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);
    r = await call('GET', '/properties/profile');
    assert.deepEqual([r.body.property_type, r.body.unit_word, r.body.long_stay, r.body.notice_days], ['pg', 'Room', true, 30]);

    r = await call('PATCH', '/properties/settings', { sharing_rates: { 1: 1200000, 2: 800000, 3: 650000 }, food_plan: 'two_meals', lock_in_months: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sharing_rates, { 1: 1200000, 2: 800000, 3: 650000 });
    assert.equal((await call('PATCH', '/properties/settings', { property_type: 'villa' })).status, 400);
    assert.equal((await call('PATCH', '/properties/settings', { sharing_rates: { 99: 1 } })).status, 400);

    const f = (await call('POST', '/floors', { floor_number: 1, label: 'First Floor' })).body;
    r = await call('POST', `/floors/${f.id}/bunkers`, { bunkers: 2, beds_per_bunker: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.created.map((c) => [c.name, c.beds]), [['101', ['101-A', '101-B']], ['102', ['102-A', '102-B']]]);
    r = await call('POST', `/floors/${f.id}/bunkers`, { bunkers: 1, beds_per_bunker: 1 });
    assert.deepEqual(r.body.created[0].beds, ['103-A']);

    let floors = (await call('GET', '/floors')).body;
    const room = (n) => floors[0].rooms.find((x) => x.room_number === n);
    assert.equal(room('101').beds[0].monthly_rate_paise, 800000, 'double sharing rent from Settings');
    assert.equal(room('101').beds[0].daily_rate_paise, Math.round(800000 / 30));
    assert.equal(room('103').beds[0].monthly_rate_paise, 1200000, 'single room rent');

    r = await call('POST', `/rooms/${room('101').id}/beds`, {});
    assert.equal(r.body.bed_label, '101-C', 'next bed in a PG room');
    r = await call('POST', '/beds/apply-sharing-rates', {});
    assert.equal(r.status, 200);
    floors = (await call('GET', '/floors')).body;
    assert.ok(room('101').beds.every((b) => b.monthly_rate_paise === 650000), 'room 101 is now triple sharing');

    r = await call('PATCH', `/floors/${f.id}`, { gender: 'girls' });
    assert.equal(r.body.gender, 'girls');
    assert.equal((await call('PATCH', `/floors/${f.id}`, { gender: 'aliens' })).status, 400);

    const bedId = room('101').beds[0].id;
    const base = { full_name: 'Priya', mobile: '9000000022', bed_id: bedId, check_in_date: TODAY, id_consent: true,
      id_type: 'pan', id_number: 'abcde1234f', open_ended: true, rate_type: 'monthly', gender: 'female' };
    assert.equal((await call('POST', '/residents', { ...base, rate_type: 'daily' })).status, 400, 'open-ended needs weekly/monthly');
    r = await call('POST', '/residents', base);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const res = r.body.resident;
    assert.equal(res.expected_checkout, null);
    assert.equal(res.rate_paise, 650000, 'monthly rent taken from the bed');
    assert.deepEqual([res.food_plan, res.notice_days, res.lock_in_months, res.gender], ['two_meals', 30, 3, 'female']);

    r = await call('GET', `/residents/${res.id}/bill`);
    assert.match(r.body.lines[0].description, /with breakfast & dinner/);

    r = await call('POST', `/residents/${res.id}/extend`, { new_expected_checkout: addDays(TODAY, 60) });
    assert.equal(r.status, 200, 'extending an open-ended stay works: ' + JSON.stringify(r.body));
    await call('POST', `/residents/${res.id}/extend`, { new_expected_checkout: addDays(TODAY, 61) });

    r = await call('POST', `/residents/${res.id}/notice`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.expected_checkout, addDays(TODAY, 30));
    assert.equal((await call('POST', `/residents/${res.id}/notice`, {})).status, 409);
    r = await call('DELETE', `/residents/${res.id}/notice`);
    assert.equal(r.body.expected_checkout, addDays(TODAY, 61), 'old leaving date comes back');
    r = await call('POST', `/residents/${res.id}/notice`, { leaving_date: addDays(TODAY, 10) });
    assert.equal(r.body.short_days, 20);

    r = await call('GET', `/residents/${res.id}/checkout-preview?date=${TODAY}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.terms.notice_short_days, 30);
    assert.equal(r.body.terms.notice_short_charge_paise, Math.round(650000 / 30) * 30);
    assert.equal(r.body.terms.before_lock_in, true);
    assert.ok(!/\[ERROR\]|UNCAUGHT/.test(s.logs.join('')), s.logs.join(''));
  } finally {
    s.stop();
  }
});

test('Hostel: owner picks nightly or monthly', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-hostel-'));
  const s = await boot({ dbDir, port: port() });
  try {
    let r = await s.call('POST', '/auth/register', { business_name: 'Backpack', owner_name: 'Amit', mobile: '9876522345',
      password: 'Passw0rd!23', property_type: 'hostel', hostel_style: 'nightly' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);
    r = await s.call('GET', '/properties/profile');
    assert.deepEqual([r.body.property_type, r.body.hostel_style, r.body.long_stay, r.body.notice_days, r.body.unit_word],
      ['hostel', 'nightly', false, 0, 'Room']);
    r = await s.call('PATCH', '/properties/settings', { hostel_style: 'monthly' });
    assert.equal(r.body.long_stay, true);
    assert.equal((await s.call('POST', '/auth/register', { business_name: 'X', owner_name: 'Y', mobile: '9876532345',
      password: 'Passw0rd!23', property_type: 'hotel' })).status, 400);
    // App icons are the DormBook logo (they used to be plain purple squares), and the app can see new versions.
    for (const n of [192, 512]) {
      const res = await fetch(`http://127.0.0.1:${s.port}/icons/icon-${n}.png`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(buf.readUInt32BE(16), n, `icon is ${n}px wide`);
      assert.ok(buf.length > 1500, 'not a single-colour square');
    }
    assert.match((await s.call('GET', '/health')).body.build, /^[0-9a-f]{12}$/);
  } finally {
    s.stop();
  }
});
