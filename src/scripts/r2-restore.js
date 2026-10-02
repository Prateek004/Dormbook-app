'use strict';
/**
 * Get a database backup back from Cloudflare R2.
 *
 * Run where the R2_* and AES_256_KEY variables are set (Railway → service → shell,
 * or locally with the same variables in .env):
 *
 *   node src/scripts/r2-restore.js list
 *       → shows every backup in R2, newest last
 *   node src/scripts/r2-restore.js get dormbook-2026-10-03T03-15-00-daily.db restored.db
 *       → downloads + decrypts it to restored.db (your live database is NOT touched)
 *
 * To actually switch to a restored copy: stop the service, copy restored.db over
 * DB_DIR/dormbook.db, start again. (The app also keeps 14 local copies in DB_DIR/backups.)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const r2 = require('../services/r2');
const { decryptBuffer } = require('../services/encryption');

async function main() {
  const [cmd, name, out] = process.argv.slice(2);
  if (!r2.enabled()) {
    console.error('R2 is not set up here. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.');
    process.exit(1);
  }
  if (cmd === 'list') {
    const items = (await r2.listObjects('backups/')).sort((a, b) => a.key.localeCompare(b.key));
    if (!items.length) console.log('No backups in R2 yet.');
    for (const o of items) console.log(`${o.key.replace(/^backups\//, '').replace(/\.enc$/, '')}   ${Math.round(o.size / 1024)} KB   ${o.lastModified || ''}`);
    return;
  }
  if (cmd === 'get' && name) {
    const base = path.basename(name).replace(/\.enc$/, '');
    if (!/^dormbook-[0-9T-]+-[a-z]+\.db$/.test(base)) { console.error('Use a name exactly as shown by: list'); process.exit(1); }
    const target = path.resolve(out || base);
    if (fs.existsSync(target)) { console.error(`${target} already exists — choose another file name.`); process.exit(1); }
    const enc = await r2.getObject(`backups/${base}.enc`, { timeoutMs: 5 * 60 * 1000 });
    if (!enc) { console.error('Not found in R2.'); process.exit(1); }
    let db;
    try { db = decryptBuffer(enc); } catch (_) { console.error('Could not decrypt — AES_256_KEY is not the key used for this backup.'); process.exit(1); }
    if (db.subarray(0, 15).toString('latin1') !== 'SQLite format 3') { console.error('Downloaded file is not a SQLite database.'); process.exit(1); }
    fs.writeFileSync(target, db, { mode: 0o600 });
    console.log(`Saved ${target} (${Math.round(db.length / 1024)} KB). Your live database was not changed.`);
    return;
  }
  console.log('Usage:\n  node src/scripts/r2-restore.js list\n  node src/scripts/r2-restore.js get <backup name> [output file]');
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
