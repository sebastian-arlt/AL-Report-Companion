'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CalSessions } = require('../src/cal-sessions');
const { findCalLayouts, digest } = require('../src/cal-layouts');
const { calReport } = require('./cal-fixtures');

test('editing sessions preserve originals, prepare bounded edits and support repeated imports', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-session-test-'));
  try {
    const processor = async job => ({ namespace: 'http://schemas.microsoft.com/sqlserver/reporting/2010/01/reportdefinition', xml: job.xml, changes: [] });
    const manager = new CalSessions(folder, processor);
    let source = calReport();
    const layout = findCalLayouts(source)[0];
    const session = await manager.extract('file:///Report.txt', source, layout);
    assert.equal(path.basename(session.layoutPath), 'layout.rdlc');
    assert.equal(await fs.readFile(path.join(session.folder, 'original-report.txt'), 'utf8'), source);
    assert.equal((await manager.prepareImport(session, source)).unchanged, true);
    let external = await fs.readFile(session.layoutPath, 'utf8');
    external = external.replace('Original ä', 'Edited ö');
    await fs.writeFile(session.layoutPath, external, 'utf8');
    const edit = await manager.prepareImport(session, source);
    source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
    session.sourceHash = edit.updatedHash;
    session.exportedHash = edit.editedHash;
    await manager.save(session);
    assert.equal((await manager.prepareImport(session, source)).unchanged, true);
    assert.equal(digest(external), edit.editedHash);
    const persisted = JSON.parse(await fs.readFile(path.join(session.folder, 'session.json'), 'utf8'));
    assert.equal(persisted.sourceHash, edit.updatedHash);
    await fs.writeFile(session.layoutPath, external.replace('Edited ö', 'Again ü'), 'utf8');
    assert.ok((await manager.prepareImport(session, source)).replacement.includes('Again ü'));
    await assert.rejects(manager.prepareImport(session, source.replace('Edited ö', 'Conflicting')), /RDLDATA changed/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
