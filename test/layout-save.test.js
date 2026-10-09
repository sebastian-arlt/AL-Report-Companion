'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diskMatchesRename } = require('../src/layout-save');
test('accepts original bytes and auto-saved expected UTF-8/BOM/UTF-16 text', () => {
  const original = Buffer.from('<Report>Für</Report>\r\n');
  const expected = '<Report>Österreich</Report>\n';
  assert.equal(diskMatchesRename(original, original, expected), true);
  assert.equal(diskMatchesRename(Buffer.from('\uFEFF' + expected), original, expected), true);
  assert.equal(diskMatchesRename(Buffer.from(expected.replace(/\n/g, '\r\n')), original, expected), true);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(expected, 'utf16le')]);
  assert.equal(diskMatchesRename(utf16, original, expected), true);
});
test('supports configured Windows-1252 but rejects distinct content or invalid UTF-8', () => {
  assert.equal(diskMatchesRename(Buffer.from([0x46, 0xfc, 0x72]), Buffer.from('Old'), 'Für', 'windows1252'), true);
  assert.equal(diskMatchesRename(Buffer.from('Unrelated change'), Buffer.from('Old'), 'New'), false);
  assert.equal(diskMatchesRename(Buffer.from([0xff]), Buffer.from('Old'), 'New'), false);
});
