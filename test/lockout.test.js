'use strict';
// Sign-in lock: 6 wrong tries in a row lock the account for 15 minutes, with a warning before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { boot } = require('./helpers');

test('6 wrong tries lock the account for 15 minutes; unknown numbers behave exactly the same', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-lock-'));
  const s = await boot({ dbDir, port: 24000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    let r = await call('POST', '/auth/register', { business_name: 'Lock PG', owner_name: 'Owner', mobile: '9876555550',
      password: 'Right@12345', pg_name: 'Lock PG', city: 'Pune' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(null);

    const tryWrong = (mobile) => call('POST', '/auth/login', { mobile, password: 'Wrong@12345' });
    const real = [], ghost = [];
    for (let i = 1; i <= 6; i++) {
      real.push(await tryWrong('9876555550'));
      ghost.push(await tryWrong('9876555559'));      // no account with this number
    }
    // Tries 1–2: plain message. 3–5: countdown warning. 6: locked.
    assert.equal(real[0].status, 401); assert.equal(real[0].body.error, 'Invalid credentials');
    assert.equal(real[2].body.error, 'Invalid credentials. 3 tries left before a 15-minute lock.');
    assert.equal(real[4].body.error, 'Invalid credentials. 1 try left before a 15-minute lock.');
    assert.equal(real[5].status, 429);
    assert.match(real[5].body.error, /^Account locked after 6 wrong tries\. Try again in 15 minutes\.$/);
    // Same answers for a number that has no account (can't be used to find registered numbers)
    assert.deepEqual(ghost.map((x) => [x.status, x.body.error]), real.map((x) => [x.status, x.body.error]));

    // While locked, even the right password is refused
    r = await call('POST', '/auth/login', { mobile: '9876555550', password: 'Right@12345' });
    assert.equal(r.status, 429);
    const db = new Database(path.join(dbDir, 'dormbook.db'), { readonly: true });
    const u = db.prepare('SELECT locked_until, failed_logins FROM users WHERE mobile = ?').get('9876555550');
    db.close();
    const mins = (Date.parse(u.locked_until) - Date.now()) / 60000;
    assert.ok(mins > 14 && mins <= 15, `locked for about 15 minutes (got ${mins.toFixed(1)})`);
    assert.equal(u.failed_logins, 6);
  } finally {
    s.stop();
  }
});

test('the lock repeats after every 6 more wrong tries', () => {
  const { backoffSeconds, triesLeft } = require('../src/middleware/rateLimits');
  assert.deepEqual([1, 2, 3, 4, 5].map(backoffSeconds), [0, 0, 0, 0, 0]);
  assert.equal(backoffSeconds(6), 15 * 60);
  assert.deepEqual([7, 8, 9, 10, 11].map(backoffSeconds), [0, 0, 0, 0, 0], 'after the lock: 5 more tries');
  assert.equal(backoffSeconds(12), 15 * 60, 'then locked again');
  assert.deepEqual([0, 3, 5, 6].map(triesLeft), [6, 3, 1, 6]);
});
