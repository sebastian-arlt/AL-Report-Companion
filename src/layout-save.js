'use strict';
const { Buffer } = require('node:buffer');
const { TextDecoder } = require('node:util');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
const comparableText = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
function decodeDisk(value, encoding = 'utf8') {
  const buffer = bytes(value);
  let label = String(encoding).toLowerCase().replace(/[-_]/g, '');
  if (buffer[0] === 0xff && buffer[1] === 0xfe) label = 'utf16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) label = 'utf16be';
  else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) label = 'utf8';
  label = ({ utf8: 'utf-8', utf8bom: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', windows1252: 'windows-1252' })[label] || encoding;
  try { return new TextDecoder(label, { fatal: true }).decode(buffer); } catch { return undefined; }
}
function diskMatchesRename(current, original, expected, encoding) {
  if (bytes(current).equals(bytes(original))) return true;
  const decoded = decodeDisk(current, encoding);
  return decoded !== undefined && comparableText(decoded) === comparableText(expected);
}
module.exports = { bytes, comparableText, diskMatchesRename };
