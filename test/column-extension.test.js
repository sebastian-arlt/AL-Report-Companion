'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const layouts = require('../src/layouts');
const { applyEdits, analyze } = require('../src/rdlc-fields');
function harness({ cancel = false, conflict = false, native = false, invalid = false, cursorOnSource = false, saveFails = false, cancelPreview = false, autoSavedBom = false, autoSavedCRLF = false, externalChangeAfterApply = false } = {}) {
  class Uri { constructor(filename) { this.fsPath = filename; this.scheme = 'file'; } toString() { return this.fsPath; } static file(filename) { return new Uri(filename); } }
  class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
  class WorkspaceEdit { constructor() { this.changes = []; } replace(uri, range, newText) { this.changes.push({ uri, range, newText }); } }
  const root = path.resolve('column-fixture');
  const al = new Uri(path.join(root, 'Report.al'));
  const rdlcs = ['one.rdlc', 'two.rdlc'].map(name => new Uri(path.join(root, name)));
  const source = `report 1 R { dataset { dataitem(Customer; Customer) { column(TelefonCaptionLbl; TelefonCaptionLbl) {} } } rendering { layout(One) { LayoutFile = 'one.rdlc'; } layout(Two) { LayoutFile = 'two.rdlc'; } } }`;
  const rdl = `<Report><DataSets><DataSet Name="DataSet_Result"><Fields><Field Name="TelefonCaptionLbl"><DataField>TelefonCaptionLbl</DataField></Field></Fields></DataSet></DataSets><Body><Value>=Fields!TelefonCaptionLbl.Value</Value></Body></Report>\n`;
  const disk = new Map([[al.fsPath, source], ...rdlcs.map(uri => [uri.fsPath, invalid ? '<Report>' : rdl])]);
  const docs = new Map(), saved = [], details = [];
  for (const [filename, text] of disk) docs.set(filename, { uri: new Uri(filename), fileName: filename, version: 1, text, isDirty: false, getText() { return this.text; }, offsetAt: p => p.character, positionAt: n => ({ line: 0, character: n }), async save() {
    saved.push(filename);
    if (saveFails || !require('../src/layout-save').diskMatchesRename(disk.get(filename), text, this.text)) return false;
    disk.set(filename, this.text); this.isDirty = false; return true;
  } });
  const commands = new Map(), errors = [], applied = [], invoked = [], contexts = [], prepared = [], subscriptions = [];
  let provider, documentChanged = () => {};
  const columnOffset = source.indexOf('TelefonCaptionLbl');
  const disposable = () => ({ dispose() {} });
  const vscode = { Uri, Range, WorkspaceEdit,
    languages: { registerRenameProvider(_selector, registered) { provider = registered; return { dispose() { provider = undefined; } }; } },
    window: { activeTextEditor: { document: docs.get(al.fsPath), selection: { active: { line: 0, character: columnOffset + (cursorOnSource ? 'TelefonCaptionLbl; '.length : 2) } } },
      createOutputChannel: () => ({ appendLine: line => details.push(line), show() {}, dispose() {} }),
      onDidChangeActiveTextEditor: disposable, onDidChangeTextEditorSelection: disposable,
      showInputBox: async () => { throw new Error('Top-of-window input must not be used'); }, showErrorMessage: msg => errors.push(msg), showInformationMessage() {} },
    commands: { registerCommand(id, handler) { commands.set(id, async (...args) => { await handler(...args); await new Promise(resolve => setTimeout(resolve, 20)); }); return disposable(); },
      async executeCommand(id, ...args) {
        invoked.push(id);
        if (id === 'setContext') contexts.push(args);
        if (id === 'editor.action.rename' && provider) {
          const active = vscode.window.activeTextEditor, current = provider;
          prepared.push(await current.prepareRename(active.document, active.selection.active));
          if (cancel) return;
          const edit = await current.provideRenameEdits(active.document, active.selection.active, 'TelefonCaptionLblTest', { isCancellationRequested: false });
          if (edit?.changes.length && !cancelPreview) await vscode.workspace.applyEdit(edit);
        }
        if (id === 'vscode.executeDocumentRenameProvider') {
          assert.equal(provider, undefined, 'Own provider must be removed before invoking native AL rename');
          if (conflict) disk.set(rdlcs[1].fsPath, rdl + '\n');
          if (native) return { entries: () => [[al, [{ range: new Range(docs.get(al.fsPath).positionAt(columnOffset), docs.get(al.fsPath).positionAt(columnOffset + 'TelefonCaptionLbl'.length)), newText: args[2] }]]] };
          throw new Error('AL cannot rename column');
        }
      } },
    workspace: { isTrusted: true, textDocuments: [...docs.values()], onDidChangeTextDocument: handler => { documentChanged = handler; return disposable(); },
      getWorkspaceFolder: () => ({ uri: new Uri(root) }), openTextDocument: async uri => docs.get(uri.fsPath),
      async applyEdit(edit) {
        applied.push(edit);
        for (const doc of docs.values()) {
          const edits = edit.changes.filter(change => change.uri.fsPath === doc.fileName).map(change => ({ start: change.range.start.character, end: change.range.end.character, text: change.newText }));
          if (edits.length) {
            doc.text = applyEdits(doc.text, edits); doc.version++; doc.isDirty = true;
            if (/\.rdlc$/i.test(doc.fileName)) {
              if (autoSavedBom) { disk.set(doc.fileName, '\uFEFF' + doc.text); doc.isDirty = false; }
              if (autoSavedCRLF) { disk.set(doc.fileName, doc.text.replace(/\n/g, '\r\n')); doc.isDirty = false; }
              if (externalChangeAfterApply) disk.set(doc.fileName, doc.text.replace('</Report>', '<Code>External change</Code></Report>'));
            }
            documentChanged({ document: doc });
          }
        }
        return true;
      } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/column-extension.js'), 'utf8'), { module, setTimeout, clearTimeout,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:fs/promises') return { readFile: async filename => disk.get(filename) };
      if (name === './layouts') return { ...layouts, projectRoot: async () => root };
      if (name === './column-rename') return require('../src/column-rename');
      if (name === './rdlc-fields') return require('../src/rdlc-fields');
      if (name === './layout-save') return require('../src/layout-save');
      throw new Error(name);
    } });
  module.exports.activateColumns({ subscriptions });
  return { commands, errors, applied, invoked, contexts, docs, al, rdlcs, saved, disk, details, prepared, providerActive: () => Boolean(provider), dispose() { for (const entry of subscriptions) entry.dispose(); } };
}
test('F2 declaration fallback renames column and both layouts in one edit', async () => {
  const h = harness(); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.errors.length, 0); assert.equal(h.applied.length, 1); assert.equal(h.applied[0].changes.length, 7);
  assert.ok(h.docs.get(h.al.fsPath).text.includes('column(TelefonCaptionLblTest; TelefonCaptionLbl)'));
  assert.ok(h.rdlcs.every(uri => analyze(h.docs.get(uri.fsPath).text).references.every(ref => ref.name === 'TelefonCaptionLblTest' && !ref.missing)));
  assert.deepEqual(h.saved, h.rdlcs.map(uri => uri.fsPath));
  assert.ok(h.disk.get(h.al.fsPath).includes('column(TelefonCaptionLbl; TelefonCaptionLbl)'));
  assert.ok(h.rdlcs.every(uri => h.disk.get(uri.fsPath) === h.docs.get(uri.fsPath).text));
  assert.equal(h.prepared[0].placeholder, 'TelefonCaptionLbl');
  assert.equal(h.prepared[0].range.start.character, h.docs.get(h.al.fsPath).text.indexOf('TelefonCaptionLblTest'));
  assert.ok(h.invoked.includes('editor.action.rename')); assert.equal(h.providerActive(), false);
});
test('uses native AL rename result and adds layout edits without duplicate declaration edit', async () => {
  const h = harness({ native: true }); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.errors.length, 0); assert.equal(h.applied[0].changes.length, 7);
  assert.ok(h.invoked.includes('vscode.executeDocumentRenameProvider'));
});
test('cancelling the F2 name prompt changes nothing', async () => {
  const h = harness({ cancel: true }); await h.commands.get('bcReportLayouts.renameColumn')(); assert.equal(h.applied.length, 0); assert.equal(h.saved.length, 0); assert.equal(h.providerActive(), false);
});
test('cancelling native rename preview never applies or saves the proposed changes', async () => {
  const h = harness({ cancelPreview: true });
  try { await h.commands.get('bcReportLayouts.renameColumn')(); assert.equal(h.applied.length, 0); assert.equal(h.saved.length, 0); }
  finally { h.dispose(); }
});
test('invalid layout aborts the complete AL and layout rename', async () => {
  const h = harness({ invalid: true }); await h.commands.get('bcReportLayouts.renameColumn')(); assert.equal(h.applied.length, 0); assert.match(h.errors[0], /Incomplete/);
});
test('concurrent external changes abort the complete rename', async () => {
  const h = harness({ conflict: true }); await h.commands.get('bcReportLayouts.renameColumn')(); assert.equal(h.applied.length, 0); assert.match(h.errors[0], /changed on disk/);
});
test('source expression retains normal F2 rename instead of renaming the column', async () => {
  const h = harness({ cursorOnSource: true }); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.contexts.at(-1)[1], false); assert.ok(h.invoked.includes('editor.action.rename')); assert.equal(h.applied.length, 0);
});
test('failed save reports the applied changes and requests manual saving', async () => {
  const h = harness({ saveFails: true }); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.applied.length, 1); assert.equal(h.errors.length, 1); assert.match(h.errors[0], /Could not automatically save 2 RDLC/); assert.equal(h.details.length, 2);
});
test('native auto-save with UTF-8 BOM does not produce a false rename conflict', async () => {
  const h = harness({ autoSavedBom: true }); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.errors.length, 0); assert.equal(h.saved.length, 0);
});
test('native auto-save with normalized line endings does not produce a false conflict', async () => {
  const h = harness({ autoSavedCRLF: true }); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.errors.length, 0); assert.equal(h.saved.length, 0);
});
test('real external content changes after application are not overwritten', async () => {
  const h = harness({ externalChangeAfterApply: true }); await h.commands.get('bcReportLayouts.renameColumn')();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0], /Could not automatically save 2 RDLC/); assert.equal(h.details.length, 2);
  assert.ok(h.rdlcs.every(uri => h.disk.get(uri.fsPath).includes('External change')));
});
test('validation and manual mapping are absent from both context menus and remain commands', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  for (const command of ['bcReportLayouts.validateFields', 'bcReportLayouts.renameFields']) {
    assert.ok(manifest.contributes.commands.some(entry => entry.command === command));
    for (const menu of ['editor/context', 'explorer/context']) assert.ok(!manifest.contributes.menus[menu].some(entry => entry.command === command));
  }
  assert.ok(manifest.contributes.keybindings.some(entry => entry.key === 'f2' && entry.when.includes('bcReportLayouts.columnRename')));
});
