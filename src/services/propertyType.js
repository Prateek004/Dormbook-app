'use strict';
// What changes with the kind of property. Only wording, setup and defaults depend on
// this; stored guests, beds and money are the same for every type.
//
//   dormitory      floors > bunkers > beds (0A1, 0A2). Short stays, daily rate.
//   pg             floors > rooms > beds (101-A, 101-B). Monthly rent by sharing,
//                  no fixed leaving date until the tenant gives notice.
//   hostel         like PG when hostel_style is 'monthly' (students, working people);
//                  rooms with per-night beds when it is 'nightly' (backpackers).

const TYPES = ['pg', 'hostel', 'dormitory'];
const HOSTEL_STYLES = ['monthly', 'nightly'];
const GENDERS = ['boys', 'girls', 'coliving'];
const FOOD_PLANS = ['none', 'breakfast', 'two_meals', 'three_meals'];
const FOOD_LABEL = { breakfast: 'breakfast', two_meals: 'breakfast & dinner', three_meals: 'all meals' };
const MAX_SHARING = 12;

function typeOf(prop) { return TYPES.includes(prop && prop.property_type) ? prop.property_type : 'dormitory'; }
function usesRooms(prop) { return typeOf(prop) !== 'dormitory'; }
/** Long stays: monthly rent, open-ended stay, notice period and sharing rates apply. */
function isLongStay(prop) {
  const t = typeOf(prop);
  return t === 'pg' || (t === 'hostel' && prop.hostel_style !== 'nightly');
}
function unitWord(prop) { return usesRooms(prop) ? 'Room' : 'Bunker'; }

/** {"1": 1200000, "2": 800000} → only whole, non-negative paise for 1..12 sharing. */
function parseSharingRates(raw) {
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (_) { obj = null; } }
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (let n = 1; n <= MAX_SHARING; n++) {
    const v = Number(obj[n]);
    if (Number.isInteger(v) && v > 0) out[n] = v;
  }
  return out;
}

function propertyRow(db, propertyId) {
  return db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId) || {};
}

module.exports = {
  TYPES, HOSTEL_STYLES, GENDERS, FOOD_PLANS, FOOD_LABEL, MAX_SHARING,
  typeOf, usesRooms, isLongStay, unitWord, parseSharingRates, propertyRow,
};
