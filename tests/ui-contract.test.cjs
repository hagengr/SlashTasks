'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
test('every static UI ID referenced by the controller exists once in the document', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate IDs can disconnect controls.');
  for (const match of source.matchAll(/\$\('#([A-Za-z][A-Za-z0-9]+)'\)/g)) {
    assert(ids.includes(match[1]), 'Missing required element: ' + match[1]);
  }
});
test('the shared task model loads before the UI and both are deferred', () => {
  assert(html.indexOf('src="task-model.js" defer') < html.indexOf('src="app.js" defer'));
  assert(html.includes('src="app.js" defer'));
});
test('the current UI has no dependency on the superseded stylesheet or a CDN', () => {
  assert(!html.includes('styles-extra.css'));
  assert(!html.includes('fonts.googleapis.com'));
  assert(html.includes('data-layout="list"'));
  assert(html.includes('data-layout="table"'));
  assert(html.includes('id="acceptSuggestions"'));
});
