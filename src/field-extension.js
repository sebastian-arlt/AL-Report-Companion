'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const { findLayouts, projectRoot, resolveLayout } = require('./layouts');
const { analyze, editsFor, applyEdits, suggestions } = require('./rdlc-fields');
const { unusedColumns } = require('./column-usage');
const { validateVb } = require('./rdlc-vb');
const { compileVb } = require('./vb-compiler');

function activateFields(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('bc-report-layout-fields');
  const unusedDiagnostics = vscode.languages.createDiagnosticCollection('bc-report-unused-columns');
  const warnedReports = new Set();
  const history = context.workspaceState.get('layoutFieldHistory', {});
  const cache = new Map(), groups = new Map(), previews = new Map();
  const vbCache = new Map(), reportCache = new Map();
  const cachedCompile = source => {
    if (!vbCache.has(source)) {
      if (vbCache.size >= 30) vbCache.delete(vbCache.keys().next().value);
      const pending = compileVb(source).catch(error => { vbCache.delete(source); throw error; });
      vbCache.set(source, pending);
    }
    return vbCache.get(source);
  };
  let timer, running, refreshRequested = false, disposed = false, sequence = 0;
  const enabled = uri => vscode.workspace.getConfiguration('bcReportLayouts', uri).get('enableReportCop', false) === true;
  const layoutEnabled = uri => {
    const owners = [...groups].filter(([, paths]) => paths.includes(uri.toString()));
    return owners.length ? owners.some(([key]) => enabled(vscode.Uri.parse(key))) : enabled(uri);
  };
  const clearDisabled = () => {
    for (const key of cache.keys()) if (!layoutEnabled(vscode.Uri.parse(key))) {
      diagnostics.delete(vscode.Uri.parse(key)); cache.get(key).validated = false;
    }
    for (const key of warnedReports) if (!enabled(vscode.Uri.parse(key))) {
      unusedDiagnostics.delete(vscode.Uri.parse(key)); warnedReports.delete(key);
    }
  };
  const read = async uri => vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())?.getText() ?? await fs.readFile(uri.fsPath, 'utf8');
  const position = (text, offset) => { const lines = text.slice(0, offset).split('\n'); return new vscode.Position(lines.length - 1, lines.at(-1).length); };
  const range = (text, edit) => new vscode.Range(position(text, edit.start), position(text, edit.end));
  async function refresh() {
    if (disposed || !vscode.workspace.isTrusted) return;
    const nextGroups = new Map();
    const reports = new Map();
    const alFiles = await vscode.workspace.findFiles('**/*.al', '**/{.git,.alpackages,node_modules}/**');
    for (const uri of alFiles) {
      if (uri.scheme !== 'file') continue;
      try {
        const text = await read(uri);
        const root = await projectRoot(uri.fsPath, vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath);
        const previous = reportCache.get(uri.toString());
        const layouts = previous?.text === text && previous.root === root ? previous.layouts
          : [...new Set(findLayouts(text).filter(layout => /\.rdlc?$/i.test(layout.path))
            .map(layout => vscode.Uri.file(resolveLayout(root, layout.path)).toString()))];
        reportCache.set(uri.toString(), { text, root, layouts });
        if (layouts.length) { nextGroups.set(uri.toString(), layouts); reports.set(uri.toString(), { uri, text }); }
      } catch { /* A deleted or incomplete AL file will be retried on its next change. */ }
    }
    const alKeys = new Set(alFiles.map(uri => uri.toString()));
    for (const key of reportCache.keys()) if (!alKeys.has(key)) reportCache.delete(key);
    groups.clear(); for (const [key, value] of nextGroups) groups.set(key, value);
    const targets = new Set([...groups.values()].flat());
    for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === 'file' && /\.rdlc?$/i.test(doc.fileName)) targets.add(doc.uri.toString());
    for (const key of cache.keys()) if (!targets.has(key)) { cache.delete(key); diagnostics.delete(vscode.Uri.parse(key)); }
    for (const key of targets) {
      const uri = vscode.Uri.parse(key);
      if (!layoutEnabled(uri)) { diagnostics.delete(uri); cache.delete(key); continue; }
      try {
        const diskText = await fs.readFile(uri.fsPath, 'utf8');
        const text = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === key)?.getText() ?? diskText;
        const vbEnabled = vscode.workspace.getConfiguration?.('bcReportLayouts', uri)?.get('validateVisualBasic', true) !== false;
        const previous = cache.get(key);
        if (previous?.text === text && previous.vbEnabled === vbEnabled && previous.validated) {
          previous.diskText = diskText;
          continue;
        }
        const analysis = previous?.text === text ? previous.analysis : analyze(text);
        const record = { uri, text, diskText, analysis, vbEnabled, validated: false };
        cache.set(key, record);
        const inventory = analysis.datasets;
        if (!history[key]) history[key] = { baseline: inventory, current: inventory };
        else {
          // Keep the pre-build inventory while missing references need repair.
          if (!analysis.references.some(ref => ref.missing)) history[key].baseline = inventory;
          history[key].current = inventory;
        }
        const entries = analysis.references.filter(ref => ref.missing).map(ref => {
          const diagnostic = new vscode.Diagnostic(range(text, ref), `Field '${ref.name}' is not defined in ${ref.scope || 'any report dataset'}. Build the AL report, then use Rename Layout Fields to repair a renamed field.`, vscode.DiagnosticSeverity.Error);
          diagnostic.source = 'AL Report Companion Fields'; diagnostic.code = 'missing-layout-field'; return diagnostic;
        });
        // Field checks do not need to wait for the external VB compiler.
        if (!disposed && layoutEnabled(uri) && await read(uri) === text) diagnostics.set(uri, [...entries]);
        let compilerFailed = false;
        if (vbEnabled) {
          try {
            const warnings = await validateVb(analysis, cachedCompile);
            for (const warning of warnings) {
              const diagnostic = new vscode.Diagnostic(range(text, warning), warning.message, vscode.DiagnosticSeverity.Error);
              diagnostic.source = 'AL Report Companion VB'; diagnostic.code = `rdlc-vb:${warning.code}`; entries.push(diagnostic);
            }
          } catch (error) {
            compilerFailed = true;
            const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `VB validation is unavailable: ${error.message}`, vscode.DiagnosticSeverity.Error);
            diagnostic.source = 'AL Report Companion VB'; diagnostic.code = 'rdlc-vb-unavailable'; entries.push(diagnostic);
          }
        }
        if (disposed || !layoutEnabled(uri) || await read(uri) !== text) continue;
        diagnostics.set(uri, entries);
        record.validated = !compilerFailed;
      } catch (error) {
        cache.delete(key);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `Cannot validate layout: ${error.message}`, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'AL Report Companion Fields'; if (!disposed && layoutEnabled(uri)) diagnostics.set(uri, [diagnostic]);
      }
    }
    for (const key of warnedReports) if (!reports.has(key) || !enabled(reports.get(key).uri)) {
      unusedDiagnostics.delete(vscode.Uri.parse(key)); warnedReports.delete(key);
    }
    for (const [key, report] of reports) {
      if (!enabled(report.uri)) continue;
      const layouts = groups.get(key).map(path => cache.get(path)?.analysis);
      unusedDiagnostics.set(report.uri, unusedColumns(report.text, layouts).map(column => {
        const diagnostic = new vscode.Diagnostic(range(report.text, column), `Column '${column.name}' is not used in any of the ${layouts.length} linked RDLC layouts. The dataset definition alone does not count as usage.`, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'AL Report Companion Fields'; diagnostic.code = 'unused-layout-column'; return diagnostic;
      }));
      warnedReports.add(key);
    }
    if (!disposed) await context.workspaceState.update('layoutFieldHistory', history);
  }
  const queue = () => {
    refreshRequested = true;
    if (!running) {
      running = (async () => {
        while (refreshRequested && !disposed) {
          refreshRequested = false;
          await refresh();
        }
      })().finally(() => { running = undefined; });
    }
    return running;
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void queue().catch(error => console.error('Layout field validation:', error)); }, 400); };
  async function selectedLayouts(resource) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before checking or editing layouts.');
    await queue();
    const uri = resource?.scheme ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri) throw new Error('Select an AL report or RDLC layout.');
    const key = uri.toString();
    if (groups.has(key)) return groups.get(key);
    const owners = [...groups].filter(([, paths]) => paths.includes(key));
    if (owners.length === 1) return owners[0][1];
    if (owners.length > 1) {
      const owner = await vscode.window.showQuickPick(owners.map(([al, layouts]) => ({ label: vscode.workspace.asRelativePath(vscode.Uri.parse(al)), layouts })), { title: 'Choose the report whose layouts should be checked' });
      return owner?.layouts || [];
    }
    if (cache.has(key) || /\.rdlc?$/i.test(uri.fsPath)) return [key];
    throw new Error('No RDLC layouts found for this file.');
  }
  async function validate(resource) {
    try {
      const keys = await selectedLayouts(resource);
      if (!keys.length) return;
      if (keys.every(key => !layoutEnabled(vscode.Uri.parse(key)))) throw new Error('Report Cop is disabled. Set bcReportLayouts.enableReportCop to true in your project settings.json.');
      const entries = keys.flatMap(key => diagnostics.get(vscode.Uri.parse(key)) || []);
      const errors = entries.filter(entry => entry.severity === vscode.DiagnosticSeverity.Error).length;
      const warnings = entries.filter(entry => entry.severity === vscode.DiagnosticSeverity.Warning).length;
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      void vscode.window.showInformationMessage(`Checked ${keys.length} layout(s): ${errors} error(s), ${warnings} warning(s).`);
    } catch (error) { void vscode.window.showErrorMessage(`Validate Layout Fields: ${error.message}`); }
  }
  async function rename(resource) {
    const previewKeys = [];
    try {
      const keys = await selectedLayouts(resource);
      if (!keys.length) return;
      // Explicit rename remains available even when background diagnostics are disabled.
      for (const key of keys) if (!cache.has(key)) {
        const uri = vscode.Uri.parse(key);
        const diskText = await fs.readFile(uri.fsPath, 'utf8');
        const text = await read(uri);
        cache.set(key, { uri, text, diskText, analysis: analyze(text), validated: false });
      }
      const records = keys.map(key => cache.get(key));
      const choices = new Map();
      for (const record of records) for (const ref of record.analysis.references.filter(ref => ref.missing)) {
        for (const dataset of ref.datasets) choices.set(JSON.stringify([dataset, ref.name]), { label: ref.name, description: dataset, dataset, name: ref.name });
      }
      if (!choices.size) { void vscode.window.showInformationMessage('No missing field references. Build the AL report first to update its RDLC dataset definitions.'); return; }
      const old = await vscode.window.showQuickPick([...choices.values()], { title: 'Rename Layout Fields — choose missing field', placeHolder: 'Choose the old field name. Deletions can remain as errors until the expression is corrected.' });
      if (!old) return;
      const candidates = new Map();
      for (const [index, record] of records.entries()) {
        for (const field of record.analysis.datasets[old.dataset] || []) candidates.set(field.name, { label: field.name, description: 'Existing dataset field' });
        for (const proposal of suggestions(history[keys[index]]?.baseline, record.analysis.datasets, old.dataset, old.name)) candidates.set(proposal.name, { label: proposal.name, description: proposal.reason });
      }
      const target = await vscode.window.showQuickPick([...candidates.values()], { title: `Map ${old.dataset}: ${old.name} → …`, placeHolder: 'Confirm the replacement field; suggestions are not proof of a rename.' });
      if (!target) return;
      // A single confirmed mapping is applied to every referenced layout of the report.
      const changes = records.map(record => ({ ...record, edits: editsFor(record.analysis, old.dataset, old.name, target.label) })).filter(record => record.edits.length);
      const remaining = records.reduce((count, record) => count + record.analysis.references.filter(ref => ref.name === old.name).length, 0)
        - changes.reduce((count, record) => count + record.edits.length, 0);
      if (!changes.length) throw new Error('No safely scoped occurrences found. Check dataset scope or the expression manually.');
      for (const record of changes) {
        record.preview = vscode.Uri.from({ scheme: 'bc-layout-preview', path: `/${++sequence}/${record.uri.path.split('/').at(-1)}` });
        previewKeys.push(record.preview.toString()); previews.set(record.preview.toString(), applyEdits(record.text, record.edits));
      }
      const showPreview = record => vscode.commands.executeCommand('vscode.diff', record.uri, record.preview, `${old.name} → ${target.label}: ${record.uri.path.split('/').at(-1)}`);
      await showPreview(changes[0]);
      while (true) {
        const count = changes.reduce((sum, record) => sum + record.edits.length, 0);
        const action = await vscode.window.showQuickPick([
          ...changes.map(record => ({ label: `Preview: ${vscode.workspace.asRelativePath(record.uri)}`, record })),
          { label: `Apply ${count} replacements in ${changes.length} layouts`, apply: true, description: remaining ? `${remaining} other occurrence(s) remain unchanged: ambiguous scope or missing target field` : 'Undoable edits; files are not saved automatically' }
        ], { title: 'Review changes, then explicitly apply', placeHolder: 'Escape cancels without changes.' });
        if (!action) return;
        if (action.record) { await showPreview(action.record); continue; }
        if (!action.apply) continue;
        const documents = [];
        for (const record of changes) {
          const doc = await vscode.workspace.openTextDocument(record.uri);
          if (doc.getText() !== record.text || await fs.readFile(record.uri.fsPath, 'utf8') !== record.diskText) throw new Error('A layout changed during review. Run the command again.');
          documents.push(doc);
        }
        // Recheck after the last await to avoid overwriting edits in another editor.
        if (documents.some((doc, index) => doc.getText() !== changes[index].text)) throw new Error('A layout changed during review. Run the command again.');
        const edit = new vscode.WorkspaceEdit();
        for (const record of changes) for (const change of record.edits) edit.replace(record.uri, range(record.text, change), change.text);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the changes.');
        await queue();
        void vscode.window.showInformationMessage(`Replaced ${count} field references in ${changes.length} layouts.${remaining ? ` ${remaining} other occurrences require manual review.` : ''} Save the changed files when ready.`);
        return;
      }
    } catch (error) { void vscode.window.showErrorMessage(`Rename Layout Fields: ${error.message}`); }
    // Keep reviewed virtual documents readable for as long as their tabs are open.
    finally { for (const key of previewKeys) if (!vscode.workspace.textDocuments.some(doc => doc.uri.toString() === key)) previews.delete(key); }
  }
  context.subscriptions.push(diagnostics, unusedDiagnostics,
    vscode.workspace.registerTextDocumentContentProvider('bc-layout-preview', { provideTextDocumentContent: uri => previews.get(uri.toString()) || '' }),
    vscode.commands.registerCommand('bcReportLayouts.validateFields', validate),
    vscode.commands.registerCommand('bcReportLayouts.validateVB', validate),
    vscode.commands.registerCommand('bcReportLayouts.renameFields', rename),
    vscode.workspace.onDidChangeTextDocument(event => { if (/\.(al|rdlc?)$/i.test(event.document.fileName)) schedule(); }),
    vscode.workspace.onDidOpenTextDocument(document => { if (/\.(al|rdlc?)$/i.test(document.fileName)) schedule(); }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === 'bc-layout-preview') previews.delete(document.uri.toString());
      else if (/\.(al|rdlc?)$/i.test(document.fileName)) schedule();
    }),
    { dispose() { disposed = true; clearTimeout(timer); previews.clear(); vbCache.clear(); reportCache.clear(); } },
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file', pattern: '**/*.rdlc' }, { scheme: 'file', pattern: '**/*.rdl' }], {
      provideCodeActions(document, _range, actionContext) {
        return actionContext.diagnostics.filter(diagnostic => diagnostic.code === 'missing-layout-field').map(diagnostic => {
          const action = new vscode.CodeAction('Rename missing layout field…', vscode.CodeActionKind.QuickFix);
          action.diagnostics = [diagnostic]; action.command = { command: 'bcReportLayouts.renameFields', title: action.title, arguments: [document.uri] }; return action;
        });
      }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
  );
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('bcReportLayouts.enableReportCop')) { clearDisabled(); schedule(); }
    else if (event.affectsConfiguration('bcReportLayouts.validateVisualBasic')) schedule();
  }));
  for (const pattern of ['**/*.al', '**/*.rdlc', '**/*.rdl']) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule));
  }
  void queue().catch(error => console.error('Layout field validation:', error));
}
module.exports = { activateFields };
