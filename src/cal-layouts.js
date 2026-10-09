'use strict';

const crypto = require('node:crypto');

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function standaloneXml(payload) {
  const xml = payload.replace(/^\uFEFF/, '').trim();
  if (!xml) throw new Error('The RDLDATA section is empty.');
  return xml.startsWith('<?xml')
    ? xml.replace(/^<\?xml\b[\s\S]*?\?>/, '<?xml version="1.0" encoding="utf-8"?>')
    : `<?xml version="1.0" encoding="utf-8"?>\n${xml}`;
}

function findCalLayouts(text) {
  const objects = [...text.matchAll(/^[ \t]*OBJECT[ \t]+(\w+)[ \t]+(\d+)[ \t]+([^\r\n]+)\r?\n[ \t]*\{/gim)];
  const layouts = [];
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index];
    if (object[1].toLowerCase() !== 'report') continue;
    const objectEnd = objects[index + 1]?.index ?? text.length;
    const section = text.slice(object.index, objectEnd);
    const startPattern = /^[ \t]*RDLDATA[ \t]*\r?\n[ \t]*\{[ \t]*\r?\n/gim;
    const start = startPattern.exec(section);
    if (!start) continue;
    const payloadStart = object.index + start.index + start[0].length;
    const rest = text.slice(payloadStart, objectEnd);
    const end = /^[ \t]*END_OF_RDLDATA[ \t]*\r?\n[ \t]*\}/im.exec(rest);
    // Incomplete sections are never offered for editing.
    if (!end) continue;
    const payloadEnd = payloadStart + end.index;
    const payload = text.slice(payloadStart, payloadEnd);
    const root = /<Report\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(payload);
    if (!root || !/<\/Report\s*>/i.test(payload)) continue;
    const namespace = /\bxmlns\s*=\s*(["'])(.*?)\1/i.exec(root[0])?.[2];
    if (!/^https?:\/\/schemas\.microsoft\.com\/sqlserver\/reporting\/\d{4}\/\d{2}\/reportdefinition$/i.test(namespace || '')) continue;
    layouts.push({ id: object[2], name: object[3].trim(), key: `${object[2]}:${object[3].trim()}`,
      objectStart: object.index, objectEnd, start: object.index + start.index,
      end: payloadEnd + end[0].length, payloadStart, payloadEnd, payload,
      hash: digest(payload), namespace, header: root[0], xml: standaloneXml(payload) });
  }
  return layouts;
}

function selectCalLayout(layouts, offset) {
  return layouts.find(layout => offset >= layout.objectStart && offset < layout.objectEnd);
}

function importCalLayout(text, session, xml) {
  const matches = findCalLayouts(text).filter(layout => layout.key === session.key);
  if (matches.length !== 1) throw new Error('The original report was removed, renamed or is ambiguous. Extract its layout again.');
  const layout = matches[0];
  if (layout.hash !== session.sourceHash) throw new Error('RDLDATA changed in the source object while the external layout was being edited. Extract again or merge the changes manually.');
  const eol = layout.payload.includes('\r\n') ? '\r\n' : '\n';
  const leading = /^\s*/.exec(layout.payload)[0];
  const trailing = /\s*$/.exec(layout.payload)[0];
  const replacement = leading + xml.trim().replace(/\r\n|\r|\n/g, eol) + trailing;
  return { start: layout.payloadStart, end: layout.payloadEnd, replacement,
    updatedHash: digest(replacement), layout };
}

module.exports = { digest, standaloneXml, findCalLayouts, selectCalLayout, importCalLayout };
