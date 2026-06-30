const fs = require('fs');
let c = fs.readFileSync('src/core/tool-registry.ts', 'utf8');

const startMarker = 'function toolCallGbnf';
const endMarker = 'export function toolsToXml';
const si = c.indexOf(startMarker);
const ei = c.indexOf(endMarker);

// Build grammar strings using character codes to avoid escaping hell
const Q = '"';       // double quote
const BS = '\\';     // backslash  
const NL = '\\n';    // literal \n for grammar
const EOT_REF = '${EOT}';  // reference to EOT const

const tc = `tool-call ::= ${Q}