/** Shared utilities for the RWKV adapter and agent loop. */

export function clean(txt: string): string {
  return txt.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

export function fixToolCallJson(raw: string): string {
  try { JSON.parse(raw); return raw } catch {}

  let result = ""
  let inString = false
  let escaped = false

  const escapeMap: Record<string, string> = {
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === "\\" && inString) { result += ch; escaped = true; continue }
    if (escaped) { result += ch; escaped = false; continue }

    if (ch === '"') {
      if (!inString) {
        inString = true
        result += '"'
      } else {
        const rest = raw.slice(i + 1).trimStart()
        if (rest.length > 0 && ',:}]'.includes(rest[0])) {
          inString = false
          result += '"'
        } else {
          result += '\\"'
        }
      }
    } else if (inString && escapeMap[ch] !== undefined) {
      result += escapeMap[ch]
    } else {
      result += ch
    }
  }
  return result
}
