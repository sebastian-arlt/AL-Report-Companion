'use strict';

function xml(year = '2010', value = 'Original ä &amp; text') {
  const namespace = `http://schemas.microsoft.com/sqlserver/reporting/${year}/01/reportdefinition`;
  const textbox = year === '2005' ? `<Textbox Name="Title"><Value>${value}</Value><Style /></Textbox>`
    : `<Textbox Name="Title"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontFamily>Arial</FontFamily></Style></TextRun></TextRuns><Style /></Paragraph></Paragraphs><Style /></Textbox>`;
  const body = `<Body><ReportItems>${textbox}</ReportItems><Height>1in</Height><Style /></Body>`;
  const page = '<Page><PageHeight>11in</PageHeight><PageWidth>8.5in</PageWidth><Style /></Page>';
  const content = year === '2005' ? `${body}<Width>6.5in</Width><PageHeight>11in</PageHeight><PageWidth>8.5in</PageWidth>`
    : year === '2008' ? `${body}<Width>6.5in</Width>${page}`
      : `<ReportSections><ReportSection>${body}<Width>6.5in</Width>${page}</ReportSection></ReportSections>`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<Report xmlns:rd="http://schemas.microsoft.com/SQLServer/reporting/reportdesigner" xmlns="${namespace}">${content}<rd:ReportID>11111111-1111-1111-1111-111111111111</rd:ReportID></Report>`;
}

function calReport({ id = '50000', name = 'Sales Report', year = '2010', value, eol = '\r\n' } = {}) {
  return [
    `OBJECT Report ${id} ${name}`, '{', '  OBJECT-PROPERTIES', '  {', '    Version List=TEST;', '  }',
    '  CODE', '  {', '    BEGIN', "      MESSAGE('Grüße');", '    END.', '  }',
    '  RDLDATA', '  {', '    ' + xml(year, value).replace(/\n/g, eol),
    '    END_OF_RDLDATA', '  }', '}', ''
  ].join(eol);
}

module.exports = { xml, calReport };
