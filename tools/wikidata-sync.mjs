// Fill countries that have no officially sourced records with heads of state and
// government from Wikidata, labeled as Wikidata (never as verified).
// Countries that already have official records are never changed; if Wikidata
// disagrees with them, the difference is written to reports/wikidata-check.md.
//
// Usage: node tools/wikidata-sync.mjs
// Test with a saved SPARQL response: WIKIDATA_FIXTURE=path.json node tools/wikidata-sync.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OFFICIAL_SOURCE_TYPES } = require('../lib/directory.js');

const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const DIR = 'data/countries';
const ROLE_TITLES = { 'head-of-state': 'Head of State', 'head-of-government': 'Head of Government' };
const MAX_PER_ROLE = 3; // more than this usually means stale Wikidata statements

// Small queries in batches: one large query times out on the public endpoint.
const BATCH = 50;
const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'civic-directory-sync/1.1 (https://github.com/jbirdfarrow/civic-directory)';

const qid = uri => (uri || '').split('/').pop();
const norm = s => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const sameName = (a, b) => {
  const x = norm(a).split(' ').filter(w => w.length > 2), y = new Set(norm(b).split(' '));
  return x.length > 0 && x.filter(w => y.has(w)).length >= Math.min(2, x.length);
};

async function sparql(query) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(SPARQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json', 'User-Agent': UA },
      body: new URLSearchParams({ query })
    });
    if (response.ok) return (await response.json()).results.bindings;
    const text = (await response.text()).slice(0, 200);
    if (attempt === 4 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`Wikidata query failed: ${response.status} ${text}`);
    const wait = Number(response.headers.get('retry-after')) * 1000 || attempt * 5000;
    console.log(`Wikidata ${response.status}, retrying in ${wait / 1000}s`);
    await new Promise(r => setTimeout(r, wait));
  }
}

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const lit = (value) => ({ value });

// Returns rows shaped like a single SPARQL result: code, country, countryLabel, role, office, officeLabel, person, personLabel, rank, start.
async function fetchRows() {
  if (process.env.WIKIDATA_FIXTURE) return JSON.parse(readFileSync(process.env.WIKIDATA_FIXTURE, 'utf8')).results.bindings;

  // 1. Current countries and territories with an ISO code. If two items share a code, keep the older (lower) Q-id.
  const byCode = new Map();
  for (const b of await sparql('SELECT DISTINCT ?country ?code WHERE { ?country wdt:P297 ?code . FILTER NOT EXISTS { ?country wdt:P576 [] } }')) {
    const code = b.code.value.toUpperCase(), q = qid(b.country.value);
    const prev = byCode.get(code);
    if (!prev || Number(q.slice(1)) < Number(prev.slice(1))) byCode.set(code, q);
  }
  const countryOf = new Map([...byCode].map(([code, q]) => [q, code]));
  const items = [...countryOf.keys()];
  console.log(`${items.length} countries and territories`);

  // 2. Current holders (no end date, not deprecated) and the office each country names for the role.
  const roles = [['head-of-state', 'P35', 'P1906'], ['head-of-government', 'P6', 'P1313']];
  const raw = [];
  const offices = new Map();
  for (const group of chunks(items, BATCH)) {
    const values = group.map(q => 'wd:' + q).join(' ');
    for (const [role, prop, officeProp] of roles) {
      for (const b of await sparql(`SELECT ?country ?person ?rank ?start WHERE { VALUES ?country { ${values} } ?country p:${prop} ?st . ?st ps:${prop} ?person ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) FILTER NOT EXISTS { ?st pq:P582 ?end } OPTIONAL { ?st pq:P580 ?start } }`)) {
        raw.push({ role, country: qid(b.country.value), person: qid(b.person.value), rank: b.rank.value, start: b.start ? b.start.value : null });
      }
      for (const b of await sparql(`SELECT ?country ?office WHERE { VALUES ?country { ${values} } ?country wdt:${officeProp} ?office . }`)) {
        offices.set(`${qid(b.country.value)}|${role}`, qid(b.office.value));
      }
    }
  }

  // 3. English labels for every country, person and office.
  const ids = [...new Set(raw.flatMap(r => [r.country, r.person]).concat([...offices.values()]))];
  const labels = new Map();
  for (const group of chunks(ids, 200)) {
    for (const b of await sparql(`SELECT ?item ?label WHERE { VALUES ?item { ${group.map(q => 'wd:' + q).join(' ')} } ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }`)) {
      labels.set(qid(b.item.value), b.label.value);
    }
  }
  const entity = q => 'http://www.wikidata.org/entity/' + q;
  return raw.map(r => {
    const office = offices.get(`${r.country}|${r.role}`);
    const row = {
      code: lit(countryOf.get(r.country)), country: lit(entity(r.country)), countryLabel: lit(labels.get(r.country) || r.country),
      role: lit(r.role), person: lit(entity(r.person)), personLabel: lit(labels.get(r.person) || r.person), rank: lit(r.rank)
    };
    if (office) { row.office = lit(entity(office)); row.officeLabel = lit(labels.get(office) || office); }
    if (r.start) row.start = lit(r.start);
    return row;
  });
}

function allowedCodes() {
  // Restrict to the app's jurisdiction registry when it has been synced into app/.
  if (!existsSync('app/jurisdictions.json')) return null;
  return new Set(JSON.parse(readFileSync('app/jurisdictions.json', 'utf8')).jurisdictions.map(j => j.code));
}

function hasOfficialRecords(doc) {
  const sources = new Map((doc.sources || []).map(s => [s.id, s]));
  return (doc.officeholders || []).some(r => (r.sourceIds || []).some(id => OFFICIAL_SOURCE_TYPES.includes((sources.get(id) || {}).sourceType)));
}

// Compare documents without the timestamps that change on every run.
function substance(doc) {
  return JSON.stringify(doc, (key, value) => ['generatedAt', 'retrievedAt', 'checkedAt'].includes(key) ? undefined : value);
}

function buildDoc(code, roles) {
  const sources = [];
  const officeholders = [];
  const byPerson = new Map();
  for (const role of ['head-of-state', 'head-of-government']) {
    for (const row of roles[role] || []) {
      const personId = qid(row.person.value);
      if (byPerson.has(personId)) continue; // same person holds both offices: one record
      const sourceId = `${code.toLowerCase()}-wikidata-${personId.toLowerCase()}`;
      sources.push({
        id: sourceId,
        name: `Wikidata: ${row.personLabel.value}`,
        url: `https://www.wikidata.org/wiki/${personId}`,
        sourceType: 'wikidata',
        publisher: 'Wikidata',
        language: 'en',
        license: 'CC0-1.0',
        retrievedAt: NOW,
        archivedUrl: null,
        notes: `${role === 'head-of-state' ? 'P35' : 'P6'} on ${row.countryLabel.value} (${qid(row.country.value)}), rank ${qid(row.rank.value).replace('Rank', '').toLowerCase()}${row.start ? ', start ' + row.start.value.slice(0, 10) : ''}`
      });
      const n = officeholders.filter(r => r.id.startsWith(`${code.toLowerCase()}-${role}`)).length + 1;
      const record = {
        id: `${code.toLowerCase()}-${role}-${n}`,
        jurisdictionCode: code,
        subdivisionCode: null,
        administrativeArea: null,
        office: {
          id: row.office ? qid(row.office.value) : null,
          title: row.officeLabel && !/^Q\d+$/.test(row.officeLabel.value) ? row.officeLabel.value.replace(/^./, c => c.toUpperCase()) : ROLE_TITLES[role],
          localTitle: null,
          level: 'national',
          selectionMethod: 'unknown',
          termStart: row.start ? row.start.value.slice(0, 10) : null,
          termEnd: null
        },
        person: { name: row.personLabel.value, localName: null, languageCodes: [] },
        contacts: [],
        sourceIds: [sourceId],
        verification: {
          status: 'unverified',
          checkedAt: NOW,
          verifiedAt: null,
          verifiedBy: null,
          method: null,
          evidenceSourceIds: [sourceId],
          reviewBy: null,
          notes: 'From Wikidata. Needs an official government or parliament page and a second-person check before it can be verified.'
        }
      };
      byPerson.set(personId, record);
      officeholders.push(record);
    }
  }
  return { schemaVersion: 2, jurisdictionCode: code, generatedAt: NOW, sources, officeholders };
}

const rows = await fetchRows();
const allowed = allowedCodes();
const byCountry = new Map();
const skipped = [];
for (const row of rows) {
  const code = row.code.value.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || (allowed && !allowed.has(code))) continue;
  if (/^Q\d+$/.test(row.personLabel.value)) continue; // no English label
  if (!byCountry.has(code)) byCountry.set(code, { 'head-of-state': [], 'head-of-government': [] });
  const list = byCountry.get(code)[row.role.value];
  if (!list.some(r => r.person.value === row.person.value)) list.push(row);
}

let written = 0, unchanged = 0;
const disagreements = [];
mkdirSync(DIR, { recursive: true });
for (const [code, roles] of [...byCountry].sort()) {
  for (const role of Object.keys(roles)) {
    const preferred = roles[role].filter(r => r.rank.value.endsWith('PreferredRank'));
    roles[role] = preferred.length ? preferred : roles[role];
    if (roles[role].length > MAX_PER_ROLE) { skipped.push(`${code} ${role}: ${roles[role].length} current statements, looks stale`); roles[role] = []; }
  }
  const path = `${DIR}/${code}.json`;
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (existing && hasOfficialRecords(existing)) {
    // Never overwrite official records; report where Wikidata disagrees.
    const names = (existing.officeholders || []).map(r => r.person.name);
    for (const role of Object.keys(roles)) for (const row of roles[role]) {
      if (!names.some(n => sameName(row.personLabel.value, n) || sameName(n, row.personLabel.value))) {
        disagreements.push(`| ${code} | ${ROLE_TITLES[role]} | ${row.personLabel.value} | ${names.join(', ')} |`);
      }
    }
    continue;
  }
  const doc = buildDoc(code, roles);
  if (!doc.officeholders.length) continue;
  if (existing && substance(existing) === substance(doc)) { unchanged++; continue; }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  written++;
}

mkdirSync('reports', { recursive: true });
writeFileSync('reports/wikidata-check.md', [
  '# Wikidata check',
  '',
  `Run: ${NOW}. Wikidata rows: ${rows.length}. Countries with Wikidata data: ${byCountry.size}. Files written: ${written}. Unchanged: ${unchanged}.`,
  '',
  '## Where Wikidata disagrees with an officially sourced record',
  '',
  'Wikidata may be ahead (a recent change) or wrong. Check the official page before changing anything.',
  '',
  disagreements.length ? '| Country | Office | Wikidata says | Directory has |\n| --- | --- | --- | --- |\n' + disagreements.join('\n') : 'None.',
  '',
  '## Skipped',
  '',
  skipped.length ? skipped.map(s => `- ${s}`).join('\n') : 'None.',
  ''
].join('\n'));
console.log(`Wikidata rows ${rows.length}; written ${written}; unchanged ${unchanged}; disagreements ${disagreements.length}; skipped ${skipped.length}`);
