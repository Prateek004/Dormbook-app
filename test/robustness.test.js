'use strict';
// Crash-safety guards: every API route answers even if its handler fails, and a
// Railway restart (SIGTERM) lets open requests finish and closes cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');

test('every API route handler is wrapped so a failing async handler cannot hang a request', () => {
  const router = require('../src/routes');
  let count = 0;
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const l of layer.route.stack) {
      count++;
      assert.match(l.handle.toString(), /Promise\.resolve\(fn\(req, res, next\)\)\.catch\(next\)/,
        `${Object.keys(layer.route.methods)} ${layer.route.path} is not wrapped`);
    }
  }
  assert.ok(count > 50, `expected many route handlers, found ${count}`);
});

test('SIGTERM shuts down cleanly with exit code 0', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-'));
  const s = await boot({ dbDir, port: 20000 + Math.floor(Math.random() * 1000) });
  assert.equal((await s.call('GET', '/health')).status, 200);
  const exited = new Promise((resolve) => s.child.on('exit', (code) => resolve(code)));
  s.child.kill('SIGTERM');
  assert.equal(await exited, 0, s.logs.join(''));
  assert.match(s.logs.join(''), /SIGTERM received/);
});
