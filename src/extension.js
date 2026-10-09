'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const { findLayouts, projectRoot, resolveLayout, layoutAtPosition } = require('./layouts');
const { openWithWindows } = require('./windows');
const { activateCal } = require('./cal-extension');
const { activateFields } = require('./field-extension');
const { activateColumns } = require('./column-extension');

function activate(context) {
  const layoutType = layout => /\.docx$/i.test(layout.path) ? 'docx' : 'rdlc';
  const indexedLayouts = new Map();
  const indexDocument = document => {
    if (document?.uri.scheme !== 'file' || !/\.al$/i.test(document.fileName)) return;
    const uri = document.uri.toString();
    const layouts = findLayouts(document.getText());
    if (JSON.stringify(indexedLayouts.get(uri)) === JSON.stringify(layouts)) return;
    indexedLayouts.set(uri, layouts);
    updateExplorerContext();
  };
  const updateExplorerContext = () => {
    for (const type of ['rdlc', 'docx']) {
      const resources = [...indexedLayouts].filter(([, layouts]) => layouts.some(layout => layoutType(layout) === type))
        .map(([uri]) => uri);
      void vscode.commands.executeCommand('setContext', `bcReportLayouts.${type}Resources`, resources);
    }
  };
  const updateContext = () => {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const layouts = document?.uri.scheme === 'file' && /\.al$/i.test(document.fileName)
      ? indexedLayouts.get(document.uri.toString()) || findLayouts(document.getText()) : [];
    const hasLayouts = layouts.length > 0;
    void vscode.commands.executeCommand('setContext', 'bcReportLayouts.hasLayouts', Boolean(hasLayouts));
    let selected;
    if (hasLayouts) {
      const position = editor.selection.active;
      const line = document.lineAt(position.line);
      selected = layoutAtPosition(layouts, document.offsetAt(position),
        document.offsetAt(line.range.start), document.offsetAt(line.range.end));
    }
    for (const type of ['rdlc', 'docx']) {
      const visible = selected ? layoutType(selected) === type : layouts.some(layout => layoutType(layout) === type);
      void vscode.commands.executeCommand('setContext', `bcReportLayouts.show${type.toUpperCase()}`, visible);
    }
    indexDocument(document);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.window.onDidChangeTextEditorSelection(updateContext),
    vscode.workspace.onDidChangeTextDocument(event => {
      indexDocument(event.document);
      if (event.document === vscode.window.activeTextEditor?.document) updateContext();
    }),
    vscode.commands.registerCommand('bcReportLayouts.openExternally', resource => openLayout(resource, true)),
    vscode.commands.registerCommand('bcReportLayouts.chooseAndOpenExternally', resource => openLayout(resource, false)),
    vscode.commands.registerCommand('bcReportLayouts.openRDLCSource', resource => openLayout(resource, true, 'rdlc', true)),
    vscode.commands.registerCommand('bcReportLayouts.chooseRDLCSource', resource => openLayout(resource, false, 'rdlc', true)),
    ...['rdlc', 'docx'].flatMap(type => [
      vscode.commands.registerCommand(`bcReportLayouts.open${type.toUpperCase()}`, resource => openLayout(resource, true, type)),
      vscode.commands.registerCommand(`bcReportLayouts.choose${type.toUpperCase()}`, resource => openLayout(resource, false, type))
    ])
  );
  async function openLayout(resource, useCaret, type, source = false) {
      try {
        if (!source && process.platform !== 'win32') throw new Error('Open externally currently supports Windows only.');
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before opening layouts externally.');
        const editor = vscode.window.activeTextEditor;
        const uri = resource instanceof vscode.Uri ? resource : editor?.document.uri;
        if (!uri || uri.scheme !== 'file' || !/\.al$/i.test(uri.fsPath)) {
          throw new Error('Select a local AL report or reportextension file. Remote files are not supported.');
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const layouts = findLayouts(document.getText()).filter(layout => !type || layoutType(layout) === type);
        if (!layouts.length) throw new Error(type
          ? `No ${type === 'docx' ? 'Word (.docx)' : 'RDLC (.rdlc/.rdl)'} layout found in this AL report.`
          : 'No RDL/RDLC or Word layout found in this AL report.');
        let selected;
        // The editor menu can also pass a URI. Keep Explorer selection separate.
        if (useCaret && editor?.document === document) {
          const position = editor.selection.active;
          const line = document.lineAt(position.line);
          selected = layoutAtPosition(layouts, document.offsetAt(position),
            document.offsetAt(line.range.start), document.offsetAt(line.range.end));
        }
        if (!selected && layouts.length === 1) selected = layouts[0];
        if (!selected) {
          const choice = await vscode.window.showQuickPick(layouts.map(layout => ({
            label: layout.name || layout.property, description: layout.path, layout
          })), { title: source ? 'Open report layout source' : 'Open report layout externally', placeHolder: 'Choose an RDL/RDLC or Word layout' });
          if (!choice) return;
          selected = choice.layout;
        }
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        const root = await projectRoot(uri.fsPath, workspaceRoot);
        const target = resolveLayout(root, selected.path);
        let stats;
        try { stats = await fs.stat(target); } catch { throw new Error(`Layout file not found: ${target}`); }
        if (!stats.isFile()) throw new Error(`Layout path is not a file: ${target}`);
        if (source) {
          const targetUri = vscode.Uri.file(target);
          const existingGroup = vscode.window.tabGroups.all.find(group => group.tabs.some(tab =>
            tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetUri.toString()));
          const layoutDocument = await vscode.workspace.openTextDocument(targetUri);
          await vscode.window.showTextDocument(layoutDocument, {
            preview: false, viewColumn: existingGroup?.viewColumn ?? vscode.ViewColumn.Active
          });
        } else {
          await openWithWindows(target);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`Open Layout: ${error.message}`);
      }
  }
  updateContext();
  const refreshResource = async uri => {
    if (uri.scheme !== 'file') return;
    try {
      const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      const text = openDocument ? openDocument.getText() : await fs.readFile(uri.fsPath, 'utf8');
      indexedLayouts.set(uri.toString(), findLayouts(text));
    } catch {
      indexedLayouts.delete(uri.toString());
    }
    updateExplorerContext();
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.al');
  context.subscriptions.push(watcher,
    watcher.onDidCreate(uri => { void refreshResource(uri); }),
    watcher.onDidChange(uri => { void refreshResource(uri); }),
    watcher.onDidDelete(uri => { indexedLayouts.delete(uri.toString()); updateExplorerContext(); })
  );
  void vscode.workspace.findFiles('**/*.al', '**/{.git,.alpackages,node_modules}/**')
    .then(async uris => { for (const uri of uris) await refreshResource(uri); }, () => {});
  activateCal(context);
  activateFields(context);
  activateColumns(context);
}

module.exports = { activate };
