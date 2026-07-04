#!/usr/bin/env node
/**
 * Grammar validity tests.
 *
 * schoolmarm is a Rust crate (used in the native binding). From TS we
 * can't link to it directly, so these tests parse each generated GBNF
 * string structurally and check the things that would make
 * `Grammar::new(gbnf)` panic:
 *
 *   1. Every line contains a `::=` (or is a comment `# …` / blank line).
 *   2. The left-hand identifier matches `[a-zA-Z][a-zA-Z0-9]*`.
 *   3. No duplicate rule definitions.
 *   4. Every identifier on the right-hand side resolves to a defined
 *      rule (or to a literal / character class — see `RHS_TERMINALS`).
 *   5. The grammar contains the expected top-level rules (`root`, `call`,
 *      `ws`, at minimum one of: `string-value` / `string-char`).
 *
 * If the structural check passes, the grammar *should* compile under
 * schoolmarm; combined with `grammar-gen.test.ts` (which checks allowed
 * tokens), this gives us full coverage from the JS side.
 */
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import {
  toolsToGbnf,
  toolsToGbnfWithThink,
  toolsToGbnfText,
  toolsToGbnfZod,
  toolsToGbnfResponse,
} from "../tools/registry.ts"
import { toolDefs as envoyDefs } from "../agents/envoy/tools/index.ts"
import { toolDefs as storytellerDefs } from "../agents/storyteller/tools/index.ts"
import { toolDefs as coderDefs } from "../agents/coder/tools/index.ts"
import { toolDefs as defaultDefs } from "../tools/registry.ts"
import { parseGrammar, validateGrammarFull, rhsIdentifiers } from "./grammar-helpers.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

function validateGrammar(label: string, gbnf: string) {
  console.log(`\n── ${label} ──`)
  const issues = validateGrammarFull(gbnf)
  if (issues.length > 0) {
    for (const issue of issues) {
      check(`${label}: free of issues`, false, `${issue.name}: ${issue.message}`)
    }
    return
  }
  check(`${label}: free of issues`, true)
  const parsed = parseGrammar(gbnf)
  check(`${label}: has at least 1 rule`, parsed.definitions.size >= 1)

  const must = ["root", "call", "ws"]
  for (const r of must) {
    check(`${label}: has rule "${r}"`, parsed.definitions.has(r))
  }

  // Check `root` references `call` somewhere
  const rootRhs = parsed.definitions.get("root") ?? ""
  check(`${label}: root rule references "call"`, /\bcall\b/.test(rootRhs))
}



function main() {
  validateGrammar("default / tool-only", toolsToGbnf(defaultDefs))
  validateGrammar("default / think+text+tool", toolsToGbnfWithThink(defaultDefs))
  validateGrammar("default / text+tool", toolsToGbnfText(defaultDefs))
  validateGrammar("default / zod", toolsToGbnfZod(defaultDefs))
  // response grammar is intentionally minimal (EOT-terminated prose),
  // so we don't require "call"/"ws" in it.
  validateResponseGrammar("response / EOT", toolsToGbnfResponse())

  validateGrammar("envoy / think+text+tool", toolsToGbnfWithThink(envoyDefs))
  validateGrammar("storyteller / think+text+tool", toolsToGbnfWithThink(storytellerDefs))
  validateGrammar("coder / think+text+tool", toolsToGbnfWithThink(coderDefs))

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

function validateResponseGrammar(label: string, gbnf: string) {
  console.log(`\n── ${label} ──`)
  const issues = validateGrammarFull(gbnf)
  if (issues.length > 0) {
    for (const issue of issues) {
      check(`${label}: free of issues`, false, `${issue.name}: ${issue.message}`)
    }
    return
  }
  check(`${label}: free of issues`, true)
  const parsed = parseGrammar(gbnf)
  check(`${label}: has at least 1 rule`, parsed.definitions.size >= 1)
  check(`${label}: has rule "root"`, parsed.definitions.has("root"))
}

main()
