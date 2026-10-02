'use strict';
// Regression: a login with no PG property (the super-admin) used to crash
// POST /floors with a 500 "NOT NULL constraint failed: floors.property_id"
// (seen on the live server). Writes must now be refused cleanly with a 403,
// reads must keep working, and the server must stay up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');

test('super-admin (no property) gets a clean 403 on property writes, never a 500', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-noprop-'));
  const s = await boot({ dbDir, port: 19000 + Math.floor(Math.random() * 900) });
  try {
    let r = await s.call('POST', '/auth/login', { email: 'superadmin@dormbook.in', password: 'Sup3r!secret' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    s.setToken(r.body.token);

    const writes = [
      ['POST', '/floors', { floor_number: 0, label: 'Ground' }],
      ['POST', '/rooms', { floor_id: 'x', room_number: '101' }],
      ['POST', '/beds', { room_id: 'x', bed_label: 'A' }],
      ['POST', '/residents', { full_name: 'Test' }],
    ];
    for (const [m, p, b] of writes) {
      r = await s.call(m, p, b);
      assert.equal(r.status, 403, `${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /no PG property/);
    }

    // reads still work (empty data, no crash)
    r = await s.call('GET', '/floors');
    assert.equal(r.status, 200);
    r = await s.call('GET', '/admin/stats');
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // server still healthy after all of it
    r = await s.call('GET', '/health');
    assert.equal(r.status, 200);
    assert.ok(!s.logs.join('').includes('NOT NULL constraint failed'), 'no DB constraint crash in logs');
  } finally { s.stop(); }
});
