// Match preferences: who someone wants to meet (gender, age, country, language) and how (video,
// voice, chat). Matching is mutual: two people only see each other when each fits the other's
// filters and they share at least one mode.
const { GENDERS, AGE_BANDS, MODES, COUNTRIES, LANGUAGES, MAX_LANGUAGES } = require('./public/prefs-data');

const DEFAULTS = Object.freeze({ genders: [], ages: [], countries: [], languages: [], modes: [...MODES] });

const pick = (list, allowed, max = allowed.length) => [...new Set((Array.isArray(list) ? list : []).filter((x) => allowed.includes(x)))].slice(0, max);

// Cleans preferences from a request or the database. Empty lists mean "anyone".
function clean(p = {}) {
  const modes = pick(p.modes, MODES);
  return {
    genders: pick(p.genders, GENDERS),
    ages: pick(p.ages, Object.keys(AGE_BANDS)),
    countries: pick(p.countries, COUNTRIES, 20),
    languages: pick(p.languages, LANGUAGES, 10),
    modes: modes.length ? MODES.filter((m) => modes.includes(m)) : [...MODES],
  };
}

function parse(json) {
  if (!json) return { ...DEFAULTS, modes: [...MODES] };
  try {
    return clean(JSON.parse(json));
  } catch {
    return { ...DEFAULTS, modes: [...MODES] };
  }
}

function ageFrom(dob, today = new Date()) {
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  let age = today.getUTCFullYear() - d.getUTCFullYear();
  const m = today.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

const parseLanguages = (json) => {
  try { return pick(JSON.parse(json || '[]'), LANGUAGES, MAX_LANGUAGES); } catch { return []; }
};

// What other people's filters are checked against, from an account row.
function facts(row) {
  return {
    gender: row.gender || null,
    age: ageFrom(row.date_of_birth),
    country: row.country || null,
    languages: parseLanguages(row.languages),
  };
}

// Does someone with these facts fit these preferences? Unknown facts only pass "anyone".
function fits(p, f) {
  if (p.genders.length && !p.genders.includes(f.gender)) return false;
  if (p.ages.length && !(f.age != null && p.ages.some((b) => f.age >= AGE_BANDS[b][0] && f.age <= AGE_BANDS[b][1]))) return false;
  if (p.countries.length && !p.countries.includes(f.country)) return false;
  if (p.languages.length && !f.languages.some((l) => p.languages.includes(l))) return false;
  return true;
}

// The richest mode both allow (video > voice > chat), or null if they share none.
function callMode(a, b) {
  return MODES.find((m) => a.prefs.modes.includes(m) && b.prefs.modes.includes(m)) || null;
}

// a and b are { prefs, facts }.
function compatible(a, b) {
  return !!callMode(a, b) && fits(a.prefs, b.facts) && fits(b.prefs, a.facts);
}

// How many filters narrow the search (for the "Filters (3)" button).
function activeCount(p) {
  return ['genders', 'ages', 'countries', 'languages'].filter((k) => p[k].length).length + (p.modes.length < MODES.length ? 1 : 0);
}

module.exports = { DEFAULTS, clean, parse, facts, fits, callMode, compatible, activeCount, parseLanguages, ageFrom, MODES, COUNTRIES, LANGUAGES, MAX_LANGUAGES };
