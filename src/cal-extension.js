'use strict';

const path = require('node:path');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const { findCalLayouts, selectCalLayout, digest } = require('./cal-layouts');
const { CalSessions } = require('./cal-sessions');
const { processRdl } = require('./rdl-processor');
const { openWithWindows, findReportBuilder } = require('./windows');

function activateCal(context) {
  const sessions = context.workspaceState.get('calLayoutSessions', []);
  const storage = context.storageUri || context.globalStorageUri;
  const manager = new CalSessions(path.join(storage.fsPath, 'cal-layout-sessions'), processRdl);
  const indexed = new Map();
  const busy = new Set();
  const isCalFile = uri => uri?.scheme === 'file' && /\.(txt|cal)$/i.test(uri.fsPath);
  const publishContexts = () => {
    void vscode.commands.executeCommand('setContext', 'bcReportLayouts.calResources', [...indexed].filter(([, layouts]) => layouts.length).map(([uri]) => uri));
    void vscode.commands.executeCommand('setContext', 'bcReportLayouts.calSessionResources', [...new Set(sessions.map(session => session.sourceUri))]);
    const document = vscode.window.activeTextEditor?.document;
    void vscode.commands.executeCommand('setContext', 'bcReportLayouts.hasCalLayout', Boolean(document && isCalFile(document.uri) && findCalLayouts(document.getText()).length));
    void vscode.commands.executeCommand('setContext', 'bcReportLayouts.hasCalSession', Boolean(document && sessions.some(session => session.sourceUri === document.uri.toString())));
  };
  const indexDocument = document => {
    if (document && isCalFile(document.uri)) indexed.set(document.uri.toString(), findCalLayouts(document.getText()));
    publishContexts();
  };
  const persist = async () => {
    await context.workspaceState.update('calLayoutSessions', sessions);
    publishContexts();
  };
  const getDocument = async resource => {
    if (process.platform !== 'win32') throw new Error('C/AL layout editing currently supports Windows only.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before editing layouts externally.');
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!isCalFile(uri)) throw new Error('Select a local exported C/AL report (.txt or .cal).');
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText().includes('\uFFFD')) {
      throw new Error('The source contains replacement characters. Use Reopen with Encoding to select the original NAV export encoding before editing its layout.');
    }
    return document;
  };
  const choose = async (items, document, useCaret, isSession = false) => {
    const editor = vscode.window.activeTextEditor;
    if (useCaret && editor?.document === document) {
      const layout = selectCalLayout(findCalLayouts(document.getText()), document.offsetAt(editor.selection.active));
      const match = isSession ? items.find(item => item.key === layout?.key) : layout;
      if (match) return match;
    }
    if (items.length === 1) return items[0];
    const picked = await vscode.window.showQuickPick(items.map(item => ({
      label: `Report ${isSession ? item.reportId : item.id}: ${isSession ? item.reportName : item.name}`,
      description: isSession ? item.layoutPath : item.namespace, item
    })), { title: isSession ? 'Import edited C/AL layout' : 'Open embedded C/AL layout', placeHolder: 'Choose the report' });
    return picked?.item;
  };
  const run = async (resource, action) => {
    let uri;
    let acquired = false;
    try {
      const document = await getDocument(resource);
      uri = document.uri.toString();
      if (busy.has(uri)) throw new Error('A layout operation is already running for this object.');
      busy.add(uri);
      acquired = true;
      await action(document);
    } catch (error) {
      void vscode.window.showErrorMessage(`C/AL Layout: ${error.message}`);
    } finally {
      if (acquired) busy.delete(uri);
    }
  };
  const extract = (resource, useCaret) => run(resource, async document => {
    const layouts = findCalLayouts(document.getText());
    if (!layouts.length) throw new Error('No embedded RDLDATA layout found in this C/AL report export.');
    const layout = await choose(layouts, document, useCaret);
    if (!layout) return;
    const builder = await findReportBuilder(vscode.workspace.getConfiguration('bcReportLayouts').get('reportBuilderPath', ''));
    let session = sessions.find(session => session.sourceUri === document.uri.toString() && session.key === layout.key);
    // Reopening an active session must not overwrite unsaved external work.
    if (session) {
      if (session.sourceHash !== layout.hash) throw new Error('The source RDLDATA changed since extraction. Finish or close the previous session before extracting again.');
      await fs.access(session.layoutPath);
    } else {
      session = await manager.extract(document.uri.toString(), document.getText(), layout);
      sessions.push(session);
      await persist();
    }
    await openWithWindows(session.layoutPath, undefined, builder);
    void vscode.window.showInformationMessage(`Report ${layout.id}: edit and save ${session.layoutPath}, then use Import Layout (.rdlc) in the source object.`);
  });
  const importLayout = (resource, useCaret) => run(resource, async document => {
    const candidates = sessions.filter(session => session.sourceUri === document.uri.toString());
    if (!candidates.length) throw new Error('No editing session for this object. Open its embedded layout first.');
    const session = await choose(candidates, document, useCaret, true);
    if (!session) return;
    const version = document.version;
    const result = await manager.prepareImport(session, document.getText());
    if (result.unchanged) { void vscode.window.showInformationMessage('The external layout has no changes to import. Save it in Report Builder first.'); return; }
    if (document.version !== version) throw new Error('The source document changed during validation. Run Import Layout again.');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(result.start), document.positionAt(result.end)), result.replacement);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the layout edit. The working layout is retained.');
    session.sourceHash = result.updatedHash;
    session.exportedHash = result.editedHash;
    await manager.save(session);
    await persist();
    await vscode.window.showTextDocument(document);
    void vscode.window.showInformationMessage(`Layout imported into Report ${session.reportId}. Save the source object when ready.${result.changes.length ? ' Compatibility changes: ' + result.changes.join(' ') : ''}`);
  });
  const closeSession = resource => run(resource, async document => {
    const candidates = sessions.filter(session => session.sourceUri === document.uri.toString());
    if (!candidates.length) throw new Error('No active layout session for this object.');
    const session = await choose(candidates, document, false, true);
    if (!session) return;
    sessions.splice(sessions.indexOf(session), 1);
    await persist();
    // Keep recovery files, including external changes, even after closing.
    void vscode.window.showInformationMessage(`Layout session closed. Recovery files remain in ${session.folder}.`);
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('bcReportLayouts.openCalRDLC', resource => extract(resource, true)),
    vscode.commands.registerCommand('bcReportLayouts.chooseCalRDLC', resource => extract(resource, false)),
    vscode.commands.registerCommand('bcReportLayouts.importCalRDLC', resource => importLayout(resource, true)),
    vscode.commands.registerCommand('bcReportLayouts.chooseImportCalRDLC', resource => importLayout(resource, false)),
    vscode.commands.registerCommand('bcReportLayouts.closeCalSession', closeSession),
    vscode.window.onDidChangeActiveTextEditor(editor => indexDocument(editor?.document)),
    vscode.workspace.onDidChangeTextDocument(event => indexDocument(event.document))
  );
  indexDocument(vscode.window.activeTextEditor?.document);
  const refresh = async uri => {
    if (!isCalFile(uri)) return;
    try {
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
      const text = document ? document.getText() : await fs.readFile(uri.fsPath, 'utf8');
      indexed.set(uri.toString(), findCalLayouts(text));
    } catch { indexed.delete(uri.toString()); }
    publishContexts();
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{txt,cal}');
  context.subscriptions.push(watcher,
    watcher.onDidCreate(uri => { void refresh(uri); }), watcher.onDidChange(uri => { void refresh(uri); }),
    watcher.onDidDelete(uri => { indexed.delete(uri.toString()); publishContexts(); })
  );
  void vscode.workspace.findFiles('**/*.{txt,cal}', '**/{.git,.alpackages,node_modules}/**')
    .then(async uris => { for (const uri of uris) await refresh(uri); }, () => {});
}

module.exports = { activateCal };
