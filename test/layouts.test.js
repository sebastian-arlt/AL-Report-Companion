'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findLayouts, projectRoot, resolveLayout, layoutAtPosition } = require('../src/layouts');

test('legacy report properties, comments, case and escaped apostrophes', () => {
  const source = `namespace Example.Reports;
  // report 1 Ignored { RDLCLayout = 'ignored.rdlc'; }
  #pragma warning disable AA0000
  report 50100 "Customer Report" {
    /* RDLCLayout = 'comment.rdlc'; */
    rDlClAyOuT /* split */ =
      './Layouts/Customer''s report.RDLC';
    WordLayout = 'word.docx';
    trigger OnPreReport() { Message('RDLCLayout = ''fake.rdlc'';'); }
  }`;
  const layouts = findLayouts(source);
  assert.equal(layouts.length, 2);
  assert.equal(layouts[0].path, "./Layouts/Customer's report.RDLC");
  assert.equal(source.slice(layouts[0].valueStart, layouts[0].valueEnd), "'./Layouts/Customer''s report.RDLC'");
  assert.equal(layouts[1].path, 'word.docx');
  assert.equal(layouts[1].property, 'WordLayout');
});

test('multiple named rendering layouts in report and reportextension', () => {
  for (const object of ['report 50100 Sales', 'reportextension 50100 Sales extends "Sales Invoice"']) {
    const layouts = findLayouts(`${object} {
      DefaultRenderingLayout = Invoice;
      dataset { dataitem(Customer; Customer) { column(LayoutFile; Name) { } } }
      rendering {
        layout(Invoice) { LayoutFile = 'Layouts/Invoice.rdlc'; Type = RDLC; }
        layout("Credit Note") { Type = RDLC; LayoutFile = 'Layouts\\Credit.rdl'; }
        layout(Word) { Type = Word; LayoutFile = 'Layouts/Invoice.docx'; }
      }
    }`);
    assert.deepEqual(layouts.map(l => [l.name, l.path]), [
      ['Invoice', 'Layouts/Invoice.rdlc'], ['"Credit Note"', 'Layouts\\Credit.rdl'],
      ['Word', 'Layouts/Invoice.docx']
    ]);
  }
});

test('Word rendering layouts support either property order, mixed case and multiline paths', () => {
  const source = `report 50100 Sales {
    rendering {
      layout(First) {
        Type = Word;
        LayoutFile = 'Layouts/First.docx';
      }
      layout(Second) {
        layoutfile =
          'Layouts/Second.DOCX';
        Type = Word;
      }
      layout(Excel) { Type = Excel; LayoutFile = 'Layouts/Excel.xlsx'; }
    }
  }`;
  assert.deepEqual(findLayouts(source).map(l => l.path), ['Layouts/First.docx', 'Layouts/Second.DOCX']);
});

test('ignores unrelated objects, captions, executable code and invalid declarations', () => {
  assert.deepEqual(findLayouts(`page 50100 Example { RDLCLayout = 'fake.rdlc'; }
    report 50100 Example {
      Caption = 'LayoutFile = ''fake.rdlc'';';
      procedure Example() { RDLCLayout := 'fake.rdlc'; }
      rendering { layout(Example) { LayoutFile = 'unfinished.rdlc' } }
    }`), []);
});

test('selects correct declaration in multiline property and on its property line', () => {
  const source = "report 1 X {\n  RDLCLayout =\n    'layout.rdlc';\n}";
  const layouts = findLayouts(source);
  const offset = source.indexOf('layout.rdlc') + 3;
  assert.equal(layoutAtPosition(layouts, offset, offset, offset), layouts[0]);
  assert.equal(layoutAtPosition(layouts, source.indexOf('  RDLC'), source.indexOf('  RDLC'), source.indexOf('=') + 1), layouts[0]);
  assert.equal(layoutAtPosition(layouts, 0, 0, 12), undefined);
});

test('uses nearest app.json for nested AL projects, with workspace fallback', async () => {
  const workspace = path.resolve('test-workspace');
  const app = path.join(workspace, 'apps', 'sales');
  const document = path.join(app, 'src', 'reports', 'Report.al');
  const accesses = [];
  const access = async filename => { accesses.push(filename); if (filename !== path.join(app, 'app.json')) throw Error('missing'); };
  assert.equal(await projectRoot(document, workspace, access), app);
  assert.equal(accesses.length, 3);
  assert.equal(await projectRoot(document, workspace, async () => { throw Error('missing'); }), workspace);
  await assert.rejects(projectRoot(document, undefined, async () => { throw Error('missing'); }), /No AL project root/);
});

test('resolves layout paths from project root with either separator and parent segments', () => {
  const root = path.resolve('project');
  assert.equal(resolveLayout(root, './Layouts\\Sales Invoice.rdlc'), path.join(root, 'Layouts', 'Sales Invoice.rdlc'));
  assert.equal(resolveLayout(root, '../Shared/Test.rdl'), path.resolve(root, '..', 'Shared', 'Test.rdl'));
});
