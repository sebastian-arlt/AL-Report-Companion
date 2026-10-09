'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../src/rdlc-fields');
const layoutCore = require('../src/layouts');
const rdl = field => `<Report><DataSets><DataSet Name="DataSet_Result"><Fields><Field Name="${field}"><DataField>${field}</DataField></Field></Fields></DataSet></DataSets><Body><Value>=Fields!Old.Value + Fields!Old.Value</Value></Body></Report>`;
function harness({ cancel = false, conflict = false, trusted = true, vbWarnings = [], vbEnabled = true, vbUnavailable = false, copEnabled = true, configForUri } = {}) {
  class Uri {
    constructor(value) { this.value = value; this.scheme = value.split(':')[0]; this.fsPath = value.replace(/^file:/, ''); this.path = this.fsPath; }
    toString() { return this.value; }
    static file(value) { return new Uri('file:' + value); }
    static parse(value) { return new Uri(value); }
    static from(value) { return new Uri(value.scheme + ':' + value.path); }
  }
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  class Range { constructor(start, end, lastLine, lastChar) { this.start = typeof start === 'number' ? new Position(start, end) : start; this.end = typeof start === 'number' ? new Position(lastLine, lastChar) : end; } }
  class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
  class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } }
  const root = path.resolve('field-fixture');
  const al = Uri.file(path.join(root, 'Report.al'));
  const uris = ['one.rdlc', 'two.rdlc'].map(name => Uri.file(path.join(root, name)));
  const files = new Map([[al.fsPath, "report 1 Example { rendering { layout(One) { Type = RDLC; LayoutFile = 'one.rdlc'; } layout(Two) { Type = RDLC; LayoutFile = 'two.rdlc'; } } }"], ...uris.map(uri => [uri.fsPath, rdl('Old')])]);
  const documents = new Map(); const values = new Map(); const warnings = new Map(); const commands = new Map(); const errors = []; const info = []; const applied = []; const diffs = []; const state = {};
  const subscriptions = [];
  const disposable = () => ({ dispose() {} });
  let picks = 0;
  let vbCalls = 0, configurationChanged;
  const collection = { set: (uri, entries) => values.set(uri.toString(), entries), get: uri => values.get(uri.toString()), delete: uri => values.delete(uri.toString()), dispose() {} };
  const workspace = {
    isTrusted: trusted, textDocuments: [], findFiles: async () => [al], getWorkspaceFolder: () => ({ uri: Uri.file(root) }),
    asRelativePath: uri => path.basename(uri.fsPath), registerTextDocumentContentProvider: disposable,
    getConfiguration: (_section, uri) => ({ get: (name, fallback) => name === 'enableReportCop' ? (configForUri ? configForUri(uri) : copEnabled) : name === 'validateVisualBasic' ? vbEnabled : fallback }),
    onDidChangeConfiguration: handler => { configurationChanged = handler; return disposable(); },
    onDidChangeTextDocument: disposable, onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable,
    createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }),
    openTextDocument: async uri => {
      if (!documents.has(uri.fsPath)) {
        const doc = { uri, fileName: uri.fsPath, content: files.get(uri.fsPath), getText() { return this.content; }, isDirty: false };
        documents.set(uri.fsPath, doc); workspace.textDocuments.push(doc);
      }
      return documents.get(uri.fsPath);
    },
    applyEdit: async edit => {
      applied.push(edit);
      for (const uri of uris) {
        const doc = documents.get(uri.fsPath); if (!doc) continue;
        const edits = edit.edits.filter(change => change.uri.toString() === uri.toString()).map(change => ({ start: change.range.start.character, end: change.range.end.character, text: change.text }));
        doc.content = core.applyEdits(doc.content, edits); doc.isDirty = true;
      }
      return true;
    }
  };
  const vscode = { Uri, Position, Range, Diagnostic, WorkspaceEdit, DiagnosticSeverity: { Error: 0, Warning: 1 }, CodeActionKind: { QuickFix: 'quickfix' },
    languages: { createDiagnosticCollection: name => name === 'bc-report-unused-columns' ? { set: (uri, entries) => warnings.set(uri.toString(), entries), delete: uri => warnings.delete(uri.toString()), dispose() {} } : collection, registerCodeActionsProvider: disposable }, workspace,
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      async executeCommand(id, ...args) { if (id === 'vscode.diff') { diffs.push(args); if (conflict) files.set(uris[1].fsPath, rdl('New') + '\n'); } }
    },
    window: { activeTextEditor: { document: { uri: al } }, showErrorMessage: message => errors.push(message), showInformationMessage: message => info.push(message),
      async showQuickPick(items) { picks++; if (picks === 1) return items[0]; if (picks === 2) return items.find(item => item.label === 'New'); if (cancel) return undefined; return items.find(item => item.apply); }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/field-extension.js'), 'utf8'), { module, console, setTimeout, clearTimeout,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === './rdlc-fields') return core;
      if (name === './column-usage') return require('../src/column-usage');
      if (name === './rdlc-vb') return { validateVb: async () => { vbCalls++; if (vbUnavailable) throw new Error('Compiler not installed.'); return vbWarnings; } };
      if (name === './vb-compiler') return { compileVb: async () => [] };
      if (name === './layouts') return { ...layoutCore, projectRoot: async () => root };
      if (name === 'node:fs/promises') return { readFile: async file => { if (!files.has(file)) throw new Error('Missing'); return files.get(file); } };
      throw new Error(name);
    }
  });
  module.exports.activateFields({ subscriptions, workspaceState: { get: key => state[key] || {}, update: async (key, value) => { state[key] = value; } } });
  return { al, uris, values, warnings, files, workspace, state, commands, errors, info, applied, diffs, documents,
    vbCalls: () => vbCalls,
    setCop(value) { copEnabled = value; configurationChanged({ affectsConfiguration: name => name === 'bcReportLayouts.enableReportCop' }); },
    build() { for (const uri of uris) files.set(uri.fsPath, rdl('New')); },
    dispose() { for (const item of subscriptions) item.dispose(); } };
}
test('captures inventory before build and publishes all stale references in both layouts', async () => {
  const h = harness();
  try {
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    h.build(); await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.ok(h.uris.every(uri => h.values.get(uri.toString()).length === 2));
    assert.equal(h.state.layoutFieldHistory[h.uris[0].toString()].baseline.DataSet_Result[0].name, 'Old');
    assert.equal(h.state.layoutFieldHistory[h.uris[0].toString()].current.DataSet_Result[0].name, 'New');
  } finally { h.dispose(); }
});
test('unused columns produce AL warnings at their names and a usage in either layout clears the warning', async () => {
  const h = harness();
  try {
    const text = "report 1 Example { dataset { dataitem(Item; Item) { column(Old; OldLbl) {} } } RDLCLayout = 'one.rdlc'; rendering { layout(Two) { Type = RDLC; LayoutFile = 'two.rdlc'; } } }";
    h.files.set(h.al.fsPath, text);
    for (const uri of h.uris) h.files.set(uri.fsPath, rdl('Old').replace('=Fields!Old.Value + Fields!Old.Value', 'Old'));
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    const warning = h.warnings.get(h.al.toString())[0];
    assert.equal(warning.severity, 1); assert.equal(warning.code, 'unused-layout-column');
    assert.equal(text.slice(warning.range.start.character, warning.range.end.character), 'Old');
    h.files.set(h.uris[1].fsPath, rdl('Old'));
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.warnings.get(h.al.toString()).length, 0);
    h.files.set(h.al.fsPath, 'report 1 Example { dataset { dataitem(Item; Item) { column(Old; OldLbl) {} } } }');
    await h.commands.get('bcReportLayouts.validateFields')(h.uris[1]);
    assert.equal(h.warnings.has(h.al.toString()), false);
  } finally { h.dispose(); }
});
test('an unreadable linked layout prevents unused-column warnings', async () => {
  const h = harness();
  try {
    h.files.set(h.al.fsPath, "report 1 R { dataset { dataitem(I; Item) { column(Old; OldLbl) {} } } RDLCLayout = 'one.rdlc'; rendering { layout(Two) { LayoutFile = 'two.rdlc'; } } }");
    h.files.set(h.uris[0].fsPath, rdl('Old').replace('=Fields!Old.Value + Fields!Old.Value', 'Plain'));
    h.files.delete(h.uris[1].fsPath);
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.warnings.get(h.al.toString()).length, 0);
    assert.equal(h.values.get(h.uris[1].toString()).length, 1);
  } finally { h.dispose(); }
});
test('confirmed mapping previews and changes all report layouts in one undoable edit', async () => {
  const h = harness();
  try {
    await h.commands.get('bcReportLayouts.validateFields')(h.al); h.build();
    await h.commands.get('bcReportLayouts.renameFields')(h.al);
    assert.equal(h.errors.length, 0); assert.equal(h.diffs.length, 1);
    assert.equal(h.applied.length, 1); assert.equal(h.applied[0].edits.length, 4);
    assert.ok(h.uris.every(uri => h.values.get(uri.toString()).length === 0));
    assert.ok([...h.documents.values()].every(doc => doc.isDirty));
  } finally { h.dispose(); }
});
test('cancel after preview leaves every layout untouched', async () => {
  const h = harness({ cancel: true });
  try { await h.commands.get('bcReportLayouts.validateFields')(h.al); h.build(); await h.commands.get('bcReportLayouts.renameFields')(h.al); assert.equal(h.applied.length, 0); assert.equal(h.diffs.length, 1); }
  finally { h.dispose(); }
});
test('file change during review aborts edits across every layout', async () => {
  const h = harness({ conflict: true });
  try { await h.commands.get('bcReportLayouts.validateFields')(h.al); h.build(); await h.commands.get('bcReportLayouts.renameFields')(h.al); assert.equal(h.applied.length, 0); assert.match(h.errors[0], /changed during review/); }
  finally { h.dispose(); }
});
test('untrusted workspaces cannot validate or rename', async () => {
  const h = harness({ trusted: false });
  try { await h.commands.get('bcReportLayouts.renameFields')(h.al); assert.equal(h.applied.length, 0); assert.match(h.errors[0], /Trust this workspace/); }
  finally { h.dispose(); }
});
test('VB diagnostics appear as errors in each layout without modifying or saving AL', async () => {
  const h = harness({ vbWarnings: [{ start: 3, end: 8, code: 'BC30456', message: "VB BC30456: Member 'Typo' does not exist." }] });
  try {
    const original = h.files.get(h.al.fsPath);
    await h.commands.get('bcReportLayouts.validateVB')(h.al);
    for (const uri of h.uris) {
      const entries = h.values.get(uri.toString());
      assert.equal(entries.length, 1); assert.equal(entries[0].severity, 0); assert.equal(entries[0].source, 'AL Report Companion VB');
    }
    assert.equal(h.files.get(h.al.fsPath), original); assert.equal(h.applied.length, 0); assert.ok(h.info.at(-1).includes('2 error(s), 0 warning(s)'));
  } finally { h.dispose(); }
});
test('disabling VB validation skips the compiler and compiler unavailability does not hide field errors', async () => {
  const disabled = harness({ vbEnabled: false });
  try { await disabled.commands.get('bcReportLayouts.validateVB')(disabled.al); assert.equal(disabled.vbCalls(), 0); }
  finally { disabled.dispose(); }
  const unavailable = harness({ vbUnavailable: true });
  try {
    unavailable.build(); await unavailable.commands.get('bcReportLayouts.validateVB')(unavailable.al);
    for (const uri of unavailable.uris) {
      const entries = unavailable.values.get(uri.toString());
      assert.equal(entries.filter(entry => entry.severity === 0).length, 3);
      assert.equal(entries.filter(entry => entry.code === 'rdlc-vb-unavailable').length, 1);
    }
  } finally { unavailable.dispose(); }
});

test('RDLC diagnostics use native VS Code display without duplicate decoration or hover providers', async () => {
  const h = harness({vbWarnings: [{start: 3, end: 8, code: 'BC30456', message: "VB BC30456: Member 'Typo' does not exist."}]});
  try {
    // The harness exposes no decoration API or hover provider registration.
    await h.commands.get('bcReportLayouts.validateVB')(h.al);
    for (const uri of h.uris) {
      const entries = h.values.get(uri.toString());
      assert.equal(entries.length, 1); assert.equal(entries[0].severity, 0);
      assert.equal(entries[0].code, 'rdlc-vb:BC30456');
    }
  } finally {h.dispose();}
});


test('unchanged layouts reuse validation and only a changed layout is revalidated', async () => {
  const h = harness();
  try {
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.vbCalls(), 2);
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.vbCalls(), 2);
    h.files.set(h.al.fsPath, h.files.get(h.al.fsPath) + '\n// AL-only change');
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.vbCalls(), 2);
    h.files.set(h.uris[0].fsPath, rdl('New'));
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.vbCalls(), 3);
    assert.equal(h.values.get(h.uris[0].toString()).length, 2);
    assert.equal(h.values.get(h.uris[1].toString()).length, 0);
  } finally { h.dispose(); }
});

test('compiler failures remain retryable for unchanged layouts', async () => {
  const h = harness({ vbUnavailable: true });
  try {
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    const calls = h.vbCalls();
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.ok(h.vbCalls() > calls);
  } finally { h.dispose(); }
});


test('Report Cop is opt-in and disabled projects never invoke the VB validator or publish diagnostics', async () => {
  const h = harness({ copEnabled: false });
  try {
    h.build(); await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.vbCalls(), 0);
    assert.equal(h.values.size, 0); assert.equal(h.warnings.size, 0);
    assert.match(h.errors.at(-1), /Report Cop is disabled/);
  } finally { h.dispose(); }
});

test('changing Report Cop settings clears diagnostics immediately and enables fresh validation', async () => {
  const h = harness();
  try {
    h.build(); await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.ok(h.values.size > 0);
    h.setCop(false);
    assert.equal(h.values.size, 0); assert.equal(h.warnings.size, 0);
    await h.commands.get('bcReportLayouts.validateFields')(h.al);
    const calls = h.vbCalls();
    h.setCop(true); await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.ok(h.vbCalls() > calls); assert.ok(h.values.size > 0);
  } finally { h.dispose(); }
});

test('explicit field rename remains available with Report Cop disabled', async () => {
  const h = harness({ copEnabled: false });
  try {
    h.build(); await h.commands.get('bcReportLayouts.renameFields')(h.al);
    assert.equal(h.errors.length, 0); assert.equal(h.applied.length, 1);
    assert.equal(h.vbCalls(), 0); assert.equal(h.values.size, 0);
  } finally { h.dispose(); }
});

test('Report Cop uses the owning AL project settings for linked layouts', async () => {
  const h = harness({ configForUri: uri => /Report\.al$/.test(uri.fsPath) });
  try {
    h.build(); await h.commands.get('bcReportLayouts.validateFields')(h.al);
    assert.equal(h.vbCalls(), 2); assert.equal(h.values.size, 2);
  } finally { h.dispose(); }
});
