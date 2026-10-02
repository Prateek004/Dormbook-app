'use strict';
// Feature toggles are really saved, the super-admin password reset lets the
// owner sign in (and clears a lockout), email login ignores capital letters,
// and bills carry every business detail without "A unit of".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');
const { istDate, addDays } = require('../src/util/time');

test('toggles, owner password reset, email login, bill details', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-settings-'));
  const s = await boot({ dbDir, port: 20000 + Math.floor(Math.random() * 900) });
  const { call } = s;
  try {
    // Owner signs up
    let r = await call('POST', '/auth/register', { business_name: 'Shanti Hospitality Pvt Ltd', owner_name: 'Amit',
      mobile: '9876500001', email: 'amit@shanti.in', password: 'Original@123', pg_name: 'Shanti PG', city: 'Pune' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);

    // ── Feature toggles: default on, saved, returned, and not reset by a business save
    r = await call('GET', '/properties/profile');
    assert.equal(r.body.feature_beds, true);
    assert.equal(r.body.feature_gst, true);
    assert.equal(r.body.feature_user_access, true);
    r = await call('PATCH', '/properties/settings', { feature_beds: false, feature_gst: false, feature_user_access: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('GET', '/properties/profile');
    assert.equal(r.body.feature_beds, false);
    assert.equal(r.body.feature_gst, false);
    assert.equal(r.body.feature_user_access, true);
    r = await call('PATCH', '/properties/settings', { address: '12 MG Road', city: 'Pune' });
    assert.equal(r.status, 200);
    r = await call('GET', '/properties/profile');
    assert.equal(r.body.feature_beds, false, 'saving business details must not switch toggles back on');
    r = await call('PATCH', '/properties/settings', { feature_beds: 'no' });
    assert.equal(r.status, 400, 'only true/false accepted');
    r = await call('PATCH', '/properties/settings', { feature_beds: true, feature_gst: true });
    assert.equal(r.status, 200);

    // ── Bill shows every business detail; GSTIN saved without charging GST
    r = await call('PATCH', '/properties/settings', { contact_phone: '9876500001', contact_email: 'hello@shanti.in',
      gstin: '27ABCDE1234F1Z5', state: 'Maharashtra', pincode: '411001' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    r = await call('POST', '/rooms', { floor_id: r.body.id, room_number: '101' });
    r = await call('POST', '/beds', { room_id: r.body.id, bed_label: 'A', daily_rate_paise: 30000 });
    const TODAY = istDate();
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000000001', bed_id: r.body.id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 2), id_consent: true, id_type: 'passport', id_number: 'k1234567', rate_type: 'daily', rate_paise: 60000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ravi = r.body.resident.id;
    r = await call('GET', `/residents/${ravi}/bill`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.company;
    assert.equal(c.gstin, '27ABCDE1234F1Z5');
    assert.equal(c.phone, '9876500001');
    assert.equal(c.email, 'hello@shanti.in');
    assert.match(c.address, /12 MG Road, Pune, Maharashtra, 411001/);
    assert.deepEqual(c.missing, []);
    // Shared (WhatsApp) bill page
    r = await call('POST', `/residents/${ravi}/bill-link`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const html = await (await fetch(r.body.url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${s.port}`))).text();
    assert.ok(!html.includes('A unit of'), 'no "A unit of" on the bill');
    for (const want of ['Shanti PG', 'Shanti Hospitality Pvt Ltd', '12 MG Road', 'Phone: 9876500001', 'Email: hello@shanti.in', 'GSTIN: 27ABCDE1234F1Z5']) {
      assert.ok(html.includes(want), `bill shows ${want}`);
    }

    // ── Super-admin resets the owner's password
    const ownerToken = s.token();
    s.setToken(null);
    // Owner types the wrong password until locked
    for (let i = 0; i < 6; i++) await call('POST', '/auth/login', { mobile: '9876500001', password: 'Wrong@pass' + i });
    r = await call('POST', '/auth/login', { mobile: '9876500001', password: 'Original@123' });
    assert.equal(r.status, 429, 'owner is locked after wrong tries');

    r = await call('POST', '/auth/login', { email: 'superadmin@dormbook.in', password: 'Sup3r!secret' });
    s.setToken(r.body.token);
    r = await call('GET', '/admin/accounts');
    const acc = r.body.find(a => a.owner_mobile === '9876500001');
    assert.ok(acc, 'account listed');
    r = await call('POST', `/admin/accounts/${acc.id}/reset-password`, { new_password: '  Fresh@2026 ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.password, 'Fresh@2026', 'outer spaces removed');
    assert.equal(r.body.login.mobile, '9876500001');

    s.setToken(null);
    await new Promise((res) => setTimeout(res, 1100));   // next second, like a real person
    r = await call('POST', '/auth/login', { mobile: '9876500001', password: 'Fresh@2026' });
    assert.equal(r.status, 200, 'owner signs in with the new password (lock cleared): ' + JSON.stringify(r.body));
    r = await call('POST', '/auth/login', { mobile: '9876500001', password: 'Fresh@2026 ' });
    assert.equal(r.status, 200, 'a trailing space from the keyboard is tolerated');
    r = await call('POST', '/auth/login', { email: 'AMIT@Shanti.in', password: 'Fresh@2026' });
    assert.equal(r.status, 200, 'email with capitals works');
    r = await call('POST', '/auth/login', { mobile: '9876500001', password: 'Original@123' });
    assert.equal(r.status, 401, 'old password no longer works');

    // Old session (from before the reset) is signed out
    s.setToken(ownerToken);
    r = await call('GET', '/properties/profile');
    assert.equal(r.status, 401, 'old sessions end after a reset');

    // ── Staff saved with a capitalised email can sign in by email
    r = await call('POST', '/auth/login', { mobile: '9876500001', password: 'Fresh@2026' });
    s.setToken(r.body.token);
    r = await call('POST', '/staff', { name: 'Ravi Staff', email: 'Ravi.Staff@Gmail.com', mobile: '9000000099', role: 'manager', password: 'Staff@12345' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(null);
    r = await call('POST', '/auth/login', { email: 'ravi.staff@gmail.com', password: 'Staff@12345' });
    assert.equal(r.status, 200, 'staff email login ignores capitals: ' + JSON.stringify(r.body));

    r = await call('GET', '/health');
    assert.equal(r.status, 200);
    assert.ok(!/\[ERROR\]|UNCAUGHT|UNHANDLED/.test(s.logs.join('')), 'no server errors:\n' + s.logs.join(''));
  } finally { s.stop(); }
});
