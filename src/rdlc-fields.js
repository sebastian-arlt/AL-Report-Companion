'use strict';

// Work on source offsets rather than serializing XML: Report Builder formatting,
// namespaces and the original report header remain intact.
function decode(source, offset) {
  let value = ''; const positions = [];
  for (let i = 0; i < source.length;) {
    const entity = source.slice(i).match(/^&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/i);
    let part = source[i], length = 1;
    if (entity) {
      length = entity[0].length;
      const key = entity[0].slice(1, -1);
      part = key[0] === '#' ? String.fromCodePoint(parseInt(key.slice(key[1]?.toLowerCase() === 'x' ? 2 : 1), key[1]?.toLowerCase() === 'x' ? 16 : 10))
        : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key];
    }
    for (let j = 0; j < part.length; j++) { value += part[j]; positions.push({ start: offset + i, end: offset + i + length }); }
    i += length;
  }
  return { value, positions };
}
const local = name => name.split(':').at(-1);
function expressionScope(value, masked, index, regionScope, datasets) {
  const open = [];
  for (let i = 0; i < index; i++) {
    if (masked[i] === '(') {
      const name = masked.slice(0, i).match(/([\w.]+)\s*$/)?.[1].toLowerCase();
      open.push({ start: i, name });
    } else if (masked[i] === ')') open.pop();
  }
  for (const call of open.reverse()) {
    const aggregate = /^(sum|first|last|count|countdistinct|countrows|avg|min|max|stdev|stdevp|var|varp|aggregate|runningvalue|previous)$/.test(call.name);
    const lookup = /^(lookup|lookupset|multilookup)$/.test(call.name);
    if (!aggregate && !lookup) continue;
    const args = []; let start = call.start + 1, depth = 0;
    for (let i = start; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')') {
        if (!depth) { args.push({ start, end: i }); break; }
        depth--;
      } else if (masked[i] === ',' && !depth) { args.push({ start, end: i }); start = i + 1; }
    }
    const argument = args.findIndex(arg => arg.start <= index && index < arg.end);
    if (lookup && argument === 0) continue; // Source expression uses its containing region.
    const scopeIndex = lookup ? 3 : call.name === 'runningvalue' ? 2 : 1;
    const scopeArg = args[scopeIndex];
    if (!scopeArg) return lookup ? undefined : regionScope;
    const literal = value.slice(scopeArg.start, scopeArg.end).trim().match(/^"((?:[^"]|"")*)"$/);
    const scope = literal?.[1].replace(/""/g, '"');
    return scope && Object.hasOwn(datasets, scope) ? scope : undefined;
  }
  return regionScope;
}
function analyze(text) {
  const root = { children: [], parent: null }; const stack = [root]; const nodes = []; const chunks = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/g;
  let end = 0;
  for (const token of text.matchAll(tokens)) {
    if (token.index !== end) throw new Error('Incomplete XML at offset ' + end);
    end = token.index + token[0].length;
    const raw = token[0], parent = stack.at(-1);
    if (/^<!--|^<\?/.test(raw)) continue;
    if (/^<!DOCTYPE/i.test(raw)) throw new Error('DTD declarations are not supported.');
    if (raw.startsWith('</')) {
      const name = raw.slice(2, -1).trim();
      if (stack.length === 1 || parent.fullName !== name) throw new Error('Mismatched XML closing tag at offset ' + token.index);
      stack.pop(); continue;
    }
    if (raw.startsWith('<') && !raw.startsWith('<![CDATA[')) {
      const match = raw.match(/^<([\w:.-]+)/);
      if (!match) throw new Error('Invalid XML tag at offset ' + token.index);
      const node = { name: local(match[1]), fullName: match[1], parent, children: [], attributes: {}, attributeSpans: {}, text: '' };
      for (const attr of raw.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) {
        node.attributes[local(attr[1])] = decode(attr[3], 0).value;
        const valueOffset = token.index + attr.index + attr[0].indexOf(attr[2]) + 1;
        node.attributeSpans[local(attr[1])] = { start: valueOffset, end: valueOffset + attr[3].length };
        chunks.push({ node, ...decode(attr[3], valueOffset), quote: attr[2] });
      }
      parent.children.push(node); nodes.push(node);
      if (!raw.endsWith('/>')) stack.push(node);
    } else {
      const cdata = raw.startsWith('<![CDATA[');
      const source = cdata ? raw.slice(9, -3) : raw;
      const decoded = cdata ? { value: source, positions: Array.from({ length: source.length }, (_, i) => ({ start: token.index + 9 + i, end: token.index + 10 + i })) }
        : decode(source, token.index);
      parent.text = (parent.text || '') + decoded.value;
      chunks.push({ node: parent, ...decoded, cdata });
    }
  }
  if (end !== text.length || stack.length !== 1 || root.children.length !== 1 || root.children[0].name !== 'Report') throw new Error('Incomplete or invalid Report XML.');
  const datasets = {}, definitions = [];
  for (const node of nodes.filter(node => node.name === 'DataSet' && node.parent.name === 'DataSets')) {
    datasets[node.attributes.Name] = (node.children.find(child => child.name === 'Fields')?.children || [])
      .filter(child => child.name === 'Field').map(child => ({ name: child.attributes.Name,
        dataField: child.children.find(item => item.name === 'DataField')?.text.trim() || '' }));
    for (const field of node.children.find(child => child.name === 'Fields')?.children || []) {
      if (field.name !== 'Field') continue;
      const data = field.children.find(child => child.name === 'DataField');
      const chunk = chunks.find(chunk => chunk.node === data && chunk.value.trim());
      const start = chunk?.value.search(/\S/), end = chunk?.value.trimEnd().length;
      definitions.push({ dataset: node.attributes.Name, name: field.attributes.Name, nameSpan: field.attributeSpans.Name,
        dataField: data?.text.trim(), dataFieldSpan: chunk && { start: chunk.positions[start].start, end: chunk.positions[end - 1].end } });
    }
  }
  const references = [];
  let hasDynamicFieldAccess = false;
  for (const chunk of chunks) {
    if (!chunk.value.trimStart().startsWith('=')) continue;
    let scope;
    for (let node = chunk.node; node; node = node.parent) {
      const own = node.children.find(child => child.name === 'DataSetName');
      if (own) { scope = own.text.trim(); break; }
      if (node.name === 'DataSet' && node.parent?.name === 'DataSets') { scope = node.attributes.Name; break; }
    }
    // Mask VB strings and comments, preserving offsets. Indexed Fields("x")
    // is recognized separately before its quoted argument is masked.
    const value = chunk.value;
    let masked = '', inString = false;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '"') {
        if (inString && value[i + 1] === '"') { masked += '  '; i++; continue; }
        inString = !inString; masked += ' '; continue;
      }
      if (!inString && char === "'") { const next = value.indexOf('\n', i); const stop = next < 0 ? value.length : next; masked += ' '.repeat(stop - i); i = stop - 1; continue; }
      masked += inString ? ' ' : char;
    }
    const matches = [];
    // VB identifiers allow Unicode letters and combining marks. ASCII \w
    // truncated names at e.g. ü and produced false missing-field diagnostics.
    for (const match of masked.matchAll(/\bFields\s*!\s*(\[[^\]\r\n]+\]|[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*)/giu)) {
      const raw = match[1], start = match.index + match[0].lastIndexOf(raw);
      matches.push({ name: raw.startsWith('[') ? raw.slice(1, -1) : raw, index: start, length: raw.length, style: raw.startsWith('[') ? 'bracket' : 'identifier' });
    }
    for (const match of value.matchAll(/\bFields\s*(?:\.\s*Item\s*)?\(\s*"((?:[^"]|"")*)"\s*\)/gi)) {
      if (!/^Fields/i.test(masked.slice(match.index))) continue;
      const start = match.index + match[0].indexOf('"') + 1;
      matches.push({ name: match[1].replace(/""/g, '"'), index: start, length: match[1].length, style: 'string' });
    }
    for (const match of masked.matchAll(/\bFields\s*(?:\.\s*Item\s*)?\(/gi)) {
      const literal = value.slice(match.index).match(/^Fields\s*(?:\.\s*Item\s*)?\(\s*"(?:[^"]|"")*"\s*\)/i);
      if (!literal) hasDynamicFieldAccess = true;
    }
    for (const match of matches) {
      const candidateScope = expressionScope(value, masked, match.index, scope, datasets);
      const available = candidateScope && datasets[candidateScope] ? [candidateScope] : Object.keys(datasets);
      const start = chunk.positions[match.index]?.start, finish = chunk.positions[match.index + match.length - 1]?.end;
      if (start === undefined || finish === undefined) continue;
      references.push({ ...match, start, end: finish, scope: candidateScope, datasets: available,
        missing: available.length > 0 && !available.some(name => datasets[name].some(field => field.name === match.name)),
        cdata: chunk.cdata, quote: chunk.quote });
    }
  }
  const codeNodes = nodes.filter(node => node.name === 'Code' && node.parent.name === 'Report');
  const textContent = new Map();
  for (const chunk of chunks) if (!chunk.quote) {
    if (!textContent.has(chunk.node)) textContent.set(chunk.node, []);
    textContent.get(chunk.node).push(chunk);
  }
  const joined = content => ({ value: content.map(chunk => chunk.value).join(''), positions: content.flatMap(chunk => chunk.positions) });
  const codeBlocks = codeNodes.map(node => {
    return joined(textContent.get(node) || []);
  });
  const expressions = [...textContent].filter(([node]) => !codeNodes.includes(node)).map(([, content]) => joined(content))
    .concat(chunks.filter(chunk => chunk.quote).map(chunk => ({ value: chunk.value, positions: chunk.positions })))
    .filter(chunk => chunk.value.trimStart().startsWith('='));
  const externalCodeInstances = nodes.filter(node => node.name === 'InstanceName' && node.parent.name === 'Class').map(node => node.text.trim());
  const externalCodeModules = nodes.filter(node => node.name === 'CodeModule' && node.parent.name === 'CodeModules').map(node => node.text.trim());
  const builtinNames = {};
  const definitionsOf = (item, parent) => nodes.filter(node => node.name === item && node.parent.name === parent).map(node => node.attributes.Name).filter(Boolean);
  if (nodes.some(node => node.name === 'ReportParameters')) builtinNames.Parameters = definitionsOf('ReportParameter', 'ReportParameters');
  if (nodes.some(node => node.name === 'ReportItems')) builtinNames.ReportItems = nodes.filter(node => node.name === 'Textbox').map(node => node.attributes.Name).filter(Boolean);
  if (nodes.some(node => node.name === 'Variables')) builtinNames.Variables = definitionsOf('Variable', 'Variables');
  if (nodes.some(node => node.name === 'DataSets')) builtinNames.DataSets = definitionsOf('DataSet', 'DataSets');
  if (nodes.some(node => node.name === 'DataSources')) builtinNames.DataSources = definitionsOf('DataSource', 'DataSources');
  return { datasets, references, definitions, hasDynamicFieldAccess, codeBlocks, expressions, externalCodeInstances, externalCodeModules, builtinNames };
}
function replacement(reference, name) {
  if (reference.style === 'identifier' && !/^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*$/u.test(name)) throw new Error('This field requires indexed syntax; choose a valid AL column name.');
  if (reference.style === 'bracket' && name.includes(']')) throw new Error('A bracket field cannot contain ].');
  let value = reference.style === 'bracket' ? `[${name}]` : reference.style === 'string' ? name.replace(/"/g, '""') : name;
  if (reference.cdata) { if (value.includes(']]>')) throw new Error('Invalid CDATA field name.'); return value; }
  value = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (reference.quote === '"') value = value.replace(/"/g, '&quot;');
  if (reference.quote === "'") value = value.replace(/'/g, '&apos;');
  return value;
}
function editsFor(analysis, dataset, oldName, newName) {
  if (!analysis.datasets[dataset]?.some(field => field.name === newName)) return [];
  return analysis.references.filter(ref => ref.name === oldName && (ref.scope === dataset || ref.datasets.length === 1 && ref.datasets[0] === dataset))
    .map(ref => ({ start: ref.start, end: ref.end, text: replacement(ref, newName) }));
}
function applyEdits(text, edits) {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
function suggestions(previous, current, dataset, oldName) {
  const old = previous?.[dataset]?.find(field => field.name === oldName);
  const before = new Set((previous?.[dataset] || []).map(field => field.name));
  return (current[dataset] || []).filter(field => !before.has(field.name)).map(field => ({ name: field.name,
    reason: old?.dataField && old.dataField === field.dataField ? 'Same DataField' : 'New dataset field (confirm mapping)' }));
}
module.exports = { analyze, editsFor, applyEdits, suggestions };
