'use strict';
/**
 * Staff salary maths — the ONE place salary due is calculated.
 *
 * Salary for a month becomes due on the 1st of that month (or the joining day).
 *  - first month: pro-rata from the joining day to month end
 *  - last month (after "left on" is set): pro-rata from the 1st to the leaving day
 *  - months in between: the full monthly salary in force that month
 * Payments are ledger rows (kind SALARY). Balance = salary due − paid:
 *   > 0  the business owes the staff member
 *   < 0  advance given to the staff member
 */
const { istDate } = require('../util/time');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function nextMonth(ym) { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }

/** Monthly salary in force for a month: the latest rate starting on or before it (0 if none). */
function rateFor(rates, ym) {
  let r = 0;
  for (const x of rates) if (x.from_month <= ym) r = x.amount_paise; // rates sorted by from_month
  return r;
}

/**
 * Salary due, month by month, from joining up to `asOf` (YYYY-MM-DD, inclusive).
 * Returns [{ month, date, rate_paise, due_paise, note }] — date is when that month's salary became due.
 */
function schedule(staff, rates, asOf = istDate()) {
  const out = [];
  const sorted = rates.slice().sort((a, b) => (a.from_month < b.from_month ? -1 : 1));
  const start = staff.joined_on;
  const end = staff.left_on && staff.left_on < asOf ? staff.left_on : asOf;
  if (!start || start > end) return out;
  for (let ym = start.slice(0, 7), guard = 0; ym <= end.slice(0, 7) && guard < 600; ym = nextMonth(ym), guard++) {
    const rate = rateFor(sorted, ym);
    const dim = daysInMonth(ym);
    let from = 1, to = dim, note = '';
    if (ym === start.slice(0, 7)) from = Number(start.slice(8));
    if (staff.left_on && ym === staff.left_on.slice(0, 7)) to = Number(staff.left_on.slice(8));
    const days = to - from + 1;
    const due = days >= dim ? rate : Math.round((rate * days) / dim);
    if (days < dim) note = `${days} of ${dim} days`;
    const date = from === 1 ? `${ym}-01` : start;
    if (date <= asOf) out.push({ month: ym, date, rate_paise: rate, due_paise: due, note });
  }
  return out;
}

module.exports = { schedule, rateFor, daysInMonth, nextMonth, MONTH_RE };
