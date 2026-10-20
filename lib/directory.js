/*
 * Civic Directory: source-tracked officeholder records.
 * Loads one country file at a time from the civic-directory GitHub repository,
 * checks every record's sources and verification, and renders cards that always
 * show where a record came from and how far it has been checked.
 * Records that fail the checks are not shown.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const OFFICIAL_SOURCE_TYPES = ['government', 'legislature', 'election-authority', 'official-api'];
  const STATUSES = ['verified', 'unverified', 'stale', 'disputed'];

  const STATUS_INFO = {
    verified: { label: 'Verified', note: 'Checked against an official source.' },
    unverified: { label: 'Unverified', note: 'Not yet confirmed by a second reviewer. Check the source before relying on it.' },
    stale: { label: 'Needs re-check', note: 'This record is past its review date and may be out of date.' },
    disputed: { label: 'Disputed', note: 'Sources disagree about this record. Check before relying on it.' },
    live: { label: 'Live API', note: 'Returned directly by a third-party API. Not independently verified.' },
    community: { label: 'Unverified · Wikidata', note: 'From Wikidata, a community-edited source. Not yet checked against an official page.' }
  };

  const DEFAULT_BASE = 'https://raw.githubusercontent.com/jbirdfarrow/civic-directory/main/data/';

  function isDateTime(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }

  /*
   * Rules JSON Schema cannot express on its own: cross-references between
   * records and sources, and what counts as enough evidence to say "verified".
   * Returns a list of { recordId, message } problems. Empty list means valid.
   */
  function validate(doc) {
    const problems = [];
    const add = (recordId, message) => problems.push({ recordId, message });

    if (!doc || doc.schemaVersion !== SCHEMA_VERSION) {
      add(null, `schemaVersion must be ${SCHEMA_VERSION}`);
      return problems;
    }
    const sources = Array.isArray(doc.sources) ? doc.sources : [];
    const records = Array.isArray(doc.officeholders) ? doc.officeholders : [];
    const sourcesById = new Map();

    sources.forEach(source => {
      if (!source || !source.id) return add(null, 'A source is missing its id');
      if (sourcesById.has(source.id)) add(null, `Duplicate source id ${source.id}`);
      sourcesById.set(source.id, source);
      if (!/^https?:\/\//.test(source.url || '')) add(null, `Source ${source.id} needs an http(s) URL`);
      if (!isDateTime(source.retrievedAt)) add(null, `Source ${source.id} needs a retrievedAt date-time`);
    });

    const seenRecords = new Set();
    records.forEach(record => {
      const id = record && record.id;
      if (!id) return add(null, 'An officeholder record is missing its id');
      if (seenRecords.has(id)) add(id, 'Duplicate record id');
      seenRecords.add(id);

      if (!/^[A-Z]{2}$/.test(record.jurisdictionCode || '')) add(id, 'jurisdictionCode must be a 2-letter ISO code');
      if (record.subdivisionCode && !record.subdivisionCode.startsWith(record.jurisdictionCode + '-')) {
        add(id, 'subdivisionCode must start with the jurisdictionCode');
      }
      if (!record.person || !record.person.name) add(id, 'person.name is required');
      if (!record.office || !record.office.title) add(id, 'office.title is required');

      const sourceIds = Array.isArray(record.sourceIds) ? record.sourceIds : [];
      if (!sourceIds.length) add(id, 'At least one sourceId is required');
      sourceIds.forEach(sid => { if (!sourcesById.has(sid)) add(id, `Unknown sourceId ${sid}`); });
      (record.contacts || []).forEach(contact => {
        if (contact.sourceId && !sourcesById.has(contact.sourceId)) add(id, `Contact cites unknown sourceId ${contact.sourceId}`);
      });

      const v = record.verification || {};
      if (!STATUSES.includes(v.status)) add(id, `verification.status must be one of ${STATUSES.join(', ')}`);

      if (v.status === 'verified') {
        if (!isDateTime(v.verifiedAt)) add(id, 'Verified records need verifiedAt');
        if (!v.verifiedBy) add(id, 'Verified records need verifiedBy');
        if (!v.method) add(id, 'Verified records need a verification method');
        if (!v.reviewBy) add(id, 'Verified records need a reviewBy date');
        const evidence = Array.isArray(v.evidenceSourceIds) ? v.evidenceSourceIds : [];
        if (!evidence.length) add(id, 'Verified records need evidenceSourceIds');
        evidence.forEach(sid => {
          if (!sourceIds.includes(sid)) add(id, `Evidence source ${sid} is not listed in sourceIds`);
        });
        const official = evidence.some(sid => {
          const source = sourcesById.get(sid);
          return source && OFFICIAL_SOURCE_TYPES.includes(source.sourceType);
        });
        if (!official) add(id, 'Verified records need at least one official evidence source (government, legislature, election-authority or official-api)');
        if (isDateTime(v.verifiedAt)) {
          evidence.forEach(sid => {
            const source = sourcesById.get(sid);
            if (source && isDateTime(source.retrievedAt) && Date.parse(source.retrievedAt) > Date.parse(v.verifiedAt)) {
              add(id, `Verified before evidence source ${sid} was retrieved`);
            }
          });
        }
      }
      if (v.status === 'disputed' && !v.notes) add(id, 'Disputed records need notes explaining the disagreement');
    });

    return problems;
  }

  // Verified records past their review date are shown as needing a re-check.
  function effectiveStatus(record, now) {
    const v = record.verification || {};
    const today = (now || new Date()).toISOString().slice(0, 10);
    if (v.status === 'verified' && v.reviewBy && v.reviewBy < today) return 'stale';
    return STATUSES.includes(v.status) ? v.status : 'unverified';
  }

  let base = DEFAULT_BASE;
  const countries = new Map(); // jurisdiction code -> checked state
  const pending = new Map();   // jurisdiction code -> in-flight load
  let indexPromise = null;
  let mode = null;             // 'github' once the repository answers, 'local' while it can't
  let localPromise = null;

  function configure(options) {
    if (options && options.base) base = options.base;
    countries.clear();
    pending.clear();
    indexPromise = null;
    localPromise = null;
    mode = null;
  }

  // Fallback while the GitHub repository is unavailable: the "directory" section of coverage.json.
  function loadLocal() {
    if (!localPromise) {
      localPromise = fetch('./coverage.json', { cache: 'no-cache' })
        .then(response => { if (!response.ok) throw new Error('Could not load coverage.json'); return response.json(); })
        .then(data => (data && data.directory) || null)
        .catch(error => { localPromise = null; throw error; });
    }
    return localPromise;
  }

  function countryFromDoc(doc, code) {
    const officeholders = ((doc && doc.officeholders) || []).filter(r => r.jurisdictionCode === code);
    const used = new Set(officeholders.flatMap(r => (r.sourceIds || []).concat((r.verification && r.verification.evidenceSourceIds) || [], (r.contacts || []).map(c => c.sourceId).filter(Boolean))));
    return { schemaVersion: SCHEMA_VERSION, jurisdictionCode: code, sources: ((doc && doc.sources) || []).filter(s => used.has(s.id)), officeholders };
  }

  function indexFromDoc(doc) {
    const out = {};
    ((doc && doc.officeholders) || []).forEach(r => {
      const entry = out[r.jurisdictionCode] || (out[r.jurisdictionCode] = { records: 0 });
      entry.records++;
    });
    return { schemaVersion: 1, countries: out };
  }

  // Check a country document and keep only the records that pass.
  function setData(doc, code) {
    const problems = validate(doc);
    if (code && doc && Array.isArray(doc.officeholders)) {
      doc.officeholders.forEach(r => { if (r.jurisdictionCode !== code) problems.push({ recordId: r.id, message: `Record belongs to ${r.jurisdictionCode}, not ${code}` }); });
    }
    const badIds = new Set(problems.filter(p => p.recordId).map(p => p.recordId));
    const fatal = problems.some(p => !p.recordId);
    if (problems.length && root.console) console.warn('Civic directory problems' + (code ? ` (${code})` : '') + ':', problems);
    const sourcesById = new Map(((doc && doc.sources) || []).map(s => [s.id, s]));
    const all = (doc && doc.officeholders) || [];
    const records = fatal ? [] : all.filter(r => !badIds.has(r.id));
    const state = { sourcesById, records, problems, hidden: all.length - records.length };
    if (code) countries.set(code, state);
    return state;
  }

  function withMessage(error, message) {
    error.userMessage = message;
    return error;
  }

  // Which countries have records, with counts by status. Built by the repository's GitHub Action.
  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(base + 'index.json', { cache: 'no-cache' })
        .then(response => {
          if (!response.ok) throw new Error('Could not load the directory index');
          return response.json();
        })
        .then(index => { mode = 'github'; return index; })
        .catch(() => loadLocal().then(doc => {
          if (!doc) throw new Error('No directory data available');
          mode = 'local';
          return indexFromDoc(doc);
        }))
        .catch(error => {
          indexPromise = null;
          throw withMessage(error, 'The directory list could not be loaded. Please refresh and try again.');
        });
    }
    return indexPromise;
  }

  function load(code) {
    if (!/^[A-Z]{2}$/.test(code || '')) return Promise.reject(withMessage(new Error('Bad country code'), 'Choose a country first.'));
    if (countries.has(code)) return Promise.resolve(countries.get(code));
    if (!pending.has(code)) {
      const request = loadIndex().catch(() => null)
        .then(() => mode === 'local'
          ? loadLocal().then(doc => countryFromDoc(doc, code))
          : fetch(base + 'countries/' + code + '.json', { cache: 'no-cache' }).then(response => {
            if (response.status === 404) return { schemaVersion: SCHEMA_VERSION, sources: [], officeholders: [] };
            if (!response.ok) throw new Error('Could not load the civic directory for ' + code);
            return response.json();
          }))
        .then(doc => setData(doc, code))
        .catch(error => { throw withMessage(error, 'The civic directory could not be loaded. Please refresh and try again.'); })
        .finally(() => pending.delete(code));
      pending.set(code, request);
    }
    return pending.get(code);
  }

  function recordsFor(jurisdictionCode, subdivisionCode) {
    const state = countries.get(jurisdictionCode);
    if (!state) return [];
    return state.records.filter(r =>
      r.jurisdictionCode === jurisdictionCode &&
      (subdivisionCode ? r.subdivisionCode === subdivisionCode : !r.subdivisionCode)
    );
  }

  // Convert a directory record to the shape the letter tools already use.
  function toOfficial(record, now) {
    const pick = type => (record.contacts || []).filter(c => c.type === type).map(c => c.value);
    const v = record.verification || {};
    const state = countries.get(record.jurisdictionCode);
    const evidence = ((v.evidenceSourceIds && v.evidenceSourceIds.length) ? v.evidenceSourceIds : (record.sourceIds || []))
      .map(id => state && state.sourcesById.get(id)).filter(Boolean);
    const officialEvidence = evidence.some(source => OFFICIAL_SOURCE_TYPES.includes(source.sourceType));
    let status = effectiveStatus(record, now);
    if (status === 'unverified' && !officialEvidence) status = 'community';
    return {
      name: record.person.name,
      title: record.office.localTitle ? `${record.office.title} (${record.office.localTitle})` : record.office.title,
      emails: pick('email'),
      phones: pick('phone'),
      urls: pick('website').concat(pick('contact-form')),
      address: pick('postal-address'),
      provenance: {
        status,
        // Show the evidence pages, not every page a contact detail came from
        sources: evidence,
        verifiedAt: v.verifiedAt || null,
        verifiedBy: v.verifiedBy || null,
        reviewBy: v.reviewBy || null,
        notes: v.notes || null
      }
    };
  }

  function liveApiProvenance(provider) {
    return {
      status: 'live',
      sources: [{ name: provider.name, url: provider.documentationUrl, retrievedAt: new Date().toISOString() }],
      verifiedAt: null,
      verifiedBy: null,
      reviewBy: null,
      notes: null
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value.length === 10 ? value + 'T00:00:00Z' : value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function safeUrl(value) {
    return /^https?:\/\//i.test(value || '') ? value : null;
  }

  // Badge plus source line. Built with DOM nodes so record text is never parsed as HTML.
  function renderProvenance(provenance) {
    const info = STATUS_INFO[provenance.status] || STATUS_INFO.unverified;
    const box = el('div', `provenance provenance-${provenance.status === 'community' ? 'unverified' : provenance.status}`);
    const badge = el('span', 'provenance-badge', info.label);
    badge.title = info.note;
    box.appendChild(badge);
    box.appendChild(el('p', 'provenance-note', info.note));

    provenance.sources.forEach(source => {
      const line = el('p', 'provenance-source');
      line.appendChild(document.createTextNode('Source: '));
      const href = safeUrl(source.url);
      if (href) {
        const link = el('a', null, source.name);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        line.appendChild(link);
      } else {
        line.appendChild(document.createTextNode(source.name));
      }
      if (source.retrievedAt && provenance.status !== 'live') {
        line.appendChild(document.createTextNode(` · retrieved ${formatDate(source.retrievedAt)}`));
      }
      box.appendChild(line);
    });

    if (provenance.verifiedAt) {
      const by = provenance.verifiedBy ? ` by ${provenance.verifiedBy}` : '';
      box.appendChild(el('p', 'provenance-source', `Verified ${formatDate(provenance.verifiedAt)}${by}`));
    }
    if (provenance.reviewBy) {
      box.appendChild(el('p', 'provenance-source', `Re-check due ${formatDate(provenance.reviewBy)}`));
    }
    if (provenance.notes && provenance.status === 'disputed') {
      box.appendChild(el('p', 'provenance-source', provenance.notes));
    }
    return box;
  }

  function renderCard(official, index) {
    const card = el('div', 'official-card bg-gray-800 rounded-lg overflow-hidden shadow-lg');
    const body = el('div', 'p-4');
    body.appendChild(el('h3', 'text-xl font-bold text-white', official.name));
    body.appendChild(el('h4', 'text-primary-400 mb-3', official.title));
    body.appendChild(renderProvenance(official.provenance));

    const contacts = el('div', 'space-y-2 mt-3');
    official.emails.slice(0, 1).forEach(email => {
      const link = el('a', 'text-gray-300 hover:text-white', email);
      link.href = 'mailto:' + email;
      contacts.appendChild(wrap(link));
    });
    official.phones.slice(0, 1).forEach(phone => {
      const link = el('a', 'text-gray-300 hover:text-white', phone);
      link.href = 'tel:' + phone.replace(/[^+\d]/g, '');
      contacts.appendChild(wrap(link));
    });
    official.urls.slice(0, 1).forEach(url => {
      const href = safeUrl(url);
      if (!href) return;
      const link = el('a', 'text-gray-300 hover:text-white', 'Website');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      contacts.appendChild(wrap(link));
    });
    body.appendChild(contacts);

    const actions = el('div', 'mt-4');
    const button = el('button', 'write-letter-btn contact-btn w-full bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded transition duration-300 ease-in-out', 'Write a Letter');
    button.type = 'button';
    button.dataset.index = String(index);
    actions.appendChild(button);
    body.appendChild(actions);

    card.appendChild(body);
    return card;
  }

  function wrap(node) {
    const row = el('div', 'flex items-center');
    row.appendChild(node);
    return row;
  }

  const api = {
    SCHEMA_VERSION,
    OFFICIAL_SOURCE_TYPES,
    STATUS_INFO,
    validate,
    effectiveStatus,
    setData,
    configure,
    dataSource: () => mode,
    loadIndex,
    load,
    recordsFor,
    toOfficial,
    liveApiProvenance,
    renderProvenance,
    renderCard
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CivicDirectory = api;
})(typeof window !== 'undefined' ? window : globalThis);
