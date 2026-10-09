'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/rdlc-fields');
const { unusedColumns } = require('../src/column-usage');
const al = `report 1 R { dataset { dataitem(Item; Item) { column(Used; UsedLbl) {} column("Übergröße"; Size) {} column(NewBeforeBuild; NewLbl) {} } } RDLCLayout = 'one.rdlc'; }`;
const layout = expression => analyze(`<Report><DataSets><DataSet Name="DataSet_Result"><Fields><Field Name="Used"><DataField>Used</DataField></Field><Field Name="Übergröße"><DataField>Übergröße</DataField></Field></Fields></DataSet></DataSets><Body><Value>${expression}</Value></Body></Report>`);
test('only static expression references count as uses, not dataset definitions or literal display text', () => {
  const result = unusedColumns(al, [layout('=Fields!Used.Value'), layout('Übergröße')]);
  assert.deepEqual(result.map(column => column.name), ['Übergröße']);
  assert.equal(al.slice(result[0].start, result[0].end), '"Übergröße"');
});
test('usage in any linked layout prevents a warning, including indexed Unicode access', () => {
  assert.deepEqual(unusedColumns(al, [layout('=Fields!Used.Value'), layout('=Fields.Item("Übergröße").Value')]), []);
});
test('no warnings for Word-only reports, missing layouts or unresolved generated datasets', () => {
  assert.deepEqual(unusedColumns(al, []), []);
  assert.deepEqual(unusedColumns(al, [layout('=Fields!Used.Value'), undefined]), []);
  assert.deepEqual(unusedColumns(al, [analyze('<Report/>')]), []);
});
test('dynamic field access suppresses uncertain warnings but quoted strings do not', () => {
  assert.deepEqual(unusedColumns(al, [layout('=Fields(Parameters!Column.Value).Value')]), []);
  assert.equal(unusedColumns(al, [layout('="Fields(Parameters!Column.Value).Value"')]).length, 2);
  assert.equal(unusedColumns(al, [layout('=Fields("Used").Value')]).length, 1);
});
test('same-name usage in a different dataset does not mark the AL column used', () => {
  const analysis = layout('=Fields!Used.Value');
  analysis.datasets.Other = [{ name: 'Used' }];
  analysis.references[0].datasets = ['Other'];
  assert.deepEqual(unusedColumns(al, [analysis]).map(column => column.name), ['Used', 'Übergröße']);
});
