'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function processRdl(job, launch = spawn) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = launch(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'rdl-processor.ps1')],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => { child.kill(); reject(new Error('RDL validation timed out. The source object was not changed.')); }, 60000);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim() || 'RDL validation failed.')); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('The RDL validator returned an invalid response.')); }
    });
    child.stdin.end(JSON.stringify(job), 'utf8');
  });
}

module.exports = { processRdl };
