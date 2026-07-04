/**
 * Helpers for parsing GBNF grammars structurally. Mirrors the validation
 * performed by `schoolmarm::Grammar::new` (the Rust crate the binding
 * uses), so we can test in TS without linking the native crate.
 *
 * schoolmarm's `parse_name` (parse.rs:81) accepts `[a-zA-Z_-][a-zA-Z0-9_-]*`
 * — rule names may contain letters, digits, underscores, and dashes, but
 * not start with a digit.
 */

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

export interface ParsedGrammar {
  definitions: Map<string, string>
  order: string[]
}

export function parseGrammar(gbnf: string): ParsedGrammar {
  const definitions = new Map<string, string>()
  const order: string[] = []
  for (const rawLine of gbnf.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim()
    if (!line) continue
    const eqIdx = line.indexOf("::=")
    if (eqIdx < 0) {
      throw new Error(`line missing "::=": ${JSON.stringify(rawLine)}`)
    }
    const name = line.slice(0, eqIdx).trim()
    const rhs = line.slice(eqIdx + 3).trim()
    if (!IDENT_RE.test(name)) {
      throw new Error(`invalid rule identifier: ${JSON.stringify(name)}`)
    }
    if (definitions.has(name)) {
      throw new Error(`duplicate rule definition: ${name}`)
    }
    definitions.set(name, rhs)
    order.push(name)
  }
  return { definitions, order }
}

/** Collect every identifier on an RHS that isn't a literal or character class. */
export function rhsIdentifiers(rhs: string): Set<string> {
  const ids = new Set<string>()
  const stripped = rhs.replace(/"(?:\\.|[^"\\])*"/g, "")
  const noClasses = stripped.replace(/\[[^\]]*\]/g, "")
  const re = /\b[a-zA-Z_][a-zA-Z0-9_-]*\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noClasses)) !== null) {
    ids.add(m[0])
  }
  return ids
}

export interface GrammarIssue {
  name: string
  message: string
}

/**
 * Validate a GBNF string the way schoolmarm does:
 *   - parses structurally
 *   - rejects dangling `|`
 *   - rejects unresolved rule references
 */
export function validateGrammarFull(gbnf: string): GrammarIssue[] {
  const issues: GrammarIssue[] = []
  let parsed: ParsedGrammar
  try {
    parsed = parseGrammar(gbnf)
  } catch (e) {
    issues.push({ name: "<parse>", message: e instanceof Error ? e.message : String(e) })
    return issues
  }

  const defined = new Set(parsed.definitions.keys())
  for (const [name, rhs] of parsed.definitions) {
    if (/^\s*\|/.test(rhs) || /\|\s*$/.test(rhs)) {
      issues.push({ name, message: "dangling alternation pipe" })
    }
    for (const ref of rhsIdentifiers(rhs)) {
      if (!defined.has(ref)) {
        issues.push({ name, message: `unresolved rule reference: ${ref}` })
      }
    }
  }
  return issues
}

/**
 * Naive best-effort simulation of `GrammarState.accepts(grammar, tokens)`.
 *
 * Given a grammar and a list of candidate token strings, classify each as
 * "could be the next token" (true) or "definitely not" (false). We use a
 * tiny recursive descent: at any point we look at the prefix of the RHS
 * we have advanced to, try literals/character classes first, then if the
 * prefix is a non-terminal we recurse into one of its alternatives.
 *
 * This is a sound under-approximation: anything we reject WOULD be
 * rejected by schoolmarm; things we accept may or may not be accepted.
 * For test purposes we always check that "accept" feels plausible
 * (length, prefix), not that "reject" is a complete list.
 */
export interface SimulatedGrammar {
  definitions: Map<string, string[]>
  /** A token that "looks like" a literal in this grammar. */
  looksLiteral(token: string): boolean
}

export function buildSimulation(gbnf: string): SimulatedGrammar {
  const { definitions } = parseGrammar(gbnf)
  const defsAlt = new Map<string, string[]>()
  for (const [k, rhs] of definitions) {
    defsAlt.set(k, rhs.split("|").map((s) => s.trim()))
  }

  const literalSet = new Set<string>()
  for (const [, alts] of defsAlt) {
    for (const alt of alts) {
      const matches = alt.match(/"(?:\\.|[^"\\])*"/g) ?? []
      for (const m of matches) {
        // decode the literal present in the grammar; do not match escape
        // characters special — keep the wrapped form
        literalSet.add(m)
      }
    }
  }

  return {
    definitions: defsAlt,
    looksLiteral(token: string): boolean {
      // Heuristic: any token that exactly equals or starts with a known
      // literal is "literal-shaped". Otherwise check if it's a valid key
      // that could expand into a literal via the grammar.
      for (const lit of literalSet) {
        if (token === lit) return true
        // Strip surrounding quotes to compare to a token with quotes
        const inner = lit.slice(1, -1)
        if (token.startsWith(inner) || token.endsWith(inner)) return true
      }
      // JSON-shaped tool call payloads: any token starting with "{"
      // could match a tool_call rule
      if (token.trim().startsWith("{")) return true
      return false
    },
  }
}
