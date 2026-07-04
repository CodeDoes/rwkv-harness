#!/usr/bin/env node
/**
 * Negative tests — make sure our structural validator (and the upstream
 * `Grammar::new` it approximates) would reject broken GBNF. We don't have
 * schoolmarm linked in from JS so we exercise our parser directly.
 *
 * Each fixture is crafted to fail for a specific reason:
 *   - missing `::=`
 *   - illegal identifier (starts with digit, contains whitespace)
 *   - unresolved reference
 *   - duplicate rule
 *   - dangling `|` alternation
 *
 * (Note: schoolmarm accepts `_` and `-` in identifier names per its
 *  parse_name rule (`[a-zA-Z0-9_-]+`), so we deliberately do NOT treat
 *  those as invalid here.)
 */
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

interface Fixture {
  label: string
  gbnf: string
  /** A predicate that returns true when the fixture produced an issue. */
  expectFailure: (issues: ReturnType<typeof validateGrammarFull>) => boolean
}

const FIXTURES: Fixture[] = [
  {
    label: "missing ::=",
    gbnf: "root call",
    expectFailure: (issues) =>
      issues.some((i) => i.message.includes('line missing "::="')),
  },
  {
    label: "identifier starts with digit",
    gbnf: '1call ::= "<tool_call>"',
    expectFailure: (issues) =>
      issues.some((i) => i.message.includes("invalid rule identifier")),
  },
  {
    label: "identifier contains illegal character (space)",
    gbnf: 'ca ll ::= "x"',
    expectFailure: (issues) =>
      issues.some((i) => i.message.includes("invalid rule identifier") || i.message.includes('line missing "::="')),
  },
  {
    label: "duplicate rule",
    gbnf: [
      'root ::= call',
      'call ::= "x"',
      'call ::= "y"',
    ].join("\n"),
    expectFailure: (issues) =>
      issues.some((i) => i.message.includes("duplicate rule definition")),
  },
  {
    label: "unresolved reference (referenced rule never defined)",
    gbnf: [
      'root ::= nonexistent',
    ].join("\n"),
    expectFailure: (issues) =>
      issues.some((i) => i.message.includes("unresolved rule reference")),
  },
  {
    label: "dangling alternation pipe",
    gbnf: [
      'root ::= call |',
    ].join("\n"),
    expectFailure: (issues) =>
      issues.some((i) => /dangling alternation/i.test(i.message)),
  },
]

function run(f: Fixture) {
  console.log(`\n── ${f.label} ──`)
  const issues = validateGrammarFull(f.gbnf)
  const ok = f.expectFailure(issues)
  check(
    f.label,
    ok,
    ok
      ? ""
      : `validator accepted fixture; issues: ${JSON.stringify(issues)}`,
  )
}

function main() {
  for (const f of FIXTURES) run(f)

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main()
