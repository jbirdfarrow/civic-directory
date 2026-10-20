// Validate every country file against the JSON Schema and the evidence rules in lib/directory.js.
// Exit code 1 if anything fails, so the GitHub Action blocks bad data.
// Usage: node tools/validate-all.mjs [data/countries]
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const { validate, effectiveStatus } = require('../lib/directory.js');

const dir = process.argv[2] || 'data/countries';
const schema = JSON.parse(readFileSync('schema/directory.schema.json', 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const check = ajv.compile(schema);

let failed = 0;
const lines = [];
const totals = { files: 0, records: 0, verified: 0, unverified: 0, stale: 0, disputed: 0 };

for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const code = file.replace(/\.json$/, '');
  let doc;
  try { doc = JSON.parse(readFileSync(join(dir, file), 'utf8')); }
  catch (e) { failed++; lines.push(`${file}: not valid JSON (${e.message})`); continue; }
  const problems = [];
  if (!/^[A-Z]{2}$/.test(code)) problems.push('file name must be a 2-letter ISO code, like BB.json');
  if (doc.jurisdictionCode !== code) problems.push(`jurisdictionCode is ${doc.jurisdictionCode}, expected ${code}`);
  if (!check(doc)) check.errors.forEach(e => problems.push(`schema: ${e.instancePath || '/'} ${e.message}`));
  validate(doc).forEach(p => problems.push(`${p.recordId || 'document'}: ${p.message}`));
  (doc.officeholders || []).forEach(r => {
    if (r.jurisdictionCode !== code) problems.push(`${r.id}: belongs to ${r.jurisdictionCode}, not ${code}`);
    const s = effectiveStatus(r);
    totals[s] = (totals[s] || 0) + 1;
  });
  totals.files++;
  totals.records += (doc.officeholders || []).length;
  if (problems.length) {
    failed++;
    lines.push(`${file}:`);
    problems.forEach(p => lines.push(`  - ${p}`));
  }
}

const summary = `${totals.files} countries, ${totals.records} records: ${totals.verified} verified, ${totals.unverified} unverified, ${totals.stale} need re-check, ${totals.disputed} disputed`;
console.log(lines.length ? lines.join('\n') + '\n' : '', summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Directory validation\n\n${summary}\n\n${failed ? '```\n' + lines.join('\n') + '\n```\n' : 'All files passed.\n'}`);
}
process.exit(failed ? 1 : 0);
