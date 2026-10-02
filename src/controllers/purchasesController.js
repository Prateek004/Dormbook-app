'use strict';
/**
 * Purchases: goods bought for the PG (blankets, utensils, cleaning supplies ...).
 * One bill = one purchases row + its item lines + ONE ledger row (kind PURCHASE),
 * all in the same transaction. Undo = reversing that ledger row (the bill stays in history).
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const ledger = require('../services/ledger');
const { writeAudit } = require('../middleware/auditLog');
const { istDate, istMonthStart, isValidDate } = require('../util/time');

const CATEGORIES = ['Bedding & linen', 'Furniture & fittings', 'Kitchen & utensils', 'Groceries & food', 'Cleaning supplies',
  'Toiletries', 'Electrical & repairs', 'Stationery', 'Other'];
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', bank_transfer: 'Bank transfer' };
const text = (v, max) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));

// GET /purchases?from&to
function listPurchases(req, res) {
  const to = req.query.to ? String(req.query.to) : istDate();
  const from = req.query.from ? String(req.query.from) : istMonthStart();
  if (!isValidDate(from) || !isValidDate(to) || from > to) return res.status(400).json({ error: 'Choose a valid date range' });
  const db = getDb(), pid = req.user.property_id;
  const rows = db.prepare(`SELECT p.*, u.name created_by_name,
      (SELECT e.id FROM ledger_entries e WHERE e.source_table = 'purchases' AND e.source_id = p.id AND e.reversal_of IS NULL) ledger_id,
      EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_entries r ON r.reversal_of = e.id
              WHERE e.source_table = 'purchases' AND e.source_id = p.id) is_cancelled
    FROM purchases p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.property_id = ? AND p.purchase_date BETWEEN ? AND ? ORDER BY p.purchase_date DESC, p.created_at DESC`).all(pid, from, to);
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY rowid');
  const list = rows.map((p) => ({ id: p.id, date: p.purchase_date, vendor: p.vendor || '', bill_no: p.bill_no || '', category: p.category,
    mode: MODE_LABEL[p.payment_mode] || p.payment_mode, total: p.total_paise, note: p.note || '', by: p.created_by_name || '',
    ledger_id: p.ledger_id, cancelled: !!p.is_cancelled,
    items: items.all(p.id).map((i) => ({ item: i.item, qty: i.qty, unit: i.unit || '', rate: i.rate_paise, amount: i.amount_paise })) }));
  const total = list.filter((p) => !p.cancelled).reduce((a, p) => a + p.total, 0);
  const byCat = {};
  list.filter((p) => !p.cancelled).forEach((p) => { byCat[p.category] = (byCat[p.category] || 0) + p.total; });
  return res.json({ from, to, purchases: list, total, by_category: byCat, categories: CATEGORIES });
}

// POST /purchases { date, vendor, bill_no, category, mode, note, items: [{ item, qty, unit, rate_paise }] }
function createPurchase(req, res) {
  const db = getDb(), pid = req.user.property_id, b = req.body || {};
  const date = b.date ? String(b.date) : istDate();
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  if (date > istDate()) return res.status(400).json({ error: 'The date cannot be in the future' });
  const category = text(b.category, 40) || 'Other';
  if (!Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Add at least one item' });
  if (b.items.length > 100) return res.status(400).json({ error: 'Too many items on one bill (100 max)' });
  const items = [];
  for (const [i, raw] of b.items.entries()) {
    const item = text(raw && raw.item, 80);
    const qty = Number(raw && raw.qty);
    const rate = typeof (raw && raw.rate_paise) === 'number' ? raw.rate_paise : Number(String(raw && raw.rate_paise).trim());
    if (!item) return res.status(400).json({ error: `Item ${i + 1}: write what you bought` });
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return res.status(400).json({ error: `${item}: quantity must be more than zero` });
    if (!Number.isSafeInteger(rate) || rate < 0) return res.status(400).json({ error: `${item}: rate is not valid` });
    const amount = Math.round(qty * rate);
    items.push({ item, qty: Math.round(qty * 1000) / 1000, unit: text(raw.unit, 12) || null, rate, amount });
  }
  const total = items.reduce((a, x) => a + x.amount, 0);
  if (total <= 0) return res.status(400).json({ error: 'The bill total must be more than zero' });
  if (total > 100000000000) return res.status(400).json({ error: 'The bill total is unrealistically large' });
  const mode = String(b.mode || '');
  if (!ledger.MODES.includes(mode)) return res.status(400).json({ error: 'Choose how it was paid' });
  const id = uuidv4();
  const key = req.get('Idempotency-Key');
  const row = db.transaction(() => {
    db.prepare(`INSERT INTO purchases (id, property_id, purchase_date, vendor, bill_no, category, payment_mode, total_paise, note, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, pid, date, text(b.vendor, 80) || null, text(b.bill_no, 40) || null, category, mode, total,
      text(b.note, 300) || null, req.user.id, new Date().toISOString());
    const ins = db.prepare('INSERT INTO purchase_items (id, purchase_id, item, qty, unit, rate_paise, amount_paise) VALUES (?,?,?,?,?,?,?)');
    for (const x of items) ins.run(uuidv4(), id, x.item, x.qty, x.unit, x.rate, x.amount);
    return ledger.purchase({ propertyId: pid, purchaseId: id, amountPaise: total, mode, category, bizDate: date,
      reason: [text(b.vendor, 80), items.map((x) => x.item).join(', ')].filter(Boolean).join(': ').slice(0, 300),
      userId: req.user.id, idemKey: key ? `purchase:${pid}:${String(key).slice(0, 80)}` : null }, db);
  })();
  writeAudit({ propertyId: pid, userId: req.user.id, action: 'PURCHASE_RECORDED', entityType: 'purchases', entityId: id,
    amountPaise: total, snapshot: { category, mode, items: items.length, ledger_id: row.id }, ip: req.ip });
  return res.status(201).json({ id, total_paise: total, entry: row, moved_to_date: row.biz_date !== date ? row.biz_date : null });
}

module.exports = { listPurchases, createPurchase, CATEGORIES };
