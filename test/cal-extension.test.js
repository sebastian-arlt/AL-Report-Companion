'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const calLayouts = require('../src/cal-layouts');
const { CalSessions } = require('../src/cal-sessions');
const { calReport } = require('./cal-fixtures');

function harness(storagePath, state = new Map(), initialText = calReport(), race = false) {
  let text = initialText;
  const commands = new Map(); const messages = []; const errors = []; const opened = [];
  class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
    toString() { return `file:///${this.fsPath.replace(/\\/g, '/')}`; }
  }
  const document = { uri: new Uri(path.join(storagePath, 'Report.txt')), version: 1,
    fileName: path.join(storagePath, 'Report.txt'), getText: () => text,
    offsetAt: value => value, positionAt: value => value };
  const editor = { document, selection: { active: 10 } };
  class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, replacement) { this.edits.push({ uri, range, replacement }); } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  const vscode = {
    Uri, WorkspaceEdit, Range,
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return { dispose() {} }; }, executeCommand: async () => {} },
    window: { activeTextEditor: editor, onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      showQuickPick: async items => items[0], showErrorMessage: value => errors.push(value),
      showInformationMessage: value => messages.push(value), showTextDocument: async () => {} },
    workspace: { isTrusted: true, textDocuments: [document], openTextDocument: async () => document,
      getConfiguration: () => ({ get: () => 'C:\\Tools\\MSReportBuilder.exe' }),
      onDidChangeTextDocument: () => ({ dispose() {} }), findFiles: async () => [],
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }) }),
      applyEdit: async edit => { for (const change of edit.edits) {
        text = text.slice(0, change.range.start) + change.replacement + text.slice(change.range.end);
      } document.version++; return true; }
    }
  };
  const module = { exports: {} };
  const processor = async job => {
    if (race && job.operation === 'import') { text = text.replace('Version List=TEST;', 'Version List=CHANGED;'); document.version++; }
    return { namespace: 'http://schemas.microsoft.com/sqlserver/reporting/2010/01/reportdefinition', xml: job.xml, changes: [] };
  };
  vm.runInNewContext(fsSync.readFileSync(path.join(__dirname, '../src/cal-extension.js'), 'utf8'), {
    module, process: { platform: 'win32' },
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === 'node:path') return path;
      if (name === 'node:fs/promises') return fs;
      if (name === './cal-layouts') return calLayouts;
      if (name === './cal-sessions') return { CalSessions };
      if (name === './rdl-processor') return { processRdl: processor };
      if (name === './windows') return {
        findReportBuilder: async filename => filename,
        openWithWindows: async (filename, _launch, builder) => opened.push({ filename, builder })
      };
      throw Error(`Unexpected dependency ${name}`);
    }
  });
  module.exports.activateCal({ subscriptions: [], storageUri: new Uri(storagePath),
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) } });
  return { commands, document, errors, opened, messages, state, source: () => text };
}

test('C/AL commands extract, reopen, import and restore sessions across extension reloads', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-command-test-'));
  try {
    const h = harness(folder);
    await h.commands.get('bcReportLayouts.openCalRDLC')(h.document.uri);
    assert.deepEqual(h.errors, []);
    const session = h.state.get('calLayoutSessions')[0];
    assert.equal(h.opened[0].filename, session.layoutPath);
    assert.equal(h.opened[0].builder, 'C:\\Tools\\MSReportBuilder.exe');
    const external = (await fs.readFile(session.layoutPath, 'utf8')).replace('Original ä', 'Edited ö');
    await fs.writeFile(session.layoutPath, external, 'utf8');
    await h.commands.get('bcReportLayouts.openCalRDLC')(h.document.uri);
    assert.equal(h.state.get('calLayoutSessions').length, 1);
    assert.equal(await fs.readFile(session.layoutPath, 'utf8'), external);
    await h.commands.get('bcReportLayouts.importCalRDLC')(h.document.uri);
    assert.deepEqual(h.errors, []);
    assert.ok(h.source().includes('Edited ö'));
    assert.ok(h.source().includes("MESSAGE('Grüße')"));
    const reloaded = harness(folder, h.state, h.source());
    await reloaded.commands.get('bcReportLayouts.importCalRDLC')(reloaded.document.uri);
    assert.deepEqual(reloaded.errors, []);
    assert.ok(reloaded.messages.at(-1).includes('no changes'));
    await reloaded.commands.get('bcReportLayouts.closeCalSession')(reloaded.document.uri);
    assert.equal(h.state.get('calLayoutSessions').length, 0);
    assert.equal(await fs.readFile(session.layoutPath, 'utf8'), external);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('C/AL command refuses source changes occurring during external-layout validation', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-race-test-'));
  try {
    const h = harness(folder, new Map(), calReport(), true);
    await h.commands.get('bcReportLayouts.openCalRDLC')();
    const session = h.state.get('calLayoutSessions')[0];
    const external = (await fs.readFile(session.layoutPath, 'utf8')).replace('Original ä', 'Edited ö');
    await fs.writeFile(session.layoutPath, external, 'utf8');
    await h.commands.get('bcReportLayouts.importCalRDLC')();
    assert.match(h.errors.at(-1), /changed during validation/);
    assert.ok(h.source().includes('Original ä'));
    assert.ok(!h.source().includes('Edited ö'));
    assert.equal(await fs.readFile(session.layoutPath, 'utf8'), external);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('C/AL commands refuse a source decoded with replacement characters', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-encoding-test-'));
  try {
    const h = harness(folder, new Map(), calReport().replace('Grüße', 'Gr\uFFFD\uFFFDe'));
    await h.commands.get('bcReportLayouts.openCalRDLC')();
    assert.match(h.errors.at(-1), /Reopen with Encoding/);
    assert.equal(h.opened.length, 0);
    assert.equal(h.state.size, 0);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
