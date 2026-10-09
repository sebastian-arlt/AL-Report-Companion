$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$output = Join-Path $projectRoot "$($package.name)-$($package.version).vsix"
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($package.name)" Version="$($package.version)" Publisher="$($package.publisher)" />
    <DisplayName>$($package.displayName)</DisplayName>
    <Description xml:space="preserve">$($package.description)</Description>
    <Tags>AL,CAL,NAV,Business Central,RDLC,RDL,Word,DOCX</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($package.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
"@
$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="ps1" ContentType="text/plain" />
  <Default Extension="xsd" ContentType="text/xml" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
'@
$stream = [System.IO.File]::Open($output, [System.IO.FileMode]::Create)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
function Add-TextEntry([string]$name, [string]$content) {
  $entry = $archive.CreateEntry($name)
  $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
  try { $writer.Write($content) } finally { $writer.Dispose() }
}
try {
  Add-TextEntry 'extension.vsixmanifest' $manifest
  Add-TextEntry '[Content_Types].xml' $contentTypes
  $packageFiles = @('package.json', 'README.md', 'LICENSE')
  foreach ($directory in @('src', 'schemas', 'media', 'docs')) {
    $packageFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot $directory) -File -Recurse | ForEach-Object {
      $_.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
    }
  }
  foreach ($relative in $packageFiles) {
    $entry = $archive.CreateEntry("extension/$relative")
    $inputStream = [System.IO.File]::OpenRead((Join-Path $projectRoot $relative))
    $entryStream = $entry.Open()
    try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose(); $inputStream.Dispose() }
  }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Output "Created $output"
