'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
function compileVb(source, launch = spawn) {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = launch(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'vb-compiler.ps1')],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('VB validation timed out.')); }, 30000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim() || 'VB compiler is unavailable.')); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()).diagnostics || []); }
      catch { reject(new Error('Invalid response from VB compiler.')); }
    });
    child.stdin.end(JSON.stringify({ source }), 'utf8');
  });
}
module.exports = { compileVb };
