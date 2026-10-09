# AL Report Companion

## Enable Report Cop per project

Starting with 0.9.0, diagnostics are disabled by default. Add this entry to the AL project's `.vscode/settings.json` to enable missing-field errors, VB errors, and unused-column warnings:

```json
{
  "bcReportLayouts.enableReportCop": true
}
```

Removing the entry or setting it to `false` clears Companion diagnostics immediately. Linked layouts follow their owning AL project configuration; a shared layout is checked if any owning project enables Report Cop. Standalone layouts use their own resource configuration. `bcReportLayouts.validateVisualBasic` can still disable only VB checks within an enabled project. Manual Validate commands also require Report Cop activation. Opening layouts and F2 column renaming remain available without activation; explicit rename commands may parse layouts to calculate edits. The setting does not turn the extension into an AL compiler analyzer or block compilation. AL documents are not saved by validation.

Open RDL/RDLC and Word (.docx) layouts referenced by an AL report using the Windows default application.

## Install and use

1. In VS Code, run **Extensions: Install from VSIX…** and select `al-report-companion-0.9.0.vsix`.
2. Open and trust your local Business Central AL project folder.
3. Right-click an `RDLCLayout`, `WordLayout` or `LayoutFile` declaration in an AL report and choose **Open Layout (.rdlc)** or **Open Layout (.docx)** according to its format.

The declaration under the editor caret determines which menu entry appears. Elsewhere in a report with both formats, both entries appear. Each entry opens or offers only layouts of its format; `.rdl` files are included under **Open Layout (.rdlc)**. The Explorer menu shows entries for the formats declared in the clicked file, independently of the active editor. A single matching layout opens directly. Use **Open Layout…** in the command palette to choose among all formats. If VS Code retains an existing selection when opening a context menu, the retained caret determines the layout; place the caret on the desired declaration first.

Windows uses the application assigned to `.rdlc`, `.rdl` or `.docx` in **Settings > Apps > Default apps**. Configure the association to your report designer or Word application. The extension requires no report renderer or Node.js installation on the user's machine.

## Supported declarations

Legacy properties:

```al
report 50100 "Sales Report"
{
    RDLCLayout = './Layouts/Sales.rdlc';
    WordLayout = './Layouts/Sales.docx';
}
```

Multiple layouts, including report extensions:

```al
reportextension 50101 "Sales Layouts" extends "Sales Invoice"
{
    rendering
    {
        layout(Standard)
        {
            Type = RDLC;
            LayoutFile = './Layouts/Sales.rdlc';
        }
        layout(Alternative)
        {
            Type = RDLC;
            LayoutFile = './Layouts/Alternative.rdl';
        }
        layout(WordLayout)
        {
            Type = Word;
            LayoutFile = './Layouts/Sales.docx';
        }
    }
}
```

Detection supports case-insensitive property names, multiline assignments, comments, quoted layout names and escaped AL apostrophes. Supported paths end in `.rdl`, `.rdlc` or `.docx`. Word layouts work regardless of whether `Type = Word` appears before or after `LayoutFile`. Comments, other object types and unrelated strings are ignored. Conditional compilation branches are scanned as written; the extension does not evaluate preprocessor symbols.

## Project paths

Relative paths are resolved from the nearest ancestor folder containing `app.json`, not from the folder containing the `.al` file. When no `app.json` is found within the workspace folder, that workspace folder is used. This supports nested AL projects and multi-root workspaces. Forward slashes and backslashes are accepted. Missing files produce an error with the resolved path.

Local Windows files only. Remote SSH/WSL/container files and virtual documents are not supported. The extension indexes AL files in the workspace to show the appropriate Explorer entries and updates them when files or open documents change.

## Development

No production dependencies and no compile step. Open this folder in VS Code and press **F5** to start an Extension Development Host.

```powershell
node --test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1
```

The packaging script creates a standard VSIX with the manifest, source, README and license using .NET ZIP APIs, without npm or network access.

## Manual validation

Test in a trusted AL workspace with a registered Windows report designer:

- Right-click a legacy path and each path in a report with multiple rendering layouts.
- Check Explorer selection of multiple layouts and cancellation of the picker.
- Check a nested report source folder, a nested project with its own `app.json`, and a multi-root workspace.
- Check filenames with spaces, umlauts and apostrophes.
- Check a missing file and a file without an associated Windows application.

Automated tests exercise detection, project resolution, selection, command dispatch, and Windows process arguments. Actual report-designer startup requires the local Windows association and is a separate manual check.

AL syntax reference: [Microsoft: Declare report layouts in AL](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-report-layout-declaration).

## Exported C/AL reports

Export a NAV C/AL report as a text object (`.txt` or `.cal`) and open it in VS Code using the correct original file encoding (for example the encoding used by your NAV export). The extension recognizes `OBJECT Report ...`, `RDLDATA { ... END_OF_RDLDATA }`, and combined exports containing multiple objects.

1. Configure **AL Report Companion > Report Builder Path** (`bcReportLayouts.reportBuilderPath`) with the full path to your current `MSReportBuilder.exe` if it is not in a standard installation folder. C/AL layouts launch this executable explicitly; AL layouts continue to use the Windows default application.
2. Right-click the exported report and choose **Open Layout (.rdlc)**. The embedded XML is validated and extracted to a unique session folder containing `layout.rdlc`. For combined exports, the editor caret selects its report; Explorer offers a report picker.
3. Edit and **save to the same `layout.rdlc` file** in Report Builder. If using Save As, choose that original working filename.
4. Return to the source object and choose **Import Layout (.rdlc)**. Only the inner RDLDATA content is replaced. The edit participates in VS Code Undo/Redo and leaves the text object unsaved for inspection. Save the text object and test importing/compiling it in the original NAV environment.

The original `Report` opening tag, including its RDL namespace and namespace declarations, is preserved exactly in the source. During extraction only the standalone XML encoding declaration is normalized to UTF-8, because the working file is written as UTF-8. The extension uses VS Code's text editing API for the C/AL source so its configured encoding is retained when VS Code saves it. C/AL code, wrapper lines, other objects and the source's line-ending convention remain outside the edit.

Session files live in the extension's workspace storage, with a fallback to global storage. This provides temporary work files that survive a VS Code restart rather than depending on an OS temporary directory that might be purged. Each session retains `original.rdlc`, `original-report.txt`, `session.json`, and, after a changed import is prepared, `before-import-report.txt` and `import-candidate.rdlc`. Recovery text copies are UTF-8 copies of the decoded document. Session metadata is persisted in the workspace. Reopening an active session reuses its working layout. **C/AL Report Layouts: Close Layout Session** removes it from the active-session list while retaining its recovery files.

Imports detect concurrent changes to the original embedded layout and changes made while validation is running. Unrelated C/AL edits are allowed. Imports are explicit; external saves never silently rewrite the source object.

### Legacy schema compatibility

The original schema is derived from the embedded XML, not guessed from the report ID or NAV version. RDL 2005, 2008 and 2010 definitions can be extracted, validated and imported when the edited file retains its original schema. XML validation uses the bundled Microsoft XSD files, prohibits DTDs/external entities and requires no network access.

A current Report Builder may automatically upgrade an older definition while saving it. Changing the namespace back alone does **not** undo that conversion. The guarded import implements these limited compatibility steps:

- RDL 2016 back to 2010, and a compatible single-section RDL 2010/2016 report back to 2008.
- Restore the exact original root header and convert the report-definition element namespace structurally, leaving strings and embedded code untouched.
- Remove newer `ReportParametersLayout` (parameter-panel arrangement) and authoring metadata; retain report parameters and report code.
- Remove `DefaultFontFamily=Arial`, whose absence has the same legacy default. A different default font requires explicit compatible fonts before import and is not silently discarded.
- For RDL 2008, unwrap a single `ReportSection` containing only `Body`, `Width` and `Page`. Additional sections or unmapped section properties are rejected.
- Validate the result against the original XSD. Incompatible new elements/features are rejected; the source object stays unchanged and external work remains available.

An upgraded **RDL 2005** file is deliberately rejected: newer designers can replace old Table/Matrix structures and Textbox values with Tablix/Paragraphs/TextRuns. The extension does not implement a general inverse migration. For these reports use a designer that saves RDL 2005, or a separately verified conversion. Supporting every old NAV report in the latest builder with guaranteed reversibility is not achieved by this extension and cannot be promised by header restoration.

Schema validity is not a proof of NAV runtime compatibility: expressions, dataset bindings, custom assemblies, fonts, subreports and printing behavior still require testing in the original target environment. There is no real report-data preview in this extension.

Technical sources:

- [Microsoft: Find the Report Definition Schema Version](https://learn.microsoft.com/en-us/sql/reporting-services/reports/find-the-report-definition-schema-version-ssrs)
- [Microsoft: Upgrade Reports](https://learn.microsoft.com/en-us/sql/reporting-services/install-windows/upgrade-reports)
- [Microsoft: Report.DefaultFontFamily](https://learn.microsoft.com/en-us/openspecs/sql_server_protocols/ms-rdl/691c71de-b19d-4eeb-a5cb-a2b0c0eca8b5)

### RDLC field validation and confirmed renames (0.3.0)

Version 0.3.1 fixes false missing-field errors caused by truncating Unicode field names at umlauts. Validation and confirmed renames accept Unicode identifiers, including combining marks and XML-encoded characters, and retain the complete field-name source span.

All `.rdlc`/`.rdl` layouts explicitly referenced by an AL report or reportextension are checked automatically when AL or layout files change, including files written by a build. Every missing static field reference appears as an **Error** at its exact occurrence in VS Code **Problems**. The generated layout dataset is the source of truth: build after changing AL columns or dataitems. The extension does not predict compiler-generated names from unbuilt AL source.

1. Open the project before the build so the extension can retain the previous dataset field inventory. Inventories persist across VS Code restarts.
2. Rename a column or dataitem in AL and build. If the generated dataset drops an old field while expressions still use it, Problems flags those occurrences. A deleted column produces the same errors; references are never removed automatically.
3. Open the Command Palette and choose **AL Report Companion: Rename Layout Fields…**, or use the missing-field Quick Fix. Choose the old field, its dataset, and its replacement. Newly added fields are suggested; an unchanged `DataField` is labeled as additional evidence. Suggestions require your confirmation because additions and deletions are not proof of a rename. Without an old inventory, all current fields remain available for manual mapping.
4. Inspect the diff. The review picker offers a preview for every affected layout and a separate **Apply … replacements …** action. Escape cancels. Applying performs one undoable workspace edit across all referenced layouts where that dataset and replacement field exist. Files remain unsaved. Repeat for additional mappings.
5. For genuine deletions, correct the affected report expressions manually. **Validate Layout Fields** opens Problems and reports the current error count.

Supported static expressions include `Fields!Name.Value`, `Fields![Name].Value`, `Fields("Name").Value` and `Fields.Item("Name").Value`, also in CDATA and XML attributes. VB string literals, comments and plain display text are excluded. Dataset scope follows the containing data region, literal aggregate dataset arguments and literal Lookup target datasets. XML formatting, namespaces and headers are preserved by editing only field-name spans. If a layout changes during review, the operation aborts.

Limitations: dynamic field names such as `Fields(Parameters!Name.Value)` cannot be resolved statically. Ambiguous scopes are checked against the union of dataset fields and are not renamed automatically; the confirmation reports occurrences left for manual review. This is a field-reference checker, not a complete VB expression compiler or RDLC schema validator. Layouts inherited from a base report without an explicit local layout path are not automatically discovered. Word layouts and embedded C/AL RDLDATA are outside this field-validation feature. Use the existing C/AL workflow for embedded layouts.

Field-validation tests cover column/dataitem field-inventory changes, each missing usage, multiple layouts, dataset scope, strings, XML entities/CDATA, preview cancellation, conflict detection, undoable application and untrusted workspaces. Real AL compiler integration and Report Builder rendering still need verification in your project.

Sources: [Microsoft expression collections](https://learn.microsoft.com/en-us/sql/reporting-services/report-design/built-in-collections-in-expressions-report-builder), [Microsoft expression scope](https://learn.microsoft.com/en-us/sql/reporting-services/report-design/expression-scope-for-totals-aggregates-and-built-in-collections), [VS Code extension API](https://code.visualstudio.com/api/references/vscode-api).

### F2 column rename (0.4.1)

Place the cursor on the **first argument** in `column(TelefonCaptionLbl; TelefonCaptionLbl)`, press **F2**, enter `TelefonCaptionLblTest` in the standard inline rename widget directly at the column name, and confirm. The extension renames the column declaration and the matching dataset field definitions and static expressions in every explicitly referenced RDLC layout. Matching `DataField` bindings are updated too; a different source binding is preserved. This works before the next build, so the dataset and expressions remain consistent together. Names with umlauts are supported. Version 0.4.1 replaces the top-of-window input box with VS Code's native rename widget, including its cancellation and optional preview behavior.

The extension invokes the installed AL rename service and merges its semantic text edits when that service supports column renaming. If it rejects the request or provides no edits, the extension changes only the AL column declaration, together with the layouts. The column's source expression (the second argument, often a label variable) is a separate symbol and is not renamed by the fallback. F2 elsewhere keeps the normal VS Code behavior. A scoped keybinding installs a temporary rename provider for the selected declaration and invokes the standard editor rename action. The temporary provider is removed before querying the AL service to prevent recursion and is cleaned up on cancellation. User-defined F2 keybindings can override this extension's binding.

The entered new name is the confirmed mapping, so this flow applies directly without the manual mapping preview. VS Code applies the returned workspace edit, allowing its native rename preview when enabled. Layouts are saved only after the proposed edits have actually appeared in their documents; cancelled input or preview never triggers saving. If a preview applies only part of a layout's proposed edits, review and save that partial result manually. **Only the changed RDLC/RDL layouts are saved automatically; the extension never saves AL documents**. Your general VS Code Auto Save setting can still save AL independently. Save AL when ready, then build. No build is started by this extension. If a layout save fails, the error identifies the file; some layouts may already have been saved, while remaining edits stay available in the editors. Undo restores editor text; saving the undone layouts is needed to restore their disk contents.

Missing/invalid layouts, dataset-field collisions, ambiguous dataset scope and concurrent file changes abort before applying the rename. F2 covers column declaration names, including nested report dataitems and locally declared reportextension columns. Renaming dataitems or symbols at references uses the existing AL rename behavior and subsequent field validation. Dynamic field expressions and layouts not explicitly referenced in the object remain outside this feature. Verify the generated layout with your AL build and designer.

**Validate Layout Fields** and **Rename Layout Fields…** were removed from editor and Explorer context menus. They remain in the Command Palette; the missing-field Quick Fix remains available. Tests cover the F2 declaration fallback, native rename integration, multiple layouts, layout-only saving with AL left unsaved, cancellation, invalid layouts, collisions, Unicode, source-expression separation, conflicts and save failure. The AL service integration is tested with a mock; verification with the installed Microsoft AL language server is still required.

Implementation uses the documented [VS Code rename-provider command](https://code.visualstudio.com/api/references/commands#commands) and [scoped extension keybindings](https://code.visualstudio.com/api/references/contribution-points#contributes.keybindings).

### Unused column warnings (0.5.0)

Report and reportextension columns receive a **Warning** directly on their declaration names in AL, also visible in **Problems**, when no explicitly linked RDLC/RDL layout uses the corresponding field. A reference in any one of the linked layouts counts as usage. The field's dataset definition and literal display text alone do not count; static field references in layout expressions (including sorting, grouping, visibility, aggregates, indexed fields and Unicode names) do. Validation refreshes on AL/layout changes and builds, including unsaved editor text.

The check uses generated dataset field names. A column must be present in at least one linked layout dataset before it can receive this warning; build first for new columns or compiler-transformed names. Word layouts are not analyzed. Reports without explicit RDLC paths are not warned. If a linked layout is missing or invalid, its report dataset cannot be identified, or a dynamic `Fields(...)` lookup could reference an unknown field, unused-column warnings are suppressed for that report to avoid false positives. Missing-field errors in RDLC continue independently. This feature only reports usage; it does not remove columns or save AL files.

Version 0.5.2 fixes false post-rename save conflicts when the native rename has already saved the expected layout with a BOM, a different encoding or normalized CRLF/LF line endings. Pre-rename conflicts still compare exact disk bytes. After application, the check accepts either unchanged original bytes or the expected text decoded using its BOM/configured file encoding, ignoring only BOM and line-ending differences. Actual content changes remain protected, and conflict messages identify the affected layout. AL files are still never saved by this extension.

Version 0.5.3 replaces the additional post-application disk comparison from 0.5.2 with VS Code's native document save handling. The earlier byte comparison could race the native rename's own saves and report every linked layout as a conflict. Before applying edits, original disk bytes and document versions are still checked. After applying, only matching edited layout documents are considered; already saved/clean layouts are skipped, and dirty layouts are saved through `TextDocument.save()` without forcing overwrite or bypassing VS Code's conflict handling. Failed saves are reported in one notification, with **Show details** opening **Output → AL Report Companion** for individual file paths and save failure messages. AL documents are not saved by the extension. Save-conflict handling follows your VS Code settings, as with a manual save.

### Embedded VB and expression validation (0.6.0)

The extension automatically checks the embedded `<Code>` block **and all XML text/attribute expressions starting with `=` anywhere in RDLC/RDL**. This includes textbox values, visibility, filters, sorting, grouping, actions and expressions passed as arguments to other functions. XML entities and CDATA are decoded and diagnostics are mapped back to their positions in the original layout. Plain text that does not start with `=` is not compiled as an expression.

This is an actual Microsoft Visual Basic compiler check, not a regex-only spelling checker. It detects unknown identifiers such as `Valuue`, missing `Code.BlankZerro` members, missing/excessive arguments, inaccessible functions, conflicting declarations, incomplete blocks and compiler-detectable type/syntax inconsistencies. Public constants/properties, optional parameters and case-insensitive names are supported. The supplied `BlankZero`, `BlankPos`, `BlankZeroAndPos`, `BlankNeg` and `BlankNegAndZero` example is valid, including its implicit Object return types.

VB diagnostics are **Errors** under **Problems**, with English summaries and VB diagnostic IDs. These are static validation results against a simplified context, rather than proof that NAV's report processor will fail. Use **AL Report Companion: Validate Layout Visual Basic** in the Command Palette to recheck all linked layouts of the active report or an open standalone layout. The existing field check remains active independently. Set `bcReportLayouts.validateVisualBasic` to `false` to disable compiler checks in a workspace or resource. Compiler results are cached so unchanged expressions/code are not repeatedly compiled.

The Windows .NET Framework VB compiler is invoked in a hidden process. It writes its generated source and library to an isolated temporary directory and removes them afterward. **The generated assembly is never loaded and report code is never executed. The validation never edits or saves AL or RDLC.** F2 remains separate and only explicitly saves changed layouts. The extension never calls save for AL; VS Code's independent Auto Save setting may still save it.

Limits: the bundled Windows compiler supports VB through the VB 2012 language generation, rather than every newer Report Builder language feature. Report collections and aggregate functions are represented by placeholders. Runtime field values, report-parameter values, group/aggregate execution rules, arbitrary late-bound members and data-dependent exceptions are not verified. External custom assemblies are not loaded or resolved; declared external Code instances are late-bound placeholders, and unresolved dependency warnings mention the limited context. Full compatibility still requires validation/rendering in the target NAV/Business Central environment. If the compiler is unavailable, an error reports that explicitly. Compiler syntax errors may prevent subsequent semantic errors from being reported until the syntax is corrected.

Tests run the real Windows compiler against the supplied code, typo/arity/visibility/type/syntax failures and constant/optional-argument cases, including expressions outside textbox values. Tests also cover XML source positions, comments/CDATA, disabled/unavailable checks, and that compiled code is not executed or AL saved by validation.

Sources: [Microsoft custom report code and Code-member references](https://learn.microsoft.com/en-us/sql/reporting-services/report-design/custom-code-and-assembly-references-in-expressions-in-report-designer-ssrs), [Microsoft report expression examples](https://learn.microsoft.com/en-us/sql/reporting-services/report-design/expression-examples-report-builder-and-ssrs).

### C/AL validation

Automated tests cover extraction and bounded replacement in RDL 2005/2008/2010 exports, combined-object selection, unchanged headers, CRLF/LF and Unicode, conflicts, persisted sessions, and actual Windows PowerShell/.NET XSD validation and conversion. Manual verification with a genuine export, an installed Report Builder and the original NAV runtime is required before relying on the workflow in production.

### Built-in member validation (0.8.0)

The VB compiler now receives typed contracts for the built-in report collections instead of untyped `Object` placeholders. `User` and `Globals` support property, bang, and literal indexed access; `RenderFormat` exposes `Name`, `IsInteractive`, and read-only `DeviceInfo`. Field, parameter, textbox, variable, dataset and data-source objects expose their documented members. Unknown members and incorrect method/indexer argument counts produce English errors in Problems. Expressions support `Me.Value` and `Value`.

Known literal parameter, textbox, variable, dataset and data-source references are checked against declarations when the respective collection is present. Dynamic names are not resolved statically. Existing scoped dataset-field diagnostics continue separately. Embedded-code locals with names such as User are preserved. Report/group accessibility and renderer support remain runtime concerns; runtime variants and custom indexed field properties remain late-bound. Layout and AL files are never modified by these checks.
