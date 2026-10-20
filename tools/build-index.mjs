// Build data/index.json: which countries have records, with counts by status.
// The Civic Lookup app reads this to decide which countries are connected.
// Usage: node tools/build-index.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { effectiveStatus, OFFICIAL_SOURCE_TYPES } = require('../lib/directory.js');

const dir = 'data/countries';
const countries = {};
for (const file of readdirSync(dir).filter(f => /^[A-Z]{2}\.json$/.test(f)).sort()) {
  const doc = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  const sources = new Map((doc.sources || []).map(s => [s.id, s]));
  const entry = { records: 0, verified: 0, unverified: 0, stale: 0, disputed: 0, officialEvidence: 0, wikidataOnly: 0, nextReviewBy: null };
  for (const r of doc.officeholders || []) {
    entry.records++;
    entry[effectiveStatus(r)]++;
    const v = r.verification || {};
    const evidence = (v.evidenceSourceIds && v.evidenceSourceIds.length ? v.evidenceSourceIds : r.sourceIds || []).map(id => sources.get(id)).filter(Boolean);
    if (evidence.some(s => OFFICIAL_SOURCE_TYPES.includes(s.sourceType))) entry.officialEvidence++;
    else entry.wikidataOnly++;
    if (v.reviewBy && (!entry.nextReviewBy || v.reviewBy < entry.nextReviewBy)) entry.nextReviewBy = v.reviewBy;
  }
  if (entry.records) countries[doc.jurisdictionCode] = entry;
}

const index = { schemaVersion: 1, countries };
const path = 'data/index.json';
const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
const after = JSON.stringify(index, null, 2) + '\n';
if (before !== after) writeFileSync(path, after);
console.log(`${Object.keys(countries).length} countries in index${before === after ? ' (unchanged)' : ''}`);
