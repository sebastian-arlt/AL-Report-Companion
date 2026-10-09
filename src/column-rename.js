'use strict';
const { tokenize } = require('./layouts');
const { analyze, editsFor } = require('./rdlc-fields');
const validName = name => /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u.test(name);
function columns(text) {
  const tokens = tokenize(text), openings = new Map(), result = [], stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const keyword = tokens[i].raw.toLowerCase();
    if (['report', 'reportextension', 'dataset'].includes(keyword)) {
      let j = i + 1; while (j < tokens.length && !['{', '}', ';'].includes(tokens[j].raw)) j++;
      if (tokens[j]?.raw === '{') openings.set(j, { kind: keyword });
    }
    if (['dataitem', 'add', 'column'].includes(keyword) && tokens[i + 1]?.raw === '(') {
      let depth = 1, j = i + 2;
      for (; j < tokens.length && depth; j++) { if (tokens[j].raw === '(') depth++; else if (tokens[j].raw === ')') depth--; }
      if (!depth && tokens[j]?.raw === '{') openings.set(j, { kind: keyword, name: tokens[i + 2], separator: tokens[i + 3] });
    }
    if (tokens[i].raw === '{') {
      const entry = openings.get(i) || { kind: 'other' };
      if (entry.kind === 'column' && entry.separator?.raw === ';' && stack.some(item => ['report', 'reportextension'].includes(item.kind))
        && stack.some(item => item.kind === 'dataset') && ['dataitem', 'add'].includes(stack.at(-1)?.kind)) {
        const token = entry.name;
        const name = token.raw.startsWith('"') ? token.raw.slice(1, -1).replace(/""/g, '"') : token.raw;
        result.push({ name, start: token.start, end: token.end, quoted: token.raw.startsWith('"') });
      }
      stack.push(entry);
    } else if (tokens[i].raw === '}') stack.pop();
  }
  return result;
}
function layoutColumnEdits(text, oldName, newName) {
  const analysis = analyze(text), names = Object.keys(analysis.datasets);
  const dataset = names.find(name => name.toLowerCase() === 'dataset_result') || (names.length === 1 ? names[0] : undefined);
  if (!dataset) throw new Error('Cannot identify the AL report dataset in this layout.');
  const fields = analysis.datasets[dataset];
  if (!fields.some(field => field.name === oldName)) {
    if (analysis.references.some(ref => ref.name === oldName)) throw new Error('The old field is absent from the dataset. Build or repair this layout before using F2.');
    return [];
  }
  if (fields.some(field => field.name === newName)) throw new Error(`Layout already contains field '${newName}'.`);
  // Allow the existing selective expression editor to validate the new target.
  fields.push({ name: newName, dataField: newName });
  const edits = editsFor(analysis, dataset, oldName, newName);
  const oldRefs = analysis.references.filter(ref => ref.name === oldName && ref.datasets.includes(dataset));
  if (oldRefs.some(ref => !edits.some(edit => edit.start === ref.start && edit.end === ref.end))) throw new Error('Ambiguous dataset scope; use Rename Layout Fields or repair the expression manually.');
  for (const definition of analysis.definitions.filter(item => item.dataset === dataset && item.name === oldName)) {
    edits.push({ ...definition.nameSpan, text: newName });
    if (definition.dataField === oldName && definition.dataFieldSpan) edits.push({ ...definition.dataFieldSpan, text: newName });
  }
  return edits;
}
module.exports = { columns, validName, layoutColumnEdits };
