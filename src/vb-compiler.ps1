$ErrorActionPreference = 'Stop'
[System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
$env:VSLANG = '1033'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskTempDirectory = $null
try {
    $taskJob = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $taskTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $taskTempDirectory = [System.IO.Path]::GetFullPath((Join-Path $taskTempRoot ('bc-rdlc-vb-' + [guid]::NewGuid().ToString('N'))))
    if ([System.IO.Path]::GetDirectoryName($taskTempDirectory).TrimEnd('\') -ne $taskTempRoot.TrimEnd('\')) { throw 'Invalid compiler temporary directory.' }
    [void][System.IO.Directory]::CreateDirectory($taskTempDirectory)
    $taskSource = Join-Path $taskTempDirectory 'ReportValidation.vb'
    [System.IO.File]::WriteAllText($taskSource, [string]$taskJob.source, [System.Text.UTF8Encoding]::new($true))
    $taskProvider = [Microsoft.VisualBasic.VBCodeProvider]::new()
    $taskOptions = [System.CodeDom.Compiler.CompilerParameters]::new()
    $taskOptions.GenerateExecutable = $false
    $taskOptions.GenerateInMemory = $false
    $taskOptions.IncludeDebugInformation = $false
    # CodeDom can omit warnings when compilation succeeds. Elevating native
    # warnings also makes their reporting consistent with the editor error policy.
    $taskOptions.TreatWarningsAsErrors = $true
    $taskOptions.OutputAssembly = Join-Path $taskTempDirectory 'ReportValidation.dll'
    $taskOptions.TempFiles = [System.CodeDom.Compiler.TempFileCollection]::new($taskTempDirectory, $false)
    $taskOptions.CompilerOptions = '/optionexplicit+ /optionstrict- /utf8output'
    foreach ($taskReference in @('System.dll', 'System.Core.dll', 'System.Xml.dll', 'Microsoft.VisualBasic.dll')) { [void]$taskOptions.ReferencedAssemblies.Add($taskReference) }
    try {
        # Never load the generated assembly or evaluate report code.
        $taskResult = $taskProvider.CompileAssemblyFromFile($taskOptions, $taskSource)
        $taskErrors = @($taskResult.Errors | ForEach-Object {
            @{ line = $_.Line; column = $_.Column; code = $_.ErrorNumber; message = $_.ErrorText; warning = $_.IsWarning }
        })
        @{ diagnostics = $taskErrors } | ConvertTo-Json -Depth 8 -Compress
    } finally { $taskProvider.Dispose() }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($taskTempDirectory -and [System.IO.Path]::GetDirectoryName($taskTempDirectory).TrimEnd('\') -eq [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') -and [System.IO.Path]::GetFileName($taskTempDirectory) -match '^bc-rdlc-vb-[a-f0-9]{32}$' -and [System.IO.Directory]::Exists($taskTempDirectory)) {
        [System.IO.Directory]::Delete($taskTempDirectory, $true)
    }
}
