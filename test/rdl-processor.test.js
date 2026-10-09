'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processRdl } = require('../src/rdl-processor');
const { xml } = require('./cal-fixtures');

const options = { skip: process.platform !== 'win32' };
const headerOf = text => /<Report\b[^>]*>/.exec(text)[0];
const restore = (original, edited) => processRdl({ operation: 'import', xml: edited,
  originalXml: original, originalHeader: headerOf(original) });

test('native XML/XSD validation accepts each legacy schema and Unicode', options, async () => {
  for (const year of ['2005', '2008', '2010']) {
    const original = xml(year);
    const prepared = await processRdl({ operation: 'prepare', xml: original });
    assert.equal(prepared.xml, original);
    const result = await restore(original, original.replace('Original ä', 'Edited ö'));
    assert.equal(headerOf(result.xml), headerOf(original));
    assert.ok(result.xml.includes('Edited ö'));
    assert.deepEqual(result.changes, []);
  }
});

test('native converter reverses a compatible 2016 upgrade to 2010 and 2008', options, async () => {
  for (const year of ['2010', '2008']) {
    const original = xml(year);
    let edited = xml('2016', 'Edited ö');
    edited = edited.replace('<Report ', '<Report MustUnderstand="df" xmlns:df="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition/defaultfontfamily" ')
      .replace('<ReportSections>', '<df:DefaultFontFamily>Arial</df:DefaultFontFamily><ReportParametersLayout><GridLayoutDefinition><NumberOfColumns>2</NumberOfColumns><NumberOfRows>1</NumberOfRows></GridLayoutDefinition></ReportParametersLayout><ReportSections>');
    const result = await restore(original, edited);
    assert.equal(headerOf(result.xml), headerOf(original));
    assert.ok(result.xml.includes('Edited ö'));
    assert.ok(!result.xml.includes('ReportParametersLayout'));
    assert.ok(!result.xml.includes('DefaultFontFamily'));
    assert.ok(result.namespace.includes(year));
    if (year === '2008') assert.ok(!result.xml.includes('ReportSections'));
    assert.ok(result.changes.length >= 2);
  }
});

test('native converter refuses unsupported fonts, features and multiple sections', options, async () => {
  const original = xml('2008');
  const newer = xml('2016');
  await assert.rejects(restore(original, newer.replace('<ReportSections>', '<df:DefaultFontFamily xmlns:df="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition/defaultfontfamily">Segoe UI</df:DefaultFontFamily><ReportSections>')), /explicit compatible fonts/);
  await assert.rejects(restore(original, newer.replace('</ReportSection>', '</ReportSection><ReportSection><Body><Height>1in</Height></Body><Width>1in</Width><Page /></ReportSection>')), /Multiple report sections/);
  await assert.rejects(restore(original, newer.replace('<Height>1in</Height>', '<Height>1in</Height><UnsupportedFeature>new</UnsupportedFeature>')), /incompatible/);
  await assert.rejects(restore(xml('2005'), newer), /RDL 2005/);
});

test('native parser blocks malformed XML and DTD/external entities', options, async () => {
  await assert.rejects(processRdl({ operation: 'prepare', xml: '<Report>' }));
  await assert.rejects(processRdl({ operation: 'prepare', xml: xml('2010').replace('<Report ', '<!DOCTYPE Report [<!ENTITY unsafe SYSTEM "file:///C:/Windows/win.ini">]><Report ') }), /DTD|DOCTYPE/i);
});

test('native conversion preserves literal schema URLs in report code and exact original header spelling', options, async () => {
  const original = xml('2010').replace('xmlns="http://schemas.microsoft.com/sqlserver/reporting/2010/01/reportdefinition"', "xmlns='http://schemas.microsoft.com/sqlserver/reporting/2010/01/reportdefinition'");
  const edited = xml('2016', 'Edited ö').replace('</Report>', '<Code>Public Function Schema() As String\n Return "http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"\nEnd Function</Code></Report>');
  const result = await restore(original, edited);
  assert.equal(headerOf(result.xml), headerOf(original));
  assert.ok(result.xml.includes('Return "http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"'));
});
