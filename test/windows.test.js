'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openWithWindows, findReportBuilder } = require('../src/windows');

function launcher(exitCode, stderr, inspect) {
  return (...args) => {
    inspect?.(...args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => { if (stderr) child.stderr.emit('data', stderr); child.emit('close', exitCode); });
    return child;
  };
}

test('Windows opening passes special characters as data and uses shell association', async () => {
  const target = "C:\\Reports\\Kunde's $(calc); & Ä.rdlc";
  await openWithWindows(target, launcher(0, '', (executable, args, options) => {
    assert.match(executable, /powershell\.exe$/);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.BC_REPORT_LAYOUT_TARGET, target);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(!script.includes(target));
    assert.match(script, /UseShellExecute = \$true/);
  }));
});

test('configured Report Builder is launched explicitly without changing default associations', async () => {
  const application = 'C:\\Tools\\Report Builder\\MSReportBuilder.exe';
  await openWithWindows('C:\\Layouts\\layout.rdlc', launcher(0, '', (_executable, args, options) => {
    assert.equal(options.env.BC_REPORT_LAYOUT_APPLICATION, application);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /\$p.Arguments/);
    assert.ok(!script.includes(application));
  }), application);
  assert.equal(await findReportBuilder(application, { stat: async () => ({ isFile: () => true }) }), application);
  await assert.rejects(findReportBuilder('missing.exe', { stat: async () => { throw Error('missing'); } }), /existing .exe/);
});

test('reports association errors and spawn failures', async () => {
  await assert.rejects(openWithWindows('test.rdlc', launcher(1, 'No associated application')), /No associated application/);
  await assert.rejects(openWithWindows('test.rdlc', () => {
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('error', Error('Cannot start PowerShell'))); return child;
  }), /Cannot start PowerShell/);
});
