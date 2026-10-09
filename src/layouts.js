'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

// Keep offsets into the original document; comments and string contents must
// never be interpreted as AL declarations.
function tokenize(text) {
  const tokens = [];
  const pattern = /^[ \t]*#[^\r\n]*|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}\p{M}_]*|\d+|[^\s]/gmu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    if (raw.startsWith('//') || raw.startsWith('/*') || raw.trimStart().startsWith('#')) continue;
    tokens.push({ raw, value: raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw,
      start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

function findLayouts(text) {
  const tokens = tokenize(text);
  const result = [];
  const stack = [];
  let statementStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const current = stack.at(-1);
    if (token.raw === '{') {
      const header = tokens.slice(statementStart, i);
      const first = header[0]?.raw.toLowerCase();
      const kind = !stack.length && ['report', 'reportextension'].includes(first) ? 'report'
        : current?.kind === 'report' && first === 'rendering' ? 'rendering'
        : current?.kind === 'rendering' && first === 'layout' ? 'layout' : 'other';
      stack.push({ kind, name: kind === 'layout' ? header.slice(2, -1).map(t => t.raw).join(' ') : undefined });
      statementStart = i + 1;
    } else if (token.raw === '}') {
      stack.pop();
      statementStart = i + 1;
    } else if (token.raw === ';') {
      statementStart = i + 1;
    } else {
      const property = token.raw.toLowerCase();
      const supported = (current?.kind === 'report' && ['rdlclayout', 'wordlayout'].includes(property))
        || (current?.kind === 'layout' && property === 'layoutfile');
      const value = tokens[i + 2];
      if (supported && tokens[i + 1]?.raw === '=' && value?.raw.startsWith("'")
        && tokens[i + 3]?.raw === ';' && /\.(rdlc?|docx)$/i.test(value.value)) {
        result.push({ path: value.value, property: token.raw, name: current.name,
          start: token.start, end: tokens[i + 3].end, valueStart: value.start, valueEnd: value.end });
      }
    }
  }
  return result;
}

async function projectRoot(documentPath, workspaceRoot, access = fs.access) {
  let directory = path.dirname(documentPath);
  while (true) {
    try { await access(path.join(directory, 'app.json')); return directory; } catch { /* Walk to the AL project root. */ }
    if (workspaceRoot && directory.toLowerCase() === workspaceRoot.toLowerCase()) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (workspaceRoot) return workspaceRoot;
  throw new Error('No AL project root found. Open the project folder or add an app.json.');
}

function resolveLayout(root, layoutPath) {
  return path.resolve(root, layoutPath.replace(/[\\/]/g, path.sep));
}

// Select the declaration under the caret, including a caret elsewhere on its
// property line. Else the caller offers all layouts in a picker.
function layoutAtPosition(layouts, offset, lineStart, lineEnd) {
  return layouts.find(layout => layout.start <= offset && offset <= layout.end)
    || layouts.find(layout => layout.start >= lineStart && layout.start <= lineEnd);
}

module.exports = { findLayouts, projectRoot, resolveLayout, layoutAtPosition, tokenize };
