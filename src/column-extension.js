'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const { columns, validName, layoutColumnEdits } = require('./column-rename');
const { findLayouts, projectRoot, resolveLayout } = require('./layouts');
const { applyEdits } = require('./rdlc-fields');
const { bytes, comparableText } = require('./layout-save');

function activateColumns(context) {
  let busy = false;
  const pendingSaves = new Set();
  const output = vscode.window.createOutputChannel('AL Report Companion');
  let saving = false;
  let saveAgain = false;
  let saveTimer;
  function scheduleSaves() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveAppliedLayouts(); }, 0);
  }
  async function saveAppliedLayouts() {
    if (saving) { saveAgain = true; return; }
    saving = true;
    const failures = [];
    try {
    for (const plan of pendingSaves) {
      for (const item of [...plan.layouts]) {
        if (comparableText(item.record.doc.getText()) !== comparableText(item.expected)) continue;
        plan.layouts.delete(item);
        try {
          // A native rename can save a previously closed file itself. Its disk
          // writes, encoding and save participants belong to VS Code's file
          // model, not our original byte snapshot. Let that model handle save
          // conflicts instead of racing its writes with a second disk read.
          if (!item.record.doc.isDirty) continue;
          if (comparableText(item.record.doc.getText()) !== comparableText(item.expected)) throw new Error('Layout changed in the editor; review and save it manually.');
          if (!await item.record.doc.save()) throw new Error(`Rename applied, but could not save ${item.record.uri.fsPath}. Save it manually.`);
        } catch (error) {
          failures.push(item.record.uri.fsPath);
          output.appendLine(`Save failed: ${item.record.uri.fsPath} (document version ${item.record.doc.version}, dirty ${item.record.doc.isDirty}). ${error.message}`);
        }
      }
      if (!plan.layouts.size) { clearTimeout(plan.expiry); pendingSaves.delete(plan); }
    }
    } finally { saving = false; if (saveAgain) { saveAgain = false; scheduleSaves(); } }
    if (failures.length) {
      const choice = await vscode.window.showErrorMessage(`Rename Report Column: Could not automatically save ${failures.length} RDLC layout(s). AL remains unsaved. Review VS Code's save-conflict notification or save the layouts manually.`, 'Show details');
      if (choice === 'Show details') output.show(true);
    }
  }
  function selectedColumn() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'file' || !/\.al$/i.test(editor.document.fileName)) return undefined;
    const offset = editor.document.offsetAt(editor.selection.active);
    const column = columns(editor.document.getText()).find(column => column.start <= offset && offset <= column.end);
    return column && { editor, column };
  }
  function updateContext() {
    void vscode.commands.executeCommand('setContext', 'bcReportLayouts.columnRename', Boolean(vscode.workspace.isTrusted && selectedColumn()));
  }
  async function renameColumn() {
    const selected = selectedColumn();
    if (!selected) { await vscode.commands.executeCommand('editor.action.rename'); return; }
    if (busy) return;
    busy = true;
    let registration;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before renaming report columns.');
      const { editor, column } = selected, document = editor.document;
      const original = document.getText(), version = document.version;
      // Register immediately before opening the native widget. The provider is
      // scoped to the selected declaration and removed before calling AL's
      // provider, preventing recursion and preserving normal AL renames.
      registration = vscode.languages.registerRenameProvider({ scheme: 'file', language: document.languageId, pattern: '**/*.al' }, {
        prepareRename(doc, position) {
          const offset = doc.offsetAt(position);
          if (doc.uri.toString() !== document.uri.toString() || offset < column.start || offset > column.end) return undefined;
          if (doc.version !== version || doc.getText() !== original) throw new Error('The AL report changed. Try again.');
          return { range: new vscode.Range(doc.positionAt(column.start + (column.quoted ? 1 : 0)), doc.positionAt(column.end - (column.quoted ? 1 : 0))), placeholder: column.name };
        },
        async provideRenameEdits(doc, position, newName, token) {
          const offset = doc.offsetAt(position);
          if (doc.uri.toString() !== document.uri.toString() || offset < column.start || offset > column.end) return undefined;
          registration?.dispose(); registration = undefined;
          try { return await computeRename(document, column, original, version, newName, token); }
          catch (error) { void vscode.window.showErrorMessage(`Rename Report Column: ${error.message}`); return new vscode.WorkspaceEdit(); }
        }
      });
      await vscode.commands.executeCommand('editor.action.rename');
      scheduleSaves();
    } catch (error) { void vscode.window.showErrorMessage(`Rename Report Column: ${error.message}`); }
    finally { registration?.dispose(); busy = false; updateContext(); }
  }
  async function computeRename(document, column, original, version, newName, token) {
      if (token.isCancellationRequested || newName === column.name) return new vscode.WorkspaceEdit();
      if (!validName(newName) || columns(original).some(other => other.start !== column.start && other.name.toLowerCase() === newName.toLowerCase())) throw new Error('Invalid or duplicate column name.');
      if (document.version !== version || document.getText() !== original) throw new Error('The AL report changed while entering the name. Try again.');
      const snapshots = new Map();
      async function snapshot(uri) {
        const key = uri.toString();
        if (snapshots.has(key)) return snapshots.get(key);
        if (uri.scheme !== 'file') throw new Error('Only local files are supported.');
        const diskBytes = bytes(await fs.readFile(uri.fsPath));
        const doc = await vscode.workspace.openTextDocument(uri);
        const record = { uri, doc, text: doc.getText(), version: doc.version, diskBytes };
        snapshots.set(key, record); return record;
      }
      const al = await snapshot(document.uri);
      if (al.text !== original) throw new Error('The AL report changed. Try again.');
      const root = await projectRoot(document.fileName, vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath);
      const paths = [...new Set(findLayouts(original).filter(layout => /\.rdlc?$/i.test(layout.path)).map(layout => resolveLayout(root, layout.path)))];
      const layoutChanges = [];
      for (const filename of paths) {
        const record = await snapshot(vscode.Uri.file(filename));
        const edits = layoutColumnEdits(record.text, column.name, newName);
        if (edits.length) layoutChanges.push({ record, edits });
      }
      // The temporary provider has already been unregistered, so this request
      // reaches the installed AL language service without recursive calls.
      let native;
      try { native = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, document.positionAt(column.start + (column.quoted ? 1 : 0)), newName); }
      catch { /* AL versions without column rename support use the declaration fallback. */ }
      const edit = new vscode.WorkspaceEdit();
      const entries = native?.entries?.() || [];
      let hasDeclaration = false;
      for (const [uri, edits] of entries) {
        if (/\.rdlc?$/i.test(uri.fsPath)) throw new Error('Another rename provider also changes RDLC files. Use one rename integration at a time.');
        const record = await snapshot(uri);
        for (const change of edits) {
          if (uri.toString() === document.uri.toString()) {
            const start = document.offsetAt(change.range.start), end = document.offsetAt(change.range.end);
            if (start < column.end && end > column.start) hasDeclaration = true;
          }
          edit.replace(uri, change.range, change.newText);
        }
      }
      if (entries.length && !hasDeclaration) throw new Error('The AL rename provider did not rename the selected column. No changes applied.');
      if (!hasDeclaration) edit.replace(document.uri, new vscode.Range(document.positionAt(column.start), document.positionAt(column.end)), column.quoted ? `"${newName}"` : newName);
      for (const { record, edits } of layoutChanges) for (const change of edits) {
        edit.replace(record.uri, new vscode.Range(record.doc.positionAt(change.start), record.doc.positionAt(change.end)), change.text);
      }
      for (const record of snapshots.values()) {
        if (!bytes(await fs.readFile(record.uri.fsPath)).equals(record.diskBytes)) throw new Error('A file changed on disk during rename. Try again.');
      }
      if ([...snapshots.values()].some(record => record.doc.version !== record.version || record.doc.getText() !== record.text)) throw new Error('A file changed during rename. Try again.');
      if (token.isCancellationRequested) return new vscode.WorkspaceEdit();
      // VS Code applies the returned edit (or its accepted preview). Save only
      // after a layout document contains the exact proposed text; cancelled
      // previews and providers queried without application never write files.
      if (layoutChanges.length) {
        const plan = { layouts: new Set(layoutChanges.map(({ record, edits }) => ({ record, expected: applyEdits(record.text, edits) }))) };
        plan.expiry = setTimeout(() => { pendingSaves.delete(plan); }, 120000);
        plan.expiry.unref?.();
        pendingSaves.add(plan);
      }
      return edit;
  }
  context.subscriptions.push(output,
    vscode.commands.registerCommand('bcReportLayouts.renameColumn', renameColumn),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.onDidChangeTextEditorSelection(updateContext),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === vscode.window.activeTextEditor?.document) updateContext();
      if (pendingSaves.size) scheduleSaves();
    }),
    { dispose() { clearTimeout(saveTimer); for (const plan of pendingSaves) clearTimeout(plan.expiry); pendingSaves.clear(); } }
  );
  updateContext();
}
module.exports = { activateColumns };
