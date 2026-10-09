'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, editsFor, applyEdits, suggestions } = require('../src/rdlc-fields');
const dataset = (name, fields) => `<DataSet Name="${name}"><Fields>${fields.map(field => `<Field Name="${field}"><DataField>${field}</DataField></Field>`).join('')}</Fields></DataSet>`;
const report = (expression, fields = ['New']) => `<Report xmlns="original"><DataSets>${dataset('DataSet_Result', fields)}</DataSets><Body><Textbox><Value>${expression}</Value></Textbox></Body></Report>`;
test('recognizes complete Unicode field names, including the reported umlaut caption', () => {
  const names = ['V32__Warenwert_für_SVS_RVS_EURCaption', 'V42__Empfangsbestätigung', 'Änderung_Öl_Übergröße', 'Straße', 'Cafe\u0301', '数量'];
  const text = report('=' + names.map(name => `First(Fields!${name}.Value)`).join(' + '), names);
  const result = analyze(text);
  assert.deepEqual(result.references.map(ref => ref.name), names);
  assert.ok(result.references.every(ref => !ref.missing));
  assert.deepEqual(result.references.map(ref => text.slice(ref.start, ref.end)), names);
});
test('missing Unicode fields are diagnosed as full names and can be renamed to Unicode names', () => {
  const old = 'V32__Warenwert_für_SVS_RVS_EURCaption';
  const target = 'V32__Warenwert_für_ÖsterreichCaption';
  const text = report(`=Fields!${old}.Value + Fields!${old}.Value`, [target]);
  const result = analyze(text);
  assert.deepEqual(result.references.filter(ref => ref.missing).map(ref => ref.name), [old, old]);
  const edits = editsFor(result, 'DataSet_Result', old, target);
  assert.equal(edits.length, 2);
  const edited = applyEdits(text, edits);
  assert.equal(edited, text.replaceAll(`Fields!${old}`, `Fields!${target}`));
  assert.ok(analyze(edited).references.every(ref => !ref.missing));
});
test('Unicode XML entities retain exact diagnostic spans and support replacement', () => {
  const text = report('=Fields!Warenwert_f&#252;r.Value', ['Warenwert_für']);
  const ref = analyze(text).references[0];
  assert.equal(ref.name, 'Warenwert_für');
  assert.equal(ref.missing, false);
  assert.equal(text.slice(ref.start, ref.end), 'Warenwert_f&#252;r');
  const missing = report('=Fields!Warenwert_f&#252;r.Value', ['Ölmenge']);
  assert.equal(applyEdits(missing, editsFor(analyze(missing), 'DataSet_Result', 'Warenwert_für', 'Ölmenge')), missing.replace('Warenwert_f&#252;r', 'Ölmenge'));
});
test('missing fields are marked at each exact usage; XML entities and header survive selective rename', () => {
  const text = report('=IIF(Fields!Old.Value &gt; 0, Fields!Old.Value, Fields!New.Value)');
  const result = analyze(text);
  assert.equal(result.references.filter(ref => ref.missing).length, 2);
  assert.ok(result.references.filter(ref => ref.missing).every(ref => text.slice(ref.start, ref.end) === 'Old'));
  const edited = applyEdits(text, editsFor(result, 'DataSet_Result', 'Old', 'New'));
  assert.equal(edited, text.replaceAll('Fields!Old', 'Fields!New'));
  assert.equal(analyze(edited).references.some(ref => ref.missing), false);
});
test('ignores comments, VB strings, literal text and embedded code', () => {
  const text = report('="Fields!Ghost.Value" &amp; Fields!New.Value\n\' Fields!Ghost.Value')
    .replace('</Body>', '<!-- =Fields!Ghost.Value --><Textbox><Value>Fields!Ghost.Value</Value></Textbox></Body>')
    .replace('</Report>', '<Code>Function X()\n Fields!Ghost.Value\nEnd Function</Code></Report>');
  assert.deepEqual(analyze(text).references.map(ref => ref.name), ['New']);
});
test('indexed, Item and bracket expressions are diagnosed and renamed, including CDATA', () => {
  const text = report('<![CDATA[=Fields("Old").Value + Fields.Item("Old").Value + Fields![Old].Value]]>');
  const result = analyze(text);
  assert.equal(result.references.length, 3);
  const edited = applyEdits(text, editsFor(result, 'DataSet_Result', 'Old', 'New'));
  assert.equal(edited, text.replaceAll('Old', 'New'));
});
test('encoded quotes in attribute expressions retain attribute escaping', () => {
  const text = report('=Fields!New.Value').replace('<Textbox>', '<Textbox Expr="=Fields(&quot;Old&quot;).Value">');
  assert.equal(applyEdits(text, editsFor(analyze(text), 'DataSet_Result', 'Old', 'New')), text.replace('&quot;Old&quot;', '&quot;New&quot;'));
});
test('dataset scope distinguishes fields with the same name and explicit aggregate scope', () => {
  const text = `<Report><DataSets>${dataset('A', ['Present'])}${dataset('B', ['Old', 'New'])}</DataSets><Body><Tablix><DataSetName>A</DataSetName><Value>=Fields!Old.Value</Value><Value>=First(Fields!Old.Value, "B")</Value></Tablix></Body></Report>`;
  const result = analyze(text);
  assert.equal(result.references[0].missing, true);
  assert.equal(result.references[1].missing, false);
  assert.equal(result.references[1].scope, 'B');
  assert.equal(editsFor(result, 'B', 'Old', 'New').length, 1);
});
test('ambiguous multiple datasets and lookup scopes are not automatically edited', () => {
  const text = `<Report><DataSets>${dataset('A', ['New'])}${dataset('B', ['Other'])}</DataSets><Body><Value>=Fields!Old.Value</Value><Value>=Lookup(Fields!Old.Value, Fields!Other.Value, Fields!Other.Value, "B")</Value></Body></Report>`;
  assert.equal(editsFor(analyze(text), 'A', 'Old', 'New').length, 0);
  assert.equal(analyze(text).references.filter(ref => ref.missing).length, 2);
});
test('dynamic field indexes are left to manual review rather than misdiagnosed', () => {
  assert.equal(analyze(report('=Fields(Parameters!Choice.Value).Value')).references.length, 0);
});
test('ordinary string arguments are not confused with aggregate scopes; nested aggregates keep the region', () => {
  const text = `<Report><DataSets>${dataset('A', ['New'])}${dataset('B', ['Old'])}</DataSets><Body><Tablix><DataSetName>A</DataSetName><Value>=IIF(Fields!Old.Value, "B")</Value><Value>=Sum(IIF(Fields!Old.Value &gt; 0, Fields!Old.Value, 0))</Value></Tablix></Body></Report>`;
  const result = analyze(text);
  assert.equal(result.references.filter(ref => ref.missing).length, 3);
  assert.equal(editsFor(result, 'A', 'Old', 'New').length, 3);
});
test('lookup source and target references use different datasets', () => {
  const text = `<Report><DataSets>${dataset('A', ['New'])}${dataset('B', ['Other'])}</DataSets><Body><Tablix><DataSetName>A</DataSetName><Value>=Lookup(Fields!Old.Value, Fields!Other.Value, Fields!Other.Value, "B")</Value></Tablix></Body></Report>`;
  const result = analyze(text);
  assert.deepEqual(result.references.map(ref => ref.scope), ['A', 'B', 'B']);
  assert.equal(editsFor(result, 'A', 'Old', 'New').length, 1);
});
test('snapshot proposals cover column and dataitem induced field name changes without asserting identity', () => {
  const previous = { DataSet_Result: [{ name: 'Amount_OldItem', dataField: 'Amount_OldItem' }, { name: 'OldColumn', dataField: 'Source' }] };
  const current = { DataSet_Result: [{ name: 'Amount_NewItem', dataField: 'Amount_NewItem' }, { name: 'NewColumn', dataField: 'Source' }] };
  assert.equal(suggestions(previous, current, 'DataSet_Result', 'OldColumn').find(field => field.name === 'NewColumn').reason, 'Same DataField');
  assert.ok(suggestions(previous, current, 'DataSet_Result', 'Amount_OldItem').some(field => field.name === 'Amount_NewItem'));
});
test('rejects malformed documents and DTDs; Unicode offsets remain source offsets', () => {
  assert.throws(() => analyze('<Report><Value></Report>'), /Mismatched/);
  assert.throws(() => analyze('<!DOCTYPE Report><Report/>'), /DTD/);
  const text = report('="😀" &amp; Fields!Old.Value');
  const ref = analyze(text).references[0];
  assert.equal(text.slice(ref.start, ref.end), 'Old');
});
