$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Read-SafeXml([string]$text) {
    $settings = [System.Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 20000000
    $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($text), $settings)
    $document = [System.Xml.XmlDocument]::new()
    $document.PreserveWhitespace = $true
    $document.XmlResolver = $null
    try { $document.Load($reader) } finally { $reader.Dispose() }
    if ($document.DocumentElement.LocalName -ne 'Report') { throw 'The layout root must be Report.' }
    return ,$document
}

function Assert-Schema($document) {
    $namespace = $document.DocumentElement.NamespaceURI
    if ($namespace -notmatch '^https?://schemas\.microsoft\.com/sqlserver/reporting/(2005|2008|2010)/01/reportdefinition$') {
        throw "No bundled legacy schema for $namespace. The original object was not changed."
    }
    $year = $Matches[1]
    $schemaPath = Join-Path (Split-Path $PSScriptRoot -Parent) "schemas/$year.xsd"
    $schemas = [System.Xml.Schema.XmlSchemaSet]::new()
    $schemas.XmlResolver = $null
    [void]$schemas.Add($namespace, $schemaPath)
    $document.Schemas = $schemas
    $script:validationErrors = [System.Collections.Generic.List[string]]::new()
    $document.Validate([System.Xml.Schema.ValidationEventHandler]{
        param($sender, $eventArgs)
        if ($eventArgs.Severity -eq [System.Xml.Schema.XmlSeverityType]::Error) {
            $script:validationErrors.Add($eventArgs.Message)
        }
    })
    if ($script:validationErrors.Count -gt 0) {
        throw ('The edited layout is incompatible with the original RDL schema: ' + (($script:validationErrors | Select-Object -First 4) -join ' '))
    }
}

function Clone-Namespace($node, $target, [string]$sourceNamespace, [string]$targetNamespace) {
    if ($node.NodeType -ne [System.Xml.XmlNodeType]::Element) { return ,$target.ImportNode($node, $true) }
    $namespace = $node.NamespaceURI
    if ($namespace -eq $sourceNamespace) { $namespace = $targetNamespace }
    $copy = $target.CreateElement($node.Prefix, $node.LocalName, $namespace)
    foreach ($attribute in $node.Attributes) {
        $copiedAttribute = $target.ImportNode($attribute, $true)
        if ($attribute.NamespaceURI -eq 'http://www.w3.org/2000/xmlns/' -and $attribute.Value -eq $sourceNamespace) {
            $copiedAttribute.Value = $targetNamespace
        }
        [void]$copy.Attributes.Append($copiedAttribute)
    }
    foreach ($child in $node.ChildNodes) { [void]$copy.AppendChild((Clone-Namespace $child $target $sourceNamespace $targetNamespace)) }
    return ,$copy
}

try {
    $job = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $document = Read-SafeXml $job.xml
    $namespace = $document.DocumentElement.NamespaceURI
    $changes = [System.Collections.Generic.List[string]]::new()
    if ($job.operation -eq 'prepare') {
        Assert-Schema $document
        [Console]::Write((@{ namespace = $namespace; xml = $job.xml; changes = @() } | ConvertTo-Json -Depth 8 -Compress))
        exit 0
    }
    if ($job.operation -ne 'import') { throw 'Unknown RDL operation.' }
    $original = Read-SafeXml $job.originalXml
    Assert-Schema $original
    $targetNamespace = $original.DocumentElement.NamespaceURI
    if ($namespace -ne $targetNamespace) {
        if ($targetNamespace -match '/2005/01/') {
            throw 'The Report Builder upgraded this RDL 2005 layout. Reversing Table/Matrix and Textbox migrations cannot be guaranteed. Use a designer that saves RDL 2005; the edited temporary layout is retained.'
        }
        if ($namespace -notmatch '/(2008|2010|2016)/01/reportdefinition$') { throw "Unsupported RDL source schema: $namespace" }
        if ($targetNamespace -notmatch '/(2008|2010)/01/reportdefinition$') { throw "Unsupported RDL target schema: $targetNamespace" }
        $root = $document.DocumentElement
        foreach ($node in @($root.ChildNodes)) {
            if ($node.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
            if ($node.LocalName -eq 'ReportParametersLayout' -and $node.NamespaceURI -eq $namespace) {
                [void]$root.RemoveChild($node)
                $changes.Add('Removed the newer Report Builder parameter-panel layout; report parameters are preserved.')
            } elseif ($node.LocalName -eq 'AuthoringMetadata' -and $node.NamespaceURI -eq 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition/authoringmetadata') {
                [void]$root.RemoveChild($node)
                $changes.Add('Removed newer designer authoring metadata.')
            } elseif ($node.LocalName -eq 'DefaultFontFamily' -and $node.NamespaceURI -eq 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition/defaultfontfamily') {
                if ($node.InnerText -ne 'Arial') {
                    throw "The upgraded layout uses DefaultFontFamily='$($node.InnerText)'. Set explicit compatible fonts in the designer before importing; this font cannot be silently removed."
                }
                [void]$root.RemoveChild($node)
                $changes.Add('Removed DefaultFontFamily=Arial, the same default in the legacy schema.')
            }
        }
        # Only understood, removed extensions may be removed from MustUnderstand.
        $mustUnderstand = $root.GetAttribute('MustUnderstand')
        foreach ($prefix in ($mustUnderstand -split '\s+' | Where-Object { $_ })) {
            $requiredNamespace = $root.GetNamespaceOfPrefix($prefix)
            if ($requiredNamespace -notin @('http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition/defaultfontfamily', 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition/authoringmetadata')) {
                throw "The layout requires an unsupported extension: $prefix"
            }
        }
        $root.RemoveAttribute('MustUnderstand')
        if ($targetNamespace -match '/2008/01/') {
            $sections = @($root.ChildNodes | Where-Object { $_.NodeType -eq 'Element' -and $_.LocalName -eq 'ReportSections' -and $_.NamespaceURI -eq $namespace })
            if ($sections.Count -gt 0) {
                if ($sections.Count -ne 1) { throw 'Multiple ReportSections containers cannot be converted to RDL 2008.' }
                $items = @($sections[0].ChildNodes | Where-Object { $_.NodeType -eq 'Element' })
                if ($items.Count -ne 1 -or $items[0].LocalName -ne 'ReportSection') { throw 'Multiple report sections cannot be converted to RDL 2008.' }
                $section = $items[0]
                if ($section.Attributes.Count -gt 0) { throw 'ReportSection attributes cannot be converted safely to RDL 2008.' }
                foreach ($child in @($section.ChildNodes)) {
                    if ($child.NodeType -eq 'Element' -and ($child.NamespaceURI -ne $namespace -or $child.LocalName -notin @('Body', 'Width', 'Page'))) {
                        throw "ReportSection.$($child.LocalName) cannot be converted safely to RDL 2008."
                    }
                    [void]$root.InsertBefore($child, $sections[0])
                }
                [void]$root.RemoveChild($sections[0])
                $changes.Add('Unwrapped the single ReportSection for RDL 2008.')
            }
        }
        $converted = [System.Xml.XmlDocument]::new()
        $converted.PreserveWhitespace = $true
        [void]$converted.AppendChild((Clone-Namespace $document.DocumentElement $converted $namespace $targetNamespace))
        $document = $converted
        $changes.Add("Restored the original RDL namespace: $targetNamespace")
    }
    # Restore original root attributes, including namespace bindings; never copy
    # a newer schema header over the exported C/AL object's original header.
    $root = $document.DocumentElement
    $root.Prefix = $original.DocumentElement.Prefix
    $root.RemoveAllAttributes()
    foreach ($attribute in $original.DocumentElement.Attributes) {
        [void]$root.Attributes.Append($document.ImportNode($attribute, $true))
    }
    $xml = $root.OuterXml
    $headerEnd = $xml.IndexOf('>')
    $xml = $job.originalHeader + $xml.Substring($headerEnd + 1)
    $declaration = [regex]::Match($job.originalXml, '^\s*(<\?xml[\s\S]*?\?>)').Groups[1].Value
    if ($declaration) { $xml = $declaration + "`n" + $xml }
    $restored = Read-SafeXml $xml
    Assert-Schema $restored
    [Console]::Write((@{ namespace = $targetNamespace; xml = $xml; changes = @($changes) } | ConvertTo-Json -Depth 8 -Compress))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
