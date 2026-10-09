'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const layouts = require('../src/layouts');

function harness({ pickIndex = 0, missing = false, trusted = true, text, position, workspaceFiles = [], existingSource = false } = {}) {
  const source = text || `report 1 Sales {\n rendering {\n layout(First) { LayoutFile = 'Layouts/First.rdlc'; Type = RDLC; }\n layout(Second) { Type = RDLC; LayoutFile = 'Layouts/Second.rdlc'; }\n }\n}`;
  class Uri {
    static file(fsPath) { return new Uri(fsPath); }
    constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
    toString() { return `file:///${this.fsPath.replace(/\\/g, '/')}`; }
  }
  const root = path.resolve('fixture-project');
  const document = {
    uri: new Uri(path.join(root, 'src', 'reports', 'Sales.al')),
    fileName: path.join(root, 'src', 'reports', 'Sales.al'),
    getText: () => source,
    offsetAt: position => source.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
    lineAt: index => ({ range: { start: { line: index, character: 0 }, end: { line: index, character: source.split('\n')[index].length } } })
  };
  const editor = { document, selection: { active: position || { line: text ? 0 : 3, character: text ? 0 : 40 } } };
  const layoutDocument = { uri: new Uri(path.join(root, 'Layouts', 'Second.rdlc')), isDirty: true, getText: () => '<Report>unsaved</Report>' };
  class TabInputText { constructor(uri) { this.uri = uri; } }
  const shown = [];
  const commands = new Map();
  const errors = []; const opened = []; const pickers = []; const contexts = [];
  let selectionChanged;
  const watcherHandlers = {};
  const vscode = {
    Uri, TabInputText, ViewColumn: { Active: -1 },
    commands: {
      registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; },
      executeCommand: (...args) => { contexts.push(args); return Promise.resolve(); }
    },
    window: {
      tabGroups: { all: existingSource ? [{viewColumn: 2, tabs: [{input: new TabInputText(layoutDocument.uri)}]}] : [] },
      showTextDocument: async (document, options) => { shown.push({document, options}); },
      activeTextEditor: editor, onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeTextEditorSelection: handler => { selectionChanged = handler; return { dispose() {} }; },
      showQuickPick: async choices => { pickers.push(choices); return choices[pickIndex]; },
      showErrorMessage: message => errors.push(message)
    },
    workspace: {
      isTrusted: trusted,
      textDocuments: [document],
      findFiles: async () => workspaceFiles.map(file => new Uri(file.path)),
      createFileSystemWatcher: () => ({ dispose() {},
        onDidCreate: handler => { watcherHandlers.create = handler; return { dispose() {} }; },
        onDidChange: handler => { watcherHandlers.change = handler; return { dispose() {} }; },
        onDidDelete: handler => { watcherHandlers.delete = handler; return { dispose() {} }; } }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      openTextDocument: async uri => /\.al$/i.test(uri.fsPath) ? document : layoutDocument,
      getWorkspaceFolder: () => ({ uri: new Uri(root) })
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), {
    module, process: { platform: 'win32' },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './layouts') return { ...layouts, projectRoot: async () => root };
      if (name === './windows') return { openWithWindows: async file => opened.push(file) };
      if (name === './cal-extension') return { activateCal() {} };
      if (name === './field-extension') return { activateFields() {} };
      if (name === './column-extension') return { activateColumns() {} };
      if (name === 'node:fs/promises') return {
        readFile: async filename => {
          const file = workspaceFiles.find(file => file.path === filename);
          if (!file) throw Error('missing');
          return file.text;
        },
        stat: async () => { if (missing) throw Error('missing'); return { isFile: () => true }; }
      };
      throw Error(`Unexpected dependency ${name}`);
    }
  });
  module.exports.activate({ subscriptions: [] });
  return { commands, document, editor, root, errors, opened, pickers, contexts, shown, layoutDocument,
    select: position => { editor.selection.active = position; selectionChanged(); },
    resource: filename => new Uri(filename),
    fileEvent: (event, filename) => watcherHandlers[event](new Uri(filename)),
    context: key => contexts.filter(args => args[1] === key).at(-1)?.[2] };
}

test('editor command opens the layout at the caret even when passed a URI', async () => {
  const h = harness();
  await h.commands.get('bcReportLayouts.openExternally')(h.document.uri);
  assert.deepEqual(h.opened, [path.join(h.root, 'Layouts', 'Second.rdlc')]);
  assert.equal(h.pickers.length, 0);
  assert.deepEqual(h.contexts[0], ['setContext', 'bcReportLayouts.hasLayouts', true]);
});

test('menu switches format with the caret and offers both away from declarations', () => {
  const h = harness({ text: `report 1 Sales {
    RDLCLayout = 'Layouts/Sales.rdlc';
    WordLayout = 'Layouts/Sales.docx';
  }`, position: { line: 1, character: 10 } });
  assert.equal(h.context('bcReportLayouts.showRDLC'), true);
  assert.equal(h.context('bcReportLayouts.showDOCX'), false);
  h.select({ line: 2, character: 10 });
  assert.equal(h.context('bcReportLayouts.showRDLC'), false);
  assert.equal(h.context('bcReportLayouts.showDOCX'), true);
  h.select({ line: 0, character: 0 });
  assert.equal(h.context('bcReportLayouts.showRDLC'), true);
  assert.equal(h.context('bcReportLayouts.showDOCX'), true);
  assert.ok(h.context('bcReportLayouts.rdlcResources').includes(h.document.uri.toString()));
  assert.ok(h.context('bcReportLayouts.docxResources').includes(h.document.uri.toString()));
});

test('typed commands and Explorer pickers only open layouts of the requested format', async () => {
  const h = harness({ text: `report 1 Sales {
    rendering {
      layout(RDLC) { LayoutFile = 'Layouts/Sales.rdlc'; Type = RDLC; }
      layout(Word) { LayoutFile = 'Layouts/Sales.docx'; Type = Word; }
      layout(WordCopy) { LayoutFile = 'Layouts/Copy.docx'; Type = Word; }
    }
  }`, position: { line: 2, character: 40 } });
  await h.commands.get('bcReportLayouts.openDOCX')(h.document.uri);
  assert.equal(h.pickers[0].length, 2);
  assert.deepEqual(h.opened, [path.join(h.root, 'Layouts', 'Sales.docx')]);
  await h.commands.get('bcReportLayouts.chooseRDLC')(h.document.uri);
  assert.equal(h.pickers.length, 1);
  assert.equal(h.opened[1], path.join(h.root, 'Layouts', 'Sales.rdlc'));
});

test('single Word report only contributes Word menu contexts', () => {
  const h = harness({ text: "report 1 Sales { WordLayout = 'Layouts/Sales.docx'; }" });
  assert.equal(h.context('bcReportLayouts.showRDLC'), false);
  assert.equal(h.context('bcReportLayouts.showDOCX'), true);
  assert.equal(h.context('bcReportLayouts.rdlcResources').length, 0);
  assert.equal(h.context('bcReportLayouts.docxResources').length, 1);
});

test('Explorer indexing recognizes formats in unopened AL files independently of active report', async () => {
  const file = { path: path.resolve('fixture-project', 'Other.al'), text: "report 2 Other { WordLayout = 'Other.docx'; }" };
  const h = harness({ workspaceFiles: [file] });
  await new Promise(resolve => setImmediate(resolve));
  const uri = h.resource(file.path).toString();
  assert.ok(h.context('bcReportLayouts.docxResources').includes(uri));
  assert.ok(!h.context('bcReportLayouts.rdlcResources').includes(uri));
  assert.equal(h.context('bcReportLayouts.showDOCX'), false);
  file.text = "report 2 Other { RDLCLayout = 'Other.rdlc'; }";
  h.fileEvent('change', file.path);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!h.context('bcReportLayouts.docxResources').includes(uri));
  assert.ok(h.context('bcReportLayouts.rdlcResources').includes(uri));
  h.fileEvent('delete', file.path);
  assert.ok(!h.context('bcReportLayouts.rdlcResources').includes(uri));
});

test('Explorer offers all layouts regardless of active editor caret', async () => {
  const h = harness();
  await h.commands.get('bcReportLayouts.chooseAndOpenExternally')(h.document.uri);
  assert.equal(h.pickers[0].length, 2);
  assert.deepEqual(h.opened, [path.join(h.root, 'Layouts', 'First.rdlc')]);
});

test('picker cancellation opens nothing', async () => {
  const h = harness({ pickIndex: -1 });
  await h.commands.get('bcReportLayouts.chooseAndOpenExternally')(h.document.uri);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.errors, []);
});

test('missing layout reports resolved target and never launches Windows', async () => {
  const h = harness({ missing: true });
  await h.commands.get('bcReportLayouts.openExternally')();
  assert.deepEqual(h.opened, []);
  assert.ok(h.errors[0].includes(path.join(h.root, 'Layouts', 'Second.rdlc')));
});

test('untrusted and non-report documents cannot launch layouts', async () => {
  const untrusted = harness({ trusted: false });
  await untrusted.commands.get('bcReportLayouts.openExternally')();
  assert.match(untrusted.errors[0], /Trust this workspace/);
  assert.deepEqual(untrusted.opened, []);
  const page = harness({ text: "page 1 X { Caption = 'report.rdlc'; }" });
  await page.commands.get('bcReportLayouts.openExternally')();
  assert.match(page.errors[0], /No RDL\/RDLC or Word layout/);
  assert.equal(page.contexts[0][2], false);
});

test('Word layouts are dispatched to the Windows default application', async () => {
  for (const text of [
    "report 1 Sales { WordLayout = 'Layouts/Sales.docx'; }",
    "report 1 Sales { rendering { layout(Word) { Type = Word; LayoutFile = 'Layouts/Sales.docx'; } } }"
  ]) {
    const h = harness({ text });
    await h.commands.get('bcReportLayouts.chooseAndOpenExternally')(h.document.uri);
    assert.deepEqual(h.opened, [path.join(h.root, 'Layouts', 'Sales.docx')]);
    assert.deepEqual(h.errors, []);
    assert.equal(h.contexts[0][2], true);
  }
});

for (const existingSource of [false, true]) {
  test('RDLC source command ' + (existingSource ? 'reuses existing text tab and unsaved document' : 'opens a pinned source tab'), async () => {
    const h = harness({existingSource});
    await h.commands.get('bcReportLayouts.openRDLCSource')(h.document.uri);
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].document, h.layoutDocument);
    assert.equal(h.shown[0].options.preview, false);
    assert.equal(h.shown[0].options.viewColumn, existingSource ? 2 : -1);
    assert.equal(h.layoutDocument.isDirty, true);
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.errors, []);
  });
}
test('source command cannot open Word layouts as text', async () => {
  const h = harness({text: "report 1 Sales { WordLayout = 'Layouts/Sales.docx'; }"});
  await h.commands.get('bcReportLayouts.openRDLCSource')(h.document.uri);
  assert.equal(h.shown.length, 0);
  assert.match(h.errors[0], /No RDLC/);
});
test('source menu entries only appear for RDLC contexts', () => {
  const p = require('../package.json');
  assert.equal(p.displayName, 'AL Report Companion');
  const editor = p.contributes.menus['editor/context'].find(x => x.command === 'bcReportLayouts.openRDLCSource');
  const explorer = p.contributes.menus['explorer/context'].find(x => x.command === 'bcReportLayouts.chooseRDLCSource');
  assert.match(editor.when, /showRDLC/);
  assert.match(explorer.when, /rdlcResources/);
});
