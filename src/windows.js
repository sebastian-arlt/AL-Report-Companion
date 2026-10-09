'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

function openWithWindows(filePath, launch = spawn, applicationPath) {
  // Pass the filename as data, never as executable PowerShell/cmd text.
  const script = "$ErrorActionPreference = 'Stop'; try { $p = New-Object System.Diagnostics.ProcessStartInfo; if ($env:BC_REPORT_LAYOUT_APPLICATION) { $p.FileName = $env:BC_REPORT_LAYOUT_APPLICATION; $p.Arguments = '\"' + $env:BC_REPORT_LAYOUT_TARGET + '\"' } else { $p.FileName = $env:BC_REPORT_LAYOUT_TARGET }; $p.UseShellExecute = $true; [System.Diagnostics.Process]::Start($p) | Out-Null } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = launch(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true, shell: false, env: { ...process.env, BC_REPORT_LAYOUT_TARGET: filePath,
        BC_REPORT_LAYOUT_APPLICATION: applicationPath || '' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || 'Windows could not open this layout. Check its default application.')));
  });
}

async function findReportBuilder(configuredPath, fileSystem = require('node:fs/promises')) {
  if (configuredPath) {
    const stats = await fileSystem.stat(configuredPath).catch(() => undefined);
    if (!stats?.isFile() || !/\.exe$/i.test(configuredPath)) throw new Error('Report Builder path must point to an existing .exe file.');
    return configuredPath;
  }
  const roots = [...new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
    'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean))];
  for (const folder of ['Microsoft Report Builder', 'ReportBuilder', 'Report Builder', 'Report Builder\\Report Builder', 'Microsoft SQL Server\\Report Builder']) {
    for (const root of roots) {
      for (const name of ['MSReportBuilder.exe', 'ReportBuilder.exe']) {
        const candidate = path.win32.join(root, folder, name);
        try { if ((await fileSystem.stat(candidate)).isFile()) return candidate; } catch { /* Try next install location. */ }
      }
    }
  }
  throw new Error('Report Builder was not found. Set AL Report Companion > Report Builder Path to your current Report Builder executable.');
}

module.exports = { openWithWindows, findReportBuilder };
