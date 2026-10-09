'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findCalLayouts, standaloneXml, importCalLayout, selectCalLayout } = require('../src/cal-layouts');
const { calReport } = require('./cal-fixtures');

test('extracts RDLDATA in legacy schemas without changing its Report header', () => {
  for (const year of ['2005', '2008', '2010']) {
    const source = calReport({ year });
    const layouts = findCalLayouts(source);
    assert.equal(layouts.length, 1);
    const layout = layouts[0];
    assert.equal(layout.id, '50000');
    assert.equal(layout.name, 'Sales Report');
    assert.ok(layout.namespace.includes(year));
    assert.ok(layout.xml.includes(layout.header));
    assert.equal(source.slice(layout.payloadStart, layout.payloadEnd), layout.payload);
    assert.ok(!layout.xml.includes('END_OF_RDLDATA'));
  }
});

test('recognizes combined exports and selects the report under the caret', () => {
  const first = calReport({ id: '50000' });
  const other = 'OBJECT Codeunit 50001 Helper\r\n{\r\n}\r\n';
  const second = calReport({ id: '50002', name: 'Another Report' });
  const source = first + other + second;
  const layouts = findCalLayouts(source);
  assert.equal(layouts.length, 2);
  assert.equal(selectCalLayout(layouts, first.length + other.length + 50).id, '50002');
  assert.equal(selectCalLayout(layouts, first.length + 10), undefined);
});

test('imports only the inner XML, retaining wrappers, C/AL code and line endings', () => {
  for (const eol of ['\r\n', '\n']) {
    const source = calReport({ eol });
    const layout = findCalLayouts(source)[0];
    const edit = importCalLayout(source, { key: layout.key, sourceHash: layout.hash }, layout.xml.replace('Original ä', 'Edited ö'));
    const updated = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
    assert.equal(updated.slice(0, edit.start), source.slice(0, layout.payloadStart));
    assert.equal(updated.slice(edit.start + edit.replacement.length), source.slice(layout.payloadEnd));
    assert.ok(updated.includes('Edited ö'));
    assert.ok(updated.includes(layout.header));
    assert.equal(findCalLayouts(updated)[0].hash, edit.updatedHash);
    if (eol === '\r\n') assert.ok(!/(?<!\r)\n/.test(updated));
    else assert.ok(!updated.includes('\r'));
  }
});

test('rejects conflicting XML edits but accepts unrelated source edits', () => {
  const source = calReport();
  const layout = findCalLayouts(source)[0];
  const session = { key: layout.key, sourceHash: layout.hash };
  assert.throws(() => importCalLayout(source.replace('Original ä', 'Conflicting'), session, layout.xml), /RDLDATA changed/);
  assert.doesNotThrow(() => importCalLayout(source.replace("MESSAGE('Grüße')", "MESSAGE('Other')"), session, layout.xml));
  assert.throws(() => importCalLayout(source.replace('Sales Report', 'Renamed'), session, layout.xml), /removed, renamed/);
  assert.throws(() => importCalLayout(source + source, session, layout.xml), /ambiguous/);
});

test('ignores incomplete exports, unrelated objects and empty sections', () => {
  assert.equal(findCalLayouts(calReport().replace('END_OF_RDLDATA', 'BROKEN')).length, 0);
  assert.equal(findCalLayouts(calReport().replace('OBJECT Report', 'OBJECT Codeunit')).length, 0);
  assert.equal(findCalLayouts('OBJECT Report 1 Empty\n{\n RDLDATA\n {\n END_OF_RDLDATA\n }\n}').length, 0);
  assert.throws(() => standaloneXml('  '), /empty/);
});
