/**
 * Markdown frontmatter parse for example/story files.
 *
 * Expected shape:
 *   ---
 *   think: |
 *     <paragraph of model-targeted narration>
 *   ---
 *   # File content...
 *
 * Returns:
 *   - think: the contents of `think:` (after YAML folding),
 *   - body:  the markdown after the closing `---`.
 *
 * The parser is intentionally minimal — only the fields used here
 * (`think`) are supported. Other YAML fields are ignored (so authors
 * can leave notes, will document why they wrote X, etc., without
 * breaking the loader).
 */
import * as fs from "fs"

export interface FrontmatterResult {
  think: string | null
  body: string
  /** Any unrecognized fields — surfaced for debugging without breaking. */
  extra: Record<string, string>
}

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function readFolded(raw: string): string {
  // Very simple: trim trailing whitespace and join continuation lines.
  return raw
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim()
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(FRONT_RE)
  if (!match) return { think: null, body: raw, extra: {} }
  const inside = match[1]
  const body = raw.slice(match[0].length)

  // Capture the indented block beneath `think: |`. The block ends
  // whenever a non-indented line appears (a new YAML key) or end of
  // string. Anchoring `^` with the `m` flag does most of the work.
  let think: string | null = null
  const thinkHead = /^think:\s*\|\s*\n/m.exec(inside)
  if (thinkHead && thinkHead.index !== undefined) {
    const rest = inside.slice(thinkHead.index + thinkHead[0].length)
    const lines: string[] = []
    for (const line of rest.split("\n")) {
      if (line.trim() === "") { lines.push(""); continue }
      if (/^[A-Za-z_][\w-]*:\s/.test(line)) break
      // Strip exactly two-space indent added by YAML '|' so the
      // captured block can be re-used as a think entry without
      // surfacing the YAML formatting.
      lines.push(line.startsWith("  ") ? line.slice(2) : line)
    }
    think = lines.join("\n").trim()
  }

  const extra: Record<string, string> = {}
  for (const line of inside.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (m && m[1] !== "think") extra[m[1]] = m[2]
  }

  return { think, body, extra }
}

/**
 * Read a markdown file and return its frontmatter and body. Returns
 * null when the file does not exist.
 */
export function readFrontmatter(filePath: string): FrontmatterResult | null {
  try {
    return parseFrontmatter(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}
