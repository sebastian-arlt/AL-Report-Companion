'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { columns, validName, layoutColumnEdits } = require('../src/column-rename');
const { analyze, applyEdits } = require('../src/rdlc-fields');
const xml = (old = 'TelefonCaptionLbl') => `<Report xmlns="original"><DataSets><DataSet Name="DataSet_Result"><Fields><Field Name="${old}"><DataField> ${old} </DataField></Field><Field Name="Other"><DataField>Other</DataField></Field></Fields></DataSet></DataSets><Body><Value>=First(Fields!${old}.Value)</Value><Value>=Fields("${old}").Value</Value><Value>${old}</Value></Body></Report>`;
test('finds only column declaration names inside report datasets, including nested dataitems and extensions', () => {
  const text = `report 1 R { dataset { dataitem(Customer; Customer) {
    // column(Fake; Fake) {}
    column(TelefonCaptionLbl; TelefonCaptionLbl) { }
    dataitem(Line; "Sales Line") { column("Übergröße"; Size) { } }
    trigger OnAfterGetRecord() begin Message('column(Fake; Fake) {}'); end;
  } } rendering { layout(X) { LayoutFile = 'x.rdlc'; } } }
  reportextension 2 E extends R { dataset { add(Customer) { column(Extra; ExtraLbl) {} } } }
  table 3 T { fields { column(Wrong; Wrong) {} } }`;
  const found = columns(text);
  assert.deepEqual(found.map(item => item.name), ['TelefonCaptionLbl', 'Übergröße', 'Extra']);
  assert.deepEqual(found.map(item => text.slice(item.start, item.end)), ['TelefonCaptionLbl', '"Übergröße"', 'Extra']);
});
test('F2 mapping changes dataset definition and usages together, preserving unrelated strings and header', () => {
  const text = xml(), edits = layoutColumnEdits(text, 'TelefonCaptionLbl', 'TelefonCaptionLblTest');
  const updated = applyEdits(text, edits);
  assert.equal(edits.length, 4);
  assert.ok(updated.startsWith('<Report xmlns="original">'));
  assert.ok(updated.includes('<Value>TelefonCaptionLbl</Value>'));
  assert.equal(analyze(updated).datasets.DataSet_Result[0].name, 'TelefonCaptionLblTest');
  assert.ok(analyze(updated).references.every(ref => !ref.missing && ref.name === 'TelefonCaptionLblTest'));
});
test('Unicode declaration and entity-encoded layout field names rename correctly', () => {
  const text = xml('Für').replaceAll('Für', 'F&#252;r');
  const updated = applyEdits(text, layoutColumnEdits(text, 'Für', 'Österreich'));
  assert.equal(analyze(updated).datasets.DataSet_Result[0].name, 'Österreich');
  assert.ok(analyze(updated).references.every(ref => ref.name === 'Österreich' && !ref.missing));
  assert.equal(validName('Übergröße2'), true); assert.equal(validName('2New'), false);
});
test('rejects collisions, broken layouts and stale definitions without changing files', () => {
  assert.throws(() => layoutColumnEdits(xml(), 'TelefonCaptionLbl', 'Other'), /already contains/);
  assert.throws(() => layoutColumnEdits('<Report>', 'Old', 'New'), /Incomplete/);
  assert.throws(() => layoutColumnEdits(xml().replace(/<Field Name="TelefonCaptionLbl">.*?<\/Field>/, ''), 'TelefonCaptionLbl', 'New'), /old field is absent/);
  assert.deepEqual(layoutColumnEdits(xml(), 'Unrelated', 'New'), []);
});
test('keeps a different DataField source binding and does not rename fields in other datasets', () => {
  const text = xml().replace('<DataField> TelefonCaptionLbl </DataField>', '<DataField>SourceBinding</DataField>');
  const edited = applyEdits(text, layoutColumnEdits(text, 'TelefonCaptionLbl', 'New'));
  assert.ok(edited.includes('<DataField>SourceBinding</DataField>'));
});
