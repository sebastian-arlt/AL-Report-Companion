'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/rdlc-fields');
const { buildSource, validateVb } = require('../src/rdlc-vb');
const sample = `<Code>Public Function BlankZero(ByVal Value As Decimal)
    if Value = 0 then
        Return ""
    end if
    Return Value
End Function

Public Function BlankPos(ByVal Value As Decimal)
    if Value &gt; 0 then
        Return ""
    end if
    Return Value
End Function

Public Function BlankZeroAndPos(ByVal Value As Decimal)
    if Value &gt;= 0 then
        Return ""
    end if
    Return Value
End Function

Public Function BlankNeg(ByVal Value As Decimal)
    if Value &lt; 0 then
        Return ""
    end if
    Return Value
End Function

Public Function BlankNegAndZero(ByVal Value As Decimal)
    if Value &lt;= 0 then
        Return ""
    end if
    Return Value
End Function
</Code>`;
test('collects VB from the Code block, every expression location, attributes, split text/CDATA and escaped XML', () => {
  const text = `<Report>${sample}<Value>=Code.BlankZero(1)</Value><Hidden>=Code.BlankPos(2)</Hidden><GroupExpression>=Code.BlankNeg(3)</GroupExpression><FilterValue>=Code.BlankNegAndZero(4)</FilterValue><SortExpression>=Code.BlankZeroAndPos(5)</SortExpression><Action Expr="=Code.BlankZero(&quot;0&quot;)"/><Value>=<![CDATA[Code.BlankZero(0)]]></Value><Value>Code.NotACall</Value><!-- =Code.Comment() --></Report>`;
  const analysis = analyze(text);
  assert.equal(analysis.codeBlocks.length, 1); assert.equal(analysis.expressions.length, 7);
  assert.ok(analysis.codeBlocks[0].value.includes('Value >= 0'));
  assert.ok(analysis.expressions.some(chunk => chunk.value === '=Code.BlankZero(0)'));
  for (const chunk of [...analysis.codeBlocks, ...analysis.expressions]) assert.equal(chunk.positions.length, chunk.value.length);
});
test('source mapping places compiler diagnostics in original XML and keeps all UI messages English', async () => {
  const text = '<Report><Hidden>=Code.Typo()</Hidden></Report>';
  const warnings = await validateVb(analyze(text), async source => [{ line: source.split('\n').findIndex(line => line.includes('Code.Typo')) + 1, column: 0, code: 'BC30456', message: '"Typo" ist kein Member von EmbeddedReportCode.' }]);
  assert.equal(warnings.length, 1); assert.equal(text.slice(warnings[0].start, warnings[0].end), 'Code.Typo()');
  assert.match(warnings[0].message, /Member 'Typo' does not exist/); assert.ok(!warnings[0].message.includes('ist kein'));
});
test('literal content does not launch a compiler', async () => {
  let called = false;
  assert.deepEqual(await validateVb(analyze('<Report><Value>Code.Typo()</Value></Report>'), async () => { called = true; return []; }), []);
  assert.equal(called, false);
});
test('actual Windows VB compiler accepts the supplied five functions and built-in report expressions', { skip: process.platform !== 'win32' }, async () => {
  const text = `<Report>${sample}<Value>=Code.BlankZero(Fields!Amount.Value)</Value><Hidden>=Code.BlankPos(First(Fields!Amount.Value, "DataSet_Result"))</Hidden><FilterValue>=IIF(Fields!Amount.Value &gt; 0, "yes", "no")</FilterValue><SortExpression>=Round(Sum(Fields!Amount.Value), 2)</SortExpression><Value>=Parameters!Choice.Value</Value><Value>=Variables!Count.Value</Value></Report>`;
  assert.deepEqual(await validateVb(analyze(text)), []);
});
test('actual VB compiler detects typos in code, unknown Code calls, missing and excessive arguments at XML locations', { skip: process.platform !== 'win32' }, async () => {
  const text = `<Report>${sample.replace('Return Value', 'Return Valuue')}<Hidden>=Code.BlankZerro(0)</Hidden><GroupExpression>=Code.BlankZero()</GroupExpression><SortExpression>=Code.BlankPos(1, 2)</SortExpression></Report>`;
  const warnings = await validateVb(analyze(text));
  assert.ok(warnings.some(warning => warning.code === 'BC30451' && text.slice(warning.start, warning.end).includes('Valuue')));
  assert.ok(warnings.some(warning => warning.code === 'BC30456' && text.slice(warning.start, warning.end).includes('BlankZerro')));
  assert.ok(warnings.some(warning => warning.code === 'BC30455' && text.slice(warning.start, warning.end).includes('BlankZero')));
  assert.ok(warnings.some(warning => warning.code === 'BC30057' && text.slice(warning.start, warning.end).includes('BlankPos')));
});
test('actual VB compiler detects structural errors and duplicate functions', { skip: process.platform !== 'win32' }, async () => {
  const missingEnd = await validateVb(analyze('<Report><Code>Public Function X() As Object\nReturn Nothing</Code><Hidden>=Code.X()</Hidden></Report>'));
  assert.ok(missingEnd.some(warning => ['BC30027', 'BC30289'].includes(warning.code)));
  const duplicate = await validateVb(analyze('<Report><Code>Public Function X() As Object\nReturn Nothing\nEnd Function\nPublic Function X() As Object\nReturn Nothing\nEnd Function</Code><Hidden>=Code.X()</Hidden></Report>'));
  assert.ok(duplicate.length > 0);
});
test('actual VB compiler resolves public constants, properties, optional arguments, case-insensitive calls and private visibility', { skip: process.platform !== 'win32' }, async () => {
  const text = `<Report><Code><![CDATA[Public Const MyNote As String = "Note"
Public Function Test(Optional x As Integer = 0) As Object
Return x
End Function
Private Function Secret() As Object
Return 1
End Function]]></Code><Value>=Code.MyNote</Value><Hidden>=Code.tEsT()</Hidden><Value>=Code.Secret()</Value></Report>`;
  const warnings = await validateVb(analyze(text));
  assert.equal(warnings.length, 1); assert.equal(warnings[0].code, 'BC30390');
  assert.match(text.slice(warnings[0].start, warnings[0].end), /Secret/);
});
test('external Code instances are represented as placeholders rather than falsely reported as absent', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Classes><Class><ClassName>Custom.Assembly.Helper</ClassName><InstanceName>Helper</InstanceName></Class></Classes><Value>=Code.Helper.UnverifiableFunction(1)</Value></Report>';
  const analysis = analyze(text);
  assert.ok(buildSource(analysis).source.includes('Public [Helper] As Object'));
  assert.deepEqual(await validateVb(analysis), []);
});
test('compilation never executes embedded code', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Code>Shared Sub New()\nThrow New Exception("must never execute")\nEnd Sub\nPublic Function X() As Object\nThrow New Exception("must never execute")\nEnd Function</Code><Value>=Code.X()</Value></Report>';
  assert.deepEqual(await validateVb(analyze(text)), []);
});
test('actual compiler catches type inconsistencies and syntax errors outside textbox values', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Code>Public Function BadType() As Integer\nReturn New System.Text.StringBuilder()\nEnd Function</Code><Action Expr="=Code.DoesNotExist()"/></Report>';
  const warnings = await validateVb(analyze(text));
  assert.ok(warnings.some(warning => warning.code === 'BC30311'));
  assert.ok(warnings.some(warning => warning.code === 'BC30456'));
  const syntax = await validateVb(analyze('<Report><Hidden>=1 +</Hidden></Report>'));
  assert.ok(syntax.some(warning => warning.code === 'BC30201'));
});

const navCode = '<Code>Shared Data1 As Object\nPublic Function SetData(NewData As Object, Group As Integer) As Boolean\nData1 = NewData\nReturn True\nEnd Function\nPublic Function GetData(Num As Integer, Group As Integer) As Object\nIf Group = 1 Then\nReturn CStr(Choose(Num, Split(CStr(Data1), Chr(177))))\nEnd If\nEnd Function</Code>';
test('NAV multiline SetData expression with a comma on the next line has no spurious call or syntax errors', { skip: process.platform !== 'win32' }, async () => {
  const parts = Array.from({length: 13}, (_, i) => 'CStr(Fields!FooterInfo' + (i + 1) + '.Value)');
  const text = '<Report>' + navCode + '<Hidden>=Code.SetData(' + parts.join(' + Chr(177) +\r\n') + '\r\n,2)</Hidden></Report>';
  const results = await validateVb(analyze(text));
  assert.deepEqual(results.map(r => r.code), ['BC42105']);
  assert.match(results[0].message, /does not explicitly return a value on every code path/);
  assert.ok(!results[0].message.includes('syntax'));
});
test('multiline expression normalization preserves comments, escaped quotes and explicit continuation', { skip: process.platform !== 'win32' }, async () => {
  const text = `<Report><Code>Public Function Echo(x As Object, y As Object) As Object\nReturn x\nEnd Function</Code><Value><![CDATA[=Code.Echo("a''b""c", _ \n  ' formatting comment\n "ok")]]></Value></Report>`;
  assert.deepEqual(await validateVb(analyze(text)), []);
});
test('a real typo on a later expression line maps back to the original XML', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Code>Public Function SetData(x As Object, Group As Integer) As Boolean\nReturn True\nEnd Function</Code><Hidden>=Code.SetData(Fields!A.Value +\nChr(177),\nMisspelledGroup)</Hidden></Report>';
  const results = await validateVb(analyze(text));
  assert.equal(results.length, 1); assert.equal(results[0].code, 'BC30451');
  assert.equal(text.slice(results[0].start, results[0].end), 'MisspelledGroup)');
});
test('an actual missing argument in a multiline call remains diagnosed', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report>' + navCode + '<Hidden>=Code.SetData(Fields!A.Value +\nChr(177))</Hidden></Report>';
  assert.ok((await validateVb(analyze(text))).some(r => r.code === 'BC30455'));
});

test('explicit fallback Return removes the GetData return-path diagnostic', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report>' + navCode.replace('End If\nEnd Function', 'End If\nReturn Nothing\nEnd Function') + '<Value>=Code.GetData(1, 2)</Value></Report>';
  assert.deepEqual(await validateVb(analyze(text)), []);
});

test('documented built-in members and access forms compile, including nested RenderFormat and Me.Value', { skip: process.platform !== 'win32' }, async () => {
  const expressions = [
    'User!UserID', 'User.Language', 'User("Language").ToUpper()', 'User.Item("UserID").Substring(0, 1)',
    'Globals!PageNumber', 'Globals.ExecutionTime.ToString("d")', 'Globals("RenderFormat").Name',
    'Globals.Item("RenderFormat").IsInteractive', 'Globals!RenderFormat.DeviceInfo("OutputFormat")',
    'Globals!RenderFormat.DeviceInfo.GetValues("OutputFormat")', 'Globals!RenderFormat.DeviceInfo.AllValues',
    'Fields!Amount.Value', 'Fields.Item("Amount").IsMissing', 'Fields(Parameters!Choice.Value).FormattedValue',
    'Fields!Amount("ProviderSpecificProperty")', 'Fields!Amount!ProviderSpecificProperty',
    'Parameters!Choice.IsMultiValue', 'Parameters("Choice").Count', 'Parameters!Choice.Value(0)',
    'Parameters!Choice.Label(0)', 'ReportItems!Textbox1.Value', 'Variables!Tax.SetValue(1)',
    'Variables!Tax.Writable', 'DataSets!Result.CommandText', 'DataSources!Source.Type',
    'Scopes!Result.Fields!Amount.Value', 'Me.Value', 'Value', 'uSeR![Language].Trim()'
  ];
  const text = '<Report>' + expressions.map(value => '<Value><![CDATA[=' + value + ']]></Value>').join('') + '</Report>';
  assert.deepEqual(await validateVb(analyze(text)), []);
});
test('unknown built-in members are errors for both fixed and indexed collection objects', { skip: process.platform !== 'win32' }, async () => {
  const expressions = ['User!Languagge', 'User("UserIDD")', 'Globals.PagNumber', 'Globals!RenderFormat.Nmae',
    'Globals("RenderFormat").IsInteractiv', 'Fields!Amount.Vaule', 'Fields("Amount").IsMissng',
    'Parameters!Choice.Lable', 'ReportItems!Textbox1.Vaule', 'Variables!Tax.SetValu(1)',
    'DataSets!Result.CommandTxt', 'DataSources!Source.Typpe', 'Fields.Items("Amount")'];
  const text = '<Report>' + expressions.map(value => '<Value><![CDATA[=' + value + ']]></Value>').join('') + '</Report>';
  const results = await validateVb(analyze(text));
  assert.equal(results.filter(r => r.code === 'BC30456').length, expressions.length);
});
test('built-in methods and indexers check required arguments and excessive arguments', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Value>=Variables!Tax.SetValue()</Value><Value>=Fields.Item()</Value><Value>=Fields.Item("A", "B")</Value><Value>=User!Language.Substring()</Value></Report>';
  const results = await validateVb(analyze(text));
  assert.ok(results.some(r => r.code === 'BC30455'));
  assert.ok(results.some(r => r.code === 'BC30057'));
  assert.ok(results.length >= 4);
});
test('collection definitions validate literal parameter, textbox, variable, dataset and source names', { skip: process.platform !== 'win32' }, async () => {
  const definitions = '<ReportParameters><ReportParameter Name="Choice" /></ReportParameters><ReportItems><Textbox Name="Caption" /></ReportItems><Variables><Variable Name="Tax" /></Variables><DataSets><DataSet Name="Result" /></DataSets><DataSources><DataSource Name="Source" /></DataSources>';
  const expressions = ['Parameters!Chocie.Value', 'ReportItems("Capiton").Value', 'Variables!Txa.Value', 'DataSets!Reslut.CommandText', 'DataSources!Srouce.Type'];
  const text = '<Report>' + definitions + expressions.map(value => '<Value><![CDATA[=' + value + ']]></Value>').join('') + '</Report>';
  const results = await validateVb(analyze(text));
  assert.equal(results.length, 5); assert.ok(results.every(r => r.code === 'RDL1001'));
  assert.deepEqual(results.map(r => text.slice(r.start, r.end)), ['Chocie', '"Capiton"', 'Txa', 'Reslut', 'Srouce']);
});
test('dynamic collection keys and variant values are not guessed; literals and comments are ignored', { skip: process.platform !== 'win32' }, async () => {
  const text = `<Report><ReportParameters><ReportParameter Name="Choice" /></ReportParameters><Value><![CDATA[=Fields(Parameters!Choice.Value).Value.ProviderSpecificMethod()]]></Value><Value><![CDATA[=User(Parameters!Choice.Value)]]></Value><Value><![CDATA[="User!NoSuchMember Globals!NoSuchMember" ' User!NoSuchMember]]></Value></Report>`;
  assert.deepEqual(await validateVb(analyze(text)), []);
});
test('built-ins are typed inside embedded code through Report and direct references', { skip: process.platform !== 'win32' }, async () => {
  const valid = '<Report><Code>Public Function CurrentUser() As String\nReturn Report.User!UserID &amp; User("Language")\nEnd Function</Code><Value>=Code.CurrentUser()</Value></Report>';
  assert.deepEqual(await validateVb(analyze(valid)), []);
  const invalid = valid.replace('UserID', 'UserIDD');
  assert.ok((await validateVb(analyze(invalid))).some(r => r.code === 'BC30456'));
});
test('Unicode names and XML entities preserve exact diagnostics for indexed fixed-member typos', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Hidden>=User.Item(&quot;Languagge&quot;)</Hidden><Value>=Fields![Warenwert_für].Vaule</Value></Report>';
  const results = await validateVb(analyze(text));
  assert.equal(results.length, 2); assert.ok(results.every(r => r.code === 'BC30456'));
  assert.ok(results.some(r => text.slice(r.start, r.end).includes('Languagge')));
});

test('local collection objects in embedded code are not rewritten or checked as report definitions', { skip: process.platform !== 'win32' }, async () => {
  const text = '<Report><Code><![CDATA[Public Function ReadLocal(User As System.Collections.Specialized.NameValueCollection, Parameters As System.Collections.Specialized.NameValueCollection) As Object\nRem User!NoSuchMember\nReturn User("local") & Parameters("local")\nEnd Function]]></Code><ReportParameters><ReportParameter Name="ReportChoice" /></ReportParameters></Report>';
  assert.deepEqual(await validateVb(analyze(text)), []);
});
