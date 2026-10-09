'use strict';
const { compileVb } = require('./vb-compiler');
const { environmentTypes, stubLines, fixedMemberEdits, nameDiagnostics, shadowedFixedNames } = require('./rdlc-builtins');

// A typed Code receiver lets the VB compiler resolve embedded functions. The
// built-in contracts validate members without simulating report execution.
const aggregateNames = ['Aggregate', 'Avg', 'Count', 'CountDistinct', 'CountRows', 'First', 'Last', 'Lookup', 'LookupSet', 'Max', 'Min', 'MultiLookup', 'Previous', 'RowNumber', 'RunningValue', 'StDev', 'StDevP', 'Sum', 'Var', 'VarP', 'InScope', 'Level'];
function buildSource(analysis) {
  const lines = [], map = [];
  const shadowed = shadowedFixedNames(analysis);
  function generated(line) { lines.push(line); map.push(undefined); }
  function user(chunk, expression = false) {
    const edits = fixedMemberEdits(chunk.value, expression ? undefined : shadowed);
    if (edits.length) {
      let value = ''; const positions = []; let cursor = 0;
      for (const edit of edits) {
        if (edit.start < cursor) continue;
        value += chunk.value.slice(cursor, edit.start); positions.push(...chunk.positions.slice(cursor, edit.start));
        value += edit.replacement;
        for (let i = 0; i < edit.replacement.length; i++) positions.push(chunk.positions[Math.min(edit.end - 1, edit.anchor + Math.max(0, i - 2))]);
        cursor = edit.end;
      }
      value += chunk.value.slice(cursor); positions.push(...chunk.positions.slice(cursor));
      chunk = { ...chunk, value, positions };
    }
    const value = chunk.value;
    const offset = expression ? value.indexOf('=') + 1 : 0;
    const body = value.slice(offset);
    if (expression) {
      // RDLC expressions are a single expression, not line-oriented VB method
      // statements. Normalize formatting only in the generated compiler input.
      let quoted = false, comment = false;
      const chars = [], offsets = [];
      for (let i = offset; i < value.length; i++) {
        const char = value[i];
        if (comment && char !== '\n') continue;
        if (char === '\n' || char === '\r') {
          comment = false;
          chars.push(quoted ? char : ' '); offsets.push(i); continue;
        }
        if (!quoted && char === "'") { comment = true; continue; }
        if (char === '"') {
          if (quoted && value[i + 1] === '"') {
            chars.push(char, char); offsets.push(i, i + 1); i++; continue;
          }
          quoted = !quoted;
        }
        if (!quoted && char === '_' && /\s/.test(value[i - 1] || '') && /^[ \t]*(?:'[^\r\n]*)?\r?\n/.test(value.slice(i + 1))) continue;
        chars.push(char); offsets.push(i);
      }
      let cursor = 0;
      for (const [index, line] of chars.join('').split('\n').entries()) {
        const prefix = index === 0 ? 'Return ' : '';
        lines.push(prefix + line);
        map.push({ chunk, text: line, offsets: offsets.slice(cursor, cursor + line.length), length: line.length, prefix: prefix.length });
        cursor += line.length + 1;
      }
      return;
    }
    let cursor = offset;
    for (const [index, line] of body.split('\n').entries()) {
      const prefix = expression && index === 0 ? 'Return ' : '';
      const clean = line.replace(/\r$/, '');
      lines.push(prefix + clean);
      map.push({ chunk, start: cursor, length: clean.length, prefix: prefix.length });
      cursor += line.length + 1;
    }
  }
  generated('Option Explicit On'); generated('Option Strict Off');
  generated('Imports System'); generated('Imports Microsoft.VisualBasic'); generated('Imports System.Math'); generated('Imports System.Convert');
  for (const line of stubLines()) generated(line);
  generated('Public Class ReportEnvironment');
  for (const [name, type] of Object.entries(environmentTypes)) generated(`Public ${name} As ${type}`);
  for (const name of aggregateNames) {
    generated(`Public Function ${name}(ParamArray arguments() As Object) As Object`);
    generated('Return Nothing'); generated('End Function');
  }
  generated('End Class'); generated('Public Class EmbeddedReportCode'); generated('Inherits ReportEnvironment');
  generated('Public ReadOnly Property Code As EmbeddedReportCode'); generated('Get'); generated('Return Me'); generated('End Get'); generated('End Property');
  for (const instance of analysis.externalCodeInstances || []) if (/^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u.test(instance)) generated(`Public [${instance}] As Object`);
  for (const chunk of analysis.codeBlocks || []) user(chunk);
  generated('End Class'); generated('Public Class ReportExpressions'); generated('Inherits ReportEnvironment');
  generated('Public Code As EmbeddedReportCode');
  generated('Public Value As Object');
  for (const [index, chunk] of (analysis.expressions || []).entries()) {
    generated(`Public Function Expression${index}() As Object`); user(chunk, true); generated('End Function');
  }
  generated('End Class');
  return { source: lines.join('\n'), map, externalReferences: Boolean(analysis.externalCodeModules?.length || analysis.externalCodeInstances?.length) };
}
function mapDiagnostics(diagnostics, source) {
  const result = [], seen = new Set();
  for (const diagnostic of diagnostics) {
    // Report expressions officially access Code constants through the instance.
    // VB warns about that conventional RDLC syntax, but it is valid here.
    // BC31072 only repeats a warning promoted to an error by the compiler.
    if (['BC42025', 'BC31072'].includes(diagnostic.code)) continue;
    let entry = source.map[diagnostic.line - 1];
    if (!entry && diagnostic.warning) continue;
    // A missing End Function can be reported on a generated closing boundary.
    // Anchor it to the nearest preceding original code line instead.
    if (!entry) {
      for (let line = Math.min(diagnostic.line - 2, source.map.length - 1); line >= 0; line--) if (source.map[line]) { entry = source.map[line]; break; }
    }
    if (!entry || !entry.chunk.positions.length) continue;
    const names = [...diagnostic.message.matchAll(/["'‘’“”„]([^"'‘’“”„]+)["'‘’“”„]/g)].map(match => match[1]);
    // CodeDom's older compiler often omits columns. Recover the position of a
    // named undeclared identifier in the normalized expression when possible.
    const namedOffset = !diagnostic.column && diagnostic.code === 'BC30451' && entry.text && names[0]
      ? entry.text.indexOf(names[0]) : -1;
    const index = Math.max(0, Math.min(entry.length - 1, namedOffset >= 0 ? namedOffset : (diagnostic.column || 1) - 1 - entry.prefix));
    const first = entry.chunk.positions[Math.min(entry.offsets ? (entry.offsets[index] ?? 0) : entry.start + index, entry.chunk.positions.length - 1)];
    const last = entry.chunk.positions[Math.min(entry.offsets ? (entry.offsets[Math.max(index, entry.length - 1)] ?? 0) : entry.start + Math.max(index, entry.length - 1), entry.chunk.positions.length - 1)];
    const subject = names[0] ? ` '${names[0]}'` : '';
    const messages = {
      BC42105: `Function${subject} does not explicitly return a value on every code path. If none of its conditions match, it returns the default value (Nothing for Object). Add an explicit fallback Return if this is intentional.`,
      BC30451: `Identifier${subject} is not declared. Check for a spelling mistake or a missing declaration.`,
      BC30456: `Member${subject} does not exist on the referenced type. Check the member or function name.`,
      BC30455: `A required argument${subject} is missing in this function call.`,
      BC30057: 'This function call has too many arguments.',
      BC30390: 'The referenced Code member is not accessible from this expression.',
      BC30311: 'A value cannot be converted to the required type.',
      BC30201: 'An expression is expected. Check the VB syntax.',
      BC30289: 'A declaration occurs inside a method body. Check for a missing End Function or End Sub.',
      BC30027: "The Function block is missing 'End Function'.",
      BC30026: "The Sub block is missing 'End Sub'.",
      BC30081: "The If block is missing 'End If'.",
      BC30179: 'Duplicate or conflicting declaration in embedded report code.'
    };
    const message = messages[diagnostic.code] || `The VB compiler reported a syntax, declaration or type inconsistency${subject}. Check this code statement or expression.`;
    const warning = { start: first.start, end: last.end, code: diagnostic.code, message: `VB ${diagnostic.code}: ${message}${source.externalReferences ? ' Custom assembly references are present and are not resolved by this static check.' : ''}` };
    const key = `${warning.start}:${warning.end}:${warning.message}`;
    if (!seen.has(key)) { result.push(warning); seen.add(key); }
  }
  return result;
}
async function validateVb(analysis, compile = compileVb) {
  if (!(analysis.codeBlocks || []).some(block => block.value.trim()) && !(analysis.expressions || []).length) return [];
  const source = buildSource(analysis);
  return [...nameDiagnostics(analysis), ...mapDiagnostics(await compile(source.source), source)];
}
module.exports = { buildSource, mapDiagnostics, validateVb };
