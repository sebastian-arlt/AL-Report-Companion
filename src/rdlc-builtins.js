'use strict';

// Static contracts follow Microsoft's RDLC/RDL built-in collection documentation.
// Values stay late-bound where report metadata does not establish a CLR type.
const members = {
  ReportField: { Value: 'Object', IsMissing: 'Boolean', UniqueName: 'String', BackgroundColor: 'String', Color: 'String', FontFamily: 'String', FontSize: 'String', FontWeight: 'String', FontStyle: 'String', TextDecoration: 'String', FormattedValue: 'String', Key: 'Object', LevelNumber: 'Integer', ParentUniqueName: 'String' },
  ReportParameter: { Value: 'Object', Label: 'Object', Count: 'Integer', IsMultiValue: 'Boolean' },
  ReportTextbox: { Value: 'Object' },
  ReportVariable: { Value: 'Object', Writable: 'Boolean' },
  ReportDataSet: { CommandText: 'String', RewrittenCommandText: 'String' },
  ReportDataSource: { DataSourceReference: 'String', Type: 'String' },
  ReportUser: { UserID: 'String', Language: 'String' },
  ReportGlobals: { ExecutionTime: 'DateTime', PageNumber: 'Integer', TotalPages: 'Integer', OverallPageNumber: 'Integer', OverallTotalPages: 'Integer', PageName: 'String', ReportFolder: 'String', ReportName: 'String', ReportServerUrl: 'String', RenderFormat: 'ReportRenderFormat' },
  ReportRenderFormat: { Name: 'String', IsInteractive: 'Boolean', DeviceInfo: 'ReportNameValues' },
  ReportScope: { Fields: 'ReportFields', Variables: 'ReportVariables' }
};
const collections = {
  Fields: 'ReportField', Parameters: 'ReportParameter', ReportItems: 'ReportTextbox', Variables: 'ReportVariable', DataSets: 'ReportDataSet', DataSources: 'ReportDataSource', Scopes: 'ReportScope'
};
const environmentTypes = { ...Object.fromEntries(Object.keys(collections).map(name => [name, `Report${name}`])), User: 'ReportUser', Globals: 'ReportGlobals', Report: 'ReportContext' };
function stubLines() {
  const lines = [];
  const add = (...values) => lines.push(...values);
  const item = (type, keyType = 'Object') => add(`Default Public ReadOnly Property Item(key As ${keyType}) As ${type}`, 'Get', 'Return Nothing', 'End Get', 'End Property');
  for (const [name, properties] of Object.entries(members)) {
    add(`Public Class ${name}`);
    for (const [property, type] of Object.entries(properties)) add(`Public [${property}] As ${type}`);
    // Provider-specific field properties are allowed through indexed syntax.
    if (['ReportField', 'ReportVariable', 'ReportParameter'].includes(name)) item('Object');
    if (name === 'ReportVariable') add('Public Function SetValue(value As Object) As Boolean', 'Return True', 'End Function');
    if (name === 'ReportUser' || name === 'ReportGlobals') item('Object');
    add('End Class');
  }
  for (const [name, type] of Object.entries(collections)) {
    add(`Public Class Report${name}`, 'Public Count As Integer'); item(type); add('End Class');
  }
  add('Public Class ReportNameValues', 'Public Count As Integer', 'Public AllKeys As String()', 'Public AllValues As String()', 'Public Keys As System.Collections.Specialized.NameObjectCollectionBase.KeysCollection');
  item('String');
  for (const [name, args, type] of [
    ['Get', 'key As Object', 'String'], ['GetKey', 'index As Integer', 'String'], ['GetValues', 'key As Object', 'String()'],
    ['HasKeys', '', 'Boolean'], ['GetEnumerator', '', 'System.Collections.IEnumerator']
  ]) add(`Public Function ${name}(${args}) As ${type}`, 'Return Nothing', 'End Function');
  add('Public Sub CopyTo(array As Array, index As Integer)', 'End Sub', 'End Class', 'Public Class ReportContext');
  for (const [name, type] of Object.entries(environmentTypes)) if (name !== 'Report') add(`Public ${name} As ${type}`);
  add('End Class');
  return lines;
}

// Keep source positions while tokenizing VB strings (including doubled quotes),
// bracketed Unicode identifiers, comments and explicit line continuations.
function tokens(value) {
  const result = [];
  for (let i = 0; i < value.length;) {
    if (/\s/.test(value[i])) { i++; continue; }
    if (value[i] === "'") { const end = value.indexOf('\n', i); i = end < 0 ? value.length : end; continue; }
    const start = i;
    if (value[i] === '"') {
      i++; let name = '';
      while (i < value.length) {
        if (value[i] === '"') {
          if (value[i + 1] === '"') { name += '"'; i += 2; continue; }
          i++; break;
        }
        name += value[i++];
      }
      result.push({ start, end: i, name, kind: 'string' }); continue;
    }
    if (value[i] === '[') {
      const end = value.indexOf(']', i + 1);
      if (end >= 0) { i = end + 1; result.push({ start, end: i, name: value.slice(start + 1, end), kind: 'identifier' }); continue; }
    }
    const identifier = value.slice(i).match(/^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\p{Cf}]*/u);
    if (identifier) {
      i += identifier[0].length;
      if (identifier[0] === '_' && /^[ \t]*(?:'[^\r\n]*)?\r?\n/.test(value.slice(i))) continue;
      if (/^rem$/i.test(identifier[0]) && /(?:^|[\n:])[ \t]*$/.test(value.slice(0, start))) {
        const end = value.indexOf('\n', i); i = end < 0 ? value.length : end; continue;
      }
      result.push({ start, end: i, name: identifier[0], kind: 'identifier' }); continue;
    }
    i++; result.push({ start, end: i, name: value[start], kind: 'punctuation' });
  }
  return result;
}
function accesses(value) {
  const list = tokens(value), result = [];
  for (let i = 0; i < list.length; i++) {
    const root = list[i];
    if (root.kind !== 'identifier') continue;
    const collection = Object.keys(environmentTypes).find(name => name.toLowerCase() === root.name.toLowerCase());
    if (!collection || collection === 'Report') continue;
    // A qualified property of an unrelated object is not a built-in collection.
    if (list[i - 1]?.name === '.' && !['report', 'me'].includes(list[i - 2]?.name.toLowerCase())) continue;
    let next = i + 1, name;
    if (list[next]?.name === '!' && list[next + 1]?.kind === 'identifier') {
      name = list[next + 1]; next += 2;
    } else {
      if (list[next]?.name === '.' && list[next + 1]?.name.toLowerCase() === 'item') next += 2;
      if (list[next]?.name !== '(' || list[next + 1]?.kind !== 'string' || list[next + 2]?.name !== ')') continue;
      name = list[next + 1]; next += 3;
    }
    result.push({ collection, root, name, end: list[next - 1].end });
  }
  return result;
}
function fixedMemberEdits(value, shadowed = new Set()) {
  return accesses(value).filter(access => !shadowed.has(access.collection.toLowerCase()) ||
    /(?:report|me)\s*\.\s*$/i.test(value.slice(0, access.root.start))).filter(access => ['User', 'Globals'].includes(access.collection))
    // An invalid fixed member must be diagnosed too. Unsafe identifiers retain
    // indexed syntax and are handled by the collection-name check instead.
    .filter(access => /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u.test(access.name.name))
    .map(access => ({ start: access.root.end, end: access.end, replacement: `.[${access.name.name}]`, anchor: access.name.start }));
}
function nameDiagnostics(analysis) {
  const result = [];
  for (const chunk of analysis.expressions || []) {
    for (const access of accesses(chunk.value)) {
      if (access.collection === 'Fields') continue; // Dataset-scoped field validation is separate.
      const fixed = { User: Object.keys(members.ReportUser), Globals: Object.keys(members.ReportGlobals) }[access.collection];
      const names = fixed || analysis.builtinNames?.[access.collection];
      if (!names || names.some(name => fixed ? name.toLowerCase() === access.name.name.toLowerCase() : name === access.name.name)) continue;
      // The compiler diagnoses safe fixed identifiers through typed properties.
      if (fixed && /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u.test(access.name.name)) continue;
      const first = chunk.positions[access.name.start], last = chunk.positions[access.name.end - 1];
      if (!first || !last) continue;
      result.push({ start: first.start, end: last.end, code: 'RDL1001', message: `RDLC RDL1001: '${access.name.name}' is not defined in the ${access.collection} collection.` });
    }
  }
  return result;
}
function shadowedFixedNames(analysis) {
  const result = new Set();
  for (const chunk of analysis.codeBlocks || []) {
    const list = tokens(chunk.value);
    for (let i = 0; i < list.length; i++) {
      const name = list[i].name.toLowerCase();
      if (['user', 'globals'].includes(name) && (list[i + 1]?.name.toLowerCase() === 'as' ||
        ['dim', 'const', 'static', 'byval', 'byref', 'optional'].includes(list[i - 1]?.name.toLowerCase()))) result.add(name);
    }
  }
  return result;
}
module.exports = { environmentTypes, stubLines, fixedMemberEdits, nameDiagnostics, shadowedFixedNames };
