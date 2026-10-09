'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { digest, importCalLayout } = require('./cal-layouts');

class CalSessions {
  constructor(storagePath, processor, fileSystem = fs) {
    this.storagePath = storagePath;
    this.processor = processor;
    this.fs = fileSystem;
  }

  async extract(sourceUri, sourceText, layout) {
    const prepared = await this.processor({ operation: 'prepare', xml: layout.xml });
    if (prepared.namespace !== layout.namespace) throw new Error('The detected report header does not match the XML root.');
    await this.fs.mkdir(this.storagePath, { recursive: true });
    const folder = await this.fs.mkdtemp(path.join(this.storagePath, `report-${layout.id}-`));
    const session = { sourceUri, key: layout.key, reportId: layout.id, reportName: layout.name,
      sourceHash: layout.hash, namespace: layout.namespace, header: layout.header,
      folder, layoutPath: path.join(folder, 'layout.rdlc'), originalXmlPath: path.join(folder, 'original.rdlc'),
      exportedHash: digest(prepared.xml), createdAt: new Date().toISOString() };
    await this.fs.writeFile(session.layoutPath, prepared.xml, 'utf8');
    await this.fs.writeFile(session.originalXmlPath, layout.xml, 'utf8');
    // VS Code owns the source encoding. These are UTF-8 recovery copies of the
    // decoded document; source writes always go through WorkspaceEdit.
    await this.fs.writeFile(path.join(folder, 'original-report.txt'), sourceText, 'utf8');
    await this.save(session);
    return session;
  }

  async save(session) {
    await this.fs.writeFile(path.join(session.folder, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
  }

  async prepareImport(session, sourceText) {
    // Detect layout conflicts before any conversion work; C/AL-only edits are OK.
    importCalLayout(sourceText, session, '');
    const edited = await this.fs.readFile(session.layoutPath, 'utf8');
    if (digest(edited) === session.exportedHash) return { unchanged: true };
    const originalXml = await this.fs.readFile(session.originalXmlPath, 'utf8');
    const result = await this.processor({ operation: 'import', xml: edited,
      originalXml, originalHeader: session.header });
    const edit = importCalLayout(sourceText, session, result.xml);
    if (edit.updatedHash === session.sourceHash) return { unchanged: true };
    await this.fs.writeFile(path.join(session.folder, 'before-import-report.txt'), sourceText, 'utf8');
    await this.fs.writeFile(path.join(session.folder, 'import-candidate.rdlc'), result.xml, 'utf8');
    return { ...edit, changes: result.changes, editedHash: digest(edited) };
  }
}

module.exports = { CalSessions };
